-- ============================================================
-- Migration: Definitive GRN trigger fix
-- Date: 2026-08-29
-- Purpose:
--   The grn_accounting_trigger function was updated via CREATE OR REPLACE
--   but triggers were not properly rebuilt. There are two triggers
--   (grn_accounting_trigger + trg_grn_accounting) both pointing to the
--   same function. Some INSERTs create batches (both triggers fire), some don't.
--   This migration drops all existing triggers/functions and creates one clean
--   trigger with the correct function body.
--
--   Root cause: CREATE OR REPLACE on the function doesn't guarantee the
--   trigger re-attaches cleanly when both trigger names fire on INSERT.
-- ============================================================

-- Step 1: Drop existing triggers
DROP TRIGGER IF EXISTS grn_accounting_trigger ON goods_receipt_notes;
DROP TRIGGER IF EXISTS trg_grn_accounting ON goods_receipt_notes;

-- Step 2: Drop old duplicate functions
DROP FUNCTION IF EXISTS grn_accounting_trigger();

-- Step 3: Create one clean function
CREATE OR REPLACE FUNCTION grn_accounting_trigger()
RETURNS TRIGGER AS $$
DECLARE
  v_tenant_id    uuid;
  v_total_cost   decimal(15,2);
  v_po_number   text;
  v_item        RECORD;
  v_batch_counter integer := 0;
  v_batch_num   text;
BEGIN
  v_tenant_id := COALESCE(NEW.tenant_id, '00000000-0000-0000-0000-000000000001');

  -- Only fire on INSERT or UPDATE that brings status to 'posted'
  IF NOT (
    (TG_OP = 'INSERT' AND NEW.status = 'posted')
    OR (TG_OP = 'UPDATE' AND NEW.status = 'posted' AND OLD.status IS DISTINCT FROM 'posted')
  ) THEN
    RETURN NEW;
  END IF;

  -- Get PO number if linked
  SELECT po.po_number INTO v_po_number
  FROM purchase_orders po
  WHERE po.id = NEW.purchase_order_id;

  -- === PO-backed GRN: read from purchase_order_items ===
  IF NEW.purchase_order_id IS NOT NULL THEN
    FOR v_item IN
      SELECT poi.product_id, poi.variant_id, poi.received_quantity, poi.unit_cost
      FROM purchase_order_items poi
      WHERE poi.purchase_order_id = NEW.purchase_order_id
        AND poi.received_quantity > 0
    LOOP
      v_batch_counter := v_batch_counter + 1;
      v_batch_num := 'GRN-' || COALESCE(NEW.grn_number, v_batch_counter::text);

      INSERT INTO inventory_batches (
        product_id, variant_id, warehouse_id, batch_number,
        quantity_received, quantity_remaining, unit_cost,
        batch_type, reference_type, reference_id, reference_number,
        notes, created_at
      ) VALUES (
        v_item.product_id, v_item.variant_id, NEW.warehouse_id, v_batch_num,
        v_item.received_quantity, v_item.received_quantity, v_item.unit_cost,
        'purchase', 'grn', NEW.id, NEW.grn_number,
        'Goods received via GRN', COALESCE(NEW.received_date, CURRENT_DATE)
      );
    END LOOP;

    -- AP journal entry from PO items
    SELECT COALESCE(SUM(poi.received_quantity * poi.unit_cost), 0)
    INTO v_total_cost
    FROM purchase_order_items poi
    WHERE poi.purchase_order_id = NEW.purchase_order_id;

  -- === Direct GRN: read from stock_movements ===
  ELSE
    FOR v_item IN
      SELECT
        sm.product_id,
        NULL::uuid AS variant_id,
        sm.quantity AS received_quantity,
        sm.unit_cost
      FROM stock_movements sm
      WHERE sm.reference_type = 'grn'
        AND sm.reference_id = NEW.id
        AND sm.movement_type = 'purchase'
        AND sm.quantity > 0
    LOOP
      v_batch_counter := v_batch_counter + 1;
      v_batch_num := 'GRN-' || COALESCE(NEW.grn_number, v_batch_counter::text);

      INSERT INTO inventory_batches (
        product_id, variant_id, warehouse_id, batch_number,
        quantity_received, quantity_remaining, unit_cost,
        batch_type, reference_type, reference_id, reference_number,
        notes, created_at
      ) VALUES (
        v_item.product_id, v_item.variant_id, NEW.warehouse_id, v_batch_num,
        v_item.received_quantity, v_item.received_quantity, v_item.unit_cost,
        'purchase', 'grn', NEW.id, NEW.grn_number,
        'Goods received via direct GRN', COALESCE(NEW.received_date, CURRENT_DATE)
      );
    END LOOP;

    -- AP journal entry from stock_movements
    SELECT COALESCE(SUM(sm.quantity * sm.unit_cost), 0)
    INTO v_total_cost
    FROM stock_movements sm
    WHERE sm.reference_type = 'grn'
      AND sm.reference_id = NEW.id
      AND sm.movement_type = 'purchase';
  END IF;

  -- === Post journal entry ===
  IF v_total_cost > 0 THEN
    PERFORM post_journal_entry(
      'Goods Received - GRN #' || NEW.grn_number || COALESCE(' / PO #' || v_po_number, ''),
      COALESCE(NEW.received_date, CURRENT_DATE),
      'grn',
      NEW.id,
      json_build_array(
        json_build_object('account_id',
          (SELECT id FROM accounts WHERE code = '1200' LIMIT 1),
          'debit', v_total_cost, 'description', 'Inventory received'),
        json_build_object('account_id',
          (SELECT id FROM accounts WHERE code = '2000' LIMIT 1),
          'credit', v_total_cost, 'description', 'Accounts Payable - goods received')
      )::json,
      NULL,
      NULL
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Step 4: Re-attach single clean trigger
CREATE TRIGGER grn_accounting_trigger
  AFTER INSERT OR UPDATE ON goods_receipt_notes
  FOR EACH ROW
  EXECUTE FUNCTION grn_accounting_trigger();
