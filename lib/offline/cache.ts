/**
 * Read-through cache for offline data access.
 *
 * Every integrated page loads its data through cachedQuery():
 *
 *   online + cache fresh (< ttl)  → return cached instantly, no network —
 *                                   the TTL bounds egress; the next stale
 *                                   read past the TTL refreshes
 *   online + cache stale/missing  → await the live fetch, cache, return
 *   online but fetch fails        → fall back to cache (marked stale) —
 *                                   silent network drops are treated as
 *                                   offline — else rethrow
 *   offline                       → serve cache (marked stale/offline);
 *                                   throw OfflineError when never cached
 *
 * Cache rows are sealed with the per-user AES-GCM key before they touch
 * IndexedDB and are namespaced per user id, so a shared device never leaks
 * one user's snapshot to another.
 */
import { networkMonitor } from './network'
import { getDB, type CacheRow } from './db'
import { getUserKey, seal, unseal } from './crypto'
import { resolveUserId } from './session'
import { mark } from '../perf/cold-start'

export class OfflineError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OfflineError'
  }
}

export interface CachedResult<T> {
  data: T
  /** false when the data came from the local cache rather than a live fetch */
  fresh: boolean
  cachedAt: number | null
  offline: boolean
}

const NETWORK_ERROR_RE =
  /failed to fetch|networkerror|network error|fetch failed|load failed|timeout|aborted|err_internet|connection refused/i

export function isNetworkError(err: unknown): boolean {
  if (!err) return false
  let msg: string
  if (err instanceof Error) {
    msg = `${err.name}: ${err.message}`
  } else if (typeof err === 'object' && err !== null && 'message' in err) {
    // Supabase PostgrestError and friends are plain objects with a message.
    msg = String((err as { message: unknown }).message)
  } else {
    msg = String(err)
  }
  return NETWORK_ERROR_RE.test(msg)
}

export async function cachePut(key: string, data: unknown): Promise<void> {
  try {
    const userId = await resolveUserId()
    if (!userId) return
    const fullKey = `${userId}:${key}`
    const k = await getUserKey(userId)
    const blob = await seal(k, data)
    await getDB().cache.put({ key: fullKey, blob, updatedAt: Date.now() })
  } catch {
    // Caching is best-effort; a failure must never break the page.
  }
}

/** Raw cache row (still sealed) — internal TTL bookkeeping uses this. */
async function cacheGetRow(key: string): Promise<CacheRow | null> {
  try {
    const userId = await resolveUserId()
    if (!userId) return null
    return (await getDB().cache.get(`${userId}:${key}`)) ?? null
  } catch {
    return null
  }
}

/** Public getter: the cached value itself, or null (miss/corrupt/foreign key). */
export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const row = await cacheGetRow(key)
    if (!row) return null
    const userId = await resolveUserId()
    if (!userId) return null
    const k = await getUserKey(userId)
    return await unseal<T>(k, row.blob)
  } catch {
    // Corrupt/foreign-key row — treat as a miss; it will be overwritten.
    return null
  }
}

export async function cacheDelete(key: string): Promise<void> {
  try {
    const userId = await resolveUserId()
    if (!userId) return
    await getDB().cache.delete(`${userId}:${key}`)
  } catch {
    // best-effort
  }
}

export interface CachedQueryOptions<T> {
  /**
   * Serve the cached value immediately even once it is past its TTL, and
   * rebuild it in the background.
   *
   * The default blocking behaviour exists to bound egress: handing back a
   * stale value and then refreshing on every mount would re-download the
   * payload each time. Opting in trades a bounded staleness window for a first
   * paint that never waits on a rebuild. Correct for a snapshot that is
   * rebuilt from local data and whose staleness is already bounded by the
   * replica cadence (the POS catalogue); wrong for anything a money decision
   * depends on.
   *
   * Note this returns `fresh: false`, so a caller that renders a stale-data
   * banner must not opt in unless the banner is meant to appear on every
   * load — which is why this is opt-in rather than the default.
   */
  staleWhileRevalidate?: boolean
  /** Called when a background revalidation produced newer data than the
   *  value the caller was handed. Only fires on the staleWhileRevalidate path. */
  onRevalidated?: (data: T) => void
}

