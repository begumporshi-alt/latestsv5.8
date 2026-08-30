/*
# Fix: DELETE trigger should only create return_in, not delete original sale movement

## Problem
The DELETE trigger was:
1. Creating a return_in movement (+1)
2. Deleting the original sale movement (removes -1 = effectively +1)
Net effect: +2 instead of +1

## Fix
Only create the return_in movement. Keep the original sale movement.
Net effect: -1 (original) + 1 (return_in) = 0 (correctly restored)

## Also
The session variable check prevents firing when called from edit_invoice,
which already handles stock restoration in STEP 1b.
*/

CREATE OR REPLACE FUNCTION restore_stock_on_invoice_item_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_invoice_record RECORD;
  v_target_wh uuid;
  v_qty_to_restore numeric;
  v_inv_id uuid;
  v_product_cost numeric;
  v_existing_movement RECORD;
BEGIN
  -- Skip if called from within edit_invoice (it handles stock restoration itself)
  IF current_setting('app.edit_invoice_active', true) = 'true' THEN
    RETURN OLD;
  END IF;

  -- Get the invoice record
  SELECT * INTO v_invoice_record FROM invoices WHERE id = OLD.invoice_id;
  IF NOT FOUND THEN
    RETURN OLD;
  END IF;

  -- Skip if invoice is cancelled
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

  -- Determine quantity to restore
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
    UPDATE inventory_items
    SET quantity_on_hand = quantity_on_hand + v_qty_to_restore,
        updated_at = now()
    WHERE id = v_inv_id;
  ELSE
    INSERT INTO inventory_items (product_id, warehouse_id, quantity_on_hand, quantity_reserved, quantity_incoming)
    VALUES (OLD.product_id, v_target_wh, v_qty_to_restore, 0, 0);
  END IF;

  -- Get product cost
  SELECT cost_price INTO v_product_cost FROM products WHERE id = OLD.product_id;

  -- Record the reversal movement (DO NOT delete original sale movement)
  INSERT INTO stock_movements (
    product_id, warehouse_id, movement_type, quantity,
    unit_cost, reference_type, reference_id, reference_number, notes
  ) VALUES (
    OLD.product_id, v_target_wh, 'return_in', v_qty_to_restore,
    COALESCE(v_product_cost, 0), 'invoice', OLD.invoice_id,
    v_invoice_record.invoice_number,
    'Stock restoration - invoice item deleted - invoice_item:' || OLD.id::text
  );

  -- NOTE: We intentionally do NOT delete the original sale movement.
  -- The original sale movement remains as-is, and the return_in movement
  -- restores the stock. Net effect: -original + return_in = 0 (correct).

  RETURN OLD;
END;
$$;
