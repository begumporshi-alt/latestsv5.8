// Automatic batch allocation engine shared by the POS cart preview and the
// manual-override editor. The DB trigger (consume_fifo) is the authority at
// checkout; this module mirrors its rules client-side so the cashier sees
// the exact allocation the database will deduct:
//
//   - eligible batch: quantity_remaining > 0, not expired
//     (expiry_date IS NULL OR expiry_date >= today)
//   - warehouse: the line's warehouse, or the DEFAULT warehouse when the
//     line has none — the same fallback consume_fifo uses (never a
//     cross-warehouse sum)
//   - order: fifo → created_at ASC, then id; fefo → expiry_date ASC NULLS
//     LAST, then created_at ASC, then id  (read from app_settings 'inventory')
//
// Allocation is DERIVED, never stored on cart lines: the cart keeps only
// product/qty/warehouse, and allocations are recomputed from the batch
// snapshot + current cart contents on every change. Adding the same product
// again, raising or lowering a quantity, or removing a line therefore
// re-allocates automatically (spec §5, §11). A per-line manual override
// (spec §9) is the one stored exception; it is honored only while it stays
// valid and falls back to auto-allocation the moment it isn't.

import { supabase } from '@/lib/supabase';
import { fetchAll } from '@/lib/fetch-all';

export interface AllocatableBatch {
  id: string;
  batch_number: string | null;
  product_id: string;
  warehouse_id: string;
  quantity_remaining: number;
  unit_cost: number;
  expiry_date: string | null;
  created_at: string;
}

export type AllocationStrategy = 'fifo' | 'fefo';

export interface InventorySettings {
  batch_allocation_method: AllocationStrategy;
  allow_partial_add: boolean;
}

export const DEFAULT_INVENTORY_SETTINGS: InventorySettings = {
  batch_allocation_method: 'fifo',
  allow_partial_add: true,
};

export interface AllocLineInput {
  lineId: string;
  productId: string;
  warehouseId?: string | null;
  baseQuantity: number;
  // Manual override: batchId → base-unit qty for THIS line. Honored only if
  // it exactly sums to baseQuantity and fits what earlier cart lines leave.
  allocOverride?: Record<string, number> | null;
}

export interface BatchAllocation {
  batch: AllocatableBatch;
  qty: number;
}

export interface LineAllocation {
  lineId: string;
  allocations: BatchAllocation[];
  allocatedQty: number;
  shortfall: number;
  usedOverride: boolean;
  overrideInvalid: boolean;
}

export interface AllocationResult {
  byLine: Map<string, LineAllocation>;
  // `${productId}|${warehouseId}` → eligible base-unit qty (before cart use)
  availableByPair: Map<string, number>;
  // `${productId}|${warehouseId}` → eligible batches in strategy order
  batchesByPair: Map<string, AllocatableBatch[]>;
  // `${productId}|${warehouseId}` → base units already held by cart lines
  reservedByPair: Map<string, number>;
}

const EPSILON = 1e-9;

export function todayStr(): string {
  return new Date().toISOString().split('T')[0];
}

export function isExpired(batch: Pick<AllocatableBatch, 'expiry_date'>, today = todayStr()): boolean {
  return !!batch.expiry_date && batch.expiry_date < today;
}

