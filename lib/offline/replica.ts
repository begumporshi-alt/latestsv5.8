/**
 * The local database replicator.
 *
 * Maintains COMPLETE local copies of the core tables in IndexedDB
 * (replica_* stores): products, stock counters, units, customers, invoices,
 * invoice items, payments, returns, employees, attendance and the reference
 * tables. Refresh strategy is a full replace per table — the app uses soft
 * deletes, so a full refresh is the only strategy that also removes rows
 * deleted server-side without a changelog.
 *
 * Triggers: app start (after login), every 15 minutes while online, and the
 * moment connectivity returns. Rows are sealed per-record with the user's
 * AES-GCM key, so the local database is encrypted at rest exactly like the
 * page caches and the outbox.
 *
 * Reads: replicaRows() decrypts a whole table for page fallbacks; the data
 * is also what makes offline coverage independent of which pages were
 * visited while online.
 */

import { supabaseRaw } from '../supabase-raw'
import { fetchAll } from '../fetch-all'
import { getDB, getMeta, setMeta } from './db'
import { getUserKey, seal, unseal } from './crypto'
import { networkMonitor } from './network'
import { isNetworkError } from './cache'
import { resolveUserId } from './session'

export const REPLICA_INTERVAL_MS = 15 * 60_000

/**
 * A completed full sync newer than this makes further (non-forced) runs skip.
 * The app start fires several replicateAll triggers (mount-if-stale, the
 * network monitor's first online probe); without this guard they run
 * back-to-back, and each run's per-table replace briefly empties the store
 * for concurrent readers.
 */
const REPLICA_MIN_INTERVAL_MS = 60_000

export interface ReplicaTableSpec {
  /** human name shown in the Sync Center */
  name: string
  /** source table in Postgres — used by the replica query engine */
  table: string
  /** Dexie store holding the rows */
  store: string
  /** full-table fetch, paginated past the 1000-row cap, deterministically ordered */
  fetch: () => Promise<Array<Record<string, any> & { id: string | number }>>
}

