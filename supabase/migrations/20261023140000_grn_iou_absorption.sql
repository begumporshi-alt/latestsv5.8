-- 2026-10-23: Heal oversell IOU layers on receipt.
--
-- Problem (2026-10-23 audit): when a sale goes past the FIFO ledger with
-- "Allow selling beyond stock" ON, consume_fifo writes a negative IOU batch
-- and the on-hand counter is floored at 0. receive_grn then blindly does
-- counter + received_qty and inserts a fresh positive batch — nothing ever
-- nets the IOU. Result: the counter permanently overstates by the cumulative
-- IOU amount (counter says 100 after receiving 100, truth is 84), the IOU
-- batch row lingers negative forever, and nothing prompts a replenishment.
--
-- Fix, inside receive_grn (the offline replay sync_grn_receive wraps this
-- function, so both paths heal):
--   1. Absorb outstanding negative batches for the same product+warehouse
--      into the receipt: IOU rows are driven back to 0 (oldest first) and the
--      FIFO batch posts NET of what was owed (received 100, owed 16 → batch
--      of 84). The stock movement still records the paper receipt of 100.
--   2. Resync the on-hand counter from the batch-ledger sum instead of
--      blind-incrementing it, so flooring drift and legacy divergence both
--      snap back to truth at every receipt. The ledger is already the source
--      of truth everywhere else (consume_fifo, reports, the oversell gate).
--
-- No-op when there are no negative batches: absorption finds nothing and the
-- counter resync lands on the same number the old increment produced (as long
-- as counter and ledger agree, which the backfills guarantee).
--
-- Forward-looking only: existing rows are touched only by the next receipt
-- for their product+warehouse.

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
  v_expiry date;
  v_before_cost numeric;
  v_after_cost numeric;
  v_batch_cost numeric;
  v_force_cost boolean := false;
  v_poi_unit_cost numeric;
  v_poi_discount numeric;
  v_inv_item record;
  v_cost_updates jsonb := '[]'::jsonb;
  v_sale_updates jsonb := '[]'::jsonb;
  v_before_sale numeric;
  v_new_sale numeric;
  v_all_received boolean;
  v_some_received boolean;
  v_owed numeric;
  v_absorb_left numeric;
  v_absorbed numeric;
  v_take numeric;
  v_iou record;
  v_net_qty numeric;
  v_ledger_sum numeric;
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
    v_expiry := (v_item->>'expiry_date')::date;
    v_product_id := (v_item->>'product_id')::uuid;
    v_po_item_id := NULLIF(v_item->>'po_item_id', '')::uuid;
    v_force_cost := false;
    IF v_qty <= 0 OR v_product_id IS NULL THEN
      CONTINUE;
    END IF;

    -- PO-based receipts cost what the PO line committed to: unit cost minus
    -- the line discount. The client sends the raw pre-discount unit_cost, so
    -- it is ignored here — otherwise batches, movements, and the cost ratchet
    -- all post at the undiscounted price.
    IF v_po_item_id IS NOT NULL THEN
      SELECT unit_cost, COALESCE(discount_percent, 0)
        INTO v_poi_unit_cost, v_poi_discount
      FROM purchase_order_items WHERE id = v_po_item_id;
      IF FOUND THEN
        v_cost := v_poi_unit_cost * (1 - v_poi_discount / 100);
      END IF;
    END IF;

    SELECT cost_price INTO v_before_cost FROM products WHERE id = v_product_id;

    INSERT INTO stock_movements (tenant_id, product_id, warehouse_id, movement_type,
                                 quantity, unit_cost, reference_type, reference_id, reference_number)
    VALUES (v_tenant, v_product_id, v_wh, 'purchase', v_qty, v_cost, 'grn', v_grn_id, v_grn_number);

    -- Absorb outstanding oversell IOU layers (negative FIFO-SHORTFALL batches)
    -- into this receipt: drive them back to 0, oldest first, and post the new
    -- batch net of what was owed. Batches and p_qty share the same base-unit
    -- convention, so the arithmetic is direct.
    SELECT COALESCE(-SUM(quantity_remaining), 0) INTO v_owed
      FROM inventory_batches
     WHERE product_id = v_product_id AND warehouse_id = v_wh
       AND quantity_remaining < 0;
    v_absorbed := LEAST(v_owed, v_qty);
    v_net_qty := v_qty - v_absorbed;
    IF v_absorbed > 0 THEN
      v_absorb_left := v_absorbed;
      FOR v_iou IN
        SELECT id, quantity_remaining
          FROM inventory_batches
         WHERE product_id = v_product_id AND warehouse_id = v_wh
           AND quantity_remaining < 0
         ORDER BY created_at ASC, id ASC
         FOR UPDATE
      LOOP
        EXIT WHEN v_absorb_left <= 0;
        v_take := LEAST(-v_iou.quantity_remaining, v_absorb_left);
        UPDATE inventory_batches
           SET quantity_remaining = quantity_remaining + v_take
         WHERE id = v_iou.id;
        v_absorb_left := v_absorb_left - v_take;
      END LOOP;
    END IF;

    IF v_po_item_id IS NOT NULL THEN
      UPDATE purchase_order_items
      SET received_quantity = COALESCE(received_quantity, 0) + v_qty
      WHERE id = v_po_item_id;

      -- Push the PO line's intended sale price onto the product master.
      -- Only for PO-based receipts; direct GRNs never touch product prices.
      -- Changes are reported back so the client can confirm what was updated.
      v_new_sale := NULL;
      SELECT poi.sale_price, COALESCE(poi.force_cost_update, false)
        INTO v_new_sale, v_force_cost
      FROM purchase_order_items poi WHERE poi.id = v_po_item_id;
      IF v_new_sale IS NOT NULL THEN
        SELECT sale_price INTO v_before_sale FROM products WHERE id = v_product_id;
        UPDATE products SET sale_price = v_new_sale, updated_at = now()
        WHERE id = v_product_id AND sale_price IS DISTINCT FROM v_new_sale;
        IF FOUND THEN
          v_sale_updates := v_sale_updates || jsonb_build_object(
            'product_id', v_product_id,
            'name', (SELECT name FROM products p WHERE p.id = v_product_id),
            'before', COALESCE(v_before_sale, 0),
            'after', v_new_sale
          );
        END IF;
      END IF;
    END IF;

    -- FIFO layer with optional expiry_date. RETURNING gives the batch's
    -- unit_cost after the base-unit normalization trigger ran, so the forced
    -- cost write below compares like-for-like with products.cost_price.
    INSERT INTO inventory_batches (tenant_id, product_id, variant_id, warehouse_id, batch_number,
                                   quantity_received, quantity_remaining, unit_cost, batch_type,
                                   reference_type, reference_id, reference_number, notes, expiry_date)
    VALUES (v_tenant, v_product_id, NULL, v_wh,
            v_grn_number || '-' || left(v_product_id::text, 8),
            v_net_qty, v_net_qty, v_cost, 'purchase',
            'grn', v_grn_id, v_grn_number, COALESCE(p_notes, 'Goods received via GRN'), v_expiry)
    RETURNING unit_cost INTO v_batch_cost;

    -- On-hand counter: resync from the batch ledger (source of truth) instead
    -- of blind-incrementing. This heals the floor-at-0 divergence from
    -- overselling and any legacy counter drift on every receipt.
    SELECT COALESCE(SUM(quantity_remaining), 0) INTO v_ledger_sum
      FROM inventory_batches
     WHERE product_id = v_product_id AND warehouse_id = v_wh;

    SELECT ii.id INTO v_inv_item
      FROM inventory_items ii
     WHERE ii.product_id = v_product_id AND ii.warehouse_id = v_wh
     LIMIT 1;
    IF v_inv_item.id IS NOT NULL THEN
      UPDATE inventory_items
      SET quantity_on_hand = v_ledger_sum, updated_at = now()
      WHERE id = v_inv_item.id;
    ELSE
      INSERT INTO inventory_items (tenant_id, product_id, warehouse_id, quantity_on_hand)
      VALUES (v_tenant, v_product_id, v_wh, v_ledger_sum);
    END IF;

    -- Forced cost override: set the master cost to the received cost even when
    -- it is lower than the current one (the ratchet trigger above only raises).
    IF v_force_cost THEN
      UPDATE products SET cost_price = ROUND(v_batch_cost, 2), updated_at = now()
      WHERE id = v_product_id AND cost_price IS DISTINCT FROM ROUND(v_batch_cost, 2);
    END IF;

    SELECT cost_price INTO v_after_cost FROM products WHERE id = v_product_id;
    IF v_force_cost THEN
      IF v_after_cost IS DISTINCT FROM COALESCE(v_before_cost, 0) THEN
        v_cost_updates := v_cost_updates || jsonb_build_object(
          'product_id', v_product_id,
          'name', (SELECT name FROM products p WHERE p.id = v_product_id),
          'before', COALESCE(v_before_cost, 0),
          'after', v_after_cost,
          'forced', true
        );
      END IF;
    ELSIF v_after_cost > COALESCE(v_before_cost, 0) THEN
      v_cost_updates := v_cost_updates || jsonb_build_object(
        'product_id', v_product_id,
        'name', (SELECT name FROM products p WHERE p.id = v_product_id),
        'before', COALESCE(v_before_cost, 0),
        'after', v_after_cost
      );
    END IF;
  END LOOP;

  -- Journal entry (idempotent per GRN)
  PERFORM post_grn_journal(v_grn_id);

  -- PO status recompute
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

  -- Auto-fulfill pending purchase reminders
  UPDATE purchase_reminders
  SET status = 'fulfilled', fulfilled_at = now(), fulfilled_by_grn_id = v_grn_id, updated_at = now()
  WHERE status = 'pending'
    AND product_id IN (SELECT (j->>'product_id')::uuid FROM json_array_elements(p_items) j);

  RETURN json_build_object('grn_id', v_grn_id, 'grn_number', v_grn_number,
                           'cost_updates', v_cost_updates, 'sale_price_updates', v_sale_updates);
END $$;

GRANT EXECUTE ON FUNCTION receive_grn(uuid, uuid, uuid, json, text) TO authenticated;

COMMIT;
