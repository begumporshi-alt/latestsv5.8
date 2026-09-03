import { getInventoryValue } from '../inventory-value';

// Minimal mock that mimics the supabase-js call chain used by the helper.
// The helper makes three kinds of calls:
//   rpc('get_fifo_inventory_value') -> { data, error }
//   from('inventory_items').select(...).gt(...).order(...) -> { data, error }
//   from('inventory_batches').select(...).gt(...).order(...) -> { data, error }
function mockSupabase(opts: {
  fifoValue: number | null;
  invItems: any[];        // rows from inventory_items
  batchKeys: string[];    // product_id|warehouse_id pairs with remaining batches
  rpcThrows?: boolean;
}) {
  const rpc = opts.rpcThrows
    ? jest.fn().mockRejectedValue(new Error('boom'))
    : jest.fn().mockResolvedValue({ data: opts.fifoValue, error: null });
  const from = jest.fn().mockImplementation((table: string) => {
    if (table === 'inventory_items') {
      const builder: any = {
        select: jest.fn(),
        gt: jest.fn(),
        order: jest.fn(),
        range: jest.fn(),
      };
      builder.select.mockReturnValue(builder);
      builder.gt.mockReturnValue(builder);
      builder.order.mockReturnValue(builder);
      builder.range.mockResolvedValue({ data: opts.invItems, error: null });
      return builder;
    }
    if (table === 'inventory_batches') {
      const batchData = opts.batchKeys.map((k) => {
        const [product_id, warehouse_id] = k.split('|');
        return { product_id, warehouse_id };
      });
      const builder: any = {
        select: jest.fn(),
        gt: jest.fn(),
        order: jest.fn(),
        range: jest.fn(),
      };
      builder.select.mockReturnValue(builder);
      builder.gt.mockReturnValue(builder);
      builder.order.mockReturnValue(builder);
      builder.range.mockResolvedValue({ data: batchData, error: null });
      return builder;
    }
    return { select: jest.fn().mockResolvedValue({ data: [], error: null }) };
  });
  return { rpc, from };
}

describe('getInventoryValue', () => {
  it('returns FIFO total when no products lack batches', async () => {
    const m = mockSupabase({ fifoValue: 500, invItems: [], batchKeys: [] });
    const result = await getInventoryValue({ rpc: m.rpc, from: m.from } as any);
    expect(result.total).toBe(500);
    expect(result.source).toBe('fifo');
    expect(result.productsWithoutBatches).toBe(0);
  });

  it('adds fallback qty*cost_price for products with stock but no batches', async () => {
    const m = mockSupabase({
      fifoValue: 500,
      invItems: [
        { product_id: 'p1', warehouse_id: 'w1', quantity_on_hand: 10, product: { id: 'p1', cost_price: 20 } },
      ],
      batchKeys: [], // p1|w1 has no remaining batch
    });
    const result = await getInventoryValue({ rpc: m.rpc, from: m.from } as any);
    expect(result.total).toBe(700); // 500 + 10*20
    expect(result.source).toBe('fifo_with_fallback');
    expect(result.productsWithoutBatches).toBe(1);
  });

  it('does not double-count a product that has a remaining batch', async () => {
    const m = mockSupabase({
      fifoValue: 500,
      invItems: [
        { product_id: 'p1', warehouse_id: 'w1', quantity_on_hand: 10, product: { id: 'p1', cost_price: 20 } },
      ],
      batchKeys: ['p1|w1'], // p1|w1 already counted by FIFO
    });
    const result = await getInventoryValue({ rpc: m.rpc, from: m.from } as any);
    expect(result.total).toBe(500);
    expect(result.source).toBe('fifo');
  });

  it('falls back to simple sum when the RPC throws', async () => {
    const m = mockSupabase({
      fifoValue: null,
      invItems: [{ product_id: 'p1', warehouse_id: 'w1', quantity_on_hand: 10, product: { id: 'p1', cost_price: 20 } }],
      batchKeys: [],
      rpcThrows: true,
    });
    const result = await getInventoryValue({ rpc: m.rpc, from: m.from } as any);
    expect(result.source).toBe('fallback_simple');
    expect(result.total).toBe(200);
  });

  it('returns error result on hard failure without throwing', async () => {
    const rpc = jest.fn().mockRejectedValue(new Error('boom'));
    const from = jest.fn().mockImplementation(() => ({
      select: jest.fn().mockReturnThis(),
      gt: jest.fn().mockRejectedValue(new Error('boom')),
    }));
    const result = await getInventoryValue({ rpc, from } as any);
    expect(result.source).toBe('error');
    expect(result.total).toBe(0);
  });
});
