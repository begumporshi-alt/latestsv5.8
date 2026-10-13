-- PO line-level sale price:
--   * purchase_order_items.sale_price carries the intended selling price
--     entered on the purchase order form (prefilled from products.sale_price).
--   * receive_grn pushes it onto products.sale_price when goods are received
--     against a PO (direct GRNs never touch product prices).
--   * Offline replay RPCs (po.create / po.update) carry the field too.

BEGIN;

ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS sale_price numeric(15,2);

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
  v_inv_item record;
  v_cost_updates jsonb := '[]'::jsonb;
  v_sale_updates jsonb := '[]'::jsonb;
  v_before_sale numeric;
  v_new_sale numeric;
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
    v_expiry := (v_item->>'expiry_date')::date;
    v_product_id := (v_item->>'product_id')::uuid;
    v_po_item_id := NULLIF(v_item->>'po_item_id', '')::uuid;
    IF v_qty <= 0 OR v_product_id IS NULL THEN
      CONTINUE;
    END IF;

    SELECT cost_price INTO v_before_cost FROM products WHERE id = v_product_id;

    INSERT INTO stock_movements (tenant_id, product_id, warehouse_id, movement_type,
                                 quantity, unit_cost, reference_type, reference_id, reference_number)
    VALUES (v_tenant, v_product_id, v_wh, 'purchase', v_qty, v_cost, 'grn', v_grn_id, v_grn_number);

    -- Counter upsert
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

      -- Push the PO line's intended sale price onto the product master.
      -- Only for PO-based receipts; direct GRNs never touch product prices.
      -- Changes are reported back so the client can confirm what was updated.
      v_new_sale := NULL;
      SELECT poi.sale_price INTO v_new_sale FROM purchase_order_items poi WHERE poi.id = v_po_item_id;
      IF v_new_sale IS NOT NULL THEN
        SELECT sale_price INTO v_before_sale FROM products WHERE id = v_product_id;
        UPDATE products SET sale_price = v_new_sale, updated_at = now()
        WHERE id = v_product_id AND sale_price IS DISTINCT FROM v_new_sale;
        IF FOUND THEN
          v_sale_updates := v_sale_updates || jsonb_build_object(
            'product_id', v_product_id,
            'name', (SELECT name FROM products WHERE id = v_product_id),
            'before', COALESCE(v_before_sale, 0),
            'after', v_new_sale
          );
        END IF;
      END IF;
    END IF;

    -- FIFO layer with optional expiry_date
    INSERT INTO inventory_batches (tenant_id, product_id, variant_id, warehouse_id, batch_number,
                                   quantity_received, quantity_remaining, unit_cost, batch_type,
                                   reference_type, reference_id, reference_number, notes, expiry_date)
    VALUES (v_tenant, v_product_id, NULL, v_wh,
            v_grn_number || '-' || left(v_product_id::text, 8),
            v_qty, v_qty, v_cost, 'purchase',
            'grn', v_grn_id, v_grn_number, COALESCE(p_notes, 'Goods received via GRN'), v_expiry);

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

