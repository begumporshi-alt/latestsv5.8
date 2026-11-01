/**
 * Unit tests for the online write → replica refresh router
 * (lib/offline/write-refresh).
 *
 * What matters here is *which* tables a write schedules. An under-declared RPC
 * leaves the local copy silently stale, and an over-declared one turns a
 * single GRN into a full 55-table pass — the two failure modes this module
 * exists to prevent. The replica module is mocked so the tests assert on the
 * routing decision only.
 */

jest.mock('../replica', () => {
  // Every replica name referenced by write-refresh's RPC map.
  const names = [
    'Goods receipt notes',
    'Stock movements',
    'Stock counters',
    'Inventory batches',
    'Purchase order items',
    'Purchase orders',
    'Journal entries',
    'Journal lines',
    'Accounts',
    'Products',
    'Purchase reminders',
    'Invoices',
  ]
  const REPLICA: Record<string, { name: string }> = {}
  for (const name of names) REPLICA[name] = { name }
  const REPLICA_BY_TABLE: Record<string, { name: string }> = {
    purchase_orders: REPLICA['Purchase orders'],
    purchase_order_items: REPLICA['Purchase order items'],
    invoices: REPLICA['Invoices'],
  }
  return {
    REPLICA,
    REPLICA_BY_TABLE,
    refreshReplicaTables: jest.fn(async () => {}),
    replicateAll: jest.fn(async () => {}),
  }
})

import { awaitPendingWrites, noteServerWrite } from '../write-refresh'

const replica = jest.requireMock('../replica') as {
  refreshReplicaTables: jest.Mock
  replicateAll: jest.Mock
}

describe('write-refresh routing', () => {
  beforeEach(() => {
    // The module is browser-only by design (it drives IndexedDB).
    ;(globalThis as { window?: unknown }).window = {}
    jest.clearAllMocks()
  })

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window
  })

  it('refreshes only the tables a mapped RPC declares', async () => {
    noteServerWrite('rpc', 'receive_grn')
    await awaitPendingWrites()

    expect(replica.replicateAll).not.toHaveBeenCalled()
    expect(replica.refreshReplicaTables).toHaveBeenCalledTimes(1)

    const names = replica.refreshReplicaTables.mock.calls[0][0] as string[]
    // The GRN's own effects…
    expect(names).toEqual(
      expect.arrayContaining([
        'Goods receipt notes',
        'Stock counters',
        'Inventory batches',
        'Purchase order items',
        'Purchase orders',
        'Journal entries',
        'Journal lines',
        'Accounts',
        'Products',
        'Purchase reminders',
      ]),
    )
    // …and nothing else.
    expect(names).not.toContain('Invoices')
    expect(names).toHaveLength(11)
  })

  it('does not refresh anything for a sequence generator', async () => {
    noteServerWrite('rpc', 'generate_invoice_number')
    await awaitPendingWrites()

    expect(replica.replicateAll).not.toHaveBeenCalled()
    expect(replica.refreshReplicaTables).not.toHaveBeenCalled()
  })

  it('falls back to one full pass for an unmapped RPC', async () => {
    noteServerWrite('rpc', 'some_future_write_rpc')
    await awaitPendingWrites()

    expect(replica.replicateAll).toHaveBeenCalledWith(true)
    expect(replica.refreshReplicaTables).not.toHaveBeenCalled()
  })

  // Creating a product with opening stock (the inventory form, the PO form, and
  // every row of a CSV import) calls these. Unmapped they cost a full 48-table
  // pass per create; they only touch the batch row and the warehouse counter.
  it('maps the opening-stock RPCs instead of forcing a full pass', async () => {
    noteServerWrite('rpc', 'create_opening_batch')
    await awaitPendingWrites()

    expect(replica.replicateAll).not.toHaveBeenCalled()
    expect(replica.refreshReplicaTables).toHaveBeenCalledWith(['Stock counters', 'Inventory batches'])
  })

  it('routes .from() writes by table name', async () => {
    noteServerWrite('from', 'purchase_order_items')
    await awaitPendingWrites()

    expect(replica.refreshReplicaTables).toHaveBeenCalledWith(['Purchase order items'])
    expect(replica.replicateAll).not.toHaveBeenCalled()
  })

  it('collapses a burst into a single refresh', async () => {
    noteServerWrite('from', 'purchase_orders')
    noteServerWrite('from', 'purchase_order_items')
    noteServerWrite('rpc', 'generate_purchase_order_number')
    await awaitPendingWrites()

    expect(replica.refreshReplicaTables).toHaveBeenCalledTimes(1)
    const names = replica.refreshReplicaTables.mock.calls[0][0] as string[]
    expect(names.sort()).toEqual(['Purchase order items', 'Purchase orders'])
  })

  it('resolves only after the replica refresh completes', async () => {
    let release: (() => void) | undefined
    replica.refreshReplicaTables.mockImplementationOnce(
      () => new Promise<void>((resolve) => { release = resolve }),
    )

    noteServerWrite('rpc', 'receive_grn')
    let settled = false
    const pending = awaitPendingWrites().then(() => { settled = true })

    // The refresh is reached through a dynamic import, so wait for the mock to
    // be invoked rather than assuming a single microtask tick is enough.
    for (let i = 0; i < 50 && !release; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(release).toBeDefined()
    expect(settled).toBe(false)

    release?.()
    await pending
    expect(settled).toBe(true)
  })
})
