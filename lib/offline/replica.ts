/**
 * The local database replicator.
 *
 * Maintains COMPLETE local copies of the core tables in IndexedDB
 * (replica_* stores): products, stock counters, units, customers, invoices,
 * invoice items, payments, returns, employees, attendance and the reference
 * tables. Refresh strategy is a full replace per table — the app uses soft
 * deletes, so a full refresh is the only strategy that also removes rows
 * deleted server-side without a changelog. Every table has a `delta`
 * fetch (ledger/line-item tables by created_at; editable tables by the
 * trigger-maintained updated_at — migrations 20261002150000,
 * 20261018150000, 20261027120000 and 20261028100000) and only downloads rows changed
 * since the last refresh, guarded by a zero-payload count probe that
 * falls back to a full replace when rows disappear server-side; a full
 * replace also runs once a day as a convergence net.
 *
 * purchase_order_items is the one line-item table that does NOT follow the
 * created_at rule: GRNs, purchase returns and IOU absorption update
 * received_quantity in place, so it carries updated_at like an editable table
 * (migration 20261101090000).
 *
 * Triggers: app start (after login), hourly while the tab is visible and
 * online (plus the moment connectivity returns or a hidden tab regains
 * visibility), after every applied outbox change, after every successful
 * online write (lib/offline/write-refresh), and on another device's writes
 * through Realtime (lib/offline/realtime). Rows are sealed per-record with the user's
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
import { mark } from '../perf/cold-start'

/**
 * Periodic full-refresh interval. Kept at one hour because it is the
 * background safety net only — active use refreshes the replica after every
 * applied outbox change (lib/offline/sync.ts), and a hidden tab skips ticks
 * entirely.
 */
export const REPLICA_INTERVAL_MS = 60 * 60_000

/**
 * A completed full sync newer than this makes further (non-forced) runs skip.
 * The app start fires several replicateAll triggers (mount-if-stale, the
 * network monitor's first online probe); without this guard they run
 * back-to-back, and each run's per-table replace briefly empties the store
 * for concurrent readers.
 */
const REPLICA_MIN_INTERVAL_MS = 60_000

/**
 * Delta-replicated replica tables fall back to a full refresh at least this
 * often, so changes a timestamp cursor cannot see (server-side removals by
 * data-repair migrations, or delete+reinsert edits that keep the total
 * count) eventually converge out of the local copy.
 */
const REPLICA_FULL_REFRESH_MS = 24 * 60 * 60_000

export interface ReplicaTableSpec {
  /** human name shown in the Sync Center */
  name: string
  /** source table in Postgres — used by the replica query engine */
  table: string
  /** Dexie store holding the rows */
  store: string
  /** full-table fetch, paginated past the 1000-row cap, deterministically ordered */
  fetch: () => Promise<Array<Record<string, any> & { id: string | number }>>
  /**
   * Incremental fetch for tables the replica can track by timestamp: only
   * rows with the cursor column strictly after the given ISO timestamp
   * (the newest value the replica has already stored), in (cursor column,
   * id) order. When present, replicateAll appends/updates between full
   * refreshes instead of re-downloading the whole table.
   */
  delta?: (afterCursor: string) => Promise<Array<Record<string, any> & { id: string | number }>>
  /**
   * Timestamp column the delta cursor tracks — 'created_at' for insert-only
   * tables, 'updated_at' (maintained by the touch_updated_at trigger,
   * migration 20261002150000) for tables whose rows can be edited. Defaults
   * to 'created_at'.
   */
  cursorColumn?: 'created_at' | 'updated_at'
}

