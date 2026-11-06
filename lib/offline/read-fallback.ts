/**
 * Transparent offline read fallback for the app-wide Supabase client.
 *
 * Why it exists: only a handful of pages read through lib/offline's helpers;
 * the rest call `supabase.from(...)` / `supabase.rpc(...)` directly and went
 * blank or empty offline. Rather than rewrite ~48 pages, the client they
 * already import is wrapped here:
 *
 *   read (select / allowlisted read RPC)
 *     online, success        → result cached (sealed, per-user, keyed by the
 *                              exact table + filter chain) and returned as-is.
 *     offline                → the cached result for that exact query is
 *                              served immediately (no multi-second postgrest
 *                              retry stall); with no cached copy, `.from()`
 *                              reads are answered from the local replica
 *                              database (lib/offline/replica-query.ts) — so
 *                              pages work offline even if never opened while
 *                              online. Only if that also declines does the
 *                              caller get a postgrest-shaped error and the UI
 *                              shows the "not available offline" notice.
 *     network-classified error (resolved OR thrown) → mark offline + the same
 *                              fallback chain (cache → replica → notice).
 *
 *   writes (insert/update/delete/upsert) and non-allowlisted RPCs
 *     always go to the network untouched — a queued or attempted write must
 *     either reach the server or fail loudly. Nothing is cached or faked.
 *     A successful write reports to lib/offline/write-refresh.ts, which
 *     coalesces a replica refresh so the local database converges right
 *     after the save instead of waiting for the hourly cycle.
 *
 * Online behavior is unchanged: the fallback only engages on offline/network
 * failures, so a working connection always sees live data.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { cacheGet, cachePut, isNetworkError } from './cache'
import { networkMonitor } from './network'
import { getDB } from './db'
import { runReplicaQuery } from './replica-query'
import { noteServerWrite } from './write-refresh'
import { beginWrite, commitWrite, failWrite } from './write-status'
import { reportRead } from './data-source'
import { hasStoredSessionUser } from './stored-session'

/** Builder methods that turn a chain into a write — never intercepted. */
const MUTATION_METHODS = new Set(['insert', 'update', 'delete', 'upsert'])

/**
 * Read-only RPCs whose last successful result may be served offline. Writes
 * (create_*, post_*, receive_*, cancel_*, transfer_*, sync_apply, …) never
 * match, so they are never cached and never fall back.
 *
 * `sales_` covers the sales-report aggregates (sales_report_summary,
 * sales_report_breakdown, sales_report_detail, sales_monthly, …). They are
 * pure reads; without the prefix they were classified as writes — never
 * cached, and thrown at the caller when offline, which left the report page
 * on a permanent spinner instead of showing its last copy.
 */
const READ_RPC_PREFIXES = ['get_', 'period_net_', 'list_', 'search_', 'fetch_', 'sales_']

/** Results larger than this are not cached (they would just bloat IndexedDB). */
const MAX_CACHED_RESULT_BYTES = 2_000_000
/** Keep at most this many query results; older ones are pruned. */
const PRUNE_KEEP = 400
const PRUNE_EVERY_PUTS = 25

type Steps = Array<[string, unknown[]]>

interface BuilderState {
  kind: 'from' | 'rpc'
  name: string
  mutation: boolean
  steps: Steps
}

export interface OfflineMissInfo {
  /** e.g. "invoices" or "rpc get_trial_balance" */
  target: string
  at: number
}

type MissListener = (info: OfflineMissInfo) => void
const missListeners = new Set<MissListener>()

/** UI hook: some data on this page had no offline copy. */
export function subscribeOfflineMiss(listener: MissListener): () => void {
  missListeners.add(listener)
  return () => missListeners.delete(listener)
}

function emitOfflineMiss(target: string): void {
  const info: OfflineMissInfo = { target, at: Date.now() }
  missListeners.forEach((listener) => {
    try {
      listener(info)
    } catch {
      // a listener must never break a read
    }
  })
}

/* ------------------------------------------------------------------ */
/* Cache keys                                                          */
/* ------------------------------------------------------------------ */

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, v) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const sorted: Record<string, unknown> = {}
        for (const k of Object.keys(v as Record<string, unknown>).sort()) {
          sorted[k] = (v as Record<string, unknown>)[k]
        }
        return sorted
      }
      return v
    })
  } catch {
    return String(value)
  }
}

async function digest(text: string): Promise<string> {
  try {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
    return Array.from(new Uint8Array(bytes))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  } catch {
    // Non-crypto fallback (no WebCrypto, e.g. some test runners).
    let hash = 0
    for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0
    return `h${hash}:${text.length}`
  }
}

/**
 * One cache key per exact query: table/rpc name plus the ordered method chain
 * with its arguments. Long argument lists (`.in('product_id', [...1000 ids])`)
 * are digested so keys stay small without risking collisions.
 */
