/**
 * One contract for product spreadsheets.
 *
 * Template download, Export, Bulk Paste and file import all read from
 * COLUMNS below, so the three can never drift apart again. The previous
 * implementation had three separate ideas of what a column was called:
 * the template wrote `Cost Price`, the paste parser lower-cased it to
 * `cost price`, and the reader looked for `'Cost Price' || 'cost_price'`.
 * Nothing matched, every price silently saved as 0.
 *
 * The other rule this module enforces: an import only writes the columns
 * the file actually contains and actually fills. A blank cell means
 * "leave it alone", never "set it to zero".
 */
import * as XLSX from 'xlsx';

export type ColumnType = 'text' | 'number' | 'integer' | 'boolean';

export interface ColumnDef {
  /** Canonical key used in payloads. */
  key: string;
  /** Header written into the template and the export. */
  label: string;
  /** Extra accepted spellings, matched after normalisation. */
  aliases: string[];
  type: ColumnType;
  example: string;
  help: string;
}

/** Template/export order. */
export const COLUMNS: ColumnDef[] = [
  { key: 'name', label: 'Name', aliases: ['product name', 'product', 'item', 'item name', 'title'], type: 'text', example: 'Widget A', help: 'Product name. Required.' },
  { key: 'sku', label: 'SKU', aliases: ['code', 'product code', 'item code', 'sku code', 'product sku', 'barcode sku'], type: 'text', example: 'WID-001', help: 'Unique code. Required — this is how a row is matched to an existing product.' },
  { key: 'barcode', label: 'Barcode', aliases: ['bar code', 'ean', 'upc', 'ean13'], type: 'text', example: '8901234567890', help: 'Optional scanner code.' },
  { key: 'category', label: 'Category', aliases: ['cat', 'category name', 'product category'], type: 'text', example: 'Electronics', help: 'Must match an existing category name, otherwise it is left unchanged.' },
  { key: 'brand', label: 'Brand', aliases: ['brand name', 'make', 'manufacturer'], type: 'text', example: 'TechCorp', help: 'Must match an existing brand name.' },
  { key: 'unit', label: 'Unit', aliases: ['uom', 'unit of measure', 'base unit', 'measure', 'unit name'], type: 'text', example: 'pcs', help: 'Base unit. Matched against the unit catalog (name or short code).' },
  { key: 'cost_price', label: 'Cost Price', aliases: ['cost', 'purchase price', 'buy price', 'unit cost', 'cost rate', 'purchase cost', 'costprice'], type: 'number', example: '100', help: 'Purchase cost per base unit.' },
  { key: 'sale_price', label: 'Sale Price', aliases: ['price', 'selling price', 'sale rate', 'sell price', 'retail price'], type: 'number', example: '150', help: 'Selling price per base unit.' },
  { key: 'mrp', label: 'MRP', aliases: ['max retail price', 'list price', 'mrp price'], type: 'number', example: '', help: 'Optional maximum retail price.' },
  { key: 'tax_rate', label: 'Tax Rate', aliases: ['tax', 'vat', 'vat %', 'tax %', 'gst', 'tax rate %'], type: 'number', example: '', help: 'Percentage, e.g. 5 for 5%.' },
  { key: 'min_stock_level', label: 'Min Stock Level', aliases: ['min stock', 'minimum stock', 'reorder level', 'min qty', 'min stock qty', 'alert qty', 'low stock level'], type: 'integer', example: '10', help: 'Low-stock alert threshold.' },
  { key: 'current_stock', label: 'Current Stock', aliases: ['stock', 'qty', 'quantity', 'opening stock', 'stock qty', 'quantity on hand', 'on hand', 'opening balance'], type: 'number', example: '50', help: 'Stock to set in the default warehouse. Blank = leave stock untouched.' },
  { key: 'description', label: 'Description', aliases: ['desc', 'note', 'notes', 'details', 'remarks'], type: 'text', example: '', help: 'Free text.' },
  { key: 'color', label: 'Color', aliases: ['colour', 'color name', 'colour name', 'colors', 'colours'], type: 'text', example: '', help: 'Variant colour. Separate multiple values with | .' },
  { key: 'size', label: 'Size', aliases: ['size name', 'variant size', 'sizes'], type: 'text', example: '', help: 'Variant size. Separate multiple values with | .' },
  { key: 'multi_unit_name', label: 'Multi-Unit Name', aliases: ['secondary unit', 'alternate unit', 'multi unit', 'pack unit', 'larger unit'], type: 'text', example: 'box', help: 'Larger selling unit, e.g. box. Only used when creating a product.' },
  { key: 'multi_unit_conversion', label: 'Multi-Unit Conversion', aliases: ['conversion', 'conversion factor', 'multi unit conversion factor', 'units per box', 'qty per unit'], type: 'number', example: '12', help: 'How many base units one larger unit contains. Must be greater than 1.' },
  { key: 'multi_unit_sale_price', label: 'Multi-Unit Sale Price', aliases: ['multi unit price', 'pack price', 'box price', 'secondary unit price'], type: 'number', example: '1700', help: 'Selling price per larger unit.' },
  { key: 'warranty_months', label: 'Warranty Months', aliases: ['warranty', 'warranty (months)', 'guarantee months', 'guarantee'], type: 'integer', example: '', help: 'Warranty length in months.' },
  { key: 'track_inventory', label: 'Track Inventory', aliases: ['track stock', 'stocked', 'is stocked', 'track'], type: 'boolean', example: 'yes', help: 'yes/no. Set no for services that hold no stock.' },
];

