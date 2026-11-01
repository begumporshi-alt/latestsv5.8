/**
 * Bounded waiting for work on a paint path.
 *
 * A cashier-facing screen must never sit on a loading state because a
 * subsystem did not answer. The POS grid is the case that motivated this:
 * the local catalogue read is normally 100–200 ms, but IndexedDB can be
 * blocked by another tab's upgrade, a decrypt can wedge, and a profile can
 * end up in a state where the database never opens at all. None of those
 * produce an error — the promise simply never settles — so the grid stayed
 * on its skeleton with nothing to click and nothing to report.
 *
 * `withinBudget` converts "never" into "not yet": the caller gets `fallback`
 * after `ms` and can paint from a slower-but-working source (the server
 * page), while the original work continues and populates the cache behind it.
 *
 * Deliberately NOT a cancellation mechanism. Aborting the underlying work
 * would throw away a read that is probably about to succeed, and the cache it
 * is filling is what makes the next open fast.
 */

export interface Budgeted<T> {
  value: T
  /** True when the budget expired and `value` is the fallback. */
  timedOut: boolean
}

export async function withinBudget<T>(
  work: Promise<T>,
  ms: number,
  fallback: T,
  onExpire?: () => void,
): Promise<Budgeted<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<Budgeted<T>>((resolve) => {
    timer = setTimeout(() => {
      try {
        onExpire?.()
      } catch {
        // Reporting must never break the path it is reporting on.
      }
      resolve({ value: fallback, timedOut: true })
    }, ms)
  })

  // Both outcomes are funnelled into a value rather than a rejection: when the
  // budget expires first, a later rejection from `work` would otherwise have no
  // handler attached and surface as an unhandled promise rejection.
  const settled = work.then(
    (value) => ({ value, timedOut: false as const }),
    (error: unknown) => ({ error }),
  )

  try {
    const raced = await Promise.race([settled, expiry])
    if ('error' in raced) throw raced.error
    return raced
  } finally {
    // Not cosmetic: without this the timer keeps the event loop alive and a
    // fast resolution still pays the full timeout before the process can idle.
    if (timer) clearTimeout(timer)
  }
}
