/**
 * Unit tests for the .sibak backup envelope and the outbox import policy —
 * the pure decision logic of lib/offline/backup.ts.
 *
 * The full export → wipe → restore browser flow was verified manually on
 * 2026-09-10 (replica wiped via deleteDatabase, restored 8,365 rows from the
 * passphrase file, POS then served the catalog offline). What that flow
 * cannot exercise deterministically is pinned here: wrong-passphrase
 * handling, format/version refusal, resolved-item skipping, id-merge and the
 * mid-flight status reset.
 */

import { seal, toB64, randomBytes } from '../crypto';
import type { PlainOutboxItem } from '../backup';

let BACKUP_FORMAT: string;
let BACKUP_VERSION: number;
let deriveBackupKey: (passphrase: string, salt: Uint8Array) => Promise<CryptoKey>;
let parseBackupEnvelope: (text: string, passphrase: string) => Promise<{ envelope: { format: string; version: number; userId: string }; bundle: unknown }>;
let selectOutboxImports: (items: PlainOutboxItem[], existingIds: Set<string>) => PlainOutboxItem[];

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://test.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key';
  // lib/supabase creates its client at import time; env must be set first
  // (jest hoists static imports, so a runtime require is required here).
  const backup = require('../backup');
  BACKUP_FORMAT = backup.BACKUP_FORMAT;
  BACKUP_VERSION = backup.BACKUP_VERSION;
  deriveBackupKey = backup.deriveBackupKey;
  parseBackupEnvelope = backup.parseBackupEnvelope;
  selectOutboxImports = backup.selectOutboxImports;
});

const PASSPHRASE = 'correct horse battery';

async function buildEnvelope(bundle: unknown, overrides: Record<string, unknown> = {}): Promise<string> {
  const salt = randomBytes(16);
  const cipher = await seal(await deriveBackupKey(PASSPHRASE, salt), bundle);
  return JSON.stringify({
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    userId: 'user-1',
    kdf: { algo: 'PBKDF2-SHA256', iterations: 600000, salt: toB64(salt) },
    cipher,
    ...overrides,
  });
}

describe('.sibak envelope (lib/offline/backup)', () => {
  test('round-trips a bundle through the passphrase envelope', async () => {
    const bundle = {
      schema: 2,
      replica: { replica_products: [{ id: 'p1', name: 'Cable 2.5mm' }] },
      cache: [{ key: 'user-1:products', data: [{ id: 'p1' }], updatedAt: 1 }],
      meta: [{ key: 'replica:count:Products', value: 1 }],
      outbox: [],
    };
    const text = await buildEnvelope(bundle);
    const opened = await parseBackupEnvelope(text, PASSPHRASE);
    expect(opened.envelope.format).toBe(BACKUP_FORMAT);
    expect(opened.envelope.userId).toBe('user-1');
    expect(opened.bundle).toEqual(bundle);
  });

  test('wrong passphrase → clean error, nothing opened', async () => {
    const text = await buildEnvelope({ schema: 2, replica: {}, cache: [], meta: [], outbox: [] });
    await expect(parseBackupEnvelope(text, 'a different passphrase')).rejects.toThrow('Wrong passphrase, or the backup file is corrupted');
  });

  test('tampered ciphertext → the same wrong-passphrase error (GCM auth)', async () => {
    const envelope = JSON.parse(await buildEnvelope({ schema: 2, replica: {}, cache: [], meta: [], outbox: [] }));
    const ct = Buffer.from(envelope.cipher.ct, 'base64');
    ct[0] ^= 0xff;
    envelope.cipher.ct = ct.toString('base64');
    await expect(parseBackupEnvelope(JSON.stringify(envelope), PASSPHRASE)).rejects.toThrow('Wrong passphrase, or the backup file is corrupted');
  });

  test('non-JSON and foreign JSON are rejected as not-a-backup', async () => {
    await expect(parseBackupEnvelope('not json at all', PASSPHRASE)).rejects.toThrow('Not a valid SI ERP backup file');
    await expect(parseBackupEnvelope(JSON.stringify({ hello: 'world' }), PASSPHRASE)).rejects.toThrow('Not a SI ERP backup file (unknown format)');
  });

  test('a newer backup format is refused, not mis-parsed', async () => {
    const text = await buildEnvelope({}, { version: BACKUP_VERSION + 1 });
    await expect(parseBackupEnvelope(text, PASSPHRASE)).rejects.toThrow('newer than this app supports');
  });
});

describe('outbox import policy (lib/offline/backup)', () => {
  const item = (id: string, status: PlainOutboxItem['status']): PlainOutboxItem => ({
    id,
    op: 'customer.create',
    label: `item ${id}`,
    payload: { name: `customer-${id}` },
    status,
    createdAt: 1,
    updatedAt: 1,
    retries: 0,
  });

  test('pending/conflict/failed carry over; synced/discarded are history', () => {
    const out = selectOutboxImports(
      [item('a', 'pending'), item('b', 'synced'), item('c', 'conflict'), item('d', 'discarded'), item('e', 'failed')],
      new Set(),
    );
    expect(out.map(i => i.id)).toEqual(['a', 'c', 'e']);
  });

  test('ids already on this device never overwrite local state (idempotent merge)', () => {
    const out = selectOutboxImports([item('a', 'pending'), item('z', 'pending')], new Set(['a']));
    expect(out.map(i => i.id)).toEqual(['z']);
  });

  test('items mid-flight in the backup return to pending', () => {
    const out = selectOutboxImports([item('s', 'syncing')], new Set());
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe('pending');
  });

  test('order is preserved (the drain applies items in creation order)', () => {
    const out = selectOutboxImports([item('late', 'pending'), item('early', 'pending')], new Set());
    expect(out.map(i => i.id)).toEqual(['late', 'early']);
  });
});
