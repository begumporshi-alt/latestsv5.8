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
