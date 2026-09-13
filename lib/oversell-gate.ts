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
import { REPLICA, replicaRows } from '@/lib/offline/replica';
import { networkMonitor, raceDeadline } from '@/lib/offline/network';

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
  // Non-stock (quick-sell) products never touch the batch ledger — they are
  // exempt from the oversell gate entirely.
  track_inventory?: boolean;
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
// Offline (or past the gate deadline) the snapshot plus the local replica's
// batch ledger is served with stale=true so callers can soften hard blocks
// into warnings — offline data is advisory. Returns null only when there is
// no data either way, so callers fail open with a notice: the gate is
// advisory and the DB allows the sale either way.
// Interactive gate lookups must never hang the checkout. When the monitor
// knows we're offline, the network is skipped entirely; when it believes we
// are online, the lookup is raced against this deadline so a dead-but-
// reported-online connection (monitor lag, captive portal) falls through to
// the offline snapshot instead of stalling the sale.
const GATE_DEADLINE_MS = 4_000;

export async function fetchLedgerStockFor(
  productIds: string[],
  defaultWarehouseId?: string | null
): Promise<LedgerStock | null> {
  const ids = Array.from(new Set(productIds.filter(Boolean)));
  const defaultWh = defaultWarehouseId ?? (await resolveDefaultWarehouseId());
  if (ids.length === 0) return { byPair: {}, defaultWarehouseId: defaultWh };

  let data: Awaited<ReturnType<typeof supabaseRaw.rpc>>['data'] = null;
  let error: unknown = null;
  let timedOut = false;
  if (networkMonitor.getState().online) {
    const raced = await raceDeadline(
      supabaseRaw
        .rpc('get_batch_stock_by_product_warehouse', { p_product_ids: ids })
        .then((r) => ({ ok: true as const, r }), (e) => ({ ok: false as const, e })),
      GATE_DEADLINE_MS
    );
    if (raced === 'timeout') {
      timedOut = true;
    } else if (!raced.ok) {
      error = raced.e;
    } else {
      data = raced.r.data;
      error = raced.r.error;
    }
  }

  if (error || !data) {
    if (timedOut || isNetworkError(error)) {
      const cached = await cacheGet<LedgerStock>(CACHE_KEYS.gateStock);
      // Offline fallback #1: the local replica's full batch ledger (refreshed
      // every 15 min while online). Without it, any product never gate-checked
      // online from this device reads "ledger 0" and false-fires the oversell
      // warning — the gate snapshot only covers products in previous carts.
      const replicaByPair = await ledgerByPairFromReplica(ids);
      // Cached pairs come from the most recent ONLINE gate check, which can be
      // newer than the last replica refresh — they win per pair.
      const byPair = { ...replicaByPair, ...(cached?.byPair ?? {}) };
      if (Object.keys(byPair).length > 0) {
        return { byPair, defaultWarehouseId: cached?.defaultWarehouseId ?? defaultWh, stale: true };
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

// Sum quantity_remaining per product|warehouse from the local replica's
// inventory_batches table, restricted to the requested products. A missing
// pair means the product genuinely has no batch rows on this device's
// snapshot — a legitimate ledger-zero.
async function ledgerByPairFromReplica(ids: string[]): Promise<Record<string, number>> {
  try {
    const idSet = new Set(ids);
    const batches = await replicaRows<any>(REPLICA['Inventory batches']);
    const byPair: Record<string, number> = {};
    for (const b of batches) {
      const pid = String(b.product_id ?? '');
      if (!idSet.has(pid)) continue;
      const key = `${pid}|${b.warehouse_id ?? null}`;
      byPair[key] = (byPair[key] ?? 0) + Number(b.quantity_remaining ?? 0);
    }
    return byPair;
  } catch {
    return {};
  }
}

async function resolveDefaultWarehouseId(): Promise<string | null> {
  if (networkMonitor.getState().online) {
    const raced = await raceDeadline(
      supabaseRaw
        .from('warehouses')
        .select('id')
        .eq('is_default', true)
        .eq('is_active', true)
        .limit(1)
        .then((r) => ({ ok: true as const, r }), (e) => ({ ok: false as const, e })),
      GATE_DEADLINE_MS
    );
    if (raced !== 'timeout' && raced.ok && !raced.r.error && raced.r.data?.length) {
      return raced.r.data[0].id;
    }
  }
  const cached = await cacheGet<Array<{ id: string; is_default: boolean; is_active: boolean }>>(CACHE_KEYS.warehouses);
  const cachedDefault = cached?.find((w) => w.is_default && w.is_active)?.id;
  if (cachedDefault) return cachedDefault;
  // Last resort: the replica's warehouses table — without a default id,
  // items with no warehouse_id read as ledger 0 and false-fire the gate.
  try {
    const warehouses = await replicaRows<any>(REPLICA['Warehouses']);
    return warehouses.find((w) => w.is_default && w.is_active)?.id ?? null;
  } catch {
    return null;
  }
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
    // Quick-sell (non-stock) items have no ledger to check — skip them so a
    // batch-less product can never fire the bothEmpty hard block.
    if (item.track_inventory === false) continue;
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
