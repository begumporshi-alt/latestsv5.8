/**
 * Coalesced replica refresh after successful online writes.
 *
 * Online writes go straight to Supabase and never enter the outbox, so the
 * "refresh after applied outbox changes" trigger never fires for them — the
 * local replica database would otherwise lag until the hourly cycle. The
 * app-wide client wrapper (lib/offline/read-fallback.ts) reports every
 * successful write here: `.from()` writes name their table, so only those
 * replica tables re-pull; RPCs can touch any table, so they schedule one
 * forced full pass. Bursts (a save that writes several tables) are collapsed
 * into a single refresh after a short quiet period.
 *
 * The replica module is imported lazily: this hook sits on the import chain
 * of the app-wide client wrapper, which must stay loadable in environments
 * that never configure Supabase (unit tests).
 */

/** Quiet period after the last write before the refresh runs. */
const QUIET_MS = 2_500

let timer: ReturnType<typeof setTimeout> | null = null
/** Source table names written via .from() — mapped to replica specs at flush. */
const touchedTables = new Set<string>()
let sawRpc = false

async function flush(): Promise<void> {
  timer = null
  const tables = [...touchedTables]
  const rpc = sawRpc
  touchedTables.clear()
  sawRpc = false
  try {
    const { REPLICA_BY_TABLE, refreshReplicaTables, replicateAll } = await import('./replica')
    // refreshReplicaTables/replicateAll no-op offline and guard concurrent runs.
    if (rpc) void replicateAll(true)
    else {
      const specs = tables.map(t => REPLICA_BY_TABLE[t]?.name).filter(Boolean)
      // A write to a table the replica doesn't track needs no refresh; the
      // page caches for such tables are invalidated at their own call sites.
      if (specs.length > 0) void refreshReplicaTables(specs)
    }
  } catch {
    // best-effort — the hourly cycle and the POS TTL are the safety nets
  }
}

export function noteServerWrite(kind: 'from' | 'rpc', name: string): void {
  if (typeof window === 'undefined') return
  if (kind === 'rpc') sawRpc = true
  else touchedTables.add(name)
  if (timer) clearTimeout(timer)
  timer = setTimeout(flush, QUIET_MS)
  // Don't hold the process open (node test runners).
  ;(timer as { unref?: () => void }).unref?.()
}