export const REPLICA_TABLES: ReplicaTableSpec[] = [
  { name: 'Products', table: 'products', store: 'replica_products', fetch: () => fetchAll(() => supabaseRaw.from('products').select('*').order('id')), cursorColumn: 'updated_at', delta: (afterCursor) => fetchAll(() => supabaseRaw.from('products').select('*').gt('updated_at', afterCursor).order('updated_at').order('id')) },
  { name: 'Stock counters', table: 'inventory_items', store: 'replica_inventory_items', fetch: () => fetchAll(() => supabaseRaw.from('inventory_items').select('*').order('id')), cursorColumn: 'updated_at', delta: (afterCursor) => fetchAll(() => supabaseRaw.from('inventory_items').select('*').gt('updated_at', afterCursor).order('updated_at').order('id')) },
  { name: 'Product units', table: 'product_units', store: 'replica_product_units', fetch: () => fetchAll(() => supabaseRaw.from('product_units').select('*').order('id')), cursorColumn: 'updated_at', delta: (afterCursor) => fetchAll(() => supabaseRaw.from('product_units').select('*').gt('updated_at', afterCursor).order('updated_at').order('id')) },
  { name: 'Customers', table: 'customers', store: 'replica_customers', fetch: () => fetchAll(() => supabaseRaw.from('customers').select('*').order('id')), cursorColumn: 'updated_at', delta: (afterCursor) => fetchAll(() => supabaseRaw.from('customers').select('*').gt('updated_at', afterCursor).order('updated_at').order('id')) },
  { name: 'Invoices', table: 'invoices', store: 'replica_invoices', fetch: () => fetchAll(() => supabaseRaw.from('invoices').select('*').order('id')), cursorColumn: 'updated_at', delta: (afterCursor) => fetchAll(() => supabaseRaw.from('invoices').select('*').gt('updated_at', afterCursor).order('updated_at').order('id')) },
  { name: 'Invoice items', table: 'invoice_items', store: 'replica_invoice_items', fetch: () => fetchAll(() => supabaseRaw.from('invoice_items').select('*').order('id')), cursorColumn: 'updated_at', delta: (afterCursor) => fetchAll(() => supabaseRaw.from('invoice_items').select('*').gt('updated_at', afterCursor).order('updated_at').order('id')) },
  { name: 'Payments', table: 'payments', store: 'replica_payments', fetch: () => fetchAll(() => supabaseRaw.from('payments').select('*').order('id')), cursorColumn: 'updated_at', delta: (afterCursor) => fetchAll(() => supabaseRaw.from('payments').select('*').gt('updated_at', afterCursor).order('updated_at').order('id')) },
  { name: 'Sales returns', table: 'sales_returns', store: 'replica_sales_returns', fetch: () => fetchAll(() => supabaseRaw.from('sales_returns').select('*').order('id')), cursorColumn: 'updated_at', delta: (afterCursor) => fetchAll(() => supabaseRaw.from('sales_returns').select('*').gt('updated_at', afterCursor).order('updated_at').order('id')) },
  { name: 'Sales return items', table: 'sales_return_items', store: 'replica_sales_return_items', fetch: () => fetchAll(() => supabaseRaw.from('sales_return_items').select('*').order('id')), delta: (afterCursor) => fetchAll(() => supabaseRaw.from('sales_return_items').select('*').gt('created_at', afterCursor).order('created_at').order('id')) },
  { name: 'Employees', table: 'employees', store: 'replica_employees', fetch: () => fetchAll(() => supabaseRaw.from('employees').select('*').order('id')), cursorColumn: 'updated_at', delta: (afterCursor) => fetchAll(() => supabaseRaw.from('employees').select('*').gt('updated_at', afterCursor).order('updated_at').order('id')) },
  { name: 'Attendance', table: 'attendance', store: 'replica_attendance', fetch: () => fetchAll(() => supabaseRaw.from('attendance').select('*').order('id')), cursorColumn: 'updated_at', delta: (afterCursor) => fetchAll(() => supabaseRaw.from('attendance').select('*').gt('updated_at', afterCursor).order('updated_at').order('id')) },
  { name: 'Warehouses', table: 'warehouses', store: 'replica_warehouses', fetch: () => fetchAll(() => supabaseRaw.from('warehouses').select('*').order('id')), cursorColumn: 'updated_at', delta: (afterCursor) => fetchAll(() => supabaseRaw.from('warehouses').select('*').gt('updated_at', afterCursor).order('updated_at').order('id')) },
  { name: 'Brands', table: 'brands', store: 'replica_brands', fetch: () => fetchAll(() => supabaseRaw.from('brands').select('*').order('id')), cursorColumn: 'updated_at', delta: (afterCursor) => fetchAll(() => supabaseRaw.from('brands').select('*').gt('updated_at', afterCursor).order('updated_at').order('id')) },
  { name: 'Categories', table: 'categories', store: 'replica_categories', fetch: () => fetchAll(() => supabaseRaw.from('categories').select('*').order('id')), cursorColumn: 'updated_at', delta: (afterCursor) => fetchAll(() => supabaseRaw.from('categories').select('*').gt('updated_at', afterCursor).order('updated_at').order('id')) },
  { name: 'Payment methods', table: 'payment_methods', store: 'replica_payment_methods', fetch: () => fetchAll(() => supabaseRaw.from('payment_methods').select('*').order('id')), cursorColumn: 'updated_at', delta: (afterCursor) => fetchAll(() => supabaseRaw.from('payment_methods').select('*').gt('updated_at', afterCursor).order('updated_at').order('id')) },
  { name: 'Suppliers', table: 'suppliers', store: 'replica_suppliers', fetch: () => fetchAll(() => supabaseRaw.from('suppliers').select('*').order('id')), cursorColumn: 'updated_at', delta: (afterCursor) => fetchAll(() => supabaseRaw.from('suppliers').select('*').gt('updated_at', afterCursor).order('updated_at').order('id')) },
  // Operational data the POS and the shared gates read while offline: VAT /
  // POS defaults, store credit balances, and the FIFO batch ledger.
  { name: 'App settings', table: 'app_settings', store: 'replica_app_settings', fetch: () => fetchAll(() => supabaseRaw.from('app_settings').select('*').order('id')), cursorColumn: 'updated_at', delta: (afterCursor) => fetchAll(() => supabaseRaw.from('app_settings').select('*').gt('updated_at', afterCursor).order('updated_at').order('id')) },
  { name: 'Store credits', table: 'customer_store_credits', store: 'replica_customer_store_credits', fetch: () => fetchAll(() => supabaseRaw.from('customer_store_credits').select('*').order('id')), cursorColumn: 'updated_at', delta: (afterCursor) => fetchAll(() => supabaseRaw.from('customer_store_credits').select('*').gt('updated_at', afterCursor).order('updated_at').order('id')) },
  { name: 'Inventory batches', table: 'inventory_batches', store: 'replica_inventory_batches', fetch: () => fetchAll(() => supabaseRaw.from('inventory_batches').select('*').order('id')), cursorColumn: 'updated_at', delta: (afterCursor) => fetchAll(() => supabaseRaw.from('inventory_batches').select('*').gt('updated_at', afterCursor).order('updated_at').order('id')) },
  // Accounting, purchasing, delivery and CRM history — everything the pages
  // read. Replicating these means offline coverage does not depend on which
  // pages were visited while online (lib/offline/replica-query.ts answers
  // any page's query from these tables).
  { name: 'Accounts', table: 'accounts', store: 'replica_accounts', fetch: () => fetchAll(() => supabaseRaw.from('accounts').select('*').order('id')), cursorColumn: 'updated_at', delta: (afterCursor) => fetchAll(() => supabaseRaw.from('accounts').select('*').gt('updated_at', afterCursor).order('updated_at').order('id')) },
  { name: 'Journal entries', table: 'journal_entries', store: 'replica_journal_entries', fetch: () => fetchAll(() => supabaseRaw.from('journal_entries').select('*').order('id')), delta: (afterCursor) => fetchAll(() => supabaseRaw.from('journal_entries').select('*').gt('created_at', afterCursor).order('created_at').order('id')) },
  { name: 'Journal lines', table: 'journal_lines', store: 'replica_journal_lines', fetch: () => fetchAll(() => supabaseRaw.from('journal_lines').select('*').order('id')), delta: (afterCursor) => fetchAll(() => supabaseRaw.from('journal_lines').select('*').gt('created_at', afterCursor).order('created_at').order('id')) },
  { name: 'Stock movements', table: 'stock_movements', store: 'replica_stock_movements', fetch: () => fetchAll(() => supabaseRaw.from('stock_movements').select('*').order('id')), delta: (afterCursor) => fetchAll(() => supabaseRaw.from('stock_movements').select('*').gt('created_at', afterCursor).order('created_at').order('id')) },
  { name: 'Quotations', table: 'quotations', store: 'replica_quotations', fetch: () => fetchAll(() => supabaseRaw.from('quotations').select('*').order('id')), cursorColumn: 'updated_at', delta: (afterCursor) => fetchAll(() => supabaseRaw.from('quotations').select('*').gt('updated_at', afterCursor).order('updated_at').order('id')) },
  { name: 'Quotation items', table: 'quotation_items', store: 'replica_quotation_items', fetch: () => fetchAll(() => supabaseRaw.from('quotation_items').select('*').order('id')), delta: (afterCursor) => fetchAll(() => supabaseRaw.from('quotation_items').select('*').gt('created_at', afterCursor).order('created_at').order('id')) },
  { name: 'Purchase orders', table: 'purchase_orders', store: 'replica_purchase_orders', fetch: () => fetchAll(() => supabaseRaw.from('purchase_orders').select('*').order('id')), cursorColumn: 'updated_at', delta: (afterCursor) => fetchAll(() => supabaseRaw.from('purchase_orders').select('*').gt('updated_at', afterCursor).order('updated_at').order('id')) },
  // Not append-only: receive_grn, purchase returns and IOU absorption UPDATE
  // received_quantity / unit_cost in place, so this table needs the
  // updated_at cursor (migration 20261101090000) — a created_at cursor would
  // never see those edits.
  { name: 'Purchase order items', table: 'purchase_order_items', store: 'replica_purchase_order_items', fetch: () => fetchAll(() => supabaseRaw.from('purchase_order_items').select('*').order('id')), cursorColumn: 'updated_at', delta: (afterCursor) => fetchAll(() => supabaseRaw.from('purchase_order_items').select('*').gt('updated_at', afterCursor).order('updated_at').order('id')) },
  { name: 'Purchase reminders', table: 'purchase_reminders', store: 'replica_purchase_reminders', fetch: () => fetchAll(() => supabaseRaw.from('purchase_reminders').select('*').order('id')), cursorColumn: 'updated_at', delta: (afterCursor) => fetchAll(() => supabaseRaw.from('purchase_reminders').select('*').gt('updated_at', afterCursor).order('updated_at').order('id')) },
  { name: 'Purchase returns', table: 'purchase_returns', store: 'replica_purchase_returns', fetch: () => fetchAll(() => supabaseRaw.from('purchase_returns').select('*').order('id')), cursorColumn: 'updated_at', delta: (afterCursor) => fetchAll(() => supabaseRaw.from('purchase_returns').select('*').gt('updated_at', afterCursor).order('updated_at').order('id')) },
  { name: 'Purchase return items', table: 'purchase_return_items', store: 'replica_purchase_return_items', fetch: () => fetchAll(() => supabaseRaw.from('purchase_return_items').select('*').order('id')), delta: (afterCursor) => fetchAll(() => supabaseRaw.from('purchase_return_items').select('*').gt('created_at', afterCursor).order('created_at').order('id')) },
  { name: 'GRNs', table: 'goods_receipt_notes', store: 'replica_goods_receipt_notes', fetch: () => fetchAll(() => supabaseRaw.from('goods_receipt_notes').select('*').order('id')), cursorColumn: 'updated_at', delta: (afterCursor) => fetchAll(() => supabaseRaw.from('goods_receipt_notes').select('*').gt('updated_at', afterCursor).order('updated_at').order('id')) },
  { name: 'Deliveries', table: 'deliveries', store: 'replica_deliveries', fetch: () => fetchAll(() => supabaseRaw.from('deliveries').select('*').order('id')), cursorColumn: 'updated_at', delta: (afterCursor) => fetchAll(() => supabaseRaw.from('deliveries').select('*').gt('updated_at', afterCursor).order('updated_at').order('id')) },
  // delivered_quantity is updated in place by the delivery flow, so this table
  // needs the updated_at cursor (migration 20261101093000) — created_at would
  // never see a partial delivery.
  { name: 'Delivery items', table: 'delivery_items', store: 'replica_delivery_items', fetch: () => fetchAll(() => supabaseRaw.from('delivery_items').select('*').order('id')), cursorColumn: 'updated_at', delta: (afterCursor) => fetchAll(() => supabaseRaw.from('delivery_items').select('*').gt('updated_at', afterCursor).order('updated_at').order('id')) },
  { name: 'Customer advances', table: 'customer_advances', store: 'replica_customer_advances', fetch: () => fetchAll(() => supabaseRaw.from('customer_advances').select('*').order('id')), cursorColumn: 'updated_at', delta: (afterCursor) => fetchAll(() => supabaseRaw.from('customer_advances').select('*').gt('updated_at', afterCursor).order('updated_at').order('id')) },
  { name: 'Advance refunds', table: 'customer_advance_refunds', store: 'replica_customer_advance_refunds', fetch: () => fetchAll(() => supabaseRaw.from('customer_advance_refunds').select('*').order('id')), delta: (afterCursor) => fetchAll(() => supabaseRaw.from('customer_advance_refunds').select('*').gt('created_at', afterCursor).order('created_at').order('id')) },
  { name: 'Advance applications', table: 'customer_advance_applications', store: 'replica_customer_advance_applications', fetch: () => fetchAll(() => supabaseRaw.from('customer_advance_applications').select('*').order('id')), delta: (afterCursor) => fetchAll(() => supabaseRaw.from('customer_advance_applications').select('*').gt('created_at', afterCursor).order('created_at').order('id')) },
  { name: 'Customer notes', table: 'customer_notes', store: 'replica_customer_notes', fetch: () => fetchAll(() => supabaseRaw.from('customer_notes').select('*').order('id')), delta: (afterCursor) => fetchAll(() => supabaseRaw.from('customer_notes').select('*').gt('created_at', afterCursor).order('created_at').order('id')) },
  { name: 'Store credit redemptions', table: 'store_credit_redemptions', store: 'replica_store_credit_redemptions', fetch: () => fetchAll(() => supabaseRaw.from('store_credit_redemptions').select('*').order('id')), delta: (afterCursor) => fetchAll(() => supabaseRaw.from('store_credit_redemptions').select('*').gt('created_at', afterCursor).order('created_at').order('id')) },
  { name: 'Cost price history', table: 'cost_price_history', store: 'replica_cost_price_history', fetch: () => fetchAll(() => supabaseRaw.from('cost_price_history').select('*').order('id')), delta: (afterCursor) => fetchAll(() => supabaseRaw.from('cost_price_history').select('*').gt('created_at', afterCursor).order('created_at').order('id')) },
  { name: 'Product sizes', table: 'product_sizes', store: 'replica_product_sizes', fetch: () => fetchAll(() => supabaseRaw.from('product_sizes').select('*').order('id')), cursorColumn: 'updated_at', delta: (afterCursor) => fetchAll(() => supabaseRaw.from('product_sizes').select('*').gt('updated_at', afterCursor).order('updated_at').order('id')) },
  { name: 'Product colors', table: 'product_colors', store: 'replica_product_colors', fetch: () => fetchAll(() => supabaseRaw.from('product_colors').select('*').order('id')), cursorColumn: 'updated_at', delta: (afterCursor) => fetchAll(() => supabaseRaw.from('product_colors').select('*').gt('updated_at', afterCursor).order('updated_at').order('id')) },
  { name: 'Unit types', table: 'unit_types', store: 'replica_unit_types', fetch: () => fetchAll(() => supabaseRaw.from('unit_types').select('*').order('id')), cursorColumn: 'updated_at', delta: (afterCursor) => fetchAll(() => supabaseRaw.from('unit_types').select('*').gt('updated_at', afterCursor).order('updated_at').order('id')) },
  { name: 'Projects', table: 'projects', store: 'replica_projects', fetch: () => fetchAll(() => supabaseRaw.from('projects').select('*').order('id')), cursorColumn: 'updated_at', delta: (afterCursor) => fetchAll(() => supabaseRaw.from('projects').select('*').gt('updated_at', afterCursor).order('updated_at').order('id')) },
  { name: 'Activity logs', table: 'activity_logs', store: 'replica_activity_logs', fetch: () => fetchAll(() => supabaseRaw.from('activity_logs').select('*').order('id')), delta: (afterCursor) => fetchAll(() => supabaseRaw.from('activity_logs').select('*').gt('created_at', afterCursor).order('created_at').order('id')) },
  { name: 'Profiles', table: 'profiles', store: 'replica_profiles', fetch: () => fetchAll(() => supabaseRaw.from('profiles').select('*').order('id')), cursorColumn: 'updated_at', delta: (afterCursor) => fetchAll(() => supabaseRaw.from('profiles').select('*').gt('updated_at', afterCursor).order('updated_at').order('id')) },
  { name: 'Online orders', table: 'online_orders', store: 'replica_online_orders', fetch: () => fetchAll(() => supabaseRaw.from('online_orders').select('*').order('id')), cursorColumn: 'updated_at', delta: (afterCursor) => fetchAll(() => supabaseRaw.from('online_orders').select('*').gt('updated_at', afterCursor).order('updated_at').order('id')) },
  { name: 'Bank reconciliation items', table: 'bank_reconciliation_items', store: 'replica_bank_reconciliation_items', fetch: () => fetchAll(() => supabaseRaw.from('bank_reconciliation_items').select('*').order('id')), cursorColumn: 'updated_at', delta: (afterCursor) => fetchAll(() => supabaseRaw.from('bank_reconciliation_items').select('*').gt('updated_at', afterCursor).order('updated_at').order('id')) },
  { name: 'Reconciliation log', table: 'inventory_reconciliation_log', store: 'replica_inventory_reconciliation_log', fetch: () => fetchAll(() => supabaseRaw.from('inventory_reconciliation_log').select('*').order('id')), delta: (afterCursor) => fetchAll(() => supabaseRaw.from('inventory_reconciliation_log').select('*').gt('created_at', afterCursor).order('created_at').order('id')) },
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

/**
 * Work requested while a run was already in flight. It is queued, never
 * dropped: a targeted refresh that arrives during the hourly full pass used to
 * be discarded silently, leaving the caller believing the local copy was
 * fresh. A forced full pass collapses to a single pending flag.
 */
const queuedTables = new Set<string>()
/** Tables queued for a forced full replace (Sync Center repair). */
const queuedRebuilds = new Set<string>()
let queuedFullPass = false
/** Callers waiting for the queue to drain (one resolver per waiter). */
let drainWaiters: Array<() => void> = []

function waitForDrain(): Promise<void> {
  return new Promise<void>((resolve) => drainWaiters.push(resolve))
}

function releaseDrain(): void {
  const waiters = drainWaiters
  drainWaiters = []
  waiters.forEach((resolve) => resolve())
}

export function isReplicating(): boolean {
  return replicating
}

// One table's sync: delta pull when a cursor is fresh, full replace
// otherwise, plus cursor/count bookkeeping. Shared by replicateAll and the
// targeted refreshReplicaTables. `forceFull` skips the delta path — the Sync
// Center's per-table repair uses it when the local copy is suspected to have
// drifted (a cursor cannot see a row rewritten with an older timestamp).
async function replicateOne(spec: ReplicaTableSpec, forceFull = false): Promise<void> {
  const userId = await resolveUserId()
  if (!userId) return
  const key = await getUserKey(userId)
  const db = getDB()
  const writeTable = async (
    tableSpec: ReplicaTableSpec,
    tableRows: Array<Record<string, any> & { id: string | number }>,
    replace: boolean,
  ) => {
    const sealed = await Promise.all(tableRows.map(async r => ({ id: r.id, blob: await seal(key, r) })))
    // clear + bulkPut in ONE transaction: a concurrent reader (the POS
    // fallback, the replica query engine) sees the old rows or the new
    // rows, never an empty store.
    await db.transaction('rw', tableSpec.store, async () => {
      if (replace) await db.table(tableSpec.store).clear()
      if (sealed.length > 0) await db.table(tableSpec.store).bulkPut(sealed)
    })
  }
  try {
    let rows: Array<Record<string, any> & { id: string | number }> = []
    let replaceAllRows = true
    let applied = false
    if (spec.delta && !forceFull) {
      const cursorKey = `replica:delta_cursor:${spec.name}`
      const cursor = await getMeta<string>(cursorKey)
      const lastFull = await getMeta<number>(`replica:last_full:${spec.name}`)
      if (cursor && lastFull != null && Date.now() - lastFull < REPLICA_FULL_REFRESH_MS) {
        const col = spec.cursorColumn ?? 'created_at'
        const collected: Array<Record<string, any> & { id: string | number }> = []
        let from = cursor
        // Apply BEFORE the count probe: an update replaces its row without
        // changing the count, so a mismatch after the write isolates rows
        // deleted server-side — the one change a timestamp cursor cannot see.
        // Mismatch (or a failed probe) falls through to the full replace
        // below, so removals converge within one refresh cycle.
        //
        // The loop closes the other blind spot: rows committed *while* this
        // fetch was paging have a timestamp newer than the newest row we
        // applied. One cheap head request per pass tells us whether to keep
        // paging, so a delta converges even under concurrent writes instead
        // of leaving those rows for the next cycle.
        for (let pass = 0; pass < 3; pass++) {
          const batch = await spec.delta(from)
          if (batch.length === 0) break
          collected.push(...batch)
          await writeTable(spec, batch, false)
          const batchMax = batch.reduce<string | null>((m, r) => {
            const ts = r[col]
            return typeof ts === 'string' && ts && (!m || ts > m) ? ts : m
          }, null)
          if (batchMax) from = batchMax
          const { count: residual } = await supabaseRaw
            .from(spec.table)
            .select('id', { count: 'exact', head: true })
            .gt(col, from)
          if (!residual) break
        }
        const { count: serverCount, error: cntErr } = await supabaseRaw
          .from(spec.table)
          .select('id', { count: 'exact', head: true })
        const localCount = await db.table(spec.store).count()
        if (!cntErr && serverCount != null && serverCount === localCount) {
          rows = collected
          replaceAllRows = false
          applied = true
        }
      }
    }
    if (!applied) {
      rows = await spec.fetch()
      await writeTable(spec, rows, true)
    }
    if (spec.delta) {
      // Advance the cursor to the newest timestamp seen. Rows sharing a
      // timestamp (one transaction writes a whole batch) were all fetched
      // together, so a strict-gt cursor never skips them.
      const col = spec.cursorColumn ?? 'created_at'
      const newCursor = rows.reduce<string | null>((m, r) => {
        const ts = r[col]
        return typeof ts === 'string' && ts && (!m || ts > m) ? ts : m
      }, null)
      if (newCursor) await setMeta(`replica:delta_cursor:${spec.name}`, newCursor)
      if (replaceAllRows) await setMeta(`replica:last_full:${spec.name}`, Date.now())
    }
    await setMeta(`replica:last_sync:${spec.name}`, Date.now())
    await setMeta(
      `replica:count:${spec.name}`,
      replaceAllRows ? rows.length : await db.table(spec.store).count(),
    )
  } catch (err) {
    if (isNetworkError(err)) {
      networkMonitor.markOffline()
      return
    }
    // Skip a broken table, keep the rest of the local database fresh.
    console.warn(`[replica] ${spec.name} refresh failed:`, err)
  }
}

/** Refresh one named table, stopping early if the connection drops. */
async function runTargeted(names: Iterable<string>, forceFull = false): Promise<void> {
  for (const name of names) {
    const spec = REPLICA[name]
    if (!spec) continue
    if (!networkMonitor.getState().online) return
    await replicateOne(spec, forceFull)
    notifyReplicaChanged()
  }
}

/** One pass over every replica table plus the completion stamp. */
async function runFullPass(): Promise<void> {
  for (const spec of REPLICA_TABLES) {
    if (!networkMonitor.getState().online) return
    await replicateOne(spec)
    notifyReplicaChanged()
  }
  await setMeta('replica:last_full_sync', Date.now())
  notifyReplicaChanged()
}

/**
 * Apply everything that was queued behind the current run: per-table rebuilds,
 * targeted pulls, and at most one forced full pass. Called by every run owner
 * so a request that arrived mid-run can never be left pending — including a
 * forced full pass requested while a *targeted* refresh was in flight.
 */
async function drainQueue(): Promise<void> {
  while (queuedRebuilds.size > 0) {
    const next = [...queuedRebuilds]
    queuedRebuilds.clear()
    await runTargeted(next, true)
  }
  while (queuedTables.size > 0) {
    const next = [...queuedTables]
    queuedTables.clear()
    await runTargeted(next)
  }
  if (queuedFullPass && networkMonitor.getState().online) {
    queuedFullPass = false
    await runFullPass()
    // runFullPass can be followed by more queued work; one extra sweep settles
    // it because the loops above drain to empty and runFullPass enqueues
    // nothing itself.
    await drainQueue()
  }
}

/**
 * Full refresh of every replica table. Safe to call repeatedly — a run that
 * completed within the last minute is skipped unless `force` (the Sync Center
 * button). A network drop mid-run stops the run (tables already refreshed stay
 * fresh). If a run is already in flight the request is QUEUED rather than
 * dropped: a forced pass requested during the hourly cycle still happens, once.
 */
export async function replicateAll(force = false): Promise<void> {
  if (!networkMonitor.getState().online) return
  if (replicating) {
    if (force) queuedFullPass = true
    return waitForDrain()
  }
  if (!force) {
    const recent = await getMeta<number>('replica:last_full_sync')
    if (recent && Date.now() - recent < REPLICA_MIN_INTERVAL_MS) return
  }

  const userId = await resolveUserId()
  if (!userId) return

  replicating = true
  notifyReplicaChanged()
  try {
    mark('replica:fullpass-start')
    await runFullPass()
    mark('replica:fullpass-end')
    await drainQueue()
  } finally {
    replicating = false
    notifyReplicaChanged()
    releaseDrain()
  }
}

/**
 * Targeted refresh of named replica tables (by REPLICA name) without the
 * full replicateAll pass. The POS uses this to converge its catalog, stock
 * counters, units and customer replica stores on a short interval so pages
 * can serve reads locally; delta tables only download rows changed since
 * their cursor, so a quiet table costs one zero-row request.
 *
 * Requests that arrive while another run is in flight are queued and applied
 * by that run before it finishes — the returned promise resolves once they
 * have been applied, so a caller can await real convergence.
 */
export async function refreshReplicaTables(names: string[]): Promise<void> {
  if (!networkMonitor.getState().online || names.length === 0) return
  if (replicating) {
    for (const name of names) queuedTables.add(name)
    return waitForDrain()
  }
  replicating = true
  notifyReplicaChanged()
  try {
    await runTargeted(names)
    await drainQueue()
  } finally {
    replicating = false
    notifyReplicaChanged()
    releaseDrain()
  }
}

/**
 * Re-download one table in full, ignoring its delta cursor. This is the repair
 * path: a timestamp cursor cannot see a row rewritten with an older value
 * (a data-repair migration, a delete+reinsert that keeps the count), so the
 * Sync Center offers a per-table rebuild instead of waiting for the daily
 * full replace.
 */
export async function rebuildReplicaTable(name: string): Promise<void> {
  if (!networkMonitor.getState().online || !REPLICA[name]) return
  if (replicating) {
    queuedRebuilds.add(name)
    return waitForDrain()
  }
  replicating = true
  notifyReplicaChanged()
  try {
    await runTargeted([name], true)
    await drainQueue()
  } finally {
    replicating = false
    notifyReplicaChanged()
    releaseDrain()
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
  mark('snapshot:build-start')
  const products = await replicaRows<any>(REPLICA['Products'])
  if (products.length === 0) return null
  const invItems = await replicaRows<any>(REPLICA['Stock counters'])
  const units = await replicaRows<any>(REPLICA['Product units'])
  mark('snapshot:decrypt-end')

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

  const snapshot = products
    .filter(p => p.is_active)
    .map(p => ({
      ...p,
      inventory_items: invByProduct.get(p.id) || [],
      units: unitsByProduct.get(p.id) || [],
    }))
  mark('snapshot:build-end')
  return snapshot
}

/** Per-table status for the Sync Center. */
export interface ReplicaStatus {
  replicating: boolean
  lastFullSync: number | null
  tables: Array<{
    name: string
    count: number
    lastSync: number | null
    /** Newest timestamp this table's delta cursor has applied, if it has one. */
    cursor: string | null
  }>
}

export async function replicaStatus(): Promise<ReplicaStatus> {
  const tables: ReplicaStatus['tables'] = []
  for (const spec of REPLICA_TABLES) {
    const count = (await getMeta<number>(`replica:count:${spec.name}`)) ?? 0
    const lastSync = (await getMeta<number>(`replica:last_sync:${spec.name}`)) ?? null
    const cursor = (await getMeta<string>(`replica:delta_cursor:${spec.name}`)) ?? null
    tables.push({ name: spec.name, count, lastSync, cursor })
  }
  return {
    replicating: replicating,
    lastFullSync: (await getMeta<number>('replica:last_full_sync')) ?? null,
    tables,
  }
}

let started = false
let timer: ReturnType<typeof setInterval> | null = null

/**
 * How long after the first paint the boot-time pass is allowed to start.
 * Purely a settle window — see afterFirstPaint below.
 */
const REPLICA_FIRST_PASS_SETTLE_MS = 1_500

/**
 * Run `fn` once the first frame has painted, plus a short settle window.
 *
 * The boot-time pass walks every replica table (~19 MB on a populated
 * database) and writes them in a stream of IndexedDB transactions. Firing it
 * at mount put that download and those write locks directly in front of the
 * POS catalogue read that paints the grid — the largest avoidable overlap on
 * a cold start. The pass is a background convergence task, not something a
 * user is waiting on, so a one-off delay costs nothing in freshness; the
 * hourly timer and the visibility/reconnect triggers are untouched.
 *
 * Two rAFs guarantee at least one frame has been painted (a single rAF
 * callback can still run before the first paint in some engines); the idle
 * callback then yields to whatever the page is already doing.
 */
function afterFirstPaint(fn: () => void): void {
  if (typeof window === 'undefined') {
    fn()
    return
  }
  const idle = () => {
    const ric = (window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void
    }).requestIdleCallback
    if (typeof ric === 'function') ric(fn, { timeout: 5_000 })
    else fn()
  }
  requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(idle, REPLICA_FIRST_PASS_SETTLE_MS)))
}