export const REPLICA_TABLES: ReplicaTableSpec[] = [
  { name: 'Products', table: 'products', store: 'replica_products', fetch: () => fetchAll(() => supabaseRaw.from('products').select('*').order('id')) },
  { name: 'Stock counters', table: 'inventory_items', store: 'replica_inventory_items', fetch: () => fetchAll(() => supabaseRaw.from('inventory_items').select('*').order('id')) },
  { name: 'Product units', table: 'product_units', store: 'replica_product_units', fetch: () => fetchAll(() => supabaseRaw.from('product_units').select('*').order('id')) },
  { name: 'Customers', table: 'customers', store: 'replica_customers', fetch: () => fetchAll(() => supabaseRaw.from('customers').select('*').order('id')) },
  { name: 'Invoices', table: 'invoices', store: 'replica_invoices', fetch: () => fetchAll(() => supabaseRaw.from('invoices').select('*').order('id')) },
  { name: 'Invoice items', table: 'invoice_items', store: 'replica_invoice_items', fetch: () => fetchAll(() => supabaseRaw.from('invoice_items').select('*').order('id')) },
  { name: 'Payments', table: 'payments', store: 'replica_payments', fetch: () => fetchAll(() => supabaseRaw.from('payments').select('*').order('id')) },
  { name: 'Sales returns', table: 'sales_returns', store: 'replica_sales_returns', fetch: () => fetchAll(() => supabaseRaw.from('sales_returns').select('*').order('id')) },
  { name: 'Sales return items', table: 'sales_return_items', store: 'replica_sales_return_items', fetch: () => fetchAll(() => supabaseRaw.from('sales_return_items').select('*').order('id')) },
  { name: 'Employees', table: 'employees', store: 'replica_employees', fetch: () => fetchAll(() => supabaseRaw.from('employees').select('*').order('id')) },
  { name: 'Attendance', table: 'attendance', store: 'replica_attendance', fetch: () => fetchAll(() => supabaseRaw.from('attendance').select('*').order('id')) },
  { name: 'Warehouses', table: 'warehouses', store: 'replica_warehouses', fetch: () => fetchAll(() => supabaseRaw.from('warehouses').select('*').order('id')) },
  { name: 'Brands', table: 'brands', store: 'replica_brands', fetch: () => fetchAll(() => supabaseRaw.from('brands').select('*').order('id')) },
  { name: 'Categories', table: 'categories', store: 'replica_categories', fetch: () => fetchAll(() => supabaseRaw.from('categories').select('*').order('id')) },
  { name: 'Payment methods', table: 'payment_methods', store: 'replica_payment_methods', fetch: () => fetchAll(() => supabaseRaw.from('payment_methods').select('*').order('id')) },
  { name: 'Suppliers', table: 'suppliers', store: 'replica_suppliers', fetch: () => fetchAll(() => supabaseRaw.from('suppliers').select('*').order('id')) },
  // Operational data the POS and the shared gates read while offline: VAT /
  // POS defaults, store credit balances, and the FIFO batch ledger.
  { name: 'App settings', table: 'app_settings', store: 'replica_app_settings', fetch: () => fetchAll(() => supabaseRaw.from('app_settings').select('*').order('id')) },
  { name: 'Store credits', table: 'customer_store_credits', store: 'replica_customer_store_credits', fetch: () => fetchAll(() => supabaseRaw.from('customer_store_credits').select('*').order('id')) },
  { name: 'Inventory batches', table: 'inventory_batches', store: 'replica_inventory_batches', fetch: () => fetchAll(() => supabaseRaw.from('inventory_batches').select('*').order('id')) },
  // Accounting, purchasing, delivery and CRM history — everything the pages
  // read. Replicating these means offline coverage does not depend on which
  // pages were visited while online (lib/offline/replica-query.ts answers
  // any page's query from these tables).
  { name: 'Accounts', table: 'accounts', store: 'replica_accounts', fetch: () => fetchAll(() => supabaseRaw.from('accounts').select('*').order('id')) },
  { name: 'Journal entries', table: 'journal_entries', store: 'replica_journal_entries', fetch: () => fetchAll(() => supabaseRaw.from('journal_entries').select('*').order('id')) },
  { name: 'Journal lines', table: 'journal_lines', store: 'replica_journal_lines', fetch: () => fetchAll(() => supabaseRaw.from('journal_lines').select('*').order('id')) },
  { name: 'Stock movements', table: 'stock_movements', store: 'replica_stock_movements', fetch: () => fetchAll(() => supabaseRaw.from('stock_movements').select('*').order('id')) },
  { name: 'Quotations', table: 'quotations', store: 'replica_quotations', fetch: () => fetchAll(() => supabaseRaw.from('quotations').select('*').order('id')) },
  { name: 'Quotation items', table: 'quotation_items', store: 'replica_quotation_items', fetch: () => fetchAll(() => supabaseRaw.from('quotation_items').select('*').order('id')) },
  { name: 'Purchase orders', table: 'purchase_orders', store: 'replica_purchase_orders', fetch: () => fetchAll(() => supabaseRaw.from('purchase_orders').select('*').order('id')) },
  { name: 'Purchase order items', table: 'purchase_order_items', store: 'replica_purchase_order_items', fetch: () => fetchAll(() => supabaseRaw.from('purchase_order_items').select('*').order('id')) },
  { name: 'Purchase reminders', table: 'purchase_reminders', store: 'replica_purchase_reminders', fetch: () => fetchAll(() => supabaseRaw.from('purchase_reminders').select('*').order('id')) },
  { name: 'Purchase returns', table: 'purchase_returns', store: 'replica_purchase_returns', fetch: () => fetchAll(() => supabaseRaw.from('purchase_returns').select('*').order('id')) },
  { name: 'Purchase return items', table: 'purchase_return_items', store: 'replica_purchase_return_items', fetch: () => fetchAll(() => supabaseRaw.from('purchase_return_items').select('*').order('id')) },
  { name: 'GRNs', table: 'goods_receipt_notes', store: 'replica_goods_receipt_notes', fetch: () => fetchAll(() => supabaseRaw.from('goods_receipt_notes').select('*').order('id')) },
  { name: 'Deliveries', table: 'deliveries', store: 'replica_deliveries', fetch: () => fetchAll(() => supabaseRaw.from('deliveries').select('*').order('id')) },
  { name: 'Delivery items', table: 'delivery_items', store: 'replica_delivery_items', fetch: () => fetchAll(() => supabaseRaw.from('delivery_items').select('*').order('id')) },
  { name: 'Customer advances', table: 'customer_advances', store: 'replica_customer_advances', fetch: () => fetchAll(() => supabaseRaw.from('customer_advances').select('*').order('id')) },
  { name: 'Advance refunds', table: 'customer_advance_refunds', store: 'replica_customer_advance_refunds', fetch: () => fetchAll(() => supabaseRaw.from('customer_advance_refunds').select('*').order('id')) },
  { name: 'Advance applications', table: 'customer_advance_applications', store: 'replica_customer_advance_applications', fetch: () => fetchAll(() => supabaseRaw.from('customer_advance_applications').select('*').order('id')) },
  { name: 'Customer notes', table: 'customer_notes', store: 'replica_customer_notes', fetch: () => fetchAll(() => supabaseRaw.from('customer_notes').select('*').order('id')) },
  { name: 'Store credit redemptions', table: 'store_credit_redemptions', store: 'replica_store_credit_redemptions', fetch: () => fetchAll(() => supabaseRaw.from('store_credit_redemptions').select('*').order('id')) },
  { name: 'Cost price history', table: 'cost_price_history', store: 'replica_cost_price_history', fetch: () => fetchAll(() => supabaseRaw.from('cost_price_history').select('*').order('id')) },
  { name: 'Product sizes', table: 'product_sizes', store: 'replica_product_sizes', fetch: () => fetchAll(() => supabaseRaw.from('product_sizes').select('*').order('id')) },
  { name: 'Product colors', table: 'product_colors', store: 'replica_product_colors', fetch: () => fetchAll(() => supabaseRaw.from('product_colors').select('*').order('id')) },
  { name: 'Unit types', table: 'unit_types', store: 'replica_unit_types', fetch: () => fetchAll(() => supabaseRaw.from('unit_types').select('*').order('id')) },
  { name: 'Projects', table: 'projects', store: 'replica_projects', fetch: () => fetchAll(() => supabaseRaw.from('projects').select('*').order('id')) },
  { name: 'Activity logs', table: 'activity_logs', store: 'replica_activity_logs', fetch: () => fetchAll(() => supabaseRaw.from('activity_logs').select('*').order('id')) },
  { name: 'Profiles', table: 'profiles', store: 'replica_profiles', fetch: () => fetchAll(() => supabaseRaw.from('profiles').select('*').order('id')) },
  { name: 'Online orders', table: 'online_orders', store: 'replica_online_orders', fetch: () => fetchAll(() => supabaseRaw.from('online_orders').select('*').order('id')) },
  { name: 'Bank reconciliation items', table: 'bank_reconciliation_items', store: 'replica_bank_reconciliation_items', fetch: () => fetchAll(() => supabaseRaw.from('bank_reconciliation_items').select('*').order('id')) },
  { name: 'Reconciliation log', table: 'inventory_reconciliation_log', store: 'replica_inventory_reconciliation_log', fetch: () => fetchAll(() => supabaseRaw.from('inventory_reconciliation_log').select('*').order('id')) },
]

