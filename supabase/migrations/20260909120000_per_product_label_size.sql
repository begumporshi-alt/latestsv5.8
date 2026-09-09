-- Per-product barcode/QR label size overrides.
-- NULL barcode_label_size = product follows the page-level (global) label
-- settings on the barcode print page; a preset or custom dims overrides it.

ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode_label_size text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode_label_width numeric;
ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode_label_height numeric;

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_barcode_label_size_check;
ALTER TABLE products ADD CONSTRAINT products_barcode_label_size_check
  CHECK (barcode_label_size IN ('xs', 'small', 'medium', 'large', 'xl', 'custom'));

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_barcode_label_width_check;
ALTER TABLE products ADD CONSTRAINT products_barcode_label_width_check
  CHECK (barcode_label_width IS NULL OR (barcode_label_width >= 0.5 AND barcode_label_width <= 5));

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_barcode_label_height_check;
ALTER TABLE products ADD CONSTRAINT products_barcode_label_height_check
  CHECK (barcode_label_height IS NULL OR (barcode_label_height >= 0.3 AND barcode_label_height <= 3));

COMMENT ON COLUMN products.barcode_label_size IS 'Per-product barcode/QR label size preset (xs|small|medium|large|xl|custom); NULL = use global print settings';
COMMENT ON COLUMN products.barcode_label_width IS 'Custom label width in inches, used when barcode_label_size = custom';
COMMENT ON COLUMN products.barcode_label_height IS 'Custom label height in inches, used when barcode_label_size = custom';
