/**
 * Realtime-driven replica sync.
 *
 * Until now a write on one device reached another only through the hourly
 * replica cycle, so two terminals in the same shop could disagree for up to an
 * hour about stock, a PO's received quantity or the GL. This module subscribes
 * to Postgres change events for the tables the offline copy actually mirrors
 * and turns them into the same targeted refresh an online write triggers
 * locally — so "online" means the same thing on every device.
 *
 * Design notes:
 *   - One channel, many tables. Events are coalesced for DEBOUNCE_MS because a
 *     single GRN emits a burst (header + movements + counters + batches + PO
 *     lines + journal) and each table would otherwise schedule its own pull.
 *   - Only table names are used, never payloads: the replica pulls the rows
 *     itself, so nothing depends on REPLICA IDENTITY or on payload size.
 *   - Events are ignored while the app believes it is offline; the reconnect
 *     path (networkMonitor → replicateAll) already covers that gap, and a
 *     Realtime reconnect burst would otherwise stampede the API.
 *   - The channel is best-effort: if Realtime is disabled on the project the
 *     subscription simply never fires and the hourly cycle remains the
 *     fallback. Nothing else depends on it.
 */

import { supabaseRaw } from '../supabase-raw'
import { networkMonitor } from './network'

/** Tables whose changes another device must see promptly. */
const WATCHED_TABLES = [
  // Goods receipt and its downstream effects
  'goods_receipt_notes',
  'stock_movements',
  'inventory_items',
  'inventory_batches',
  'purchase_order_items',
  'purchase_orders',
  'purchase_reminders',
  // GL
  'journal_entries',
  'journal_lines',
  'accounts',
  // Catalog and pricing (cost ratchet, sale-price push-down)
  'products',
  'product_units',
  // Sales path — keeps the POS catalogue and the oversell gate honest
  'invoices',
  'invoice_items',
  'payments',
  'customers',
  'suppliers',
] as const

/**
 * Page-level aggregates (lib/offline/keys.ts) that must be dropped when one of
 * these tables changes remotely. Without this the local replica would be
 * correct while a page still rendered its cached 60s snapshot.
 */
const TABLE_AGGREGATES: Record<string, string[]> = {
  inventory_items: ['inventory:page-data'],
  inventory_batches: ['inventory:page-data'],
  products: ['inventory:page-data', 'products:all'],
  purchase_orders: ['purchases:list'],
  purchase_order_items: ['purchases:list'],
  goods_receipt_notes: ['purchases:list'],
  invoices: ['sales:page-data:', 'invoices:recent'],
  invoice_items: ['sales:page-data:', 'invoices:recent'],
  payments: ['sales:page-data:', 'invoices:recent'],
  customers: ['crm:page-data', 'customers:all'],
}

/** Coalesce a burst (one GRN touches eight tables) into one refresh. */
const DEBOUNCE_MS = 1_200

type Channel = ReturnType<typeof supabaseRaw.channel>

let channel: Channel | null = null
let timer: ReturnType<typeof setTimeout> | null = null
const dirtyTables = new Set<string>()
let started = false

async function flush(): Promise<void> {
  timer = null
  if (dirtyTables.size === 0) return
  if (!networkMonitor.getState().online) {
    dirtyTables.clear()
    return
  }
  const tables = [...dirtyTables]
  dirtyTables.clear()

  try {
    const [{ REPLICA_BY_TABLE, refreshReplicaTables }, { invalidateCachesForTables, invalidateCacheKeys }] =
      await Promise.all([import('./replica'), import('./pending')])

    const specs = tables
      .map((t) => REPLICA_BY_TABLE[t]?.name)
      .filter((n): n is string => Boolean(n))

    // Caches first: a page rendering during the pull should miss its stale
    // aggregate rather than serve it for the whole refresh window.
    const prefixes = new Set<string>(['dashboard:page-data'])
    for (const t of tables) for (const p of TABLE_AGGREGATES[t] || []) prefixes.add(p)
    void invalidateCachesForTables(tables)
    void invalidateCacheKeys([...prefixes])

    // refreshReplicaTables queues instead of dropping when a local run is in
    // flight, so a remote change can never be silently skipped.
    if (specs.length > 0) void refreshReplicaTables(specs)
  } catch {
    // best-effort — the hourly cycle is the safety net
  }
}

function onTableChange(table: string): void {
  if (!networkMonitor.getState().online) return
  dirtyTables.add(table)
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    void flush()
  }, DEBOUNCE_MS)
  ;(timer as { unref?: () => void }).unref?.()
}

/**
 * Start the channel. Idempotent; called from startReplicator so it shares the
 * provider's lifecycle. No-op outside the browser.
 */
export function startRealtimeSync(): void {
  if (started || typeof window === 'undefined') return
  started = true

  try {
    let ch = supabaseRaw.channel('replica-sync')
    for (const table of WATCHED_TABLES) {
      ch = ch.on(
        'postgres_changes' as never,
        { event: '*', schema: 'public', table },
        () => onTableChange(table),
      )
    }
    channel = ch.subscribe()
  } catch {
    // Realtime unavailable (disabled on the project, blocked network) — the
    // hourly replica cycle still converges every table.
    started = false
  }
}

/** Tear the channel down (sign-out, tests). */
export function stopRealtimeSync(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  dirtyTables.clear()
  try {
    if (channel) void supabaseRaw.removeChannel(channel)
  } catch {
    // already gone
  }
  channel = null
  started = false
}
