/**
 * Coalesced replica refresh after successful online writes.
 *
 * Online writes go straight to Supabase and never enter the outbox, so the
 * "refresh after applied outbox changes" trigger never fires for them — the
 * local replica database would otherwise lag until the hourly cycle. The
 * app-wide client wrapper (lib/offline/read-fallback.ts) reports every
 * successful write here.
 *
 * `.from()` writes name their table, so only those replica tables re-pull.
 * RPCs are resolved through RPC_TABLES below:
 *   - a mapped RPC refreshes exactly the replica tables it can touch,
 *   - an empty mapping (sequence generators) refreshes nothing,
 *   - an unmapped RPC falls back to one forced full pass, which is the safe
 *     default for anything new.
 *
 * Bursts (a save that writes several tables, plus its sequence RPC) are
 * collapsed into a single refresh after a short quiet period. Callers that
 * need the device copy to be consistent before continuing can await
 * awaitPendingWrites().
 *
 * The replica module is imported lazily: this hook sits on the import chain
 * of the app-wide client wrapper, which must stay loadable in environments
 * that never configure Supabase (unit tests).
 */

import { getMeta, setMeta } from './db'

/** Quiet period after the last write before the refresh runs. */
const QUIET_MS = 2_500

/**
 * Timestamp of the last successful server write, persisted so every tab and
 * every page-level cache can tell whether its copy predates a write.
 *
 * Page snapshots used to be invalidated by hand at the call sites that
 * remembered to (`cacheDelete(CACHE_KEYS.products)` and friends). One missed
 * call site — or one write performed from another tab, or from a path that
 * never had the call at all — left the page serving a pre-write snapshot for
 * its whole TTL (10 minutes for the POS catalogue). Recording the write itself
 * makes invalidation automatic: `cachedQuery` treats any entry stamped before
 * this timestamp as stale, regardless of its TTL.
 */
const LAST_WRITE_META_KEY = 'data:last-write-at'

let lastWriteAt = 0
let loadedWriteAt = false
let lastMetaReadAt = 0
/** Re-read the persisted value at most this often (cross-tab writes). */
const META_READ_TTL_MS = 400

/**
 * Replica tables (by REPLICA name) each write RPC can touch. Keep this in
 * step with the function bodies in supabase/migrations — an under-declared
 * RPC leaves the local copy silently stale, which is exactly the class of bug
 * this map exists to prevent. `rpc-tables-coverage.test.ts` reads the function
 * bodies and fails when this map misses a table one of them writes, so the
 * "keep in step" instruction above is enforced rather than trusted.
 */
export const RPC_TABLES: Record<string, string[]> = {
  // Number generators only advance a Postgres sequence — no replicated table.
  // Treating these as "touch everything" made every sale and every PO create
  // schedule a full 55-table pass.
  generate_invoice_number: [],
  generate_pos_number: [],
  generate_payment_number: [],
  generate_delivery_number: [],
  generate_journal_number: [],
  generate_purchase_order_number: [],
  generate_purchase_payment_number: [],
  generate_credit_number: [],

  // Opening stock and stock reductions: the batch row plus the warehouse
  // counter. Left unmapped, every product created with opening stock — and
  // every row of a CSV import — forced a full 48-table replica pass.
  create_opening_batch: ['Stock counters', 'Inventory batches'],
  create_stock_reduction: ['Stock counters', 'Inventory batches'],

  // Typed-reason stock adjustment (corrections and write-offs): FIFO layers,
  // counters, movements and the GL. Same table set the RPC itself touches.
  sync_stock_adjustment: [
    'Stock counters',
    'Inventory batches',
    'Stock movements',
    'Journal entries',
    'Journal lines',
    'Accounts',
  ],

  // Atomic goods receipt: GRN header, stock counters, movements, FIFO layers,
  // PO line received quantities, PO status, GL, reminders, product cost/sale
  // prices, and account balances.
  //
  // 'Product units' is not optional. receive_grn rewrites the per-unit rows
  // from the line's selected unit (exact prices for that unit, proportional
  // for the others, plus the base row mirroring products), and the POS tile
  // prices a multi-unit product from its DEFAULT UNIT's price — not from
  // products.sale_price. Omitting the table left the tile showing the old
  // price until the POS's own ten-minute replica cycle happened to refresh it,
  // which is exactly the "new sale price takes ten minutes" report.
  receive_grn: [
    'Goods receipt notes',
    'Stock movements',
    'Stock counters',
    'Inventory batches',
    'Purchase order items',
    'Purchase orders',
    'Journal entries',
    'Journal lines',
    'Accounts',
    'Products',
    'Product units',
    'Purchase reminders',
  ],
}

/**
 * Replica tables a `.from()` write changes INDIRECTLY, through database
 * triggers. The client never writes `inventory_items` — stock is deducted by
 * the trigger on `invoice_items` INSERT — so a write to the source table must
 * also converge the tables the trigger touched.
 *
 * Without this, a completed POS sale left the local stock counters at their
 * pre-sale values until the hourly pass. The POS grid's optimistic decrement
 * masked that for a while, but any snapshot rebuilt from the replica in
 * between (a replica notification, the 10-minute catalogue refresh, a page
 * reload) showed the sold units as still on hand, and then cached that figure
 * for the snapshot's whole TTL.
 */