async function buildKey(state: BuilderState): Promise<string> {
  const parts: string[] = []
  for (const [method, args] of state.steps) {
    const text = stableStringify(args)
    parts.push(`${method}(${text.length > 200 ? `sha256:${await digest(text)}` : text})`)
  }
  return `q:${state.kind}:${state.name}:${parts.join('|')}`
}

/* ------------------------------------------------------------------ */
/* Cache upkeep                                                        */
/* ------------------------------------------------------------------ */

let putsSincePrune = 0

async function pruneCachedResults(): Promise<void> {
  try {
    const db = getDB()
    // Only this wrapper's entries (":q:"), never the curated page caches.
    const rows = await db.cache.filter((row) => row.key.includes(':q:')).toArray()
    if (rows.length <= PRUNE_KEEP) return
    rows.sort((a, b) => a.updatedAt - b.updatedAt)
    const excess = rows.slice(0, rows.length - PRUNE_KEEP)
    await db.cache.bulkDelete(excess.map((row) => row.key))
  } catch {
    // best-effort
  }
}

async function rememberResult(key: string, res: { data: unknown; count?: number | null; status?: number | null; statusText?: string | null }): Promise<void> {
  try {
    const size = JSON.stringify(res.data ?? null).length
    if (size > MAX_CACHED_RESULT_BYTES) return
    await cachePut(key, {
      data: res.data,
      count: res.count ?? null,
      status: res.status ?? null,
      statusText: res.statusText ?? null,
    })
    putsSincePrune += 1
    if (putsSincePrune >= PRUNE_EVERY_PUTS) {
      putsSincePrune = 0
      void pruneCachedResults()
    }
  } catch {
    // Caching is best-effort; a failure must never break the read.
  }
}

/** Postgrest-shaped "we are offline and have no copy of this" result. */
function offlineNoCache(target: string): { data: null; error: { message: string; code: string; details: string; hint: string }; count: null; status: number; statusText: string } {
  return {
    data: null,
    error: {
      message: `Offline and no cached copy of ${target} on this device`,
      code: 'OFFLINE_NO_CACHE',
      details: '',
      hint: 'Open this page once with a connection to make it available offline.',
    },
    count: null,
    status: 0,
    statusText: 'Offline',
  }
}

/**
 * Serve a `.from(table)` read from the local replica database. Returns null
 * when the query uses something the interpreter can't replay or the table
 * isn't replicated — the caller then falls back to the offline notice.
 */
async function replicaFallback(state: BuilderState): Promise<any | null> {
  if (state.kind !== 'from') return null
  const result = await runReplicaQuery(state.name, state.steps)
  if (!result) return null
  return {
    data: result.data,
    count: result.count,
    error: null,
    status: 200,
    statusText: 'Offline (local database)',
    offline: true,
  }
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

function isReadRpc(name: string): boolean {
  const lower = name.toLowerCase()
  return READ_RPC_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

/**
 * A read failed because the access token is expired/unusable — PostgREST
 * answers 401 "JWT expired" (code PGRST301). postgrest-js returns that as a
 * normal resolved error, not a network fault: the transport is fine, so the
 * network monitor must not flip. But the page should still get its last good
 * copy instead of a hard failure — the token refresh recovers the moment
 * connectivity (or the auth service) returns, and until then the offline
 * shell is exactly the state the user is in.
 */
function isAuthExpiredError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: unknown; message?: unknown }
  if (e.code === 'PGRST301') return true
  if (typeof e.message === 'string' && /jwt expired|invalid jwt/i.test(e.message)) return true
  return false
}

/**
 * Serve a read from the last good copy: per-query cache, then the local
 * replica, then the offline-miss notice. Never called for writes.
 */
async function serveFromFallback(
  key: string,
  state: BuilderState,
  target: string,
): Promise<any> {
  const pageRead = isPageRead(state)
  const cached = await cacheGet<any>(key)
  if (cached) {
    if (pageRead) reportRead('cache', target, { offline: true })
    return { ...cached, offline: true }
  }
  const fromReplica = await replicaFallback(state)
  if (fromReplica) {
    if (pageRead) reportRead('replica', target, { offline: true })
    return fromReplica
  }
  if (pageRead) reportRead('none', target, { offline: true })
  emitOfflineMiss(target)
  return offlineNoCache(target)
}

/**
 * Tables the app shell reads on every page (the signed-in profile, the
 * notification bell). Reporting them would make every page claim "live
 * server" regardless of where its own data came from.
 */
const CHROME_TABLES = new Set(['profiles', 'notifications'])

function isPageRead(state: BuilderState): boolean {
  return state.kind === 'from' && !CHROME_TABLES.has(state.name)
}

/**
 * Writes the app performs for itself (the bell marking a notification read).
 * Reporting these would put "Server committed…" on screen for something the
 * user did not do.
 */
const SILENT_WRITE_TABLES = new Set(['notifications'])

