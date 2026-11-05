import { buildProductBreakdown, matchesProductGroup, productStockStatus, UNASSIGNED_GROUP, type BreakdownDimension, type BreakdownProduct } from '../product-breakdown';

const product = (id: string, fields: Partial<BreakdownProduct> = {}): BreakdownProduct => ({
  id, is_active: true, min_stock_level: 5, total_stock: 10, ...fields,
});
const warehouses = [{ id: 'main', name: 'Main warehouse' }, { id: 'empty', name: 'Empty warehouse' }];

describe('product breakdown', () => {
  test('counts all active products beyond one API or UI page, excluding inactive products', () => {
    const products = Array.from({ length: 3046 }, (_, i) => product(String(i)));
    products.push(product('inactive', { is_active: false }));
    const result = buildProductBreakdown(products, {}, warehouses);
    expect(result.total).toBe(3046);
    expect(result.groups.category).toEqual([{ key: UNASSIGNED_GROUP, label: 'Uncategorized', count: 3046 }]);
    expect(result.groups.brand).toEqual([{ key: UNASSIGNED_GROUP, label: 'No brand', count: 3046 }]);
  });

  test('groups by IDs, including same-name groups, missing assignments and inactive reference names', () => {
    const products = [
      product('a', { category_id: 'c1', category: { name: 'Pipes' }, brand_id: 'b1', brand: { name: 'Old brand' } }),
      product('b', { category_id: 'c2', category: { name: 'Pipes' } }),
      product('c', { category_id: null, brand_id: null }),
      product('d', { category_id: 'c3', brand_id: 'b2' }),
    ];
    const result = buildProductBreakdown(products, {}, [], [{ id: 'c3', name: 'Fittings' }], [{ id: 'b2', name: 'Local brand' }]);
    expect(result.groups.category).toHaveLength(4);
    expect(result.groups.category.find(g => g.key === 'c3')?.label).toBe('Fittings');
    expect(result.groups.brand.find(g => g.key === 'b1')?.label).toBe('Old brand');
    expect(result.groups.brand.find(g => g.key === 'b2')?.label).toBe('Local brand');
  });

  test.each([
    [-1, 5, 'negative'], [0, 5, 'out'], [1, 5, 'low'], [5, 5, 'low'], [6, 5, 'ok'],
    [0.25, 0.5, 'low'], [0, -1, 'out'], [1, -1, 'ok'],
  ])('partitions stock %s with minimum %s as %s', (stock, min, status) => {
    expect(productStockStatus(product('p', { total_stock: stock as number, min_stock_level: min as number }))).toBe(status);
  });

  test('counts each product once per positive warehouse, with an explicit no-stock group', () => {
    const products = [product('a'), product('b'), product('c'), product('d')];
    const stock = { a: { main: 10, other: 2 }, b: { main: 0 }, c: { main: -2 }, d: {} };
    const result = buildProductBreakdown(products, stock, warehouses);
    expect(result.groups.warehouse).toEqual(expect.arrayContaining([
      { key: 'main', label: 'Main warehouse', count: 1 },
      { key: 'other', label: 'Unavailable warehouse (other)', count: 1 },
      { key: 'empty', label: 'Empty warehouse', count: 0 },
      { key: UNASSIGNED_GROUP, label: 'No positive warehouse stock', count: 3 },
    ]));
    expect(result.groups.warehouse.reduce((sum, group) => sum + group.count, 0)).toBe(5);
  });

  test('every drill-down matches its displayed count, including absent references and zero groups', () => {
    const products = [
      product('a', { category_id: 'c1', brand_id: 'b1', total_stock: 6 }),
      product('b', { category_id: 'c1', total_stock: 2 }),
      product('c', { brand_id: 'b2', total_stock: 0 }),
      product('d', { total_stock: -3 }),
      product('e', { is_active: false }),
    ];
    const stock = { a: { main: 4, other: 2 }, b: { main: 2 }, c: { main: 0 }, d: { main: -3 } };
    const result = buildProductBreakdown(products, stock, warehouses);
    for (const dimension of Object.keys(result.groups) as BreakdownDimension[]) {
      for (const group of result.groups[dimension]) {
        expect(products.filter(p => p.is_active && matchesProductGroup(p, dimension, group.key, stock))).toHaveLength(group.count);
      }
      if (dimension !== 'warehouse') {
        expect(result.groups[dimension].reduce((sum, group) => sum + group.count, 0)).toBe(result.total);
      }
    }
  });

  test('empty catalogs have zero statuses, without fabricated products', () => {
    const result = buildProductBreakdown([], {}, []);
    expect(result.total).toBe(0);
    expect(result.groups.category).toEqual([]);
    expect(result.groups.brand).toEqual([]);
    expect(result.groups.warehouse).toEqual([]);
    expect(result.groups.status.every(g => g.count === 0)).toBe(true);
  });

  test('rebuilding after an edit reflects the new group without stale cached counts', () => {
    const original = product('a', { category_id: 'old' });
    expect(buildProductBreakdown([original], {}, []).groups.category[0].key).toBe('old');
    expect(buildProductBreakdown([{ ...original, category_id: 'new' }], {}, []).groups.category[0].key).toBe('new');
  });
});
