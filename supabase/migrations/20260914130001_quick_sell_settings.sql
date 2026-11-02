-- Quick Sell corrections (owner review 2026-09-14):
-- 1) products.is_quick_sell marks catalog entries created by Quick Sell so
--    the inventory products list can exclude them (admin setting, default
--    hidden). track_inventory=false alone is not enough — non-stock products
--    can also be created manually from the inventory form, and those should
--    stay listed.
-- 2) Admin setting `quick_sell` in app_settings:
--      { show_in_inventory: boolean (default false),
--        show_qty: boolean (default false) }
--    Consumers read it with those defaults; no seed row needed.
-- No journal/accounting changes — this is catalog visibility only.

BEGIN;

ALTER TABLE public.products ADD COLUMN IF NOT EXISTS is_quick_sell boolean NOT NULL DEFAULT false;

-- Backfill: every product ever sold on a quick-sell invoice, plus the QS-*
-- SKUs the RPC assigns (covers entries created but never sold).
UPDATE public.products
   SET is_quick_sell = true
 WHERE NOT track_inventory
   AND (
     sku LIKE 'QS-%'
     OR id IN (
       SELECT DISTINCT ii.product_id
         FROM invoice_items ii
         JOIN invoices i ON i.id = ii.invoice_id
        WHERE i.is_quick_sell
     )
   );

