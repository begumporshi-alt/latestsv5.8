-- Normalize unit labels across the cable product family.
--
-- User-confirmed convention for cable products: BASE unit = Meter, SALE
-- unit = coil (1 coil = 100 meters). 'pcs'/'pieces' is never a valid unit
-- for cables.
--
-- Current state: all cable product masters are already correct
-- (unit/base_unit = Meter, per-meter cost_price) and all have Meter+coil
-- rows in product_units (coil conversion 100, sale unit). But historical
-- sale records carry inconsistent labels — 'pcs' (21 rows), 'Coil' (26),
-- blank invoice-item unit names (17) — because the product master's unit
-- was flipped over time.
--
-- A line is coil-priced when its cost is ~100x the product's per-meter
-- cost (coil costs 3,198-30,000+ vs meter costs 25-365; price alone can't
-- separate them since thick-cable meter lines reach 29,540). The ratio
-- test (cost >= 50x per-meter cost) classifies reliably; lines already
-- labeled 'Meter'/'meter' are never touched.
--
-- Amounts and quantities are NOT changed — labels only.

-- Cable family: products with an active 'coil' unit of conversion 100
-- (25 SKUs — the walton 1*x RM/re cables + CAT6; excludes strip lights,
-- which may use different roll sizes and are left untouched)

-- 1. Cost price history: 'pcs'/'Coil' rows that are coil-priced -> 'coil'
UPDATE cost_price_history h
SET unit = 'coil'
FROM products p
JOIN product_units pu ON pu.product_id = p.id
  AND pu.unit_name ILIKE 'coil' AND pu.conversion_factor = 100 AND pu.is_active
WHERE h.product_id = p.id
  AND h.unit IN ('pcs', 'Coil')
  AND p.cost_price > 0
  AND h.cost_price_per_qty >= 50 * p.cost_price;

-- 2. Invoice items: blank/'Coil'/'pcs' unit names on coil-priced lines -> 'coil'
UPDATE invoice_items ii
SET unit_name = 'coil'
FROM products p
JOIN product_units pu ON pu.product_id = p.id
  AND pu.unit_name ILIKE 'coil' AND pu.conversion_factor = 100 AND pu.is_active
WHERE ii.product_id = p.id
  AND (ii.unit_name IS NULL OR ii.unit_name IN ('', 'Coil', 'pcs'))
  AND p.cost_price > 0
  AND ii.cost_price >= 50 * p.cost_price;

-- 3. Blank unit names on METER-priced lines -> 'Meter'
UPDATE invoice_items ii
SET unit_name = 'Meter'
FROM products p
JOIN product_units pu ON pu.product_id = p.id
  AND pu.unit_name ILIKE 'coil' AND pu.conversion_factor = 100 AND pu.is_active
WHERE ii.product_id = p.id
  AND (ii.unit_name IS NULL OR ii.unit_name = '')
  AND p.cost_price > 0
  AND ii.cost_price < 2 * p.cost_price;

-- 4. Hand-verified corrections where the current-cost ratio test is
--    inconclusive because the product's cost changed since the sale:
--    * 1*7.0 RM-BLU 'Coil' row is a genuine coil sale (cost 14,651 =
--      100 x sale-time meter cost 146.51; current cost 362.99) — casing
UPDATE cost_price_history SET unit = 'coil'
WHERE product_sku = '1*7.0 RM-BLU' AND unit = 'Coil';

--    * 1*3.0 RM-BLK 'pcs' rows are meter sales (cost 65.78/m) mislabeled
UPDATE cost_price_history SET unit = 'Meter'
WHERE product_sku = '1*3.0 RM-BLK' AND unit = 'pcs';
