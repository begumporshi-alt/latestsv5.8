import type { SupabaseClient } from '@supabase/supabase-js';

export interface InventoryValueResult {
  total: number;
  source: 'fifo' | 'fifo_with_fallback' | 'fallback_simple' | 'error';
  productsWithoutBatches: number;
  productCount: number;
}

export async function getInventoryValue(
  supabase: SupabaseClient
): Promise<InventoryValueResult> {
  // Primary path: the existing FIFO RPC sums remaining batch qty * unit_cost.
  try {
    const { data: fifoValue, error: rpcError } = await supabase.rpc('get_fifo_inventory_value');
    const fifoTotal = Number(fifoValue || 0);
    if (rpcError) throw rpcError;

    // Find products that have stock but no remaining batches for that
    // product+warehouse. Those need the fallback qty * cost_price.
    // Fetch the set of (product_id, warehouse_id) that DO have a remaining
    // batch, then classify in memory to avoid an N+1 query.
    let missing: any[] = [];
    let batchKeys = new Set<string>();
    try {
      const [invRes, batchRes] = await Promise.all([
        supabase
          .from('inventory_items')
          .select('product_id, warehouse_id, quantity_on_hand, product:products(id, cost_price)')
          .gt('quantity_on_hand', 0),
        supabase
          .from('inventory_batches')
          .select('product_id, warehouse_id')
          .gt('quantity_remaining', 0),
      ]);
      missing = invRes.data || [];
      batchKeys = new Set((batchRes.data || []).map((b: any) => `${b.product_id}|${b.warehouse_id}`));
    } catch {
      missing = [];
    }

    const missingProducts = new Set<string>();
    let fallbackValue = 0;
    let productCount = 0;
    for (const item of missing) {
      const key = `${item.product_id}|${item.warehouse_id}`;
      productCount++;
      if (item.product?.id) missingProducts.add(item.product.id);
      if (!batchKeys.has(key)) {
        fallbackValue += Number(item.quantity_on_hand) * Number(item.product?.cost_price || 0);
      }
    }

    return {
      total: fifoTotal + fallbackValue,
      source: fallbackValue > 0 ? 'fifo_with_fallback' : 'fifo',
      productsWithoutBatches: fallbackValue > 0 ? missingProducts.size : 0,
      productCount,
    };
  } catch {
    // RPC failed — fall back to a simple quantity * cost_price sum.
    try {
      let total = 0;
      let count = 0;
      let pg = 0;
      while (true) {
        const { data: pageData } = await supabase
          .from('inventory_items')
          .select('quantity_on_hand, product:products(cost_price)')
          .range(pg * 1000, (pg + 1) * 1000 - 1);
        const page = pageData || [];
        for (const item of page) {
          total += Number(item.quantity_on_hand) * Number((item.product as any)?.cost_price || 0);
          count++;
        }
        if (page.length < 1000) break;
        pg++;
      }
      return { total, source: 'fallback_simple', productsWithoutBatches: 0, productCount: count };
    } catch {
      return { total: 0, source: 'error', productsWithoutBatches: 0, productCount: 0 };
    }
  }
}
