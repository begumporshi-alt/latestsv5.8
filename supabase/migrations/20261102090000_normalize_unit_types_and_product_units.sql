-- Normalise unit naming across unit_types, products and product_units.
--
-- Before this migration the catalog held 21 unit_types rows for 16 real units
-- (case duplicates plus two aliases) and products used 18 spellings for 9
-- units across unit / base_unit:
--
--   pcs 2452 | pieces 219 | PCS 205 | piece 59 | Piece 57   -> pcs
--   Meter 62 | meter 1                                     -> Meter
--   coil 21  | Coil 7                                      -> coil
--   Kilogram 4 | kg 4                                      -> Kilogram
--   foot 48 | Foot 14                                      -> foot
--   box 3, pack 2, yard 1, grams 1                         -> unchanged
--
-- 'pieces'/'piece'/'Piece' matched no unit_types row at all, so those products
-- fell through to the hard-coded decimal-unit list and the picker showed a
-- blank value for them.
--
-- Renaming in this order matters: product_units is written FIRST so
-- trg_sync_product_unit (20261102080000) can move products.unit / base_unit
-- for multi-unit products. Writing products first would let
-- trg_normalize_product_unit stamp the old base name back over the new one.
--
-- Historical rows (invoice_items, purchase_order_items, delivery_items,
-- quotation_items, online_order_items, stock_movements) keep the unit label
-- they were issued with. They are documents, not master data.

BEGIN;

-- 1. Drop the inactive duplicates. Each one shadows an active unit that
--    survives, so no product or unit row can be orphaned by the delete.
DELETE FROM unit_types WHERE unit_name IN ('bag', 'Bag', 'Coil', 'packet');

-- 'ps' is an active alias of 'pcs' (short 'pieces') with no rows on it. Guarded
-- in case another database does use it.
DELETE FROM unit_types ut
 WHERE ut.unit_name = 'ps'
   AND NOT EXISTS (SELECT 1 FROM products p      WHERE lower(trim(p.unit)) = 'ps')
   AND NOT EXISTS (SELECT 1 FROM product_units pu WHERE lower(trim(pu.unit_name)) = 'ps');

-- Safety net: any remaining inactive row that only differs by case from an
-- active one.
DELETE FROM unit_types ut
 WHERE NOT ut.is_active
   AND EXISTS (SELECT 1 FROM unit_types a WHERE a.is_active AND lower(trim(a.unit_name)) = lower(trim(ut.unit_name)));

-- 'baag' is the surviving spelling of the bag unit; align it with its short.
UPDATE unit_types
   SET unit_name = 'bag', unit_short = 'bag'
 WHERE unit_name = 'baag'
   AND NOT EXISTS (SELECT 1 FROM unit_types x WHERE lower(trim(x.unit_name)) = 'bag');

-- 2. Map every observed spelling onto the canonical unit_types name.
CREATE TEMP TABLE unit_name_map (old_name text PRIMARY KEY, new_name text NOT NULL) ON COMMIT DROP;
INSERT INTO unit_name_map (old_name, new_name) VALUES
  ('pcs', 'pcs'), ('PCS', 'pcs'), ('pieces', 'pcs'), ('piece', 'pcs'), ('Piece', 'pcs'),
  ('Meter', 'Meter'), ('meter', 'Meter'),
  ('Kilogram', 'Kilogram'), ('kg', 'Kilogram'), ('kgs', 'Kilogram'),
  ('coil', 'coil'), ('Coil', 'coil'),
  ('foot', 'foot'), ('Foot', 'foot'), ('feet', 'foot'),
  ('grams', 'grams'), ('gram', 'grams'),
  ('box', 'box'), ('pack', 'pack'), ('yard', 'yard');

-- 3. Child rows first — the sync trigger carries the base unit up to products.
UPDATE product_units pu
   SET unit_name = m.new_name
  FROM unit_name_map m
 WHERE pu.unit_name = m.old_name
   AND m.old_name <> m.new_name;

-- 4. Product row. Covers single-unit products and any product whose base row
--    was already correct but whose unit column had drifted.
UPDATE products p
   SET unit = m.new_name
  FROM unit_name_map m
 WHERE p.unit = m.old_name
   AND m.old_name <> m.new_name;

UPDATE products p
   SET base_unit = m.new_name
  FROM unit_name_map m
 WHERE p.base_unit = m.old_name
   AND m.old_name <> m.new_name;

-- 5. Make the duplicate class impossible from here on. The app checks first so
--    the user gets a readable message; this is the backstop.
CREATE UNIQUE INDEX IF NOT EXISTS unit_types_name_unique
  ON unit_types (lower(trim(unit_name)));

COMMIT;
