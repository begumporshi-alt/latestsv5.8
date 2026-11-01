import { buildChallanItems } from '../challan-items';

const invoiceLines = [
  { product_id: 'p1', quantity: 2, unit_name: 'pcs', product: { name: 'Angle Valve', sku: 'ANG-201', unit: 'pcs' } },
  { product_id: 'p2', quantity: 2, unit_name: null, product: { name: 'Rain Shower', sku: 'RS-7154', unit: 'pcs' } },
];

describe('buildChallanItems', () => {
  test('prints the invoice quantities, not the pre-edit delivery snapshot', () => {
    // The delivery snapshot still carries the quantities from before the edit:
    // 0 for the line the edit added, 1 for the line whose qty was raised to 2.
    const deliveryLines = [
      { product_id: 'p1', quantity: 2, delivered_quantity: 0 },
      { product_id: 'p2', quantity: 2, delivered_quantity: 1 },
    ];

    const items = buildChallanItems(invoiceLines, deliveryLines, 'pending');

    expect(items.map((i) => i.delivered_quantity)).toEqual([2, 2]);
    expect(items.map((i) => i.product_sku)).toEqual(['ANG-201', 'RS-7154']);
    expect(items.map((i) => i.unit_name)).toEqual(['pcs', 'pcs']);
  });

  test('a delivered challan reports what was actually delivered', () => {
    const deliveryLines = [
      { product_id: 'p1', quantity: 2, delivered_quantity: 2 },
      { product_id: 'p2', quantity: 2, delivered_quantity: 1 },
    ];

    const items = buildChallanItems(invoiceLines, deliveryLines, 'delivered');

    expect(items.map((i) => i.delivered_quantity)).toEqual([2, 1]);
  });

  test('a delivered challan with no progress row falls back to the invoice qty', () => {
    const items = buildChallanItems(invoiceLines, [], 'delivered');
    expect(items.map((i) => i.delivered_quantity)).toEqual([2, 2]);
  });

  test('a challan with no linked invoice prints its own delivery lines', () => {
    const deliveryLines = [
      { product_id: 'p9', quantity: 5, delivered_quantity: 3, product: { name: 'Tee', sku: 'T-1' } },
    ];

    const items = buildChallanItems(null, deliveryLines, 'pending');

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ product_name: 'Tee', product_sku: 'T-1', quantity: 5, delivered_quantity: 5 });
  });

  test('an empty invoice falls back to the delivery lines instead of printing nothing', () => {
    const deliveryLines = [{ product_id: 'p9', quantity: 5, product: { name: 'Tee' } }];
    expect(buildChallanItems([], deliveryLines, 'pending')).toHaveLength(1);
  });

  test('missing product names render a placeholder, not undefined', () => {
    const items = buildChallanItems([{ product_id: 'x', quantity: 1, product: null }], [], 'pending');
    expect(items[0].product_name).toBe('—');
    expect(items[0].product_sku).toBeUndefined();
    expect(items[0].unit_name).toBeUndefined();
  });

  test('string quantities from PostgREST numeric columns are coerced', () => {
    const items = buildChallanItems([{ product_id: 'x', quantity: '2.500', product: { name: 'Pipe' } }], [], 'pending');
    expect(items[0].quantity).toBe(2.5);
    expect(items[0].delivered_quantity).toBe(2.5);
  });
});