/** Named access for page fallbacks — keeps callers independent of array order. */
export const REPLICA: Record<string, ReplicaTableSpec> = Object.fromEntries(
  REPLICA_TABLES.map(s => [s.name, s]),
)

/** Source-table access for the replica query engine (lib/offline/replica-query). */
export const REPLICA_BY_TABLE: Record<string, ReplicaTableSpec> = Object.fromEntries(
  REPLICA_TABLES.map(s => [s.table, s]),
)

type ReplicaListener = () => void
const listeners = new Set<ReplicaListener>()

export function subscribeReplica(listener: ReplicaListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notifyReplicaChanged(): void {
  listeners.forEach((l) => l())
}

let replicating = false

export function isReplicating(): boolean {
  return replicating
}

/**
 * Full refresh of every replica table. Safe to call repeatedly — while a run
 * is in progress, further calls are ignored, and a run that completed within
 * the last minute is skipped unless `force` (the Sync Center button). A
 * network drop mid-run stops the run (tables already refreshed stay fresh);
 * non-network table errors skip that table and continue.
 */
export async function replicateAll(force = false): Promise<void> {
  if (replicating) return
  if (!networkMonitor.getState().online) return
  if (!force) {
    const recent = await getMeta<number>('replica:last_full_sync')
    if (recent && Date.now() - recent < REPLICA_MIN_INTERVAL_MS) return
  }

  const userId = await resolveUserId()
  if (!userId) return

  replicating = true
  notifyReplicaChanged()
  try {
    const key = await getUserKey(userId)
    const db = getDB()
    for (const spec of REPLICA_TABLES) {
      if (!networkMonitor.getState().online) return
      try {
        const rows = await spec.fetch()
        const sealed = await Promise.all(rows.map(async r => ({ id: r.id, blob: await seal(key, r) })))
        // clear + bulkPut in ONE transaction: a concurrent reader (the POS
        // fallback, the replica query engine) sees the old rows or the new
        // rows, never an empty store.
        await db.transaction('rw', spec.store, async () => {
          await db.table(spec.store).clear()
          await db.table(spec.store).bulkPut(sealed)
        })
        await setMeta(`replica:last_sync:${spec.name}`, Date.now())
        await setMeta(`replica:count:${spec.name}`, rows.length)
        notifyReplicaChanged()
      } catch (err) {
        if (isNetworkError(err)) {
          networkMonitor.markOffline()
          return
        }
        // Skip a broken table, keep the rest of the local database fresh.
        console.warn(`[replica] ${spec.name} refresh failed:`, err)
      }
    }
    await setMeta('replica:last_full_sync', Date.now())
    notifyReplicaChanged()
  } finally {
    replicating = false
    notifyReplicaChanged()
  }
}

/** Decrypt and return every row of a replica table. */
export async function replicaRows<T>(spec: ReplicaTableSpec): Promise<T[]> {
  try {
    // resolveUserId keeps replica reads working offline even when the access
    // token has expired (the local rows are sealed with this user's key).
    const userId = await resolveUserId()
    if (!userId) return []
    const key = await getUserKey(userId)
    const rows = await getDB().table(spec.store).toArray()
    const out: T[] = []
    for (const r of rows as Array<{ id: string; blob: unknown }>) {
      try {
        out.push(await unseal<T>(key, r.blob as never))
      } catch {
        // foreign/corrupt row — skip
      }
    }
    return out
  } catch {
    return []
  }
}

/**
 * Build the POS product snapshot (products + nested stock counters + units)
 * entirely from the local database — used when the page-level snapshot cache
 * is empty but the replicator has already filled the local tables.
 */
export async function buildPosSnapshotFromReplica(): Promise<any[] | null> {
  const products = await replicaRows<any>(REPLICA['Products'])
  if (products.length === 0) return null
  const invItems = await replicaRows<any>(REPLICA['Stock counters'])
  const units = await replicaRows<any>(REPLICA['Product units'])

  const invByProduct = new Map<string, any[]>()
  for (const inv of invItems) {
    if (!invByProduct.has(inv.product_id)) invByProduct.set(inv.product_id, [])
    invByProduct.get(inv.product_id)!.push(inv)
  }
  const unitsByProduct = new Map<string, any[]>()
  for (const u of units) {
    if (!unitsByProduct.has(u.product_id)) unitsByProduct.set(u.product_id, [])
    unitsByProduct.get(u.product_id)!.push(u)
  }

  return products
    .filter(p => p.is_active)
    .map(p => ({
      ...p,
      inventory_items: invByProduct.get(p.id) || [],
      units: unitsByProduct.get(p.id) || [],
    }))
}

/** Per-table status for the Sync Center. */
export interface ReplicaStatus {
  replicating: boolean
  lastFullSync: number | null
  tables: Array<{ name: string; count: number; lastSync: number | null }>
}

export async function replicaStatus(): Promise<ReplicaStatus> {
  const tables: ReplicaStatus['tables'] = []
  for (const spec of REPLICA_TABLES) {
    const count = (await getMeta<number>(`replica:count:${spec.name}`)) ?? 0
    const lastSync = (await getMeta<number>(`replica:last_sync:${spec.name}`)) ?? null
    tables.push({ name: spec.name, count, lastSync })
  }
  return {
    replicating: replicating,
    lastFullSync: (await getMeta<number>('replica:last_full_sync')) ?? null,
    tables,
  }
}

let started = false
let timer: ReturnType<typeof setInterval> | null = null

/** Mount once from the OfflineProvider: keeps the local database fresh. */
export async function startReplicator(): Promise<void> {
  if (started || typeof window === 'undefined') return
  started = true

  const last = await getMeta<number>('replica:last_full_sync')
  const stale = !last || Date.now() - last > REPLICA_INTERVAL_MS
  if (stale) void replicateAll()

  networkMonitor.subscribe((s) => {
    if (s.online) void replicateAll()
  })
  timer = setInterval(() => {
    if (networkMonitor.getState().online) void replicateAll()
  }, REPLICA_INTERVAL_MS)
}