export const COLUMN_BY_KEY: Record<string, ColumnDef> = Object.fromEntries(COLUMNS.map(c => [c.key, c]));

/** Column order written into the template and the export. */
export const TEMPLATE_HEADERS: string[] = COLUMNS.map(c => c.label);

export function normalizeHeader(header: unknown): string {
  return String(header ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const HEADER_INDEX: Map<string, string> = (() => {
  const index = new Map<string, string>();
  for (const column of COLUMNS) {
    for (const spelling of [column.key, column.label, ...column.aliases]) {
      const key = normalizeHeader(spelling);
      if (key && !index.has(key)) index.set(key, column.key);
    }
  }
  return index;
})();

export interface RawTable {
  headers: string[];
  rows: Record<string, unknown>[];
}

export interface HeaderMapping {
  /** canonical key -> the header string used in this file */
  headerByKey: Map<string, string>;
  /** canonical keys the file actually carries */
  present: Set<string>;
  /** headers we could not place */
  unmapped: string[];
}

/**
 * Resolve the file's headers to canonical keys. Normalisation ignores case,
 * spaces, punctuation and underscores, so `Cost Price`, `cost_price`,
 * `COST  PRICE` and `CostPrice` all land on `cost_price`.
 */
export function mapHeaders(headers: string[]): HeaderMapping {
  const headerByKey = new Map<string, string>();
  const present = new Set<string>();
  const unmapped: string[] = [];

  for (const header of headers) {
    if (isBlank(header)) continue;
    const key = HEADER_INDEX.get(normalizeHeader(header));
    if (!key) {
      unmapped.push(String(header));
      continue;
    }
    if (!headerByKey.has(key)) headerByKey.set(key, header);
    present.add(key);
  }

  return { headerByKey, present, unmapped };
}

export function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  return false;
}

/**
 * Parse a number the way a human types one: `1,200`, `৳ 1,200.50`, `1 200`.
 * The old `Number(x) || 0` turned every thousands-separated value into 0.
 */
export function toNumber(value: unknown): number | undefined {
  if (isBlank(value)) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const cleaned = String(value).trim().replace(/[৳$€£₹,\s]/g, '');
  if (!cleaned || !/^-?\d+(\.\d+)?$/.test(cleaned)) return undefined;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function toBool(value: unknown): boolean | undefined {
  if (isBlank(value)) return undefined;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'active', 'enabled', 'on'].includes(text)) return true;
  if (['false', '0', 'no', 'n', 'inactive', 'disabled', 'off'].includes(text)) return false;
  return undefined;
}

/** Split a multi-value cell (`Red | Blue`, `S;M`) into trimmed values. */
export function splitList(value: unknown): string[] {
  if (isBlank(value)) return [];
  return String(value)
    .split(/[|;\n]/)
    .map(part => part.trim())
    .filter(Boolean);
}

export interface UnitTypeRef {
  unit_name: string;
  unit_short?: string | null;
}

