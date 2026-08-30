-- ============================================================
-- CLEANUP: Historical Stock Double Deductions
-- Date: 2026-08-30
-- This migration removes duplicate stock movements and restores
-- stock to correct levels for invoices that were edited.
-- ============================================================

-- ============================================================
-- STEP 1: Remove duplicate stock movements
-- Keep only the EARLIEST movement per invoice+product+type
-- ============================================================

DO $$
DECLARE
  v_deleted integer := 0;
  v_record record;
BEGIN
  -- Find and delete duplicate sale movements
  FOR v_record IN
    SELECT id FROM (
      SELECT id,
        ROW_NUMBER() OVER (
          PARTITION BY reference_id, product_id, movement_type
          ORDER BY created_at ASC, id ASC
        ) as rn
      FROM stock_movements
      WHERE reference_type = 'invoice'
        AND movement_type = 'sale'
    ) t WHERE rn > 1
  LOOP
    DELETE FROM stock_movements WHERE id = v_record.id;
    v_deleted := v_deleted + 1;
  END LOOP;

  RAISE NOTICE 'Deleted % duplicate sale movements', v_deleted;
END $$;

-- ============================================================
-- STEP 2: Recalculate inventory from stock_movements
-- This ensures inventory_items.quantity_on_hand is correct
-- ============================================================

DO $$
DECLARE
  v_product record;
  v_warehouse record;
  v_calculated_qty numeric;
  v_current_qty numeric;
  v_diff numeric;
  v_updated integer := 0;
BEGIN
  -- For each product+warehouse combination
  FOR v_product IN
    SELECT DISTINCT sm.product_id, sm.warehouse_id
    FROM stock_movements sm
    WHERE sm.reference_type = 'invoice'
  LOOP
    -- Calculate expected quantity from all movements
    SELECT COALESCE(SUM(quantity), 0) INTO v_calculated_qty
    FROM stock_movements
    WHERE product_id = v_product.product_id
      AND warehouse_id = v_product.warehouse_id;

    -- Get current inventory
    SELECT quantity_on_hand INTO v_current_qty
    FROM inventory_items
    WHERE product_id = v_product.product_id
      AND warehouse_id = v_product.warehouse_id;

    IF v_current_qty IS NOT NULL THEN
      v_diff := v_calculated_qty - v_current_qty;
      
      -- Only update if there's a meaningful difference
      IF ABS(v_diff) > 0.001 THEN
        UPDATE inventory_items
        SET quantity_on_hand = v_calculated_qty,
            updated_at = now()
        WHERE product_id = v_product.product_id
          AND warehouse_id = v_product.warehouse_id;
        v_updated := v_updated + 1;
      END IF;
    END IF;
  END LOOP;

  RAISE NOTICE 'Updated % inventory records to correct levels', v_updated;
END $$;

-- ============================================================
-- STEP 3: Verify cleanup
-- ============================================================

DO $$
DECLARE
  v_movements integer;
  v_products integer;
BEGIN
  SELECT COUNT(*) INTO v_movements FROM stock_movements WHERE reference_type = 'invoice';
  SELECT COUNT(DISTINCT product_id) INTO v_products FROM stock_movements WHERE reference_type = 'invoice';
  
  RAISE NOTICE '=== CLEANUP VERIFICATION ===';
  RAISE NOTICE 'Total stock movements: %', v_movements;
  RAISE NOTICE 'Products affected: %', v_products;
  RAISE NOTICE '=== CLEANUP COMPLETE ===';
END $$;
