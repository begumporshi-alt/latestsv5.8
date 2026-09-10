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
 *
 * Online behavior is unchanged: the fallback only engages on offline/network
 * failures, so a working connection always sees live data.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { cacheGet, cachePut, isNetworkError } from './cache'
import { networkMonitor } from './network'
import { getDB } from './db'
import { runReplicaQuery } from './replica-query'

/** Builder methods that turn a chain into a write — never intercepted. */
const MUTATION_METHODS = new Set(['insert', 'update', 'delete', 'upsert'])

/**
 * Read-only RPCs whose last successful result may be served offline. Writes
 * (create_*, post_*, receive_*, cancel_*, transfer_*, sync_apply, …) never
 * match, so they are never cached and never fall back.
 */
const READ_RPC_PREFIXES = ['get_', 'period_net_', 'list_', 'search_', 'fetch_']

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

async function execute(rawBuilder: unknown, state: BuilderState): Promise<any> {
  const target = state.kind === 'rpc' ? `rpc ${state.name}` : state.name
  const key = await buildKey(state)
  const fallbackAllowed = !state.mutation

  // Offline: never touch the network for a read — serve the last copy now.
  if (fallbackAllowed && !networkMonitor.getState().online) {
    const cached = await cacheGet<any>(key)
    if (cached) return { ...cached, offline: true }
    const fromReplica = await replicaFallback(state)
    if (fromReplica) return fromReplica
    emitOfflineMiss(target)
    return offlineNoCache(target)
  }

  try {
    // Awaiting the raw builder performs the real request.
    const res: any = await rawBuilder
    if (!fallbackAllowed) return res

    if (res && res.error) {
      if (isNetworkError(res.error)) {
        networkMonitor.markOffline()
        const cached = await cacheGet<any>(key)
        if (cached) return { ...cached, offline: true }
        const fromReplica = await replicaFallback(state)
        if (fromReplica) return fromReplica
        emitOfflineMiss(target)
      }
      return res
    }

    void rememberResult(key, res)
    return res
  } catch (err) {
    if (fallbackAllowed && isNetworkError(err)) {
      networkMonitor.markOffline()
      const cached = await cacheGet<any>(key)
      if (cached) return { ...cached, offline: true }
      const fromReplica = await replicaFallback(state)
      if (fromReplica) return fromReplica
      emitOfflineMiss(target)
      return offlineNoCache(target)
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
          if (typeof fn !== 'string' || !isReadRpc(fn)) return builder
          return wrapBuilder(builder, { kind: 'rpc', name: fn, mutation: false, steps: [['args', [args]]] })
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
    },
  }) as T
}
