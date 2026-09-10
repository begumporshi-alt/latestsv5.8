/**
 * Unit tests for the app-wide offline read fallback (lib/offline/read-fallback).
 *
 * The real cache module is replaced with an in-memory map: IndexedDB does not
 * exist under jest, and these tests are about the *decision* logic — when a
 * read is cached, when it is served offline, and when it must never fall back
 * (writes). The network monitor is spied on so both connectivity states can be
 * exercised deterministically.
 *
 * The fake builder mirrors postgrest-js v2's shape deliberately: `.select()`
 * returns a NEW builder object (a PostgrestFilterBuilder), not `this`. An
 * earlier version of the fallback only kept chains wrapped when a method
 * returned `this`, which silently disabled caching for every `.from().select()`
 * read — that regression is covered by the first test below.
 */

jest.mock('../cache', () => {
  const store = new Map<string, unknown>();
  return {
    __store: store,
    cacheGet: jest.fn(async (key: string) => (store.has(key) ? store.get(key) : null)),
    cachePut: jest.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    // Same classification as the real module (its own tests live in
    // offline-lib.test.ts) — duplicated here so the mock has no imports.
    isNetworkError: (err: unknown) => {
      if (!err) return false;
      let msg: string;
      if (err instanceof Error) msg = `${err.name}: ${err.message}`;
      else if (typeof err === 'object' && err !== null && 'message' in err) msg = String((err as { message: unknown }).message);
      else msg = String(err);
      return /failed to fetch|networkerror|network error|fetch failed|load failed|timeout|aborted|err_internet|connection refused/i.test(msg);
    },
  };
});

jest.mock('../replica-query', () => ({
  runReplicaQuery: jest.fn(),
}));

import { withOfflineReads, subscribeOfflineMiss } from '../read-fallback';
import { runReplicaQuery } from '../replica-query';
import { networkMonitor } from '../network';

interface FakeResult {
  data: unknown;
  error: unknown;
  count?: number | null;
  status?: number | null;
  statusText?: string | null;
}

interface FakeStats {
  executed: number;
  calls: string[];
  rpcCalls: string[];
  next: FakeResult;
}

/** Minimal PostgREST-like thenable builder sharing one stats object. */
class FakeBuilder {
  constructor(private stats: FakeStats) {}

  /** postgrest-js v2 returns a NEW builder here — not `this`. */
  select(..._args: unknown[]): FakeBuilder {
    this.stats.calls.push('select');
    return new FakeBuilder(this.stats);
  }
  not(..._args: unknown[]) {
    this.stats.calls.push('not');
    return this;
  }
  eq(..._args: unknown[]) {
    this.stats.calls.push('eq');
    return this;
  }
  in(..._args: unknown[]) {
    this.stats.calls.push('in');
    return this;
  }
  order(..._args: unknown[]) {
    this.stats.calls.push('order');
    return this;
  }
  limit(..._args: unknown[]) {
    this.stats.calls.push('limit');
    return this;
  }
  range(..._args: unknown[]) {
    this.stats.calls.push('range');
    return this;
  }
  single() {
    this.stats.calls.push('single');
    return this;
  }
  insert(..._args: unknown[]) {
    this.stats.calls.push('insert');
    return this;
  }
  update(..._args: unknown[]) {
    this.stats.calls.push('update');
    return this;
  }
  upsert(..._args: unknown[]) {
    this.stats.calls.push('upsert');
    return this;
  }

  then(onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown): Promise<unknown> {
    this.stats.executed += 1;
    return Promise.resolve(this.stats.next).then(onFulfilled, onRejected);
  }
  catch(onRejected?: (e: unknown) => unknown): Promise<unknown> {
    return this.then(undefined, onRejected);
  }
  finally(onFinally?: () => void): Promise<unknown> {
    return this.then(undefined, undefined).finally(onFinally);
  }
}

function makeFakeClient() {
  const stats: FakeStats = {
    executed: 0,
    calls: [],
    rpcCalls: [],
    next: { data: [], error: null, count: null, status: 200, statusText: 'OK' },
  };
  const client = {
    stats,
    from(_table: string) {
      return new FakeBuilder(stats);
    },
    rpc(fn: string, _args?: unknown) {
      stats.rpcCalls.push(fn);
      return new FakeBuilder(stats);
    },
    auth: { getSession: async () => ({ data: { session: null }, error: null }) },
  };
  return client;
}

const mockedCache = jest.requireMock('../cache') as {
  __store: Map<string, unknown>;
  cacheGet: jest.Mock;
  cachePut: jest.Mock;
};

const ONLINE = { online: true, lastChangeAt: 0, lastProbeAt: null };
const OFFLINE = { online: false, lastChangeAt: 0, lastProbeAt: null };

let getStateSpy: jest.SpyInstance;
let markOfflineSpy: jest.SpyInstance;
const mockedReplica = runReplicaQuery as jest.Mock;

