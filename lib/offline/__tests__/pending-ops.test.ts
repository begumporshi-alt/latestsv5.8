/**
 * Invariants for the pending overlay's op maps:
 *  - every op that drops page-level cache keys (OP_CACHE_KEYS) must also
 *    derive list-view effects (OP_TABLES) — otherwise the drop forces a
 *    replica replay that can't surface anything new, just wasting a reload;
 *  - the update ops for the shared master-data entities (customers,
 *    employees, products) are present, so offline edits reflect in list
 *    views (regression pin for the 2026-09-13 visual-test findings).
 */

import {
  OP_TABLES,
  OP_CACHE_KEYS,
  NATURAL_KEYS,
  naturalKeyOf,
  dedupeByNaturalKey,
  deriveEffects,
} from '../pending';

describe('pending overlay op maps (lib/offline/pending)', () => {
  test('every OP_CACHE_KEYS op also derives effects via OP_TABLES', () => {
    const orphaned = Object.keys(OP_CACHE_KEYS).filter((op) => !OP_TABLES[op]);
    expect(orphaned).toEqual([]);
  });

  test('master-data update ops are covered (edits reflect in list views)', () => {
    expect(OP_TABLES['customer.update']).toContain('customers');
    expect(OP_TABLES['employee.update']).toContain('employees');
    expect(OP_TABLES['product.update']).toContain('products');
    expect(OP_TABLES['employee.create']).toContain('employees');
  });

  // Every page-level cachedQuery aggregate must be dropped by the ops that
  // touch its data — otherwise a queued offline record keeps being hidden by
  // the stale snapshot instead of surfacing via the replica's pending overlay.
  test('page-level cachedQuery aggregates are dropped by their ops', () => {
    expect(OP_CACHE_KEYS['quotation.create']).toContain('quotations:list');
    expect(OP_CACHE_KEYS['quotation.update']).toContain('quotations:list');
    expect(OP_CACHE_KEYS['po.create']).toContain('purchases:list');
    expect(OP_CACHE_KEYS['delivery.create']).toContain('delivery:list');
    expect(OP_CACHE_KEYS['invoice.create']).toContain('dashboard:page-data');
    expect(OP_CACHE_KEYS['product.update']).toEqual(
      expect.arrayContaining(['sales:refs', 'quotations:refs', 'purchases:refs'])
    );
    expect(OP_CACHE_KEYS['customer.update']).toEqual(
      expect.arrayContaining(['sales:refs', 'quotations:refs', 'delivery:refs'])
    );
  });

  test('product.create derives rows for the products table and its embed children', () => {
    // units:product_units and inventory_items are read through relation
    // embeds by the POS snapshot / sales page — without child rows the new
    // product renders without units or stock offline.
    expect(OP_TABLES['product.create']).toEqual(
      expect.arrayContaining(['products', 'product_units', 'inventory_items'])
    );
    expect(OP_CACHE_KEYS['product.create']).toEqual(
      expect.arrayContaining(['inventory:page-data', 'products:all'])
    );
  });

  test('sales-page aggregate keys are dropped by every op that changes invoices/payments', () => {
    for (const op of [
      'invoice.create',
      'payment.create',
      'invoice.status',
      'invoice.cancel',
      'sales_return.create',
    ]) {
      expect(OP_CACHE_KEYS[op]).toContain('sales:page-data:');
    }
  });

  // The DB recomputes customers.outstanding_balance / total_purchases from
  // invoices + receivable debits + receivable payments (recompute_customer_balances,
  // fired by invoice_customer_totals_trigger and payment_customer_totals_trigger),
  // so every op that writes one of those also moves the customer's balance.
  // Without this drop the customer list — and the POS picker's "Due:" badge —
  // keeps serving the pre-op figure.
  test('every op that moves a customer balance drops the canonical customers list', () => {
    for (const op of [
      'invoice.create',
      'payment.create',
      'invoice.status',
      'invoice.cancel',
      'sales_return.create',
      'advance.apply',
      'advance.refund',
    ]) {
      expect(OP_CACHE_KEYS[op]).toContain('customers:all');
    }
  });

  test('customer ops drop the CRM aggregate and the canonical customers list', () => {
    for (const op of ['customer.create', 'customer.update']) {
      expect(OP_CACHE_KEYS[op]).toEqual(
        expect.arrayContaining(['crm:page-data', 'customers:all'])
      );
    }
  });

  test('stock.adjust derives provisional movement rows and drops the stock aggregates', () => {
    const effects = deriveEffects(
      'stock.adjust',
      {
        id: 'adj-1',
        idempotency_key: 'adj-1',
        product_id: 'p1',
        reason_code: 'damaged',
        reason_details: 'water in storage',
        items: [
          { warehouse_id: 'w1', delta: -3, expected_on_hand: 10, unit_cost: 5 },
          { warehouse_id: 'w2', delta: 2, expected_on_hand: 4, unit_cost: 5 },
        ],
      },
      'item-adj',
      1_700_000_000_000,
    );

    const rows = effects.filter((e) => e.kind === 'row' && e.table === 'stock_movements');
    expect(rows).toHaveLength(2);
    expect(rows.map((e: any) => e.row)).toEqual([
      expect.objectContaining({
        product_id: 'p1',
        warehouse_id: 'w1',
        movement_type: 'adjustment',
        quantity: -3,
        reference_type: 'stock_adjustment',
        reference_id: 'adj-1',
        notes: 'Stock write-off (damaged) — water in storage',
      }),
      expect.objectContaining({
        product_id: 'p1',
        warehouse_id: 'w2',
        movement_type: 'adjustment',
        quantity: 2,
        reference_type: 'stock_adjustment',
        reference_id: 'adj-1',
        notes: 'Stock write-off (damaged) — water in storage',
      }),
    ]);
    expect(OP_TABLES['stock.adjust']).toContain('stock_movements');
    expect(OP_CACHE_KEYS['stock.adjust']).toEqual(
      expect.arrayContaining(['inventory:page-data', 'products:all', 'gate:stock'])
    );
  });

  test('a quantity-correction adjustment reads as a correction, not a write-off', () => {
    const effects = deriveEffects(
      'stock.adjust',
      {
        id: 'adj-2',
        product_id: 'p1',
        reason_code: 'quantity_correction',
        items: [{ warehouse_id: 'w1', delta: -1, expected_on_hand: 8 }],
      },
      'item-adj2',
      1,
    );
    const row = effects.find((e) => e.kind === 'row') as any;
    expect(row.row.notes).toBe('Stock quantity correction');
  });
});

