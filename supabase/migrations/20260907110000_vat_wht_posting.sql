-- Batch 2 of the 2026-09-06 gap audit (P0-1 VAT on sales, P0-2 withholding on purchases).
--
-- VAT: invoices may now carry tax_amount. Posting splits it out of revenue:
--     Dr 1100 (total) / Cr 4000 (total - vat) / Cr 2100 VAT Payable (vat)
-- Symmetric reversal everywhere the AR/revenue entry is undone:
--     invoice_accounting_trigger, edit_invoice (reverse + repost),
--     cancel_invoice, record_sales_return (proportional VAT on refunds).
--
-- WHT: supplier payments may now carry wht_amount. Posting:
--     Dr 2000 (full) / Cr cash (paid) / Cr 2110 WHT Payable (withheld)
-- in payment_accounting_trigger (purchase_order payments) and
-- record_manual_payable_payment.
--
-- Safety: VAT is OFF by default (app_settings key 'vat', enabled=false).
-- With tax_amount = 0 and wht_amount = 0 every function posts exactly what
-- it posted before this migration.

-- 1. Accounts: WHT Payable (2110); VAT Payable (2100) already exists.
INSERT INTO accounts (tenant_id, code, name, account_type, is_active)
SELECT '00000000-0000-0000-0000-000000000001', '2110', 'Withholding Tax Payable', 'liability', true
WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE tenant_id = '00000000-0000-0000-0000-000000000001' AND code = '2110');

-- 2. VAT settings (default OFF — owner enables from the Settings page).
INSERT INTO app_settings (setting_key, setting_value)
VALUES ('vat', '{"enabled": false, "rate": 15, "mode": "exclusive", "default_on": true}'::jsonb)
ON CONFLICT (setting_key) DO NOTHING;

-- 3. Withholding amount on payments.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS wht_amount numeric NOT NULL DEFAULT 0;

-- ════════════════════════════════════════════════════════════════════
-- 4. invoice_accounting_trigger — VAT split on the AR/revenue entry
-- ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.invoice_accounting_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
v_ar_account uuid;
v_revenue_account uuid;
v_vat_account uuid;
v_entry_id uuid;
v_total numeric;
v_vat numeric;
v_should_post boolean := false;
BEGIN
-- Get account IDs
SELECT id INTO v_ar_account FROM accounts WHERE code = '1100' LIMIT 1;
SELECT id INTO v_revenue_account FROM accounts WHERE code = '4000' LIMIT 1;
SELECT id INTO v_vat_account FROM accounts WHERE code = '2100' LIMIT 1;

IF v_ar_account IS NULL OR v_revenue_account IS NULL THEN
RETURN NEW;
END IF;

v_total := COALESCE(NEW.total_amount, 0);
v_vat := LEAST(COALESCE(NEW.tax_amount, 0), v_total);
IF v_total <= 0 THEN
RETURN NEW;
END IF;

IF v_vat > 0 AND v_vat_account IS NULL THEN
RAISE EXCEPTION 'Invoice % carries VAT (%) but VAT Payable account (2100) is missing', NEW.invoice_number, v_vat;
END IF;

-- Determine if we should post (on INSERT when status is not draft, or on UPDATE when status transitions)
IF TG_OP = 'INSERT' THEN
IF NEW.status IN ('sent', 'partially_paid', 'paid') THEN
v_should_post := true;
END IF;
ELSIF TG_OP = 'UPDATE' THEN
-- Only post if status changed from draft to a non-draft status
IF OLD.status = 'draft' AND NEW.status IN ('sent', 'partially_paid', 'paid') THEN
v_should_post := true;
END IF;
END IF;

IF NOT v_should_post THEN
RETURN NEW;
END IF;

-- Check if AR journal entry already exists for this invoice to avoid duplicates
PERFORM 1 FROM journal_entries WHERE reference_type = 'invoice' AND reference_id = NEW.id AND description LIKE '%Accounts Receivable%';
IF FOUND THEN
RETURN NEW;
END IF;

-- Post: Debit AR (gross), Credit Sales Revenue (net), Credit VAT Payable (vat)
IF v_vat > 0 THEN
v_entry_id := post_journal_entry(
'Accounts Receivable - Invoice ' || NEW.invoice_number,
COALESCE(NEW.invoice_date, CURRENT_DATE),
'invoice',
NEW.id,
json_build_array(
json_build_object('account_id', v_ar_account, 'debit', v_total, 'credit', 0, 'description', 'AR for invoice ' || NEW.invoice_number),
json_build_object('account_id', v_revenue_account, 'debit', 0, 'credit', v_total - v_vat, 'description', 'Sales revenue (net of VAT) for invoice ' || NEW.invoice_number),
json_build_object('account_id', v_vat_account, 'debit', 0, 'credit', v_vat, 'description', 'VAT payable for invoice ' || NEW.invoice_number)
)::json,
NEW.customer_id
);
ELSE
v_entry_id := post_journal_entry(
'Accounts Receivable - Invoice ' || NEW.invoice_number,
COALESCE(NEW.invoice_date, CURRENT_DATE),
'invoice',
NEW.id,
json_build_array(
json_build_object('account_id', v_ar_account, 'debit', v_total, 'credit', 0, 'description', 'AR for invoice ' || NEW.invoice_number),
json_build_object('account_id', v_revenue_account, 'debit', 0, 'credit', v_total, 'description', 'Sales revenue for invoice ' || NEW.invoice_number)
)::json,
NEW.customer_id
);
END IF;

RETURN NEW;
END;
$function$;