-- Offline replay: po.create carries sale_price (original definition with the
-- item insert extended)
CREATE OR REPLACE FUNCTION public.sync_po_create(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_supplier uuid;
  v_number   text;
  v_paid     numeric := COALESCE((p_payload->>'amount_paid')::numeric, 0);
  v_po_id    uuid;
  v_pnum     text;
BEGIN
  v_supplier := (p_payload->>'supplier_id')::uuid;
  IF v_supplier IS NULL THEN
    RAISE EXCEPTION 'po.create: supplier_id is required';
  END IF;
  IF p_payload->'items' IS NULL OR jsonb_array_length(p_payload->'items') = 0 THEN
    RAISE EXCEPTION 'po.create: items array is required';
  END IF;

  v_number := public.generate_purchase_order_number();

  IF p_payload ? 'id' THEN
    INSERT INTO purchase_orders (id, po_number, supplier_id, order_date, expected_date,
      subtotal, cart_discount_percent, extra_discount, discount_amount, total_amount,
      amount_paid, status, notes, reference)
    VALUES ((p_payload->>'id')::uuid, v_number, v_supplier,
      COALESCE(NULLIF(p_payload->>'order_date', '')::date, current_date),
      NULLIF(p_payload->>'expected_date', '')::date,
      COALESCE((p_payload->>'subtotal')::numeric, 0),
      COALESCE((p_payload->>'cart_discount_percent')::numeric, 0),
      COALESCE((p_payload->>'extra_discount')::numeric, 0),
      COALESCE((p_payload->>'discount_amount')::numeric, 0),
      COALESCE((p_payload->>'total_amount')::numeric, 0),
      0, 'draft',
      NULLIF(p_payload->>'notes', ''),
      NULLIF(p_payload->>'reference', ''))
    RETURNING id INTO v_po_id;
  ELSE
    INSERT INTO purchase_orders (po_number, supplier_id, order_date, expected_date,
      subtotal, cart_discount_percent, extra_discount, discount_amount, total_amount,
      amount_paid, status, notes, reference)
    VALUES (v_number, v_supplier,
      COALESCE(NULLIF(p_payload->>'order_date', '')::date, current_date),
      NULLIF(p_payload->>'expected_date', '')::date,
      COALESCE((p_payload->>'subtotal')::numeric, 0),
      COALESCE((p_payload->>'cart_discount_percent')::numeric, 0),
      COALESCE((p_payload->>'extra_discount')::numeric, 0),
      COALESCE((p_payload->>'discount_amount')::numeric, 0),
      COALESCE((p_payload->>'total_amount')::numeric, 0),
      0, 'draft',
      NULLIF(p_payload->>'notes', ''),
      NULLIF(p_payload->>'reference', ''))
    RETURNING id INTO v_po_id;
  END IF;

  INSERT INTO purchase_order_items (purchase_order_id, product_id, quantity, unit_cost,
    discount_percent, subtotal, unit_name, unit_conversion_factor, base_quantity, warehouse_id, sale_price)
  SELECT v_po_id,
    (r->>'product_id')::uuid,
    (r->>'quantity')::numeric,
    (r->>'unit_cost')::numeric,
    COALESCE((r->>'discount_percent')::numeric, 0),
    (r->>'subtotal')::numeric,
    NULLIF(r->>'unit_name', ''),
    NULLIF(r->>'unit_conversion_factor', '')::numeric,
    (r->>'base_quantity')::numeric,
    NULLIF(r->>'warehouse_id', '')::uuid,
    NULLIF(r->>'sale_price', '')::numeric
  FROM jsonb_array_elements(p_payload->'items') r;

  IF v_paid > 0 THEN
    v_pnum := public.generate_purchase_payment_number();
    INSERT INTO payments (payment_number, payment_type, reference_type, reference_id, supplier_id,
      amount, payment_method, payment_date, reference_number, notes, payment_for)
    VALUES (COALESCE(v_pnum, 'POPAY-' || to_char(now(), 'HH24MISS')),
      'made', 'purchase_order', v_po_id, v_supplier,
      v_paid,
      COALESCE(p_payload->>'payment_method', 'cash'),
      COALESCE(NULLIF(p_payload->>'payment_date', '')::date, current_date),
      NULLIF(p_payload->>'payment_reference', ''),
      COALESCE(NULLIF(p_payload->>'payment_notes', ''),
        CASE WHEN v_paid >= (p_payload->>'total_amount')::numeric
          THEN 'Full payment at order time' ELSE 'Partial payment at order time' END),
      'supplier_payment');
  END IF;

  RETURN jsonb_build_object('status', 'synced', 'po_id', v_po_id, 'po_number', v_number);
END;
$$;

-- Offline replay: po.update carries sale_price
CREATE OR REPLACE FUNCTION public.sync_po_update(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_po  purchase_orders%rowtype;
  v_new_total numeric;
BEGIN
  SELECT * INTO v_po FROM purchase_orders WHERE id = (p_payload->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'po.update: purchase order not found';
  END IF;
  IF v_po.status = 'cancelled' THEN
    RAISE EXCEPTION 'po.update: purchase order % is cancelled', v_po.po_number;
  END IF;

  IF COALESCE((p_payload->>'force')::boolean, false) = false
     AND p_payload ? 'expected_updated_at'
     AND p_payload->>'expected_updated_at' <> ''
     AND v_po.updated_at <> (p_payload->>'expected_updated_at')::timestamptz THEN
    RETURN jsonb_build_object(
      'status', 'conflict',
      'reason', 'Purchase order changed on the server since this device last saw it',
      'server_row', to_jsonb(v_po)
    );
  END IF;

  v_new_total := COALESCE((p_payload->>'total_amount')::numeric, v_po.total_amount);

  UPDATE purchase_orders SET
    supplier_id  = (p_payload->>'supplier_id')::uuid,
    order_date   = COALESCE(NULLIF(p_payload->>'order_date', '')::date, order_date),
    expected_date = NULLIF(p_payload->>'expected_date', '')::date,
    subtotal     = COALESCE((p_payload->>'subtotal')::numeric, subtotal),
    cart_discount_percent = COALESCE((p_payload->>'cart_discount_percent')::numeric, 0),
    extra_discount = COALESCE((p_payload->>'extra_discount')::numeric, 0),
    discount_amount = COALESCE((p_payload->>'discount_amount')::numeric, 0),
    total_amount = v_new_total,
    notes        = NULLIF(p_payload->>'notes', ''),
    reference    = NULLIF(p_payload->>'reference', ''),
    amount_paid  = LEAST(amount_paid, v_new_total),
    updated_at   = now()
  WHERE id = v_po.id;

  DELETE FROM purchase_order_items WHERE purchase_order_id = v_po.id;
  INSERT INTO purchase_order_items (purchase_order_id, product_id, quantity, unit_cost,
    discount_percent, subtotal, unit_name, unit_conversion_factor, base_quantity, warehouse_id, sale_price)
  SELECT v_po.id,
    (r->>'product_id')::uuid,
    (r->>'quantity')::numeric,
    (r->>'unit_cost')::numeric,
    COALESCE((r->>'discount_percent')::numeric, 0),
    (r->>'subtotal')::numeric,
    NULLIF(r->>'unit_name', ''),
    NULLIF(r->>'unit_conversion_factor', '')::numeric,
    (r->>'base_quantity')::numeric,
    NULLIF(r->>'warehouse_id', '')::uuid,
    NULLIF(r->>'sale_price', '')::numeric
  FROM jsonb_array_elements(p_payload->'items') r;

  RETURN jsonb_build_object('status', 'synced', 'po_id', v_po.id, 'po_number', v_po.po_number);
END;
$$;

COMMIT;