describe('natural-key dedupe (attendance upserts)', () => {
  test('attendance ops derive effects (offline marks reflect in list views)', () => {
    expect(OP_TABLES['attendance.mark']).toContain('attendance');
    expect(OP_TABLES['attendance.details']).toContain('attendance');
    expect(NATURAL_KEYS.attendance).toEqual(['employee_id', 'date']);
  });

  test('consecutive pending marks for the same employee+day collapse to the latest', () => {
    const rows = [
      { id: 'pending-1-att', employee_id: 'e1', date: '2026-09-13', status: 'present' },
      { id: 'pending-2-att', employee_id: 'e1', date: '2026-09-13', status: 'late' },
      { id: 'pending-3-att', employee_id: 'e2', date: '2026-09-13', status: 'absent' },
    ];
    const out = dedupeByNaturalKey('attendance', rows);
    expect(out).toHaveLength(2);
    expect(out.find((r) => r.employee_id === 'e1')?.status).toBe('late');
    expect(out.find((r) => r.employee_id === 'e2')?.status).toBe('absent');
  });

  test('different days for the same employee stay separate rows', () => {
    const rows = [
      { id: 'pending-1-att', employee_id: 'e1', date: '2026-09-12', status: 'present' },
      { id: 'pending-2-att', employee_id: 'e1', date: '2026-09-13', status: 'absent' },
    ];
    expect(dedupeByNaturalKey('attendance', rows)).toHaveLength(2);
  });

  test('tables without a natural key pass through untouched', () => {
    const rows = [{ id: 'a' }, { id: 'b' }];
    expect(dedupeByNaturalKey('customers', rows)).toEqual(rows);
  });

  test('naturalKeyOf is null for tables without a natural key', () => {
    expect(naturalKeyOf({ id: 'x' }, 'invoices')).toBeNull();
    expect(naturalKeyOf({ employee_id: 'e1', date: '2026-09-13' }, 'attendance')).toBe('e1|2026-09-13');
  });
});