/**
 * RPCs that write for the app rather than for the user. The number generators
 * only advance a sequence (a form asking for the next invoice number), and
 * counting them as a change would leave "1 saving" on the pill for a write the
 * user never made.
 */
function isSilentRpc(name: string): boolean {
  return name.startsWith('generate_')
}

function errorText(err: unknown): string {
  if (!err) return 'Unknown error'
  if (typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message)
  return String(err)
}

async function execute(rawBuilder: unknown, state: BuilderState): Promise<any> {
  const target = state.kind === 'rpc' ? `rpc ${state.name}` : state.name
  const key = await buildKey(state)
  const fallbackAllowed = !state.mutation
  // Every mutation reports its lifecycle so the data-source pill can count what
  // is still unsettled: whether the SERVER has the change, and whether THIS
  // DEVICE has caught up.
  const silentWrite =
    (state.kind === 'from' && SILENT_WRITE_TABLES.has(state.name)) ||
    (state.kind === 'rpc' && isSilentRpc(state.name))
  const writeId = fallbackAllowed || silentWrite ? null : beginWrite(target)

  // Offline, or no usable session record on disk: never touch the network for
  // a read — serve the last copy now. The no-session guard matters even while
  // the network is up: after auth-js has removed an unrefreshable session, a
  // request would leave unauthenticated and PostgREST would answer with an
  // anon-role, RLS-filtered (usually empty) 200 — caching that would silently
  // overwrite the last real copy of the data.
  if (fallbackAllowed && (!networkMonitor.getState().online || !hasStoredSessionUser())) {
    return serveFromFallback(key, state, target)
  }

  try {
    // Awaiting the raw builder performs the real request.
    const res: any = await rawBuilder
    if (!fallbackAllowed) {
      if (res?.error) {
        if (writeId != null) failWrite(writeId, errorText(res.error))
      } else {
        noteServerWrite(state.kind, state.name)
        if (writeId != null) commitWrite(writeId)
      }
      return res
    }

    if (res && res.error) {
      const expired = isAuthExpiredError(res.error)
      if (expired || isNetworkError(res.error)) {
        if (!expired) networkMonitor.markOffline()
        return serveFromFallback(key, state, target)
      }
      return res
    }

    if (isPageRead(state)) reportRead('server', target)
    void rememberResult(key, res)
    return res
  } catch (err) {
    if (writeId != null) failWrite(writeId, errorText(err))
    if (fallbackAllowed && isNetworkError(err)) {
      networkMonitor.markOffline()
      return serveFromFallback(key, state, target)
    }
    throw err
  }
}

function wrapBuilder(target: any, state: BuilderState): any {
  const proxy: any = new Proxy(target, {
    get(t, prop, receiver) {
      // Awaiting the builder must go through our executor, not the raw then.
      if (prop === 'then') {
        return (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
          execute(t, state).then(onFulfilled, onRejected)
      }
      if (prop === 'catch' || prop === 'finally') {
        return (arg: unknown) => (execute(t, state) as any)[prop as 'catch' | 'finally'](arg)
      }
      const value = Reflect.get(t, prop, receiver)
      if (typeof value === 'function') {
        return (...args: unknown[]) => {
          if (typeof prop === 'string') {
            if (MUTATION_METHODS.has(prop)) state.mutation = true
            state.steps.push([prop, args])
          }
          const result = value.apply(t, args)
          // Chain methods either return `this` (eq, order, limit, single, …)
          // or a NEW builder — postgrest-js v2's `.select()` returns a
          // PostgrestFilterBuilder, not the query builder it was called on.
          // Both must stay wrapped or the rest of the chain would bypass the
          // fallback entirely.
          if (result === t) return proxy
          if (
            result &&
            typeof result === 'object' &&
            typeof (result as { then?: unknown }).then === 'function' &&
            !(result instanceof Promise)
          ) {
            return wrapBuilder(result, state)
          }
          return result
        }
      }
      return value
    },
  })
  return proxy
}

/**
 * Wrap a Supabase client so reads fall back to their last successful result
 * when the network is unavailable. Auth, storage, realtime channels, writes
 * and non-read RPCs pass through untouched.
 */
export function withOfflineReads<T extends SupabaseClient>(client: T): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'from') {
        return (table: string) =>
          wrapBuilder((target as any).from(table), { kind: 'from', name: table, mutation: false, steps: [] })
      }
      if (prop === 'rpc') {
        return (fn: string, args?: unknown) => {
          const builder = (target as any).rpc(fn, args)
          if (typeof fn !== 'string' || !isReadRpc(fn)) {
            // Write RPCs stay pass-through (mutation state disables the
            // fallback); wrapping only routes the result through execute so a
            // successful call reports to the write-refresh hook.
            return wrapBuilder(builder, { kind: 'rpc', name: fn, mutation: true, steps: [['args', [args]]] })
          }
          return wrapBuilder(builder, { kind: 'rpc', name: fn, mutation: false, steps: [['args', [args]]] })
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
    },
  }) as T
}
