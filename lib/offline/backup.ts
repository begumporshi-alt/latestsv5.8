/**
 * Encrypted export / import of the entire local offline database.
 *
 * Why a passphrase and not the device key: the per-user AES-GCM key is a
 * non-extractable CryptoKey that cannot leave IndexedDB, so a file sealed
 * with it could never be opened on another device (or on this one after a
 * browser-profile wipe). Instead, export UNSSEALS every row in memory and
 * seals the whole bundle with a key derived from a passphrase
 * (PBKDF2-SHA256, 600k iterations). Import re-seals everything with the
 * importing device's own key, so a backup works on any device.
 *
 * File format (.sibak — JSON):
 *   { format, version, createdAt, userId,
 *     kdf:    { algo: 'PBKDF2-SHA256', iterations, salt },
 *     cipher: { algo: 'AES-GCM-256', iv, ct } }
 * where the ciphertext is the bundle JSON:
 *   { schema, replica: {store: rows[]}, cache: [], meta: [], outbox: [] }
 * holding ALL business data in PLAINTEXT inside the cipher. Treat a .sibak
 * file like a pg_dump: it is only as safe as the passphrase and wherever
 * you keep it.
 *
 * Import semantics:
 *  - replica stores are replaced wholesale (re-sealed per row)
 *  - only the replica bookkeeping meta (counts/last-sync) is imported;
 *    other meta is device-local
 *  - outbox items are MERGED, never overwritten: ids already present are
 *    skipped, resolved items (synced/discarded) are not carried over, and
 *    items mid-flight in the backup return to 'pending'. Importing another
 *    device's pending items is safe — the server dedupes by (user, item id)
 *  - cache and outbox are only imported for the SAME user: cache is
 *    user-scoped, and a foreign outbox would apply under the wrong account
 *  - a fresh replication runs afterwards — the server stays the source of
 *    truth; the file restores offline-read coverage and unsynced writes
 */

import { supabase } from '../supabase'
import { getDB, setMeta, type OutboxItem } from './db'
import { getUserKey, seal, unseal, subtle, randomBytes, toB64, fromB64, type SealedBlob } from './crypto'
import { REPLICA_TABLES, replicateAll, replicaRows } from './replica'
import { notifyOutboxChanged } from './outbox'

export const BACKUP_FORMAT = 'sisolution-offline-backup'
export const BACKUP_VERSION = 1
const KDF_ITERATIONS = 600_000
const KDF_SALT_BYTES = 16

/** Thrown when the backup belongs to a different user than the signed-in one. */
export class BackupUserMismatchError extends Error {
  readonly backupUserId: string
  constructor(backupUserId: string) {
    super('This backup was exported by a different user account')
    this.name = 'BackupUserMismatchError'
    this.backupUserId = backupUserId
  }
}

interface BackupEnvelope {
  format: string
  version: number
  createdAt: string
  userId: string
  kdf: { algo: 'PBKDF2-SHA256'; iterations: number; salt: string }
  cipher: SealedBlob
}

/** An outbox item with its sealed fields carried as plaintext. */
export type PlainOutboxItem = Omit<OutboxItem, 'payload' | 'serverResult' | 'conflictData'> & {
  payload: unknown
  serverResult?: unknown
  conflictData?: unknown
}

interface BackupBundle {
  schema: 2
  /** store name -> decrypted rows (each row is the full server row incl. id) */
  replica: Record<string, Array<Record<string, any>>>
  /** cache entries with the full `${userId}:key` key, data decrypted */
  cache: Array<{ key: string; data: unknown; updatedAt: number }>
  meta: Array<{ key: string; value: unknown }>
  outbox: PlainOutboxItem[]
}

export interface BackupImportSummary {
  backupUserId: string
  sameUser: boolean
  rowsImported: number
  cacheImported: number
  outboxImported: number
}

async function requireUserId(): Promise<string> {
  const { data } = await supabase.auth.getSession()
  const userId = data.session?.user?.id
  if (!userId) {
    throw new Error('Exporting or restoring a backup requires a signed-in session')
  }
  return userId
}

