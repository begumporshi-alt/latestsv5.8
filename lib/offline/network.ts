/**
 * Network connectivity detection.
 *
 * navigator.onLine lies in both directions (it only knows whether the OS has
 * an interface up — captive portals and dead routes read as "online"). So:
 *
 *  - window 'offline' event  → immediately treat as offline.
 *  - window 'online' event   → probe before believing it.
 *  - periodic probe (30s, page visible) → catch silent drops.
 *  - transport-level failures from the sync engine also mark offline.
 *
 * The probe is a same-origin no-store GET to /api/ping; any completed HTTP
 * response means our origin is reachable. Supabase reachability is confirmed
 * by the sync engine itself (a failed sync marks offline and re-arms probing).
 */

export interface NetworkState {
  online: boolean
  lastChangeAt: number
  lastProbeAt: number | null
}

type Listener = (state: NetworkState) => void

const PROBE_INTERVAL_MS = 30_000
const PROBE_TIMEOUT_MS = 6_000

class NetworkMonitor {
  private state: NetworkState = {
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    lastChangeAt: Date.now(),
    lastProbeAt: null,
  }
  private listeners = new Set<Listener>()
  private probeTimer: ReturnType<typeof setInterval> | null = null
  private probing = false
  private started = false

  getState(): NetworkState {
    return { ...this.state }
  }

  private setState(online: boolean) {
    if (this.state.online === online) return
    this.state = { ...this.state, online, lastChangeAt: Date.now() }
    this.listeners.forEach((l) => l(this.getState()))
  }

  start() {
    if (this.started || typeof window === 'undefined') return
    this.started = true
    window.addEventListener('online', () => {
      // Don't trust the event alone — captive portals fire it.
      void this.probe()
    })
    window.addEventListener('offline', () => this.setState(false))
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.probe()
    })
    this.probeTimer = setInterval(() => {
      if (document.visibilityState === 'visible') void this.probe()
    }, PROBE_INTERVAL_MS)
    void this.probe()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.getState())
    return () => this.listeners.delete(listener)
  }

  /** Explicitly mark offline (sync engine transport failure). */
  markOffline() {
    this.setState(false)
  }

  async probe(): Promise<boolean> {
    if (this.probing || typeof window === 'undefined') return this.state.online
    this.probing = true
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
      try {
        const res = await fetch('/api/ping', { cache: 'no-store', signal: controller.signal })
        // Any completed HTTP response (even a non-2xx) proves reachability.
        this.setState(res.status > 0)
      } finally {
        clearTimeout(timer)
      }
    } catch {
      this.setState(false)
    } finally {
      this.probing = false
      this.state = { ...this.state, lastProbeAt: Date.now() }
    }
    return this.state.online
  }
}

export const networkMonitor = new NetworkMonitor()
