-- Quick Sell atomic RPC + trigger wiring for the cost JE.
--
-- quick_sell_create(p_payload) creates a complete quick-sell sale in ONE
-- transaction: resolves (or auto-creates) non-stock products, inserts the
-- invoice (is_quick_sell) + items (manual per-sale-unit cost, source shop
-- note) + cost_price_history + payments/store-credit redemption. All journal
-- entries come from the existing (quick-sell-aware, 20260914100000) triggers;
-- the cost leg is posted by post_cogs_je_from_item_insert, which this
-- migration extends to refresh the Quick Sell Cost JE on every non-draft
-- invoice_items INSERT — so POS, the invoice modal, the offline
-- sync_invoice_create replay and this RPC all post it identically without
-- each writer needing an explicit call.
--
-- Idempotency: invoices.idempotency_key (unique index, 20260911120000).
-- A replayed key returns the original invoice as status 'duplicate'.
--
-- Product identity rules (design review 2026-09-14):
--   * explicit product_id must reference a track_inventory=false product;
--   * name matching is exact on the normalized name (lower/trim/collapse
--     whitespace) among non-stock products only; an ambiguous name (multiple
--     non-stock matches) is rejected rather than silently merged;
--   * a name that matches a STOCKED product is rejected with guidance;
--   * no match creates a fresh non-stock product (QS- SKU sequence, single
--     unit, entered cost/price as defaults) and reuses it on later sales.

BEGIN;

-- Human-friendly SKUs for auto-created quick-sell products (QS-00001…).
CREATE SEQUENCE IF NOT EXISTS quick_sell_sku_seq START 1;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1) post_cogs_je_from_item_insert: also refresh the Quick Sell Cost JE.
--    Full re-create of the live 20260902090000 version + one PERFORM. The
--    call sits BEFORE the stocked-account lookups so a missing 1200 can never
--    block the quick-sell leg, and is idempotent (aggregate refresh).
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.post_cogs_je_from_item_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_invoice RECORD;
  v_cogs_account uuid;
  v_inventory_account uuid;
  v_total_cogs decimal(15,2) := 0;
  v_lines json[] := '{}';
  v_line_count int := 0;
  v_item RECORD;
  v_product RECORD;
  v_cogs_amount decimal(15,2);
  v_qty numeric;
  v_desc text;
  v_existing_je_id uuid;
  v_old_cogs_net numeric;
  v_old_inv_net numeric;
  v_new_cogs_net numeric;
  v_new_inv_net numeric;