export async function deriveBackupKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await subtle().importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return subtle().deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations: KDF_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * Pure: parse + validate a .sibak file's JSON envelope and open the cipher
 * with the passphrase. Throws the user-facing errors ("wrong passphrase",
 * "not a backup file", "newer format").
 */
export async function parseBackupEnvelope(
  text: string,
  passphrase: string,
): Promise<{ envelope: BackupEnvelope; bundle: BackupBundle }> {
  let envelope: BackupEnvelope
  try {
    envelope = JSON.parse(text)
  } catch {
    throw new Error('Not a valid SI ERP backup file')
  }
  if (envelope?.format !== BACKUP_FORMAT) {
    throw new Error('Not a SI ERP backup file (unknown format)')
  }
  if (envelope.version > BACKUP_VERSION) {
    throw new Error(`Backup format v${envelope.version} is newer than this app supports (v${BACKUP_VERSION})`)
  }
  if (envelope.kdf?.algo !== 'PBKDF2-SHA256') {
    throw new Error(`Unsupported key derivation ${envelope.kdf?.algo}`)
  }
  try {
    const bundle = await unseal<BackupBundle>(
      await deriveBackupKey(passphrase, fromB64(envelope.kdf.salt)),
      envelope.cipher,
    )
    return { envelope, bundle }
  } catch {
    throw new Error('Wrong passphrase, or the backup file is corrupted')
  }
}

/**
 * Pure: which backup outbox items are imported onto this device. Resolved
 * items (synced/discarded) are history — the server already has them or they
 * were deliberately dropped. Ids already present locally never overwrite.
 * Items mid-flight in the backup return to 'pending'.
 */
export function selectOutboxImports(
  items: PlainOutboxItem[],
  existingIds: Set<string>,
): PlainOutboxItem[] {
  return items
    .filter(item => item.status !== 'synced' && item.status !== 'discarded' && !existingIds.has(item.id))
    .map(item => (item.status === 'syncing' ? { ...item, status: 'pending' as const } : item))
}

function fileTimestamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

/** Build the passphrase-sealed bundle from everything in the local database. */
async function buildBackup(passphrase: string): Promise<{ blob: Blob; userId: string }> {
  const userId = await requireUserId()
  const key = await getUserKey(userId)
  const db = getDB()

  const replica: BackupBundle['replica'] = {}
  for (const spec of REPLICA_TABLES) {
    // replicaRows() decrypts per table and silently skips corrupt rows
    replica[spec.store] = await replicaRows<Record<string, any>>(spec)
  }

  const cache: BackupBundle['cache'] = []
  const prefix = `${userId}:`
  for (const row of await db.cache.toArray()) {
    if (!row.key.startsWith(prefix)) continue // another user's snapshot on a shared device
    try {
      cache.push({ key: row.key, data: await unseal(key, row.blob), updatedAt: row.updatedAt })
    } catch {
      // corrupt row — skip
    }
  }

  const meta = (await db.meta.toArray()).map(({ key: k, value }) => ({ key: k, value }))

  const outbox: PlainOutboxItem[] = []
  for (const item of await db.outbox.toArray()) {
    try {
      outbox.push({
        ...item,
        payload: await unseal(key, item.payload),
        serverResult: item.serverResult ? await unseal(key, item.serverResult) : undefined,
        conflictData: item.conflictData ? await unseal(key, item.conflictData) : undefined,
      })
    } catch {
      // corrupt item — skip; its server idempotency key stays known server-side
    }
  }

  const salt = randomBytes(KDF_SALT_BYTES)
  const cipher = await seal(await deriveBackupKey(passphrase, salt), {
    schema: 2,
    replica,
    cache,
    meta,
    outbox,
  } satisfies BackupBundle)

  const envelope: BackupEnvelope = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    userId,
    kdf: { algo: 'PBKDF2-SHA256', iterations: KDF_ITERATIONS, salt: toB64(salt) },
    cipher,
  }
  await setMeta('backup:last_export', Date.now())

  return { blob: new Blob([JSON.stringify(envelope)], { type: 'application/json' }), userId }
}

