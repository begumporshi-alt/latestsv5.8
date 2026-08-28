-- ============================================================
-- Migration: Backfill GRNs for legacy POs received without GRN
-- Date: 2026-08-29
-- Purpose:
--   Some POs were marked as 'received' / 'partially_received' via the
--   legacy "Mark as Received" flow on the PO page, which bypassed the
--   GRN system. Those POs have stock_movements with
--   reference_type = 'purchase_order' but no GRN, no inventory_batches,
--   and therefore no cost_price update via the weighted-average trigger.
--
--   This migration:
--     1. For each such PO, creates a GRN (status='posted') and links it.
--     2. Re-points the existing stock_movements to reference the new GRN.
--     3. Lets grn_accounting_trigger create the inventory_batches.
--     4. Lets trg_update_weighted_average_cost update products.cost_price.
--
--   Note: this only fixes the FIFO/weighted-average data path. Stock
--   quantities in inventory_items are already correct from the legacy flow.
-- ============================================================

-- ============================================================
-- Phase 2: Fix GRNs inserted as 'posted' before INSERT-trigger fix was applied
-- GRN-485187 (test12) and any other GRNs with purchase_order_id and
-- received_quantity > 0 but no inventory_batches.
-- The INSERT trigger was only added on 2026-08-29, so any GRN inserted
-- before that date via the GRN page (INSERT as 'posted') missed batch creation.
-- ============================================================
DO $$
DECLARE
  v_grn record;
  v_item record;
  v_po record;
  v_warehouse_id uuid;
BEGIN
  FOR v_grn IN
    SELECT grn.id, grn.grn_number, grn.warehouse_id, grn.purchase_order_id, grn.received_date
    FROM goods_receipt_notes grn
    WHERE grn.status = 'posted'
      AND grn.purchase_order_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM inventory_batches ib
        WHERE ib.reference_type = 'grn' AND ib.reference_id = grn.id
      )
  LOOP
    -- Get warehouse from GRN or fall back
    v_warehouse_id := v_grn.warehouse_id;
    IF v_warehouse_id IS NULL THEN
      SELECT id INTO v_warehouse_id FROM warehouses WHERE is_default = true LIMIT 1;
    END IF;
    IF v_warehouse_id IS NULL THEN
      SELECT id INTO v_warehouse_id FROM warehouses WHERE is_active = true LIMIT 1;
    END IF;

    -- Create batch for each PO item with received qty
    FOR v_item IN
      SELECT poi.product_id, poi.received_quantity, poi.unit_cost
      FROM purchase_order_items poi
      WHERE poi.purchase_order_id = v_grn.purchase_order_id
        AND poi.received_quantity > 0
    LOOP
      INSERT INTO inventory_batches (
        product_id, variant_id, warehouse_id, batch_number,
        quantity_received, quantity_remaining, unit_cost,
        batch_type, reference_type, reference_id, reference_number,
        notes, created_at
      ) VALUES (
        v_item.product_id, NULL, v_warehouse_id, v_grn.grn_number,
        v_item.received_quantity, v_item.received_quantity, v_item.unit_cost,
        'purchase', 'grn', v_grn.id, v_grn.grn_number,
        'Backfilled missing batch (INSERT trigger inactive at GRN creation)',
        COALESCE(v_grn.received_date, CURRENT_DATE)
      )
      ON CONFLICT DO NOTHING;
    END LOOP;

    RAISE NOTICE 'Backfilled missing batch for GRN %', v_grn.grn_number;
  END LOOP;
END $$;

-- ============================================================
-- Phase 1 (original): Create GRNs for POs received via old Mark-as-Received
-- ============================================================
DO $$
DECLARE
  v_po record;
  v_movement record;
  v_grn_id uuid;
  v_grn_number text;
  v_warehouse_id uuid;
  v_received_date date;
  v_total_movements integer;
  v_counter integer;
BEGIN
  FOR v_po IN
    SELECT po.id, po.po_number, po.supplier_id, po.status, po.order_date
    FROM purchase_orders po
    WHERE po.status IN ('received', 'partially_received')
      AND NOT EXISTS (
        SELECT 1 FROM goods_receipt_notes grn WHERE grn.purchase_order_id = po.id
      )
      AND EXISTS (
        SELECT 1 FROM stock_movements sm
        WHERE sm.reference_type = 'purchase_order' AND sm.reference_id = po.id
      )
  LOOP
    -- Pick a warehouse from the PO's existing stock_movements
    SELECT sm.warehouse_id
    INTO v_warehouse_id
    FROM stock_movements sm
    WHERE sm.reference_type = 'purchase_order' AND sm.reference_id = v_po.id
    LIMIT 1;

    IF v_warehouse_id IS NULL THEN
      -- Fall back to default warehouse
      SELECT id INTO v_warehouse_id FROM warehouses WHERE is_default = true LIMIT 1;
    END IF;
    IF v_warehouse_id IS NULL THEN
      SELECT id INTO v_warehouse_id FROM warehouses WHERE is_active = true LIMIT 1;
    END IF;

    v_grn_id := gen_random_uuid();
    v_grn_number := 'GRN-LEGACY-' || v_po.po_number;
    v_received_date := COALESCE(v_po.order_date::date, CURRENT_DATE);

    -- Create the GRN
    INSERT INTO goods_receipt_notes (
      id, tenant_id, grn_number, supplier_id, purchase_order_id,
      warehouse_id, received_date, status, notes, created_at
    ) VALUES (
      v_grn_id,
      '00000000-0000-0000-0000-000000000001',
      v_grn_number,
      v_po.supplier_id,
      v_po.id,
      v_warehouse_id,
      v_received_date,
      'posted',
      'Backfilled from legacy Mark-as-Received flow on ' || CURRENT_DATE::text,
      NOW()
    );

    -- Re-point existing stock_movements to reference this new GRN
    UPDATE stock_movements
    SET reference_type = 'grn',
        reference_id = v_grn_id,
        reference_number = v_grn_number
    WHERE reference_type = 'purchase_order'
      AND reference_id = v_po.id;

    -- Also update received_quantity on purchase_order_items to match what
    -- was actually received, if not already set.
    UPDATE purchase_order_items poi
    SET received_quantity = COALESCE(poi.received_quantity,
      (SELECT SUM(sm.quantity)
       FROM stock_movements sm
       WHERE sm.reference_id = v_grn_id
         AND sm.reference_type = 'grn'
         AND sm.product_id = poi.product_id))
    WHERE poi.purchase_order_id = v_po.id;

    RAISE NOTICE 'Backfilled GRN % for PO %', v_grn_number, v_po.po_number;
  END LOOP;
END $$;
