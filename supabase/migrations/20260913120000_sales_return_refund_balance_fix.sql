-- Sales returns no longer decrement invoices.amount_paid.
--
-- record_sales_return() treated a refund as "un-paying" the invoice
-- (amount_paid := amount_paid - refund) while total_amount stayed put, so the
-- generated balance_due (total_amount - amount_paid - bad_debt_amount) went
-- back UP by exactly the refund — a ৳490 cash refund on a fully-paid POS
-- invoice showed ৳490 as "Balance Due" (POS-00590220, INV-940689, 2026-09-12).
--
-- The correct model (and what the journals already post — Cr Cash for cash
-- refunds, Cr 2200 for store credit, never Cr 1100 AR): a refund settles
-- through cash-out or store credit, NOT through the invoice receivable.
-- amount_paid must stay "cash actually received"; the invoice balance is
-- already correct without any refund adjustment. Refunds are now tracked in
-- a refunded_amount column (display + 'refunded' status) instead.

-- 1. Track refunds on the invoice (maintained by record_sales_return).
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS refunded_amount numeric NOT NULL DEFAULT 0;

-- 2. Backfill from completed returns (pre-atomic returns never touched
--    amount_paid — the old page's UPDATE on generated balance_due errored and
--    was swallowed — so those invoices need no repair, only the backfill).
UPDATE invoices i
SET refunded_amount = sr.total
FROM (
  SELECT invoice_id, SUM(total_refund_amount) AS total
  FROM sales_returns
  WHERE status = 'completed' AND invoice_id IS NOT NULL
  GROUP BY invoice_id
) sr
WHERE sr.invoice_id = i.id AND i.refunded_amount = 0;

-- 3. Repair invoices whose amount_paid was decremented by the RPC since
--    2026-09-01. Verified signature: amount_paid + refunded == sum of active
--    received invoice-payments (POS-00590220 1610+490=2100,
--    INV-940689 21992.50+3657.50=25650, INV-940533 0+4=4).
--    Invoices that don't match exactly are left untouched for manual review
--    (POS-00589653 — ৳4 July test invoice with a messy edit history).
WITH candidates AS (
  SELECT i.id,
         i.amount_paid,
         COALESCE(i.refunded_amount, 0) AS refunded,
         COALESCE(p.active_paid, 0) AS active_paid
  FROM invoices i
  JOIN LATERAL (
    SELECT COALESCE(SUM(amount), 0) AS active_paid
    FROM payments
    WHERE reference_type = 'invoice' AND reference_id = i.id
      AND payment_type = 'received' AND is_reversed = false
  ) p ON true
  WHERE COALESCE(i.refunded_amount, 0) > 0 AND i.status <> 'cancelled'
)
UPDATE invoices
SET amount_paid = c.active_paid,
    status = CASE
      WHEN refunded_amount >= total_amount THEN 'refunded'
      WHEN total_amount - bad_debt_amount - c.active_paid <= 0 THEN 'paid'
      WHEN c.active_paid > 0 THEN 'partially_paid'
      ELSE 'sent'
    END,
    updated_at = now()
FROM candidates c
WHERE invoices.id = c.id
  AND invoices.amount_paid <> c.active_paid
  AND invoices.amount_paid + c.refunded = c.active_paid;

