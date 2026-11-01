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

/** Quiet period after the last write before the refresh runs. */
const QUIET_MS = 2_500

/**
 * Replica tables (by REPLICA name) each write RPC can touch. Keep this in
 * step with the function bodies in supabase/migrations — an under-declared
 * RPC leaves the local copy silently stale, which is exactly the class of bug
 * this map exists to prevent.
 */
const RPC_TABLES: Record<string, string[]> = {
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

  // Atomic goods receipt: GRN header, stock counters, movements, FIFO layers,
  // PO line received quantities, PO status, GL, reminders, product cost/sale
  // prices, and account balances.
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
    'Purchase reminders',
  ],
}

let timer: ReturnType<typeof setTimeout> | null = null
/** Source table names written via .from() — mapped to replica specs at flush. */
const touchedTables = new Set<string>()
/** RPC names called since the last flush. */
const calledRpcs = new Set<string>()
/** The refresh currently in flight, if any. */
let running: Promise<void> | null = null

async function flush(): Promise<void> {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  // A run is already in flight — it re-runs itself for whatever arrived in the
  // meantime (see the finally block), so there is nothing to do here.
  if (running) return running
  if (touchedTables.size === 0 && calledRpcs.size === 0) return

  const tables = [...touchedTables]
  const rpcs = [...calledRpcs]
  touchedTables.clear()
  calledRpcs.clear()

  running = (async () => {
    try {
      const { REPLICA, REPLICA_BY_TABLE, refreshReplicaTables, replicateAll } = await import('./replica')
      const specs = new Set<string>()
      let needsFullPass = false

      for (const table of tables) {
        const spec = REPLICA_BY_TABLE[table]
        // A write to a table the replica doesn't track needs no refresh; the
        // page caches for such tables are invalidated at their own call sites.
        if (spec) specs.add(spec.name)
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
    } finally {
      running = null
      // Writes that landed while this pass was running get their own pass.
      if (touchedTables.size > 0 || calledRpcs.size > 0) void flush()
    }
  })()

  return running
}

export function noteServerWrite(kind: 'from' | 'rpc', name: string): void {
  if (typeof window === 'undefined') return
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
 */
export async function awaitPendingWrites(): Promise<void> {
  if (typeof window === 'undefined') return
  // Bounded: each iteration either finishes the work or hands it to a run
  // that the previous finally block scheduled.
  for (let i = 0; i < 3; i++) {
    if (running) await running
    if (!timer && touchedTables.size === 0 && calledRpcs.size === 0) return
    await flush()
  }
  if (running) await running
}
