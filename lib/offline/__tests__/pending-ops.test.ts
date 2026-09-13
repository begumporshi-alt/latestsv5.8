/**
 * Invariants for the pending overlay's op maps:
 *  - every op that drops page-level cache keys (OP_CACHE_KEYS) must also
 *    derive list-view effects (OP_TABLES) — otherwise the drop forces a
 *    replica replay that can't surface anything new, just wasting a reload;
 *  - the update ops for the shared master-data entities (customers,
 *    employees, products) are present, so offline edits reflect in list
 *    views (regression pin for the 2026-09-13 visual-test findings).
 */

import { OP_TABLES, OP_CACHE_KEYS } from '../pending';

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
