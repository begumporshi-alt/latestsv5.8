/**
 * At-rest encryption for locally stored offline data.
 *
 * Key model: one non-extractable AES-256-GCM CryptoKey per user, persisted as a
 * structured-cloneable CryptoKey object in IndexedDB. Non-extractable means the
 * raw key bytes can never be read out of the database through the WebCrypto
 * export APIs — an attacker who copies the IndexedDB files off disk gets
 * ciphertext without the key material.
 *
 * Every cached dataset and every queued outbox mutation is sealed with a fresh
 * random 96-bit IV before it touches IndexedDB.
 *
 * Honest scope: this protects data at rest (the leveldb files backing
 * IndexedDB). It cannot protect against an attacker running code in the same
 * browser profile with the key loaded — no browser-local scheme can. The key
 * and all sealed data are deleted on logout (see clearLocalData).
 */

export interface SealedBlob {
  algo: 'AES-GCM-256'
  iv: string // base64
  ct: string // base64 ciphertext
}

const subtle = () => {
  const c = typeof globalThis !== 'undefined' ? (globalThis as { crypto?: Crypto }).crypto : undefined
  if (!c?.subtle) {
    throw new Error('WebCrypto unavailable — offline storage requires a secure browser context')
  }
  return c.subtle
}

function randomBytes(n: number): Uint8Array {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (!c?.getRandomValues) {
    throw new Error('WebCrypto unavailable — offline storage requires a secure browser context')
  }
  return c.getRandomValues(new Uint8Array(n))
}

export function toB64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

export function fromB64(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

const keyCache = new Map<string, CryptoKey>()

/**
 * Get (or create) the per-user data encryption key. The key lives only in
 * IndexedDB as a non-extractable CryptoKey; there is no passphrase and no
 * recovery — clearing browser data destroys the key and the cached data with it.
 */
export async function getUserKey(userId: string): Promise<CryptoKey> {
  const cached = keyCache.get(userId)
  if (cached) return cached
  const { getDB } = await import('./db')
  const db = getDB()
  const existing = await db.keys.get(userId)
  if (existing) {
    keyCache.set(userId, existing.key)
    return existing.key
  }
  const key = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, false /* non-extractable */, [
    'encrypt',
    'decrypt',
  ])
  await db.keys.put({ userId, key })
  keyCache.set(userId, key)
  return key
}

export async function seal<T>(key: CryptoKey, data: T): Promise<SealedBlob> {
  const iv = randomBytes(12)
  const plaintext = new TextEncoder().encode(JSON.stringify(data))
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, key, plaintext)
  return { algo: 'AES-GCM-256', iv: toB64(iv), ct: toB64(new Uint8Array(ct)) }
}

export async function unseal<T>(key: CryptoKey, blob: SealedBlob): Promise<T> {
  if (blob.algo !== 'AES-GCM-256') throw new Error(`Unknown cipher ${blob.algo}`)
  const pt = await subtle().decrypt(
    { name: 'AES-GCM', iv: fromB64(blob.iv) },
    key,
    fromB64(blob.ct) as unknown as BufferSource,
  )
  return JSON.parse(new TextDecoder().decode(pt)) as T
}