describe('offline delivery challans (lib/offline/pending)', () => {
  const lines = [
    { product_id: 'p1', quantity: 2, unit_name: 'pcs' },
    { product_id: 'p2', quantity: 3, unit_name: null },
  ];

  test('delivery.create derives the challan lines from the payload', () => {
    const effects = deriveEffects(
      'delivery.create',
      { id: 'dlv-1', invoice_id: 'inv-1', items: lines },
      'item-1',
      1_700_000_000_000,
    );
    const itemRows = effects.filter((e) => e.kind === 'row' && e.table === 'delivery_items');

    expect(itemRows).toHaveLength(2);
    expect(itemRows.map((e: any) => e.row)).toEqual([
      expect.objectContaining({ delivery_id: 'dlv-1', product_id: 'p1', quantity: 2, delivered_quantity: 2 }),
      expect.objectContaining({ delivery_id: 'dlv-1', product_id: 'p2', quantity: 3, delivered_quantity: 3 }),
    ]);
    expect(OP_TABLES['delivery.create']).toEqual(expect.arrayContaining(['deliveries', 'delivery_items']));
  });

  test('a delivery queued without lines still derives the header only', () => {
    const effects = deriveEffects('delivery.create', { id: 'dlv-2' }, 'item-2', 1);
    expect(effects.filter((e) => e.kind === 'row' && e.table === 'delivery_items')).toHaveLength(0);
    expect(effects.some((e) => e.kind === 'row' && e.table === 'deliveries')).toBe(true);
  });

  test('delivery.update carries the re-link and swaps the challan lines', () => {
    const effects = deriveEffects(
      'delivery.update',
      { id: 'dlv-1', invoice_id: 'inv-2', items: lines, delivery_date: '2026-11-01' },
      'item-3',
      1,
    );

    const patch = effects.find((e) => e.kind === 'patch' && e.table === 'deliveries') as any;
    expect(typeof patch.patch).toBe('function');
    expect(patch.patch({ customer_id: 'c1', invoice_id: 'inv-1' }).invoice_id).toBe('inv-2');

    const replace = effects.find((e) => e.kind === 'replaceParent') as any;
    expect(replace).toMatchObject({ table: 'delivery_items', parentColumn: 'delivery_id', parentId: 'dlv-1' });
    expect(replace.rows).toHaveLength(2);
  });

  test('an older queued edit without invoice_id must not unlink the invoice', () => {
    const effects = deriveEffects('delivery.update', { id: 'dlv-1', notes: 'x' }, 'item-4', 1);
    const patch = effects.find((e) => e.kind === 'patch' && e.table === 'deliveries') as any;
    const applied = patch.patch({ customer_id: 'c1', invoice_id: 'inv-1' });

    expect(applied.invoice_id).toBeUndefined();
    expect(effects.some((e) => e.kind === 'replaceParent')).toBe(false);
  });

  // The form sends `items` only when the link changes. A plain edit of an
  // offline-created challan must keep the lines it was queued with.
  test('a plain edit leaves a queued challan lines intact', () => {
    const create = deriveEffects(
      'delivery.create',
      { id: 'dlv-9', invoice_id: 'inv-1', items: lines },
      'item-5',
      1,
    ).filter((e) => e.kind === 'row' && e.table === 'delivery_items');

    const edit = deriveEffects(
      'delivery.update',
      { id: 'dlv-9', invoice_id: 'inv-1', notes: 'same link' },
      'item-6',
      2,
    );

    expect(create).toHaveLength(2);
    expect(edit.some((e) => e.kind === 'replaceParent')).toBe(false);
  });

  // replaceParent only swaps queued rows. Rows already in the replica are
  // hidden through the overlay's deletes set, so the re-link payload names them.
  test('a re-link deletes the superseded rows by id', () => {
    const effects = deriveEffects(
      'delivery.update',
      { id: 'dlv-1', invoice_id: 'inv-2', items: lines, removed_item_ids: ['di-1', 'di-2'] },
      'item-7',
      1,
    );

    const deletes = effects.filter((e) => e.kind === 'delete') as any[];
    expect(deletes).toEqual([
      { kind: 'delete', table: 'delivery_items', id: 'di-1' },
      { kind: 'delete', table: 'delivery_items', id: 'di-2' },
    ]);
  });

  test('a re-link without captured ids still swaps the queued rows', () => {
    const effects = deriveEffects(
      'delivery.update',
      { id: 'dlv-1', invoice_id: 'inv-2', items: lines },
      'item-8',
      1,
    );

    expect(effects.filter((e) => e.kind === 'delete')).toHaveLength(0);
    expect(effects.some((e) => e.kind === 'replaceParent')).toBe(true);
  });
});
