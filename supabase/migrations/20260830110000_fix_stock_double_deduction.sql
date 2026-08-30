-- ============================================================
-- FIX: Stock Double Deduction on Invoice Edit
-- Date: 2026-08-30
-- Issue: trg_deduct_stock_on_invoice_item fires on EVERY INSERT
--        with no idempotency guard. When invoice items are deleted
--        and re-inserted during edit, stock is deducted multiple times.
--        No reversal (return_in) is recorded on DELETE.
--
-- Fix:
--   1. Add idempotency guard to deduct_stock_on_invoice_item
--   2. Create restore_stock_on_invoice_item_delete for DELETE events
--   3. Create trigger for DELETE events
-- ============================================================

-- ============================================================
-- STEP 1: Fix deduct_stock_on_invoice_item (ADD IDEMPOTENCY GUARD)
-- ============================================================

CREATE OR REPLACE FUNCTION deduct_stock_on_invoice_item()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_invoice_record RECORD;
  v_target_wh uuid;
  v_qty_to_deduct numeric;
  v_inv_id uuid;
  v_current_qty numeric;
  v_product_cost numeric;
BEGIN
  -- Get the invoice record
  SELECT * INTO v_invoice_record FROM invoices WHERE id = NEW.invoice_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- Skip if invoice is cancelled
  IF v_invoice_record.status = 'cancelled' THEN
    RETURN NEW;
  END IF;

  -- ============================================================
  -- IDEMPOTENCY GUARD: Check if stock was already deducted
  -- for this specific invoice_item_id
  -- ============================================================
  IF EXISTS (
    SELECT 1 FROM stock_movements
    WHERE reference_id = NEW.invoice_id
      AND reference_type = 'invoice'
      AND product_id = NEW.product_id
      AND movement_type = 'sale'
      AND notes LIKE '%invoice_item:' || NEW.id::text || '%'
  ) THEN
    -- Stock already deducted for this item, skip
    RETURN NEW;
  END IF;

  -- Determine quantity to deduct (use base_quantity if available, else quantity)
  v_qty_to_deduct := COALESCE(NEW.base_quantity, NEW.quantity);

  -- Use the warehouse_id from the invoice item if provided; otherwise fall back to default warehouse
  v_target_wh := NEW.warehouse_id;

  IF v_target_wh IS NULL THEN
    SELECT id INTO v_target_wh FROM warehouses WHERE is_default = true AND is_active = true LIMIT 1;
    IF v_target_wh IS NULL THEN
      SELECT id INTO v_target_wh FROM warehouses WHERE is_active = true LIMIT 1;
    END IF;
  END IF;

  IF v_target_wh IS NULL THEN
    RETURN NEW;
  END IF;

  -- Get current inventory in the target warehouse
  SELECT id, quantity_on_hand INTO v_inv_id, v_current_qty
  FROM inventory_items
  WHERE product_id = NEW.product_id AND warehouse_id = v_target_wh
  FOR UPDATE;

  IF v_inv_id IS NOT NULL THEN
    -- Update existing inventory
    UPDATE inventory_items
    SET quantity_on_hand = quantity_on_hand - v_qty_to_deduct,
        updated_at = now()
    WHERE id = v_inv_id;
  ELSE
    -- Create inventory record with negative stock (product was sold without prior stock in this warehouse)
    INSERT INTO inventory_items (product_id, warehouse_id, quantity_on_hand, quantity_reserved, quantity_incoming)
    VALUES (NEW.product_id, v_target_wh, -v_qty_to_deduct, 0, 0);
  END IF;

  -- Get product cost for the stock movement
  SELECT cost_price INTO v_product_cost FROM products WHERE id = NEW.product_id;

  -- Record the stock movement in the correct warehouse
  -- Include invoice_item_id in notes for idempotency check
  INSERT INTO stock_movements (
    product_id, warehouse_id, movement_type, quantity,
    unit_cost, reference_type, reference_id, reference_number, notes
  )
  VALUES (
    NEW.product_id, v_target_wh, 'sale', -v_qty_to_deduct,
    COALESCE(v_product_cost, 0), 'invoice', NEW.invoice_id,
    v_invoice_record.invoice_number,
    'Stock deduction for sale - invoice_item:' || NEW.id::text
  );

  RETURN NEW;
END;
$function$;

-- ============================================================
-- STEP 2: Create restore function for DELETE events
-- ============================================================

