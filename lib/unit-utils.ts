import type { Product, ProductUnit } from './types';

export function getBaseUnit(product: Product): ProductUnit | null {
  return product.units?.find(u => u.is_base_unit) || null;
}

export function getSaleUnit(product: Product): ProductUnit | null {
  return product.units?.find(u => u.is_sale_unit) || null;
}

export function convertToBaseUnit(quantity: number, unit: ProductUnit): number {
  return quantity * unit.conversion_factor;
}

export function convertFromBaseUnit(baseQuantity: number, unit: ProductUnit): number {
  return baseQuantity / unit.conversion_factor;
}

export function getUnitPrice(unit: ProductUnit): number {
  return unit.price;
}

export function getAvailableUnits(product: Product): ProductUnit[] {
  return product.units?.filter(u => u.is_active) || [];
}

export function calculateLineTotal(quantity: number, unit: ProductUnit): number {
  return quantity * unit.price;
}

export function formatUnitDisplay(unit: ProductUnit): string {
  return unit.unit_short ? `${unit.unit_name} (${unit.unit_short})` : unit.unit_name;
}

export function formatStockDisplay(baseQuantity: number, product: Product): string {
  const baseUnit = getBaseUnit(product);
  const saleUnit = getSaleUnit(product);

  if (!baseUnit || !saleUnit) {
    return `${baseQuantity} ${product.unit || 'pcs'}`;
  }

  if (saleUnit.id === baseUnit.id) {
    return `${baseQuantity} ${baseUnit.unit_name}`;
  }

  const saleQty = convertFromBaseUnit(baseQuantity, saleUnit);
  return `${saleQty.toFixed(2)} ${saleUnit.unit_name} (${baseQuantity} ${baseUnit.unit_name})`;
}

const DECIMAL_UNIT_NAMES = new Set([
  'meter', 'meters', 'm',
  'foot', 'feet', 'ft',
  'kg', 'kgs', 'kilogram', 'kilograms',
  'gram', 'grams', 'g',
  'liter', 'litre', 'liters', 'litres', 'l',
]);

// Client-side fallback when products.allow_decimal is not loaded.
export function unitAllowsDecimal(unit?: string | null): boolean {
  if (!unit) return false;
  return DECIMAL_UNIT_NAMES.has(unit.trim().toLowerCase());
}

export function allowDecimalFor(allowDecimal?: boolean, unit?: string | null): boolean {
  return allowDecimal ?? unitAllowsDecimal(unit);
}

// Round to 3 decimals (matches invoice_items.quantity decimal(15,3)) so
// float artifacts like 0.30000000000000004 never reach the DB.
export function clampSaleQty(qty: number, allowDecimal: boolean): number {
  if (!allowDecimal) return Math.floor(qty);
  return Math.round(qty * 1000) / 1000;
}

const UNIT_LABEL_ALIASES: Record<string, string> = {
  pieces: 'pcs', piece: 'pcs', pc: 'pcs',
  kilograms: 'kg', kgs: 'kg', kilogram: 'kg',
  meters: 'meter',
  feet: 'foot', ft: 'foot',
  grams: 'gram',
  liters: 'liter', litres: 'liter',
};

export function normalizeUnitLabel(unit?: string | null, fallback = 'pcs'): string {
  if (!unit) return fallback;
  const trimmed = unit.trim();
  if (!trimmed) return fallback;
  return UNIT_LABEL_ALIASES[trimmed.toLowerCase()] || trimmed;
}

export function isMultiUnitEnabled(product: Product): boolean {
  return product.enable_multi_unit === true && (product.units?.length || 0) > 1;
}

export function getDefaultSaleUnit(product: Product): ProductUnit {
  const saleUnit = getSaleUnit(product);
  if (saleUnit) return saleUnit;

  const baseUnit = getBaseUnit(product);
  if (baseUnit) return baseUnit;

  return {
    id: 'default',
    product_id: product.id,
    unit_name: product.unit || 'pcs',
    unit_short: product.unit || 'pcs',
    conversion_factor: 1,
    is_base_unit: true,
    is_sale_unit: true,
    price: product.sale_price,
    cost_price: product.cost_price,
    sort_order: 0,
    is_active: true,
    created_at: new Date().toISOString(),
  };
}
