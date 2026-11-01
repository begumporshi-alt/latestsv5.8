/**
 * The merge the offline challan re-link relies on.
 *
 * `pendingOverlayFor` can only express a removal by row id, so an offline
 * re-link of an already-synced delivery names the rows it supersedes. This
 * pins the other half of that contract: a `delete` effect must hide the replica
 * row and the queued replacement rows must take its place — otherwise the
 * challan would show the old and new line sets side by side until the replay
 * lands.
 */

jest.mock('../replica', () => ({
  REPLICA_BY_TABLE: { delivery_items: { name: 'Delivery items', table: 'delivery_items', store: 'replica_delivery_items' } },
  replicaRows: jest.fn(),
  subscribeReplica: jest.fn(() => () => {}),
}))

jest.mock('../outbox', () => ({
  subscribeOutbox: jest.fn(() => () => {}),
}))

const overlay = { rows: [] as any[], patches: new Map<string, any>(), deletes: new Set<string>() }

jest.mock('../pending', () => ({
  pendingOverlayFor: jest.fn(async () => overlay),
  resetPendingCaches: jest.fn(),
  applyPatchChain: jest.fn((row: any) => row),
  NATURAL_KEYS: {},
  naturalKeyOf: jest.fn(() => null),
}))

import { applyPendingOverlay } from '../replica-query';

const replicaRows = [
  { id: 'di-old-1', delivery_id: 'dlv-1', product_id: 'p1', quantity: 2 },
  { id: 'di-old-2', delivery_id: 'dlv-1', product_id: 'p2', quantity: 3 },
  { id: 'di-other', delivery_id: 'dlv-2', product_id: 'p1', quantity: 9 },
]

beforeEach(() => {
  overlay.rows = []
  overlay.deletes = new Set()
})

describe('applyPendingOverlay — challan re-link', () => {
  test('the superseded rows disappear and the queued replacement appears', async () => {
    overlay.deletes = new Set(['di-old-1', 'di-old-2'])
    overlay.rows = [{ id: 'pending-item-7-relink0', delivery_id: 'dlv-1', product_id: 'p9', quantity: 5 }]

    const merged = await applyPendingOverlay('delivery_items', replicaRows)

    expect(merged.map((r) => r.id)).toEqual(['di-other', 'pending-item-7-relink0'])
  })

  test('a delete id that no longer exists is a no-op', async () => {
    overlay.deletes = new Set(['di-gone'])
    overlay.rows = [{ id: 'pending-item-7-relink0', delivery_id: 'dlv-1', product_id: 'p9', quantity: 5 }]

    const merged = await applyPendingOverlay('delivery_items', replicaRows)

    expect(merged).toHaveLength(4)
  });

  test('without a delete the old rows stay (the plain-edit case)', async () => {
    const merged = await applyPendingOverlay('delivery_items', replicaRows)
    expect(merged.map((r) => r.id)).toEqual(['di-old-1', 'di-old-2', 'di-other'])
  })
})
