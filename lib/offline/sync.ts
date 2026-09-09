/**
 * Sync engine: replays the encrypted outbox against the server when a
 * connection is available.
 *
 * Triggers: connectivity regained (probed, not just the OS event), a 30s
 * interval while online, a manual "Sync now", and app startup.
 *
 * Ordering: items are applied strictly in createdAt order — a queued
 * product.create will land before the invoice that uses it.
 *
 * Outcomes per item:
 *   synced | duplicate → marked synced, server result stored
 *                          (duplicate = the server already applied this item
 *                           id in an earlier delivery — idempotent by design)
 *   conflict            → parked with the server row; the Sync Center offers
 *                         "Overwrite server" (force retry) or "Keep server"
 *   network error       → engine marks the app offline and stops; the item
 *                         stays pending for the next window
 *   rpc error           → retried with backoff; after MAX_RETRIES total
 *                         attempts the item is parked as failed with the
 *                         server's error message
 *
 * Transport security: every sync call goes through the same authenticated
 * HTTPS channel as the rest of the app (TLS to Supabase); payloads are only
 * unsealed in memory for the duration of the call.
 */
import { supabase } from '../supabase'
import { getDB, setMeta, getMeta, type OutboxItem } from './db'
import { getUserKey, seal, unseal } from './crypto'
import { networkMonitor } from './network'
import { isNetworkError } from './cache'
import { notifyOutboxChanged, resetInFlightItems } from './outbox'

const DRAIN_INTERVAL_MS = 30_000
const MAX_ATTEMPTS_PER_DRAIN = 2
const MAX_TOTAL_RETRIES = 5
const BACKOFF_BASE_MS = 3_000

export interface SyncApplyResult {
  status: 'synced' | 'duplicate' | 'conflict' | 'error'
  reason?: string
  server_row?: unknown
  [key: string]: unknown
}

type EngineListener = (state: SyncEngineState) => void

export interface SyncEngineState {
  running: boolean
  lastSyncAt: number | null
  lastError: string | null
}

class SyncEngine {
  private state: SyncEngineState = { running: false, lastSyncAt: null, lastError: null }
  private listeners = new Set<EngineListener>()
  private timer: ReturnType<typeof setInterval> | null = null
  private started = false

  getState(): SyncEngineState {
    return { ...this.state }
  }

  subscribe(listener: EngineListener): () => void {
    this.listeners.add(listener)
    listener(this.getState())
    return () => this.listeners.delete(listener)
  }

  private setState(patch: Partial<SyncEngineState>) {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((l) => l(this.getState()))
  }

  async start(): Promise<void> {
    if (this.started || typeof window === 'undefined') return
    this.started = true
    networkMonitor.start()
    await resetInFlightItems()
    const last = await getMeta<number>('lastSyncAt')
    if (last) this.setState({ lastSyncAt: last })

    networkMonitor.subscribe((s) => {
      if (s.online) void this.drain()
    })
    this.timer = setInterval(() => {
      if (networkMonitor.getState().online) void this.drain()
    }, DRAIN_INTERVAL_MS)

    if (networkMonitor.getState().online) void this.drain()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.started = false
  }

  /** Manual trigger from the Sync Center. */
  async syncNow(): Promise<void> {
    await networkMonitor.probe()
    if (networkMonitor.getState().online) {
      await this.drain()
    } else {
      this.setState({ lastError: 'Still offline — cannot sync right now' })
    }
  }

  async drain(): Promise<void> {
    if (this.state.running) return
    if (!networkMonitor.getState().online) return

    const { data } = await supabase.auth.getSession()
    const userId = data.session?.user?.id
    if (!userId) return

    this.setState({ running: true })
    try {
      const key = await getUserKey(userId)
      const db = getDB()
      const queue = (await db.outbox.where('status').equals('pending').toArray()).sort(
        (a, b) => a.createdAt - b.createdAt,
      )
      for (const item of queue) {
        if (!networkMonitor.getState().online) break
        await this.applyItem(item, key)
      }
      if (queue.length > 0 || this.state.lastSyncAt === null) {
        const now = Date.now()
        await setMeta('lastSyncAt', now)
        this.setState({ lastSyncAt: now })
      }
    } catch (err) {
      this.setState({ lastError: err instanceof Error ? err.message : String(err) })
    } finally {
      this.setState({ running: false })
    }
  }

  private async applyItem(item: OutboxItem, key: CryptoKey): Promise<void> {
    const db = getDB()
    const payload = await unseal<Record<string, unknown>>(key, item.payload)

    await db.outbox.update(item.id, { status: 'syncing', updatedAt: Date.now() })
    notifyOutboxChanged()

    let attempts = 0
    while (attempts < MAX_ATTEMPTS_PER_DRAIN) {
      attempts++
      try {
        const { data, error } = await supabase.rpc('sync_apply', {
          p_item_id: item.id,
          p_op: item.op,
          p_payload: payload,
        })
        if (error) throw new Error(error.message)

        const res = (data ?? {}) as SyncApplyResult
        if (res.status === 'synced' || res.status === 'duplicate') {
          await db.outbox.update(item.id, {
            status: 'synced',
            syncedAt: Date.now(),
            updatedAt: Date.now(),
            serverResult: await seal(key, res),
            lastError: undefined,
            conflictData: undefined,
          })
          notifyOutboxChanged()
          return
        }
        if (res.status === 'conflict') {
          await db.outbox.update(item.id, {
            status: 'conflict',
            updatedAt: Date.now(),
            conflictData: await seal(key, res),
          })
          notifyOutboxChanged()
          return
        }
        throw new Error(`Unexpected sync status: ${String(res.status)}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)

        if (isNetworkError(message)) {
          networkMonitor.markOffline()
          await db.outbox.update(item.id, { status: 'pending', updatedAt: Date.now() })
          notifyOutboxChanged()
          return // connection lost — stop the drain
        }

        const retries = item.retries + attempts
        if (retries >= MAX_TOTAL_RETRIES) {
          await db.outbox.update(item.id, {
            status: 'failed',
            retries,
            lastError: message,
            updatedAt: Date.now(),
          })
          notifyOutboxChanged()
          this.setState({ lastError: message })
          return
        }
        if (attempts < MAX_ATTEMPTS_PER_DRAIN) {
          await sleep(BACKOFF_BASE_MS * attempts)
        } else {
          // Still pending — the next drain window picks it up.
          await db.outbox.update(item.id, {
            status: 'pending',
            retries,
            lastError: message,
            updatedAt: Date.now(),
          })
          notifyOutboxChanged()
        }
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export const syncEngine = new SyncEngine()
