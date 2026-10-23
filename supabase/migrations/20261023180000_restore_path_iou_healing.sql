-- ============================================================================
-- heal_negative_batches_and_resync
-- Shared negative-stock (IOU) healing used by every stock-restore path.
-- 1. Drains the newest positive batches into the oldest negative (IOU) layers,
--    oldest IOU first, until the debt is repaid or positives run out.
--    Ledger sum is unchanged — this only cleans up layer structure.
-- 2. Resyncs the inventory_items counter from the batch ledger (source of
--    truth), undoing the drift caused by blind counter restores / flooring.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.heal_negative_batches_and_resync(p_product_id uuid, p_warehouse_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_owed       numeric;
  v_absorbed   numeric := 0;
  v_take       numeric;
  v_batch      RECORD;
  v_ledger_sum numeric;
BEGIN
  IF p_product_id IS NULL OR p_warehouse_id IS NULL THEN
    RETURN;
  END IF;

  SELECT -COALESCE(SUM(quantity_remaining), 0) INTO v_owed
    FROM inventory_batches
   WHERE product_id = p_product_id
     AND warehouse_id = p_warehouse_id
     AND quantity_remaining < 0;

  IF v_owed > 0 THEN
    FOR v_batch IN
      SELECT id, quantity_remaining
        FROM inventory_batches
       WHERE product_id = p_product_id
         AND warehouse_id = p_warehouse_id
         AND quantity_remaining > 0
       ORDER BY created_at DESC, id DESC
       FOR UPDATE
    LOOP
      EXIT WHEN v_owed <= 0;
      v_take := LEAST(v_batch.quantity_remaining, v_owed);
      UPDATE inventory_batches
         SET quantity_remaining = quantity_remaining - v_take
       WHERE id = v_batch.id;
      v_owed := v_owed - v_take;
      v_absorbed := v_absorbed + v_take;
    END LOOP;

    FOR v_batch IN
      SELECT id, quantity_remaining
        FROM inventory_batches
       WHERE product_id = p_product_id
         AND warehouse_id = p_warehouse_id
         AND quantity_remaining < 0
       ORDER BY created_at ASC, id ASC
       FOR UPDATE
    LOOP
      EXIT WHEN v_absorbed <= 0;
      v_take := LEAST(-v_batch.quantity_remaining, v_absorbed);
      UPDATE inventory_batches
         SET quantity_remaining = quantity_remaining + v_take
       WHERE id = v_batch.id;
      v_absorbed := v_absorbed - v_take;
    END LOOP;
  END IF;

  SELECT COALESCE(SUM(quantity_remaining), 0) INTO v_ledger_sum
    FROM inventory_batches
   WHERE product_id = p_product_id
     AND warehouse_id = p_warehouse_id;

  UPDATE inventory_items
     SET quantity_on_hand = v_ledger_sum, updated_at = now()
   WHERE product_id = p_product_id
     AND warehouse_id = p_warehouse_id;
END;
$$;



CREATE OR REPLACE FUNCTION public.restore_fifo_on_return(p_invoice_item_id uuid, p_product_id uuid, p_warehouse_id uuid, p_quantity numeric, p_unit_cost numeric, p_reference_id uuid, p_reference_number text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
v_consumption RECORD;
v_remaining numeric := p_quantity;
v_restore_qty numeric;
BEGIN
IF p_quantity <= 0 THEN
RETURN;
END IF;

-- Try to restore to the original consumed batches first
FOR v_consumption IN
SELECT batch_id, quantity_consumed
FROM invoice_item_batch_consumption
WHERE invoice_item_id = p_invoice_item_id
ORDER BY created_at ASC
LOOP
EXIT WHEN v_remaining <= 0;

IF v_consumption.batch_id IS NOT NULL THEN
v_restore_qty := LEAST(v_consumption.quantity_consumed, v_remaining);
UPDATE inventory_batches
SET quantity_remaining = quantity_remaining + v_restore_qty
WHERE id = v_consumption.batch_id;
v_remaining := v_remaining - v_restore_qty;
END IF;
END LOOP;

-- If there's still remaining quantity, create a return batch
IF v_remaining > 0 THEN
INSERT INTO inventory_batches (
product_id, warehouse_id, batch_number,
quantity_received, quantity_remaining, unit_cost,
batch_type, reference_type, reference_id, reference_number,
notes
) VALUES (
p_product_id, p_warehouse_id, 'RET-' || p_reference_number,
v_remaining, v_remaining, p_unit_cost,
'return', 'sales_return', p_reference_id, p_reference_number,
'Stock returned from sales return ' || p_reference_number
);
END IF;
END;
$function$;



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

      -- Heal any IOU layer the returned units repay + resync counter from ledger
      PERFORM heal_negative_batches_and_resync(v_it.product_id, v_wh);
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



CREATE OR REPLACE FUNCTION public.cancel_invoice(p_invoice_id uuid, p_reason text, p_cancelled_by text, p_reverse_due_collections boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_invoice invoices%ROWTYPE;
  v_ar_account uuid;
  v_revenue_account uuid;
  v_cogs_account uuid;
  v_inventory_account uuid;
  v_default_wh uuid;
  v_item RECORD;
  v_qty numeric;
  v_cost numeric;
  v_payment RECORD;
  v_payment_account uuid;
  v_total_payments numeric := 0;
  v_has_deliveries boolean;
  v_je_id uuid;
  v_sr RECORD;
  v_returned_qty numeric;
  v_rev_pay_num text;
  v_cogs_total decimal(15,2) := 0;
  v_qs_cogs decimal(15,2) := 0;
  v_stocked_cogs decimal(15,2) := 0;
  v_paid_account uuid;
  v_stock_restored boolean := false;
  v_journal_reversed boolean := false;
  v_vat_account uuid;
  v_vat numeric := 0;
  v_shipping_account uuid;
  v_shipping numeric := 0;
  v_lines json;
  v_total_due_reversed numeric := 0;
  v_due_retained numeric := 0;
  -- Sales-return netting: a completed return already refunded the customer and
  -- already restocked/reversed its own share of revenue, VAT, shipping and
  -- COGS, so the cancellation reverses only the remainder.
  v_already_refunded numeric := 0;
  v_ar_net numeric := 0;
  v_vat_returned numeric := 0;
  v_shipping_returned numeric := 0;
  v_cogs_returned numeric := 0;
  v_returned_base numeric := 0;
  v_pay_refund numeric := 0;
  v_refund_left numeric := 0;
  v_refund_offset numeric := 0;
  v_total_refunded numeric := 0;
  v_payments_total numeric := 0;
  v_item_stock_restored boolean := false;
  v_adv_account uuid;
  v_app RECORD;
  v_total_advance_reversed numeric := 0;
BEGIN
  SELECT * INTO v_invoice FROM invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Invoice not found');
  END IF;

  IF v_invoice.status = 'cancelled' THEN
    RETURN json_build_object('success', false, 'error', 'Invoice is already cancelled');
  END IF;

  IF v_invoice.status = 'draft' THEN
    UPDATE invoices
    SET status = 'cancelled', amount_paid = 0, total_amount = 0, subtotal = 0, bad_debt_amount = 0, updated_at = now()
    WHERE id = p_invoice_id;

    INSERT INTO invoice_edit_history (
      invoice_id, invoice_number, edited_by_name, change_type, reason,
      snapshot_before, snapshot_after
    ) VALUES (
      p_invoice_id, v_invoice.invoice_number, p_cancelled_by, 'cancelled', p_reason,
      json_build_object('status', v_invoice.status, 'total_amount', v_invoice.total_amount),
      json_build_object('status', 'cancelled')
    );
    RETURN json_build_object(
      'success', true,
      'message', 'Draft invoice cancelled (no reversals needed)',
      'invoice_number', v_invoice.invoice_number,
      'stock_restored', true,
      'journal_reversed', false
    );
  END IF;

  -- Accounts
  SELECT id INTO v_ar_account FROM accounts WHERE code = '1100' LIMIT 1;
  SELECT id INTO v_revenue_account FROM accounts WHERE code = '4000' LIMIT 1;
  SELECT id INTO v_cogs_account FROM accounts WHERE code = '5000' LIMIT 1;
  SELECT id INTO v_inventory_account FROM accounts WHERE code = '1200' LIMIT 1;
  SELECT id INTO v_vat_account FROM accounts WHERE code = '2100' LIMIT 1;
  SELECT id INTO v_shipping_account FROM accounts WHERE code = '4020' LIMIT 1;
  SELECT id INTO v_default_wh FROM warehouses WHERE is_default = true LIMIT 1;

  -- ---------------------------------------------------------------------
  -- Linked sales returns still in force.
  --
  -- Each one ALREADY: refunded the customer (cash, store credit or advance),
  -- restocked the returned units (inventory_items + batches via
  -- restore_fifo_on_return) and posted its own JE reversing the returned share
  -- of revenue, VAT, shipping and COGS. Cancelling the invoice must reverse
  -- only the REMAINDER — otherwise the returned portion is reversed a second
  -- time (stock over-restored, COGS credited twice, revenue and AR doubly
  -- reversed) while the return's payout stays out of the till.
  --
  -- The ledger is the source of truth for the reversed GL amounts, and
  -- invoices.refunded_amount for the money already paid back.
  -- ---------------------------------------------------------------------
  v_already_refunded := COALESCE(v_invoice.refunded_amount, 0);

  IF EXISTS (SELECT 1 FROM sales_returns WHERE invoice_id = p_invoice_id AND status <> 'void') THEN
    SELECT COALESCE(SUM(jl.debit - jl.credit), 0) INTO v_vat_returned
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.journal_entry_id
     WHERE je.is_posted
       AND je.reference_type = 'sales_return'
       AND je.reference_id IN (SELECT id FROM sales_returns WHERE invoice_id = p_invoice_id AND status <> 'void')
       AND jl.account_id = v_vat_account;

    SELECT COALESCE(SUM(jl.debit - jl.credit), 0) INTO v_shipping_returned
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.journal_entry_id
     WHERE je.is_posted
       AND je.reference_type = 'sales_return'
       AND je.reference_id IN (SELECT id FROM sales_returns WHERE invoice_id = p_invoice_id AND status <> 'void')
       AND jl.account_id = v_shipping_account;

    -- The return CREDITS COGS, so the reversed amount is -SUM(debit - credit)
    SELECT COALESCE(-SUM(jl.debit - jl.credit), 0) INTO v_cogs_returned
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.journal_entry_id
     WHERE je.is_posted
       AND je.reference_type = 'sales_return'
       AND je.reference_id IN (SELECT id FROM sales_returns WHERE invoice_id = p_invoice_id AND status <> 'void')
       AND jl.account_id = v_cogs_account;

    SELECT COALESCE(SUM(r.returned_base), 0) INTO v_returned_base
      FROM public.sales_return_base_units(p_invoice_id) r;
  END IF;

  -- Collections still standing on this invoice. Needed before the AR reversal
  -- so the receivable lands on exactly zero: the reversing credit is
  -- (total - min(collections, already refunded)) and the cash refund issued
  -- below is max(0, collections - already refunded) — the two together clear
  -- AR and leave the customer exactly whole, whatever the refund mix was.
  SELECT COALESCE(SUM(amount), 0) INTO v_payments_total
    FROM payments
   WHERE reference_type = 'invoice' AND reference_id = p_invoice_id AND is_reversed = false;

  -- Reverse AR and Revenue, net of the invoice's VAT, shipping and the portion
  -- already reversed by linked sales returns.
  v_ar_net := GREATEST(0, COALESCE(v_invoice.total_amount, 0) - LEAST(v_payments_total, v_already_refunded));
  v_vat := LEAST(COALESCE(v_invoice.tax_amount, 0), v_invoice.total_amount);
  v_shipping := LEAST(COALESCE(v_invoice.shipping_cost, 0), GREATEST(0, v_invoice.total_amount - v_vat));
  v_vat := LEAST(GREATEST(0, v_vat - v_vat_returned), v_ar_net);
  v_shipping := LEAST(GREATEST(0, v_shipping - v_shipping_returned), GREATEST(0, v_ar_net - v_vat));
  IF v_vat > 0 AND v_vat_account IS NULL THEN
    RAISE EXCEPTION 'Invoice % carries VAT (%) but VAT Payable account (2100) is missing', v_invoice.invoice_number, v_vat;
  END IF;
  IF v_shipping > 0 AND v_shipping_account IS NULL THEN
    RAISE EXCEPTION 'Invoice % carries shipping (%) but Shipping Income account (4020) is missing', v_invoice.invoice_number, v_shipping;
  END IF;
  IF v_ar_net > 0 AND v_ar_account IS NOT NULL AND v_revenue_account IS NOT NULL THEN
    v_lines := to_json(ARRAY[]::json[]);
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_revenue_account, 'debit', v_ar_net - v_vat - v_shipping, 'credit', 0,
      'description', CASE WHEN v_vat > 0 OR v_shipping > 0
                          THEN 'Reverse revenue (net of VAT and shipping) for cancelled ' || v_invoice.invoice_number
                          ELSE 'Reverse revenue for cancelled ' || v_invoice.invoice_number END)))::json);
    IF v_vat > 0 THEN
      v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
        'account_id', v_vat_account, 'debit', v_vat, 'credit', 0,
        'description', 'Reverse VAT for cancelled ' || v_invoice.invoice_number)))::json);
    END IF;
    IF v_shipping > 0 THEN
      v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
        'account_id', v_shipping_account, 'debit', v_shipping, 'credit', 0,
        'description', 'Reverse shipping income for cancelled ' || v_invoice.invoice_number)))::json);
    END IF;
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_ar_account, 'debit', 0, 'credit', v_ar_net,
      'description', 'Reverse AR for cancelled ' || v_invoice.invoice_number)))::json);
    PERFORM post_journal_entry(
      'Reverse AR/Revenue - Cancelled ' || v_invoice.invoice_number,
      COALESCE(v_invoice.invoice_date, CURRENT_DATE),
      'invoice_cancel',
      p_invoice_id,
      v_lines,
      v_invoice.customer_id
    );
    v_journal_reversed := true;
  END IF;

  -- COGS reversal amount: from POSTED COGS JEs (net of reversals). Includes
  -- the Quick Sell Cost JE (no description filter — account-5000 lines only).
  SELECT COALESCE(SUM(jl.debit - jl.credit), 0) INTO v_cogs_total
  FROM journal_lines jl
  JOIN journal_entries je ON je.id = jl.journal_entry_id
  JOIN accounts a ON a.id = jl.account_id
  WHERE je.reference_type IN ('invoice', 'invoice_edit')
    AND je.reference_id = p_invoice_id
    AND a.code = '5000'
    AND je.is_posted = true;

  IF v_cogs_total = 0 THEN
    SELECT COALESCE(SUM(cogs_amount), 0) INTO v_cogs_total
    FROM invoice_item_batch_consumption
    WHERE invoice_item_id IN (SELECT id FROM invoice_items WHERE invoice_id = p_invoice_id);
  END IF;
  IF v_cogs_total = 0 THEN
    FOR v_item IN SELECT ii.* FROM invoice_items ii JOIN products pr ON pr.id = ii.product_id WHERE ii.invoice_id = p_invoice_id LOOP
      v_cogs_total := v_cogs_total + (COALESCE(v_item.cost_price, 0) * COALESCE(v_item.quantity, 0));
    END LOOP;
  END IF;

  -- Net of the COGS a linked sales return already reversed (its JE credits
  -- 5000 for the returned cost), so the cancellation only reverses the rest.
  v_cogs_total := GREATEST(0, v_cogs_total - v_cogs_returned);

  -- Split the reversal: the quick-sell portion was credited to the account
  -- the source shop was paid from; only the stocked portion restores 1200.
  SELECT COALESCE(SUM(GREATEST(0, ii.quantity - COALESCE(r.returned_qty, 0)) * ii.cost_price), 0) INTO v_qs_cogs
  FROM invoice_items ii
  JOIN products pr ON pr.id = ii.product_id
  LEFT JOIN public.sales_return_base_units(p_invoice_id) r ON r.invoice_item_id = ii.id
  WHERE ii.invoice_id = p_invoice_id AND NOT pr.track_inventory AND ii.quantity > 0;
  v_qs_cogs := LEAST(ROUND(v_qs_cogs, 2), v_cogs_total);
  v_stocked_cogs := v_cogs_total - v_qs_cogs;
  IF v_qs_cogs > 0 THEN
    v_paid_account := quick_sell_cost_account(v_invoice.cost_payment_method);
    IF v_paid_account IS NULL THEN
      RAISE EXCEPTION 'Cannot reverse quick-sell cost for cancelled %: paid-from account unavailable', v_invoice.invoice_number;
    END IF;
  END IF;

  IF v_cogs_account IS NOT NULL AND v_cogs_total > 0
     AND (v_stocked_cogs <= 0 OR v_inventory_account IS NOT NULL) THEN
    v_lines := to_json(ARRAY[]::json[]);
    IF v_stocked_cogs > 0 THEN
      v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
        'account_id', v_inventory_account, 'debit', v_stocked_cogs, 'credit', 0,
        'description', 'Restore inventory for cancelled ' || v_invoice.invoice_number)))::json);
    END IF;
    IF v_qs_cogs > 0 THEN
      v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
        'account_id', v_paid_account, 'debit', v_qs_cogs, 'credit', 0,
        'description', 'Restore source-shop payment for cancelled ' || v_invoice.invoice_number)))::json);
    END IF;
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_cogs_account, 'debit', 0, 'credit', v_cogs_total,
      'description', 'Reverse COGS for cancelled ' || v_invoice.invoice_number)))::json);
    PERFORM post_journal_entry(
      'Reverse COGS - Cancelled ' || v_invoice.invoice_number,
      COALESCE(v_invoice.invoice_date, CURRENT_DATE),
      'invoice_cancel',
      p_invoice_id,
      v_lines,
      v_invoice.customer_id
    );
    v_journal_reversed := true;
  END IF;

  -- Restore stock + record stock movements (STOCKED items only), net of the
  -- units a linked sales return already put back on the shelf.
  FOR v_item IN
    SELECT ii.*, COALESCE(r.returned_base, 0) AS returned_base
      FROM invoice_items ii
      JOIN products pr ON pr.id = ii.product_id
      LEFT JOIN public.sales_return_base_units(p_invoice_id) r ON r.invoice_item_id = ii.id
     WHERE ii.invoice_id = p_invoice_id AND pr.track_inventory
  LOOP
    v_qty := GREATEST(0, COALESCE(v_item.base_quantity, v_item.quantity) - v_item.returned_base);
    IF v_qty <= 0 THEN
      CONTINUE;  -- every unit on this line was already returned and restocked
    END IF;

    INSERT INTO inventory_items (tenant_id, product_id, warehouse_id, quantity_on_hand, quantity_reserved, quantity_incoming)
    VALUES ('00000000-0000-0000-0000-000000000001', v_item.product_id, COALESCE(v_item.warehouse_id, v_default_wh), v_qty, 0, 0)
    ON CONFLICT (product_id, warehouse_id)
    DO UPDATE SET quantity_on_hand = inventory_items.quantity_on_hand + EXCLUDED.quantity_on_hand,
                  updated_at = now();

    INSERT INTO stock_movements (product_id, warehouse_id, movement_type, quantity, unit_cost, reference_type, reference_id, reference_number, notes)
    VALUES (
      v_item.product_id,
      COALESCE(v_item.warehouse_id, v_default_wh),
      'return_in',
      v_qty,
      COALESCE(v_item.cost_price, 0),
      'invoice_cancel',
      p_invoice_id,
      v_invoice.invoice_number,
      'Stock restored on cancel: ' || p_reason
    );
    v_item_stock_restored := true;
  END LOOP;
  v_stock_restored := v_item_stock_restored;

  -- FIFO: restore batch quantities for the units still out. restore_fifo would
  -- hand back the item's FULL consumption, double-counting the units a return
  -- already restored through restore_fifo_on_return, so the restore is capped
  -- at (consumed - returned). Non-stock items have no consumption rows (natural
  -- no-op) and every consumption row is cleared either way.
  FOR v_item IN
    SELECT ii.id,
           GREATEST(0, COALESCE(ii.base_quantity, ii.quantity) - COALESCE(r.returned_base, 0)) AS restore_base
      FROM invoice_items ii
      LEFT JOIN public.sales_return_base_units(p_invoice_id) r ON r.invoice_item_id = ii.id
     WHERE ii.invoice_id = p_invoice_id
  LOOP
    PERFORM restore_fifo_partial(v_item.id, v_item.restore_base);
  END LOOP;

  -- Heal any IOU layers the restore repaid + resync counters from the ledger
  FOR v_item IN
    SELECT DISTINCT ii.product_id, COALESCE(ii.warehouse_id, v_default_wh) AS wh
      FROM invoice_items ii
      JOIN products pr ON pr.id = ii.product_id
     WHERE ii.invoice_id = p_invoice_id AND pr.track_inventory
  LOOP
    PERFORM heal_negative_batches_and_resync(v_item.product_id, v_item.wh);
  END LOOP;

  -- Restore advance applications (sub-ledger) AND reverse their journal, so the
  -- general ledger and the customer's wallets agree again after the reversal.
  -- Before this, cancelling an advance-paid invoice put the money back in the
  -- wallet (customer_advances.balance) while Dr 2300 / Cr 1100 stayed on the
  -- books: the GL said the advance was spent and the sub-ledger said it was
  -- still held. Now each restored application posts the mirror entry
  -- Dr 1100 (AR) / Cr 2300 (customer advances).
  SELECT id INTO v_adv_account FROM accounts WHERE code = '2300' LIMIT 1;
  FOR v_app IN
    SELECT advance_id, customer_id, amount
      FROM customer_advance_applications
     WHERE invoice_id = p_invoice_id
  LOOP
    UPDATE customer_advances ca
       SET balance = ca.balance + v_app.amount,
           status = CASE WHEN ca.status = 'applied' THEN 'active' ELSE ca.status END,
           updated_at = now()
     WHERE ca.id = v_app.advance_id;

    IF v_ar_account IS NOT NULL AND v_adv_account IS NOT NULL AND COALESCE(v_app.amount, 0) > 0 THEN
      PERFORM post_journal_entry(
        'Reverse advance application - ' || v_invoice.invoice_number,
        COALESCE(v_invoice.invoice_date, CURRENT_DATE),
        'advance_application_reversal',
        v_app.advance_id,
        json_build_array(
          json_build_object('account_id', v_ar_account, 'debit', v_app.amount, 'credit', 0,
            'description', 'Restore AR for reversed advance application on ' || v_invoice.invoice_number),
          json_build_object('account_id', v_adv_account, 'debit', 0, 'credit', v_app.amount,
            'description', 'Customer advance restored - ' || v_invoice.invoice_number)
        )::json,
        v_app.customer_id
      );
      v_journal_reversed := true;
    END IF;

    v_total_advance_reversed := v_total_advance_reversed + COALESCE(v_app.amount, 0);
  END LOOP;

  DELETE FROM customer_advance_applications WHERE invoice_id = p_invoice_id;

  -- Cancel payments. Money already paid back through a linked sales return is
  -- NOT refunded a second time: invoices.refunded_amount is netted off the
  -- refunds, oldest payment first, so the customer ends up exactly whole (paid
  -- X, already refunded R via the return, refunded X - R here).
  v_refund_left := v_already_refunded;

  FOR v_payment IN SELECT * FROM payments WHERE reference_type = 'invoice' AND reference_id = p_invoice_id AND is_reversed = false ORDER BY payment_date, payment_number LOOP
    v_total_payments := v_total_payments + v_payment.amount;
    UPDATE payments SET is_reversed = true, updated_at = now() WHERE id = v_payment.id;

    v_pay_refund := COALESCE(v_payment.amount, 0);
    IF v_refund_left > 0 AND v_pay_refund > 0 THEN
      IF v_refund_left >= v_pay_refund THEN
        v_refund_left := v_refund_left - v_pay_refund;
        v_refund_offset := v_refund_offset + v_pay_refund;
        v_pay_refund := 0;
      ELSE
        v_pay_refund := v_pay_refund - v_refund_left;
        v_refund_offset := v_refund_offset + v_refund_left;
        v_refund_left := 0;
      END IF;
    END IF;

    IF v_pay_refund <= 0 THEN
      CONTINUE;  -- this collection was already paid back through the return
    END IF;

    v_total_refunded := v_total_refunded + v_pay_refund;

    SELECT 'RVP-' || COALESCE(MAX(CAST(SUBSTRING(payment_number FROM 5) AS INTEGER)) + 1, 1)
    INTO v_rev_pay_num FROM payments WHERE payment_number LIKE 'RVP-%';

    INSERT INTO payments (payment_number, payment_type, reference_type, reference_id, customer_id, supplier_id,
    amount, payment_method, payment_date, reference_number, notes)
    VALUES (
      v_rev_pay_num, 'refund', 'invoice', p_invoice_id, v_payment.customer_id, v_payment.supplier_id,
      v_pay_refund, v_payment.payment_method, CURRENT_DATE, v_payment.payment_number,
      CASE WHEN v_refund_offset > 0
           THEN 'Auto-refund on invoice cancellation (net of ' || v_already_refunded || ' already refunded on linked sales returns)'
           ELSE 'Auto-refund on invoice cancellation' END
    );

    IF v_ar_account IS NOT NULL AND COALESCE(v_pay_refund, 0) > 0 THEN
      SELECT pm.account_id INTO v_payment_account
      FROM payment_methods pm
      WHERE pm.code = v_payment.payment_method AND pm.is_active = true
      LIMIT 1;
      IF v_payment_account IS NULL THEN
        SELECT id INTO v_payment_account FROM accounts WHERE code = '1001' LIMIT 1;
      END IF;

      IF v_payment_account IS NOT NULL THEN
        PERFORM post_journal_entry(
          'Reverse Payment - Cancelled ' || v_invoice.invoice_number,
          COALESCE(v_invoice.invoice_date, CURRENT_DATE),
          'invoice_cancel',
          p_invoice_id,
          json_build_array(
            json_build_object('account_id', v_ar_account, 'debit', v_pay_refund, 'credit', 0,
              'description', 'Restore AR for reversed payment ' || v_payment.payment_number),
            json_build_object('account_id', v_payment_account, 'debit', 0, 'credit', v_pay_refund,
              'description', 'Refund ' || v_payment.payment_number || ' for cancelled ' || v_invoice.invoice_number)
          )::json,
          v_invoice.customer_id
        );
        v_journal_reversed := true;
      END IF;
    END IF;
  END LOOP;

  -- Previous-due collections gathered WITH this invoice (POS due collection)
  IF COALESCE(p_reverse_due_collections, true) THEN
    FOR v_payment IN
      SELECT * FROM payments
      WHERE collected_with_invoice_id = p_invoice_id AND is_reversed = false
    LOOP
      v_total_due_reversed := v_total_due_reversed + COALESCE(v_payment.amount, 0);
      UPDATE payments SET is_reversed = true, updated_at = now() WHERE id = v_payment.id;

      SELECT 'RVP-' || COALESCE(MAX(CAST(SUBSTRING(payment_number FROM 5) AS INTEGER)) + 1, 1)
      INTO v_rev_pay_num FROM payments WHERE payment_number LIKE 'RVP-%';

      INSERT INTO payments (payment_number, payment_type, reference_type, reference_id, customer_id, supplier_id,
      amount, payment_method, payment_date, reference_number, notes)
      VALUES (
        v_rev_pay_num, 'refund', 'invoice', p_invoice_id, v_payment.customer_id, v_payment.supplier_id,
        v_payment.amount, v_payment.payment_method, CURRENT_DATE, v_payment.payment_number,
        'Auto-refund of due collection on invoice cancellation'
      );

      -- Restore the older invoice this collection was allocated to
      IF v_payment.reference_type = 'invoice'
         AND v_payment.reference_id IS NOT NULL
         AND v_payment.reference_id <> p_invoice_id THEN
        UPDATE invoices
        SET amount_paid = GREATEST(0, COALESCE(amount_paid, 0) - v_payment.amount),
            status = CASE
              WHEN GREATEST(0, COALESCE(amount_paid, 0) - v_payment.amount) <= 0 THEN 'sent'
              ELSE 'partially_paid'
            END,
            updated_at = now()
        WHERE id = v_payment.reference_id
          AND status NOT IN ('cancelled', 'refunded', 'draft');
      END IF;

      IF v_ar_account IS NOT NULL AND COALESCE(v_payment.amount, 0) > 0 THEN
        SELECT pm.account_id INTO v_payment_account
        FROM payment_methods pm
        WHERE pm.code = v_payment.payment_method AND pm.is_active = true
        LIMIT 1;
        IF v_payment_account IS NULL THEN
          SELECT id INTO v_payment_account FROM accounts WHERE code = '1001' LIMIT 1;
        END IF;

        IF v_payment_account IS NOT NULL THEN
          PERFORM post_journal_entry(
            'Reverse Due Collection - Cancelled ' || v_invoice.invoice_number,
            COALESCE(v_invoice.invoice_date, CURRENT_DATE),
            'invoice_cancel',
            p_invoice_id,
            json_build_array(
              json_build_object('account_id', v_ar_account, 'debit', v_payment.amount, 'credit', 0,
                'description', 'Restore AR for reversed due collection ' || v_payment.payment_number),
              json_build_object('account_id', v_payment_account, 'debit', 0, 'credit', v_payment.amount,
                'description', 'Refund due collection ' || v_payment.payment_number || ' for cancelled ' || v_invoice.invoice_number)
            )::json,
            v_invoice.customer_id
          );
          v_journal_reversed := true;
        END IF;
      END IF;
    END LOOP;
  ELSE
    -- Keep old dues paid: unlink payments from this invoice so they stand independently as normal payments on the older invoice.
    SELECT COALESCE(SUM(amount), 0) INTO v_due_retained
      FROM payments
     WHERE collected_with_invoice_id = p_invoice_id AND is_reversed = false;

    UPDATE payments
       SET collected_with_invoice_id = NULL,
           notes = COALESCE(notes, '') || ' [Retained as paid after cancellation of ' || v_invoice.invoice_number || ']',
           updated_at = now()
     WHERE collected_with_invoice_id = p_invoice_id
       AND is_reversed = false;
  END IF;

  -- Mark invoice cancelled
  UPDATE invoices
  SET status = 'cancelled', amount_paid = 0, total_amount = 0, subtotal = 0, bad_debt_amount = 0, updated_at = now()
  WHERE id = p_invoice_id;

  -- Audit history
  INSERT INTO invoice_edit_history (
    invoice_id, invoice_number, edited_by_name, change_type, reason,
    snapshot_before, snapshot_after
  ) VALUES (
    p_invoice_id, v_invoice.invoice_number, p_cancelled_by, 'cancelled', p_reason,
    json_build_object(
      'status', v_invoice.status,
      'total_amount', v_invoice.total_amount,
      'amount_paid', v_invoice.amount_paid,
      'reverse_due_collections', COALESCE(p_reverse_due_collections, true)
    ),
    json_build_object('status', 'cancelled')
  );

  RETURN json_build_object(
    'success', true,
    'message', 'Invoice cancelled successfully',
    'invoice_number', v_invoice.invoice_number,
    'cogs_reversed', v_cogs_total,
    'payments_reversed', v_total_payments,
    'payments_refunded', v_total_refunded,
    'refund_offset_by_returns', v_refund_offset,
    'returns_refunded_total', v_already_refunded,
    'stock_qty_already_returned', v_returned_base,
    'stock_restored', v_stock_restored,
    'journal_reversed', v_journal_reversed,
    'due_collections_reversed', v_total_due_reversed,
    'due_collections_retained', v_due_retained,
    'advance_applications_reversed', v_total_advance_reversed
  );
