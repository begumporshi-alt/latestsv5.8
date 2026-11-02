-- Per-product barcode/QR label: barcode symbol size + info text font sizes.
-- NULL = follow the page-level print settings / label preset.
ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode_symbol_width numeric;
ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode_symbol_height numeric;
ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode_name_font_size numeric;
ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode_sku_font_size numeric;
ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode_price_font_size numeric;

COMMENT ON COLUMN products.barcode_symbol_width IS 'Per-product barcode bar width (JsBarcode width multiplier); NULL = use preset/page default';
COMMENT ON COLUMN products.barcode_symbol_height IS 'Per-product barcode bar height in px (JsBarcode height); NULL = use preset/page default';
COMMENT ON COLUMN products.barcode_name_font_size IS 'Per-product product-name font size in px on the label; NULL = use page/preset default';
COMMENT ON COLUMN products.barcode_sku_font_size IS 'Per-product SKU font size in px on the label; NULL = use page/preset default';
COMMENT ON COLUMN products.barcode_price_font_size IS 'Per-product price font size in px on the label; NULL = use page/preset default';
