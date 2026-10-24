-- Sale deduction: counter tracks the ledger, floor removed.
-- With oversell ON an IOU batch is a legitimate ledger state, so the counter
-- must go negative with it (GREATEST(0, ...) previously hid the shortfall and
-- made the products page overstate stock). The write is a full resync against
-- the pre-sale ledger sum, which also heals any legacy drift on every sale.

CREATE OR REPLACE FUNCTION public.deduct_stock_on_invoice_item()
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
  v_ledger_sum numeric;
  v_oversold numeric;
  v_oversold_text text;
BEGIN
  -- Quick-sell (non-stock) products carry no inventory counter and no stock
  -- movement; nothing to deduct.
  IF NOT COALESCE((SELECT p.track_inventory FROM products p WHERE p.id = NEW.product_id), true) THEN
    RETURN NEW;
  END IF;

  -- Get the invoice record
  SELECT * INTO v_invoice_record FROM invoices WHERE id = NEW.invoice_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- Skip if invoice is cancelled
  IF v_invoice_record.status = 'cancelled' THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM stock_movements
    WHERE reference_id = NEW.invoice_id
      AND reference_type = 'invoice'
      AND product_id = NEW.product_id
      AND movement_type = 'sale'
      AND notes LIKE '%invoice_item:' || NEW.id::text || '%'
  ) THEN
    RETURN NEW;
  END IF;

  v_qty_to_deduct := COALESCE(NEW.base_quantity, NEW.quantity);

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

  SELECT id, quantity_on_hand INTO v_inv_id, v_current_qty
  FROM inventory_items
  WHERE product_id = NEW.product_id AND warehouse_id = v_target_wh
  FOR UPDATE;

  -- This trigger runs before consume_fifo creates this sale's consumption
  -- rows (and any IOU batch), so the ledger sum here is the pre-sale truth.
  -- The counter is resynced to ledger_sum - qty rather than decremented
  -- blindly: the ledger is the source of truth and legacy drift heals here.
  SELECT COALESCE(SUM(quantity_remaining), 0) INTO v_ledger_sum
    FROM inventory_batches
   WHERE product_id = NEW.product_id AND warehouse_id = v_target_wh;

  IF v_inv_id IS NOT NULL THEN
    UPDATE inventory_items
    SET quantity_on_hand = v_ledger_sum - v_qty_to_deduct,
        updated_at = now()
    WHERE id = v_inv_id;
  ELSE
    INSERT INTO inventory_items (product_id, warehouse_id, quantity_on_hand, quantity_reserved, quantity_incoming)
    VALUES (NEW.product_id, v_target_wh, v_ledger_sum - v_qty_to_deduct, 0, 0);
  END IF;

  SELECT cost_price INTO v_product_cost FROM products WHERE id = NEW.product_id;

  v_oversold_text := NULL;
  v_oversold := v_qty_to_deduct - v_ledger_sum;
  IF v_oversold > 0 THEN
    v_oversold_text := CASE WHEN v_oversold = FLOOR(v_oversold)
                            THEN FLOOR(v_oversold)::bigint::text
                            ELSE v_oversold::text END;
  END IF;

  INSERT INTO stock_movements (
    product_id, warehouse_id, movement_type, quantity,
    unit_cost, reference_type, reference_id, reference_number, notes
  ) VALUES (
    NEW.product_id, v_target_wh, 'sale', -v_qty_to_deduct,
    COALESCE(v_product_cost, 0), 'invoice', NEW.invoice_id,
    v_invoice_record.invoice_number,
    'Stock deduction for sale - invoice_item:' || NEW.id::text
      || COALESCE(' — OVERSOLD by ' || v_oversold_text || ' base unit(s) beyond stock (IOU created)', '')
  );

  RETURN NEW;
END;
$function$;
