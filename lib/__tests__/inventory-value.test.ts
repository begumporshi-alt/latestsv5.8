import { getInventoryValue } from '../inventory-value';

// The helper reads the whole valuation from one set-based RPC
// (get_inventory_page_aggregates with p_include_products = false), which
// returns the four scalar fields the caller needs.
function mockSupabase(opts: {
  aggregates?: Record<string, unknown> | null;
  error?: { message: string } | null;
  rpcThrows?: boolean;
}) {
  const rpc = opts.rpcThrows
    ? jest.fn().mockRejectedValue(new Error('boom'))
    : jest.fn().mockResolvedValue({ data: opts.aggregates ?? null, error: opts.error ?? null });
  return { rpc };
}

describe('getInventoryValue', () => {
  it('returns the FIFO total when no pair needs the qty x cost fallback', async () => {
    const m = mockSupabase({
      aggregates: { total_value: 500, fallback_value: 0, stock_pair_count: 3, stock_pair_product_count: 3 },
    });
    const result = await getInventoryValue({ rpc: m.rpc } as any);
    expect(result.total).toBe(500);
    expect(result.source).toBe('fifo');
    expect(result.productsWithoutBatches).toBe(0);
    expect(result.productCount).toBe(3);
  });

  it('reads the valuation from the aggregates RPC without the product payload', async () => {
    const m = mockSupabase({
      aggregates: { total_value: 500, fallback_value: 0, stock_pair_count: 3, stock_pair_product_count: 3 },
    });
    await getInventoryValue({ rpc: m.rpc } as any);
    expect(m.rpc).toHaveBeenCalledWith('get_inventory_page_aggregates', { p_include_products: false });
  });

  it('flags the fallback pairs that carry value outside the batch layers', async () => {
    const m = mockSupabase({
      aggregates: { total_value: 700, fallback_value: 200, stock_pair_count: 4, stock_pair_product_count: 1 },
    });
    const result = await getInventoryValue({ rpc: m.rpc } as any);
    expect(result.total).toBe(700);
    expect(result.source).toBe('fifo_with_fallback');
    expect(result.productsWithoutBatches).toBe(1);
    expect(result.productCount).toBe(4);
  });

  it('treats a missing aggregate payload as a zero valuation', async () => {
    const m = mockSupabase({ aggregates: null });
    const result = await getInventoryValue({ rpc: m.rpc } as any);
    expect(result.total).toBe(0);
    expect(result.source).toBe('fifo');
    expect(result.productsWithoutBatches).toBe(0);
  });

  it('returns error result on hard failure without throwing', async () => {
    const m = mockSupabase({ error: { message: 'boom' } });
    const result = await getInventoryValue({ rpc: m.rpc } as any);
    expect(result.source).toBe('error');
    expect(result.total).toBe(0);
  });

  it('returns error result when the RPC rejects without throwing', async () => {
    const m = mockSupabase({ rpcThrows: true });
    const result = await getInventoryValue({ rpc: m.rpc } as any);
    expect(result.source).toBe('error');
    expect(result.total).toBe(0);
  });
});
