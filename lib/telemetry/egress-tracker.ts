/**
 * Per-device API egress tracker.
 *
 * Observes the Supabase traffic the app already makes — it never issues a
 * request of its own. The wrapped fetch is handed to createClient; each
 * response's payload size is recorded against its endpoint (table or RPC)
 * and aggregated into one row per day × endpoint in a tiny standalone
 * IndexedDB database (raw API — no Dexie import, so nothing in the offline
 * layer or client-creation chain can loop back into this module).
 *
 * Measurement basis: Content-Length is not exposed on Supabase's CORS
 * allowlist, so bytes come from reading the (cloned) response body — the
 * DECOMPRESSED size, an upper bound on billed wire egress. Relative shares
 * between endpoints are what this tracker is for.
 *
 * Storage cost is O(days × endpoints): a 5,000-request day across 40
 * endpoints is ~40 small rows. Rows older than 30 days are pruned.
 *
 * Tracking can be disabled from Settings → API Usage; when disabled the
 * fetch is a pure pass-through and nothing is written.
 */

const LS_KEY = 'egress_tracking_enabled'
const DB_NAME = 'sisolution-egress'
const STORE = 'log'
const RETENTION_DAYS = 30
const FLUSH_MS = 3000
const MAX_MEASURE_BYTES = 32 * 1024 * 1024

export interface EgressEndpointRow {
  key: string // `${day}|${endpoint}`
  day: string // YYYY-MM-DD
  endpoint: string
  requests: number
  bytes: number
}

export interface EgressSummary {
  enabled: boolean
  days: Array<{ day: string; bytes: number; requests: number }>
  endpoints: Array<{ endpoint: string; bytes: number; requests: number }>
  todayBytes: number
  todayRequests: number
  trackedSince: string | null
}

export function isEgressTrackingEnabled(): boolean {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem(LS_KEY) !== '0'
}

export function setEgressTrackingEnabled(on: boolean): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(LS_KEY, on ? '1' : '0')
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function endpointKey(url: URL): string {
  const p = url.pathname
  // /rest/v1/<table>  |  /rest/v1/rpc/<fn>  |  /auth/v1/...  |  /realtime/...
  const rest = p.match(/^\/rest\/v1\/rpc\/([A-Za-z0-9_.]+)/)
  if (rest) return `rpc:${rest[1]}`
  const table = p.match(/^\/rest\/v1\/([A-Za-z0-9_.]+)/)
  if (table) return `table:${table[1]}`
  if (p.startsWith('/auth/v1/token')) return 'auth:token-refresh'
  if (p.startsWith('/auth/v1')) return 'auth'
  if (p.startsWith('/realtime')) return 'realtime'
  if (p.startsWith('/storage/v1')) return 'storage'
  return `other:${p.split('/').slice(0, 3).join('/')}`
}

// Resolved lazily on first tracked request (not at module load): the
// connection config can come from runtime injection (window.__SUPABASE_CONFIG__,
// set by lib/runtime-config.ts) which may not be present when this module is
// first imported. Read inline rather than importing runtime-config — nothing
// in the client-creation chain may import back into this module.
let supabaseHost: string | null = null
function resolveSupabaseHost(): string {
  if (supabaseHost === null) {
    const raw = (typeof window !== 'undefined' && window.__SUPABASE_CONFIG__?.url) || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
    try {
      supabaseHost = new URL(raw).host
    } catch {
      supabaseHost = ''
    }
  }
  return supabaseHost
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' })
        store.createIndex('day', 'day')
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

// Pending aggregate rows, merged into IndexedDB on flush.
const pending = new Map<string, EgressEndpointRow>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
let pruningDoneForDay = ''

function queueRecord(endpoint: string, bytes: number): void {
  const day = today()
  const key = `${day}|${endpoint}`
  const cur = pending.get(key) || { key, day, endpoint, requests: 0, bytes: 0 }
  cur.requests += 1
  cur.bytes += bytes
  pending.set(key, cur)
  if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS)
  if (pruningDoneForDay !== day) {
    pruningDoneForDay = day
    void pruneOldRows()
  }
}