beforeEach(() => {
  mockedCache.__store.clear();
  mockedCache.cacheGet.mockClear();
  mockedCache.cachePut.mockClear();
  mockedReplica.mockReset(); // default: engine declines → offline notice
  getStateSpy = jest.spyOn(networkMonitor, 'getState');
  markOfflineSpy = jest.spyOn(networkMonitor, 'markOffline').mockImplementation(() => {});
  getStateSpy.mockReturnValue(ONLINE);
});

afterEach(() => {
  getStateSpy.mockRestore();
  markOfflineSpy.mockRestore();
});

describe('read fallback — online behavior', () => {
  test('a select chain is cached under a query-specific key', async () => {
    const client = makeFakeClient();
    const wrapped = withOfflineReads(client as never) as unknown as typeof client;
    client.stats.next = { data: [{ id: 1 }], error: null, count: null, status: 200, statusText: 'OK' };

    const res: any = await (wrapped as any).from('invoices').select('*').eq('status', 'paid');
    expect(res.data).toEqual([{ id: 1 }]);
    expect(mockedCache.cachePut).toHaveBeenCalledTimes(1);
    const [key, value] = mockedCache.cachePut.mock.calls[0];
    expect(key).toContain('q:from:invoices:');
    expect(key).toContain('eq(["status","paid"])');
    expect((value as any).data).toEqual([{ id: 1 }]);
  });

  test('the same query maps to the same cache key; a different filter does not', async () => {
    const client = makeFakeClient();
    const wrapped = withOfflineReads(client as never) as unknown as typeof client;

    await (wrapped as any).from('customers').select('*').eq('id', 'a');
    await (wrapped as any).from('customers').select('*').eq('id', 'a');
    await (wrapped as any).from('customers').select('*').eq('id', 'b');

    const keys = mockedCache.cachePut.mock.calls.map((c) => c[0]);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).not.toBe(keys[2]);
  });

  test('business errors are returned unchanged and never cached', async () => {
    const client = makeFakeClient();
    const wrapped = withOfflineReads(client as never) as unknown as typeof client;
    const error = { message: 'duplicate key value violates unique constraint "x"', code: '23505' };
    client.stats.next = { data: null, error, count: null, status: 409, statusText: 'Conflict' };

    const res: any = await (wrapped as any).from('invoices').select('*');
    expect(res.error).toBe(error);
    expect(mockedCache.cachePut).not.toHaveBeenCalled();

    // Still hits the network on the next attempt (not served from a cache).
    await (wrapped as any).from('invoices').select('*');
    expect(client.stats.executed).toBe(2);
  });
});

describe('read fallback — offline', () => {
  test('serves the cached copy for the exact query without touching the network', async () => {
    const client = makeFakeClient();
    const wrapped = withOfflineReads(client as never) as unknown as typeof client;

    // 1) online read caches the result
    client.stats.next = { data: [{ id: 'p1', name: 'Pipe' }], error: null, count: null, status: 200, statusText: 'OK' };
    await (wrapped as any).from('products').select('*').order('name');
    const afterOnline = client.stats.executed;

    // 2) offline, same query
    getStateSpy.mockReturnValue(OFFLINE);
    const res: any = await (wrapped as any).from('products').select('*').order('name');

    expect(res.data).toEqual([{ id: 'p1', name: 'Pipe' }]);
    expect(res.offline).toBe(true);
    expect(client.stats.executed).toBe(afterOnline); // never hit the network
  });

  test('a network error resolved by postgrest falls back to the cached copy', async () => {
    const client = makeFakeClient();
    const wrapped = withOfflineReads(client as never) as unknown as typeof client;

    client.stats.next = { data: [{ id: 's1' }], error: null, count: null, status: 200, statusText: 'OK' };
    await (wrapped as any).from('suppliers').select('*');

    client.stats.next = {
      data: null,
      error: { message: 'TypeError: Failed to fetch', code: '' },
      count: null,
      status: 0,
      statusText: '',
    };
    const res: any = await (wrapped as any).from('suppliers').select('*');

    expect(res.data).toEqual([{ id: 's1' }]);
    expect(res.offline).toBe(true);
    expect(markOfflineSpy).toHaveBeenCalled();
  });

  test('no cached copy → postgrest-shaped offline error plus a UI miss event', async () => {
    const client = makeFakeClient();
    const wrapped = withOfflineReads(client as never) as unknown as typeof client;
    getStateSpy.mockReturnValue(OFFLINE);

    const misses: string[] = [];
    const unsubscribe = subscribeOfflineMiss((info) => misses.push(info.target));

    const res: any = await (wrapped as any).from('journal_lines').select('*');
    unsubscribe();

    expect(res.data).toBeNull();
    expect(res.error.code).toBe('OFFLINE_NO_CACHE');
    expect(res.status).toBe(0);
    expect(misses).toEqual(['journal_lines']);
    expect(client.stats.executed).toBe(0);
  });

  test('no cached copy, but the replica engine can answer → served from the local database', async () => {
    const client = makeFakeClient();
    const wrapped = withOfflineReads(client as never) as unknown as typeof client;
    getStateSpy.mockReturnValue(OFFLINE);

    const mockedReplica = runReplicaQuery as jest.Mock;
    mockedReplica.mockResolvedValueOnce({ data: [{ id: 'i1', total: 5 }], count: 1 });

    const misses: string[] = [];
    const unsubscribe = subscribeOfflineMiss((info) => misses.push(info.target));

    const res: any = await (wrapped as any).from('invoices').select('*').eq('status', 'paid');
    unsubscribe();

    expect(res.data).toEqual([{ id: 'i1', total: 5 }]);
    expect(res.count).toBe(1);
    expect(res.error).toBeNull();
    expect(res.offline).toBe(true);
    expect(misses).toEqual([]); // no notice — the replica answered
    expect(client.stats.executed).toBe(0); // never touched the network
    // The engine got the table name and the full recorded chain
    expect(mockedReplica).toHaveBeenCalledWith('invoices', [
      ['select', ['*']],
      ['eq', ['status', 'paid']],
    ]);
  });

  test('the replica engine declining (null) still surfaces the offline notice', async () => {
    const client = makeFakeClient();
    const wrapped = withOfflineReads(client as never) as unknown as typeof client;
    getStateSpy.mockReturnValue(OFFLINE);

    const mockedReplica = runReplicaQuery as jest.Mock;
    mockedReplica.mockResolvedValueOnce(null);

    const misses: string[] = [];
    const unsubscribe = subscribeOfflineMiss((info) => misses.push(info.target));
    const res: any = await (wrapped as any).from('quotations').select('*');
    unsubscribe();

    expect(res.error.code).toBe('OFFLINE_NO_CACHE');
    expect(misses).toEqual(['quotations']);
  });

  test('a write never consults the replica engine', async () => {
    const client = makeFakeClient();
    const wrapped = withOfflineReads(client as never) as unknown as typeof client;
    getStateSpy.mockReturnValue(OFFLINE);
    const mockedReplica = runReplicaQuery as jest.Mock;

    client.stats.next = { data: [{ id: 'p9' }], error: null, count: null, status: 201, statusText: 'Created' };
    await (wrapped as any).from('products').insert({ id: 'p9', name: 'New' });

    expect(mockedReplica).not.toHaveBeenCalled();
  });
});

