/**
 * Unit tests for the replica query engine (lib/offline/replica-query).
 *
 * The replica module and Dexie are replaced with in-memory fixtures — these
 * tests are about the *interpretation* of recorded postgrest builder chains:
 * filters, .or() expressions, ordering/slicing, single-terminators, counts
 * and relation embeds through the foreign-key map. Every unsupported shape
 * must return null (a miss), never a wrong result.
 */

jest.mock('../replica', () => {
  const specs = ['invoices', 'customers', 'invoice_items', 'journal_entries', 'journal_lines', 'products', 'accounts'].map((t) => ({
    name: t,
    table: t,
    store: `replica_${t}`,
  }))
  return {
    REPLICA_BY_TABLE: Object.fromEntries(specs.map((s) => [s.table, s])),
    replicaRows: jest.fn(),
    subscribeReplica: jest.fn(() => () => {}),
  }
})

jest.mock('../db', () => ({
  getMeta: jest.fn(async () => 1),
}))

import { runReplicaQuery, resetReplicaQueryCaches } from '../replica-query';
import { replicaRows } from '../replica';
import { getMeta } from '../db';

const mockedReplicaRows = replicaRows as jest.Mock;
const mockedGetMeta = getMeta as jest.Mock;

const DATA: Record<string, any[]> = {
  customers: [
    { id: 'c1', name: 'ACME Corp' },
    { id: 'c2', name: 'Beta Traders' },
  ],
  invoices: [
    { id: 'i1', customer_id: 'c1', status: 'paid', total: 100, invoice_date: '2026-08-01', created_at: '2026-08-01T00:00:00Z' },
    { id: 'i2', customer_id: 'c2', status: 'unpaid', total: 200, invoice_date: '2026-09-01', created_at: '2026-09-01T00:00:00Z' },
    { id: 'i3', customer_id: 'c1', status: 'paid', total: 50, invoice_date: '2026-07-01', created_at: '2026-07-01T00:00:00Z' },
  ],
  invoice_items: [
    { id: 'it1', invoice_id: 'i1', quantity: 2 },
    { id: 'it2', invoice_id: 'i1', quantity: 1 },
    { id: 'it3', invoice_id: 'i2', quantity: 5 },
  ],
  journal_entries: [
    { id: 'je1', entry_date: '2026-08-15', entry_number: 'JE-1', reference_type: 'invoice', reference_id: 'i1', supplier_id: null },
    { id: 'je2', entry_date: '2026-09-05', entry_number: 'JE-2', reference_type: 'grn', reference_id: 'grn9', supplier_id: 's9' },
  ],
  journal_lines: [
    { id: 'jl1', journal_entry_id: 'je1', account_id: 'a1', debit: 100, credit: 0 },
    { id: 'jl2', journal_entry_id: 'je2', account_id: 'a2', debit: 0, credit: 50 },
    { id: 'jl3', journal_entry_id: null, account_id: 'a1', debit: 7, credit: 0 },
  ],
  products: [
    { id: 'p1', name: 'Pipe 4m', sku: 'P4', is_active: true },
    { id: 'p2', name: 'Cable coil', sku: 'CC', is_active: false },
  ],
  accounts: [
    { id: 'a1', code: '1100', name: 'Cash', account_type: 'asset' },
    { id: 'a2', code: '4000', name: 'Sales Revenue', account_type: 'revenue' },
  ],
}

beforeEach(() => {
  resetReplicaQueryCaches();
  mockedReplicaRows.mockReset().mockImplementation(async (spec: any) => DATA[spec.table] ?? []);
  mockedGetMeta.mockReset().mockImplementation(async () => 1);
});