END;
$function$;



CREATE OR REPLACE FUNCTION public.edit_invoice(p_invoice_id uuid, p_new_data json, p_edited_by text DEFAULT NULL::text, p_reason text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_invoice RECORD;
  v_ar_account uuid;
  v_revenue_account uuid;
  v_cogs_account uuid;
  v_inventory_account uuid;
  v_cash_account uuid;
  v_bad_debt_account uuid;
  v_default_wh uuid;
  v_item RECORD;
  v_qty numeric;
  v_cost numeric;
  v_payment RECORD;
  v_je_id uuid;
  v_new_items json;
  v_new_item json;
  v_new_subtotal numeric := 0;
  v_new_cart_discount_percent numeric := 0;
  v_new_extra_discount numeric := 0;
  v_cart_discount_amount numeric := 0;
  v_new_total numeric := 0;
  v_new_customer uuid;
  v_new_date date;
  v_new_due_date date;
  v_new_notes text;
  v_new_reference text;
  v_new_payment_term text := 'full';
  v_new_payment_method text := 'cash';
  v_new_partial_amount numeric := 0;
  v_has_deliveries boolean;
  v_has_returns boolean;
  v_old_snapshot json;
  v_new_snapshot json;
  v_i integer := 0;
  v_old_payments json;
  v_old_payment_term text;
  v_new_payment_id uuid;
  v_delivery RECORD;
  v_product RECORD;
  v_cost_per_unit numeric;
  v_total_cost_added numeric;
  v_target_wh uuid;
  v_vat_account uuid;
  v_vat_mode text;
  v_new_tax numeric := 0;
  v_old_tax numeric := 0;
  v_shipping_account uuid;
  v_new_shipping numeric := 0;
  v_old_shipping numeric := 0;
  v_lines json;
  v_new_cost_method text;
  v_adv_account uuid;
  v_app RECORD;
  v_total_advance_reversed numeric := 0;
BEGIN
  SELECT * INTO v_invoice FROM invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Invoice not found');
  END IF;

  IF v_invoice.status = 'cancelled' THEN
    RETURN json_build_object('success', false, 'error', 'Cannot edit a cancelled invoice');
  END IF;

  SELECT EXISTS(SELECT 1 FROM deliveries WHERE invoice_id = p_invoice_id AND status = 'delivered') INTO v_has_deliveries;
  IF v_has_deliveries THEN
    RETURN json_build_object('success', false, 'error', 'Cannot edit an invoice that has been delivered. Please process a return instead.');
  END IF;

  SELECT EXISTS(SELECT 1 FROM sales_returns WHERE invoice_id = p_invoice_id AND status = 'completed') INTO v_has_returns;
  IF v_has_returns THEN
    RETURN json_build_object('success', false, 'error', 'Cannot edit an invoice with completed sales returns. Please process additional returns instead.');
  END IF;

  v_new_customer := (p_new_data->>'customer_id')::uuid;
  v_new_date := COALESCE((p_new_data->>'invoice_date')::date, CURRENT_DATE);
  v_new_due_date := CASE WHEN p_new_data->>'due_date' IS NULL OR p_new_data->>'due_date' = '' THEN NULL ELSE (p_new_data->>'due_date')::date END;
  v_new_notes := p_new_data->>'notes';
  v_new_reference := p_new_data->>'reference';
  v_new_items := p_new_data->'items';
  v_new_cart_discount_percent := COALESCE((p_new_data->>'cart_discount_percent')::numeric, 0);
  v_new_extra_discount := COALESCE((p_new_data->>'extra_discount')::numeric, 0);
  v_new_payment_term := COALESCE(p_new_data->>'payment_term', 'full');
  v_new_payment_method := COALESCE(p_new_data->>'payment_method', 'cash');
  v_new_partial_amount := COALESCE((p_new_data->>'partial_amount')::numeric, 0);
  v_new_tax := COALESCE((p_new_data->>'tax_amount')::numeric, 0);
  v_new_shipping := COALESCE((p_new_data->>'shipping_cost')::numeric, 0);
  v_new_cost_method := NULLIF(p_new_data->>'cost_payment_method', '');

  FOR v_i IN SELECT generate_series(0, json_array_length(v_new_items) - 1) LOOP
    v_new_item := v_new_items->v_i;
    v_new_subtotal := v_new_subtotal + (v_new_item->>'quantity')::numeric * (v_new_item->>'unit_price')::numeric * (1 - COALESCE((v_new_item->>'discount_percent')::numeric, 0) / 100);
  END LOOP;

  v_cart_discount_amount := (v_new_subtotal * v_new_cart_discount_percent) / 100;
  v_new_total := GREATEST(0, v_new_subtotal - v_cart_discount_amount - v_new_extra_discount);
  SELECT COALESCE(s.setting_value->>'mode', 'exclusive') INTO v_vat_mode
  FROM app_settings s WHERE s.setting_key = 'vat';
  v_vat_mode := COALESCE(v_vat_mode, 'exclusive');
  IF v_vat_mode = 'exclusive' THEN
    v_new_total := v_new_total + v_new_tax;
  END IF;
  v_new_shipping := GREATEST(0, v_new_shipping);
  v_new_total := v_new_total + v_new_shipping;

  IF v_invoice.amount_paid >= v_invoice.total_amount AND v_invoice.total_amount > 0 THEN
    v_old_payment_term := 'full';
  ELSIF v_invoice.amount_paid > 0 THEN
    v_old_payment_term := 'partial';
  ELSE
    v_old_payment_term := 'credit';
  END IF;

  SELECT id INTO v_ar_account FROM accounts WHERE code = '1100' LIMIT 1;
  SELECT id INTO v_bad_debt_account FROM accounts WHERE code = '5600' LIMIT 1;
  SELECT id INTO v_revenue_account FROM accounts WHERE code = '4000' LIMIT 1;
  SELECT id INTO v_cogs_account FROM accounts WHERE code = '5000' LIMIT 1;
  SELECT id INTO v_inventory_account FROM accounts WHERE code = '1200' LIMIT 1;
  SELECT id INTO v_vat_account FROM accounts WHERE code = '2100' LIMIT 1;
  SELECT id INTO v_shipping_account FROM accounts WHERE code = '4020' LIMIT 1;
  SELECT id INTO v_cash_account FROM accounts WHERE code = '1000' LIMIT 1;

  SELECT id INTO v_default_wh FROM warehouses WHERE is_default = true AND is_active = true LIMIT 1;
  IF v_default_wh IS NULL THEN
    SELECT id INTO v_default_wh FROM warehouses WHERE is_active = true LIMIT 1;
  END IF;

  SELECT COALESCE(json_agg(json_build_object('id', p.id, 'payment_method', p.payment_method, 'amount', p.amount, 'payment_type', p.payment_type, 'payment_date', p.payment_date)), '[]'::json)
  INTO v_old_payments
  FROM payments p WHERE p.reference_type = 'invoice' AND p.reference_id = p_invoice_id;

  SELECT json_build_object(
    'customer_id', v_invoice.customer_id, 'invoice_date', v_invoice.invoice_date, 'due_date', v_invoice.due_date,
    'notes', v_invoice.notes, 'subtotal', v_invoice.subtotal,
    'cart_discount_percent', COALESCE(v_invoice.cart_discount_percent, 0),
    'extra_discount', COALESCE(v_invoice.extra_discount, 0),
    'shipping_cost', COALESCE(v_invoice.shipping_cost, 0),
    'total_amount', v_invoice.total_amount, 'amount_paid', v_invoice.amount_paid, 'status', v_invoice.status,
    'payment_term', v_old_payment_term, 'payments', v_old_payments,
    'cost_payment_method', v_invoice.cost_payment_method,
    'items', (SELECT json_agg(json_build_object('product_id', ii.product_id, 'quantity', ii.quantity, 'unit_price', ii.unit_price, 'discount_percent', ii.discount_percent, 'subtotal', ii.subtotal, 'unit_name', ii.unit_name, 'base_quantity', ii.base_quantity, 'warehouse_id', ii.warehouse_id)) FROM invoice_items ii WHERE ii.invoice_id = p_invoice_id)
  ) INTO v_old_snapshot;

  -- STEP 1: FIFO - Restore batch quantities for old items FIRST
  FOR v_item IN SELECT * FROM invoice_items WHERE invoice_id = p_invoice_id LOOP
    PERFORM restore_fifo(v_item.id);
  END LOOP;

  -- STEP 1b: Restore stock for old STOCKED items (PRESERVE original sale movements)
  FOR v_item IN SELECT ii.* FROM invoice_items ii JOIN products pr ON pr.id = ii.product_id WHERE ii.invoice_id = p_invoice_id AND pr.track_inventory LOOP
    v_qty := COALESCE(v_item.base_quantity, v_item.quantity);
    v_target_wh := COALESCE(v_item.warehouse_id, v_default_wh);
    IF v_target_wh IS NOT NULL THEN
      UPDATE inventory_items SET quantity_on_hand = quantity_on_hand + v_qty, updated_at = now()
      WHERE product_id = v_item.product_id AND warehouse_id = v_target_wh;
      IF NOT FOUND THEN
        INSERT INTO inventory_items (product_id, warehouse_id, quantity_on_hand, quantity_reserved, quantity_incoming)
        VALUES (v_item.product_id, v_target_wh, v_qty, 0, 0);
      END IF;
      INSERT INTO stock_movements (product_id, warehouse_id, movement_type, quantity, unit_cost, reference_type, reference_id, reference_number, notes)
      VALUES (v_item.product_id, v_target_wh, 'return_in', v_qty, COALESCE(v_item.cost_price, 0), 'invoice_edit', p_invoice_id, v_invoice.invoice_number, 'Stock restoration - invoice edited');
    END IF;
  END LOOP;

  -- Heal any IOU layers the restore repaid + resync counters from the ledger
  -- (old items still exist here, so this covers every pair the edit touches)
  FOR v_item IN
    SELECT DISTINCT ii.product_id, COALESCE(ii.warehouse_id, v_default_wh) AS wh
      FROM invoice_items ii
      JOIN products pr ON pr.id = ii.product_id
     WHERE ii.invoice_id = p_invoice_id AND pr.track_inventory
  LOOP
    PERFORM heal_negative_batches_and_resync(v_item.product_id, v_item.wh);
  END LOOP;

  -- STEP 2: Reverse AR + Revenue journal entry (net of the invoice's VAT and shipping)
  v_old_tax := LEAST(COALESCE(v_invoice.tax_amount, 0), v_invoice.total_amount);
  v_old_shipping := LEAST(COALESCE(v_invoice.shipping_cost, 0), GREATEST(0, v_invoice.total_amount - v_old_tax));
  IF v_old_tax > 0 AND v_vat_account IS NULL THEN
    RAISE EXCEPTION 'Invoice % carries VAT (%) but VAT Payable account (2100) is missing', v_invoice.invoice_number, v_old_tax;
  END IF;
  IF v_old_shipping > 0 AND v_shipping_account IS NULL THEN
    RAISE EXCEPTION 'Invoice % carries shipping (%) but Shipping Income account (4020) is missing', v_invoice.invoice_number, v_old_shipping;
  END IF;
  IF v_ar_account IS NOT NULL AND v_revenue_account IS NOT NULL AND v_invoice.total_amount > 0 THEN
    v_lines := to_json(ARRAY[]::json[]);
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_ar_account, 'debit', 0, 'credit', v_invoice.total_amount, 'description', 'Reverse AR for edited invoice ' || v_invoice.invoice_number)))::json);
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_revenue_account, 'debit', v_invoice.total_amount - v_old_tax - v_old_shipping, 'credit', 0, 'description',
      CASE WHEN v_old_tax > 0 OR v_old_shipping > 0
           THEN 'Reverse revenue (net of VAT and shipping) for edited invoice ' || v_invoice.invoice_number
           ELSE 'Reverse revenue for edited invoice ' || v_invoice.invoice_number END)))::json);
    IF v_old_tax > 0 THEN
      v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
        'account_id', v_vat_account, 'debit', v_old_tax, 'credit', 0, 'description', 'Reverse VAT for edited invoice ' || v_invoice.invoice_number)))::json);
    END IF;
    IF v_old_shipping > 0 THEN
      v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
        'account_id', v_shipping_account, 'debit', v_old_shipping, 'credit', 0, 'description', 'Reverse shipping income for edited invoice ' || v_invoice.invoice_number)))::json);
    END IF;
    PERFORM post_journal_entry(
      'REVERSAL - AR - Invoice ' || v_invoice.invoice_number || ' EDIT', COALESCE(v_invoice.invoice_date, CURRENT_DATE), 'invoice_edit', p_invoice_id,
      v_lines, v_invoice.customer_id
    );
  END IF;

  -- STEP 3: Delete original COGS journal entries (including the Quick Sell
  -- Cost JE, so the edit below re-posts it from the new lines) and roll back
  -- account balances
  FOR v_je_id IN
    SELECT je.id FROM journal_entries je
    WHERE je.reference_type = 'invoice'
      AND je.reference_id = p_invoice_id
      AND (je.description LIKE 'COGS%' OR je.description LIKE 'Quick Sell Cost%')
  LOOP
    UPDATE accounts a SET balance = balance - (
      SELECT CASE WHEN a.account_type IN ('asset', 'expense')
                  THEN COALESCE(SUM(jl.debit - jl.credit), 0)
                  ELSE COALESCE(SUM(jl.credit - jl.debit), 0) END
      FROM journal_lines jl
      WHERE jl.journal_entry_id = v_je_id AND jl.account_id = a.id
    )
    WHERE EXISTS (SELECT 1 FROM journal_lines jl
                  WHERE jl.journal_entry_id = v_je_id AND jl.account_id = a.id);
    DELETE FROM journal_lines WHERE journal_entry_id = v_je_id;
    DELETE FROM journal_entries WHERE id = v_je_id;
  END LOOP;

  -- Restore advance applications (sub-ledger) AND reverse their journal, so the
  -- general ledger and the customer's wallets agree again before the invoice is rewritten. Without this an edited advance-paid invoice
  -- was reset to unpaid while the wallet stayed spent, and re-entering a cash
  -- payment on the edit double-counted the same money.
  -- Before this, cancelling an advance-paid invoice put the money back in the
  -- wallet (customer_advances.balance) while Dr 2300 / Cr 1100 stayed on the
  -- books: the GL said the advance was spent and the sub-ledger said it was
  -- still held. Now each restored application posts the mirror entry
  -- Dr 1100 (AR) / Cr 2300 (customer advances).
  SELECT id INTO v_adv_account FROM accounts WHERE code = '2300' LIMIT 1;
  FOR v_app IN
    SELECT advance_id, customer_id, amount
      FROM customer_advance_applications
     WHERE invoice_id = p_invoice_id
  LOOP
    UPDATE customer_advances ca
       SET balance = ca.balance + v_app.amount,
           status = CASE WHEN ca.status = 'applied' THEN 'active' ELSE ca.status END,
           updated_at = now()
     WHERE ca.id = v_app.advance_id;

    IF v_ar_account IS NOT NULL AND v_adv_account IS NOT NULL AND COALESCE(v_app.amount, 0) > 0 THEN
      PERFORM post_journal_entry(
        'Reverse advance application - ' || v_invoice.invoice_number,
        COALESCE(v_invoice.invoice_date, CURRENT_DATE),
        'advance_application_reversal',
        v_app.advance_id,
        json_build_array(
          json_build_object('account_id', v_ar_account, 'debit', v_app.amount, 'credit', 0,
            'description', 'Restore AR for reversed advance application on ' || v_invoice.invoice_number),
          json_build_object('account_id', v_adv_account, 'debit', 0, 'credit', v_app.amount,
            'description', 'Customer advance restored - ' || v_invoice.invoice_number)
        )::json,
        v_app.customer_id
      );
    END IF;

    v_total_advance_reversed := v_total_advance_reversed + COALESCE(v_app.amount, 0);
  END LOOP;

  DELETE FROM customer_advance_applications WHERE invoice_id = p_invoice_id;

  -- STEP 4: Reverse original payments AND mark them as reversed
  FOR v_payment IN SELECT * FROM payments WHERE reference_type = 'invoice' AND reference_id = p_invoice_id AND is_reversed = false LOOP
    INSERT INTO payments (payment_number, payment_type, payment_method, amount, payment_date, reference_type, reference_id, reference_number, notes, payment_for, customer_id)
    VALUES ('REV-' || COALESCE(v_payment.payment_number, 'PAY'), CASE WHEN v_payment.payment_type = 'received' THEN 'refund' ELSE 'payment' END, v_payment.payment_method, v_payment.amount, CURRENT_DATE, 'invoice_edit', p_invoice_id, v_invoice.invoice_number, 'Reversal payment for edited invoice ' || v_invoice.invoice_number, 'reversal_payment', COALESCE(v_payment.customer_id, v_invoice.customer_id));
    UPDATE payments SET is_reversed = true WHERE id = v_payment.id;
  END LOOP;

  -- Delete original payment journal entries and roll back account balances
  FOR v_je_id IN
    SELECT je.id FROM journal_entries je
    WHERE je.reference_type = 'payment'
      AND je.reference_id IN (SELECT id FROM payments WHERE reference_type = 'invoice' AND reference_id = p_invoice_id)
  LOOP
    UPDATE accounts a SET balance = balance - (
      SELECT CASE WHEN a.account_type IN ('asset', 'expense')
                  THEN COALESCE(SUM(jl.debit - jl.credit), 0)
                  ELSE COALESCE(SUM(jl.credit - jl.debit), 0) END
      FROM journal_lines jl
      WHERE jl.journal_entry_id = v_je_id AND jl.account_id = a.id
    )
    WHERE EXISTS (SELECT 1 FROM journal_lines jl
                  WHERE jl.journal_entry_id = v_je_id AND jl.account_id = a.id);
    DELETE FROM journal_lines WHERE journal_entry_id = v_je_id;
    DELETE FROM journal_entries WHERE id = v_je_id;
  END LOOP;

  -- STEP 5: Update invoice header (cost_payment_method preserved unless the
  -- edit payload supplies a new one)
  UPDATE invoices
  SET customer_id = v_new_customer, invoice_date = v_new_date, due_date = v_new_due_date, notes = v_new_notes,
      reference = v_new_reference,
      subtotal = v_new_subtotal, cart_discount_percent = v_new_cart_discount_percent, extra_discount = v_new_extra_discount,
      discount_amount = v_cart_discount_amount, total_amount = v_new_total, tax_amount = v_new_tax, shipping_cost = v_new_shipping, amount_paid = 0,
      cost_payment_method = COALESCE(v_new_cost_method, cost_payment_method),
      status = 'draft', edit_count = COALESCE(edit_count, 0) + 1, updated_at = now()
  WHERE id = p_invoice_id;

  -- STEP 5b: Set session flag to prevent DELETE trigger from double-restoring stock
  PERFORM set_config('app.edit_invoice_active', 'true', true);

  -- STEP 6: Re-insert items
  DELETE FROM invoice_items WHERE invoice_id = p_invoice_id;
  FOR v_i IN SELECT generate_series(0, json_array_length(v_new_items) - 1) LOOP
    v_new_item := v_new_items->v_i;
    INSERT INTO invoice_items (invoice_id, product_id, quantity, unit_price, cost_price, discount_percent, tax_rate, subtotal, unit_name, unit_conversion_factor, base_quantity, warehouse_id, source_shop, sort_order)
    VALUES (
      p_invoice_id,
      (v_new_item->>'product_id')::uuid,
      (v_new_item->>'quantity')::numeric,
      (v_new_item->>'unit_price')::numeric,
      COALESCE((v_new_item->>'cost_price')::numeric, 0),
      COALESCE((v_new_item->>'discount_percent')::numeric, 0),
      0,
      (v_new_item->>'quantity')::numeric * (v_new_item->>'unit_price')::numeric * (1 - COALESCE((v_new_item->>'discount_percent')::numeric, 0) / 100),
      NULLIF(v_new_item->>'unit_name', ''),
      NULLIF(v_new_item->>'unit_conversion_factor', '')::numeric,
      COALESCE((v_new_item->>'base_quantity')::numeric, (v_new_item->>'quantity')::numeric),
      NULLIF(v_new_item->>'warehouse_id', '')::uuid,
      NULLIF(v_new_item->>'source_shop', ''),
      v_i
    );
  END LOOP;

  -- Reset session flag
  PERFORM set_config('app.edit_invoice_active', 'false', true);

  -- STEP 6a: Re-record cost price history
  DELETE FROM cost_price_history WHERE invoice_id = p_invoice_id;
  FOR v_i IN SELECT generate_series(0, json_array_length(v_new_items) - 1) LOOP
    v_new_item := v_new_items->v_i;
    SELECT name, sku INTO v_product FROM products WHERE id = (v_new_item->>'product_id')::uuid;
    v_cost_per_unit := COALESCE((v_new_item->>'cost_price')::numeric, 0);
    v_qty := (v_new_item->>'quantity')::numeric;
    v_total_cost_added := v_cost_per_unit * v_qty;
    INSERT INTO cost_price_history (
      product_id, product_name, product_sku, invoice_id, unit, quantity,
      unit_price, cost_price_per_qty, cost_price_for_added_qty,
      total_cost_price_single, total_cost_price_added
    ) VALUES (
      (v_new_item->>'product_id')::uuid,
      COALESCE(v_product.name, 'Unknown'),
      COALESCE(v_product.sku, ''),
      p_invoice_id,
      COALESCE(NULLIF(v_new_item->>'unit_name', ''), 'pcs'),
      v_qty,
      (v_new_item->>'unit_price')::numeric,
      v_cost_per_unit,
      v_total_cost_added,
      v_cost_per_unit,
      v_total_cost_added
    );
  END LOOP;

  -- STEP 6b: Sync delivery_items
  FOR v_delivery IN SELECT id FROM deliveries WHERE invoice_id = p_invoice_id AND status != 'delivered' LOOP
    DELETE FROM delivery_items WHERE delivery_id = v_delivery.id;
    FOR v_i IN SELECT generate_series(0, json_array_length(v_new_items) - 1) LOOP
      v_new_item := v_new_items->v_i;
      INSERT INTO delivery_items (delivery_id, product_id, quantity, delivered_quantity, unit_name, base_quantity)
      VALUES (
        v_delivery.id,
        (v_new_item->>'product_id')::uuid,
        (v_new_item->>'quantity')::numeric,
        0,
        NULLIF(v_new_item->>'unit_name', ''),
        COALESCE((v_new_item->>'base_quantity')::numeric, (v_new_item->>'quantity')::numeric)
      );
    END LOOP;
  END LOOP;

  -- STEP 7: Re-post AR + Revenue for new total (revenue net of VAT and shipping).
  IF v_ar_account IS NOT NULL AND v_revenue_account IS NOT NULL AND v_new_total > 0 THEN
    IF v_new_tax > 0 AND v_vat_account IS NULL THEN
      RAISE EXCEPTION 'Edited invoice % carries VAT (%) but VAT Payable account (2100) is missing', v_invoice.invoice_number, v_new_tax;
    END IF;
    IF v_new_shipping > 0 AND v_shipping_account IS NULL THEN
      RAISE EXCEPTION 'Edited invoice % carries shipping (%) but Shipping Income account (4020) is missing', v_invoice.invoice_number, v_new_shipping;
    END IF;
    v_lines := to_json(ARRAY[]::json[]);
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_ar_account, 'debit', v_new_total, 'credit', 0, 'description', 'AR for edited invoice ' || v_invoice.invoice_number)))::json);
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_revenue_account, 'debit', 0, 'credit', v_new_total - v_new_tax - v_new_shipping, 'description',
      CASE WHEN v_new_tax > 0 OR v_new_shipping > 0
           THEN 'Revenue (net of VAT and shipping) for edited invoice ' || v_invoice.invoice_number
           ELSE 'Revenue for edited invoice ' || v_invoice.invoice_number END)))::json);
    IF v_new_tax > 0 THEN
      v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
        'account_id', v_vat_account, 'debit', 0, 'credit', v_new_tax, 'description', 'VAT payable for edited invoice ' || v_invoice.invoice_number)))::json);
    END IF;
    IF v_new_shipping > 0 THEN
      v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
        'account_id', v_shipping_account, 'debit', 0, 'credit', v_new_shipping, 'description', 'Shipping income for edited invoice ' || v_invoice.invoice_number)))::json);
    END IF;
    PERFORM post_journal_entry(
      'Accounts Receivable - Invoice ' || v_invoice.invoice_number || ' EDITED', v_new_date, 'invoice', p_invoice_id,
      v_lines, v_new_customer
    );
  END IF;

  -- STEP 7b: Post COGS journal entry for new items. Non-stock (quick-sell)
  -- items post through post_quick_sell_cost_je against the account the source
  -- shop was paid from — never Inventory 1200 — and are excluded from the
  -- no-FIFO fallback below.
  IF v_cogs_account IS NOT NULL AND v_inventory_account IS NOT NULL THEN
    DECLARE
      v_cogs_total decimal(15,2) := 0;
      v_has_fifo_data boolean := false;
      v_has_nonstock boolean := false;
    BEGIN
      SELECT EXISTS(
        SELECT 1 FROM invoice_items ii JOIN products pr ON pr.id = ii.product_id
         WHERE ii.invoice_id = p_invoice_id AND NOT pr.track_inventory
           AND ii.quantity > 0 AND COALESCE(ii.cost_price, 0) > 0
      ) INTO v_has_nonstock;
      IF v_has_nonstock THEN
        PERFORM post_quick_sell_cost_je(p_invoice_id);
      END IF;

      FOR v_item IN SELECT ii.*, p.name as product_name, p.sku FROM invoice_items ii JOIN products p ON ii.product_id = p.id WHERE ii.invoice_id = p_invoice_id ORDER BY ii.sort_order LOOP
        v_cost := 0;
        SELECT COALESCE(SUM(cogs_amount), 0) INTO v_cost
        FROM invoice_item_batch_consumption WHERE invoice_item_id = v_item.id;

        IF v_cost > 0 THEN
          v_cogs_total := v_cogs_total + v_cost;
          v_has_fifo_data := true;
        END IF;
      END LOOP;

      IF v_has_fifo_data AND v_cogs_total > 0 THEN
        PERFORM post_journal_entry(
          'COGS - ' || v_invoice.invoice_number,
          COALESCE(v_new_date, CURRENT_DATE),
          'invoice', p_invoice_id,
          json_build_array(
            json_build_object('account_id', v_cogs_account, 'debit', v_cogs_total, 'credit', 0,
              'description', 'COGS (FIFO) from consumption records'),
            json_build_object('account_id', v_inventory_account, 'debit', 0, 'credit', v_cogs_total,
              'description', 'Inventory released (FIFO)')
          )::json, v_new_customer
        );
      ELSE
        -- FALLBACK: stocked items without FIFO data only. Non-stock items are
        -- handled by post_quick_sell_cost_je above.
        v_cogs_total := 0;
        FOR v_item IN SELECT ii.*, p.name as product_name, p.sku FROM invoice_items ii JOIN products p ON ii.product_id = p.id WHERE ii.invoice_id = p_invoice_id AND p.track_inventory ORDER BY ii.sort_order LOOP
          v_qty := COALESCE(v_item.base_quantity, v_item.quantity);
          v_cost := COALESCE(v_item.cost_price, 0) * v_qty;
          IF v_cost > 0 THEN
            v_cogs_total := v_cogs_total + v_cost;
          END IF;
        END LOOP;

        IF v_cogs_total > 0 THEN
          PERFORM post_journal_entry(
            'COGS - ' || v_invoice.invoice_number,
            COALESCE(v_new_date, CURRENT_DATE),
            'invoice', p_invoice_id,
            json_build_array(
              json_build_object('account_id', v_cogs_account, 'debit', v_cogs_total, 'credit', 0,
                'description', 'COGS (fallback: cost_price × quantity)'),
              json_build_object('account_id', v_inventory_account, 'debit', 0, 'credit', v_cogs_total,
                'description', 'Inventory released (fallback)')
            )::json, v_new_customer
          );
        END IF;
      END IF;
    END;
  END IF;

  -- STEP 8: Apply new payment term
  IF v_new_payment_term = 'credit' THEN
    UPDATE invoices SET status = 'sent', amount_paid = 0 WHERE id = p_invoice_id;
  ELSIF v_new_payment_term = 'partial' THEN
    v_new_partial_amount := LEAST(v_new_partial_amount, v_new_total);
    IF v_new_partial_amount > 0 THEN
      INSERT INTO payments (payment_number, payment_type, payment_method, amount, payment_date, reference_type, reference_id, reference_number, notes, payment_for, customer_id)
      VALUES ('EDIT-' || v_invoice.invoice_number, 'received', v_new_payment_method, v_new_partial_amount, v_new_date, 'invoice', p_invoice_id, v_invoice.invoice_number, 'Partial payment for edited invoice ' || v_invoice.invoice_number, 'paid_invoice_pay', v_new_customer)
      RETURNING id INTO v_new_payment_id;
      IF v_cash_account IS NOT NULL AND v_ar_account IS NOT NULL THEN
        PERFORM post_journal_entry(
          'Payment - Invoice ' || v_invoice.invoice_number || ' EDITED', v_new_date, 'payment', v_new_payment_id,
          json_build_array(
            json_build_object('account_id', v_cash_account, 'debit', v_new_partial_amount, 'credit', 0, 'description', 'Partial payment received for ' || v_invoice.invoice_number),
            json_build_object('account_id', v_ar_account, 'debit', 0, 'credit', v_new_partial_amount, 'description', 'AR cleared for ' || v_invoice.invoice_number)
          )::json, v_new_customer
        );
      END IF;
      UPDATE invoices SET status = 'partially_paid', amount_paid = v_new_partial_amount WHERE id = p_invoice_id;
    ELSE
      UPDATE invoices SET status = 'sent', amount_paid = 0 WHERE id = p_invoice_id;
    END IF;
  ELSE
    IF v_new_total > 0 THEN
      INSERT INTO payments (payment_number, payment_type, payment_method, amount, payment_date, reference_type, reference_id, reference_number, notes, payment_for, customer_id)
      VALUES ('EDIT-' || v_invoice.invoice_number, 'received', v_new_payment_method, v_new_total, v_new_date, 'invoice', p_invoice_id, v_invoice.invoice_number, 'Payment for edited invoice ' || v_invoice.invoice_number, 'paid_invoice_pay', v_new_customer)
      RETURNING id INTO v_new_payment_id;
      IF v_cash_account IS NOT NULL AND v_ar_account IS NOT NULL THEN
        PERFORM post_journal_entry(
          'Payment - Invoice ' || v_invoice.invoice_number || ' EDITED', v_new_date, 'payment', v_new_payment_id,
          json_build_array(
            json_build_object('account_id', v_cash_account, 'debit', v_new_total, 'credit', 0, 'description', 'Payment received for ' || v_invoice.invoice_number),
            json_build_object('account_id', v_ar_account, 'debit', 0, 'credit', v_new_total, 'description', 'AR cleared for ' || v_invoice.invoice_number)
          )::json, v_new_customer
        );
      END IF;
      -- The invoice is being re-marked fully collected. If a bad-debt write-off
      -- was ever posted against it, reverse it now, otherwise AR is credited
      -- twice for the same money (once by the write-off JE, once by this payment).
      IF COALESCE(v_invoice.bad_debt_amount, 0) > 0 AND v_ar_account IS NOT NULL AND v_bad_debt_account IS NOT NULL THEN
        PERFORM post_journal_entry(
          'REVERSAL - Bad debt write-off - Invoice ' || v_invoice.invoice_number || ' EDITED', v_new_date, 'invoice_edit', p_invoice_id,
          json_build_array(
            json_build_object('account_id', v_ar_account, 'debit', v_invoice.bad_debt_amount, 'credit', 0, 'description', 'Bad-debt write-off reversed (fully collected) for ' || v_invoice.invoice_number),
            json_build_object('account_id', v_bad_debt_account, 'debit', 0, 'credit', v_invoice.bad_debt_amount, 'description', 'Reverse bad-debt expense for ' || v_invoice.invoice_number)
          )::json, v_new_customer
        );
      END IF;
      UPDATE invoices SET status = 'paid', amount_paid = v_new_total, bad_debt_amount = 0 WHERE id = p_invoice_id;
    ELSE
      UPDATE invoices SET status = 'paid', amount_paid = 0 WHERE id = p_invoice_id;
    END IF;
  END IF;

  -- STEP 9: Record edit history
  SELECT json_build_object('customer_id', v_new_customer, 'invoice_date', v_new_date, 'due_date', v_new_due_date, 'notes', v_new_notes, 'reference', v_new_reference, 'subtotal', v_new_subtotal, 'cart_discount_percent', v_new_cart_discount_percent, 'extra_discount', v_new_extra_discount, 'shipping_cost', v_new_shipping, 'total_amount', v_new_total, 'payment_term', v_new_payment_term, 'payment_method', v_new_payment_method, 'items', v_new_items) INTO v_new_snapshot;

  INSERT INTO invoice_edit_history (invoice_id, invoice_number, edited_by_name, change_type, reason, snapshot_before, snapshot_after, old_value, new_value)
  VALUES (p_invoice_id, v_invoice.invoice_number, p_edited_by, 'full_edit', p_reason, v_old_snapshot, v_new_snapshot, v_old_snapshot, v_new_snapshot);

  -- STEP 10: Update customer outstanding_balance
  IF v_invoice.customer_id IS NOT NULL THEN
    UPDATE customers SET outstanding_balance = (SELECT COALESCE(SUM(balance_due), 0) FROM invoices WHERE customer_id = v_invoice.customer_id AND status IN ('sent', 'partially_paid', 'unpaid', 'overdue')), updated_at = now() WHERE id = v_invoice.customer_id;
  END IF;
  IF v_new_customer IS NOT NULL AND v_new_customer <> v_invoice.customer_id THEN
    UPDATE customers SET outstanding_balance = (SELECT COALESCE(SUM(balance_due), 0) FROM invoices WHERE customer_id = v_new_customer AND status IN ('sent', 'partially_paid', 'unpaid', 'overdue')), updated_at = now() WHERE id = v_new_customer;
  END IF;

  -- Final counter resync: the re-inserted items re-fired the deduct trigger,
  -- which floors the counter at 0 on oversell; set it back to the ledger sum.
  FOR v_item IN
    SELECT DISTINCT ii.product_id, COALESCE(ii.warehouse_id, v_default_wh) AS wh
      FROM invoice_items ii
      JOIN products pr ON pr.id = ii.product_id
     WHERE ii.invoice_id = p_invoice_id AND pr.track_inventory
  LOOP
    PERFORM heal_negative_batches_and_resync(v_item.product_id, v_item.wh);
  END LOOP;

  RETURN json_build_object('success', true, 'invoice_id', p_invoice_id, 'old_total', v_invoice.total_amount, 'new_total', v_new_total,
    'advance_applications_reversed', v_total_advance_reversed);