/**
 * The boot pass has two independent triggers (a stale last-sync stamp and the
 * network monitor's immediate first notification); both route here so the
 * delay applies once, not twice.
 */
let firstPassScheduled = false
function scheduleFirstPass(): void {
  if (firstPassScheduled) return
  firstPassScheduled = true
  afterFirstPaint(() => { void replicateAll() })
}

/** Mount once from the OfflineProvider: keeps the local database fresh. */
export async function startReplicator(): Promise<void> {
  if (started || typeof window === 'undefined') return
  started = true

  const last = await getMeta<number>('replica:last_full_sync')
  const stale = !last || Date.now() - last > REPLICA_INTERVAL_MS
  if (stale) scheduleFirstPass()

  // A full refresh re-downloads every table (~19 MB today). Each tick that
  // fires while the tab is hidden is pure waste — the replica only matters
  // when someone is looking at the app — so background/hidden tabs skip the
  // timer and reconnect ticks, and a refresh runs the moment the tab becomes
  // visible again (the 1-minute guard collapses burst triggers).
  //
  // subscribe() invokes the listener immediately with the current state, so
  // the first notification is the boot trigger and must take the deferred
  // path; every later transition (a real reconnect) runs at once.
  let firstOnlineNotice = true
  networkMonitor.subscribe((s) => {
    if (!s.online || document.hidden) return
    if (firstOnlineNotice) {
      firstOnlineNotice = false
      scheduleFirstPass()
      return
    }
    void replicateAll()
  })
  timer = setInterval(() => {
    if (networkMonitor.getState().online && !document.hidden) void replicateAll()
  }, REPLICA_INTERVAL_MS)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && networkMonitor.getState().online) void replicateAll()
  })

  // Another device's writes reach this one through Realtime rather than
  // waiting for the hourly cycle. Best-effort: a project without Realtime
  // enabled simply never fires and the cycle above remains the fallback.
  void import('./realtime')
    .then(({ startRealtimeSync }) => startRealtimeSync())
    .catch(() => {})
}
