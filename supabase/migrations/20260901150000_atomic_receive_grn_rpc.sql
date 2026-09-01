-- 2026-09-01: Atomic GRN receive RPC (audit fix #4).
--
-- The GRN save handler previously performed 6+ sequential frontend writes
-- (GRN header, movement, counter upsert, PO received qty, FIFO batches,
-- journal, PO status, reminders). A mid-flow failure left stock counted
-- without layers or a journal entry — the exact pattern behind the August
-- double-posting era. This RPC does the entire receive in ONE transaction:
-- any error rolls back everything.
--
-- receive_grn(p_supplier_id, p_purchase_order_id, p_warehouse_id, p_items json, p_notes)
-- p_items: [{ po_item_id (nullable), product_id, quantity, unit_cost (base units) }]
-- Returns { grn_id, grn_number, cost_updates: [{product_id, name, before, after}] }
--
-- Preserves existing behavior: batch insert fires the cost-price ratchet
-- trigger; journal posted via idempotent post_grn_journal; PO status
-- recompute; pending purchase reminders auto-fulfilled.

BEGIN;

CREATE OR REPLACE FUNCTION receive_grn(
  p_supplier_id uuid,
  p_purchase_order_id uuid DEFAULT NULL,
  p_warehouse_id uuid DEFAULT NULL,
  p_items json DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := '00000000-0000-0000-0000-000000000001';
  v_grn_id uuid := gen_random_uuid();
  v_grn_number text;
  v_wh uuid;
  v_item json;
  v_product_id uuid;
  v_po_item_id uuid;
  v_qty numeric;
  v_cost numeric;
  v_before_cost numeric;
  v_after_cost numeric;
  v_inv_item record;
  v_cost_updates jsonb := '[]'::jsonb;
  v_all_received boolean;
  v_some_received boolean;
BEGIN
  IF p_supplier_id IS NULL THEN
    RAISE EXCEPTION 'Supplier is required';
  END IF;
  IF p_items IS NULL OR json_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'At least one item with quantity > 0 is required';
  END IF;

  v_wh := COALESCE(
    p_warehouse_id,
    (SELECT id FROM warehouses WHERE is_default AND is_active LIMIT 1),
    (SELECT id FROM warehouses WHERE is_active LIMIT 1)
  );
  IF v_wh IS NULL THEN
    RAISE EXCEPTION 'No active warehouse available';
  END IF;

  v_grn_number := 'GRN-' || to_char(clock_timestamp(), 'YYMMDDHH24MISSUS');

  INSERT INTO goods_receipt_notes (id, tenant_id, grn_number, purchase_order_id, supplier_id,
                                   warehouse_id, received_date, status, notes)
  VALUES (v_grn_id, v_tenant, v_grn_number, p_purchase_order_id, p_supplier_id,
          v_wh, CURRENT_DATE, 'posted', p_notes);

  FOR v_item IN SELECT * FROM json_array_elements(p_items) LOOP
    v_qty := COALESCE((v_item->>'quantity')::numeric, 0);
    v_cost := COALESCE((v_item->>'unit_cost')::numeric, 0);
    v_product_id := (v_item->>'product_id')::uuid;
    v_po_item_id := NULLIF(v_item->>'po_item_id', '')::uuid;
    IF v_qty <= 0 OR v_product_id IS NULL THEN
      CONTINUE;
    END IF;

    SELECT cost_price INTO v_before_cost FROM products WHERE id = v_product_id;

    INSERT INTO stock_movements (tenant_id, product_id, warehouse_id, movement_type,
                                 quantity, unit_cost, reference_type, reference_id, reference_number)
    VALUES (v_tenant, v_product_id, v_wh, 'purchase', v_qty, v_cost, 'grn', v_grn_id, v_grn_number);

    -- Counter upsert (no unique constraint on inventory_items — check then act).
    SELECT ii.id, ii.quantity_on_hand INTO v_inv_item
    FROM inventory_items ii
    WHERE ii.product_id = v_product_id AND ii.warehouse_id = v_wh
    LIMIT 1;
    IF v_inv_item.id IS NOT NULL THEN
      UPDATE inventory_items
      SET quantity_on_hand = quantity_on_hand + v_qty, updated_at = now()
      WHERE id = v_inv_item.id;
    ELSE
      INSERT INTO inventory_items (tenant_id, product_id, warehouse_id, quantity_on_hand)
      VALUES (v_tenant, v_product_id, v_wh, v_qty);
    END IF;

    IF v_po_item_id IS NOT NULL THEN
      UPDATE purchase_order_items
      SET received_quantity = COALESCE(received_quantity, 0) + v_qty
      WHERE id = v_po_item_id;
    END IF;

    -- FIFO layer — the cost-ratchet and base-unit-cost triggers fire on this insert.
    INSERT INTO inventory_batches (tenant_id, product_id, variant_id, warehouse_id, batch_number,
                                   quantity_received, quantity_remaining, unit_cost, batch_type,
                                   reference_type, reference_id, reference_number, notes)
    VALUES (v_tenant, v_product_id, NULL, v_wh,
            v_grn_number || '-' || left(v_product_id::text, 8),
            v_qty, v_qty, v_cost, 'purchase',
            'grn', v_grn_id, v_grn_number, COALESCE(p_notes, 'Goods received via GRN'));

    SELECT cost_price INTO v_after_cost FROM products WHERE id = v_product_id;
    IF v_after_cost > COALESCE(v_before_cost, 0) THEN
      v_cost_updates := v_cost_updates || jsonb_build_object(
        'product_id', v_product_id,
        'name', (SELECT name FROM products WHERE id = v_product_id),
        'before', COALESCE(v_before_cost, 0),
        'after', v_after_cost
      );
    END IF;
  END LOOP;

  -- Journal entry (Dr 1200 / Cr 2000), idempotent per GRN.
  PERFORM post_grn_journal(v_grn_id);

  -- PO status recompute.
  IF p_purchase_order_id IS NOT NULL THEN
    SELECT BOOL_AND(COALESCE(i.received_quantity, 0) >= i.quantity),
           BOOL_OR(COALESCE(i.received_quantity, 0) > 0)
      INTO v_all_received, v_some_received
    FROM purchase_order_items i
    WHERE i.purchase_order_id = p_purchase_order_id;

    UPDATE purchase_orders
    SET status = CASE
      WHEN COALESCE(v_all_received, false) THEN 'received'
      WHEN COALESCE(v_some_received, false) THEN 'partially_received'
      ELSE 'approved'
    END
    WHERE id = p_purchase_order_id;
  END IF;

  -- Auto-fulfill pending purchase reminders for the received products.
  UPDATE purchase_reminders
  SET status = 'fulfilled', fulfilled_at = now(), fulfilled_by_grn_id = v_grn_id, updated_at = now()
  WHERE status = 'pending'
    AND product_id IN (SELECT (j->>'product_id')::uuid FROM json_array_elements(p_items) j);

  RETURN json_build_object('grn_id', v_grn_id, 'grn_number', v_grn_number, 'cost_updates', v_cost_updates);
END $$;

GRANT EXECUTE ON FUNCTION receive_grn(uuid, uuid, uuid, json, text) TO authenticated;

COMMIT;
