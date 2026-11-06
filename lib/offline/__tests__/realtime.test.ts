/**
 * Unit tests for the Realtime → replica bridge (lib/offline/realtime).
 *
 * Two production failures motivate this suite:
 *
 *  1. The subscription existed but the tables were never added to the
 *     `supabase_realtime` publication, so no handler ever ran. That part is a
 *     migration, not code — what is testable here is that a handler, when it
 *     does run, does the right thing.
 *  2. `product_units` had no entry in TABLE_AGGREGATES. Even with Realtime
 *     working, a remote unit-price change converged the replica and left the
 *     POS catalogue snapshot in place, so the grid kept the old price for the
 *     snapshot's whole TTL. The regression test below pins that mapping.
 *
 * The refresh is also asserted to finish BEFORE the final invalidation: a
 * reader that rebuilds a snapshot mid-pull must not keep it, because the write
 * happened on another device and no local write timestamp can mark it stale.
 */

jest.mock('../../supabase-raw', () => {
  const handlers: Array<{ table: string; fire: () => void }> = []
  const channel = () => {
    const ch: Record<string, unknown> = {}
    ch.on = (_event: string, filter: { table: string }, cb: () => void) => {
      handlers.push({ table: filter.table, fire: cb })
      return ch
    }
    ch.subscribe = () => ch
    return ch
  }
  return {
    __handlers: handlers,
    supabaseRaw: { channel, removeChannel: async () => {} },
  }
})

jest.mock('../network', () => ({
  networkMonitor: {
    getState: () => ({ online: (globalThis as { __online?: boolean }).__online !== false }),
    markOffline: () => {},
  },
}))

jest.mock('../replica', () => ({
  REPLICA_BY_TABLE: {
    products: { name: 'Products' },
    product_units: { name: 'Product units' },
    inventory_items: { name: 'Stock counters' },
  },
  refreshReplicaTables: jest.fn(async () => {}),
}))

jest.mock('../pending', () => ({
  invalidateCachesForTables: jest.fn(async () => {}),
  invalidateCacheKeys: jest.fn(async () => {}),
}))

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { startRealtimeSync, stopRealtimeSync, WATCHED_TABLES } from '../realtime'

const raw = jest.requireMock('../../supabase-raw') as {
  __handlers: Array<{ table: string; fire: () => void }>
}
const replica = jest.requireMock('../replica') as { refreshReplicaTables: jest.Mock }
const pending = jest.requireMock('../pending') as {
  invalidateCachesForTables: jest.Mock
  invalidateCacheKeys: jest.Mock
}

const DEBOUNCE_MS = 1_200

/** Let the dynamic imports and the awaited flush settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await Promise.resolve()
}

function fire(table: string): void {
  const handler = raw.__handlers.find((h) => h.table === table)
  if (!handler) throw new Error(`no handler registered for ${table}`)
  handler.fire()
}

function invalidatedKeys(): string[] {
  return pending.invalidateCacheKeys.mock.calls.flatMap((c) => c[0] as string[])
}

describe('realtime replica sync', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    raw.__handlers.length = 0
    ;(globalThis as { window?: unknown }).window = {}
    ;(globalThis as { __online?: boolean }).__online = true
    startRealtimeSync()
  })

  afterEach(() => {
    stopRealtimeSync()
    jest.useRealTimers()
    delete (globalThis as { window?: unknown }).window
    delete (globalThis as { __online?: boolean }).__online
  })

  it('refreshes the changed table and drops the catalogue snapshot', async () => {
    fire('products')
    jest.advanceTimersByTime(DEBOUNCE_MS)
    await settle()

    expect(replica.refreshReplicaTables).toHaveBeenCalledWith(['Products'])
    expect(invalidatedKeys()).toEqual(expect.arrayContaining(['products:all']))
  })

  // The regression: a unit-price push-down converged `product_units` but the
  // POS grid renders its price from that table, so the snapshot had to go.
  it('drops the catalogue snapshot when only the unit prices changed', async () => {
    fire('product_units')
    jest.advanceTimersByTime(DEBOUNCE_MS)
    await settle()

    expect(replica.refreshReplicaTables).toHaveBeenCalledWith(['Product units'])
    expect(invalidatedKeys()).toEqual(expect.arrayContaining(['products:all']))
  })

  // Another terminal's sale changes the counters the grid reads for "on hand".
  it('drops the catalogue and the oversell snapshot when stock changes', async () => {
    fire('inventory_items')
    jest.advanceTimersByTime(DEBOUNCE_MS)
    await settle()

    expect(replica.refreshReplicaTables).toHaveBeenCalledWith(['Stock counters'])
    expect(invalidatedKeys()).toEqual(expect.arrayContaining(['products:all', 'gate:stock']))
  })

  it('coalesces a burst into one refresh', async () => {
    fire('products')
    fire('product_units')
    fire('inventory_items')
    jest.advanceTimersByTime(DEBOUNCE_MS)
    await settle()

    expect(replica.refreshReplicaTables).toHaveBeenCalledTimes(1)
    const specs = replica.refreshReplicaTables.mock.calls[0][0] as string[]
    expect(specs.sort()).toEqual(['Product units', 'Products', 'Stock counters'])
  })

  it('invalidates again after the replica has converged', async () => {
    let release: (() => void) | undefined
    replica.refreshReplicaTables.mockImplementationOnce(
      () => new Promise<void>((resolve) => { release = resolve }),
    )

    fire('product_units')
    jest.advanceTimersByTime(DEBOUNCE_MS)
    await settle()

    // The pre-pull invalidation has run; the post-pull one has not.
    expect(replica.refreshReplicaTables).toHaveBeenCalledTimes(1)
    expect(pending.invalidateCacheKeys).toHaveBeenCalledTimes(1)

    release?.()
    await settle()

    expect(pending.invalidateCacheKeys).toHaveBeenCalledTimes(2)
    expect(invalidatedKeys()).toEqual(expect.arrayContaining(['products:all']))
  })

  it('ignores events while the app believes it is offline', async () => {
    ;(globalThis as { __online?: boolean }).__online = false

    fire('products')
    jest.advanceTimersByTime(DEBOUNCE_MS)
    await settle()

    expect(replica.refreshReplicaTables).not.toHaveBeenCalled()
    expect(pending.invalidateCacheKeys).not.toHaveBeenCalled()
  })

  // The failure that made this whole module dead in production: the client
  // subscribed to eighteen tables while only `notifications` was in the
  // publication, so no handler ever ran and nothing reported it. A table the
  // client watches must be published, or the subscription is accepted and
  // silent.
  it('watches exactly the tables the publication migration enables', () => {
    const sql = readFileSync(
      join(__dirname, '../../../supabase/migrations/20261106120000_realtime_replica_tables.sql'),
      'utf8',
    )
    const block = sql.match(/ARRAY ARRAY\[([\s\S]*?)\]/)
    expect(block).not.toBeNull()
    const published = [...block![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])

    expect([...published].sort()).toEqual([...WATCHED_TABLES].sort())
  })
})
