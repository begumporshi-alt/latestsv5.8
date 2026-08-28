-- ============================================================
-- Migration: Fix grn_accounting_trigger to handle INSERT path and direct GRNs
-- Date: 2026-08-29
-- Purpose:
--   The existing grn_accounting_trigger only fires on UPDATE of
--   goods_receipt_notes when status transitions to 'posted'. It also only
--   reads purchase_order_items, which means direct GRNs (no PO) never
--   create inventory_batches.
--
--   Symptom: cost_price stays stale on direct GRN posts; weighted average
--   trigger never fires for direct receipts.
--
--   Fix:
--   1. Run the batch-creation block on both INSERT (status='posted') and
--      UPDATE (status transitions to 'posted').
--   2. For direct GRNs (purchase_order_id IS NULL), read unit_cost from
--      stock_movements that reference this GRN, since there are no
--      purchase_order_items to iterate.
-- ============================================================

CREATE OR REPLACE FUNCTION grn_accounting_trigger()
RETURNS TRIGGER AS $$
DECLARE
  v_tenant_id uuid;
  v_total_cost decimal(15,2);
  v_po_number text;
  v_item RECORD;
  v_batch_counter integer := 0;
  v_batch_num text;
  v_should_run boolean := false;
BEGIN
  v_tenant_id := COALESCE(NEW.tenant_id, '00000000-0000-0000-0000-000000000001');

  -- Run on UPDATE to 'posted' OR on INSERT as already-posted
  v_should_run :=
    (TG_OP = 'UPDATE' AND NEW.status = 'posted' AND OLD.status IS DISTINCT FROM 'posted')
    OR
    (TG_OP = 'INSERT' AND NEW.status = 'posted');

  IF v_should_run THEN
    SELECT po.po_number INTO v_po_number
    FROM purchase_orders po
    WHERE po.id = NEW.purchase_order_id;

    IF NEW.purchase_order_id IS NOT NULL THEN
      -- PO-backed GRN: read items from purchase_order_items
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
    ELSE
      -- Direct GRN: read from stock_movements that reference this GRN
      FOR v_item IN
        SELECT sm.product_id,
               NULL::uuid AS variant_id,
               sm.quantity  AS received_quantity,
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
    END IF;

    -- Post the AP journal entry (existing logic)
    SELECT COALESCE(SUM(poi.received_quantity * poi.unit_cost), 0)
    INTO v_total_cost
    FROM purchase_order_items poi
    WHERE poi.purchase_order_id = NEW.purchase_order_id;

    -- For direct GRNs, also include stock_movements value
    IF v_total_cost IS NULL OR v_total_cost = 0 THEN
      SELECT COALESCE(SUM(sm.quantity * sm.unit_cost), 0)
      INTO v_total_cost
      FROM stock_movements sm
      WHERE sm.reference_type = 'grn'
        AND sm.reference_id = NEW.id
        AND sm.movement_type = 'purchase';
    END IF;

    IF v_total_cost > 0 THEN
      PERFORM post_journal_entry(
        'Goods Received - GRN #' || NEW.grn_number || COALESCE(' / PO #' || v_po_number, ''),
        COALESCE(NEW.received_date, CURRENT_DATE),
        'grn',
        NEW.id,
        json_build_array(
          json_build_object('account_id', (SELECT id FROM accounts WHERE code = '1200' LIMIT 1), 'debit', v_total_cost, 'description', 'Inventory received'),
          json_build_object('account_id', (SELECT id FROM accounts WHERE code = '2000' LIMIT 1), 'credit', v_total_cost, 'description', 'Accounts Payable - goods received')
        )::json,
        NULL,  -- customer_id
        NULL   -- supplier_id
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Reattach the trigger (it should already exist; ensure function is the new one)
DROP TRIGGER IF EXISTS grn_accounting_trigger ON goods_receipt_notes;
CREATE TRIGGER grn_accounting_trigger
  AFTER INSERT OR UPDATE ON goods_receipt_notes
  FOR EACH ROW
  EXECUTE FUNCTION grn_accounting_trigger();

-- ============================================================
-- One-shot backfill: for any existing direct GRN with status='posted' that
-- has stock_movements but no inventory_batches, create the missing batches
-- and recompute cost_price.
-- ============================================================
DO $$
DECLARE
  v_grn record;
  v_item record;
  v_batch_counter integer;
  v_total_qty numeric(15,3);
  v_total_value numeric(15,4);
  v_new_cost numeric(15,2);
BEGIN
  FOR v_grn IN
    SELECT grn.id, grn.grn_number, grn.warehouse_id, grn.received_date
    FROM goods_receipt_notes grn
    WHERE grn.status = 'posted'
      AND NOT EXISTS (
        SELECT 1 FROM inventory_batches ib
        WHERE ib.reference_id = grn.id AND ib.reference_type = 'grn'
      )
  LOOP
    v_batch_counter := 0;
    FOR v_item IN
      SELECT sm.product_id, sm.quantity, sm.unit_cost
      FROM stock_movements sm
      WHERE sm.reference_type = 'grn'
        AND sm.reference_id = v_grn.id
        AND sm.movement_type = 'purchase'
        AND sm.quantity > 0
    LOOP
      v_batch_counter := v_batch_counter + 1;
      INSERT INTO inventory_batches (
        product_id, variant_id, warehouse_id, batch_number,
        quantity_received, quantity_remaining, unit_cost,
        batch_type, reference_type, reference_id, reference_number,
        notes, created_at
      ) VALUES (
        v_item.product_id, NULL, v_grn.warehouse_id,
        'GRN-' || COALESCE(v_grn.grn_number, v_batch_counter::text),
        v_item.quantity, v_item.quantity, v_item.unit_cost,
        'purchase', 'grn', v_grn.id, v_grn.grn_number,
        'Backfilled from direct GRN', COALESCE(v_grn.received_date, CURRENT_DATE)
      );
    END LOOP;
  END LOOP;
END $$;
