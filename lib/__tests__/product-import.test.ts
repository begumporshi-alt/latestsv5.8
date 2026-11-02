import * as XLSX from 'xlsx';
import {
  COLUMNS,
  TEMPLATE_HEADERS,
  TEMPLATE_SAMPLES,
  buildImportPlan,
  buildTemplateWorkbook,
  canonicalUnit,
  mapHeaders,
  normalizeHeader,
  parseDelimitedText,
  parseWorkbook,
  planCounts,
  splitList,
  toNumber,
  toSheetRows,
} from '../import/product-import';

const categories = [{ id: 'cat-1', name: 'Electronics' }];
const brands = [{ id: 'brand-1', name: 'TechCorp' }];
const unitTypes = [
  { unit_name: 'pcs', unit_short: 'pcs' },
  { unit_name: 'box', unit_short: 'box' },
  { unit_name: 'Meter', unit_short: 'mtr' },
];

function plan(text: string, overrides: Partial<Parameters<typeof buildImportPlan>[0]> = {}) {
  return buildImportPlan({
    table: parseDelimitedText(text),
    mode: 'simple',
    categories,
    brands,
    unitTypes,
    existing: [],
    ...overrides,
  });
}

describe('product import — header handling', () => {
  test('template headers are all readable by the parser', () => {
    // The template, the export and the importer share COLUMNS; if a label
    // stops mapping to itself the round-trip breaks silently.
    const mapping = mapHeaders(TEMPLATE_HEADERS);
    expect(mapping.unmapped).toEqual([]);
    expect(Array.from(mapping.present).sort()).toEqual(COLUMNS.map(c => c.key).sort());
  });

  test('ignores case, spaces, underscores and punctuation', () => {
    expect(normalizeHeader('Cost Price')).toBe('costprice');
    expect(normalizeHeader('cost_price')).toBe('costprice');
    expect(normalizeHeader('COST  PRICE')).toBe('costprice');
    expect(mapHeaders(['cost price']).present.has('cost_price')).toBe(true);
    expect(mapHeaders(['COST_PRICE']).present.has('cost_price')).toBe(true);
  });

  test('accepts common alternative spellings', () => {
    const mapping = mapHeaders(['Item', 'Item Code', 'UOM', 'Buy Price', 'Sell Price', 'Qty']);
    expect(Array.from(mapping.present).sort()).toEqual(
      ['cost_price', 'current_stock', 'name', 'sale_price', 'sku', 'unit'].sort()
    );
    expect(mapping.unmapped).toEqual([]);
  });

  test('reports unrecognised headers instead of silently dropping them', () => {
    const mapping = mapHeaders(['Name', 'SKU', 'Weird Column']);
    expect(mapping.unmapped).toEqual(['Weird Column']);
    expect(mapping.present.has('name')).toBe(true);
  });
});

describe('product import — parsing', () => {
  test('parses tab separated paste from Excel', () => {
    const table = parseDelimitedText('Name\tSKU\tCost Price\tCurrent Stock\nHammer\tHAM-001\t50\t100');
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]['Cost Price']).toBe(50);
    expect(table.rows[0]['Current Stock']).toBe(100);
  });

  test('parses comma separated CSV', () => {
    const table = parseDelimitedText('Name,SKU,Sale Price\nHammer,HAM-001,80');
    expect(table.rows[0]['Sale Price']).toBe(80);
  });

  test('keeps quoted fields containing the delimiter intact', () => {
    const table = parseDelimitedText('Name,SKU,Description\n"Widget, large",WID-9,"5"", 3-pack"');
    expect(table.rows[0]['Name']).toBe('Widget, large');
  });

  test('strips a UTF-8 BOM so the first header still matches', () => {
    const mapping = mapHeaders(parseDelimitedText('\uFEFFName,SKU\nA,B').headers);
    expect(mapping.present.has('name')).toBe(true);
  });

  test('empty input yields an empty table, not a crash', () => {
    expect(parseDelimitedText('   ').rows).toEqual([]);
  });
});