END;
$function$;



CREATE OR REPLACE FUNCTION public.restore_stock_on_invoice_item_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_invoice_record RECORD;
  v_target_wh uuid;
  v_qty_to_restore numeric;
  v_inv_id uuid;
  v_product_cost numeric;
  v_existing_movement RECORD;
BEGIN
  -- Quick-sell (non-stock) products have no stock to restore.
  IF NOT COALESCE((SELECT p.track_inventory FROM products p WHERE p.id = OLD.product_id), true) THEN
    RETURN OLD;
  END IF;

  -- Skip if called from within edit_invoice (it handles stock restoration itself)
  IF current_setting('app.edit_invoice_active', true) = 'true' THEN
    RETURN OLD;
  END IF;

  SELECT * INTO v_invoice_record FROM invoices WHERE id = OLD.invoice_id;
  IF NOT FOUND THEN
    RETURN OLD;
  END IF;

  IF v_invoice_record.status = 'cancelled' THEN
    RETURN OLD;
  END IF;

  SELECT * INTO v_existing_movement
  FROM stock_movements
  WHERE reference_id = OLD.invoice_id
    AND reference_type = 'invoice'
    AND product_id = OLD.product_id
    AND movement_type = 'sale'
    AND notes LIKE '%invoice_item:' || OLD.id::text || '%'
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN OLD;
  END IF;

  v_qty_to_restore := ABS(v_existing_movement.quantity);

  v_target_wh := v_existing_movement.warehouse_id;

  IF v_target_wh IS NULL THEN
    v_target_wh := OLD.warehouse_id;
  END IF;

  IF v_target_wh IS NULL THEN
    SELECT id INTO v_target_wh FROM warehouses WHERE is_default = true AND is_active = true LIMIT 1;
  END IF;

  IF v_target_wh IS NULL THEN
    RETURN OLD;
  END IF;

  SELECT id INTO v_inv_id
  FROM inventory_items
  WHERE product_id = OLD.product_id AND warehouse_id = v_target_wh
  FOR UPDATE;

  IF v_inv_id IS NOT NULL THEN
    UPDATE inventory_items
    SET quantity_on_hand = quantity_on_hand + v_qty_to_restore,
        updated_at = now()
    WHERE id = v_inv_id;
  ELSE
    INSERT INTO inventory_items (product_id, warehouse_id, quantity_on_hand, quantity_reserved, quantity_incoming)
    VALUES (OLD.product_id, v_target_wh, v_qty_to_restore, 0, 0);
  END IF;

  SELECT cost_price INTO v_product_cost FROM products WHERE id = OLD.product_id;

  INSERT INTO stock_movements (
    product_id, warehouse_id, movement_type, quantity,
    unit_cost, reference_type, reference_id, reference_number, notes
  ) VALUES (
    OLD.product_id, v_target_wh, 'return_in', v_qty_to_restore,
    COALESCE(v_product_cost, 0), 'invoice', OLD.invoice_id,
    v_invoice_record.invoice_number,
    'Stock restoration - invoice item deleted - invoice_item:' || OLD.id::text
  );

  PERFORM heal_negative_batches_and_resync(OLD.product_id, v_target_wh);

  RETURN OLD;