async function flush(): Promise<void> {
  flushTimer = null
  if (pending.size === 0) return
  const rows = Array.from(pending.values())
  pending.clear()
  try {
    const db = await openDB()
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    for (const row of rows) {
      const req = store.get(row.key)
      req.onsuccess = () => {
        const prev = (req.result as EgressEndpointRow | undefined) || { requests: 0, bytes: 0 }
        store.put({
          ...row,
          requests: prev.requests + row.requests,
          bytes: prev.bytes + row.bytes,
        })
      }
    }
    await new Promise<void>((resolve) => { tx.oncomplete = () => resolve(); tx.onerror = () => resolve() })
    db.close()
  } catch {
    // Tracking must never break the request it observed.
  }
}

async function pruneOldRows(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000).toISOString().slice(0, 10)
    const db = await openDB()
    const tx = db.transaction(STORE, 'readwrite')
    const idx = tx.objectStore(STORE).index('day')
    const req = idx.openCursor(IDBKeyRange.upperBound(cutoff, true))
    req.onsuccess = () => {
      const cur = req.result
      if (cur) { cur.delete(); cur.continue() }
    }
    await new Promise<void>((resolve) => { tx.oncomplete = () => resolve(); tx.onerror = () => resolve() })
    db.close()
  } catch {
    // best-effort
  }
}

async function measureAndRecord(res: Response, endpoint: string): Promise<void> {
  let bytes = 0
  const cl = res.headers.get('content-length')
  if (cl != null) {
    bytes = Number(cl) || 0
  } else if (res.body && res.status !== 204) {
    try {
      const buf = await res.clone().arrayBuffer()
      bytes = buf.byteLength
    } catch {
      bytes = 0 // body already consumed or streaming — count the request, not the bytes
    }
  }
  queueRecord(endpoint, bytes)
}

/**
 * Drop-in fetch for createClient's `global.fetch`. Passes everything through
 * untouched; when tracking is enabled, Supabase-host responses are measured
 * and aggregated locally.
 */
export function trackedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const promise = fetch(input as RequestInfo, init)
  const host = resolveSupabaseHost()
  if (typeof window === 'undefined' || !host || !isEgressTrackingEnabled()) return promise
  try {
    const url = new URL(typeof input === 'string' ? input : (input as Request).url)
    if (url.host !== host) return promise
    promise.then((res) => {
      try { void measureAndRecord(res, endpointKey(url)) } catch { /* never break the caller */ }
      return res
    }).catch(() => {})
  } catch {
    // not a parseable URL — pass through
  }
  return promise
}

export async function getEgressSummary(): Promise<EgressSummary> {
  const days = new Map<string, { bytes: number; requests: number }>()
  const endpoints = new Map<string, { bytes: number; requests: number }>()
  let trackedSince: string | null = null
  try {
    const db = await openDB()
    const rows = await new Promise<EgressEndpointRow[]>((resolve) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).getAll()
      req.onsuccess = () => resolve((req.result || []) as EgressEndpointRow[])
      req.onerror = () => resolve([])
    })
    db.close()
    const t = today()
    for (const row of rows) {
      const d = days.get(row.day) || { bytes: 0, requests: 0 }
      d.bytes += row.bytes; d.requests += row.requests
      days.set(row.day, d)
      const e = endpoints.get(row.endpoint) || { bytes: 0, requests: 0 }
      e.bytes += row.bytes; e.requests += row.requests
      endpoints.set(row.endpoint, e)
      if (!trackedSince || row.day < trackedSince) trackedSince = row.day
    }
    const dayList = Array.from(days.entries())
      .map(([day, v]) => ({ day, ...v }))
      .sort((a, b) => a.day.localeCompare(b.day))
      .slice(-14)
    const endpointList = Array.from(endpoints.entries())
      .map(([endpoint, v]) => ({ endpoint, ...v }))
      .sort((a, b) => b.bytes - a.bytes)
    const todayRow = days.get(t)
    return {
      enabled: isEgressTrackingEnabled(),
      days: dayList,
      endpoints: endpointList,
      todayBytes: todayRow?.bytes ?? 0,
      todayRequests: todayRow?.requests ?? 0,
      trackedSince,
    }
  } catch {
    return { enabled: isEgressTrackingEnabled(), days: [], endpoints: [], todayBytes: 0, todayRequests: 0, trackedSince: null }
  }
}

export async function clearEgressData(): Promise<void> {
  pending.clear()
  try {
    const db = await openDB()
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).clear()
    await new Promise<void>((resolve) => { tx.oncomplete = () => resolve(); tx.onerror = () => resolve() })
    db.close()
  } catch {
    // best-effort
  }
}