-- ═══════════════════════════════════════════════════════════════════════════
-- quick_sell_create: auto-created products carry the marker. Full re-create
-- of the live (20260914110000) body with one INSERT column added.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.quick_sell_create(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_key             text;
  v_is_pos          boolean;
  v_number          text;
  v_invoice_id      uuid;
  v_customer        uuid;
  v_date            date;
  v_due_date        date;
  v_payment_term    text;
  v_partial         numeric;
  v_store_credit    numeric;
  v_cash            numeric;
  v_cash_method     text;
  v_cost_method     text;
  v_subtotal        numeric := 0;
  v_total           numeric;
  v_amount_paid     numeric;
  v_status          text;
  v_item            jsonb;
  v_i               int := 0;
  v_product_id      uuid;
  v_name_norm       text;
  v_created_count   int := 0;
  v_reused_count    int := 0;
  v_sku             text;
  v_unit            text;
  v_qty             numeric;
  v_price           numeric;
  v_cost            numeric;
  v_disc            numeric;
  v_remaining       numeric;
  v_redeem          numeric;
  v_scnum           text;
  v_pnum            text;
  v_credit          record;
BEGIN
  v_customer     := (p_payload->>'customer_id')::uuid;
  v_date         := COALESCE((p_payload->>'invoice_date')::date, CURRENT_DATE);
  v_due_date     := NULLIF(p_payload->>'due_date', '')::date;
  v_key          := NULLIF(p_payload->>'idempotency_key', '');
  v_is_pos       := COALESCE((p_payload->>'is_pos')::boolean, true);
  v_payment_term := COALESCE(NULLIF(p_payload->>'payment_term', ''), 'full');
  v_partial      := COALESCE((p_payload->>'partial_amount')::numeric, 0);
  v_store_credit := COALESCE((p_payload->>'store_credit_amount')::numeric, 0);
  v_cash         := COALESCE((p_payload->'cash_payment'->>'amount')::numeric, 0);
  v_cash_method  := COALESCE(NULLIF(p_payload->'cash_payment'->>'method', ''), 'cash');
  v_cost_method  := COALESCE(NULLIF(p_payload->>'cost_payment_method', ''), 'cash');

  IF v_customer IS NULL THEN
    RAISE EXCEPTION 'quick_sell_create: customer_id is required (quick sells are for standing customers)';
  END IF;
  IF p_payload->'items' IS NULL OR jsonb_array_length(p_payload->'items') = 0 THEN
    RAISE EXCEPTION 'quick_sell_create: items array is required';
  END IF;
  IF v_payment_term NOT IN ('full', 'partial', 'credit') THEN
    RAISE EXCEPTION 'quick_sell_create: payment_term must be full, partial or credit';
  END IF;
  IF v_payment_term = 'partial' AND v_partial <= 0 THEN
    RAISE EXCEPTION 'quick_sell_create: partial payment requires partial_amount > 0';
  END IF;
  IF v_cash < 0 OR v_partial < 0 OR v_store_credit < 0 THEN
    RAISE EXCEPTION 'quick_sell_create: payment amounts cannot be negative';
  END IF;

  -- Idempotency: a replayed key returns the original invoice.
  IF v_key IS NOT NULL THEN
    SELECT id, invoice_number INTO v_invoice_id, v_number
      FROM invoices WHERE idempotency_key = v_key;
    IF v_invoice_id IS NOT NULL THEN
      RETURN jsonb_build_object('status', 'duplicate', 'invoice_id', v_invoice_id, 'invoice_number', v_number);
    END IF;
  END IF;

  -- Validate items up front (fail before anything is written).
  FOR v_i IN 0..(jsonb_array_length(p_payload->'items') - 1) LOOP
    v_item := p_payload->'items'->v_i;
    v_qty  := COALESCE((v_item->>'quantity')::numeric, 0);
    v_price := COALESCE((v_item->>'sale_price')::numeric, 0);
    v_cost := COALESCE((v_item->>'cost_price')::numeric, 0);
    IF NULLIF(TRIM(COALESCE(v_item->>'name', '')), '') IS NULL
       AND (v_item->>'product_id')::uuid IS NULL THEN
      RAISE EXCEPTION 'quick_sell_create: item % needs a name or product_id', v_i + 1;
    END IF;
    IF v_qty <= 0 THEN
      RAISE EXCEPTION 'quick_sell_create: item "%" has quantity % — must be > 0', COALESCE(v_item->>'name', v_item->>'product_id'), v_qty;
    END IF;
    IF v_price < 0 OR v_cost < 0 THEN
      RAISE EXCEPTION 'quick_sell_create: item "%" has negative price/cost', COALESCE(v_item->>'name', v_item->>'product_id');
    END IF;
    v_subtotal := v_subtotal + v_qty * v_price * (1 - COALESCE((v_item->>'discount_percent')::numeric, 0) / 100);
  END LOOP;

  v_total := GREATEST(
    0,
    v_subtotal
      - (v_subtotal * COALESCE((p_payload->>'cart_discount_percent')::numeric, 0)) / 100
      - COALESCE((p_payload->>'extra_discount')::numeric, 0)
  ) + COALESCE((p_payload->>'tax_amount')::numeric, 0);

  -- Amount paid / status mirror POS processOrder semantics.
  IF v_payment_term = 'full' THEN
    v_amount_paid := v_total;
    v_status := CASE WHEN v_store_credit > 0 AND (v_total - v_store_credit) > 0
                     THEN 'partially_paid' ELSE 'paid' END;
  ELSIF v_payment_term = 'partial' THEN
    v_amount_paid := LEAST(v_partial, v_total);
    v_status := 'partially_paid';
  ELSE
    v_amount_paid := 0;
    v_status := 'sent';
  END IF;

  IF v_is_pos THEN
    v_number := public.generate_pos_number();
  ELSE
    v_number := public.generate_invoice_number();
  END IF;

  INSERT INTO invoices (invoice_number, customer_id, invoice_date, due_date, subtotal, discount_amount,
    cart_discount_percent, extra_discount, tax_amount, shipping_cost, total_amount, amount_paid,
    status, is_pos, reference, notes, idempotency_key, is_quick_sell, cost_payment_method)
  VALUES (v_number, v_customer, v_date, v_due_date, v_subtotal,
    (v_subtotal * COALESCE((p_payload->>'cart_discount_percent')::numeric, 0)) / 100,
    COALESCE((p_payload->>'cart_discount_percent')::numeric, 0),
    COALESCE((p_payload->>'extra_discount')::numeric, 0),
    COALESCE((p_payload->>'tax_amount')::numeric, 0),
    0,
    v_total, v_amount_paid, v_status, v_is_pos,
    NULLIF(p_payload->>'reference', ''),
    NULLIF(p_payload->>'notes', ''),
    v_key, true, v_cost_method)
  RETURNING id INTO v_invoice_id;

  -- Resolve / create products, then write items + cost history.
  FOR v_i IN 0..(jsonb_array_length(p_payload->'items') - 1) LOOP
    v_item := p_payload->'items'->v_i;
    v_qty  := COALESCE((v_item->>'quantity')::numeric, 0);
    v_price := COALESCE((v_item->>'sale_price')::numeric, 0);
    v_cost := COALESCE((v_item->>'cost_price')::numeric, 0);
    v_disc := COALESCE((v_item->>'discount_percent')::numeric, 0);
    v_unit := COALESCE(NULLIF(v_item->>'unit', ''), 'pcs');
    v_name_norm := LOWER(REGEXP_REPLACE(TRIM(COALESCE(v_item->>'name', '')), '\s+', ' ', 'g'));

    v_product_id := NULLIF(v_item->>'product_id', '')::uuid;

    IF v_product_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM products p WHERE p.id = v_product_id AND NOT p.track_inventory) THEN
        RAISE EXCEPTION 'quick_sell_create: product % is stocked (or missing) — stocked items must be sold through the regular sale flow', v_product_id;
      END IF;
      v_reused_count := v_reused_count + 1;
    ELSE
      SELECT p.id INTO v_product_id
        FROM products p
       WHERE NOT p.track_inventory AND LOWER(REGEXP_REPLACE(TRIM(p.name), '\s+', ' ', 'g')) = v_name_norm
       LIMIT 2;
      IF v_product_id IS NOT NULL THEN
        -- Ambiguous normalized name among non-stock products? (LIMIT 2 caught
        -- at least one; re-check for a second.)
        IF EXISTS (
          SELECT 1 FROM products p2
           WHERE NOT p2.track_inventory
             AND LOWER(REGEXP_REPLACE(TRIM(p2.name), '\s+', ' ', 'g')) = v_name_norm
             AND p2.id <> v_product_id
        ) THEN
          RAISE EXCEPTION 'quick_sell_create: "%" matches several non-stock products — pick one explicitly', v_item->>'name';
        END IF;
        v_reused_count := v_reused_count + 1;
      ELSIF EXISTS (
        SELECT 1 FROM products p
         WHERE p.track_inventory
           AND LOWER(REGEXP_REPLACE(TRIM(p.name), '\s+', ' ', 'g')) = v_name_norm
      ) THEN
        RAISE EXCEPTION 'quick_sell_create: "%" is a stocked product — sell it through the regular sale flow (or receive stock first)', v_item->>'name';
      ELSE
        v_sku := 'QS-' || lpad(nextval('quick_sell_sku_seq')::text, 5, '0');
        INSERT INTO products (sku, name, unit, base_unit, cost_price, sale_price,
                              track_inventory, is_quick_sell, is_active, min_stock_level, description)
        VALUES (v_sku, TRIM(v_item->>'name'), v_unit, v_unit, v_cost, v_price,
                false, true, true, 0, 'Quick-sell (non-stock) item — bought on demand, never stocked')
        RETURNING id INTO v_product_id;
        v_created_count := v_created_count + 1;
      END IF;
    END IF;

    -- Keep the product defaults fresh for next time (cost/price of the most
    -- recent quick sell; single unit so base scale == sale scale).
    UPDATE products
       SET cost_price = v_cost, sale_price = v_price, updated_at = now()
     WHERE id = v_product_id AND NOT track_inventory;

    INSERT INTO invoice_items (invoice_id, product_id, quantity, unit_price, cost_price,
      discount_percent, tax_rate, subtotal, unit_name, unit_conversion_factor,
      base_quantity, source_shop, sort_order)
    VALUES (v_invoice_id, v_product_id, v_qty, v_price, v_cost,
      v_disc, 0, v_qty * v_price * (1 - v_disc / 100), v_unit, 1,
      v_qty, NULLIF(v_item->>'source_shop', ''), v_i);

    INSERT INTO cost_price_history (product_id, product_name, product_sku, invoice_id, unit,
      quantity, unit_price, cost_price_per_qty, cost_price_for_added_qty,
      total_cost_price_single, total_cost_price_added)
    SELECT v_product_id, p.name, COALESCE(p.sku, ''), v_invoice_id, v_unit,
      v_qty, v_price, v_cost, v_cost * v_qty, v_cost, v_cost * v_qty
    FROM products p WHERE p.id = v_product_id;
  END LOOP;

  -- The Quick Sell Cost JE is posted by trg_post_cogs_je_from_item_insert on
  -- the item INSERTs above (non-draft invoice). Nothing further needed here.

  -- Store credit redemption: same fresh re-select + oldest-first loop as POS.
  IF v_store_credit > 0 THEN
    v_remaining := v_store_credit;
    FOR v_credit IN
      SELECT id, balance FROM customer_store_credits
       WHERE customer_id = v_customer AND status = 'active'
         AND (expires_at IS NULL OR expires_at > now())
       ORDER BY created_at ASC
    LOOP
      EXIT WHEN v_remaining <= 0;
      v_redeem := LEAST(COALESCE(v_credit.balance, 0), v_remaining);
      IF v_redeem > 0 THEN
        INSERT INTO store_credit_redemptions (store_credit_id, customer_id, invoice_id, amount, notes)
        VALUES (v_credit.id, v_customer, v_invoice_id, v_redeem, 'Redeemed for ' || v_number);
        v_remaining := v_remaining - v_redeem;
      END IF;
    END LOOP;

    v_scnum := public.generate_payment_number();
    INSERT INTO payments (payment_number, payment_type, reference_type, reference_id, customer_id,
      amount, payment_method, payment_date, notes, payment_for)
    VALUES ('PAY-SC-' || REPLACE(COALESCE(v_scnum, ''), 'PAY-', ''),
      'received', 'invoice', v_invoice_id, v_customer,
      v_store_credit, 'store_credit', v_date,
      'Store credit redeemed for ' || v_number, 'paid_invoice_pay');
  END IF;

  IF v_cash > 0 THEN
    v_pnum := public.generate_payment_number();
    INSERT INTO payments (payment_number, payment_type, reference_type, reference_id, customer_id,
      amount, payment_method, payment_date, reference_number, notes, payment_for)
    VALUES (COALESCE(v_pnum, 'PAY-' || to_char(now(), 'HH24MISS')),
      'received', 'invoice', v_invoice_id, v_customer,
      v_cash, v_cash_method, v_date,
      NULLIF(p_payload->'cash_payment'->>'reference_number', ''),
      'Quick sell ' || v_number, 'paid_invoice_pay');
  END IF;

  RETURN jsonb_build_object(
    'status', 'created',
    'invoice_id', v_invoice_id,
    'invoice_number', v_number,
    'total', v_total,
    'products_created', v_created_count,
    'products_reused', v_reused_count
  );
END
$function$;

REVOKE EXECUTE ON FUNCTION public.quick_sell_create(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.quick_sell_create(jsonb) TO authenticated;

DO $$
BEGIN
  RAISE NOTICE 'quick_sell_settings: applied — products.is_quick_sell marker live; quick_sell_create stamps new auto-created products';
END $$;

COMMIT;