describe('product import — value coercion', () => {
  test('reads thousands separators and currency symbols', () => {
    expect(toNumber('1,200')).toBe(1200);
    expect(toNumber('৳ 1,200.50')).toBe(1200.5);
    expect(toNumber('1 200')).toBe(1200);
    expect(toNumber(1200)).toBe(1200);
  });

  test('blank stays undefined so it cannot overwrite a value', () => {
    expect(toNumber('')).toBeUndefined();
    expect(toNumber('   ')).toBeUndefined();
    expect(toNumber(null)).toBeUndefined();
  });

  test('junk is undefined rather than NaN or 0', () => {
    expect(toNumber('n/a')).toBeUndefined();
    expect(toNumber('12abc')).toBeUndefined();
  });

  test('splits multi-value cells on | ; and newlines only', () => {
    expect(splitList('Red | Blue;Green')).toEqual(['Red', 'Blue', 'Green']);
    expect(splitList('')).toEqual([]);
  });

  test('matches units by name or short code and keeps catalog spelling', () => {
    expect(canonicalUnit('MTR', unitTypes)).toEqual({ name: 'Meter', matched: true });
    expect(canonicalUnit('meter', unitTypes)).toEqual({ name: 'Meter', matched: true });
    expect(canonicalUnit('pallet', unitTypes)).toEqual({ name: 'pallet', matched: false });
  });
});