const TABLE_SIDE_EFFECTS: Record<string, string[]> = {
  // Sale: stock deducted, FIFO layers consumed, COGS journal posted, and the
  // customer's outstanding balance recomputed.
  invoice_items: [
    'Stock counters',
    'Inventory batches',
    'Stock movements',
    'Journal entries',
    'Journal lines',
    'Accounts',
  ],
  invoices: ['Customers'],
  // Returns put stock back and reverse the journal.
  sales_return_items: [
    'Stock counters',
    'Inventory batches',
    'Stock movements',
    'Journal entries',
    'Journal lines',
    'Accounts',
  ],
  purchase_return_items: [
    'Stock counters',
    'Inventory batches',
    'Stock movements',
    'Journal entries',
    'Journal lines',
    'Accounts',
  ],
}

let timer: ReturnType<typeof setTimeout> | null = null
/** Source table names written via .from() — mapped to replica specs at flush. */
const touchedTables = new Set<string>()
/** RPC names called since the last flush. */
const calledRpcs = new Set<string>()
/** The refresh currently in flight, if any. */
let running: Promise<boolean> | null = null

async function flush(): Promise<boolean> {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  // A run is already in flight — it re-runs itself for whatever arrived in the
  // meantime (see the finally block), so there is nothing to do here.
  if (running) return running
  if (touchedTables.size === 0 && calledRpcs.size === 0) return true

  const tables = [...touchedTables]
  const rpcs = [...calledRpcs]
  touchedTables.clear()
  calledRpcs.clear()

  running = (async () => {
    let ok = true
    try {
      const { REPLICA, REPLICA_BY_TABLE, refreshReplicaTables, replicateAll } = await import('./replica')
      const specs = new Set<string>()
      let needsFullPass = false

      for (const table of tables) {
        const spec = REPLICA_BY_TABLE[table]
        // A write to a table the replica doesn't track needs no refresh; the
        // page caches for such tables are invalidated at their own call sites.
        if (spec) specs.add(spec.name)
        // Trigger-maintained tables the write changed behind the client's back.
        for (const name of TABLE_SIDE_EFFECTS[table] ?? []) {
          if (REPLICA[name]) specs.add(name)
        }
      }

      for (const rpc of rpcs) {
        const mapped = RPC_TABLES[rpc]
        if (!mapped) {
          needsFullPass = true
          break
        }
        for (const name of mapped) if (REPLICA[name]) specs.add(name)
      }

      if (needsFullPass) await replicateAll(true)
      else if (specs.size > 0) await refreshReplicaTables([...specs])
    } catch {
      // best-effort — the hourly cycle and the POS TTL are the safety nets
      ok = false
    } finally {
      running = null
      // Writes that landed while this pass was running get their own pass.
      if (touchedTables.size > 0 || calledRpcs.size > 0) void flush()
    }
    return ok
  })()

  return running
}

/**
 * Timestamp of the last successful server write (ms), or 0 when this device
 * has never written. Read from IndexedDB so a write performed in another tab
 * still invalidates this tab's page snapshots.
 */
export async function getLastWriteAt(): Promise<number> {
  if (typeof window === 'undefined') return 0
  const now = Date.now()
  // Another tab's write lands in the same IndexedDB meta row; re-reading keeps
  // this tab's snapshots from outliving it, at one cheap read per window.
  if (loadedWriteAt && now - lastMetaReadAt < META_READ_TTL_MS) return lastWriteAt
  lastMetaReadAt = now
  try {
    const stored = await getMeta<number>(LAST_WRITE_META_KEY)
    if (typeof stored === 'number' && stored > lastWriteAt) lastWriteAt = stored
  } catch {
    // storage unavailable — the in-memory value still covers this tab
  }
  loadedWriteAt = true
  return lastWriteAt
}

function noteWriteTimestamp(): void {
  const now = Date.now()
  // Strictly monotonic: two writes in the same millisecond must still be
  // distinguishable from a cache row written before them.
  lastWriteAt = now > lastWriteAt ? now : lastWriteAt + 1
  loadedWriteAt = true
  try {
    void Promise.resolve(setMeta(LAST_WRITE_META_KEY, lastWriteAt)).catch(() => {})
  } catch {
    // best-effort — the in-memory value still covers this tab
  }
}

export function noteServerWrite(kind: 'from' | 'rpc', name: string): void {
  if (typeof window === 'undefined') return
  noteWriteTimestamp()
  if (kind === 'rpc') calledRpcs.add(name)
  else touchedTables.add(name)
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    void flush()
  }, QUIET_MS)
  // Don't hold the process open (node test runners).
  ;(timer as { unref?: () => void }).unref?.()
}

/**
 * Flush now and resolve once the local replica reflects every write reported
 * so far. The server is already committed when this is called; this only
 * waits for the device copy, so callers can report the two states separately
 * instead of implying they happen together.
 *
 * Resolves `false` when the local convergence pass failed (network drop,
 * storage error) — the caller should then say the device copy will catch up
 * later rather than claim it is up to date.
 */
export async function awaitPendingWrites(): Promise<boolean> {
  if (typeof window === 'undefined') return true
  let ok = true
  // Bounded: each iteration either finishes the work or hands it to a run
  // that the previous finally block scheduled.
  for (let i = 0; i < 3; i++) {
    if (running) ok = (await running) && ok
    if (!timer && touchedTables.size === 0 && calledRpcs.size === 0) return ok
    ok = (await flush()) && ok
  }
  if (running) ok = (await running) && ok
  return ok
}
