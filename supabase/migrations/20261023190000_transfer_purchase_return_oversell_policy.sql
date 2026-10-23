-- ============================================================================
-- Policy-aware shortfall handling for transfer + purchase-return outflows
-- (same policy as the sales side in consume_fifo):
--   allow_oversell OFF -> RAISE EXCEPTION (whole operation rolls back)
--   allow_oversell ON  -> record the shortfall as a negative IOU layer at the
--                         source warehouse so the batch ledger matches the
--                         movement rows
-- Closes two silent-fabrication gaps:
--   1. transfer_fifo_batches used to create a fallback DESTINATION batch even
--      when the source ledger could not cover the transfer (stock out of thin
--      air, source ledger unchanged).
--   2. reverse_fifo_on_purchase_return silently ignored overflow, so the
--      return_out movement overclaimed against the ledger.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.transfer_fifo_batches(p_product_id uuid, p_from_warehouse_id uuid, p_to_warehouse_id uuid, p_quantity numeric, p_reference_id uuid DEFAULT NULL::uuid, p_reference_number text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
v_remaining numeric := p_quantity;
v_batch RECORD;
v_consume_qty numeric;
v_batch_number text;
v_allow_oversell boolean;
v_fallback_cost decimal(15,2);
BEGIN
IF p_quantity <= 0 THEN
RETURN;
END IF;

SELECT COALESCE(setting_value->>'allow_oversell', 'true') = 'true'
  INTO v_allow_oversell
  FROM app_settings
 WHERE setting_key = 'inventory';
v_allow_oversell := COALESCE(v_allow_oversell, true);

FOR v_batch IN
SELECT id, unit_cost, quantity_remaining
FROM inventory_batches
WHERE product_id = p_product_id
AND warehouse_id = p_from_warehouse_id
AND quantity_remaining > 0
ORDER BY created_at ASC, id ASC
FOR UPDATE
LOOP
EXIT WHEN v_remaining <= 0;

v_consume_qty := LEAST(v_batch.quantity_remaining, v_remaining);

-- Reduce source batch
UPDATE inventory_batches
SET quantity_remaining = quantity_remaining - v_consume_qty
WHERE id = v_batch.id;

-- Create destination batch with same cost
v_batch_number := 'TRF-' || COALESCE(p_reference_number, 'MANUAL');
INSERT INTO inventory_batches (
product_id, warehouse_id, batch_number,
quantity_received, quantity_remaining, unit_cost,
batch_type, reference_type, reference_id, reference_number,
notes
) VALUES (
p_product_id, p_to_warehouse_id, v_batch_number,
v_consume_qty, v_consume_qty, v_batch.unit_cost,
'adjustment', 'transfer', p_reference_id, p_reference_number,
'Transferred from ' || p_from_warehouse_id::text
);

v_remaining := v_remaining - v_consume_qty;
END LOOP;

-- Shortfall: the source ledger could not cover the transfer. Same policy as
-- the sales side — block when overselling is OFF, otherwise the source owes
-- the shortfall (IOU layer) and the destination still receives the full
-- quantity at product cost.
IF v_remaining > 0 THEN
IF NOT v_allow_oversell THEN
RAISE EXCEPTION 'Insufficient stock: transfer is short by % base unit(s) for product % in warehouse % (only % in the FIFO ledger). Enable "Allow selling beyond stock" in Settings > Inventory to permit overselling.',
  v_remaining,
  COALESCE((SELECT p.name FROM products p WHERE p.id = p_product_id), p_product_id::text),
  COALESCE((SELECT w.name FROM warehouses w WHERE w.id = p_from_warehouse_id), p_from_warehouse_id::text),
  (SELECT COALESCE(SUM(quantity_remaining), 0) FROM inventory_batches
    WHERE product_id = p_product_id AND warehouse_id = p_from_warehouse_id);
END IF;

SELECT COALESCE(cost_price, 0) INTO v_fallback_cost
FROM products WHERE id = p_product_id;

INSERT INTO inventory_batches (
product_id, warehouse_id, batch_number,
quantity_received, quantity_remaining, unit_cost,
batch_type, reference_type, reference_id, reference_number,
notes
) VALUES (
p_product_id, p_from_warehouse_id, 'TRF-SHORTFALL-' || substr(p_product_id::text, 1, 8),
-v_remaining, -v_remaining, v_fallback_cost,
'adjustment', 'transfer', p_reference_id, p_reference_number,
'Transfer shortfall at source (oversell allowed)'
);

INSERT INTO inventory_batches (
product_id, warehouse_id, batch_number,
quantity_received, quantity_remaining, unit_cost,
batch_type, reference_type, reference_id, reference_number,
notes
) VALUES (
p_product_id, p_to_warehouse_id, 'TRF-' || COALESCE(p_reference_number, 'MANUAL'),
v_remaining, v_remaining, v_fallback_cost,
'adjustment', 'transfer', p_reference_id, p_reference_number,
'Transferred from ' || p_from_warehouse_id::text || ' (fallback at product cost)'
);
END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.reverse_fifo_on_purchase_return(p_product_id uuid, p_warehouse_id uuid, p_quantity numeric, p_unit_cost numeric DEFAULT 0, p_reference_id uuid DEFAULT NULL::uuid, p_reference_number text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
v_remaining numeric := p_quantity;
v_batch RECORD;
v_reduce_qty numeric;
v_allow_oversell boolean;
BEGIN
IF p_quantity <= 0 THEN
RETURN;
END IF;

SELECT COALESCE(setting_value->>'allow_oversell', 'true') = 'true'
  INTO v_allow_oversell
  FROM app_settings
 WHERE setting_key = 'inventory';
v_allow_oversell := COALESCE(v_allow_oversell, true);

FOR v_batch IN
SELECT id, quantity_remaining
FROM inventory_batches
WHERE product_id = p_product_id
AND warehouse_id = p_warehouse_id
AND quantity_remaining > 0
ORDER BY created_at DESC, id DESC
FOR UPDATE
LOOP
EXIT WHEN v_remaining <= 0;

v_reduce_qty := LEAST(v_batch.quantity_remaining, v_remaining);

UPDATE inventory_batches
SET quantity_remaining = quantity_remaining - v_reduce_qty
WHERE id = v_batch.id;

v_remaining := v_remaining - v_reduce_qty;
END LOOP;

-- Overflow: the ledger holds less than the return claims. Same policy as the
-- sales side — block when overselling is OFF, otherwise record the excess as
-- a negative IOU layer so the ledger matches the return_out movement.
IF v_remaining > 0 THEN
IF NOT v_allow_oversell THEN
RAISE EXCEPTION 'Insufficient stock: purchase return is short by % base unit(s) for product % in warehouse % (only % in the FIFO ledger). Enable "Allow selling beyond stock" in Settings > Inventory to permit overselling.',
  v_remaining,
  COALESCE((SELECT p.name FROM products p WHERE p.id = p_product_id), p_product_id::text),
  COALESCE((SELECT w.name FROM warehouses w WHERE w.id = p_warehouse_id), p_warehouse_id::text),
  (SELECT COALESCE(SUM(quantity_remaining), 0) FROM inventory_batches
    WHERE product_id = p_product_id AND warehouse_id = p_warehouse_id);
END IF;

INSERT INTO inventory_batches (
product_id, warehouse_id, batch_number,
quantity_received, quantity_remaining, unit_cost,
batch_type, reference_type, reference_id, reference_number,
notes
) VALUES (
p_product_id, p_warehouse_id, 'PRET-SHORTFALL-' || substr(p_product_id::text, 1, 8),
-v_remaining, -v_remaining, p_unit_cost,
'adjustment', 'purchase_return', p_reference_id, p_reference_number,
'Purchase return shortfall (oversell allowed)'
);
END IF;
END;
$function$;
