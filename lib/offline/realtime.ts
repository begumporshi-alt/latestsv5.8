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
 *   - Postgres only streams changes for tables that are members of the
 *     `supabase_realtime` publication. This module was subscribing for months
 *     while only `notifications` was published, so none of these handlers ever
 *     ran — a silent failure that looks exactly like "the other terminal's
 *     change took ten minutes". The tables are added in
 *     supabase/migrations/20261106120000_realtime_replica_tables.sql; a
 *     CHANNEL_ERROR is logged once if the subscription cannot be established.
 */

import { supabaseRaw } from '../supabase-raw'
import { networkMonitor } from './network'

/** Tables whose changes another device must see promptly.
 *
 *  Exported for the parity test: every table here must also be a member of the
 *  `supabase_realtime` publication (migration 20261106120000). A table listed
 *  here but not published is accepted by the client and never fires. */
export const WATCHED_TABLES = [
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
  // Advance wallets. The POS spends these in "advance balance first" mode and
  // reads them from the replica when offline; without this a wallet drained on
  // another terminal stays "full" locally until the hourly full pass, and the
  // cashier offers money the shop no longer holds.
  'customer_advances',
] as const

/**
 * Page-level aggregates (lib/offline/keys.ts) that must be dropped when one of
 * these tables changes remotely. Without this the local replica would be
 * correct while a page still rendered its cached 60s snapshot.
 *
 * The catalogue snapshot (`products:all`) embeds BOTH the unit rows and the
 * stock counters — the POS grid renders a multi-unit product's price from its
 * default unit and its quantity from the counters — so every one of the three
 * tables has to drop it. A unit-price change that only refreshed the replica
 * left the grid on its cached copy until the snapshot's ten-minute TTL ran out,
 * which is the same symptom from the other end.
 */
const TABLE_AGGREGATES: Record<string, string[]> = {
  inventory_items: ['inventory:page-data', 'products:all', 'gate:stock'],
  inventory_batches: ['inventory:page-data'],
  product_units: ['inventory:page-data', 'products:all'],
  products: ['inventory:page-data', 'products:all', 'gate:stock'],
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
/** A broken socket is reported once per session, not once per event. */
let statusWarned = false

async function invalidate(tables: string[], prefixes: string[]): Promise<void> {
  try {
    const { invalidateCachesForTables, invalidateCacheKeys } = await import('./pending')
    await invalidateCachesForTables(tables)
    await invalidateCacheKeys(prefixes)
  } catch {
    // best-effort — the TTL is the backstop
  }
}

async function flush(): Promise<void> {
  timer = null
  if (dirtyTables.size === 0) return
  if (!networkMonitor.getState().online) {
    dirtyTables.clear()
    return
  }
  const tables = [...dirtyTables]
  dirtyTables.clear()

  const prefixes = new Set<string>(['dashboard:page-data'])
  for (const t of tables) for (const p of TABLE_AGGREGATES[t] || []) prefixes.add(p)
  const keys = [...prefixes]

  try {
    const { REPLICA_BY_TABLE, refreshReplicaTables } = await import('./replica')
    const specs = tables
      .map((t) => REPLICA_BY_TABLE[t]?.name)
      .filter((n): n is string => Boolean(n))

    // Drop first: a page rendering during the pull must miss its stale
    // aggregate rather than serve it for the whole refresh window.
    await invalidate(tables, keys)

    // refreshReplicaTables queues instead of dropping when a local run is in
    // flight, so a remote change can never be silently skipped.
    if (specs.length > 0) await refreshReplicaTables(specs)

    // Drop again, now that the replica has converged. A reader that ran
    // between the first invalidation and the end of the pull rebuilt its
    // snapshot from a partly-converged replica and stamped it fresh — the
    // timestamp cannot catch that, because the write happened on another
    // device. Without this second pass that copy would stand for its full TTL.
    await invalidate(tables, keys)
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
    channel = ch.subscribe((status: string) => {
      // A table that is not in the `supabase_realtime` publication, or a
      // project with Realtime switched off, reports a channel error and then
      // stays silent — indistinguishable from "nothing changed" without this
      // line. It is a warning, not a failure: every table still converges on
      // the replica cycle, just slowly.
      if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && !statusWarned) {
        statusWarned = true
        console.warn(
          '[realtime] replica-sync channel could not subscribe (' + status +
          '). Check that the watched tables are in the supabase_realtime publication.',
        )
      }
    })
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
