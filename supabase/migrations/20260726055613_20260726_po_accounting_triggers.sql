/*
# Purchase Order Accounting Automation

This migration adds the missing accounting automation for the purchase flow:

1. `purchase_order_accounting_trigger()` — fires AFTER UPDATE on `purchase_orders`
   when status transitions to 'received'. Posts a journal entry:
     Dr. Inventory Asset (1200)
     Cr. Accounts Payable (2000)
   for the total cost of received goods. Also updates account balances.

2. `purchase_order_cancellation_trigger()` — fires AFTER UPDATE on `purchase_orders`
   when a previously-received order is cancelled. Posts a reversal entry:
     Dr. Accounts Payable (2000)
     Cr. Inventory Asset (1200)
   and reverses account balances.

3. Extends `payment_accounting_trigger()` to handle purchase order payments
   (payment_type = 'made', reference_type = 'purchase_order'):
     Dr. Accounts Payable (2000)
     Cr. Cash/Bank (payment method account)
*/

-- ============================================================
-- 1. Goods Receipt Accounting Trigger
-- ============================================================
CREATE OR REPLACE FUNCTION public.purchase_order_accounting_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_inventory_account uuid;
  v_ap_account uuid;
  v_total_cost numeric;
  v_je_id uuid;
  v_po_items RECORD;
BEGIN
  -- Only fire when status transitions TO 'received' (not from cancelled)
  IF NEW.status != 'received' THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'received' THEN
    RETURN NEW;  -- already received, no re-posting
  END IF;

  -- Get inventory and AP accounts
  SELECT id INTO v_inventory_account FROM accounts WHERE code = '1200' LIMIT 1;
  SELECT id INTO v_ap_account FROM accounts WHERE code = '2000' LIMIT 1;

  IF v_inventory_account IS NULL OR v_ap_account IS NULL THEN
    RETURN NEW;
  END IF;

  -- Total cost = sum of (quantity * unit_cost) minus discounts
  SELECT COALESCE(SUM(subtotal), 0) INTO v_total_cost
  FROM purchase_order_items
  WHERE purchase_order_id = NEW.id;

  IF v_total_cost <= 0 THEN
    RETURN NEW;
  END IF;

  -- Post journal entry: Dr. Inventory / Cr. Accounts Payable
  v_je_id := post_journal_entry(
    'Goods Received - ' || COALESCE(NEW.po_number, 'PO'),
    COALESCE(NEW.order_date, CURRENT_DATE),
    'purchase_receipt',
    NEW.id,
    json_build_array(
      json_build_object('account_id', v_inventory_account, 'debit', v_total_cost, 'credit', 0, 'description', 'Inventory received - ' || COALESCE(NEW.po_number, 'PO')),
      json_build_object('account_id', v_ap_account, 'debit', 0, 'credit', v_total_cost, 'description', 'Payable to supplier - ' || COALESCE(NEW.po_number, 'PO'))
    )::json,
    NULL,
    NEW.supplier_id
  );

  -- Update account balances
  PERFORM increment_account_balance(v_inventory_account, v_total_cost);
  PERFORM increment_account_balance(v_ap_account, -v_total_cost);

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_po_accounting ON purchase_orders;
CREATE TRIGGER trg_po_accounting
  AFTER UPDATE ON purchase_orders
  FOR EACH ROW
  EXECUTE FUNCTION purchase_order_accounting_trigger();

-- ============================================================
-- 2. Cancellation Reversal Trigger
-- ============================================================
CREATE OR REPLACE FUNCTION public.purchase_order_cancellation_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_inventory_account uuid;
  v_ap_account uuid;
  v_total_cost numeric;
BEGIN
  -- Only fire when status transitions TO 'cancelled' FROM 'received' or 'partially_received'
  IF NEW.status != 'cancelled' THEN
    RETURN NEW;
  END IF;
  IF OLD.status NOT IN ('received', 'partially_received') THEN
    RETURN NEW;  -- was never received, nothing to reverse
  END IF;

  SELECT id INTO v_inventory_account FROM accounts WHERE code = '1200' LIMIT 1;
  SELECT id INTO v_ap_account FROM accounts WHERE code = '2000' LIMIT 1;

  IF v_inventory_account IS NULL OR v_ap_account IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(SUM(subtotal), 0) INTO v_total_cost
  FROM purchase_order_items
  WHERE purchase_order_id = NEW.id;

  IF v_total_cost <= 0 THEN
    RETURN NEW;
  END IF;

  -- Post reversal entry: Dr. AP / Cr. Inventory (reverses the receipt)
  PERFORM post_journal_entry(
    'PO Cancelled - ' || COALESCE(NEW.po_number, 'PO'),
    CURRENT_DATE,
    'purchase_cancellation',
    NEW.id,
    json_build_array(
      json_build_object('account_id', v_ap_account, 'debit', v_total_cost, 'credit', 0, 'description', 'AP reversed - ' || COALESCE(NEW.po_number, 'PO')),
      json_build_object('account_id', v_inventory_account, 'debit', 0, 'credit', v_total_cost, 'description', 'Inventory reversed - ' || COALESCE(NEW.po_number, 'PO'))
    )::json,
    NULL,
    NEW.supplier_id
  );

  -- Reverse account balances
  PERFORM increment_account_balance(v_inventory_account, -v_total_cost);
  PERFORM increment_account_balance(v_ap_account, v_total_cost);

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_po_cancellation ON purchase_orders;
CREATE TRIGGER trg_po_cancellation
  AFTER UPDATE ON purchase_orders
  FOR EACH ROW
  EXECUTE FUNCTION purchase_order_cancellation_trigger();

-- ============================================================
-- 3. Extend Payment Trigger for PO Payments
-- ============================================================
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
BEGIN
  v_amount := COALESCE(NEW.amount, 0);
  v_bad_debt := COALESCE(NEW.bad_debt_amount, 0);

  IF v_amount <= 0 AND v_bad_debt <= 0 THEN
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

    -- Post payment: Debit AP, Credit Cash/Bank
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

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$function$;
