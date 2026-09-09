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

import { supabase } from '../supabase'
import { fetchAll } from '../fetch-all'
import { getDB, getMeta, setMeta } from './db'
import { getUserKey, seal, unseal } from './crypto'
import { networkMonitor } from './network'
import { isNetworkError } from './cache'

export const REPLICA_INTERVAL_MS = 15 * 60_000

export interface ReplicaTableSpec {
  /** human name shown in the Sync Center */
  name: string
  /** Dexie store holding the rows */
  store: string
  /** full-table fetch, paginated past the 1000-row cap, deterministically ordered */
  fetch: () => Promise<Array<Record<string, any> & { id: string }>>
}

export const REPLICA_TABLES: ReplicaTableSpec[] = [
  { name: 'Products', store: 'replica_products', fetch: () => fetchAll(() => supabase.from('products').select('*').order('id')) },
  { name: 'Stock counters', store: 'replica_inventory_items', fetch: () => fetchAll(() => supabase.from('inventory_items').select('*').order('id')) },
  { name: 'Product units', store: 'replica_product_units', fetch: () => fetchAll(() => supabase.from('product_units').select('*').order('id')) },
  { name: 'Customers', store: 'replica_customers', fetch: () => fetchAll(() => supabase.from('customers').select('*').order('id')) },
  { name: 'Invoices', store: 'replica_invoices', fetch: () => fetchAll(() => supabase.from('invoices').select('*').order('id')) },
  { name: 'Invoice items', store: 'replica_invoice_items', fetch: () => fetchAll(() => supabase.from('invoice_items').select('*').order('id')) },
  { name: 'Payments', store: 'replica_payments', fetch: () => fetchAll(() => supabase.from('payments').select('*').order('id')) },
  { name: 'Sales returns', store: 'replica_sales_returns', fetch: () => fetchAll(() => supabase.from('sales_returns').select('*').order('id')) },
  { name: 'Employees', store: 'replica_employees', fetch: () => fetchAll(() => supabase.from('employees').select('*').order('id')) },
  { name: 'Attendance', store: 'replica_attendance', fetch: () => fetchAll(() => supabase.from('attendance').select('*').order('id')) },
  { name: 'Warehouses', store: 'replica_warehouses', fetch: () => fetchAll(() => supabase.from('warehouses').select('*').order('id')) },
  { name: 'Brands', store: 'replica_brands', fetch: () => fetchAll(() => supabase.from('brands').select('*').order('id')) },
  { name: 'Categories', store: 'replica_categories', fetch: () => fetchAll(() => supabase.from('categories').select('*').order('id')) },
  { name: 'Payment methods', store: 'replica_payment_methods', fetch: () => fetchAll(() => supabase.from('payment_methods').select('*').order('id')) },
  { name: 'Suppliers', store: 'replica_suppliers', fetch: () => fetchAll(() => supabase.from('suppliers').select('*').order('id')) },
]

/** Named access for page fallbacks — keeps callers independent of array order. */
export const REPLICA: Record<string, ReplicaTableSpec> = Object.fromEntries(
  REPLICA_TABLES.map(s => [s.name, s]),
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
 * is in progress, further calls are ignored. A network drop mid-run stops the
 * run (tables already refreshed stay fresh); non-network table errors skip
 * that table and continue.
 */
export async function replicateAll(): Promise<void> {
  if (replicating) return
  if (!networkMonitor.getState().online) return

  const { data } = await supabase.auth.getSession()
  const userId = data.session?.user?.id
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
        await db.table(spec.store).clear()
        await db.table(spec.store).bulkPut(sealed)
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
    const { data } = await supabase.auth.getSession()
    const userId = data.session?.user?.id
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
