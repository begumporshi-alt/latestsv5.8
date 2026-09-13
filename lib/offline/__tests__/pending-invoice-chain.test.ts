/**
 * Reproduction of the offline sales-page issue: a pending invoice.create row
 * derived by the overlay must survive the exact query chain fetchSalesData
 * runs (select with customer embed + order + gte/lte on invoice_date +
 * fetchAll's range). The overlay module is mocked to return one pending row,
 * everything else runs the real interpreter.
 */

jest.mock('../replica', () => {
  const specs = ['invoices', 'customers'].map((t) => ({
    name: t,
    table: t,
    store: `replica_${t}`,
  }));
  return {
    REPLICA_BY_TABLE: Object.fromEntries(specs.map((s) => [s.table, s])),
    replicaRows: jest.fn(),
    subscribeReplica: jest.fn(() => () => {}),
  };
});

jest.mock('../db', () => ({
  getMeta: jest.fn(async () => 1),
}));

jest.mock('../pending', () => {
  const actual = jest.requireActual('../pending');
  return { ...actual, pendingOverlayFor: jest.fn() };
});

import { runReplicaQuery, resetReplicaQueryCaches } from '../replica-query';
import { replicaRows } from '../replica';
import { getMeta } from '../db';
import { pendingOverlayFor } from '../pending';

const mockedReplicaRows = replicaRows as jest.Mock;
const mockedGetMeta = getMeta as jest.Mock;
const mockedOverlay = pendingOverlayFor as jest.Mock;

const REAL_INVOICES = [
  { id: 'i1', customer_id: 'c1', invoice_date: '2026-09-13', created_at: '2026-09-13T05:00:00Z', total_amount: 100, status: 'paid' },
  { id: 'i2', customer_id: 'c2', invoice_date: '2026-09-13', created_at: '2026-09-13T04:00:00Z', total_amount: 200, status: 'paid' },
  { id: 'i3', customer_id: 'c1', invoice_date: '2026-09-10', created_at: '2026-09-10T04:00:00Z', total_amount: 50, status: 'sent' },
];

const PENDING_INVOICE = {
  id: 'client-uuid-1',
  invoice_number: 'INV-OFF-123456',
  customer_id: 'c1',
  invoice_date: '2026-09-13',
  created_at: '2026-09-13T12:00:00Z',
  total_amount: 3,
  amount_paid: 3,
  status: 'paid',
  is_pos: false,
  __pending: true,
};

const REAL_CUSTOMERS = [
  { id: 'c1', name: 'ACME Corp' },
  { id: 'c2', name: 'Beta Traders' },
];

beforeEach(() => {
  resetReplicaQueryCaches();
  mockedReplicaRows.mockReset().mockImplementation(async (spec: any) =>
    spec.table === 'invoices' ? REAL_INVOICES : REAL_CUSTOMERS
  );
  mockedGetMeta.mockReset().mockImplementation(async () => 1);
  mockedOverlay.mockReset().mockImplementation(async () => ({
    rows: [PENDING_INVOICE],
    patches: new Map(),
    deletes: new Set(),
  }));
});

describe('pending invoice rows in the sales-page chain', () => {
  test('survives select+embed, order, gte/lte today, and range(0,999)', async () => {
    const res = await runReplicaQuery('invoices', [
      ['select', ['*, customer:customers(name, code, phone, address)']],
      ['order', ['created_at', { ascending: false }]],
      ['gte', ['invoice_date', '2026-09-13']],
      ['lte', ['invoice_date', '2026-09-13']],
      ['range', [0, 999]],
    ] as any);

    expect(res).not.toBeNull();
    const ids = (res!.data as any[]).map((r) => r.id);
    expect(ids).toContain('client-uuid-1');
    expect(ids[0]).toBe('client-uuid-1'); // newest created_at sorts first
    expect(res!.data).toHaveLength(3); // 2 real today + 1 pending
  });

  test('customer embed resolves for the pending row too', async () => {
    const res = await runReplicaQuery('invoices', [
      ['select', ['*, customer:customers(name)']],
      ['gte', ['invoice_date', '2026-09-13']],
      ['lte', ['invoice_date', '2026-09-13']],
    ] as any);
    const pending = (res!.data as any[]).find((r) => r.id === 'client-uuid-1');
    expect(pending?.customer?.name).toBe('ACME Corp');
  });
});