describe('write protection', () => {
  test('mutations pass through even offline and are never cached or faked', async () => {
    const client = makeFakeClient();
    const wrapped = withOfflineReads(client as never) as unknown as typeof client;
    getStateSpy.mockReturnValue(OFFLINE);

    client.stats.next = { data: [{ id: 'p9' }], error: null, count: null, status: 201, statusText: 'Created' };
    const res: any = await (wrapped as any).from('products').insert({ id: 'p9', name: 'New' });

    expect(client.stats.executed).toBe(1); // went to the network
    expect(res.data).toEqual([{ id: 'p9' }]);
    expect(mockedCache.cachePut).not.toHaveBeenCalled();
  });

  test('an insert chain that selects is still a write', async () => {
    const client = makeFakeClient();
    const wrapped = withOfflineReads(client as never) as unknown as typeof client;
    getStateSpy.mockReturnValue(OFFLINE);

    client.stats.next = { data: [{ id: 'inv1' }], error: null, count: null, status: 201, statusText: 'Created' };
    await (wrapped as any).from('invoices').insert({ id: 'inv1' }).select();

    expect(client.stats.executed).toBe(1);
    expect(mockedCache.cachePut).not.toHaveBeenCalled();
  });

  test('write RPCs pass through; read RPCs are cached and can fall back', async () => {
    const client = makeFakeClient();
    const wrapped = withOfflineReads(client as never) as unknown as typeof client;

    // Read RPC → cached
    client.stats.next = { data: [{ account: 'a', balance: 1 }], error: null, count: null, status: 200, statusText: 'OK' };
    await (wrapped as any).rpc('get_trial_balance');
    expect(mockedCache.cachePut).toHaveBeenCalledTimes(1);
    expect(mockedCache.cachePut.mock.calls[0][0]).toContain('q:rpc:get_trial_balance');

    // Write RPC → untouched, not cached
    client.stats.next = { data: { id: 'je1' }, error: null, count: null, status: 200, statusText: 'OK' };
    await (wrapped as any).rpc('post_journal_entry', { p_entries: [] });
    expect(client.stats.rpcCalls).toEqual(['get_trial_balance', 'post_journal_entry']);
    expect(mockedCache.cachePut).toHaveBeenCalledTimes(1);

    // Offline read RPC → served from cache
    getStateSpy.mockReturnValue(OFFLINE);
    const offlineRead: any = await (wrapped as any).rpc('get_trial_balance');
    expect(offlineRead.data).toEqual([{ account: 'a', balance: 1 }]);
    expect(offlineRead.offline).toBe(true);
    expect(client.stats.executed).toBe(2); // only the two online calls
  });
});