describe('product import — planning', () => {
  test('creates a product with only the filled columns', () => {
    const result = plan('Name,SKU,Cost Price,Current Stock\nHammer,HAM-001,50,100');
    expect(result.errors).toEqual([]);
    expect(result.products).toHaveLength(1);
    const product = result.products[0];
    expect(product.action).toBe('create');
    expect(product.fields).toMatchObject({ name: 'Hammer', sku: 'HAM-001', unit: 'pcs', base_unit: 'pcs', cost_price: 50 });
    expect(product.fields.sale_price).toBeUndefined();
    expect(product.stockTarget).toBe(100);
  });

  test('an update never zeroes fields the file did not mention', () => {
    // The old importer wrote cost_price: Number(undefined) || 0 on every
    // update, wiping prices for any column the sheet left out.
    const result = plan('SKU,Sale Price\nHAM-001,99', {
      existing: [{ id: 'p1', sku: 'HAM-001', name: 'Hammer', unit: 'pcs', base_unit: 'pcs' }],
    });
    const product = result.products[0];
    expect(product.action).toBe('update');
    expect(product.fields.sale_price).toBe(99);
    expect(product.fields).not.toHaveProperty('cost_price');
    expect(product.fields).not.toHaveProperty('unit');
    expect(product.fields).not.toHaveProperty('description');
    expect(product.fields).not.toHaveProperty('category_id');
    expect(product.fields).not.toHaveProperty('min_stock_level');
  });

  test('a blank cell in a present column is also ignored', () => {
    const result = plan('SKU,Cost Price,Sale Price\nHAM-001,,99', {
      existing: [{ id: 'p1', sku: 'HAM-001', name: 'Hammer', unit: 'pcs', base_unit: 'pcs' }],
    });
    expect(result.products[0].fields).not.toHaveProperty('cost_price');
    expect(result.products[0].fields.sale_price).toBe(99);
  });

  test('unit and base_unit always move together on update', () => {
    const result = plan('SKU,Unit\nHAM-001,MTR', {
      existing: [{ id: 'p1', sku: 'HAM-001', name: 'Hammer', unit: 'pcs', base_unit: 'pcs' }],
    });
    expect(result.products[0].fields).toMatchObject({ unit: 'Meter', base_unit: 'Meter' });
  });

  test('unit is left alone for multi-unit products, with a warning', () => {
    const result = plan('SKU,Unit,Sale Price\nHAM-001,MTR,99', {
      existing: [{ id: 'p1', sku: 'HAM-001', name: 'Hammer', unit: 'box', base_unit: 'box', enable_multi_unit: true }],
    });
    const product = result.products[0];
    expect(product.fields).not.toHaveProperty('unit');
    expect(product.fields.sale_price).toBe(99);
    expect(product.warnings.join(' ')).toMatch(/multi-unit/i);
  });

  test('a row that changes nothing is skipped, not written', () => {
    const result = plan('Name,SKU\nHammer,HAM-001', {
      existing: [{ id: 'p1', sku: 'HAM-001', name: 'Hammer', unit: 'pcs', base_unit: 'pcs' }],
    });
    expect(result.products).toHaveLength(0);
    expect(result.skipped[0].reason).toMatch(/nothing to change/i);
  });

  test('unknown category and brand are reported and left unchanged', () => {
    const result = plan('Name,SKU,Category,Brand\nHammer,HAM-001,Nope,Nada');
    const product = result.products[0];
    expect(product.fields).not.toHaveProperty('category_id');
    expect(product.fields).not.toHaveProperty('brand_id');
    expect(product.warnings.join(' ')).toMatch(/Category "Nope"/);
    expect(product.warnings.join(' ')).toMatch(/Brand "Nada"/);
  });

  test('known category and brand resolve to ids', () => {
    const result = plan('Name,SKU,Category,Brand\nHammer,HAM-001,electronics,techcorp');
    expect(result.products[0].fields).toMatchObject({ category_id: 'cat-1', brand_id: 'brand-1' });
  });

  test('multi-unit create writes a base row and a sale row', () => {
    const result = plan('Name,SKU,Unit,Cost Price,Sale Price,Multi-Unit Name,Multi-Unit Conversion,Multi-Unit Sale Price\nCable,CAB-1,coil,500,750,box,12,8000');
    const product = result.products[0];
    expect(product.units).toHaveLength(2);
    expect(product.units[0]).toMatchObject({ unit_name: 'coil', conversion_factor: 1, is_base_unit: true });
    expect(product.units[1]).toMatchObject({ unit_name: 'box', conversion_factor: 12, is_sale_unit: true, price: 8000 });
    expect(product.fields.enable_multi_unit).toBe(true);
  });

  test('multi-unit columns are ignored on update with an explanation', () => {
    const result = plan('Name,SKU,Sale Price,Multi-Unit Name,Multi-Unit Conversion\nCable,CAB-1,900,box,12', {
      existing: [{ id: 'p1', sku: 'CAB-1', name: 'Cable', unit: 'coil', base_unit: 'coil' }],
    });
    const product = result.products[0];
    expect(product.units).toHaveLength(0);
    expect(product.warnings.join(' ')).toMatch(/ignored when updating/i);
  });

  test('conversion of 1 or less is rejected with a warning', () => {
    const result = plan('Name,SKU,Multi-Unit Name,Multi-Unit Conversion\nCable,CAB-1,box,1');
    expect(result.products[0].units).toHaveLength(0);
    expect(result.products[0].warnings.join(' ')).toMatch(/greater than 1/i);
  });

  test('a price change on a multi-unit product scales larger-unit prices proportionally', () => {
    const result = plan('SKU,Sale Price,Cost Price\nCEM-001,180,120', {
      existing: [{
        id: 'p1', sku: 'CEM-001', name: 'Cement', unit: 'coil', base_unit: 'coil',
        enable_multi_unit: true, sale_price: 150, cost_price: 100,
      }],
    });
    const product = result.products[0];
    expect(product.priceScale).toEqual({
      sale: 1.2, cost: 1.2, saleNew: 180, costNew: 120,
    });
    expect(product.warnings.join(' ')).toMatch(/scale proportionally/i);
  });

  test('a sale-price-only change scales sale prices only', () => {
    const result = plan('SKU,Sale Price\nCEM-001,300', {
      existing: [{
        id: 'p1', sku: 'CEM-001', name: 'Cement', unit: 'coil', base_unit: 'coil',
        enable_multi_unit: true, sale_price: 150, cost_price: 100,
      }],
    });
    expect(result.products[0].priceScale).toEqual({ sale: 2, saleNew: 300 });
  });

  test('a price change on a plain product emits no scaling instruction', () => {
    const result = plan('SKU,Sale Price\nHAM-001,200', {
      existing: [{ id: 'p1', sku: 'HAM-001', name: 'Hammer', sale_price: 150 }],
    });
    expect(result.products[0].priceScale).toBeUndefined();
  });

  test('a price change on a multi-unit product whose old price is 0 cannot scale', () => {
    const result = plan('SKU,Sale Price\nCEM-001,180', {
      existing: [{
        id: 'p1', sku: 'CEM-001', name: 'Cement', unit: 'coil', base_unit: 'coil',
        enable_multi_unit: true, sale_price: 0, cost_price: 0,
      }],
    });
    expect(result.products[0].priceScale).toBeUndefined();
    expect(result.products[0].warnings.join(' ')).toMatch(/could not be scaled/i);
  });

  test('stock sums across variant rows', () => {
    const result = plan(
      'Name,SKU,Color,Current Stock\nT-Shirt,TS-001,Red,10\nT-Shirt,TS-001,Blue,5',
      { mode: 'variants' }
    );
    expect(result.products).toHaveLength(1);
    expect(result.products[0].stockTarget).toBe(15);
    expect(result.products[0].colors).toEqual(['Red', 'Blue']);
  });

  test('variants mode refuses a group with different SKUs instead of dropping them', () => {
    const result = plan(
      'Name,SKU,Color\nT-Shirt,TS-RED,Red\nT-Shirt,TS-BLU,Blue',
      { mode: 'variants' }
    );
    expect(result.products).toHaveLength(0);
    expect(result.skipped[0].reason).toMatch(/exactly one SKU/i);
  });

  test('the same SKU twice in one file is rejected', () => {
    const result = plan('Name,SKU\nHammer,HAM-001\nHammer,HAM-001');
    expect(result.products).toHaveLength(1);
    expect(result.skipped[0].reason).toMatch(/only once/i);
  });

  test('rows missing name or SKU are skipped with a reason', () => {
    const result = plan('Name,SKU\n,HAM-001\nHammer,');
    expect(result.products).toHaveLength(0);
    expect(result.skipped.map(s => s.reason)).toEqual([
      'SKU is missing',
      'Name is missing — required because SKU HAM-001 is new.',
    ]);
  });

  test('matching ignores SKU case and whitespace', () => {
    const result = plan('Name,SKU,Sale Price\nHammer, ham-001 ,99', {
      existing: [{ id: 'p1', sku: 'HAM-001', name: 'Hammer', unit: 'pcs', base_unit: 'pcs' }],
    });
    expect(result.products[0].action).toBe('update');
    expect(result.products[0].productId).toBe('p1');
  });

  test('duplicate SKUs in the database do not break matching', () => {
    const result = plan('SKU,Sale Price\nHAM-001,99', {
      existing: [
        { id: 'p1', sku: 'HAM-001', name: 'Hammer', unit: 'pcs', is_active: false },
        { id: 'p2', sku: 'HAM-001', name: 'Hammer', unit: 'pcs', is_active: true },
      ],
    });
    expect(result.products[0].productId).toBe('p2');
    expect(result.products[0].warnings.join(' ')).toMatch(/more than once/i);
  });

  test('a file with no recognisable columns is rejected with guidance', () => {
    const result = plan('Foo,Bar\n1,2');
    expect(result.products).toHaveLength(0);
    expect(result.errors[0]).toMatch(/Download the template/i);
  });

  test('a header-less paste is rejected instead of guessed at', () => {
    // Guessing column order silently mis-files data (Name, SKU, Cost, Sale
    // does not match the template order), so this must be an error.
    const result = buildImportPlan({
      table: parseDelimitedText('Hammer\tHAM-001\t50\t150\nSaw\tSAW-002\t60\t90'),
      mode: 'simple',
      categories,
      brands,
      unitTypes,
      existing: [],
    });
    expect(result.products).toHaveLength(0);
    expect(result.errors[0]).toMatch(/first row must contain column headers/i);
  });
});

