-- ============================================================================
-- Sales returns must give advance-wallet money back to the wallet.
--
-- record_sales_return capped a refund at amount_paid - existing refunds and paid
-- the whole cap out through the chosen method. For an invoice that was (partly)
-- paid from the customer's advance wallet that is wrong: that portion never came
-- in as cash, so refunding it as cash (or store credit) both empties the till and
-- double-counts the customer's money.
--
-- The cap is unchanged; the refund is now SPLIT:
--   advance-funded part -> back onto the wallet(s) that funded the invoice
--                          (Cr 2300, applications reduced/removed, no cash out)
--   everything else     -> the existing refund method (cash/bank/store credit)
--
-- The linked customer_advance_applications rows are the source of truth for how
-- much advance money is still on the invoice, so a second return and a later
-- cancel each restore only what is genuinely left. The return document records
-- the split in notes, the journal has one credit line per part, and the result
-- returns advance_refunded / cash_refund_amount.
--
-- The offline path (sync_sales_return_create) calls this same RPC, so queued
-- returns behave identically.
--
-- Function is the verbatim latest definition (pg_get_functiondef) with only the
-- marked blocks changed.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.record_sales_return(p_invoice_id uuid, p_refund_method text, p_refund_account_id uuid DEFAULT NULL::uuid, p_items json DEFAULT NULL::json, p_created_by uuid DEFAULT NULL::uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid := '00000000-0000-0000-0000-000000000001';
  v_invoice record;
  v_item json;
  v_it record;
  v_conversion numeric;
  v_base_qty numeric;
  v_fifo_cogs numeric;
  v_fifo_qty numeric;
  v_cost_per_base numeric;
  v_total_refund numeric := 0;
  v_total_cogs numeric := 0;
  v_qs_cogs numeric := 0;
  v_stocked_cogs numeric := 0;
  v_nonstock boolean;
  v_existing_refunds numeric;
  v_capped_refund numeric;
  v_vat_portion numeric := 0;
  v_shipping_portion numeric := 0;
  v_max_refundable numeric;
  v_return_id uuid;
  v_return_number text;
  v_je_id uuid;
  v_payment_id uuid;
  v_credit_account uuid;
  v_ar_account uuid;
  v_inv_account uuid;
  v_cogs_account uuid;
  v_sr_account uuid;
  v_vat_account uuid;
  v_shipping_account uuid;
  v_paid_account uuid;
  v_lines json;
  v_new_refunded numeric;
  v_new_status text;
  v_wh uuid;
  v_inv_item record;
  v_adv_account uuid;
  v_adv_app record;
  v_adv_applied numeric := 0;
  v_adv_refund numeric := 0;
  v_cash_refund numeric := 0;
  v_adv_remaining numeric := 0;
  v_adv_take numeric := 0;
BEGIN
  SELECT * INTO v_invoice FROM invoices WHERE id = p_invoice_id;
  IF v_invoice.id IS NULL THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;
  IF v_invoice.status = 'cancelled' THEN
    RAISE EXCEPTION 'Cannot return items on a cancelled invoice';
  END IF;
  IF p_items IS NULL OR json_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'At least one item with quantity > 0 is required';
  END IF;

  SELECT COALESCE(SUM(total_refund_amount), 0) INTO v_existing_refunds
  FROM sales_returns
  WHERE invoice_id = p_invoice_id AND status <> 'void';

  -- Validate items and compute refund + COGS totals from server data.
  FOR v_item IN SELECT * FROM json_array_elements(p_items) LOOP
    IF COALESCE((v_item->>'quantity')::numeric, 0) <= 0 THEN
      CONTINUE;
    END IF;
    SELECT * INTO v_it FROM invoice_items WHERE id = (v_item->>'invoice_item_id')::uuid AND invoice_id = p_invoice_id;
    IF v_it.id IS NULL THEN
      RAISE EXCEPTION 'Invoice item % not found on this invoice', v_item->>'invoice_item_id';
    END IF;
    SELECT COALESCE(NOT pr.track_inventory, false) INTO v_nonstock
    FROM products pr WHERE pr.id = v_it.product_id;

    v_conversion := CASE
      WHEN v_it.quantity > 0 AND v_it.base_quantity > 0 THEN v_it.base_quantity / v_it.quantity
      ELSE GREATEST(COALESCE(v_it.unit_conversion_factor, 0), 1)
    END;
    v_base_qty := (v_item->>'quantity')::numeric * v_conversion;

    SELECT COALESCE(SUM(cogs_amount), 0), COALESCE(SUM(quantity_consumed), 0)
    INTO v_fifo_cogs, v_fifo_qty
    FROM invoice_item_batch_consumption
    WHERE invoice_item_id = v_it.id;

    -- Non-stock (quick-sell) items have no consumption rows: the original
    -- line cost IS the cost (per sale unit / conversion).
    v_cost_per_base := CASE
      WHEN v_fifo_qty > 0 THEN v_fifo_cogs / v_fifo_qty
      ELSE COALESCE(v_it.cost_price, 0) / v_conversion
    END;

    v_total_refund := v_total_refund
      + (v_item->>'quantity')::numeric * v_it.unit_price * (1 - COALESCE(v_it.discount_percent, 0) / 100);
    v_total_cogs := v_total_cogs + v_base_qty * v_cost_per_base;
    IF v_nonstock THEN
      v_qs_cogs := v_qs_cogs + v_base_qty * v_cost_per_base;
    END IF;
  END LOOP;

  IF v_total_refund <= 0 THEN
    RAISE EXCEPTION 'Refund amount is zero';
  END IF;

  v_max_refundable := GREATEST(0, COALESCE(v_invoice.amount_paid, 0) - v_existing_refunds);
  v_capped_refund := LEAST(v_total_refund, v_max_refundable);
  IF v_capped_refund <= 0 THEN
    RAISE EXCEPTION 'Refund amount (%) exceeds refundable (%) — on-credit sale with no payment received, or previous refunds already processed', v_total_refund, v_max_refundable;
  END IF;

  SELECT id INTO v_sr_account FROM accounts WHERE code = '4050' LIMIT 1;
  SELECT id INTO v_ar_account FROM accounts WHERE code = '1100' LIMIT 1;
  SELECT id INTO v_inv_account FROM accounts WHERE code = '1200' LIMIT 1;
  SELECT id INTO v_cogs_account FROM accounts WHERE code = '5000' LIMIT 1;
  IF v_sr_account IS NULL OR v_ar_account IS NULL OR v_inv_account IS NULL OR v_cogs_account IS NULL THEN
    RAISE EXCEPTION 'Required accounts (4050/1100/1200/5000) not found';
  END IF;
  SELECT id INTO v_vat_account FROM accounts WHERE code = '2100' LIMIT 1;
  SELECT id INTO v_shipping_account FROM accounts WHERE code = '4020' LIMIT 1;

  IF p_refund_method = 'store_credit' THEN
    SELECT id INTO v_credit_account FROM accounts WHERE code = '2200' LIMIT 1;
    v_credit_account := COALESCE(v_credit_account, v_ar_account);
  ELSIF p_refund_account_id IS NOT NULL THEN
    v_credit_account := p_refund_account_id;
  ELSE
    v_credit_account := v_ar_account;
  END IF;

  SELECT generate_sales_return_number() INTO v_return_number;
  v_return_number := COALESCE(v_return_number, 'SR-' || to_char(clock_timestamp(), 'YYMMDDHH24MISS'));

  -- Refund split: money the customer paid from his ADVANCE WALLET goes back to
  -- that wallet (we hold it for him again, Cr 2300) — it never leaves the till
  -- as cash, and it must not become store credit either. Everything else is
  -- refunded through the chosen method exactly as before. The applications for
  -- this invoice are the source of truth for how much advance money is still
  -- funding it, and they are reduced as the money is handed back (so a later
  -- cancel restores only what is left).
  SELECT COALESCE(SUM(amount), 0) INTO v_adv_applied
    FROM customer_advance_applications
   WHERE invoice_id = p_invoice_id AND amount > 0;

  v_adv_refund := ROUND(LEAST(v_capped_refund, v_adv_applied), 2);
  v_cash_refund := ROUND(v_capped_refund - v_adv_refund, 2);

  IF v_adv_refund > 0 THEN
    SELECT id INTO v_adv_account FROM accounts WHERE code = '2300' LIMIT 1;
    IF v_adv_account IS NULL THEN
      RAISE EXCEPTION 'Customer Advances account (2300) is missing — cannot return advance-paid money on return %', v_return_number;
    END IF;

    v_adv_remaining := v_adv_refund;
    FOR v_adv_app IN
      SELECT id, advance_id, amount
        FROM customer_advance_applications
       WHERE invoice_id = p_invoice_id AND amount > 0
       ORDER BY created_at ASC, id ASC
    LOOP
      EXIT WHEN v_adv_remaining <= 0.001;
      v_adv_take := LEAST(v_adv_app.amount, v_adv_remaining);

      UPDATE customer_advances ca
         SET balance = COALESCE(ca.balance, 0) + v_adv_take,
             status = CASE WHEN ca.status IN ('applied', 'refunded') THEN 'active' ELSE ca.status END,
             updated_at = now()
       WHERE ca.id = v_adv_app.advance_id;

      IF v_adv_take >= v_adv_app.amount - 0.001 THEN
        DELETE FROM customer_advance_applications WHERE id = v_adv_app.id;
      ELSE
        UPDATE customer_advance_applications
           SET amount = amount - v_adv_take,
               notes = COALESCE(notes, '') || ' | ' || v_adv_take || ' returned to wallet via ' || v_return_number
         WHERE id = v_adv_app.id;
      END IF;

      v_adv_remaining := v_adv_remaining - v_adv_take;
    END LOOP;

    -- What could not be matched back to a wallet (never expected) falls back to
    -- the ordinary refund path rather than posting an unbalanced journal.
    v_adv_refund := ROUND(v_adv_refund - v_adv_remaining, 2);
    v_cash_refund := ROUND(v_capped_refund - v_adv_refund, 2);
  END IF;

  SELECT id INTO v_wh FROM warehouses WHERE is_default AND is_active LIMIT 1;
  v_wh := COALESCE(v_wh, '11000000-0000-0000-0000-000000000001');

  INSERT INTO sales_returns (tenant_id, return_number, invoice_id, customer_id, return_date,
                             total_refund_amount, refund_method, status, notes, created_by)
  VALUES (v_tenant, v_return_number, p_invoice_id, v_invoice.customer_id, CURRENT_DATE,
          v_capped_refund, COALESCE(p_refund_method, 'store_credit'), 'completed',
          CASE WHEN v_adv_refund > 0
               THEN v_adv_refund || ' returned to the customer advance wallet'
               ELSE NULL END,
          p_created_by)
  RETURNING id INTO v_return_id;

  v_vat_portion := CASE
    WHEN COALESCE(v_invoice.tax_amount, 0) > 0 AND v_invoice.total_amount > 0
    THEN round(v_capped_refund * v_invoice.tax_amount / v_invoice.total_amount, 2)
    ELSE 0 END;
  IF v_vat_portion > 0 AND v_vat_account IS NULL THEN
    RAISE EXCEPTION 'Invoice % carries VAT but VAT Payable account (2100) is missing', v_invoice.invoice_number;
  END IF;

  v_shipping_portion := CASE
    WHEN COALESCE(v_invoice.shipping_cost, 0) > 0 AND v_invoice.total_amount > 0
    THEN round(v_capped_refund * v_invoice.shipping_cost / v_invoice.total_amount, 2)
    ELSE 0 END;
  IF v_shipping_portion > 0 AND v_shipping_account IS NULL THEN
    RAISE EXCEPTION 'Invoice % carries shipping but Shipping Income account (4020) is missing', v_invoice.invoice_number;
  END IF;

  v_lines := to_json(ARRAY[]::json[]);
  IF v_vat_portion > 0 THEN
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_sr_account, 'debit', v_capped_refund - v_vat_portion - v_shipping_portion, 'credit', 0,
      'description', 'Sales Return (net of VAT and shipping) - ' || v_return_number)))::json);
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_vat_account, 'debit', v_vat_portion, 'credit', 0,
      'description', 'VAT reversal for return ' || v_return_number)))::json);
  ELSE
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_sr_account, 'debit', v_capped_refund - v_shipping_portion, 'credit', 0,
      'description', 'Sales Return - ' || v_return_number)))::json);
  END IF;
  IF v_shipping_portion > 0 THEN
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_shipping_account, 'debit', v_shipping_portion, 'credit', 0,
      'description', 'Shipping reversal for return ' || v_return_number)))::json);
  END IF;
  IF v_adv_refund > 0 THEN
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_adv_account, 'debit', 0, 'credit', v_adv_refund,
      'description', 'Advance balance restored - ' || v_return_number)))::json);
  END IF;
  IF v_cash_refund > 0 THEN
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_credit_account, 'debit', 0, 'credit', v_cash_refund,
      'description', CASE WHEN p_refund_method = 'store_credit' THEN 'Customer Store Credit' ELSE 'Refund via ' || COALESCE(p_refund_method, 'payment') END)))::json);
  END IF;
  IF v_total_cogs > 0 THEN
    -- Quick-sell portion was credited to the paid-from account, not 1200.
    v_stocked_cogs := ROUND(v_total_cogs - v_qs_cogs, 2);
    IF v_stocked_cogs > 0 THEN
      v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
        'account_id', v_inv_account, 'debit', v_stocked_cogs, 'credit', 0,
        'description', 'Inventory restored from return')))::json);
    END IF;
    IF v_qs_cogs > 0 THEN
      v_paid_account := quick_sell_cost_account(v_invoice.cost_payment_method);
      IF v_paid_account IS NULL THEN
        RAISE EXCEPTION 'Cannot reverse quick-sell cost for return %: paid-from account unavailable', v_return_number;
      END IF;
      v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
        'account_id', v_paid_account, 'debit', ROUND(v_qs_cogs, 2), 'credit', 0,
        'description', 'Reverse source-shop payment for returned quick-sell items')))::json);
    END IF;
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_cogs_account, 'debit', 0, 'credit', v_total_cogs,
      'description', 'COGS reversal for returned items')))::json);
  END IF;

  v_je_id := post_journal_entry(
    'Sales Return ' || v_return_number || ' - Invoice ' || v_invoice.invoice_number,
    CURRENT_DATE,
    'sales_return',
    v_return_id,
    v_lines,
    v_invoice.customer_id,
    NULL
  );

  UPDATE sales_returns SET journal_entry_id = v_je_id WHERE id = v_return_id;

  IF p_refund_method <> 'store_credit' AND v_cash_refund > 0 THEN
    INSERT INTO payments (payment_number, payment_type, reference_type, reference_id,
                          customer_id, amount, payment_method, payment_date, notes)
    VALUES (COALESCE(generate_payment_number(), 'PAY-' || to_char(clock_timestamp(), 'YYMMDDHH24MISS')),
            'refund', 'refund', v_je_id, v_invoice.customer_id, v_cash_refund,
            COALESCE(p_refund_method, 'cash'), CURRENT_DATE,
            'Refund for sales return ' || v_return_number)
    RETURNING id INTO v_payment_id;

    UPDATE sales_returns SET payment_id = v_payment_id WHERE id = v_return_id;
  END IF;

  -- Items: return rows, FIFO restore (batch-accurate), movements, counters.
  -- Non-stock items record the return row ONLY — no batch restore (would
  -- fabricate a positive layer), no stock movement, no counter update.
  FOR v_item IN SELECT * FROM json_array_elements(p_items) LOOP
    IF COALESCE((v_item->>'quantity')::numeric, 0) <= 0 THEN
      CONTINUE;
    END IF;
    SELECT * INTO v_it FROM invoice_items WHERE id = (v_item->>'invoice_item_id')::uuid;
    SELECT COALESCE(NOT pr.track_inventory, false) INTO v_nonstock
    FROM products pr WHERE pr.id = v_it.product_id;

    v_conversion := CASE
      WHEN v_it.quantity > 0 AND v_it.base_quantity > 0 THEN v_it.base_quantity / v_it.quantity
      ELSE GREATEST(COALESCE(v_it.unit_conversion_factor, 0), 1)
    END;
    v_base_qty := (v_item->>'quantity')::numeric * v_conversion;

    SELECT COALESCE(SUM(cogs_amount), 0), COALESCE(SUM(quantity_consumed), 0)
    INTO v_fifo_cogs, v_fifo_qty
    FROM invoice_item_batch_consumption
    WHERE invoice_item_id = v_it.id;

    v_cost_per_base := CASE
      WHEN v_fifo_qty > 0 THEN v_fifo_cogs / v_fifo_qty
      ELSE COALESCE(v_it.cost_price, 0) / v_conversion
    END;

    INSERT INTO sales_return_items (sales_return_id, invoice_item_id, product_id,
                                    quantity_returned, base_quantity_returned, unit_price,
                                    discount_percent, cost_price, subtotal, reason)
    VALUES (v_return_id, v_it.id, v_it.product_id,
            (v_item->>'quantity')::numeric, v_base_qty, v_it.unit_price,
            COALESCE(v_it.discount_percent, 0), v_cost_per_base * v_conversion,
            (v_item->>'quantity')::numeric * v_it.unit_price * (1 - COALESCE(v_it.discount_percent, 0) / 100),
            COALESCE(NULLIF(v_item->>'reason', ''), 'Not specified'));

    IF NOT v_nonstock THEN
      PERFORM restore_fifo_on_return(v_it.id, v_it.product_id, v_wh, v_base_qty,
                                     v_cost_per_base, v_return_id, v_return_number);

      INSERT INTO stock_movements (tenant_id, product_id, warehouse_id, movement_type,
                                   quantity, unit_cost, reference_type, reference_id,
                                   reference_number, notes)
      VALUES (v_tenant, v_it.product_id, v_wh, 'return_in', v_base_qty, v_cost_per_base,
              'sales_return', v_return_id, v_return_number,
              COALESCE(NULLIF(v_item->>'reason', ''), 'Return from invoice ' || v_invoice.invoice_number));

      SELECT ii.id INTO v_inv_item FROM inventory_items ii
      WHERE ii.product_id = v_it.product_id AND ii.warehouse_id = v_wh LIMIT 1;
      IF v_inv_item.id IS NOT NULL THEN
        UPDATE inventory_items
        SET quantity_on_hand = quantity_on_hand + v_base_qty, updated_at = now()
        WHERE id = v_inv_item.id;
      ELSE
        INSERT INTO inventory_items (tenant_id, product_id, warehouse_id, quantity_on_hand)
        VALUES (v_tenant, v_it.product_id, v_wh, v_base_qty);
      END IF;
    END IF;
  END LOOP;

  v_new_refunded := COALESCE(v_invoice.refunded_amount, 0) + v_capped_refund;
  v_new_status := CASE
    WHEN v_new_refunded >= COALESCE(v_invoice.total_amount, 0) THEN 'refunded'
    WHEN COALESCE(v_invoice.total_amount, 0) - COALESCE(v_invoice.bad_debt_amount, 0) - COALESCE(v_invoice.amount_paid, 0) <= 0 THEN 'paid'
    WHEN COALESCE(v_invoice.amount_paid, 0) > 0 THEN 'partially_paid'
    ELSE 'sent'
  END;
  UPDATE invoices SET refunded_amount = v_new_refunded, status = v_new_status, updated_at = now()
  WHERE id = p_invoice_id;

  IF p_refund_method = 'store_credit' AND v_invoice.customer_id IS NOT NULL AND v_cash_refund > 0 THEN
    INSERT INTO customer_store_credits (customer_id, sales_return_id, credit_number,
                                        amount, balance, status, notes)
    VALUES (v_invoice.customer_id, v_return_id,
            COALESCE(generate_credit_number(), 'SC-' || to_char(clock_timestamp(), 'YYMMDDHH24MISS')),
            v_cash_refund, v_cash_refund, 'active',
            'Store credit from return ' || v_return_number || ' (Invoice ' || v_invoice.invoice_number || ')');
  END IF;

  RETURN json_build_object(
    'return_id', v_return_id,
    'return_number', v_return_number,
    'journal_entry_id', v_je_id,
    'refund_amount', v_capped_refund,
    'advance_refunded', v_adv_refund,
    'cash_refund_amount', v_cash_refund,
    'cogs_reversal', v_total_cogs
  );
END $function$;
