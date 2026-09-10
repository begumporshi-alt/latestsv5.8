/**
 * Unwrap a PostgREST read result inside a cachedQuery fetcher.
 *
 * Why this exists: postgrest resolves network failures as `{ data: null,
 * error }` — it does not throw. Fetchers written as `(await ...).data || []`
 * therefore returned an EMPTY LIST on failure, and the cache layer happily
 * stored that empty list over the last good snapshot ("poisoned cache") — the
 * page looked like it had no data even though a copy existed.
 *
 * Throwing keeps the failure a failure: cachedQuery then serves the previous
 * snapshot (or the offline fallback), and a genuinely broken query still
 * surfaces to the caller.
 */
export function readData<T>(res: { data: T | null; error: unknown }, empty: T): T {
  if (res.error) throw res.error
  return res.data ?? empty
}