// Mirror of consume_fifo's ORDER BY (migration 20260906140000).
export function sortBatchesForStrategy(batches: AllocatableBatch[], strategy: AllocationStrategy): AllocatableBatch[] {
  const sorted = [...batches];
  sorted.sort((a, b) => {
    if (strategy === 'fefo') {
      // Expiry first, no-expiry last (SQL: ASC NULLS LAST)
      if (a.expiry_date && b.expiry_date && a.expiry_date !== b.expiry_date) {
        return a.expiry_date < b.expiry_date ? -1 : 1;
      }
      if (a.expiry_date && !b.expiry_date) return -1;
      if (!a.expiry_date && b.expiry_date) return 1;
    }
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return sorted;
}

export async function fetchInventorySettings(): Promise<InventorySettings> {
  const { data } = await supabase
    .from('app_settings')
    .select('setting_value')
    .eq('setting_key', 'inventory')
    .maybeSingle();
  const v = (data?.setting_value || {}) as Partial<InventorySettings>;
  return {
    batch_allocation_method: v.batch_allocation_method === 'fefo' ? 'fefo' : 'fifo',
    allow_partial_add: v.allow_partial_add !== false,
  };
}

// Eligible batches for exactly these products in ONE paginated query
// (batches per product are few, but a big cart can cross the 1000-row cap).
// Expired batches are filtered here; ordering happens per-warehouse inside
// the engine so each pair is sorted in strategy order.
export async function fetchAllocatableBatches(
  productIds: string[]
): Promise<Map<string, AllocatableBatch[]>> {
  const ids = Array.from(new Set(productIds.filter(Boolean)));
  const byProduct = new Map<string, AllocatableBatch[]>();
  if (ids.length === 0) return byProduct;

  const rows = await fetchAll<AllocatableBatch>(() =>
    supabase
      .from('inventory_batches')
      .select('id, batch_number, product_id, warehouse_id, quantity_remaining, unit_cost, expiry_date, created_at')
      .in('product_id', ids)
      .gt('quantity_remaining', 0)
      .order('created_at')
      .order('id')
  );

  const today = todayStr();
  for (const r of rows) {
    if (isExpired(r, today)) continue;
    const list = byProduct.get(r.product_id) || [];
    list.push(r);
    byProduct.set(r.product_id, list);
  }
  return byProduct;
}

export function pairKey(productId: string, warehouseId: string | null | undefined): string {
  return `${productId}|${warehouseId ?? ''}`;
}

// Resolve a line's consumption warehouse exactly like consume_fifo:
// the line's warehouse, else the default warehouse.
export function resolveWarehouse(
  line: Pick<AllocLineInput, 'warehouseId'>,
  defaultWarehouseId?: string | null
): string | null {
  return line.warehouseId || defaultWarehouseId || null;
}

// Total eligible base-unit qty for a product in one warehouse (or the
// default warehouse when warehouseId is null — never a cross-warehouse sum).
export function ledgerQtyForPair(
  productId: string,
  warehouseId: string | null | undefined,
  batchesByProduct: Map<string, AllocatableBatch[]> | null,
  defaultWarehouseId?: string | null
): number {
  if (!batchesByProduct) return 0;
  const wh = warehouseId || defaultWarehouseId || null;
  if (!wh) return 0;
  const batches = (batchesByProduct.get(productId) || []).filter(b => b.warehouse_id === wh);
  return batches.reduce((s, b) => s + b.quantity_remaining, 0);
}

// Product-level availability across ALL warehouses (product cards).
export function ledgerQtyAllWarehouses(
  productId: string,
  batchesByProduct: Map<string, AllocatableBatch[]> | null
): number {
  if (!batchesByProduct) return 0;
  const batches = batchesByProduct.get(productId) || [];
  return batches.reduce((s, b) => s + b.quantity_remaining, 0);
}

// Core engine. Lines are consumed in the order given (cart order), so with
// several lines of one product+warehouse the earliest line gets the oldest
// batch stock. When batchesByProduct is null (lookup failed) callers should
// fall back to counter-based behavior, so this returns null.
export function allocateCartLines(
  lines: AllocLineInput[],
  batchesByProduct: Map<string, AllocatableBatch[]> | null,
  strategy: AllocationStrategy,
  defaultWarehouseId?: string | null
): AllocationResult | null {
  if (!batchesByProduct) return null;

  const byLine = new Map<string, LineAllocation>();
  const availableByPair = new Map<string, number>();
  const batchesByPair = new Map<string, AllocatableBatch[]>();
  const reservedByPair = new Map<string, number>();
  // Remaining qty per batch after earlier cart lines: keyed `${pair}#${batchId}`
  const remainingByBatch = new Map<string, number>();

  // Cart reservations per pair (spec §4, §10): every line's base qty counts
  // against its pair's availability, regardless of batch snapshot state.
  for (const line of lines) {
    const wh = resolveWarehouse(line, defaultWarehouseId);
    const key = pairKey(line.productId, wh);
    reservedByPair.set(key, (reservedByPair.get(key) || 0) + Math.max(line.baseQuantity, 0));
  }

  for (const line of lines) {
    const wh = resolveWarehouse(line, defaultWarehouseId);
    const key = pairKey(line.productId, wh);
    if (batchesByPair.has(key)) continue;
    const eligible = sortBatchesForStrategy(
      // Expired batches are never allocatable (spec §2) — enforced here too,
      // not just at fetch time, so a stale snapshot can't sell expired stock.
      (batchesByProduct.get(line.productId) || []).filter(b => wh && b.warehouse_id === wh && !isExpired(b)),
      strategy
    );
    batchesByPair.set(key, eligible);
    const total = eligible.reduce((s, b) => s + b.quantity_remaining, 0);
    availableByPair.set(key, total);
    for (const b of eligible) remainingByBatch.set(`${key}#${b.id}`, b.quantity_remaining);
  }

  for (const line of lines) {
    const wh = resolveWarehouse(line, defaultWarehouseId);
    const key = pairKey(line.productId, wh);
    const eligible = batchesByPair.get(key) || [];
    const need = Math.max(line.baseQuantity, 0);

    const result: LineAllocation = {
      lineId: line.lineId,
      allocations: [],
      allocatedQty: 0,
      shortfall: need,
      usedOverride: false,
      overrideInvalid: false,
    };

    // Manual override — honored only when it exactly covers the line qty and
    // every batch still has what the override claims (earlier cart lines
    // consumed first). Invalid overrides fall back to auto-allocation.
    const override = line.allocOverride;
    if (override && Object.keys(override).length > 0) {
      const overrideSum = Object.values(override).reduce((s, q) => s + (Number(q) || 0), 0);
      let valid = Math.abs(overrideSum - need) < EPSILON;
      const picks: BatchAllocation[] = [];
      if (valid) {
        for (const [batchId, rawQty] of Object.entries(override)) {
          const qty = Number(rawQty) || 0;
          if (qty <= EPSILON) {
            if (Math.abs(qty) > EPSILON) valid = false;
            continue;
          }
          const batch = eligible.find(b => b.id === batchId);
          const batchLeft = batch ? (remainingByBatch.get(`${key}#${batchId}`) ?? batch.quantity_remaining) : 0;
          if (!batch || qty > batchLeft + EPSILON) { valid = false; break; }
          picks.push({ batch, qty });
        }
      }
      if (valid) {
        for (const p of picks) {
          result.allocations.push(p);
          result.allocatedQty += p.qty;
          remainingByBatch.set(`${key}#${p.batch.id}`, (remainingByBatch.get(`${key}#${p.batch.id}`) ?? 0) - p.qty);
        }
        result.shortfall = Math.max(0, need - result.allocatedQty);
        result.usedOverride = true;
        byLine.set(line.lineId, result);
        continue;
      }
      result.overrideInvalid = true;
    }

    // Auto-allocation: strategy order, up to what earlier lines left
    let remaining = need;
    for (const batch of eligible) {
      if (remaining <= EPSILON) break;
      const batchLeft = remainingByBatch.get(`${key}#${batch.id}`) ?? batch.quantity_remaining;
      if (batchLeft <= EPSILON) continue;
      const qty = Math.min(batchLeft, remaining);
      result.allocations.push({ batch, qty });
      remainingByBatch.set(`${key}#${batch.id}`, batchLeft - qty);
      remaining -= qty;
      result.allocatedQty += qty;
    }
    result.shortfall = Math.max(0, remaining);
    byLine.set(line.lineId, result);
  }

  return { byLine, availableByPair, batchesByPair, reservedByPair };
}

// What a NEW addition of this product may still take from this warehouse:
// eligible ledger stock minus everything the cart already holds for the pair.
export function availableForNewAdd(
  productId: string,
  warehouseId: string | null | undefined,
  result: AllocationResult | null,
  defaultWarehouseId?: string | null
): number {
  if (!result) return 0;
  const wh = warehouseId || defaultWarehouseId || null;
  const key = pairKey(productId, wh);
  return Math.max(0, (result.availableByPair.get(key) ?? 0) - (result.reservedByPair.get(key) ?? 0));
}

// Format a base-unit qty for display: up to 3 decimals, trailing zeros trimmed.
export function fmtQty(n: number): string {
  if (!isFinite(n)) return '0';
  return String(parseFloat(n.toFixed(3)));
}
