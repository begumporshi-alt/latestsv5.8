-- Fix: deduct_stock_on_invoice_item() now respects the warehouse_id passed on invoice_items
-- Previously it always deducted from the default warehouse, ignoring the POS cart's warehouse selection.

CREATE OR REPLACE FUNCTION deduct_stock_on_invoice_item()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
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
  INSERT INTO stock_movements (
    product_id, warehouse_id, movement_type, quantity,
    unit_cost, reference_type, reference_id, reference_number, notes
  )
  VALUES (
    NEW.product_id, v_target_wh, 'sale', -v_qty_to_deduct,
    COALESCE(v_product_cost, 0), 'invoice', NEW.invoice_id,
    v_invoice_record.invoice_number, 'Stock deduction for sale'
  );

  RETURN NEW;
END;
$$;

-- Trigger stays the same (no need to drop/recreate, function is REPLACE)