END;
$function$;



CREATE OR REPLACE FUNCTION public.sync_stock_transfer_create(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id      uuid := (p_payload->>'id')::uuid;
  v_number  text := p_payload->>'transfer_number';
  v_product uuid := (p_payload->>'product_id')::uuid;
  v_from    uuid := (p_payload->>'from_warehouse_id')::uuid;
  v_to      uuid := (p_payload->>'to_warehouse_id')::uuid;
  v_qty     numeric := (p_payload->>'quantity')::numeric;
  v_cost    numeric := coalesce((p_payload->>'unit_cost')::numeric, 0);
  v_notes   text;
  v_inv_id  uuid;
BEGIN
  IF v_qty IS NULL OR v_qty <= 0 THEN
    RAISE EXCEPTION 'stock_transfer.create: quantity must be greater than 0';
  END IF;
  IF v_from = v_to THEN
    RAISE EXCEPTION 'stock_transfer.create: source and destination warehouse are the same';
  END IF;

  INSERT INTO stock_movements (tenant_id, product_id, warehouse_id, movement_type,
    quantity, unit_cost, reference_type, reference_id, reference_number, notes)
  VALUES ('00000000-0000-0000-0000-000000000001', v_product, v_from, 'transfer_out',
    -v_qty, v_cost, 'transfer', v_id, v_number,
    coalesce(nullif(p_payload->>'notes', ''), 'Transfer out'));

  INSERT INTO stock_movements (tenant_id, product_id, warehouse_id, movement_type,
    quantity, unit_cost, reference_type, reference_id, reference_number, notes)
  VALUES ('00000000-0000-0000-0000-000000000001', v_product, v_to, 'transfer_in',
    v_qty, v_cost, 'transfer', v_id, v_number,
    coalesce(nullif(p_payload->>'notes', ''), 'Transfer in'));

  PERFORM public.transfer_fifo_batches(v_product, v_from, v_to, v_qty, v_id, v_number);

  UPDATE inventory_items SET
    quantity_on_hand = GREATEST(0, quantity_on_hand - v_qty),
    updated_at = now()
  WHERE product_id = v_product AND warehouse_id = v_from;

  SELECT id INTO v_inv_id FROM inventory_items
  WHERE product_id = v_product AND warehouse_id = v_to LIMIT 1;
  IF v_inv_id IS NOT NULL THEN
    UPDATE inventory_items SET
      quantity_on_hand = quantity_on_hand + v_qty,
      updated_at = now()
    WHERE id = v_inv_id;
  ELSE
    INSERT INTO inventory_items (tenant_id, product_id, warehouse_id, quantity_on_hand)
    VALUES ('00000000-0000-0000-0000-000000000001', v_product, v_to, v_qty);
  END IF;

  PERFORM heal_negative_batches_and_resync(v_product, v_from);
  PERFORM heal_negative_batches_and_resync(v_product, v_to);

  RETURN jsonb_build_object('status', 'synced', 'transfer_id', v_id,
    'transfer_number', v_number);
END;
$function$;



CREATE OR REPLACE FUNCTION public.sync_purchase_return_create(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_po       purchase_orders%rowtype;
  v_id       uuid;
  v_number   text;
  v_ratio    numeric;
  v_total    numeric := 0;
  v_wh       uuid;
  v_item     jsonb;
  v_po_item  purchase_order_items%rowtype;
  v_inv_id   uuid;
  v_qty      numeric;
  v_refund   numeric;
  v_wh_id    uuid;
  v_rcvd     numeric;
begin
  select * into v_po from purchase_orders where id = (p_payload->>'purchase_order_id')::uuid;
  if not found then
    raise exception 'purchase_return.create: purchase order not found';
  end if;

  if p_payload ? 'id' then
    v_id := (p_payload->>'id')::uuid;
  else
    v_id := gen_random_uuid();
  end if;
  v_number := coalesce(nullif(p_payload->>'return_number', ''),
    'PRET-' || to_char(now(), 'HH24MISS'));

  v_ratio := case when coalesce(v_po.subtotal, 0) > 0
    then v_po.total_amount / v_po.subtotal else 1 end;

  select id into v_wh from warehouses where is_default limit 1;

  for v_item in select * from jsonb_array_elements(p_payload->'items')
  loop
    select * into v_po_item from purchase_order_items
      where id = (v_item->>'purchase_order_item_id')::uuid;
    if not found then
      raise exception 'purchase_return.create: PO item not found';
    end if;

    v_qty    := (v_item->>'quantity')::numeric;
    v_wh_id  := coalesce(nullif(v_item->>'warehouse_id', '')::uuid, v_po_item.warehouse_id, v_wh);
    v_refund := v_qty * coalesce(v_po_item.unit_cost, 0) * v_ratio;
    v_total  := v_total + v_refund;

    insert into stock_movements (tenant_id, product_id, warehouse_id, movement_type,
      quantity, unit_cost, reference_type, reference_id, reference_number, notes)
    values ('00000000-0000-0000-0000-000000000001', v_po_item.product_id, v_wh_id,
      'return_out', -v_qty, coalesce(v_po_item.unit_cost, 0),
      'purchase_return', v_id, v_number,
      coalesce(nullif(v_item->>'reason', ''), 'Return to supplier from PO ' || v_po.po_number));

    perform public.reverse_fifo_on_purchase_return(
      v_po_item.product_id, v_wh_id, v_qty, coalesce(v_po_item.unit_cost, 0), v_id, v_number);

    update inventory_items set
      quantity_on_hand = greatest(0, quantity_on_hand - v_qty),
      updated_at = now()
    where product_id = v_po_item.product_id and warehouse_id = v_wh_id;

    perform public.heal_negative_batches_and_resync(v_po_item.product_id, v_wh_id);

    v_rcvd := coalesce(v_po_item.received_quantity, v_po_item.quantity);
    update purchase_order_items set received_quantity = greatest(0, v_rcvd - v_qty)
    where id = v_po_item.id;
  end loop;

  insert into purchase_returns (id, return_number, purchase_order_id, supplier_id,
    warehouse_id, return_date, total_amount, status)
  values (v_id, v_number, v_po.id, v_po.supplier_id, v_wh,
    coalesce(nullif(p_payload->>'return_date', '')::date, current_date),
    v_total, 'completed');

  insert into purchase_return_items (purchase_return_id, product_id, quantity, unit_cost,
    subtotal, reason)
  select v_id,
    pi.product_id,
    (it.item->>'quantity')::numeric,
    coalesce(pi.unit_cost, 0),
    (it.item->>'quantity')::numeric * coalesce(pi.unit_cost, 0) * v_ratio,
    case when it.item->>'reason' in ('defective','wrong_item','quality_issue','overstock','other')
      then it.item->>'reason' else 'other' end
  from (select item from jsonb_array_elements(p_payload->'items') item) it
  join purchase_order_items pi
    on pi.id = (it.item->>'purchase_order_item_id')::uuid;

  return jsonb_build_object('status', 'synced', 'return_id', v_id,
    'return_number', v_number, 'refund_amount', v_total);
end;
$function$;



CREATE OR REPLACE FUNCTION public.create_stock_reduction(p_product_id uuid, p_warehouse_id uuid, p_quantity numeric, p_unit_cost numeric, p_reference_type text DEFAULT 'stock_adjustment'::text, p_reference_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT 'Stock decrease adjustment'::text, p_tenant_id uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_remaining_qty numeric := p_quantity;
  v_reduce_qty numeric;
  v_batch_cost numeric;
  v_consumed_value numeric := 0;
  v_batch_id uuid;
  v_audit_batch_id uuid;
  -- journal amount is finalized after consumption: the real layer value
  -- consumed plus any shortfall at the passed cost (batch-accurate GL).
  v_amount numeric := 0;
  v_account_1200 uuid;
  v_account_3900 uuid;
  v_product_name text;
  v_product_sku text;
  v_warehouse_name text;
  v_header text;
BEGIN
  IF p_quantity <= 0 THEN
    RETURN NULL;
  END IF;

  -- Lookup product + warehouse for human-readable journal descriptions
  SELECT name, sku INTO v_product_name, v_product_sku
    FROM products WHERE id = p_product_id;
  SELECT name INTO v_warehouse_name FROM warehouses WHERE id = p_warehouse_id;

  v_product_name := COALESCE(v_product_name, 'Unknown Product');
  v_product_sku := COALESCE(v_product_sku, 'N/A');
  v_warehouse_name := COALESCE(v_warehouse_name, 'Unknown Warehouse');

  -- 1. Reduce quantity_remaining from oldest batches first (FIFO)
  v_consumed_value := 0;
  FOR v_batch_id, v_batch_cost IN
    SELECT ib.id, ib.unit_cost
    FROM inventory_batches ib
    WHERE ib.product_id = p_product_id
      AND ib.warehouse_id = p_warehouse_id
      AND ib.quantity_remaining > 0
    ORDER BY ib.created_at ASC, ib.id ASC
    FOR UPDATE
  LOOP
    EXIT WHEN v_remaining_qty <= 0;

    -- Only consume what this batch actually holds (and never more than remaining)
    SELECT LEAST(quantity_remaining, v_remaining_qty)
      INTO v_reduce_qty
      FROM inventory_batches WHERE id = v_batch_id;

    UPDATE inventory_batches
    SET quantity_remaining = quantity_remaining - v_reduce_qty
    WHERE id = v_batch_id;

    v_consumed_value := v_consumed_value + (v_reduce_qty * v_batch_cost);
    v_remaining_qty := v_remaining_qty - v_reduce_qty;
  END LOOP;

  -- 2. Insert a reduction batch ONLY for the shortfall the real layers could
  --    not cover (an over-reduction IOU). A fully-covered reduction is already
  --    recorded by the layer consumption + stock movement + journal entry —
  --    adding a full-qty audit row here double-subtracted the batch ledger
  --    against the GL whenever real stock was consumed (bug fixed 2026-09-01).
  IF v_remaining_qty > 0 THEN
    INSERT INTO inventory_batches (
      tenant_id, product_id, warehouse_id, batch_number,
      quantity_received, quantity_remaining, unit_cost,
      batch_type, reference_type, reference_id, notes, created_at
    ) VALUES (
      p_tenant_id, p_product_id, p_warehouse_id,
      'REDUCE-' || to_char(CURRENT_DATE, 'YYYYMMDD') || '-' || substring(p_product_id::text, 1, 8),
      0, -v_remaining_qty, p_unit_cost,
      'adjustment', p_reference_type, p_reference_id, p_notes, CURRENT_DATE
    ) RETURNING id INTO v_audit_batch_id;
  END IF;

  -- 3. Post journal entry: Dr 3900 / Cr 1200 at the value actually consumed
  --    (layer costs), plus any uncovered shortfall at the passed cost.
  --    Quantity corrections are equity, not P&L expense (owner decision
  --    2026-09-07); account 5900 is legacy with no writers since this
  --    migration.
  v_amount := ROUND(v_consumed_value + (v_remaining_qty * p_unit_cost), 2);
  IF v_amount > 0 THEN
    SELECT id INTO v_account_1200 FROM accounts
      WHERE code = '1200' AND tenant_id = p_tenant_id;
    SELECT id INTO v_account_3900 FROM accounts
      WHERE code = '3900' AND tenant_id = p_tenant_id;

    IF v_account_1200 IS NOT NULL AND v_account_3900 IS NOT NULL THEN
      v_header := 'Stock reduction - ' || v_product_name || ' (' || v_product_sku || '): '
        || p_quantity || ' @ ' || p_unit_cost || ' in ' || v_warehouse_name;

      PERFORM post_journal_entry(
        p_description := v_header,
        p_entry_date := CURRENT_DATE,
        p_reference_type := p_reference_type,
        p_reference_id := p_reference_id,
        p_lines := json_build_array(
          json_build_object(
            'account_id', v_account_3900,
            'debit', v_amount,
            'description', 'Inventory reduction: ' || v_product_name || ' (' || v_product_sku || ') in ' || v_warehouse_name
          ),
          json_build_object(
            'account_id', v_account_1200,
            'credit', v_amount,
            'description', 'Inventory released (FIFO layers depleted): ' || v_product_name
          )
        )
      );
    ELSE
      RAISE WARNING 'Accounts 1200 or 3900 missing for tenant %; batch % created without GL entry',
        p_tenant_id, v_audit_batch_id;
    END IF;
  END IF;

  PERFORM heal_negative_batches_and_resync(p_product_id, p_warehouse_id);

  RETURN v_audit_batch_id;
END;
$function$;

