/**
 * Write lifecycle — the "server committed, device copy catching up" state the
 * GRN panel used to show on its own, generalised to every write in the app and
 * rendered inside the data-source pill.
 *
 * Why this lives at the client boundary: writes are issued from ~50 pages,
 * most of them as a chain of `.from()` calls plus one RPC. Instrumenting each
 * page would drift immediately. The app-wide client wrapper
 * (lib/offline/read-fallback.ts) already sees every mutation, so the states are
 * derived there and rendered once, from the header:
 *
 *   saving     → the request is in flight
 *   committed  → the server transaction succeeded; the device copy is behind
 *   synced     → the local replica reflects the write (awaitPendingWrites)
 *   deferred   → the server has it, but the local copy will catch up later
 *   failed     → the server rejected it (nothing was written)
 *   queued     → offline: sealed into the outbox, will replay on reconnect
 *
 * The unit is a QUEUE, not a single activity: a banner that appears and
 * disappears per save is noise, while a count of what is still unsettled is
 * information. `pending` is what the pill counts down to zero; settled items
 * stay in the list for a few seconds so the last outcome is still readable when
 * the popover is opened, and failures stay until acknowledged.
 *
 * A single save is usually several writes (product row, units, colours, stock,
 * opening-batch RPC). They coalesce into one item for a short window so a save
 * counts as one change instead of flickering through eight.
 */

import { awaitPendingWrites } from './write-refresh'

export type WritePhase = 'saving' | 'committed' | 'synced' | 'deferred' | 'failed' | 'queued'

export interface WriteActivity {
  id: number
  phase: WritePhase
  /** table name or `rpc <name>` */
  target: string
  /** human label when the caller knows one (e.g. the outbox label) */
  label: string | null
  startedAt: number
  updatedAt: number
  /** how many individual writes this activity covers */
  writes: number
  error: string | null
}

export interface WriteState {
  /** Newest first: unsettled writes, plus the ones that settled recently. */
  items: WriteActivity[]
  /** saving + committed — what the pill counts down. */
  pending: number
  /** sealed into the outbox offline, waiting for a reconnect. */
  queued: number
  /** rejected by the server and not yet dismissed. */
  failed: number
  /** Newest item, whatever its phase. */
  latest: WriteActivity | null
}

const COALESCE_MS = 2_500
const SETTLE_DEBOUNCE_MS = 220
/** How long a settled item stays readable in the popover. */
const SYNCED_RETENTION_MS = 4_000
const DEFERRED_RETENTION_MS = 9_000
const QUEUED_RETENTION_MS = 8_000
/** Bounded list: settled entries are dropped first, never a pending one. */
const MAX_ITEMS = 6

let seq = 0
let items: WriteActivity[] = []
const listeners = new Set<() => void>()
const settleTimers = new Map<number, ReturnType<typeof setTimeout>>()
const retainTimers = new Map<number, ReturnType<typeof setTimeout>>()

function build(): WriteState {
  let pending = 0
  let queued = 0
  let failed = 0
  for (const item of items) {
    if (item.phase === 'saving' || item.phase === 'committed') pending += 1
    else if (item.phase === 'queued') queued += 1
    else if (item.phase === 'failed') failed += 1
  }
  return { items, pending, queued, failed, latest: items[0] ?? null }
}

/** A stable object between emits — useSyncExternalStore compares by identity. */
let snapshot: WriteState = build()

function emit(): void {
  snapshot = build()
  listeners.forEach((listener) => {
    try {
      listener()
    } catch {
      // a listener must never break a write
    }
  })
}

export function getWriteState(): WriteState {
  return snapshot
}