/** Match a spreadsheet unit to the catalog and return the catalog spelling. */
export function canonicalUnit(raw: unknown, unitTypes: UnitTypeRef[]): { name: string; matched: boolean } {
  const name = String(raw ?? '').trim();
  if (!name) return { name: '', matched: false };
  const lower = name.toLowerCase();
  const byName = unitTypes.find(u => String(u.unit_name || '').toLowerCase() === lower);
  if (byName) return { name: byName.unit_name, matched: true };
  const byShort = unitTypes.find(u => String(u.unit_short || '').toLowerCase() === lower);
  if (byShort) return { name: byShort.unit_name, matched: true };
  return { name, matched: false };
}

// ---------------------------------------------------------------- parsing

function sheetToTable(sheet: XLSX.WorkSheet | undefined): RawTable {
  if (!sheet) return { headers: [], rows: [] };
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: true });
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { headers, rows };
}

/**
 * Parse pasted text. SheetJS handles comma AND tab separated input, quoted
 * fields (`"Widget, large"`) and BOMs, which the old `split(',')` did not —
 * pasting from Excel produced zero usable rows.
 */
export function parseDelimitedText(text: string): RawTable {
  const clean = String(text ?? '').replace(/^\uFEFF/, '');
  if (!clean.trim()) return { headers: [], rows: [] };
  const workbook = XLSX.read(clean, { type: 'string', raw: false });
  return sheetToTable(workbook.Sheets[workbook.SheetNames[0]]);
}

export function parseWorkbook(data: ArrayBuffer): RawTable {
  const workbook = XLSX.read(data, { type: 'array' });
  return sheetToTable(workbook.Sheets[workbook.SheetNames[0]]);
}

// ---------------------------------------------------------------- planning

export type ImportMode = 'simple' | 'variants';

export interface ExistingProduct {
  id: string;
  sku: string;
  name: string;
  unit?: string | null;
  base_unit?: string | null;
  enable_multi_unit?: boolean | null;
  is_active?: boolean | null;
  /** Current base-unit prices — used to scale multi-unit rows proportionally. */
  sale_price?: number | null;
  cost_price?: number | null;
}

/**
 * Price change applied to a multi-unit product's unit rows. The base row is
 * set to the imported prices exactly; every larger unit (box, carton…) scales
 * by the same ratio so its price derives from the new base price. The unit
 * rows themselves are fetched at preview/write time — this is the instruction.
 */
export interface PriceScale {
  /** new/old ratio for the base sale price; undefined = sale price untouched */
  sale?: number;
  cost?: number;
  /** absolute new base-unit prices for the base unit row */
  saleNew?: number;
  costNew?: number;
}

export interface PlannedUnit {
  unit_name: string;
  conversion_factor: number;
  is_base_unit: boolean;
  is_sale_unit: boolean;
  price: number;
  cost_price: number;
}

export interface PlannedProduct {
  action: 'create' | 'update';
  /** 1-based data row numbers (header excluded) that fed this product. */
  rowNumbers: number[];
  sku: string;
  name: string;
  productId?: string;
  /** products columns to write — only columns the file carried and filled. */
  fields: Record<string, unknown>;
  /** Absolute stock target for the default warehouse; undefined = untouched. */
  stockTarget?: number;
  colors: string[];
  sizes: string[];
  units: PlannedUnit[];
  /** Present when a price import on a multi-unit product must rescale unit rows. */
  priceScale?: PriceScale;
  warnings: string[];
}

export interface SkippedRow {
  rowNumber: number;
  sku: string;
  name: string;
  reason: string;
}

export interface ImportPlan {
  products: PlannedProduct[];
  skipped: SkippedRow[];
  /** File-level problems that block the whole import. */
  errors: string[];
  mapping: HeaderMapping;
  totalRows: number;
}

export interface PlanInput {
  table: RawTable;
  mode: ImportMode;
  categories: { id: string; name: string }[];
  brands: { id: string; name: string }[];
  unitTypes: UnitTypeRef[];
  existing: ExistingProduct[];
}

interface RowValues {
  rowNumber: number;
  name?: string;
  sku?: string;
  barcode?: string;
  category?: string;
  brand?: string;
  unit?: string;
  cost_price?: number;
  sale_price?: number;
  mrp?: number;
  tax_rate?: number;
  min_stock_level?: number;
  current_stock?: number;
  description?: string;
  colors: string[];
  sizes: string[];
  multi_unit_name?: string;
  multi_unit_conversion?: number;
  multi_unit_sale_price?: number;
  warranty_months?: number;
  track_inventory?: boolean;
}

