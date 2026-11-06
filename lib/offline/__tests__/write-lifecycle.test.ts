/**
 * Pins the two guarantees that keep a saved change visible immediately:
 *
 *  1. A page snapshot older than the last successful write is stale even if
 *     its TTL has not expired. This is the product-creation bug: the POS
 *     catalogue is cached for 10 minutes, so a snapshot taken before the save
 *     hid the new product until the TTL lapsed.
 *  2. The write lifecycle reports the server commit and the device copy as
 *     separate facts (saving → committed → synced), and a burst of writes from
 *     one save is reported as one activity.
 */

jest.mock('../db', () => {
  const rows = new Map<string, any>();
  const meta = new Map<string, any>();
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
    __meta: meta,
    getDB: () => ({ cache }),
    getMeta: async (key: string) => meta.get(key) ?? null,
    setMeta: async (key: string, value: unknown) => {
      meta.set(key, value);
    },
  };
});

jest.mock('../session', () => ({
  resolveUserId: jest.fn(async () => 'user-1'),
}));

jest.mock('../crypto', () => {
  const actual = jest.requireActual('../crypto');
  const key = globalThis.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return { ...actual, getUserKey: jest.fn(() => key) };
});

jest.mock('../network', () => {
  const state = { online: true };
  return {
    __state: state,
    networkMonitor: {
      getState: () => ({ ...state, lastChangeAt: 0, lastProbeAt: null }),
      markOffline: () => {
        state.online = false;
      },
      subscribe: () => () => {},
    },
  };
});

// The replica pass is a separate concern (write-refresh.test.ts). Here it only
// has to answer "did the device copy converge?".
const mockGetLastWriteAt = jest.fn(async () => 0);
const mockAwaitPendingWrites = jest.fn(async () => true);

jest.mock('../write-refresh', () => ({
  getLastWriteAt: () => mockGetLastWriteAt(),
  awaitPendingWrites: () => mockAwaitPendingWrites(),
  noteServerWrite: jest.fn(),
}));

jest.mock('../data-source', () => ({
  reportRead: jest.fn(),
}));

import { cachedQuery, cachePut } from '../cache';
import {
  beginWrite,
  commitWrite,
  dismissWrite,
  failWrite,
  getWriteActivity,
  getWriteState,
  queueWrite,
  __resetWriteActivityForTests,
} from '../write-status';

const TTL_10_MIN = 10 * 60_000;

beforeEach(() => {
  (globalThis as any).window = { location: { pathname: '/' } };
  mockGetLastWriteAt.mockReset();
  mockGetLastWriteAt.mockResolvedValue(0);
  mockAwaitPendingWrites.mockReset();
  mockAwaitPendingWrites.mockResolvedValue(true);
  __resetWriteActivityForTests();
});

afterEach(() => {
  delete (globalThis as any).window;
});

