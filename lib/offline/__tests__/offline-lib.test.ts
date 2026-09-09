/**
 * Unit tests for the offline layer's pure logic:
 *  - AES-GCM seal/unseal round-trips and tamper detection (WebCrypto)
 *  - network-error classification (drives offline fallback + retry policy)
 *
 * The full outbox→sync_apply round-trip is covered by the browser test matrix
 * in docs/offline-test-report.md (it needs real IndexedDB + a live session).
 */

import { seal, unseal, toB64, fromB64, type SealedBlob } from '../crypto';

async function makeKey(): Promise<CryptoKey> {
  return globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

describe('offline at-rest encryption (lib/offline/crypto)', () => {
  test('seal → unseal round-trips structured data', async () => {
    const key = await makeKey();
    const invoice = {
      invoice_number: 'OFF-12345678',
      customer_id: '35fd8c79-d348-4fc5-a192-50b13fdae37b',
      items: [{ product_id: 'abc', quantity: 12.5, unit_price: 149.99 }],
      nested: { deep: [1, 2, { x: null }] },
    };
    const blob = await seal(key, invoice);
    expect(blob.algo).toBe('AES-GCM-256');
    expect(blob.ct).not.toContain('OFF-12345678'); // ciphertext must not leak plaintext
    const back = await unseal<typeof invoice>(key, blob);
    expect(back).toEqual(invoice);
  });

  test('every seal uses a fresh IV — identical input seals differently', async () => {
    const key = await makeKey();
    const a = await seal(key, { same: 'input' });
    const b = await seal(key, { same: 'input' });
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  test('tampered ciphertext fails authentication (GCM tag)', async () => {
    const key = await makeKey();
    const blob = await seal(key, { amount: 1000 });
    const bytes = fromB64(blob.ct);
    bytes[0] = bytes[0] ^ 0xff; // flip a bit
    const tampered: SealedBlob = { ...blob, ct: toB64(bytes) };
    await expect(unseal(key, tampered)).rejects.toThrow();
  });

  test('a different key cannot decrypt the blob', async () => {
    const keyA = await makeKey();
    const keyB = await makeKey();
    const blob = await seal(keyA, { secret: 'customer data' });
    await expect(unseal(keyB, blob)).rejects.toThrow();
  });
});

describe('network-error classification (lib/offline/cache)', () => {
  let isNetworkError: (err: unknown) => boolean;

  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://test.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key';
    // Dynamic require: lib/supabase creates its client at import time and
    // needs the env vars set first (jest hoists static imports).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    isNetworkError = require('../cache').isNetworkError;
  });

  test('browser fetch failures are classified as network errors', () => {
    expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isNetworkError(new Error('NetworkError when attempting to fetch resource'))).toBe(true);
    expect(isNetworkError(new Error('Load failed'))).toBe(true);
    expect(isNetworkError(new DOMException('The operation was aborted', 'AbortError'))).toBe(true);
  });

  test('supabase PostgrestError-style objects are inspected via .message', () => {
    expect(isNetworkError({ message: 'TypeError: Failed to fetch', code: 'HY000' })).toBe(true);
    expect(isNetworkError({ message: 'fetch failed' })).toBe(true);
  });

  test('business/RPC errors are NOT network errors (they must park, not retry)', () => {
    expect(isNetworkError({ message: 'invoice.create: items array is required' })).toBe(false);
    expect(isNetworkError(new Error('duplicate key value violates unique constraint'))).toBe(false);
    expect(isNetworkError({ message: 'Unknown sync op: nonsense.op' })).toBe(false);
    expect(isNetworkError(null)).toBe(false);
    expect(isNetworkError(undefined)).toBe(false);
  });
});
