/**
 * Unit tests for the read-through cache (lib/offline/cache).
 *
 * There was no test for this module before, and the Phase 2 cold-start work
 * changes its most load-bearing decision: what a caller gets when the cached
 * copy is past its TTL. Three behaviours are pinned here.
 *
 *  1. Default = blocking refresh. A stale key waits for the fetcher. This is
 *     the egress contract for every page that does NOT opt in, and five pages
 *     additionally render a stale-data banner off `fresh`, so silently
 *     changing the default would make those banners lie.
 *  2. Opt-in stale-while-revalidate = serve the stale value now, rebuild
 *     behind the caller, and report the newer data through onRevalidated.
 *  3. One rebuild per key in flight. Two concurrent callers used to run the
 *     fetcher (and the ~300 ms seal + multi-MB write) twice and discard one
 *     result.
 *
 * IndexedDB, the session and the network monitor are stubbed: this suite is
 * about the decision logic, not storage. The real seal/unseal are used, so the
 * cached values round-trip through the same AES-GCM path production uses.
 */

jest.mock('../db', () => {
  const rows = new Map<string, any>();
  const cache = {
    get: async (key: string) => rows.get(key),
    put: async (row: any) => {
      rows.set(row.key, row);
    },
    delete: async (key: string) => {
      rows.delete(key);
    },
  };
  return {
    __rows: rows,
    getDB: () => ({ cache }),
  };
});

jest.mock('../session', () => ({
  resolveUserId: jest.fn(async () => 'user-1'),
}));

jest.mock('../crypto', () => {
  const actual = jest.requireActual('../crypto');
  // A real AES-GCM key, so seal/unseal behave exactly as in production.
  const key = globalThis.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return { ...actual, getUserKey: jest.fn(() => key) };
});

jest.mock('../network', () => {
  const state = { online: true, lastChangeAt: 0, lastProbeAt: null as number | null };
  return {
    __state: state,
    networkMonitor: {
      getState: () => ({ ...state }),
      markOffline: () => {
        state.online = false;
      },
      subscribe: () => () => {},
    },
  };
});

import { cachedQuery, cachePut, OfflineError } from '../cache';
import { networkMonitor } from '../network';

const db = jest.requireMock('../db') as { __rows: Map<string, any> };
const net = jest.requireMock('../network') as {
  __state: { online: boolean };
  networkMonitor: typeof networkMonitor;
};

/** Age a cache row so the next read sees it as past its TTL. */
function ageRow(key: string, ageMs: number): void {
  for (const [k, row] of db.__rows) {
    if (k.endsWith(`:${key}`)) row.updatedAt = Date.now() - ageMs;
  }
}

/**
 * Poll until `check` holds. Background revalidation is fire-and-forget and its
 * tail involves a real AES-GCM seal, so a fixed `setTimeout(0)` passes in
 * isolation and flakes when the rest of the suite competes for the CPU.
 */
async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(() => {
  db.__rows.clear();
  net.__state.online = true;
});

describe('cachedQuery', () => {
  it('serves a fresh entry without calling the fetcher', async () => {
    await cachePut('k1', [{ id: 1 }]);
    const fetcher = jest.fn(async () => [{ id: 2 }]);

    const res = await cachedQuery('k1', 60_000, fetcher);

    expect(res.fresh).toBe(true);
    expect(res.data).toEqual([{ id: 1 }]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('blocks on a stale entry by default', async () => {
    await cachePut('k1', [{ id: 1 }]);
    ageRow('k1', 10 * 60_000);
    const fetcher = jest.fn(async () => [{ id: 2 }]);

    const res = await cachedQuery('k1', 60_000, fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(res.fresh).toBe(true);
    expect(res.data).toEqual([{ id: 2 }]);
  });

  it('serves stale immediately and revalidates behind the caller when opted in', async () => {
    await cachePut('k1', [{ id: 1 }]);
    ageRow('k1', 10 * 60_000);

    let release!: (rows: Array<{ id: number }>) => void;
    const fetcher = jest.fn(
      () => new Promise<Array<{ id: number }>>((resolve) => { release = resolve; }),
    );
    const onRevalidated = jest.fn();

    const res = await cachedQuery('k1', 60_000, fetcher, {
      staleWhileRevalidate: true,
      onRevalidated,
    });

    // The caller is not waiting on the fetcher.
    expect(res.data).toEqual([{ id: 1 }]);
    expect(res.fresh).toBe(false);

    // The rebuild is fire-and-forget, so it has only been scheduled here.
    await waitFor(() => fetcher.mock.calls.length === 1);
    expect(onRevalidated).not.toHaveBeenCalled();

    release([{ id: 2 }]);
    await waitFor(() => onRevalidated.mock.calls.length === 1);

    expect(onRevalidated).toHaveBeenCalledWith([{ id: 2 }]);
    // The rebuilt value replaced the cache entry.
    const next = await cachedQuery('k1', 60_000, jest.fn());
    expect(next.data).toEqual([{ id: 2 }]);
    expect(next.fresh).toBe(true);
  });

  it('keeps serving the stale entry when the background rebuild fails', async () => {
    await cachePut('k1', [{ id: 1 }]);
    ageRow('k1', 10 * 60_000);
    const fetcher = jest.fn(async () => {
      throw new Error('failed to fetch');
    });
    const onRevalidated = jest.fn();

    const res = await cachedQuery('k1', 60_000, fetcher, {
      staleWhileRevalidate: true,
      onRevalidated,
    });
    await waitFor(() => fetcher.mock.calls.length === 1);
    await new Promise((r) => setTimeout(r, 20)); // let the rejection settle

    expect(res.data).toEqual([{ id: 1 }]);
    expect(onRevalidated).not.toHaveBeenCalled();
  });

  it('runs one rebuild for concurrent callers on the same key', async () => {
    let release!: (rows: Array<{ id: number }>) => void;
    const fetcher = jest.fn(
      () => new Promise<Array<{ id: number }>>((resolve) => { release = resolve; }),
    );

    const a = cachedQuery('k1', 60_000, fetcher);
    const b = cachedQuery('k1', 60_000, fetcher);
    // Both calls must reach the rebuild entry point before one is released,
    // otherwise the second simply starts its own rebuild and the test proves
    // nothing about sharing.
    await waitFor(() => typeof release === 'function');
    release([{ id: 7 }]);

    const [ra, rb] = await Promise.all([a, b]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(ra.data).toEqual([{ id: 7 }]);
    expect(rb.data).toEqual([{ id: 7 }]);
  });

  it('serves the cached copy when offline', async () => {
    await cachePut('k1', [{ id: 1 }]);
    net.__state.online = false;
    const fetcher = jest.fn(async () => [{ id: 2 }]);

    const res = await cachedQuery('k1', 60_000, fetcher);

    expect(res.offline).toBe(true);
    expect(res.data).toEqual([{ id: 1 }]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('throws OfflineError when offline with nothing cached', async () => {
    net.__state.online = false;
    const fetcher = jest.fn(async () => {
      throw new Error('failed to fetch');
    });

    await expect(cachedQuery('missing', 60_000, fetcher)).rejects.toBeInstanceOf(OfflineError);
  });
});
