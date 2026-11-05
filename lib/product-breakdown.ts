export type BreakdownDimension = 'category' | 'brand' | 'status' | 'warehouse';

export const UNASSIGNED_GROUP = '__unassigned__';

export interface BreakdownProduct {
  id: string;
  is_active: boolean;
  category_id?: string | null;
  brand_id?: string | null;
  category?: { name: string } | null;
  brand?: { name: string } | null;
  total_stock?: number;
  min_stock_level: number;
}

export interface BreakdownGroup {
  key: string;
  label: string;
  count: number;
}

export interface BreakdownSelection {
  dimension: BreakdownDimension;
  key: string;
  label: string;
}

export type WarehouseStock = Record<string, Record<string, number>>;

export const STOCK_STATUS_LABELS = {
  ok: 'In stock',
  low: 'Low stock',
  out: 'Out of stock',
  negative: 'Negative stock',
};

export function productStockStatus(product: BreakdownProduct): keyof typeof STOCK_STATUS_LABELS {
  const stock = product.total_stock || 0;
  if (stock < 0) return 'negative';
  if (stock === 0) return 'out';
  return stock <= product.min_stock_level ? 'low' : 'ok';
}

export function matchesProductGroup(
  product: BreakdownProduct,
  dimension: BreakdownDimension,
  key: string,
  stock: WarehouseStock,
): boolean {
  if (!key) return true;
  if (dimension === 'category' || dimension === 'brand') {
    return (product[`${dimension}_id`] || UNASSIGNED_GROUP) === key;
  }
  if (dimension === 'status') return productStockStatus(product) === key;
  const warehouses = stock[product.id] || {};
  return key === UNASSIGNED_GROUP
    ? !Object.values(warehouses).some(quantity => quantity > 0)
    : (warehouses[key] || 0) > 0;
}

export function buildProductBreakdown(
  products: BreakdownProduct[],
  stock: WarehouseStock,
  warehouses: { id: string; name: string }[],
  categories: { id: string; name: string }[] = [],
  brands: { id: string; name: string }[] = [],
): { total: number; groups: Record<BreakdownDimension, BreakdownGroup[]> } {
  const buckets: Record<BreakdownDimension, Map<string, BreakdownGroup>> = {
    category: new Map(), brand: new Map(), status: new Map(), warehouse: new Map(),
  };
  const warehouseNames = new Map(warehouses.map(w => [w.id, w.name]));
  const categoryNames = new Map(categories.map(c => [c.id, c.name]));
  const brandNames = new Map(brands.map(b => [b.id, b.name]));
  for (const [key, label] of Object.entries(STOCK_STATUS_LABELS)) {
    buckets.status.set(key, { key, label, count: 0 });
  }
  for (const warehouse of warehouses) {
    buckets.warehouse.set(warehouse.id, { key: warehouse.id, label: warehouse.name, count: 0 });
  }
  function increment(dimension: BreakdownDimension, key: string, label: string) {
    const group = buckets[dimension].get(key);
    if (group) group.count++;
    else buckets[dimension].set(key, { key, label, count: 1 });
  }
  let total = 0;
  for (const product of products) {
    if (!product.is_active) continue;
    total++;
    increment('category', product.category_id || UNASSIGNED_GROUP,
      product.category_id ? product.category?.name || categoryNames.get(product.category_id) || 'Unavailable category' : 'Uncategorized');
    increment('brand', product.brand_id || UNASSIGNED_GROUP,
      product.brand_id ? product.brand?.name || brandNames.get(product.brand_id) || 'Unavailable brand' : 'No brand');
    const status = productStockStatus(product);
    increment('status', status, STOCK_STATUS_LABELS[status]);
    let hasStock = false;
    for (const [warehouseId, quantity] of Object.entries(stock[product.id] || {})) {
      if (quantity <= 0) continue;
      hasStock = true;
      increment('warehouse', warehouseId, warehouseNames.get(warehouseId) || `Unavailable warehouse (${warehouseId.slice(0, 8)})`);
    }
    if (!hasStock) increment('warehouse', UNASSIGNED_GROUP, 'No positive warehouse stock');
  }
  const sort = (groups: Map<string, BreakdownGroup>) => [...groups.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
  return {
    total,
    groups: {
      category: sort(buckets.category), brand: sort(buckets.brand),
      status: [...buckets.status.values()], warehouse: sort(buckets.warehouse),
    },
  };
}
