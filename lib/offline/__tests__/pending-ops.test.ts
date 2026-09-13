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

  test('customer ops drop the CRM aggregate and the canonical customers list', () => {
    for (const op of ['customer.create', 'customer.update']) {
      expect(OP_CACHE_KEYS[op]).toEqual(
        expect.arrayContaining(['crm:page-data', 'customers:all'])
      );
    }
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