export function subscribeWriteState(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Newest activity only. Kept for callers that do not need the queue. */
export function getWriteActivity(): WriteActivity | null {
  return snapshot.latest
}

export const subscribeWriteActivity = subscribeWriteState

function patch(id: number, change: Partial<WriteActivity>): WriteActivity | null {
  const index = items.findIndex((item) => item.id === id)
  if (index < 0) return null
  const next = { ...items[index], ...change }
  items = [...items.slice(0, index), next, ...items.slice(index + 1)]
  return next
}

function clearTimer(map: Map<number, ReturnType<typeof setTimeout>>, id: number): void {
  const timer = map.get(id)
  if (timer) clearTimeout(timer)
  map.delete(id)
}

/** Drop settled entries from the tail, never a pending one. */
function trim(): void {
  while (items.length > MAX_ITEMS) {
    let index = -1
    for (let i = items.length - 1; i >= 0; i--) {
      const phase = items[i].phase
      if (phase === 'synced' || phase === 'deferred' || phase === 'queued') {
        index = i
        break
      }
    }
    if (index < 0) return
    items = [...items.slice(0, index), ...items.slice(index + 1)]
  }
}

function retain(id: number, ms: number): void {
  clearTimer(retainTimers, id)
  const timer = setTimeout(() => {
    retainTimers.delete(id)
    items = items.filter((item) => item.id !== id)
    emit()
  }, ms)
  ;(timer as { unref?: () => void }).unref?.()
  retainTimers.set(id, timer)
}

/** A write has been issued. Returns the activity id to commit/fail. */
export function beginWrite(target: string, label?: string | null): number {
  const now = Date.now()
  const head = items[0]
  // One save issues a chain of writes; count them as one change.
  if (head && head.phase === 'saving' && now - head.startedAt <= COALESCE_MS) {
    items[0] = {
      ...head,
      target,
      label: label ?? head.label,
      updatedAt: now,
      writes: head.writes + 1,
    }
    emit()
    return items[0].id
  }

  const activity: WriteActivity = {
    id: ++seq,
    phase: 'saving',
    target,
    label: label ?? null,
    startedAt: now,
    updatedAt: now,
    writes: 1,
    error: null,
  }
  items = [activity, ...items]
  trim()
  emit()
  return activity.id
}

/**
 * The server transaction succeeded. The device copy converges on its own
 * schedule; this tracks that second step so the UI can state which of the two
 * is true instead of implying they happened together.
 */
export function commitWrite(id: number): void {
  // A later write in the same coalesced burst must not overwrite a failure:
  // the activity is only "saved" if every write in it was.
  const existing = items.find((item) => item.id === id)
  if (!existing || existing.phase === 'failed') return
  patch(id, { phase: 'committed', updatedAt: Date.now(), error: null })
  emit()
  clearTimer(settleTimers, id)
  const timer = setTimeout(() => {
    settleTimers.delete(id)
    void settle(id)
  }, SETTLE_DEBOUNCE_MS)
  ;(timer as { unref?: () => void }).unref?.()
  settleTimers.set(id, timer)
}

async function settle(id: number): Promise<void> {
  let ok = true
  try {
    ok = await awaitPendingWrites()
  } catch {
    ok = false
  }
  const current = items.find((item) => item.id === id)
  if (!current || current.phase === 'failed') return
  patch(id, { phase: ok ? 'synced' : 'deferred', updatedAt: Date.now() })
  emit()
  retain(id, ok ? SYNCED_RETENTION_MS : DEFERRED_RETENTION_MS)
}

export function failWrite(id: number, message: string): void {
  const activity = patch(id, { phase: 'failed', error: message, updatedAt: Date.now() })
  if (!activity) return
  // A failure is not transient news: it stays until the user dismisses it.
  clearTimer(settleTimers, id)
  clearTimer(retainTimers, id)
  emit()
}

/** Offline: the change is sealed into the outbox and will replay on reconnect. */
export function queueWrite(label: string): void {
  const now = Date.now()
  const head = items[0]
  if (head && head.phase === 'queued' && now - head.startedAt <= COALESCE_MS) {
    items[0] = { ...head, label, updatedAt: now, writes: head.writes + 1 }
    emit()
    return
  }
  const activity: WriteActivity = {
    id: ++seq,
    phase: 'queued',
    target: 'outbox',
    label,
    startedAt: now,
    updatedAt: now,
    writes: 1,
    error: null,
  }
  items = [activity, ...items]
  trim()
  emit()
  retain(activity.id, QUEUED_RETENTION_MS)
}

/** Remove one item, or every item that is no longer in flight. */
export function dismissWrite(id?: number): void {
  if (id != null) {
    clearTimer(settleTimers, id)
    clearTimer(retainTimers, id)
    items = items.filter((item) => item.id !== id)
  } else {
    items = items.filter((item) => item.phase === 'saving' || item.phase === 'committed')
  }
  emit()
}

/** Test-only reset. */
export function __resetWriteActivityForTests(): void {
  items = []
  settleTimers.forEach((timer) => clearTimeout(timer))
  retainTimers.forEach((timer) => clearTimeout(timer))
  settleTimers.clear()
  retainTimers.clear()
  seq = 0
  snapshot = build()
}