-- ════════════════════════════════════════════════════════════════════
-- 5. cancel_invoice — reverse AR/revenue net of the invoice's VAT
-- ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.cancel_invoice(p_invoice_id uuid, p_reason text, p_cancelled_by text)
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
  v_stock_restored boolean := false;
  v_journal_reversed boolean := false;
  v_vat_account uuid;
  v_vat numeric := 0;
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
  SELECT id INTO v_default_wh FROM warehouses WHERE is_default = true LIMIT 1;

  -- Reverse AR and Revenue (net of the invoice's VAT)
  v_vat := LEAST(COALESCE(v_invoice.tax_amount, 0), v_invoice.total_amount);
  IF v_vat > 0 AND v_vat_account IS NULL THEN
    RAISE EXCEPTION 'Invoice % carries VAT (%) but VAT Payable account (2100) is missing', v_invoice.invoice_number, v_vat;
  END IF;
  IF v_ar_account IS NOT NULL AND v_revenue_account IS NOT NULL THEN
    IF v_vat > 0 THEN
      PERFORM post_journal_entry(
        'Reverse AR/Revenue - Cancelled ' || v_invoice.invoice_number,
        COALESCE(v_invoice.invoice_date, CURRENT_DATE),
        'invoice_cancel',
        p_invoice_id,
        json_build_array(
          json_build_object('account_id', v_revenue_account, 'debit', v_invoice.total_amount - v_vat, 'credit', 0,
            'description', 'Reverse revenue (net of VAT) for cancelled ' || v_invoice.invoice_number),
          json_build_object('account_id', v_vat_account, 'debit', v_vat, 'credit', 0,
            'description', 'Reverse VAT for cancelled ' || v_invoice.invoice_number),
          json_build_object('account_id', v_ar_account, 'debit', 0, 'credit', v_invoice.total_amount,
            'description', 'Reverse AR for cancelled ' || v_invoice.invoice_number)
        )::json,
        v_invoice.customer_id
      );
    ELSE
      PERFORM post_journal_entry(
        'Reverse AR/Revenue - Cancelled ' || v_invoice.invoice_number,
        COALESCE(v_invoice.invoice_date, CURRENT_DATE),
        'invoice_cancel',
        p_invoice_id,
        json_build_array(
          json_build_object('account_id', v_revenue_account, 'debit', v_invoice.total_amount, 'credit', 0,
            'description', 'Reverse revenue for cancelled ' || v_invoice.invoice_number),
          json_build_object('account_id', v_ar_account, 'debit', 0, 'credit', v_invoice.total_amount,
            'description', 'Reverse AR for cancelled ' || v_invoice.invoice_number)
        )::json,
        v_invoice.customer_id
      );
    END IF;
    v_journal_reversed := true;
  END IF;

  -- ── COGS reversal amount: from POSTED COGS JEs (net of reversals) ──
  -- This is the fix: previously this used the FIFO consumption total, which
  -- misses per-item COGS JEs posted by the double trigger, leaving orphans.
  SELECT COALESCE(SUM(jl.debit - jl.credit), 0) INTO v_cogs_total
  FROM journal_lines jl
  JOIN journal_entries je ON je.id = jl.journal_entry_id
  JOIN accounts a ON a.id = jl.account_id
  WHERE je.reference_type IN ('invoice', 'invoice_edit')
    AND je.reference_id = p_invoice_id
    AND a.code = '5000'
    AND je.is_posted = true;

  -- Fallback: if nothing posted, compute from FIFO consumption / cost_price
  IF v_cogs_total = 0 THEN
    SELECT COALESCE(SUM(cogs_amount), 0) INTO v_cogs_total
    FROM invoice_item_batch_consumption
    WHERE invoice_item_id IN (SELECT id FROM invoice_items WHERE invoice_id = p_invoice_id);
  END IF;
  IF v_cogs_total = 0 THEN
    FOR v_item IN SELECT * FROM invoice_items WHERE invoice_id = p_invoice_id LOOP
      v_cogs_total := v_cogs_total + (COALESCE(v_item.cost_price, 0) * COALESCE(v_item.quantity, 0));
    END LOOP;
  END IF;

  -- Reverse COGS for the FULL posted amount
  IF v_cogs_account IS NOT NULL AND v_inventory_account IS NOT NULL AND v_cogs_total > 0 THEN
    PERFORM post_journal_entry(
      'Reverse COGS - Cancelled ' || v_invoice.invoice_number,
      COALESCE(v_invoice.invoice_date, CURRENT_DATE),
      'invoice_cancel',
      p_invoice_id,
      json_build_array(
        json_build_object('account_id', v_inventory_account, 'debit', v_cogs_total, 'credit', 0,
          'description', 'Restore inventory for cancelled ' || v_invoice.invoice_number),
        json_build_object('account_id', v_cogs_account, 'debit', 0, 'credit', v_cogs_total,
          'description', 'Reverse COGS for cancelled ' || v_invoice.invoice_number)
      )::json,
      v_invoice.customer_id
    );
    v_journal_reversed := true;
  END IF;

  -- Restore stock + record stock movements
  FOR v_item IN SELECT * FROM invoice_items WHERE invoice_id = p_invoice_id LOOP
    v_qty := COALESCE(v_item.base_quantity, v_item.quantity);
    UPDATE inventory_items
    SET quantity_on_hand = quantity_on_hand + v_qty,
        updated_at = now()
    WHERE product_id = v_item.product_id
      AND warehouse_id = COALESCE(v_item.warehouse_id, v_default_wh);

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
  END LOOP;
  v_stock_restored := true;

  -- FIFO: Restore batch quantities for all invoice items
  FOR v_item IN SELECT * FROM invoice_items WHERE invoice_id = p_invoice_id LOOP
    PERFORM restore_fifo(v_item.id);
  END LOOP;

  -- Restore advance applications. The old schema stored usage on
  -- customer_advances itself (invoice_id / amount_used / remaining_balance);
  -- those columns no longer exist, and this statement aborted EVERY
  -- cancellation with 'column "invoice_id" does not exist'. Current model:
  -- customer_advance_applications rows + customer_advances.balance.
  WITH restored AS (
    DELETE FROM customer_advance_applications
     WHERE invoice_id = p_invoice_id
    RETURNING advance_id, amount
  )
  UPDATE customer_advances ca
     SET balance = ca.balance + r.amount,
         status = CASE WHEN ca.status = 'applied' THEN 'active' ELSE ca.status END,
         updated_at = now()
    FROM restored r
   WHERE ca.id = r.advance_id;

  -- Customer outstanding_balance and total_purchases are maintained by the
  -- trg_invoice_customer_balance / trg_invoice_sync_total_purchases triggers
  -- on the invoices UPDATE below (the old customers.balance column no longer
  -- exists; a manual update here also fought those triggers' recompute).

  -- Cancel payments
  FOR v_payment IN SELECT * FROM payments WHERE reference_type = 'invoice' AND reference_id = p_invoice_id AND is_reversed = false LOOP
    v_total_payments := v_total_payments + v_payment.amount;
    UPDATE payments SET is_reversed = true, updated_at = now() WHERE id = v_payment.id;

    SELECT 'RVP-' || COALESCE(MAX(CAST(SUBSTRING(payment_number FROM 5) AS INTEGER)) + 1, 1)
    INTO v_rev_pay_num FROM payments WHERE payment_number LIKE 'RVP-%';

    INSERT INTO payments (payment_number, payment_type, reference_type, reference_id, customer_id, supplier_id,
      amount, payment_method, payment_date, reference_number, notes)
    VALUES (
      v_rev_pay_num, 'refund', 'invoice', p_invoice_id, v_payment.customer_id, v_payment.supplier_id,
      v_payment.amount, v_payment.payment_method, CURRENT_DATE, v_payment.payment_number,
      'Auto-refund on invoice cancellation'
    );

    -- Reverse the payment's journal entry (Dr AR / Cr Cash). The original
    -- payment JE (Dr Cash / Cr AR) stays posted, so without this leg AR is
    -- left with a credit balance and Cash overstated by the refund. The
    -- 20260902130000 rework dropped this posting entirely; earlier versions
    -- posted it unbalanced (Dr AR only). Mirror the original JE's cash
    -- account: payment_methods.account_id ?? 1001.
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
          'Reverse Payment - Cancelled ' || v_invoice.invoice_number,
          COALESCE(v_invoice.invoice_date, CURRENT_DATE),
          'invoice_cancel',
          p_invoice_id,
          json_build_array(
            json_build_object('account_id', v_ar_account, 'debit', v_payment.amount, 'credit', 0,
              'description', 'Restore AR for reversed payment ' || v_payment.payment_number),
            json_build_object('account_id', v_payment_account, 'debit', 0, 'credit', v_payment.amount,
              'description', 'Refund ' || v_payment.payment_number || ' for cancelled ' || v_invoice.invoice_number)
          )::json,
          v_invoice.customer_id
        );
        v_journal_reversed := true;
      END IF;
    END IF;
  END LOOP;

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
    json_build_object('status', v_invoice.status, 'total_amount', v_invoice.total_amount, 'amount_paid', v_invoice.amount_paid),
    json_build_object('status', 'cancelled')
  );

  RETURN json_build_object(
    'success', true,
    'message', 'Invoice cancelled successfully',
    'invoice_number', v_invoice.invoice_number,
    'cogs_reversed', v_cogs_total,
    'payments_reversed', v_total_payments,
    'stock_restored', v_stock_restored,
    'journal_reversed', v_journal_reversed
  );
