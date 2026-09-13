import type { SupabaseClient } from '@supabase/supabase-js';

export interface InventoryValueResult {
  total: number;
  source: 'fifo' | 'fifo_with_fallback' | 'fallback_simple' | 'error';
  productsWithoutBatches: number;
  productCount: number;
}

// One jsonb row returned by the get_inventory_page_aggregates RPC. The
// products map is keyed by product id; per-warehouse fifo is null when that
// pair has no positive batch layer (callers fall back to qty × cost_price,
// matching the old client-side semantics).
export interface InventoryAggregates {
  total_value?: number;
  fallback_value?: number;
  stock_pair_count?: number;
  stock_pair_product_count?: number;
  products?: Record<string, {
    stock: number;
    sold: number;
    fifo: number;
    warehouses?: Record<string, { stock: number; fifo: number | null }>;
  }>;
  batch_only_pairs?: Record<string, Record<string, number>>;
}

export async function getInventoryValue(
  supabase: SupabaseClient
): Promise<InventoryValueResult> {
  // One set-based RPC computes the whole valuation: positive FIFO layers
  // company-wide plus the qty × cost_price fallback for stock pairs with no
  // batch layer. This used to be a scalar RPC followed by two full paginated
  // table downloads classified client-side; the scalar-only RPC mode
  // (p_include_products = false) returns just the four fields in one call.
  try {
    const { data, error } = await supabase.rpc('get_inventory_page_aggregates', { p_include_products: false });
    if (error) throw error;
    const agg = (data || {}) as InventoryAggregates;
    const fallback = Number(agg.fallback_value) || 0;
    return {
      total: Number(agg.total_value) || 0,
      source: fallback > 0 ? 'fifo_with_fallback' : 'fifo',
      productsWithoutBatches: fallback > 0 ? (Number(agg.stock_pair_product_count) || 0) : 0,
      productCount: Number(agg.stock_pair_count) || 0,
    };
  } catch {
    return { total: 0, source: 'error', productsWithoutBatches: 0, productCount: 0 };
  }
}
