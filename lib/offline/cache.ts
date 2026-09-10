/**
 * Read-through cache for offline data access.
 *
 * Every integrated page loads its data through cachedQuery():
 *
 *   online + cache fresh (< ttl)  → return cached instantly, refresh in
 *                                   the background (stale-while-revalidate)
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

export async function cachedQuery<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
): Promise<CachedResult<T>> {
  const row = await cacheGetRow(key)
  const cached = row ? await safeUnseal<T>(row) : null

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
    // Fresh enough — hand it back immediately and refresh behind the curtain.
    void refresh<T>(key, fetcher).catch(() => {})
    return { data: cached, fresh: true, cachedAt: row.updatedAt, offline: false }
  }

  return refresh<T>(key, fetcher)
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
    const data = await fetcher()
    await cachePut(key, data)
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