END;
$function$;

-- ════════════════════════════════════════════════════════════════════
-- 6. record_sales_return — proportional VAT reversal on refunds
-- ════════════════════════════════════════════════════════════════════
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
  v_lines json;
  v_new_amount_paid numeric;
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

  -- Journal entry via the canonical poster (maintains accounts.balance).
  v_lines := to_json(ARRAY[]::json[]);
  IF v_vat_portion > 0 THEN
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_sr_account, 'debit', v_capped_refund - v_vat_portion, 'credit', 0,
      'description', 'Sales Return (net of VAT) - ' || v_return_number)))::json);
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_vat_account, 'debit', v_vat_portion, 'credit', 0,
      'description', 'VAT reversal for return ' || v_return_number)))::json);
  ELSE
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_sr_account, 'debit', v_capped_refund, 'credit', 0,
      'description', 'Sales Return - ' || v_return_number)))::json);
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

  -- Invoice state: amount_paid + status (balance_due is a GENERATED column —
  -- it recomputes itself; the old page updated it explicitly and the error
  -- was silently swallowed, leaving amounts stale).
  v_new_amount_paid := GREATEST(0, COALESCE(v_invoice.amount_paid, 0) - v_capped_refund);
  v_new_status := CASE
    WHEN v_capped_refund >= COALESCE(v_invoice.total_amount, 0) THEN 'refunded'
    WHEN v_invoice.total_amount - v_new_amount_paid <= 0 THEN 'paid'
    WHEN v_new_amount_paid > 0 THEN 'partially_paid'
    ELSE 'sent'
  END;
  UPDATE invoices SET amount_paid = v_new_amount_paid, status = v_new_status, updated_at = now()
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
END $function$;

