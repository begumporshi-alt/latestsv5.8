/**
 * Cold-start timing instrumentation.
 *
 * "The POS is slow the first time I open it after boot" cannot be fixed by
 * code inspection alone: the candidate costs overlap (auth gate, IndexedDB
 * read, per-row decrypt, snapshot seal, the background replica pass) and
 * their weight changes with catalogue size. This module records a small set
 * of named checkpoints on the Performance timeline and prints ONE delta
 * table per cold boot, so every change in this workstream is justified by a
 * measurement rather than an estimate.
 *
 * Off by default. Enable with either:
 *   - `?perf=1` on the URL, or
 *   - `localStorage.setItem('perf:cold-start', '1')` (then reload)
 *
 * The localStorage form is what a measurement run against a production
 * build needs, where you cannot edit the URL before the first navigation.
 * Disable with `localStorage.removeItem('perf:cold-start')`.
 *
 * Design constraints:
 *  - Nothing here may throw. Instrumentation must never break a page, so
 *    every entry point is wrapped and every failure is swallowed.
 *  - Marks are cheap (a Performance entry each) but a cold boot should
 *    accumulate tens of them, not thousands: never mark inside a per-row
 *    loop.
 *  - `performance.mark` timestamps are relative to `timeOrigin`, which for a
 *    normal navigation is the navigation start — exactly the origin we want
 *    to report deltas against.
 */

const FLAG_KEY = 'perf:cold-start'
const PREFIX = 'cold:'

/** Print the table this long after the first mark — long enough to include
 *  the first-paint and cache-write marks, short enough to still be useful. */
const REPORT_DELAY_MS = 10_000

let enabledCache: boolean | null = null
let reportScheduled = false

/** True when instrumentation was switched on for this document. */
export function perfEnabled(): boolean {
  if (enabledCache !== null) return enabledCache
  if (typeof window === 'undefined') {
    enabledCache = false
    return enabledCache
  }
  try {
    const byQuery = new URLSearchParams(window.location.search).get('perf') === '1'
    const byStorage = window.localStorage.getItem(FLAG_KEY) === '1'
    enabledCache = byQuery || byStorage
  } catch {
    // Private mode / storage disabled — stay silent.
    enabledCache = false
  }
  return enabledCache
}

/**
 * Record a checkpoint. Idempotent: a second call with the same name is
 * ignored, so a retried code path cannot produce duplicate rows.
 */
export function mark(name: string): void {
  if (!perfEnabled() || typeof performance === 'undefined') return
  try {
    const full = PREFIX + name
    if (performance.getEntriesByName(full, 'mark').length > 0) return
    performance.mark(full)
    scheduleReport()
  } catch {
    // never let instrumentation break the caller
  }
}

/**
 * Record a named span from `startName` to now. Used where a single
 * start/end pair is clearer than two marks.
 */
export function measure(name: string, startName: string): void {
  if (!perfEnabled() || typeof performance === 'undefined') return
  try {
    const start = performance.getEntriesByName(PREFIX + startName, 'mark')[0]
    if (!start) return
    const full = PREFIX + name
    if (performance.getEntriesByName(full, 'measure').length > 0) return
    performance.measure(full, PREFIX + startName)
  } catch {
    // best-effort
  }
}

interface Row {
  checkpoint: string
  /** ms since navigation start */
  at: number
  /** ms since the previous checkpoint in this table */
  delta: number
}

/** Build the report rows from the marks currently on the timeline. */
export function collect(): Row[] {
  if (typeof performance === 'undefined') return []
  let entries: PerformanceEntry[] = []
  try {
    entries = performance.getEntriesByType('mark').filter((e) => e.name.startsWith(PREFIX))
  } catch {
    return []
  }
  const rows: Row[] = entries
    .map((e) => ({ checkpoint: e.name.slice(PREFIX.length), at: e.startTime, delta: 0 }))
    .sort((a, b) => a.at - b.at)
  for (let i = 1; i < rows.length; i++) rows[i].delta = rows[i].at - rows[i - 1].at
  return rows
}

/** Print the checkpoint table. Safe to call repeatedly. */
export function report(): Row[] {
  const rows = collect()
  if (!perfEnabled() || rows.length === 0) return rows
  try {
    // eslint-disable-next-line no-console
    console.groupCollapsed(
      `%c[cold start] ${rows.length} checkpoints · total ${rows[rows.length - 1].at.toFixed(0)} ms`,
      'color:#2563eb;font-weight:600',
    )
    // eslint-disable-next-line no-console
    console.table(
      rows.map((r) => ({
        checkpoint: r.checkpoint,
        'at (ms)': Math.round(r.at),
        'delta (ms)': Math.round(r.delta),
      })),
    )
    // eslint-disable-next-line no-console
    console.groupEnd()
  } catch {
    // console unavailable — nothing to do
  }
  return rows
}

function scheduleReport(): void {
  if (reportScheduled) return
  reportScheduled = true
  try {
    setTimeout(() => report(), REPORT_DELAY_MS)
  } catch {
    // ignore
  }
}

// Manual access from the devtools console: `__coldStart.report()`.
if (typeof window !== 'undefined') {
  try {
    ;(window as unknown as { __coldStart?: unknown }).__coldStart = { mark, report, collect }
  } catch {
    // ignore
  }
}