export async function cachedQuery<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
  options: CachedQueryOptions<T> = {},
): Promise<CachedResult<T>> {
  mark('cache:read-start')
  const row = await cacheGetRow(key)
  const cached = row ? await safeUnseal<T>(row) : null
  mark('cache:read-end')

  if (!networkMonitor.getState().online) {
    if (cached !== null) {
      return { data: cached, fresh: false, cachedAt: row!.updatedAt, offline: true }
    }
    // No page cache — but the app-wide client may still answer this fetcher
    // from the local replica database (lib/offline/read-fallback), which
    // never touches the network while the monitor is offline. Only a
    // non-empty result is cached, so a failed read can't poison the key.
    try {
      const data = await fetcher()
      if (Array.isArray(data) ? data.length > 0 : data !== null && data !== undefined) {
        void cachePut(key, data)
      }
      return { data, fresh: false, cachedAt: null, offline: true }
    } catch (err) {
      if (err instanceof OfflineError) throw err
      if (isNetworkError(err)) {
        throw new OfflineError(`Offline with no cached copy of "${key}"`)
      }
      throw err
    }
  }

  if (cached !== null && row && Date.now() - row.updatedAt < ttlMs) {
    // Fresh enough — hand it back and touch nothing. The TTL is the egress
    // budget: a background refresh here would re-download the payload on
    // every mount/keystroke, which is exactly what the cache exists to stop.
    return { data: cached, fresh: true, cachedAt: row.updatedAt, offline: false }
  }

  if (options.staleWhileRevalidate && cached !== null && row) {
    // Hand back what we have and rebuild behind the caller. Errors are
    // swallowed: the caller already has usable data, and the blocking path's
    // failure handling (mark offline, fall back to cache) belongs to the next
    // read rather than to a promise nobody is waiting on.
    void refreshOnce(key, fetcher)
      .then((res) => {
        if (res.fresh) options.onRevalidated?.(res.data)
      })
      .catch(() => {})
    return { data: cached, fresh: false, cachedAt: row.updatedAt, offline: false }
  }

  return refreshOnce<T>(key, fetcher)
}

/**
 * One in-flight rebuild per cache key.
 *
 * Two callers asking for the same key at the same time — the POS mount effect
 * plus a replica notification, or two components sharing one dataset — used to
 * run the fetcher, the seal and the IndexedDB write twice and then discard one
 * result. Rebuilding the catalogue snapshot is ~300 ms of blocking work and a
 * ~4.9 MB write, so sharing it is not a micro-optimisation. Same key means the
 * same dataset, so the second caller is correct to receive the first's result.
 */
const inFlight = new Map<string, Promise<CachedResult<unknown>>>()

function refreshOnce<T>(key: string, fetcher: () => Promise<T>): Promise<CachedResult<T>> {
  const existing = inFlight.get(key)
  if (existing) return existing as Promise<CachedResult<T>>
  const running = refresh<T>(key, fetcher)
  inFlight.set(key, running as Promise<CachedResult<unknown>>)
  const settle = () => { inFlight.delete(key) }
  running.then(settle, settle)
  return running
}

async function safeUnseal<T>(row: CacheRow): Promise<T | null> {
  try {
    const userId = await resolveUserId()
    if (!userId) return null
    const k = await getUserKey(userId)
    return await unseal<T>(k, row.blob)
  } catch {
    return null
  }
}

async function refresh<T>(key: string, fetcher: () => Promise<T>): Promise<CachedResult<T>> {
  const row = await cacheGetRow(key)
  const cached = row ? await safeUnseal<T>(row) : null
  try {
    mark('cache:fetch-start')
    const data = await fetcher()
    mark('cache:fetch-end')
    mark('cache:put-start')
    await cachePut(key, data)
    mark('cache:put-end')
    return { data, fresh: true, cachedAt: Date.now(), offline: false }
  } catch (err) {
    if (isNetworkError(err)) {
      networkMonitor.markOffline()
      if (cached !== null && row) {
        return { data: cached, fresh: false, cachedAt: row.updatedAt, offline: true }
      }
      throw new OfflineError(`Network failed and no cached copy of "${key}"`)
    }
    throw err
  }
}

/**
 * Direct typed patch access used by optimistic local updates (e.g. the POS
 * decrementing cached stock after an offline sale). Returning null skips the
 * write — never write placeholder empties, they'd mask the next live fetch.
 */
export async function mutateCache<T>(key: string, fn: (current: T | null) => T | null): Promise<void> {
  const current = await cacheGet<T>(key)
  const next = fn(current)
  if (next === null || next === undefined) return
  await cachePut(key, next)
}