function readValues(
  raw: Record<string, unknown>,
  mapping: HeaderMapping,
  rowNumber: number
): RowValues {
  const cell = (key: string): unknown => {
    const header = mapping.headerByKey.get(key);
    return header === undefined ? undefined : raw[header];
  };
  const text = (key: string): string | undefined => {
    const value = cell(key);
    return isBlank(value) ? undefined : String(value).trim();
  };

  return {
    rowNumber,
    name: text('name'),
    sku: text('sku'),
    barcode: text('barcode'),
    category: text('category'),
    brand: text('brand'),
    unit: text('unit'),
    cost_price: toNumber(cell('cost_price')),
    sale_price: toNumber(cell('sale_price')),
    mrp: toNumber(cell('mrp')),
    tax_rate: toNumber(cell('tax_rate')),
    min_stock_level: toNumber(cell('min_stock_level')),
    current_stock: toNumber(cell('current_stock')),
    description: text('description'),
    colors: splitList(cell('color')),
    sizes: splitList(cell('size')),
    multi_unit_name: text('multi_unit_name'),
    multi_unit_conversion: toNumber(cell('multi_unit_conversion')),
    multi_unit_sale_price: toNumber(cell('multi_unit_sale_price')),
    warranty_months: toNumber(cell('warranty_months')),
    track_inventory: toBool(cell('track_inventory')),
  };
}

function pushUnique(target: string[], values: string[]) {
  for (const value of values) {
    if (!target.some(existing => existing.toLowerCase() === value.toLowerCase())) target.push(value);
  }
}

/**
 * Turn raw rows into a reviewable plan: what will be created, what will be
 * updated, what will be skipped and why. Nothing is written here.
 */
