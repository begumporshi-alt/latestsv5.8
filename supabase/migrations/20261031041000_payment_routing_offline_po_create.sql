-- ============================================================================
-- Payment bank-account routing -- offline PO creation
-- ============================================================================
-- Companion to 20261031040000_payment_bank_account_routing.sql.
--
-- `sync_po_create()` is the offline replay for a purchase order created with an
-- immediate full/partial payment. It inserts into `payments` directly, so it
-- needs to carry the chosen account the same way `sync_po_payment()` does.
-- Without this, an offline PO payment would still fall back to the
-- payment_methods mapping and land on the wrong bank.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.sync_po_create(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_supplier uuid;
  v_number   text;
  v_paid     numeric := COALESCE((p_payload->>'amount_paid')::numeric, 0);
  v_po_id    uuid;
  v_pnum     text;
  v_account_id uuid;
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
    discount_percent, subtotal, unit_name, unit_conversion_factor, base_quantity, warehouse_id,
    sale_price, force_cost_update)
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
    NULLIF(r->>'sale_price', '')::numeric,
    COALESCE((r->>'force_cost_update')::boolean, false)
  FROM jsonb_array_elements(p_payload->'items') r;

  IF v_paid > 0 THEN
    v_account_id := public.resolve_payment_account(
      NULLIF(p_payload->>'account_id', '')::uuid,
      COALESCE(p_payload->>'payment_method', 'cash')
    );

    v_pnum := public.generate_purchase_payment_number();
    INSERT INTO payments (payment_number, payment_type, reference_type, reference_id, supplier_id,
      amount, payment_method, payment_date, reference_number, notes, payment_for, account_id)
    VALUES (COALESCE(v_pnum, 'POPAY-' || to_char(now(), 'HH24MISS')),
      'made', 'purchase_order', v_po_id, v_supplier,
      v_paid,
      COALESCE(p_payload->>'payment_method', 'cash'),
      COALESCE(NULLIF(p_payload->>'payment_date', '')::date, current_date),
      NULLIF(p_payload->>'payment_reference', ''),
      COALESCE(NULLIF(p_payload->>'payment_notes', ''),
        CASE WHEN v_paid >= (p_payload->>'total_amount')::numeric
          THEN 'Full payment at order time' ELSE 'Partial payment at order time' END),
      'supplier_payment',
      v_account_id);
  END IF;

  RETURN jsonb_build_object('status', 'synced', 'po_id', v_po_id, 'po_number', v_number);
END;
$function$;

COMMIT;
