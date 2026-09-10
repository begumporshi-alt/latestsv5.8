/**
 * Outbox: the write path for offline mode.
 *
 * Pages call enqueueOp() with the exact payload the server-side sync_apply
 * handler expects. The payload is AES-GCM sealed with the user's local key
 * before it touches IndexedDB, so queued business data is encrypted at rest.
 *
 * The item id is a client-generated UUID that the server uses as its
 * idempotency key — a replayed sync can never double-apply an operation.
 */
import { getDB, type OutboxItem, type OutboxStatus } from './db'
import { getUserKey, seal, unseal } from './crypto'
import { resolveUserId } from './session'

type OutboxListener = () => void
const listeners = new Set<OutboxListener>()

export function subscribeOutbox(listener: OutboxListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function notifyOutboxChanged(): void {
  listeners.forEach((l) => l())
}

async function requireUserId(): Promise<string> {
  // Works with an expired access token: queued work is sealed and namespaced
  // with the last signed-in user's key, and syncs under their identity once a
  // real token is available again.
  const userId = await resolveUserId()
  if (!userId) {
    throw new Error('Cannot queue offline changes without a signed-in session')
  }
  return userId
}

export async function enqueueOp(op: string, payload: unknown, label: string): Promise<OutboxItem> {
  const userId = await requireUserId()
  const key = await getUserKey(userId)
  const item: OutboxItem = {
    id: crypto.randomUUID(),
    op,
    label,
    payload: await seal(key, payload),
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    retries: 0,
  }
  await getDB().outbox.put(item)
  notifyOutboxChanged()
  return item
}

export async function listOutbox(): Promise<OutboxItem[]> {
  try {
    const all = await getDB().outbox.toArray()
    return all.sort((a, b) => b.createdAt - a.createdAt)
  } catch {
    return []
  }
}

export interface OutboxCounts {
  pending: number
  syncing: number
  synced: number
  conflict: number
  failed: number
  discarded: number
}

export async function outboxCounts(): Promise<OutboxCounts> {
  const empty: OutboxCounts = { pending: 0, syncing: 0, synced: 0, conflict: 0, failed: 0, discarded: 0 }
  try {
    const all = await getDB().outbox.toArray()
    for (const item of all) {
      empty[item.status as keyof OutboxCounts] = (empty[item.status as keyof OutboxCounts] ?? 0) + 1
    }
  } catch {
    // storage unavailable
  }
  return empty
}

export async function unsealPayload<T>(item: OutboxItem): Promise<T> {
  const userId = await requireUserId()
  const key = await getUserKey(userId)
  return unseal<T>(key, item.payload)
}

export async function unsealServerResult<T>(item: OutboxItem): Promise<T | null> {
  if (!item.serverResult) return null
  const userId = await requireUserId()
  const key = await getUserKey(userId)
  return unseal<T>(key, item.serverResult)
}

export async function unsealConflictData<T>(item: OutboxItem): Promise<T | null> {
  if (!item.conflictData) return null
  const userId = await requireUserId()
  const key = await getUserKey(userId)
  return unseal<T>(key, item.conflictData)
}

async function patchItem(id: string, patch: Partial<OutboxItem>): Promise<void> {
  await getDB().outbox.update(id, { ...patch, updatedAt: Date.now() })
  notifyOutboxChanged()
}

/** "Overwrite server": re-queue the same payload with force=true. */
export async function resolveConflictOverwrite(item: OutboxItem): Promise<void> {
  const payload = await unsealPayload<Record<string, unknown>>(item)
  payload.force = true
  const userId = await requireUserId()
  const key = await getUserKey(userId)
  await patchItem(item.id, {
    payload: await seal(key, payload),
    status: 'pending',
    retries: 0,
    conflictData: undefined,
    lastError: undefined,
  })
}

/** "Keep server": drop the local change. */
export async function resolveConflictKeepServer(item: OutboxItem): Promise<void> {
  await patchItem(item.id, { status: 'discarded', conflictData: undefined })
}

/** Manual retry of a parked item. */
export async function retryFailedItem(item: OutboxItem): Promise<void> {
  await patchItem(item.id, { status: 'pending', retries: 0, lastError: undefined })
}

export async function discardItem(item: OutboxItem): Promise<void> {
  await patchItem(item.id, { status: 'discarded' })
}

/** Remove synced/discarded items from the local history. */
export async function clearResolvedItems(): Promise<void> {
  const db = getDB()
  const resolved = await db.outbox
    .filter((i) => i.status === 'synced' || i.status === 'discarded')
    .primaryKeys()
  await db.outbox.bulkDelete(resolved)
  notifyOutboxChanged()
}

/** Items stuck mid-flight (tab closed during a sync) return to the queue. */
export async function resetInFlightItems(): Promise<void> {
  const db = getDB()
  const stuck = await db.outbox.filter((i) => i.status === 'syncing').primaryKeys()
  if (stuck.length > 0) {
    await Promise.all(stuck.map((id) => db.outbox.update(id, { status: 'pending' as OutboxStatus })))
    notifyOutboxChanged()
  }
}
