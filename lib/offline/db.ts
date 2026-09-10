/**
 * Local persistent storage for offline mode (IndexedDB via Dexie).
 *
 * Tables:
 *  - outbox: queued mutations created while offline (encrypted payloads).
 *    Each item's `id` is a client-generated UUID that doubles as the
 *    server-side idempotency key, so a replayed sync can never double-apply.
 *  - cache:  encrypted snapshots of datasets fetched while online
 *            (products, customers, employees, recent invoices, stock levels).
 *  - meta:   small plaintext bookkeeping (last sync time, device id).
 *  - keys:   per-user non-extractable AES-GCM CryptoKey objects.
 *
 * Everything sensitive is sealed via lib/offline/crypto before it is written;
 * `meta` holds no business data.
 */
import Dexie, { type Table } from 'dexie'
import type { SealedBlob } from './crypto'

export type OutboxStatus = 'pending' | 'syncing' | 'synced' | 'conflict' | 'failed' | 'discarded'

export interface OutboxItem {
  id: string // uuid — server idempotency key
  op: string // e.g. 'invoice.create', 'product.update'
  label: string // human-readable, shown in the Sync Center
  payload: SealedBlob
  status: OutboxStatus
  createdAt: number
  updatedAt: number
  syncedAt?: number
  retries: number
  lastError?: string
  serverResult?: SealedBlob // e.g. { invoiceNumber: 'INV-...' } after sync
  conflictData?: SealedBlob // server-side row state when a conflict is detected
}

export interface CacheRow {
  key: string
  blob: SealedBlob
  updatedAt: number
}

export interface MetaRow {
  key: string
  value: unknown
}

export interface KeyRow {
  userId: string
  key: CryptoKey
}

class OfflineDB extends Dexie {
  outbox!: Table<OutboxItem, string>
  cache!: Table<CacheRow, string>
  meta!: Table<MetaRow, string>
  keys!: Table<KeyRow, string>

  constructor() {
    super('sisolution-offline')
    this.version(1).stores({
      outbox: 'id, status, createdAt, op',
      cache: 'key, updatedAt',
      meta: 'key',
      keys: 'userId',
    })
    // v2: the full local database — complete local copies of the core tables,
    // maintained by the background replicator (lib/offline/replica.ts). Rows
    // are sealed per-record with the user's AES-GCM key before storage.
    this.version(2).stores({
      replica_products: 'id, updated_at',
      replica_inventory_items: 'id, product_id',
      replica_product_units: 'id, product_id',
      replica_customers: 'id, updated_at',
      replica_invoices: 'id, invoice_date',
      replica_invoice_items: 'id, invoice_id',
      replica_payments: 'id, reference_id',
      replica_sales_returns: 'id, invoice_id',
      replica_employees: 'id, updated_at',
      replica_attendance: 'id, employee_id, date',
      replica_warehouses: 'id',
      replica_brands: 'id',
      replica_categories: 'id',
      replica_payment_methods: 'id',
      replica_suppliers: 'id',
    })
    // v3: operational tables the POS / gates need while offline — VAT & POS
    // defaults, store-credit balances, and the FIFO batch ledger.
    this.version(3).stores({
      replica_app_settings: 'id, setting_key',
      replica_customer_store_credits: 'id, customer_id',
      replica_inventory_batches: 'id, product_id, warehouse_id',
    })
  }
}

let _db: OfflineDB | null = null

export function getDB(): OfflineDB {
  if (typeof window === 'undefined' || typeof indexedDB === 'undefined') {
    throw new Error('Offline storage is only available in the browser')
  }
  if (!_db) _db = new OfflineDB()
  return _db
}

export async function isOfflineStorageAvailable(): Promise<boolean> {
  try {
    getDB()
    return true
  } catch {
    return false
  }
}

/** Wipe every local trace of a user's data: local database, cache, queued work, and key. */
export async function clearLocalData(): Promise<void> {
  try {
    const db = getDB()
    await Promise.all(db.tables.map(t => t.clear()))
  } catch {
    // storage unavailable (SSR / old browser) — nothing to clear
  }
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await getDB().meta.put({ key, value })
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const row = await getDB().meta.get(key)
  return row?.value as T | undefined
}
