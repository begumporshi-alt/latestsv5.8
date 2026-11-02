-- receive_grn: convert multi-unit PO lines to base units
--
-- A PO line is raised in its purchase unit (1 box, unit_cost per box) while
-- FIFO batches, stock movements, on-hand counters and the cost ratchet are
-- all kept in the product's base unit (coils). The RPC previously posted the
-- purchase-unit quantity and the per-purchase-unit cost straight into those
-- base-unit tables: receiving 1 box of 12 coils created a batch of 1 unit at
-- 12x the cost, marked the PO fully received, and the cost ratchet then
-- corrupted products.cost_price with the per-box figure.
--
-- The conversion now happens here, once, server-side: the payload quantity
-- stays in purchase units (no client change, offline replay fixed too), and
-- both quantity and cost are normalized to the base unit before anything is
-- written. received_quantity remains in purchase units to match the status
-- recompute. Direct GRNs (no PO line) have no conversion context and are
-- unchanged.
--
-- Rollout note: all existing purchase_order_items have
-- unit_conversion_factor = 1/null, so historical receipts are unaffected.

CREATE OR REPLACE FUNCTION public.receive_grn(p_supplier_id uuid, p_purchase_order_id uuid DEFAULT NULL::uuid, p_warehouse_id uuid DEFAULT NULL::uuid, p_items json DEFAULT NULL::json, p_notes text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_item_wh uuid;
  v_poi_warehouse uuid;
  v_first_wh uuid;
  v_mixed_wh boolean := false;
  v_before_cost numeric;
  v_after_cost numeric;
  v_batch_cost numeric;
  v_force_cost boolean := false;
  v_poi_unit_cost numeric;
  v_poi_discount numeric;
  -- Multi-unit lines: the PO line is raised in a purchase unit (box) while
  -- batches, movements and counters are kept in the product's base unit
  -- (coil). v_conv is how many base units one purchase unit contains.
  v_poi_conv numeric;
  v_conv numeric := 1;
  v_qty_base numeric;
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
  -- Absorption accounting (this GRN, all items):
  --   v_absorb_value          = absorbed units valued at the IOU batches' own cost
  --   v_absorb_receipt_value  = same units valued at this receipt's cost
  v_absorb_value numeric := 0;
  v_absorb_receipt_value numeric := 0;
  v_line_details jsonb := '[]'::jsonb;
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
    --
    -- Multi-unit lines are also converted here, in ONE place. The PO line is
    -- raised in a purchase unit (1 box) but batches, movements, counters and
    -- the ratchet are all base-unit (12 coils): the payload quantity is
    -- purchase units and the PO's unit_cost is per purchase unit, so both are
    -- divided/multiplied by the line's conversion factor. received_quantity
    -- stays in purchase units — the status recompute compares it with the
    -- line's ordered quantity, which is also in purchase units.
    v_conv := 1;
    v_qty_base := v_qty;
    IF v_po_item_id IS NOT NULL THEN
      SELECT unit_cost, COALESCE(discount_percent, 0), warehouse_id, unit_conversion_factor
        INTO v_poi_unit_cost, v_poi_discount, v_poi_warehouse, v_poi_conv
      FROM purchase_order_items WHERE id = v_po_item_id;
      IF FOUND THEN
        v_conv := COALESCE(NULLIF(v_poi_conv, 0), 1);
        v_cost := v_poi_unit_cost * (1 - v_poi_discount / 100) / v_conv;
        v_qty_base := v_qty * v_conv;
      END IF;
    END IF;

    -- Each line lands in the warehouse it was raised for: explicit payload
    -- value, else the PO line's "Receive Into" warehouse, else the GRN's
    -- default. This is what makes a PO raised against a warehouse with an
    -- outstanding IOU actually heal that IOU.
    v_item_wh := COALESCE(
      NULLIF(v_item->>'warehouse_id', '')::uuid,
      v_poi_warehouse,
      v_wh
    );
    IF v_first_wh IS NULL THEN
      v_first_wh := v_item_wh;
    ELSIF v_first_wh IS DISTINCT FROM v_item_wh THEN
      v_mixed_wh := true;
    END IF;

    SELECT cost_price INTO v_before_cost FROM products WHERE id = v_product_id;

    -- Absorption math runs before the movement insert so the movement can
    -- carry the IOU marker (mirrors the sale-side "OVERSOLD by N" note).
    SELECT COALESCE(-SUM(quantity_remaining), 0) INTO v_owed
      FROM inventory_batches
     WHERE product_id = v_product_id AND warehouse_id = v_item_wh
       AND quantity_remaining < 0;
    v_absorbed := LEAST(v_owed, v_qty_base);
    v_net_qty := v_qty_base - v_absorbed;

    INSERT INTO stock_movements (tenant_id, product_id, warehouse_id, movement_type,
                                 quantity, unit_cost, reference_type, reference_id, reference_number, notes)
    VALUES (v_tenant, v_product_id, v_item_wh, 'purchase', v_qty_base, v_cost, 'grn', v_grn_id, v_grn_number,
            CASE WHEN v_absorbed > 0 THEN
              'Goods received — absorbed ' || trim_scale(v_absorbed) || ' base unit(s) of OVERSOLD IOU (net ' || trim_scale(v_net_qty) || ' added to stock)'
            ELSE NULL END);

    -- Absorb outstanding oversell IOU layers (negative FIFO-SHORTFALL batches)
    -- into this receipt: drive them back to 0, oldest first, and post the new
    -- batch net of what was owed. Batches and v_qty_base share the same
    -- base-unit convention, so the arithmetic is direct.
    IF v_absorbed > 0 THEN
      v_absorb_left := v_absorbed;
      FOR v_iou IN
        SELECT id, quantity_remaining, unit_cost
          FROM inventory_batches
         WHERE product_id = v_product_id AND warehouse_id = v_item_wh
           AND quantity_remaining < 0
         ORDER BY created_at ASC, id ASC
         FOR UPDATE
      LOOP
        EXIT WHEN v_absorb_left <= 0;
        v_take := LEAST(-v_iou.quantity_remaining, v_absorb_left);
        UPDATE inventory_batches
           SET quantity_remaining = quantity_remaining + v_take
         WHERE id = v_iou.id;
        v_absorb_value := v_absorb_value + v_take * COALESCE(v_iou.unit_cost, 0);
        v_absorb_receipt_value := v_absorb_receipt_value + v_take * v_cost;
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

    -- FIFO layer with optional expiry_date, in BASE units. quantity_received
    -- keeps the GROSS physical receipt (what the supplier actually delivered —
    -- the FIFO page and batches modal display it); quantity_remaining carries
    -- the net after IOU absorption. The weighted-average trigger below reads
    -- unit_cost, which is per base unit, so the ratchet compares
    -- like-for-like with products.cost_price.
    INSERT INTO inventory_batches (tenant_id, product_id, variant_id, warehouse_id, batch_number,
                                   quantity_received, quantity_remaining, unit_cost, batch_type,
                                   reference_type, reference_id, reference_number, notes, expiry_date)
    VALUES (v_tenant, v_product_id, NULL, v_item_wh,
            v_grn_number || '-' || left(v_product_id::text, 8),
            v_qty_base, v_net_qty, v_cost, 'purchase',
            'grn', v_grn_id, v_grn_number, COALESCE(p_notes, 'Goods received via GRN'), v_expiry)
    RETURNING unit_cost INTO v_batch_cost;

    -- On-hand counter: resync from the batch ledger (source of truth) instead
    -- of blind-incrementing. This heals the floor-at-0 divergence from
    -- overselling and any legacy counter drift on every receipt.
    SELECT COALESCE(SUM(quantity_remaining), 0) INTO v_ledger_sum
      FROM inventory_batches
     WHERE product_id = v_product_id AND warehouse_id = v_item_wh;

    SELECT ii.id INTO v_inv_item
      FROM inventory_items ii
     WHERE ii.product_id = v_product_id AND ii.warehouse_id = v_item_wh
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

    v_line_details := v_line_details || jsonb_build_object(
      'product_id', v_product_id,
      'quantity', v_qty,
      'unit_name', v_item->>'unit_name',
      'quantity_base', v_qty_base,
      'unit_cost_base', v_cost);

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

  -- Journal entry (idempotent per GRN). Absorption figures post the gross AP
  -- credit and the IOU cost-basis correction — see migration header.
  PERFORM post_grn_journal(v_grn_id, v_absorb_value, v_absorb_receipt_value);

  -- When every line landed in the same (non-default) warehouse, align the GRN
  -- header so the receipt displays where the goods actually went. Mixed-
  -- warehouse receipts keep the default warehouse on the header.
  IF NOT v_mixed_wh AND v_first_wh IS NOT NULL AND v_first_wh IS DISTINCT FROM v_wh THEN
    UPDATE goods_receipt_notes SET warehouse_id = v_first_wh WHERE id = v_grn_id;
  END IF;

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
                           'cost_updates', v_cost_updates, 'sale_price_updates', v_sale_updates,
                           'items', v_line_details);
END $function$