BEGIN
  -- Only fire on INSERT
  IF TG_OP != 'INSERT' THEN
    RETURN NEW;
  END IF;

  -- Get the parent invoice
  SELECT * INTO v_invoice FROM invoices WHERE id = NEW.invoice_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  -- Only fire when invoice is non-draft (status is sent, partially_paid, or paid)
  IF v_invoice.status NOT IN ('sent', 'partially_paid', 'paid') THEN
    RETURN NEW;
  END IF;

  -- Quick-sell (non-stock) cost leg: Dr 5000 / Cr paid-from account. No-op
  -- when this item (and the invoice) carries no non-stock cost; idempotent
  -- refresh when several items insert in sequence.
  PERFORM post_quick_sell_cost_je(NEW.invoice_id);

  -- Get accounts
  SELECT id INTO v_cogs_account FROM accounts WHERE code = '5000' LIMIT 1;
  SELECT id INTO v_inventory_account FROM accounts WHERE code = '1200' LIMIT 1;
  IF v_cogs_account IS NULL OR v_inventory_account IS NULL THEN
    RETURN NEW;
  END IF;

  -- Check if COGS JE already exists (for UPDATE instead of skip)
  SELECT id INTO v_existing_je_id FROM journal_entries
  WHERE reference_type = 'invoice' AND reference_id = v_invoice.id
  AND description LIKE 'COGS%';

  -- Process ALL items for this invoice
  FOR v_item IN
    SELECT ii.* FROM invoice_items ii
    WHERE ii.invoice_id = NEW.invoice_id
    ORDER BY ii.sort_order
  LOOP
    v_qty := v_item.quantity;
    IF v_qty <= 0 THEN CONTINUE; END IF;

    -- Get COGS from FIFO consumption records
    SELECT COALESCE(SUM(cogs_amount), 0) INTO v_cogs_amount
    FROM invoice_item_batch_consumption
    WHERE invoice_item_id = v_item.id;

    IF v_cogs_amount > 0 THEN
      v_total_cogs := v_total_cogs + v_cogs_amount;
      v_line_count := v_line_count + 1;

      SELECT name, sku INTO v_product FROM products WHERE id = v_item.product_id;

      v_desc := 'COGS (FIFO): ' || COALESCE(v_product.name, 'Unknown') ||
        ' (SKU: ' || COALESCE(v_product.sku, 'N/A') || ') - Qty: ' || v_qty ||
        ' x Avg Cost: ' || round(v_cogs_amount / v_qty, 2) || ' = ' || v_cogs_amount;

      v_lines := array_append(v_lines, json_build_object(
        'account_id', v_cogs_account, 'debit', v_cogs_amount, 'credit', 0,
        'description', v_desc
      ));
      v_lines := array_append(v_lines, json_build_object(
        'account_id', v_inventory_account, 'debit', 0, 'credit', v_cogs_amount,
        'description', 'Inventory released (FIFO): ' || COALESCE(v_product.name, 'Unknown') ||
          ' (Qty: ' || v_qty || ') for ' || v_invoice.invoice_number
      ));
    END IF;
  END LOOP;

  -- Post or UPDATE the aggregated COGS JE
  IF v_total_cogs > 0 THEN
    IF v_existing_je_id IS NOT NULL THEN
      SELECT COALESCE(SUM(debit - credit), 0) INTO v_old_cogs_net
      FROM journal_lines WHERE journal_entry_id = v_existing_je_id AND account_id = v_cogs_account;
      SELECT COALESCE(SUM(debit - credit), 0) INTO v_old_inv_net
      FROM journal_lines WHERE journal_entry_id = v_existing_je_id AND account_id = v_inventory_account;

      DELETE FROM journal_lines WHERE journal_entry_id = v_existing_je_id;

      FOR i IN 1..array_length(v_lines, 1) LOOP
        INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit, description, sort_order)
        VALUES (
          v_existing_je_id,
          (v_lines[i]->>'account_id')::uuid,
          (v_lines[i]->>'debit')::decimal(15,2),
          (v_lines[i]->>'credit')::decimal(15,2),
          v_lines[i]->>'description',
          i
        );
      END LOOP;

      UPDATE journal_entries
      SET description = 'COGS - ' || v_invoice.invoice_number || ' (' || v_line_count || ' items, total: ' || v_total_cogs || ')',
          total_debit = v_total_cogs,
          total_credit = v_total_cogs
      WHERE id = v_existing_je_id;

      SELECT COALESCE(SUM(debit - credit), 0) INTO v_new_cogs_net
      FROM journal_lines WHERE journal_entry_id = v_existing_je_id AND account_id = v_cogs_account;
      SELECT COALESCE(SUM(debit - credit), 0) INTO v_new_inv_net
      FROM journal_lines WHERE journal_entry_id = v_existing_je_id AND account_id = v_inventory_account;

      UPDATE accounts
         SET balance = balance + CASE WHEN account_type IN ('liability','equity','revenue')
                                      THEN -(v_new_cogs_net - v_old_cogs_net)
                                      ELSE  (v_new_cogs_net - v_old_cogs_net) END
       WHERE id = v_cogs_account;

      UPDATE accounts
         SET balance = balance + CASE WHEN account_type IN ('liability','equity','revenue')
                                      THEN -(v_new_inv_net - v_old_inv_net)
                                      ELSE  (v_new_inv_net - v_old_inv_net) END
       WHERE id = v_inventory_account;
    ELSE
      PERFORM post_journal_entry(
        'COGS - ' || v_invoice.invoice_number || ' (' || v_line_count || ' items, total: ' || v_total_cogs || ')',
        COALESCE(v_invoice.invoice_date, CURRENT_DATE),
        'invoice',
        v_invoice.id,
        to_json(v_lines),
        v_invoice.customer_id
      );
    END IF;
  END IF;

  RETURN NEW;
END
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2) quick_sell_create
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
                              track_inventory, is_active, min_stock_level, description)
        VALUES (v_sku, TRIM(v_item->>'name'), v_unit, v_unit, v_cost, v_price,
                false, true, 0, 'Quick-sell (non-stock) item — bought on demand, never stocked')
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
  RAISE NOTICE 'quick_sell_rpc: applied — post_cogs_je_from_item_insert refreshes the Quick Sell Cost JE; quick_sell_create(p_payload) live for authenticated';
END $$;

COMMIT;
