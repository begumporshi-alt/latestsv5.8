-- Fix restore_fifo: it DELETED any batch of batch_type='adjustment' that a
-- cancelled invoice had consumed from, instead of restoring just the consumed
-- quantity. Legitimate adjustment layers (opening adjustments OPN-ADJ-*, stock
-- adjustments ADJUSTMENT-*) are batch_type='adjustment' like shortfall IOU
-- rows, so cancelling an invoice that had consumed from them destroyed the
-- whole layer's remaining value (INV-940647, 2026-09-02: -2,816,747.21 of
-- batch value; the batch DELETE also cascade-deleted other invoices'
-- consumption rows on those batches).
--
-- Correct semantics: restoring consumption ALWAYS adds quantity_consumed back
-- to quantity_remaining. For a pure shortfall IOU row (received = 0, created
-- negative by consume_fifo / create_stock_reduction), adding the consumption
-- back zeroes it -- same ledger effect as the old delete, but without touching
-- anything else. No batch row is ever deleted here anymore.

BEGIN;

CREATE OR REPLACE FUNCTION restore_fifo(p_invoice_item_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_rec RECORD;
BEGIN
  FOR v_rec IN SELECT id, batch_id, quantity_consumed
               FROM invoice_item_batch_consumption
               WHERE invoice_item_id = p_invoice_item_id
               FOR UPDATE LOOP
    IF v_rec.batch_id IS NOT NULL THEN
      UPDATE inventory_batches
         SET quantity_remaining = quantity_remaining + v_rec.quantity_consumed
       WHERE id = v_rec.batch_id;
    END IF;
    DELETE FROM invoice_item_batch_consumption WHERE id = v_rec.id;
  END LOOP;
END;
$function$;

COMMIT;