describe('product import — template and export', () => {
  test('sample rows survive a round-trip through the sheet shape', () => {
    const sheetRows = toSheetRows(TEMPLATE_SAMPLES);
    expect(Object.keys(sheetRows[0])).toEqual(TEMPLATE_HEADERS);

    // Feed the samples straight back in: they must all be readable.
    const table = { headers: TEMPLATE_HEADERS, rows: sheetRows };
    const result = buildImportPlan({ table, mode: 'simple', categories, brands, unitTypes, existing: [] });
    expect(result.errors).toEqual([]);
    expect(result.products).toHaveLength(TEMPLATE_SAMPLES.length);
    expect(result.products[1].units).toHaveLength(2);
    expect(result.products[2].colors).toEqual(['Red', 'Blue', 'Green']);
  });

  test('the template workbook re-imports without a single error', () => {
    // Guards the whole loop: template written by XLSX.writeFile, opened by a
    // user, saved, then read back by parseWorkbook.
    const workbook = buildTemplateWorkbook();
    expect(workbook.SheetNames).toEqual(['Products', 'Column Reference']);
    const buffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

    const table = parseWorkbook(buffer);
    const result = buildImportPlan({ table, mode: 'simple', categories, brands, unitTypes, existing: [] });
    expect(result.errors).toEqual([]);
    expect(result.products).toHaveLength(TEMPLATE_SAMPLES.length);
    expect(result.products[0].fields).toMatchObject({ name: 'Widget A', sku: 'WID-001', cost_price: 100, sale_price: 150 });
    expect(result.products[1].units).toHaveLength(2);
    expect(result.products[2].colors).toEqual(['Red', 'Blue', 'Green']);
  });

  test('planCounts summarises the plan', () => {
    const result = plan(
      'Name,SKU,Sale Price\nNew,NEW-1,10\nOld,OLD-1,20',
      { existing: [{ id: 'p1', sku: 'OLD-1', name: 'Old', unit: 'pcs', base_unit: 'pcs' }] }
    );
    expect(planCounts(result)).toMatchObject({ creates: 1, updates: 1, skips: 0 });
  });
});
