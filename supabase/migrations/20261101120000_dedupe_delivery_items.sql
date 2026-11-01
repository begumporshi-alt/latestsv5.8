-- ============================================================================
-- De-duplicate delivery challan lines
-- ============================================================================
-- The delivery form copied the linked invoice's lines into delivery_items on
-- every save, including an edit, and never removed the previous copy. Each
-- re-save therefore appended a second set of lines: DLV-661189 carries 6 rows
-- for a 3-line invoice, each product twice — one row with the unit name copied
-- from the invoice, one with a NULL unit.
--
-- The form now replaces instead of appending (lib/delivery-item-sync.ts), and
-- a challan prints from its invoice's live lines, so this only cleans up the
-- rows already on disk (the replica, the inventory "delivered" column and
-- offline reads all consume delivery_items).
--
-- Two statements, both deliberately narrow:
--   1. a row that lost its unit name while an otherwise identical row on the
--      same challan kept it — the artifact signature above.
--   2. rows that are identical in every column, keeping one.
-- A legitimate challan may list the same product twice (a line split across
-- warehouses); those rows differ by unit name, so neither statement touches
-- them.
-- ============================================================================

-- 1. Duplicate that lost its unit name
DELETE FROM delivery_items di
USING delivery_items keeper
WHERE di.delivery_id = keeper.delivery_id
  AND di.product_id = keeper.product_id
  AND di.quantity = keeper.quantity
  AND di.delivered_quantity = keeper.delivered_quantity
  AND di.unit_name IS NULL
  AND keeper.unit_name IS NOT NULL
  AND di.id <> keeper.id;

-- 2. Exact duplicates, keep one
DELETE FROM delivery_items di
USING (
  SELECT id, row_number() OVER (
           PARTITION BY delivery_id, product_id, quantity, delivered_quantity, unit_name
           ORDER BY id) AS rn
  FROM delivery_items
) dup
WHERE di.id = dup.id
  AND dup.rn > 1;