describe('filters', () => {
  test('eq + order + limit', async () => {
    const res = await runReplicaQuery('invoices', [
      ['select', ['*']],
      ['eq', ['status', 'paid']],
      ['order', ['created_at', { ascending: false }]],
      ['limit', [1]],
    ]);
    expect(res).not.toBeNull();
    expect(res!.data).toEqual([DATA.invoices[0]]);
  });

  test('gte / lte date ranges', async () => {
    const res = await runReplicaQuery('invoices', [
      ['select', ['*']],
      ['gte', ['invoice_date', '2026-08-01']],
      ['lte', ['invoice_date', '2026-08-31']],
    ]);
    expect(res!.data.map((r: any) => r.id)).toEqual(['i1']);
  });

  test('in with an array', async () => {
    const res = await runReplicaQuery('invoices', [
      ['select', ['*']],
      ['in', ['status', ['paid', 'partial']]],
    ]);
    expect(res!.data.map((r: any) => r.id)).toEqual(['i1', 'i3']);
  });

  test('not-in with a quoted string list (dashboard pattern)', async () => {
    const res = await runReplicaQuery('invoices', [
      ['select', ['*']],
      ['not', ['status', 'in', '("cancelled","refunded","paid")']],
    ]);
    expect(res!.data.map((r: any) => r.id)).toEqual(['i2']);
  });

  test('or with ilike patterns (POS search pattern)', async () => {
    const res = await runReplicaQuery('products', [
      ['select', ['*']],
      ['or', ['name.ilike.%pipe%,sku.ilike.%pipe%']],
    ]);
    expect(res!.data.map((r: any) => r.id)).toEqual(['p1']);
  });

  test('or with a nested and + in list (journal page pattern)', async () => {
    const res = await runReplicaQuery('journal_entries', [
      ['select', ['*']],
      ['or', ['supplier_id.eq.s9,and(reference_type.eq.invoice,reference_id.in.(i1,i2))']],
    ]);
    // je1 matches the and() branch; je2 matches supplier_id even though its
    // reference_type is not invoice — top-level commas are ORs.
    expect(res!.data.map((r: any) => r.id)).toEqual(['je1', 'je2']);

    // reference_id not in the list → and() branch fails
    const res2 = await runReplicaQuery('journal_entries', [
      ['select', ['*']],
      ['or', ['supplier_id.eq.other,and(reference_type.eq.invoice,reference_id.in.(i2))']],
    ]);
    expect(res2!.data.map((r: any) => r.id)).toEqual([]);
  });

  test('or is-null + gt with an ISO timestamp containing dots (store-credit pattern)', async () => {
    const rows = [
      { id: 'sc1', expires_at: null },
      { id: 'sc2', expires_at: '2030-01-01T00:00:00.000Z' },
      { id: 'sc3', expires_at: '2020-01-01T00:00:00.000Z' },
    ];
    mockedReplicaRows.mockImplementation(async (spec: any) => (spec.table === 'products' ? rows : []));
    const res = await runReplicaQuery('products', [
      ['select', ['*']],
      ['or', ['expires_at.is.null,expires_at.gt.2026-01-01T00:00:00.000Z']],
    ]);
    expect(res!.data.map((r: any) => r.id)).toEqual(['sc1', 'sc2']);
  });
});

describe('shape', () => {
  test('order ascending is the default; nulls sort last', async () => {
    const rows = [
      { id: 'x1', rank: null },
      { id: 'x2', rank: 2 },
      { id: 'x3', rank: 1 },
    ];
    mockedReplicaRows.mockImplementation(async (spec: any) => (spec.table === 'products' ? rows : []));
    const res = await runReplicaQuery('products', [['select', ['*']], ['order', ['rank']]]);
    expect(res!.data.map((r: any) => r.id)).toEqual(['x3', 'x2', 'x1']);
  });

  test('range slices and count reflects the filtered total (pagination pattern)', async () => {
    const res = await runReplicaQuery('invoices', [
      ['select', ['*', { count: 'exact' }]],
      ['range', [0, 1]],
    ]);
    expect(res!.count).toBe(3);
    expect(res!.data.length).toBe(2);
  });

  test('head:true returns null data with the count', async () => {
    const res = await runReplicaQuery('invoices', [
      ['select', ['id', { count: 'exact', head: true }]],
    ]);
    expect(res!.data).toBeNull();
    expect(res!.count).toBe(3);
  });

  test('maybeSingle returns the first row as an object', async () => {
    const res = await runReplicaQuery('customers', [
      ['select', ['*']],
      ['eq', ['id', 'c2']],
      ['maybeSingle', []],
    ]);
    expect(res!.data).toEqual(DATA.customers[1]);
  });

  test('maybeSingle with no match returns null data, not an error', async () => {
    const res = await runReplicaQuery('customers', [
      ['select', ['*']],
      ['eq', ['id', 'nope']],
      ['maybeSingle', []],
    ]);
    expect(res!.data).toBeNull();
  });
});

