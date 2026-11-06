/**
 * Read provenance — "where did the data on this page actually come from?"
 *
 * The app reads through three different paths and the user cannot tell them
 * apart from the rendered result:
 *
 *   server   → a live PostgREST response (the online database)
 *   replica  → the encrypted local database on this device (lib/offline/replica)
 *   cache    → a page-level snapshot (lib/offline/cache) taken earlier
 *
 * Every read path reports here; the header pill renders the highest-priority
 * source seen for the CURRENT page since it was opened. Counts are keyed by
 * `window.location.pathname`, so a navigation never inherits the previous
 * page's provenance (and a read that lands during a transition cannot be
 * attributed to the wrong page).
 *
 * Reporting is deliberately cheap: a plain object update plus a throttled
 * notification. A page that issues 40 reads must not cause 40 re-renders.
 */

export type DataSourceKind = 'server' | 'replica' | 'cache' | 'none'

const PRIORITY: Record<DataSourceKind, number> = {
  server: 3,
  replica: 2,
  cache: 1,
  none: 0,
}

export interface DataSourceSnapshot {
  page: string
  /** Highest-priority source used on this page since it was opened. */
  primary: DataSourceKind | null
  counts: Record<DataSourceKind, number>
  /** Last time each source served a read on this page. */
  lastAt: Partial<Record<DataSourceKind, number>>
  lastTarget: string | null
  updatedAt: number
  /** At least one read on this page was served from a local fallback. */
  offline: boolean
}

interface PageState {
  counts: Record<DataSourceKind, number>
  lastAt: Partial<Record<DataSourceKind, number>>
  lastTarget: string | null
  updatedAt: number
  offline: boolean
}

/** Keep the map bounded — a long session visits many routes. */
const MAX_PAGES = 24

const pages = new Map<string, PageState>()
const listeners = new Set<() => void>()

function emptyCounts(): Record<DataSourceKind, number> {
  return { server: 0, replica: 0, cache: 0, none: 0 }
}

let snapshot: DataSourceSnapshot = {
  page: '/',
  primary: null,
  counts: emptyCounts(),
  lastAt: {},
  lastTarget: null,
  updatedAt: 0,
  offline: false,
}

let emitTimer: ReturnType<typeof setTimeout> | null = null
let lastEmitAt = 0
const EMIT_THROTTLE_MS = 120

function currentPage(): string {
  if (typeof window === 'undefined') return '/'
  return window.location.pathname || '/'
}

function buildSnapshot(page: string): DataSourceSnapshot {
  const state = pages.get(page)
  if (!state) {
    return {
      page,
      primary: null,
      counts: emptyCounts(),
      lastAt: {},
      lastTarget: null,
      updatedAt: 0,
      offline: false,
    }
  }
  let primary: DataSourceKind | null = null
  for (const kind of Object.keys(state.counts) as DataSourceKind[]) {
    if (state.counts[kind] <= 0) continue
    if (primary === null || PRIORITY[kind] > PRIORITY[primary]) primary = kind
  }
  return {
    page,
    primary,
    counts: { ...state.counts },
    lastAt: { ...state.lastAt },
    lastTarget: state.lastTarget,
    updatedAt: state.updatedAt,
    offline: state.offline,
  }
}

function prune(): void {
  if (pages.size <= MAX_PAGES) return
  const page = currentPage()
  const candidates = [...pages.entries()]
    .filter(([key]) => key !== page)
    .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
  const excess = pages.size - MAX_PAGES
  for (let i = 0; i < excess && i < candidates.length; i++) {
    pages.delete(candidates[i][0])
  }
}

function emitNow(): void {
  if (emitTimer) {
    clearTimeout(emitTimer)
    emitTimer = null
  }
  lastEmitAt = Date.now()
  snapshot = buildSnapshot(currentPage())
  listeners.forEach((listener) => {
    try {
      listener()
    } catch {
      // a listener must never break a read
    }
  })
}

function scheduleEmit(): void {
  if (typeof window === 'undefined') return
  if (Date.now() - lastEmitAt >= EMIT_THROTTLE_MS) {
    emitNow()
    return
  }
  if (emitTimer) return
  emitTimer = setTimeout(emitNow, EMIT_THROTTLE_MS)
  ;(emitTimer as { unref?: () => void }).unref?.()
}

/**
 * Record one read.
 *
 * `offline` marks the read as served from a local fallback (cache or replica
 * while the network is unavailable) so the pill can say so explicitly rather
 * than implying the numbers are live.
 */
export function reportRead(
  kind: DataSourceKind,
  target: string,
  opts: { offline?: boolean } = {},
): void {
  if (typeof window === 'undefined') return
  const page = currentPage()
  const now = Date.now()
  let state = pages.get(page)
  if (!state) {
    state = { counts: emptyCounts(), lastAt: {}, lastTarget: null, updatedAt: now, offline: false }
    pages.set(page, state)
    prune()
  }
  state.counts[kind] += 1
  state.lastAt[kind] = now
  state.lastTarget = target
  state.updatedAt = now
  // A live server read proves the connection is working; only a fallback read
  // (or a failed one) may leave the page flagged as offline.
  if (kind === 'server') state.offline = false
  else if (opts.offline) state.offline = true
  scheduleEmit()
}

/**
 * Recompute for the current route. Called by the pill on navigation: reports
 * are keyed by pathname, so this only has to swap the visible snapshot.
 */
export function syncDataSourcePage(): void {
  if (typeof window === 'undefined') return
  if (snapshot.page === currentPage()) return
  emitNow()
}

export function subscribeDataSource(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getDataSourceSnapshot(): DataSourceSnapshot {
  return snapshot
}

/** Test-only reset. */
export function __resetDataSourceForTests(): void {
  pages.clear()
  if (emitTimer) clearTimeout(emitTimer)
  emitTimer = null
  lastEmitAt = 0
  snapshot = {
    page: '/',
    primary: null,
    counts: emptyCounts(),
    lastAt: {},
    lastTarget: null,
    updatedAt: 0,
    offline: false,
  }
}