-- 4. record_sales_return: keep amount_paid untouched; maintain refunded_amount.
--    Full-body replace of the live (20260909100000_invoice_shipping) version —
--    only the "Invoice state" block and its variable changed.
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
  v_lines json;
  v_new_refunded numeric;
  v_new_status text;
  v_wh uuid;
  v_inv_item record;
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

    v_total_refund := v_total_refund
      + (v_item->>'quantity')::numeric * v_it.unit_price * (1 - COALESCE(v_it.discount_percent, 0) / 100);
    v_total_cogs := v_total_cogs + v_base_qty * v_cost_per_base;
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

  SELECT id INTO v_wh FROM warehouses WHERE is_default AND is_active LIMIT 1;
  v_wh := COALESCE(v_wh, '11000000-0000-0000-0000-000000000001');

  INSERT INTO sales_returns (tenant_id, return_number, invoice_id, customer_id, return_date,
                             total_refund_amount, refund_method, status, created_by)
  VALUES (v_tenant, v_return_number, p_invoice_id, v_invoice.customer_id, CURRENT_DATE,
          v_capped_refund, COALESCE(p_refund_method, 'store_credit'), 'completed', p_created_by)
  RETURNING id INTO v_return_id;

  -- Proportional VAT reversal for refunds against VAT-carrying invoices
  v_vat_portion := CASE
    WHEN COALESCE(v_invoice.tax_amount, 0) > 0 AND v_invoice.total_amount > 0
    THEN round(v_capped_refund * v_invoice.tax_amount / v_invoice.total_amount, 2)
    ELSE 0 END;
  IF v_vat_portion > 0 AND v_vat_account IS NULL THEN
    RAISE EXCEPTION 'Invoice % carries VAT but VAT Payable account (2100) is missing', v_invoice.invoice_number;
  END IF;

  -- Proportional shipping reversal, same basis as the VAT portion
  v_shipping_portion := CASE
    WHEN COALESCE(v_invoice.shipping_cost, 0) > 0 AND v_invoice.total_amount > 0
    THEN round(v_capped_refund * v_invoice.shipping_cost / v_invoice.total_amount, 2)
    ELSE 0 END;
  IF v_shipping_portion > 0 AND v_shipping_account IS NULL THEN
    RAISE EXCEPTION 'Invoice % carries shipping but Shipping Income account (4020) is missing', v_invoice.invoice_number;
  END IF;

  -- Journal entry via the canonical poster (maintains accounts.balance).
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
  v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
    'account_id', v_credit_account, 'debit', 0, 'credit', v_capped_refund,
    'description', CASE WHEN p_refund_method = 'store_credit' THEN 'Customer Store Credit' ELSE 'Refund via ' || COALESCE(p_refund_method, 'payment') END)))::json);
  IF v_total_cogs > 0 THEN
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_inv_account, 'debit', v_total_cogs, 'credit', 0,
      'description', 'Inventory restored from return')))::json);
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

  -- Refund payment record (non-store-credit). reference_type 'refund' is the
  -- constraint-allowed value (the payments_reference_type_check rejects
  -- 'sales_return' — the old page hit this and swallowed the error, which is
  -- why every sales_return row has payment_id NULL). The payment trigger
  -- ignores refund-type payments, so this does not double-post.
  IF p_refund_method <> 'store_credit' THEN
    INSERT INTO payments (payment_number, payment_type, reference_type, reference_id,
                          customer_id, amount, payment_method, payment_date, notes)
    VALUES (COALESCE(generate_payment_number(), 'PAY-' || to_char(clock_timestamp(), 'YYMMDDHH24MISS')),
            'refund', 'refund', v_je_id, v_invoice.customer_id, v_capped_refund,
            COALESCE(p_refund_method, 'cash'), CURRENT_DATE,
            'Refund for sales return ' || v_return_number)
    RETURNING id INTO v_payment_id;

    UPDATE sales_returns SET payment_id = v_payment_id WHERE id = v_return_id;
  END IF;

  -- Items: return rows, FIFO restore (batch-accurate), movements, counters.
  FOR v_item IN SELECT * FROM json_array_elements(p_items) LOOP
    IF COALESCE((v_item->>'quantity')::numeric, 0) <= 0 THEN
      CONTINUE;
    END IF;
    SELECT * INTO v_it FROM invoice_items WHERE id = (v_item->>'invoice_item_id')::uuid;

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
  END LOOP;

  -- Invoice state: refunds settle through cash-out / store credit, never
  -- through the receivable (the return JE credits Cash or 2200, not AR), so
  -- amount_paid is left untouched and balance_due needs no adjustment.
  -- refunded_amount tracks the refunds for display and the status flags.
  v_new_refunded := COALESCE(v_invoice.refunded_amount, 0) + v_capped_refund;
  v_new_status := CASE
    WHEN v_new_refunded >= COALESCE(v_invoice.total_amount, 0) THEN 'refunded'
    WHEN COALESCE(v_invoice.total_amount, 0) - COALESCE(v_invoice.bad_debt_amount, 0) - COALESCE(v_invoice.amount_paid, 0) <= 0 THEN 'paid'
    WHEN COALESCE(v_invoice.amount_paid, 0) > 0 THEN 'partially_paid'
    ELSE 'sent'
  END;
  UPDATE invoices SET refunded_amount = v_new_refunded, status = v_new_status, updated_at = now()
  WHERE id = p_invoice_id;

  -- Store credit record for store-credit refunds.
  IF p_refund_method = 'store_credit' AND v_invoice.customer_id IS NOT NULL THEN
    INSERT INTO customer_store_credits (customer_id, sales_return_id, credit_number,
                                        amount, balance, status, notes)
    VALUES (v_invoice.customer_id, v_return_id,
            COALESCE(generate_credit_number(), 'SC-' || to_char(clock_timestamp(), 'YYMMDDHH24MISS')),
            v_capped_refund, v_capped_refund, 'active',
            'Store credit from return ' || v_return_number || ' (Invoice ' || v_invoice.invoice_number || ')');
  END IF;

  RETURN json_build_object(
    'return_id', v_return_id,
    'return_number', v_return_number,
    'journal_entry_id', v_je_id,
    'refund_amount', v_capped_refund,
    'cogs_reversal', v_total_cogs
  );
END $function$