describe('relation embeds', () => {
  test('many-to-one: customer:customers(name) on invoices', async () => {
    const res = await runReplicaQuery('invoices', [
      ['select', ['id, total, customer:customers(name)']],
      ['eq', ['id', 'i1']],
    ]);
    expect(res!.data[0].customer).toEqual({ id: 'c1', name: 'ACME Corp' });
  });

  test('one-to-many: items:invoice_items(*) on invoices', async () => {
    const res = await runReplicaQuery('invoices', [
      ['select', ['id, items:invoice_items(*)']],
      ['eq', ['id', 'i1']],
    ]);
    expect(res!.data[0].items.map((i: any) => i.id)).toEqual(['it1', 'it2']);
  });

  test('nested embed: journal_entry with !inner on journal_lines', async () => {
    const res = await runReplicaQuery('journal_lines', [
      ['select', ['id, debit, journal_entry:journal_entries!inner(entry_number, entry_date)']],
      ['eq', ['id', 'jl1']],
    ]);
    expect(res!.data[0].journal_entry.entry_number).toBe('JE-1');
  });

  test('a query without embeds returns rows untouched by other queries', async () => {
    await runReplicaQuery('invoices', [
      ['select', ['id, customer:customers(name)']],
      ['eq', ['id', 'i1']],
    ]);
    const res = await runReplicaQuery('invoices', [
      ['select', ['id, total']],
      ['eq', ['id', 'i1']],
    ]);
    expect(res!.data[0].customer).toBeUndefined();
  });
});

describe('embedded-column filters', () => {
  test('journal_entries.entry_date filter on a journal_lines query (bank-reconciliation pattern)', async () => {
    const res = await runReplicaQuery('journal_lines', [
      ['select', ['id, journal_entry:journal_entries!inner(entry_date)']],
      ['gte', ['journal_entries.entry_date', '2026-09-01']],
    ]);
    // jl1's entry is in August; jl2's is September; jl3 has no entry at all
    expect(res!.data.map((r: any) => r.id)).toEqual(['jl2']);
  });

  test('embedded-column filter on invoices via invoice_items (inventory detail pattern)', async () => {
    const res = await runReplicaQuery('invoice_items', [
      ['select', ['id, invoice:invoices(invoice_number)']],
      ['in', ['invoice.status', ['paid', 'unpaid']]],
    ]);
    expect(res!.data.map((r: any) => r.id)).toEqual(['it1', 'it2', 'it3']);
  });
});

describe('unsupported queries must decline (null), never guess', () => {
  test('table not in the replica', async () => {
    const res = await runReplicaQuery('activity_logs', [['select', ['*']]]);
    expect(res).toBeNull();
  });

  test('table replicated but never synced (no replica:count meta)', async () => {
    mockedGetMeta.mockImplementation(async () => undefined);
    const res = await runReplicaQuery('invoices', [['select', ['*']]]);
    expect(res).toBeNull();
  });

  test('unknown builder method', async () => {
    const res = await runReplicaQuery('invoices', [['select', ['*']], ['textSearch', ['name', 'pipe']]]);
    expect(res).toBeNull();
  });

  test('unknown relation embed', async () => {
    const res = await runReplicaQuery('invoices', [['select', ['id, warehouse:warehouses(name)']]]);
    expect(res).toBeNull();
  });

  test('unparseable or expression', async () => {
    const res = await runReplicaQuery('invoices', [['select', ['*']], ['or', ['name.ilike.%bro(ken%']]]);
    expect(res).toBeNull();
  });

  test('filter on an embedded table with no FK from the base table', async () => {
    const res = await runReplicaQuery('invoices', [
      ['select', ['*']],
      ['eq', ['warehouses.name', 'Main']],
    ]);
    expect(res).toBeNull();
  });
});
