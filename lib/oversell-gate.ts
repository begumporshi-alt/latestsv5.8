// Shared oversell gate: compare a sale's line items against the FIFO batch
// ledger (inventory_batches.quantity_remaining) before submit. The counter
// (inventory_items.quantity_on_hand) is NOT the truth — it drifts.
//
// Used by the POS page, the CreateInvoiceModal on the sales page, and the
// quote→invoice conversion, so all three paths warn identically before
// creating a negative inventory layer (an IOU) via consume_fifo.

import { supabaseRaw } from '@/lib/supabase-raw';
import { cacheGet, cachePut, isNetworkError } from '@/lib/offline/cache';
import { CACHE_KEYS } from '@/lib/offline/keys';

export interface LedgerStock {
  // `${productId}|${warehouseId}` → base-unit qty remaining in FIFO batches
  byPair: Record<string, number>;
  defaultWarehouseId: string | null;
  /** true when served from the offline snapshot instead of a live lookup */
  stale?: boolean;
}

export interface OversellItemInput {
  product_id: string;
  warehouse_id?: string | null;
  base_quantity: number;
  name: string;
  sku?: string;
  cost_price?: number;
  // Counter stock (inventory_items.quantity_on_hand) in base units, if known.
  stock_available?: number | null;
}

export interface Shortfall {
  name: string;
  sku: string;
  baseQty: number;
  ledgerQty: number;
  shortfall: number;
  costValue: number;
  bothEmpty: boolean;
}

// Fetch batch-ledger quantities for exactly these products via
// get_batch_stock_by_product_warehouse(p_product_ids). Passing ids (not
// fetching the whole catalog) matters: the full result is >1000 rows and
// Supabase caps responses at 1000, silently dropping the tail — which made
// ~400 products read as "ledger 0" and fired false oversell warnings.
//
// Every successful lookup is merged into an offline snapshot (per
// product|warehouse pairs, so coverage accumulates across carts over time).
// When the network is unreachable the snapshot is served with stale=true so
// callers can soften hard blocks into warnings — offline data is advisory.
// Returns null only when there is no snapshot either, so callers fail open
// with a notice: the gate is advisory and the DB allows the sale either way.
export async function fetchLedgerStockFor(
  productIds: string[],
  defaultWarehouseId?: string | null
): Promise<LedgerStock | null> {
  const ids = Array.from(new Set(productIds.filter(Boolean)));
  const defaultWh = defaultWarehouseId ?? (await resolveDefaultWarehouseId());
  if (ids.length === 0) return { byPair: {}, defaultWarehouseId: defaultWh };

  const { data, error } = await supabaseRaw.rpc('get_batch_stock_by_product_warehouse', {
    p_product_ids: ids,
  });

  if (error || !data) {
    if (isNetworkError(error)) {
      const cached = await cacheGet<LedgerStock>(CACHE_KEYS.gateStock);
      if (cached) {
        return { byPair: cached.byPair ?? {}, defaultWarehouseId: cached.defaultWarehouseId ?? defaultWh, stale: true };
      }
    }
    return null;
  }

  const byPair: Record<string, number> = {};
  for (const r of data as Array<{ product_id: string; warehouse_id: string | null; qty: number | string }>) {
    byPair[`${r.product_id}|${r.warehouse_id}`] = Number(r.qty);
  }
  // Merge over the previous snapshot: fresh pairs win, older pairs survive,
  // so the offline snapshot grows to cover everything this device has sold.
  const prev = await cacheGet<LedgerStock>(CACHE_KEYS.gateStock);
  const stock: LedgerStock = {
    byPair: { ...(prev?.byPair ?? {}), ...byPair },
    defaultWarehouseId: defaultWh,
  };
  await cachePut(CACHE_KEYS.gateStock, stock);
  return stock;
}

async function resolveDefaultWarehouseId(): Promise<string | null> {
  const { data, error } = await supabaseRaw
    .from('warehouses')
    .select('id')
    .eq('is_default', true)
    .eq('is_active', true)
    .limit(1);
  if ((error || !data) && isNetworkError(error)) {
    const cached = await cacheGet<Array<{ id: string; is_default: boolean; is_active: boolean }>>(CACHE_KEYS.warehouses);
    return cached?.find((w) => w.is_default && w.is_active)?.id ?? null;
  }
  return data?.[0]?.id ?? null;
}

// FIFO ledger qty available to an item. A NULL warehouse falls back to the
// DEFAULT warehouse — mirroring consume_fifo's COALESCE fallback — NOT a
// cross-warehouse sum: consume_fifo only ever consumes within one warehouse.
export function ledgerQtyFor(
  item: { product_id: string; warehouse_id?: string | null },
  stock: LedgerStock
): number {
  if (item.warehouse_id) return stock.byPair[`${item.product_id}|${item.warehouse_id}`] ?? 0;
  if (stock.defaultWarehouseId) return stock.byPair[`${item.product_id}|${stock.defaultWarehouseId}`] ?? 0;
  return 0;
}

// Aggregate quantities per product+warehouse (a product can appear in
// multiple rows with different sale units) and return the rows that exceed
// the ledger. bothEmpty = ledger AND counter both at/below zero → treat as
// a data error (wrong SKU / 10x quantity typo), not a sellable shortfall.
export function computeShortfalls(items: OversellItemInput[], stock: LedgerStock): Shortfall[] {
  const agg: Record<string, {
    baseQty: number; ledgerQty: number; name: string; sku: string;
    costPrice: number; stockAvailable: number;
  }> = {};
  for (const item of items) {
    const key = item.warehouse_id ? `${item.product_id}|${item.warehouse_id}` : item.product_id;
    agg[key] = agg[key] || {
      baseQty: 0,
      ledgerQty: ledgerQtyFor(item, stock),
      name: item.name,
      sku: item.sku || '',
      costPrice: item.cost_price || 0,
      stockAvailable: item.stock_available ?? 0,
    };
    agg[key].baseQty += item.base_quantity;
  }
  return Object.values(agg)
    .map(a => {
      if (a.ledgerQty >= a.baseQty) return null;
      const shortfall = a.baseQty - Math.max(a.ledgerQty, 0);
      const bothEmpty = a.ledgerQty <= 0 && a.stockAvailable <= 0;
      return {
        name: a.name, sku: a.sku, baseQty: a.baseQty, ledgerQty: a.ledgerQty,
        shortfall, costValue: shortfall * a.costPrice, bothEmpty,
      };
    })
    .filter((s): s is Shortfall => s !== null);
}

// Description stamped on invoice_items rows sold past the ledger, so the
// IOU layer is traceable from the invoice line itself.
export function shortfallDescription(
  item: { product_id: string; warehouse_id?: string | null; base_quantity: number },
  stock: LedgerStock,
  where: string
): string | null {
  const ledgerQty = ledgerQtyFor(item, stock);
  const shortfall = item.base_quantity - Math.max(ledgerQty, 0);
  if (shortfall <= 0) return null;
  return `Ledger shortfall: sold ${item.base_quantity} against ${ledgerQty} in FIFO batches (short ${shortfall} base units) — confirmed at ${where}`;
}
