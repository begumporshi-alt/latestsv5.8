/**
 * Persistent-storage requests and storage health for the offline layer.
 *
 * IndexedDB is evictable by default: under disk pressure a browser may
 * delete the origin's storage (local database AND the per-user key) without
 * asking. navigator.storage.persist() marks the storage persistent —
 * installed PWAs and regularly-used sites are typically granted it, and the
 * grant is remembered, so requesting on every mount is cheap. It never
 * shows a permission prompt.
 *
 * Safari does not honor persist() (storage there is best-effort) — the Sync
 * Center shows the honest state rather than pretending.
 */

export interface StorageStatus {
  /** navigator.storage.persist()/persisted() exist in this browser */
  supported: boolean
  /** the browser has granted persistence for this origin */
  persisted: boolean
  /** bytes used by this origin (IndexedDB + service-worker caches) */
  usage: number | null
  /** bytes the browser is willing to give this origin */
  quota: number | null
}

function manager(): StorageManager | null {
  const s = typeof navigator !== 'undefined' ? navigator.storage : undefined
  if (!s || typeof s.persist !== 'function' || typeof s.persisted !== 'function') return null
  return s
}

/** Ask the browser to mark this origin's storage persistent. No prompt is shown. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    return (await manager()?.persist()) ?? false
  } catch {
    return false
  }
}

export async function getStorageStatus(): Promise<StorageStatus> {
  const m = manager()
  if (!m) return { supported: false, persisted: false, usage: null, quota: null }
  try {
    const [persisted, estimate] = await Promise.all([
      m.persisted(),
      typeof m.estimate === 'function' ? m.estimate() : Promise.resolve(null),
    ])
    return {
      supported: true,
      persisted,
      usage: estimate?.usage ?? null,
      quota: estimate?.quota ?? null,
    }
  } catch {
    return { supported: true, persisted: false, usage: null, quota: null }
  }
}