-- ════════════════════════════════════════════════════════════════════
-- 7. payment_accounting_trigger — WHT split on supplier PO payments
-- ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.payment_accounting_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_ar_account uuid;
  v_ap_account uuid;
  v_cash_account uuid;
  v_payment_account uuid;
  v_bad_debt_account uuid;
  v_invoice_record RECORD;
  v_po_record RECORD;
  v_amount numeric;
  v_bad_debt numeric;
  v_wht numeric;
  v_wht_account uuid;
BEGIN
  v_amount := COALESCE(NEW.amount, 0);
  v_bad_debt := COALESCE(NEW.bad_debt_amount, 0);

  IF v_amount <= 0 AND v_bad_debt <= 0 THEN
    RETURN NEW;
  END IF;

  -- Idempotency: if any JE already exists for this payment row (backfill,
  -- re-import, re-fire), never post a second one.
  IF EXISTS (SELECT 1 FROM journal_entries je
              WHERE je.reference_type = 'payment' AND je.reference_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  -- ============================================================
  -- Case 1: Customer payment for an invoice
  -- ============================================================
  IF NEW.payment_type = 'received' AND NEW.reference_type = 'invoice' THEN
    SELECT id INTO v_ar_account FROM accounts WHERE code = '1100' LIMIT 1;
    IF v_ar_account IS NULL THEN
      RETURN NEW;
    END IF;

    SELECT id INTO v_bad_debt_account FROM accounts WHERE code = '5600' LIMIT 1;

    SELECT pm.account_id INTO v_payment_account
      FROM payment_methods pm
     WHERE pm.code = NEW.payment_method AND pm.is_active = true
     LIMIT 1;

    IF v_payment_account IS NULL THEN
      SELECT id INTO v_cash_account FROM accounts WHERE code = '1001' LIMIT 1;
    ELSE
      v_cash_account := v_payment_account;
    END IF;

    SELECT * INTO v_invoice_record FROM invoices WHERE id = NEW.reference_id;

    -- Post payment: Debit Cash/Bank, Credit AR
    IF v_amount > 0 THEN
      IF v_cash_account IS NULL THEN
        RETURN NEW;
      END IF;

      PERFORM post_journal_entry(
        'Payment Received - ' || COALESCE(NEW.payment_number, 'invoice payment'),
        COALESCE(NEW.payment_date, CURRENT_DATE),
        'payment',
        NEW.id,
        json_build_array(
          json_build_object('account_id', v_cash_account, 'debit', v_amount, 'credit', 0, 'description', 'Cash received for ' || COALESCE(v_invoice_record.invoice_number, 'invoice')),
          json_build_object('account_id', v_ar_account, 'debit', 0, 'credit', v_amount, 'description', 'AR cleared for ' || COALESCE(v_invoice_record.invoice_number, 'invoice'))
        )::json,
        v_invoice_record.customer_id
      );
    END IF;

    -- Post bad debt: Debit Bad Debt Expense, Credit AR
    IF v_bad_debt > 0 AND v_bad_debt_account IS NOT NULL THEN
      PERFORM post_journal_entry(
        'Bad Debt Write-off - ' || COALESCE(NEW.payment_number, 'invoice payment'),
        COALESCE(NEW.payment_date, CURRENT_DATE),
        'payment',
        NEW.id,
        json_build_array(
          json_build_object('account_id', v_bad_debt_account, 'debit', v_bad_debt, 'credit', 0, 'description', 'Bad debt write-off for ' || COALESCE(v_invoice_record.invoice_number, 'invoice')),
          json_build_object('account_id', v_ar_account, 'debit', 0, 'credit', v_bad_debt, 'description', 'AR cleared (bad debt) for ' || COALESCE(v_invoice_record.invoice_number, 'invoice'))
        )::json,
        v_invoice_record.customer_id
      );
    END IF;

    RETURN NEW;
  END IF;

  -- ============================================================
  -- Case 2: Payment to supplier for a purchase order
  -- ============================================================
  IF NEW.payment_type = 'made' AND NEW.reference_type = 'purchase_order' THEN
    SELECT id INTO v_ap_account FROM accounts WHERE code = '2000' LIMIT 1;
    IF v_ap_account IS NULL THEN
      RETURN NEW;
    END IF;

    SELECT pm.account_id INTO v_payment_account
      FROM payment_methods pm
     WHERE pm.code = NEW.payment_method AND pm.is_active = true
     LIMIT 1;

    IF v_payment_account IS NULL THEN
      SELECT id INTO v_cash_account FROM accounts WHERE code = '1001' LIMIT 1;
    ELSE
      v_cash_account := v_payment_account;
    END IF;

    IF v_cash_account IS NULL THEN
      RETURN NEW;
    END IF;

    SELECT * INTO v_po_record FROM purchase_orders WHERE id = NEW.reference_id;

    -- Post payment: Debit AP (full), Credit Cash/Bank (paid), Credit WHT Payable (withheld)
    v_wht := LEAST(COALESCE(NEW.wht_amount, 0), v_amount);
    IF v_wht < 0 THEN
      RAISE EXCEPTION 'Withholding amount (%) cannot be negative on payment %', NEW.wht_amount, COALESCE(NEW.payment_number, NEW.id);
    END IF;
    IF v_wht > 0 THEN
      SELECT id INTO v_wht_account FROM accounts WHERE code = '2110' LIMIT 1;
      IF v_wht_account IS NULL THEN
        RAISE EXCEPTION 'Payment % carries withholding (%) but WHT Payable account (2110) is missing', COALESCE(NEW.payment_number, NEW.id), v_wht;
      END IF;
      PERFORM post_journal_entry(
        'Payment Made - ' || COALESCE(NEW.payment_number, 'PO payment'),
        COALESCE(NEW.payment_date, CURRENT_DATE),
        'payment',
        NEW.id,
        json_build_array(
          json_build_object('account_id', v_ap_account, 'debit', v_amount, 'credit', 0, 'description', 'AP paid for ' || COALESCE(v_po_record.po_number, 'PO')),
          json_build_object('account_id', v_cash_account, 'debit', 0, 'credit', v_amount - v_wht, 'description', 'Cash paid for ' || COALESCE(v_po_record.po_number, 'PO')),
          json_build_object('account_id', v_wht_account, 'debit', 0, 'credit', v_wht, 'description', 'Withholding tax deducted for ' || COALESCE(v_po_record.po_number, 'PO'))
        )::json,
        NULL,
        NEW.supplier_id
      );
    ELSE
      PERFORM post_journal_entry(
        'Payment Made - ' || COALESCE(NEW.payment_number, 'PO payment'),
        COALESCE(NEW.payment_date, CURRENT_DATE),
        'payment',
        NEW.id,
        json_build_array(
          json_build_object('account_id', v_ap_account, 'debit', v_amount, 'credit', 0, 'description', 'AP paid for ' || COALESCE(v_po_record.po_number, 'PO')),
          json_build_object('account_id', v_cash_account, 'debit', 0, 'credit', v_amount, 'description', 'Cash paid for ' || COALESCE(v_po_record.po_number, 'PO'))
        )::json,
        NULL,
        NEW.supplier_id
      );
    END IF;

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$function$;

-- ════════════════════════════════════════════════════════════════════
-- 8. edit_invoice — VAT-aware reversal, header persistence and repost
-- ════════════════════════════════════════════════════════════════════
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

  FOR v_i IN SELECT generate_series(0, json_array_length(v_new_items) - 1) LOOP
    v_new_item := v_new_items->v_i;
    v_new_subtotal := v_new_subtotal + (v_new_item->>'quantity')::numeric * (v_new_item->>'unit_price')::numeric * (1 - COALESCE((v_new_item->>'discount_percent')::numeric, 0) / 100);
  END LOOP;

  v_cart_discount_amount := (v_new_subtotal * v_new_cart_discount_percent) / 100;
  v_new_total := GREATEST(0, v_new_subtotal - v_cart_discount_amount - v_new_extra_discount);
  -- VAT: exclusive mode adds tax on top of the discounted base; inclusive
  -- mode prices already embed it. No tax passed (older callers) = base only.
  SELECT COALESCE(s.setting_value->>'mode', 'exclusive') INTO v_vat_mode
  FROM app_settings s WHERE s.setting_key = 'vat';
  v_vat_mode := COALESCE(v_vat_mode, 'exclusive');
  IF v_vat_mode = 'exclusive' THEN
    v_new_total := v_new_total + v_new_tax;
  END IF;

  IF v_invoice.amount_paid >= v_invoice.total_amount AND v_invoice.total_amount > 0 THEN
    v_old_payment_term := 'full';
  ELSIF v_invoice.amount_paid > 0 THEN
    v_old_payment_term := 'partial';
  ELSE
    v_old_payment_term := 'credit';
  END IF;

  SELECT id INTO v_ar_account FROM accounts WHERE code = '1100' LIMIT 1;
  SELECT id INTO v_revenue_account FROM accounts WHERE code = '4000' LIMIT 1;
  SELECT id INTO v_cogs_account FROM accounts WHERE code = '5000' LIMIT 1;
  SELECT id INTO v_inventory_account FROM accounts WHERE code = '1200' LIMIT 1;
  SELECT id INTO v_vat_account FROM accounts WHERE code = '2100' LIMIT 1;
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
    'total_amount', v_invoice.total_amount, 'amount_paid', v_invoice.amount_paid, 'status', v_invoice.status,
    'payment_term', v_old_payment_term, 'payments', v_old_payments,
    'items', (SELECT json_agg(json_build_object('product_id', ii.product_id, 'quantity', ii.quantity, 'unit_price', ii.unit_price, 'discount_percent', ii.discount_percent, 'subtotal', ii.subtotal, 'unit_name', ii.unit_name, 'base_quantity', ii.base_quantity, 'warehouse_id', ii.warehouse_id)) FROM invoice_items ii WHERE ii.invoice_id = p_invoice_id)
  ) INTO v_old_snapshot;

  -- STEP 1: FIFO - Restore batch quantities for old items FIRST
  FOR v_item IN SELECT * FROM invoice_items WHERE invoice_id = p_invoice_id LOOP
    PERFORM restore_fifo(v_item.id);
  END LOOP;

  -- STEP 1b: Restore stock for old items (PRESERVE original sale movements)
  FOR v_item IN SELECT * FROM invoice_items WHERE invoice_id = p_invoice_id LOOP
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
      -- NOTE: We DO NOT delete original sale movements here anymore to preserve audit trail
    END IF;
  END LOOP;

  -- STEP 2: Reverse AR + Revenue journal entry (net of the invoice's VAT)
  v_old_tax := LEAST(COALESCE(v_invoice.tax_amount, 0), v_invoice.total_amount);
  IF v_old_tax > 0 AND v_vat_account IS NULL THEN
    RAISE EXCEPTION 'Invoice % carries VAT (%) but VAT Payable account (2100) is missing', v_invoice.invoice_number, v_old_tax;
  END IF;
  IF v_ar_account IS NOT NULL AND v_revenue_account IS NOT NULL AND v_invoice.total_amount > 0 THEN
    IF v_old_tax > 0 THEN
      PERFORM post_journal_entry(
        'REVERSAL - AR - Invoice ' || v_invoice.invoice_number || ' EDIT', COALESCE(v_invoice.invoice_date, CURRENT_DATE), 'invoice_edit', p_invoice_id,
        json_build_array(
          json_build_object('account_id', v_ar_account, 'debit', 0, 'credit', v_invoice.total_amount, 'description', 'Reverse AR for edited invoice ' || v_invoice.invoice_number),
          json_build_object('account_id', v_revenue_account, 'debit', v_invoice.total_amount - v_old_tax, 'credit', 0, 'description', 'Reverse revenue (net of VAT) for edited invoice ' || v_invoice.invoice_number),
          json_build_object('account_id', v_vat_account, 'debit', v_old_tax, 'credit', 0, 'description', 'Reverse VAT for edited invoice ' || v_invoice.invoice_number)
        )::json, v_invoice.customer_id
      );
    ELSE
      PERFORM post_journal_entry(
        'REVERSAL - AR - Invoice ' || v_invoice.invoice_number || ' EDIT', COALESCE(v_invoice.invoice_date, CURRENT_DATE), 'invoice_edit', p_invoice_id,
        json_build_array(
          json_build_object('account_id', v_ar_account, 'debit', 0, 'credit', v_invoice.total_amount, 'description', 'Reverse AR for edited invoice ' || v_invoice.invoice_number),
          json_build_object('account_id', v_revenue_account, 'debit', v_invoice.total_amount, 'credit', 0, 'description', 'Reverse revenue for edited invoice ' || v_invoice.invoice_number)
        )::json, v_invoice.customer_id
      );
    END IF;
  END IF;

  -- STEP 3: Delete original COGS journal entries and roll back account balances
  FOR v_je_id IN
    SELECT je.id FROM journal_entries je
    WHERE je.reference_type = 'invoice'
      AND je.reference_id = p_invoice_id
      AND je.description LIKE 'COGS%'
  LOOP
    -- Aggregated rollback: subtract the SUM of every line this JE posted to
    -- the account. (The old UPDATE ... FROM join picked ONE arbitrary line per
    -- account whenever the JE held several lines on it — multi-item COGS JEs
    -- carry one Dr 5000 + one Cr 1200 line PER ITEM — so most of the balance
    -- effect stayed in the cache; surfaced as the Tk 544,356 1200/5000 drift
    -- after the 2026-09-02 INV-940648 edit.)
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

  -- STEP 4: Reverse original payments AND mark them as reversed
  FOR v_payment IN SELECT * FROM payments WHERE reference_type = 'invoice' AND reference_id = p_invoice_id AND is_reversed = false LOOP
    INSERT INTO payments (payment_number, payment_type, payment_method, amount, payment_date, reference_type, reference_id, reference_number, notes, payment_for)
    VALUES ('REV-' || COALESCE(v_payment.payment_number, 'PAY'), CASE WHEN v_payment.payment_type = 'received' THEN 'refund' ELSE 'payment' END, v_payment.payment_method, v_payment.amount, CURRENT_DATE, 'invoice_edit', p_invoice_id, v_invoice.invoice_number, 'Reversal payment for edited invoice ' || v_invoice.invoice_number, 'reversal_payment');
    UPDATE payments SET is_reversed = true WHERE id = v_payment.id;
  END LOOP;

  -- Delete original payment journal entries and roll back account balances
  FOR v_je_id IN
    SELECT je.id FROM journal_entries je
    WHERE je.reference_type = 'payment'
      AND je.reference_id IN (SELECT id FROM payments WHERE reference_type = 'invoice' AND reference_id = p_invoice_id)
  LOOP
    -- Same aggregated rollback as STEP 3 (SUM all of the JE's lines per account).
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

  -- STEP 5: Update invoice header
  UPDATE invoices
  SET customer_id = v_new_customer, invoice_date = v_new_date, due_date = v_new_due_date, notes = v_new_notes,
      reference = v_new_reference,
      subtotal = v_new_subtotal, cart_discount_percent = v_new_cart_discount_percent, extra_discount = v_new_extra_discount,
      discount_amount = v_cart_discount_amount, total_amount = v_new_total, tax_amount = v_new_tax, amount_paid = 0,
      status = 'draft', edit_count = COALESCE(edit_count, 0) + 1, updated_at = now()
  WHERE id = p_invoice_id;

  -- STEP 5b: Set session flag to prevent DELETE trigger from double-restoring stock
  PERFORM set_config('app.edit_invoice_active', 'true', true);

  -- STEP 6: Re-insert items
  DELETE FROM invoice_items WHERE invoice_id = p_invoice_id;
  FOR v_i IN SELECT generate_series(0, json_array_length(v_new_items) - 1) LOOP
    v_new_item := v_new_items->v_i;
    INSERT INTO invoice_items (invoice_id, product_id, quantity, unit_price, cost_price, discount_percent, tax_rate, subtotal, unit_name, unit_conversion_factor, base_quantity, warehouse_id, sort_order)
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

  -- STEP 7: Re-post AR + Revenue for new total (revenue net of VAT)
  IF v_ar_account IS NOT NULL AND v_revenue_account IS NOT NULL AND v_new_total > 0 THEN
    IF v_new_tax > 0 THEN
      IF v_vat_account IS NULL THEN
        RAISE EXCEPTION 'Edited invoice % carries VAT (%) but VAT Payable account (2100) is missing', v_invoice.invoice_number, v_new_tax;
      END IF;
      PERFORM post_journal_entry(
        'AR - Invoice ' || v_invoice.invoice_number || ' EDITED', v_new_date, 'invoice', p_invoice_id,
        json_build_array(
          json_build_object('account_id', v_ar_account, 'debit', v_new_total, 'credit', 0, 'description', 'AR for edited invoice ' || v_invoice.invoice_number),
          json_build_object('account_id', v_revenue_account, 'debit', 0, 'credit', v_new_total - v_new_tax, 'description', 'Revenue (net of VAT) for edited invoice ' || v_invoice.invoice_number),
          json_build_object('account_id', v_vat_account, 'debit', 0, 'credit', v_new_tax, 'description', 'VAT payable for edited invoice ' || v_invoice.invoice_number)
        )::json, v_new_customer
      );
    ELSE
      PERFORM post_journal_entry(
        'AR - Invoice ' || v_invoice.invoice_number || ' EDITED', v_new_date, 'invoice', p_invoice_id,
        json_build_array(
          json_build_object('account_id', v_ar_account, 'debit', v_new_total, 'credit', 0, 'description', 'AR for edited invoice ' || v_invoice.invoice_number),
          json_build_object('account_id', v_revenue_account, 'debit', 0, 'credit', v_new_total, 'description', 'Revenue for edited invoice ' || v_invoice.invoice_number)
        )::json, v_new_customer
      );
    END IF;
  END IF;

  -- STEP 7b: Post COGS journal entry for new items (FIXED: fallback to cost_price * quantity when no FIFO)
  IF v_cogs_account IS NOT NULL AND v_inventory_account IS NOT NULL THEN
    DECLARE
      v_cogs_total decimal(15,2) := 0;
      v_has_fifo_data boolean := false;
    BEGIN
      -- Check if we have any FIFO consumption data for new items
      FOR v_item IN SELECT ii.*, p.name as product_name, p.sku FROM invoice_items ii JOIN products p ON ii.product_id = p.id WHERE ii.invoice_id = p_invoice_id ORDER BY ii.sort_order LOOP
        v_cost := 0;
        SELECT COALESCE(SUM(cogs_amount), 0) INTO v_cost
        FROM invoice_item_batch_consumption WHERE invoice_item_id = v_item.id;
        
        IF v_cost > 0 THEN
          v_cogs_total := v_cogs_total + v_cost;
          v_has_fifo_data := true;
        END IF;
      END LOOP;
      
      -- If we have FIFO data, post it
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
        -- FALLBACK: Calculate COGS from cost_price * quantity for items without FIFO data
        v_cogs_total := 0;
        FOR v_item IN SELECT ii.*, p.name as product_name, p.sku FROM invoice_items ii JOIN products p ON ii.product_id = p.id WHERE ii.invoice_id = p_invoice_id ORDER BY ii.sort_order LOOP
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
      INSERT INTO payments (payment_number, payment_type, payment_method, amount, payment_date, reference_type, reference_id, reference_number, notes, payment_for)
      VALUES ('EDIT-' || v_invoice.invoice_number, 'received', v_new_payment_method, v_new_partial_amount, v_new_date, 'invoice', p_invoice_id, v_invoice.invoice_number, 'Partial payment for edited invoice ' || v_invoice.invoice_number, 'paid_invoice_pay')
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
      INSERT INTO payments (payment_number, payment_type, payment_method, amount, payment_date, reference_type, reference_id, reference_number, notes, payment_for)
      VALUES ('EDIT-' || v_invoice.invoice_number, 'received', v_new_payment_method, v_new_total, v_new_date, 'invoice', p_invoice_id, v_invoice.invoice_number, 'Payment for edited invoice ' || v_invoice.invoice_number, 'paid_invoice_pay')
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
      UPDATE invoices SET status = 'paid', amount_paid = v_new_total WHERE id = p_invoice_id;
    ELSE
      UPDATE invoices SET status = 'paid', amount_paid = 0 WHERE id = p_invoice_id;
    END IF;
  END IF;

  -- STEP 9: Record edit history
  SELECT json_build_object('customer_id', v_new_customer, 'invoice_date', v_new_date, 'due_date', v_new_due_date, 'notes', v_new_notes, 'reference', v_new_reference, 'subtotal', v_new_subtotal, 'cart_discount_percent', v_new_cart_discount_percent, 'extra_discount', v_new_extra_discount, 'total_amount', v_new_total, 'payment_term', v_new_payment_term, 'payment_method', v_new_payment_method, 'items', v_new_items) INTO v_new_snapshot;

  INSERT INTO invoice_edit_history (invoice_id, invoice_number, edited_by_name, change_type, reason, snapshot_before, snapshot_after, old_value, new_value)
  VALUES (p_invoice_id, v_invoice.invoice_number, p_edited_by, 'full_edit', p_reason, v_old_snapshot, v_new_snapshot, v_old_snapshot, v_new_snapshot);

  -- STEP 10: Update customer outstanding_balance
  IF v_invoice.customer_id IS NOT NULL THEN
    UPDATE customers SET outstanding_balance = (SELECT COALESCE(SUM(balance_due), 0) FROM invoices WHERE customer_id = v_invoice.customer_id AND status IN ('sent', 'partially_paid', 'unpaid', 'overdue')), updated_at = now() WHERE id = v_invoice.customer_id;
  END IF;
  IF v_new_customer IS NOT NULL AND v_new_customer <> v_invoice.customer_id THEN
    UPDATE customers SET outstanding_balance = (SELECT COALESCE(SUM(balance_due), 0) FROM invoices WHERE customer_id = v_new_customer AND status IN ('sent', 'partially_paid', 'unpaid', 'overdue')), updated_at = now() WHERE id = v_new_customer;
  END IF;

  RETURN json_build_object('success', true, 'invoice_id', p_invoice_id, 'old_total', v_invoice.total_amount, 'new_total', v_new_total);
END;
$function$;

-- ════════════════════════════════════════════════════════════════════
-- 9. record_manual_payable_payment — optional WHT on manual payables
-- ════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS public.record_manual_payable_payment(uuid, numeric, date, text, uuid, text, text);

-- 5. Manual payable payment — payment row + JE in one call.
CREATE OR REPLACE FUNCTION public.record_manual_payable_payment(
  p_payable_je_id uuid,
  p_amount numeric,
  p_wht_amount numeric DEFAULT 0,
  p_payment_date date DEFAULT CURRENT_DATE,
  p_payment_method text DEFAULT 'cash',
  p_cash_account_id uuid DEFAULT NULL,
  p_reference_number text DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_je record;
  v_supplier_id uuid;
  v_outstanding numeric;
  v_paid numeric;
  v_ap_account uuid;
  v_payment_id uuid;
  v_payment_number text;
  v_desc text;
  v_wht numeric := 0;
  v_wht_account uuid;
BEGIN
  SELECT * INTO v_je FROM journal_entries WHERE id = p_payable_je_id;
  IF NOT FOUND OR v_je.reference_type IS DISTINCT FROM 'payable' THEN
    RAISE EXCEPTION 'Manual payable % not found', p_payable_je_id;
  END IF;

  v_supplier_id := v_je.supplier_id;

  SELECT COALESCE(SUM(amount), 0) INTO v_paid
  FROM payments
  WHERE reference_type = 'payable' AND reference_id = p_payable_je_id
    AND is_reversed = false;

  v_outstanding := COALESCE(v_je.total_credit, 0) - v_paid;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be greater than zero';
  END IF;
  IF p_amount > v_outstanding + 0.01 THEN
    RAISE EXCEPTION 'Payment (%) exceeds outstanding balance (%)', p_amount, v_outstanding;
  END IF;
  IF p_cash_account_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM accounts WHERE id = p_cash_account_id AND account_type = 'asset') THEN
    RAISE EXCEPTION 'Select a valid cash/bank account to pay from';
  END IF;
  v_wht := LEAST(COALESCE(p_wht_amount, 0), p_amount);
  IF v_wht < 0 THEN
    RAISE EXCEPTION 'Withholding amount cannot be negative';
  END IF;
  IF v_wht >= p_amount THEN
    RAISE EXCEPTION 'Withholding (%) must be less than the payment amount (%)', v_wht, p_amount;
  END IF;
  IF v_wht > 0 THEN
    SELECT id INTO v_wht_account FROM accounts WHERE code = '2110' LIMIT 1;
    IF v_wht_account IS NULL THEN
      RAISE EXCEPTION 'WHT Payable account (2110) not found';
    END IF;
  END IF;

  SELECT id INTO v_ap_account FROM accounts WHERE code = '2000' LIMIT 1;
  IF v_ap_account IS NULL THEN
    RAISE EXCEPTION 'Accounts Payable account (2000) not found';
  END IF;

  v_payment_number := public.generate_payment_number();
  v_desc := COALESCE(NULLIF(p_notes, ''), 'Payment made for ' || v_je.entry_number);

  INSERT INTO payments (payment_number, payment_type, reference_type, reference_id,
    supplier_id, amount, payment_method, payment_date,
    reference_number, notes, payment_for)
  VALUES (v_payment_number, 'made', 'payable', p_payable_je_id,
    v_supplier_id, p_amount, p_payment_method, p_payment_date,
    p_reference_number, p_notes, 'manual_payable')
  RETURNING id INTO v_payment_id;

  IF v_wht > 0 THEN
    PERFORM public.post_journal_entry(
      v_desc, p_payment_date, 'payment', v_payment_id,
      json_build_array(
        json_build_object('account_id', v_ap_account, 'debit', p_amount, 'credit', 0,
          'description', 'AP paid for ' || v_je.entry_number),
        json_build_object('account_id', p_cash_account_id, 'debit', 0, 'credit', p_amount - v_wht,
          'description', 'Cash paid for ' || v_je.entry_number),
        json_build_object('account_id', v_wht_account, 'debit', 0, 'credit', v_wht,
          'description', 'Withholding tax deducted for ' || v_je.entry_number)
      )::json,
      NULL,
      v_supplier_id
    );
  ELSE
    PERFORM public.post_journal_entry(
      v_desc, p_payment_date, 'payment', v_payment_id,
      json_build_array(
        json_build_object('account_id', v_ap_account, 'debit', p_amount, 'credit', 0,
          'description', 'AP paid for ' || v_je.entry_number),
        json_build_object('account_id', p_cash_account_id, 'debit', 0, 'credit', p_amount,
          'description', 'Cash paid for ' || v_je.entry_number)
      )::json,
      NULL,
      v_supplier_id
    );
  END IF;

  RETURN json_build_object(
    'payment_id', v_payment_id,
    'payment_number', v_payment_number,
    'amount', p_amount,
    'wht_amount', v_wht,
    'cash_paid', p_amount - v_wht,
    'remaining', GREATEST(v_outstanding - p_amount, 0)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.post_manual_journal_entry(date, text, text, uuid, uuid, uuid, json) TO authenticated;
GRANT EXECUTE ON FUNCTION public.edit_manual_journal_entry(uuid, date, text, json, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_manual_journal_entry(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_manual_receivable_payment(uuid, numeric, numeric, date, text, uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_manual_payable_payment(uuid, numeric, numeric, date, text, uuid, text, text) TO authenticated;
