-- ============================================================
-- Migration: Weighted average cost update on GRN
-- Date: 2026-08-29
-- Purpose:
--   Auto-update products.cost_price using a weighted average of all open
--   inventory_batches (across all warehouses) for that product, on every
--   new batch insert (i.e. every GRN).
--
--   Formula: cost_price = SUM(unit_cost * quantity_remaining) / SUM(quantity_remaining)
--
--   Behaviour:
--     - Runs on INSERT into inventory_batches only.
--     - If total remaining qty across all batches = 0, leaves cost_price
--       unchanged (avoids divide-by-zero and meaningless 0 cost).
--     - Does NOT touch historical invoice_items.cost_price (those remain
--       at their original FIFO snapshot).
--     - Does NOT modify inventory_batches or change COGS.
--
--   Notes:
--     - Idempotent and re-runnable.
--     - The existing index inv_batches_remaining (product_id, warehouse_id,
--       quantity_remaining) already supports this aggregation efficiently.
--     - Round to 4 decimal places to avoid floating point drift in the UI.
-- ============================================================

CREATE OR REPLACE FUNCTION update_weighted_average_cost()
RETURNS TRIGGER AS $$
DECLARE
  v_total_qty    numeric(15,3) := 0;
  v_total_value  numeric(15,4) := 0;
  v_new_cost     numeric(15,2);
  v_product_id   uuid;
BEGIN
  v_product_id := NEW.product_id;

  -- Aggregate across all open batches for this product (all warehouses)
  SELECT
    COALESCE(SUM(quantity_remaining), 0),
    COALESCE(SUM(unit_cost * quantity_remaining), 0)
  INTO v_total_qty, v_total_value
  FROM inventory_batches
  WHERE product_id = v_product_id
    AND quantity_remaining > 0;

  -- Guard against zero stock to avoid divide-by-zero
  IF v_total_qty IS NULL OR v_total_qty <= 0 THEN
    RETURN NEW;
  END IF;

  v_new_cost := ROUND(v_total_value / v_total_qty, 2);

  UPDATE products
  SET cost_price = v_new_cost
  WHERE id = v_product_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_update_weighted_average_cost ON inventory_batches;
CREATE TRIGGER trg_update_weighted_average_cost
  AFTER INSERT ON inventory_batches
  FOR EACH ROW
  EXECUTE FUNCTION update_weighted_average_cost();

-- ============================================================
-- One-shot backfill: recalculate products.cost_price for all products
-- based on their current open batches. Safe to re-run.
-- ============================================================
DO $$
DECLARE
  r record;
  v_total_qty   numeric(15,3);
  v_total_value numeric(15,4);
  v_new_cost    numeric(15,2);
BEGIN
  FOR r IN SELECT id FROM products LOOP
    SELECT
      COALESCE(SUM(quantity_remaining), 0),
      COALESCE(SUM(unit_cost * quantity_remaining), 0)
    INTO v_total_qty, v_total_value
    FROM inventory_batches
    WHERE product_id = r.id
      AND quantity_remaining > 0;

    IF v_total_qty IS NOT NULL AND v_total_qty > 0 THEN
      v_new_cost := ROUND(v_total_value / v_total_qty, 2);
      UPDATE products SET cost_price = v_new_cost WHERE id = r.id;
    END IF;
  END LOOP;
END $$;