describe('cachedQuery write invalidation', () => {
  it('serves the cached snapshot while no write has happened', async () => {
    await cachePut('products:all', [{ id: 'p1' }], { asOf: Date.now() });
    const fetcher = jest.fn(async () => [{ id: 'p2' }]);

    const res = await cachedQuery('products:all', TTL_10_MIN, fetcher);

    expect(fetcher).not.toHaveBeenCalled();
    expect(res.data).toEqual([{ id: 'p1' }]);
    expect(res.fresh).toBe(true);
  });

  it('ignores a snapshot taken before the last write, even inside its TTL', async () => {
    const snapshotAt = Date.now() - 60_000;
    await cachePut('products:all', [{ id: 'p1' }], { asOf: snapshotAt });
    // The save happened after the snapshot was taken.
    mockGetLastWriteAt.mockResolvedValue(snapshotAt + 1_000);
    const fetcher = jest.fn(async () => [{ id: 'p1' }, { id: 'p2-new' }]);

    const res = await cachedQuery('products:all', TTL_10_MIN, fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(res.data).toEqual([{ id: 'p1' }, { id: 'p2-new' }]);
    expect(res.fresh).toBe(true);
  });

  it('does not serve a pre-write snapshot through the stale-while-revalidate path', async () => {
    const snapshotAt = Date.now() - 60_000;
    await cachePut('products:all', [{ id: 'p1' }], { asOf: snapshotAt });
    mockGetLastWriteAt.mockResolvedValue(snapshotAt + 1_000);
    const fetcher = jest.fn(async () => [{ id: 'p1' }, { id: 'p2-new' }]);

    const res = await cachedQuery('products:all', TTL_10_MIN, fetcher, {
      staleWhileRevalidate: true,
    });

    // Blocking refresh, not the stale copy behind the caller.
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(res.data).toEqual([{ id: 'p1' }, { id: 'p2-new' }]);
  });
});

describe('write activity lifecycle', () => {
  it('reports the server commit and the device copy separately', async () => {
    const id = beginWrite('products');
    expect(getWriteActivity()?.phase).toBe('saving');

    commitWrite(id);
    expect(getWriteActivity()?.phase).toBe('committed');

    // The settle pass is debounced, then awaits the replica refresh.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(mockAwaitPendingWrites).toHaveBeenCalled();
    expect(getWriteActivity()?.phase).toBe('synced');
  });

  it('says the device copy will catch up when convergence fails', async () => {
    mockAwaitPendingWrites.mockResolvedValue(false);
    const id = beginWrite('products');
    commitWrite(id);

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(getWriteActivity()?.phase).toBe('deferred');
  });

  it('collapses a burst of writes from one save into one activity', () => {
    const first = beginWrite('products');
    const second = beginWrite('product_units');
    const third = beginWrite('rpc create_opening_batch');

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(getWriteActivity()?.writes).toBe(3);
  });
});

/**
 * The pill shows a COUNT of unsettled writes, so "how many are still in
 * flight" has to be exact: too high and it never reaches zero, too low and a
 * save looks finished while the server has not answered.
 */
describe('write queue counts', () => {
  it('counts a write until the device copy converges', async () => {
    const id = beginWrite('products');
    expect(getWriteState().pending).toBe(1);

    commitWrite(id);
    // The server has it, but the device copy is still behind.
    expect(getWriteState().pending).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(getWriteState().pending).toBe(0);
    expect(getWriteState().items[0].phase).toBe('synced');
  });

  it('counts two separate saves separately', () => {
    const first = beginWrite('products');
    commitWrite(first);
    const second = beginWrite('customers');

    expect(second).not.toBe(first);
    expect(getWriteState().pending).toBe(2);
    expect(getWriteState().items).toHaveLength(2);
  });

  it('keeps a failure counted until it is dismissed', async () => {
    const id = beginWrite('products');
    failWrite(id, 'duplicate key value violates unique constraint');

    expect(getWriteState().failed).toBe(1);
    expect(getWriteState().pending).toBe(0);

    // The settle pass must not run for a rejected write and "heal" the row.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(mockAwaitPendingWrites).not.toHaveBeenCalled();
    expect(getWriteState().items[0].phase).toBe('failed');

    dismissWrite(id);
    expect(getWriteState().failed).toBe(0);
    expect(getWriteState().items).toHaveLength(0);
  });

  it('a later commit in the same burst cannot overwrite a failure', () => {
    const id = beginWrite('products');
    failWrite(id, 'permission denied');
    commitWrite(id);

    expect(getWriteState().items[0].phase).toBe('failed');
    expect(getWriteState().failed).toBe(1);
  });

  it('counts an offline queue entry as queued, not pending', () => {
    queueWrite('Invoice INV-0001');

    expect(getWriteState().queued).toBe(1);
    expect(getWriteState().pending).toBe(0);
    expect(getWriteState().items[0].target).toBe('outbox');
  });
});
