/**
 * Optimistic local cache patches applied when a mutation is queued offline.
 *
 * The server remains the single source of truth — every patch here is undone
 * by the next online refresh. Their only job is to keep the CURRENT offline
 * session coherent: after queueing a product edit, the inventory list and the
 * POS snapshot immediately reflect it (and an offline-created product is
 * sellable at the POS).
 */

import { mutateCache } from './cache';
import { CACHE_KEYS } from './keys';

export interface OfflineProductPayload {
  id?: string;
  data: Record<string, unknown>;
  colors?: Array<Record<string, unknown>>;
  sizes?: Array<Record<string, unknown>>;
  units?: Array<Record<string, unknown>>;
  stock?: Array<{ warehouse_id: string; quantity: number; unit_cost?: number }>;
}

function stockTotals(payload: OfflineProductPayload) {
  const byWh: Record<string, number> = {};
  let total = 0;
  for (const s of payload.stock ?? []) {
    const qty = Number(s.quantity) || 0;
    byWh[s.warehouse_id] = (byWh[s.warehouse_id] ?? 0) + qty;
    total += qty;
  }
  return { byWh, total };
}

/** Patch the inventory page aggregate so the visible list reflects the queue. */
export async function patchInventoryAggregateAfterProductOp(
  op: 'product.create' | 'product.update',
  payload: OfflineProductPayload,
  productId: string,
): Promise<void> {
  await mutateCache<Record<string, unknown>>(CACHE_KEYS.inventoryPage, agg => {
    if (!agg) return null;
    const prods = [...((agg.prods as Array<Record<string, unknown>>) || [])];
    const { byWh, total } = stockTotals(payload);

    if (op === 'product.create') {
      prods.unshift({
        id: productId,
        ...payload.data,
        category: null,
        brand: null,
        product_colors: payload.colors ?? [],
        product_sizes: payload.sizes ?? [],
        total_stock: total,
        total_sold: 0,
        stock_by_warehouse: Object.entries(byWh).map(([warehouse_id, quantity]) => ({ warehouse_id, quantity })),
        created_at: new Date().toISOString(),
      });
    } else {
      const idx = prods.findIndex(p => p.id === productId);
      if (idx >= 0) {
        prods[idx] = {
          ...prods[idx],
          ...payload.data,
          total_stock: total,
          stock_by_warehouse: Object.entries(byWh).map(([warehouse_id, quantity]) => ({ warehouse_id, quantity })),
          updated_at: new Date().toISOString(),
        };
      }
    }
    return { ...agg, prods };
  });
}

/** Patch the POS product snapshot so offline sales see the change. */
export async function patchPosSnapshotAfterProductOp(
  op: 'product.create' | 'product.update',
  payload: OfflineProductPayload,
  productId: string,
): Promise<void> {
  await mutateCache<Array<Record<string, unknown>>>(CACHE_KEYS.products, list => {
    if (!list || list.length === 0) return null; // no snapshot yet — nothing to patch

    if (op === 'product.create') {
      const inventory_items = (payload.stock ?? [])
        .filter(s => Number(s.quantity) > 0)
        .map(s => ({
          id: `local-${productId}-${s.warehouse_id}`,
          warehouse_id: s.warehouse_id,
          quantity_on_hand: Number(s.quantity),
        }));
      const units = (payload.units ?? []).map((u, i) => ({
        id: `local-${productId}-unit-${i}`,
        product_id: productId,
        ...u,
      }));
      return [{ id: productId, ...payload.data, inventory_items, units }, ...list];
    }

    return list.map(p => {
      if (p.id !== productId) return p;
      const next: Record<string, unknown> = { ...p, ...payload.data };
      if (payload.stock) {
        const inv = [...((p.inventory_items as Array<Record<string, unknown>>) || [])];
        for (const s of payload.stock) {
          const i = inv.findIndex(x => x.warehouse_id === s.warehouse_id);
          if (i >= 0) {
            inv[i] = { ...inv[i], quantity_on_hand: Number(s.quantity) };
          } else if (Number(s.quantity) > 0) {
            inv.push({ id: `local-${productId}-${s.warehouse_id}`, warehouse_id: s.warehouse_id, quantity_on_hand: Number(s.quantity) });
          }
        }
        next.inventory_items = inv;
      }
      return next;
    });
  });
}