/**
 * Export the local database to a passphrase-encrypted .sibak file, saved as
 * a plain download (Downloads folder). Returns the saved filename.
 *
 * Deliberately no File System Access save picker: Chrome rejects it with
 * the same AbortError whether the user cancelled the dialog or the picker
 * is unavailable (headless/kiosk/webview), and the two are only
 * distinguishable by rejection timing — flaky. A plain download behaves
 * identically everywhere and the file can be moved anywhere afterwards.
 */
export async function exportBackupFile(passphrase: string): Promise<string> {
  const filename = `sisolution-backup-${fileTimestamp()}.sibak`
  const { blob } = await buildBackup(passphrase)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return filename
}

/**
 * Restore a .sibak file into this device's local database.
 * Throws BackupUserMismatchError when the file belongs to another user and
 * `allowDifferentUser` is false — the UI can then re-run with it true to
 * import the read-only replica only.
 */
export async function importBackup(
  file: File,
  passphrase: string,
  opts: { allowDifferentUser?: boolean } = {},
): Promise<BackupImportSummary> {
  const currentUserId = await requireUserId()
  const { envelope, bundle } = await parseBackupEnvelope(await file.text(), passphrase)

  const sameUser = envelope.userId === currentUserId
  if (!sameUser && !opts.allowDifferentUser) {
    throw new BackupUserMismatchError(envelope.userId)
  }

  const key = await getUserKey(currentUserId)
  const db = getDB()

  // Re-seal everything BEFORE opening the transaction — WebCrypto awaits
  // inside a Dexie transaction would break its async context tracking.
  const sealedReplica: Array<{ store: string; rows: Array<{ id: string; blob: SealedBlob }> }> = []
  for (const spec of REPLICA_TABLES) {
    const rows = bundle.replica[spec.store] ?? []
    sealedReplica.push({
      store: spec.store,
      rows: await Promise.all(rows.map(async r => ({ id: r.id, blob: await seal(key, r) }))),
    })
  }

  const metaImport = bundle.meta.filter(
    ({ key: k }) => k === 'replica:last_full_sync' || k.startsWith('replica:count:') || k.startsWith('replica:last_sync:'),
  )

  let sealedCache: Array<{ key: string; blob: SealedBlob; updatedAt: number }> = []
  let outboxToAdd: OutboxItem[] = []
  if (sameUser) {
    sealedCache = await Promise.all(
      bundle.cache.map(async c => ({ key: c.key, blob: await seal(key, c.data), updatedAt: c.updatedAt })),
    )

    const existingIds = new Set((await db.outbox.toArray()).map(i => i.id))
    for (const item of selectOutboxImports(bundle.outbox, existingIds)) {
      outboxToAdd.push({
        ...item,
        payload: await seal(key, item.payload),
        serverResult: item.serverResult !== undefined ? await seal(key, item.serverResult) : undefined,
        conflictData: item.conflictData !== undefined ? await seal(key, item.conflictData) : undefined,
        updatedAt: Date.now(),
      })
    }
  }

  await db.transaction('rw', db.tables, async () => {
    for (const { store, rows } of sealedReplica) {
      await db.table(store).clear()
      await db.table(store).bulkPut(rows)
    }
    for (const m of metaImport) {
      await db.meta.put(m)
    }
    for (const c of sealedCache) {
      await db.cache.put(c)
    }
    await db.outbox.bulkPut(outboxToAdd)
  })

  if (outboxToAdd.length > 0) notifyOutboxChanged()
  // The server remains the source of truth — refresh in the background.
  void replicateAll()

  return {
    backupUserId: envelope.userId,
    sameUser,
    rowsImported: sealedReplica.reduce((s, t) => s + t.rows.length, 0),
    cacheImported: sealedCache.length,
    outboxImported: outboxToAdd.length,
  }
}