CREATE OR REPLACE FUNCTION restore_stock_on_invoice_item_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_invoice_record RECORD;
  v_target_wh uuid;
  v_qty_to_restore numeric;
  v_inv_id uuid;
  v_product_cost numeric;
  v_existing_movement RECORD;
BEGIN
  -- Get the invoice record
  SELECT * INTO v_invoice_record FROM invoices WHERE id = OLD.invoice_id;
  IF NOT FOUND THEN
    RETURN OLD;
  END IF;

  -- Skip if invoice is cancelled (cancel_invoice handles its own restoration)
  IF v_invoice_record.status = 'cancelled' THEN
    RETURN OLD;
  END IF;

  -- Find the original sale movement for this specific invoice_item
  SELECT * INTO v_existing_movement
  FROM stock_movements
  WHERE reference_id = OLD.invoice_id
    AND reference_type = 'invoice'
    AND product_id = OLD.product_id
    AND movement_type = 'sale'
    AND notes LIKE '%invoice_item:' || OLD.id::text || '%'
  LIMIT 1;

  -- If no sale movement found, nothing to restore
  IF NOT FOUND THEN
    RETURN OLD;
  END IF;

  -- Determine quantity to restore (use the same quantity that was deducted)
  v_qty_to_restore := ABS(v_existing_movement.quantity);

  -- Use the warehouse from the original movement
  v_target_wh := v_existing_movement.warehouse_id;

  IF v_target_wh IS NULL THEN
    v_target_wh := OLD.warehouse_id;
  END IF;

  IF v_target_wh IS NULL THEN
    SELECT id INTO v_target_wh FROM warehouses WHERE is_default = true AND is_active = true LIMIT 1;
  END IF;

  IF v_target_wh IS NULL THEN
    RETURN OLD;
  END IF;

  -- Get current inventory in the target warehouse
  SELECT id INTO v_inv_id
  FROM inventory_items
  WHERE product_id = OLD.product_id AND warehouse_id = v_target_wh
  FOR UPDATE;

  IF v_inv_id IS NOT NULL THEN
    -- Restore inventory
    UPDATE inventory_items
    SET quantity_on_hand = quantity_on_hand + v_qty_to_restore,
        updated_at = now()
    WHERE id = v_inv_id;
  ELSE
    -- Create inventory record with restored stock
    INSERT INTO inventory_items (product_id, warehouse_id, quantity_on_hand, quantity_reserved, quantity_incoming)
    VALUES (OLD.product_id, v_target_wh, v_qty_to_restore, 0, 0);
  END IF;

  -- Get product cost for the stock movement
  SELECT cost_price INTO v_product_cost FROM products WHERE id = OLD.product_id;

  -- Record the reversal movement
  INSERT INTO stock_movements (
    product_id, warehouse_id, movement_type, quantity,
    unit_cost, reference_type, reference_id, reference_number, notes
  )
  VALUES (
    OLD.product_id, v_target_wh, 'return_in', v_qty_to_restore,
    COALESCE(v_product_cost, 0), 'invoice', OLD.invoice_id,
    v_invoice_record.invoice_number,
    'Stock restoration - invoice item deleted - invoice_item:' || OLD.id::text
  );

  -- Delete the original sale movement to clean up
  DELETE FROM stock_movements WHERE id = v_existing_movement.id;

  RETURN OLD;
END;
$function$;

-- ============================================================
-- STEP 3: Create trigger for DELETE events
-- ============================================================

DROP TRIGGER IF EXISTS trg_restore_stock_on_invoice_item_delete ON invoice_items;
CREATE TRIGGER trg_restore_stock_on_invoice_item_delete
  AFTER DELETE ON invoice_items
  FOR EACH ROW
  EXECUTE FUNCTION restore_stock_on_invoice_item_delete();

-- ============================================================
-- STEP 4: Verify triggers
-- ============================================================

DO $$
BEGIN
  RAISE NOTICE '=== STOCK DOUBLE DEDUCTION FIX APPLIED ===';
  RAISE NOTICE '1. deduct_stock_on_invoice_item: UPDATED with idempotency guard';
  RAISE NOTICE '2. restore_stock_on_invoice_item_delete: CREATED for DELETE events';
  RAISE NOTICE '3. trg_restore_stock_on_invoice_item_delete: INSTALLED';
  RAISE NOTICE '=== FIX COMPLETE ===';
END $$;
