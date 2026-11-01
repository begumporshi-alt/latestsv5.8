/**
 * Guard for the base64 encoder used to seal every cached snapshot.
 *
 * `toB64` was the single largest cost of the POS cold-start rebuild: 199 ms of
 * a 220 ms seal at the live catalogue size (3.65 MB, ~2,960 products), because
 * it built the intermediate string one byte at a time. It is now chunked and
 * takes ~16 ms. This file exists so that regression cannot come back quietly —
 * it is invisible in review, it only shows up as "the POS feels slow again".
 *
 * Two kinds of assertion, deliberately:
 *
 *  - Correctness is exact and deterministic: the chunked encoder must produce
 *    byte-identical output to the naive per-byte form, including at the 32 KB
 *    window boundaries where an off-by-one would silently corrupt a snapshot.
 *  - The timing assertion is a gross-regression tripwire, not a benchmark. The
 *    budget is ~7x the measured cost so a slow CI machine does not fail it,
 *    while a return to per-byte encoding (~200 ms) fails loudly.
 */

import { toB64, fromB64 } from '../crypto';

/** The naive implementation, kept as the correctness oracle. */
function referenceToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function pattern(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31) & 0xff;
  return out;
}

describe('toB64', () => {
  // 32768 is the chunk window; the neighbours are where an off-by-one lives.
  it.each([0, 1, 2, 3, 32_767, 32_768, 32_769, 65_536, 100_003])(
    'matches the per-byte reference at %i bytes',
    (n) => {
      const bytes = pattern(n);
      expect(toB64(bytes)).toBe(referenceToB64(bytes));
    },
  );

  it('round-trips through fromB64', () => {
    const bytes = pattern(70_000);
    const back = fromB64(toB64(bytes));
    expect(back.length).toBe(bytes.length);
    expect(Array.from(back)).toEqual(Array.from(bytes));
  });

  it('encodes the catalogue snapshot well inside the regression budget', () => {
    // 3.65 MB is the measured JSON size of the live product snapshot.
    const bytes = pattern(3_650_000);
    toB64(pattern(1024)); // warm-up, so the first call is not the measurement

    const started = process.hrtime.bigint();
    const encoded = toB64(bytes);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(encoded.length).toBe(Math.ceil(bytes.length / 3) * 4);
    // Chunked: ~16 ms measured. Per-byte: ~200 ms. Anything near the budget
    // means the encoder regressed.
    expect(elapsedMs).toBeLessThan(120);
  });
});