export function buildImportPlan(input: PlanInput): ImportPlan {
  const { mode, categories, brands, unitTypes, existing } = input;
  const mapping = mapHeaders(input.table.headers);
  const rows = input.table.rows;

  const errors: string[] = [];
  const skipped: SkippedRow[] = [];
  const products: PlannedProduct[] = [];

  if (rows.length === 0) {
    errors.push('No data rows found. The first row must be a header row.');
    return { products, skipped, errors, mapping, totalRows: 0 };
  }
  if (mapping.present.size === 0) {
    const found = input.table.headers.filter(h => !isBlank(h)).join(', ');
    errors.push(
      `None of the columns were recognised${found ? ` (found: ${found})` : ''}. ` +
      'The first row must contain column headers — download the template to see the expected names.'
    );
    return { products, skipped, errors, mapping, totalRows: rows.length };
  }
  if (!mapping.present.has('name') && !mapping.present.has('sku')) {
    errors.push('The file has no Name or SKU column, so rows cannot be identified.');
    return { products, skipped, errors, mapping, totalRows: rows.length };
  }

  // sku (upper-cased) -> existing product. Duplicated SKUs in the database
  // used to make `.single()` throw; keep the first active match and move on.
  const existingBySku = new Map<string, ExistingProduct>();
  const duplicatedSkus = new Set<string>();
  for (const product of existing) {
    const key = String(product.sku || '').trim().toUpperCase();
    if (!key) continue;
    const current = existingBySku.get(key);
    if (!current) {
      existingBySku.set(key, product);
    } else if (current.is_active === false && product.is_active !== false) {
      existingBySku.set(key, product);
      duplicatedSkus.add(key);
    } else {
      duplicatedSkus.add(key);
    }
  }

  const categoryByName = new Map(categories.map(c => [c.name.trim().toLowerCase(), c]));
  const brandByName = new Map(brands.map(b => [b.name.trim().toLowerCase(), b]));

  const groups = new Map<string, RowValues[]>();
  const order: string[] = [];

  rows.forEach((raw, index) => {
    const rowNumber = index + 1;
    const values = readValues(raw, mapping, rowNumber);

    if (!values.name && !values.sku) {
      skipped.push({ rowNumber, sku: '', name: '', reason: 'Row is empty' });
      return;
    }
    if (!values.sku) {
      skipped.push({ rowNumber, sku: '', name: values.name || '', reason: 'SKU is missing' });
      return;
    }
    // Name is optional on update: a SKU alone is enough to say "change this
    // product". It is only required when the row has to create something.

    const groupKey = mode === 'variants' && values.name
      ? `name:${values.name.trim().toLowerCase()}`
      : `row:${rowNumber}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
      order.push(groupKey);
    }
    groups.get(groupKey)!.push(values);
  });

  const seenSkus = new Map<string, number>();

  for (const groupKey of order) {
    const rows = groups.get(groupKey)!;
    const first = rows[0];
    const rowNumbers = rows.map(r => r.rowNumber);
    const warnings: string[] = [];
    const name = rows.map(r => r.name).find(v => !!v)?.trim();

    const distinctSkus = Array.from(new Set(rows.map(r => r.sku!.trim().toUpperCase())));
    if (distinctSkus.length > 1) {
      skipped.push({
        rowNumber: first.rowNumber,
        sku: distinctSkus.join(', '),
        name: name || '',
        reason:
          `Rows ${rowNumbers.join(', ')} share the name "${name}" but carry ${distinctSkus.length} different SKUs ` +
          `(${distinctSkus.join(', ')}). A product has exactly one SKU — put all colours/sizes on rows that share one SKU, ` +
          'or switch to Simple mode to import them as separate products.',
      });
      continue;
    }

    const sku = first.sku!.trim();
    const skuKey = sku.toUpperCase();

    if (seenSkus.has(skuKey)) {
      skipped.push({
        rowNumber: first.rowNumber,
        sku,
        name: name || '',
        reason: `SKU ${sku} also appears on row ${seenSkus.get(skuKey)}. Each SKU may appear only once.`,
      });
      continue;
    }
    seenSkus.set(skuKey, first.rowNumber);

    const target = existingBySku.get(skuKey);
    const isCreate = !target;

    if (isCreate && !name) {
      skipped.push({
        rowNumber: first.rowNumber,
        sku,
        name: '',
        reason: `Name is missing — required because SKU ${sku} is new.`,
      });
      continue;
    }

    if (duplicatedSkus.has(skuKey)) {
      warnings.push(`SKU ${sku} exists more than once in the database — the active product was updated.`);
    }

    // Unit: first row that names one wins.
    const rawUnit = rows.map(r => r.unit).find(v => !!v);
    const unitMatch = canonicalUnit(rawUnit, unitTypes);
    const unitName = unitMatch.name || 'pcs';
    if (rawUnit && !unitMatch.matched) {
      warnings.push(`Unit "${rawUnit}" is not in the unit catalog — saved as typed. Add it in Manage → Units.`);
    }

    const fields: Record<string, unknown> = {};

    if (isCreate) {
      fields.name = name;
      fields.sku = sku;
      fields.unit = unitName;
      fields.base_unit = unitName;
      fields.is_active = true;
    } else {
      if (name) fields.name = name;
      // `unit` and `base_unit` must move together, or the normaliser trigger
      // copies the old base back over the new unit.
      if (rawUnit && target!.enable_multi_unit) {
        warnings.push('Unit is managed by this product\'s multi-unit setup — the Unit column was ignored.');
      } else if (rawUnit) {
        fields.unit = unitName;
        fields.base_unit = unitName;
      }
    }

    if (first.barcode !== undefined) fields.barcode = first.barcode;
    if (first.description !== undefined) fields.description = first.description;

    if (first.cost_price !== undefined) fields.cost_price = first.cost_price;
    if (first.sale_price !== undefined) fields.sale_price = first.sale_price;

    // POS charges a multi-unit product's sale-unit row price (product_units),
    // so a price import that left unit rows alone would never reach the
    // counter. Larger units scale by the same ratio; the base row is set to
    // the imported price exactly.
    let priceScale: PriceScale | undefined;
    if (!isCreate && target!.enable_multi_unit) {
      const oldSale = Number(target!.sale_price) || 0;
      const oldCost = Number(target!.cost_price) || 0;
      const saleRatio = fields.sale_price !== undefined && oldSale > 0
        ? (fields.sale_price as number) / oldSale
        : undefined;
      const costRatio = fields.cost_price !== undefined && oldCost > 0
        ? (fields.cost_price as number) / oldCost
        : undefined;
      const oldPriceZero =
        (fields.sale_price !== undefined && oldSale <= 0) ||
        (fields.cost_price !== undefined && oldCost <= 0);
      if (saleRatio !== undefined || costRatio !== undefined) {
        priceScale = {
          sale: saleRatio,
          cost: costRatio,
          saleNew: fields.sale_price as number | undefined,
          costNew: fields.cost_price as number | undefined,
        };
        warnings.push('Larger-unit prices (box, carton…) scale proportionally with the base price change.');
      } else if (oldPriceZero) {
        warnings.push('Previous base price is 0, so larger-unit prices could not be scaled — adjust them in the product editor.');
      }
    }

    if (first.mrp !== undefined) fields.mrp = first.mrp;
    if (first.tax_rate !== undefined) fields.tax_rate = first.tax_rate;
    if (first.min_stock_level !== undefined) fields.min_stock_level = Math.round(first.min_stock_level);
    if (first.warranty_months !== undefined) fields.warranty_months = Math.round(first.warranty_months);
    if (first.track_inventory !== undefined) fields.track_inventory = first.track_inventory;

    if (first.category !== undefined) {
      const match = categoryByName.get(first.category.toLowerCase());
      if (match) fields.category_id = match.id;
      else warnings.push(`Category "${first.category}" does not exist — left unchanged.`);
    }
    if (first.brand !== undefined) {
      const match = brandByName.get(first.brand.toLowerCase());
      if (match) fields.brand_id = match.id;
      else warnings.push(`Brand "${first.brand}" does not exist — left unchanged.`);
    }

    // Variants: union across the group's rows.
    const colors: string[] = [];
    const sizes: string[] = [];
    rows.forEach(r => {
      pushUnique(colors, r.colors);
      pushUnique(sizes, r.sizes);
    });
    if (isCreate) {
      if (colors.length > 0) fields.enable_colors = true;
      if (sizes.length > 0) fields.enable_sizes = true;
    }

    // Multi-unit: create only. Rewriting a conversion factor on an existing
    // product would retroactively change the meaning of every past FIFO layer.
    const units: PlannedUnit[] = [];
    const multiNameRaw = rows.map(r => r.multi_unit_name).find(v => !!v);
    if (multiNameRaw) {
      const multi = canonicalUnit(multiNameRaw, unitTypes);
      const conversion = rows.map(r => r.multi_unit_conversion).find(v => v !== undefined);
      const salePrice = rows.map(r => r.multi_unit_sale_price).find(v => v !== undefined);
      if (isCreate) {
        if (multi.name.toLowerCase() === unitName.toLowerCase()) {
          warnings.push(`Multi-unit "${multi.name}" is the same as the base unit — ignored.`);
        } else if (!conversion || conversion <= 1) {
          warnings.push(`Multi-unit "${multi.name}" needs a conversion greater than 1 — ignored.`);
        } else {
          const baseSale = first.sale_price ?? 0;
          const baseCost = first.cost_price ?? 0;
          units.push({
            unit_name: unitName,
            conversion_factor: 1,
            is_base_unit: true,
            is_sale_unit: false,
            price: baseSale,
            cost_price: baseCost,
          });
          units.push({
            unit_name: multi.name,
            conversion_factor: conversion,
            is_base_unit: false,
            is_sale_unit: true,
            price: salePrice ?? baseSale * conversion,
            cost_price: baseCost * conversion,
          });
          fields.enable_multi_unit = true;
        }
      } else {
        warnings.push('Multi-unit columns are ignored when updating an existing product — edit the product to change its units.');
      }
    }

    // Stock: sum across the group, but only if the column carried a number.
    const stockValues = rows.map(r => r.current_stock).filter((v): v is number => v !== undefined);
    const stockTarget = stockValues.length > 0 ? stockValues.reduce((a, b) => a + b, 0) : undefined;

    if (!isCreate) {
      // A row is only worth writing if something actually differs. Fields we
      // do not hold a copy of (prices, description…) always count as a change.
      const changed = Object.entries(fields).some(([key, value]) => {
        if (key === 'sku') return false;
        if (key === 'name') return String(value).trim() !== String(target!.name || '').trim();
        if (key === 'unit') return String(value) !== String(target!.unit || '');
        if (key === 'base_unit') return String(value) !== String(target!.base_unit || target!.unit || '');
        return true;
      });
      if (!changed && stockTarget === undefined && colors.length === 0 && sizes.length === 0) {
        skipped.push({
          rowNumber: first.rowNumber,
          sku,
          name: name || '',
          reason: warnings.length > 0
            ? warnings.join(' ')
            : 'Nothing to change — this SKU already exists and every other column is blank or identical.',
        });
        continue;
      }
    }

    products.push({
      action: isCreate ? 'create' : 'update',
      rowNumbers,
      sku,
      name: name || '',
      productId: target?.id,
      fields,
      stockTarget,
      colors,
      sizes,
      units,
      priceScale,
      warnings,
    });
  }

  return { products, skipped, errors, mapping, totalRows: rows.length };
}

export function planCounts(plan: ImportPlan) {
  return {
    creates: plan.products.filter(p => p.action === 'create').length,
    updates: plan.products.filter(p => p.action === 'update').length,
    skips: plan.skipped.length,
    stockRows: plan.products.filter(p => p.stockTarget !== undefined).length,
    warnings: plan.products.reduce((n, p) => n + p.warnings.length, 0),
  };
}

// ---------------------------------------------------------------- output

/** Re-key records from canonical keys to template headers, in COLUMNS order. */
export function toSheetRows(records: Record<string, unknown>[]): Record<string, unknown>[] {
  return records.map(record => {
    const row: Record<string, unknown> = {};
    for (const column of COLUMNS) {
      const value = record[column.key];
      row[column.label] = value === undefined || value === null ? '' : value;
    }
    return row;
  });
}

/** Payload keys that have no spreadsheet column of their own. */
const EXTRA_FIELD_LABELS: Record<string, string> = {
  category_id: 'Category',
  brand_id: 'Brand',
  base_unit: 'Unit',
  is_active: 'Active',
  enable_colors: 'Colours',
  enable_sizes: 'Sizes',
  enable_multi_unit: 'Multi-unit',
};

/** Human label for a `products` column, for the preview's "will write" list. */
export function fieldLabel(key: string): string {
  return COLUMN_BY_KEY[key]?.label || EXTRA_FIELD_LABELS[key] || key;
}

/** The example rows shipped with the template — one per common scenario. */
export const TEMPLATE_SAMPLES: Record<string, unknown>[] = [
  {
    name: 'Widget A', sku: 'WID-001', barcode: '8901234567890', category: 'Electronics', brand: 'TechCorp',
    unit: 'pcs', cost_price: 100, sale_price: 150, min_stock_level: 10, current_stock: 50,
    description: 'Simple product — one row, one product',
  },
  {
    name: 'Cable 3mm', sku: 'CAB-010', category: 'Electrical', brand: 'PowerCo',
    unit: 'coil', cost_price: 500, sale_price: 750, min_stock_level: 5, current_stock: 20,
    multi_unit_name: 'box', multi_unit_conversion: 12, multi_unit_sale_price: 8000,
    description: 'Multi-unit — 1 box = 12 coils',
  },
  {
    name: 'T-Shirt', sku: 'TS-001', category: 'Apparel', unit: 'pcs',
    cost_price: 250, sale_price: 450, current_stock: 15, color: 'Red | Blue | Green', size: 'S | M | L',
    description: 'Variants — one SKU, colours and sizes separated by |',
  },
];

/** Build the template workbook: data sheet plus a column reference sheet. */
export function buildTemplateWorkbook(): XLSX.WorkBook {
  const workbook = XLSX.utils.book_new();

  const dataSheet = XLSX.utils.json_to_sheet(toSheetRows(TEMPLATE_SAMPLES), { header: TEMPLATE_HEADERS });
  dataSheet['!cols'] = TEMPLATE_HEADERS.map(label => ({ wch: Math.max(14, label.length + 2) }));
  XLSX.utils.book_append_sheet(workbook, dataSheet, 'Products');

  const reference = XLSX.utils.aoa_to_sheet([
    ['Column', 'Required', 'Type', 'What it does'],
    ...COLUMNS.map(column => [
      column.label,
      column.key === 'name' || column.key === 'sku' ? 'Yes' : 'No',
      column.type,
      column.help,
    ]),
  ]);
  reference['!cols'] = [{ wch: 26 }, { wch: 10 }, { wch: 10 }, { wch: 80 }];
  XLSX.utils.book_append_sheet(workbook, reference, 'Column Reference');

  return workbook;
}

export function downloadTemplateWorkbook(filename = 'product-import-template.xlsx') {
  XLSX.writeFile(buildTemplateWorkbook(), filename);
}
