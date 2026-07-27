-- ============================================================
-- Fix 1: Receipt trigger must use NEW.total_amount (net of discount), not SUM(subtotal) (gross)
-- ============================================================
CREATE OR REPLACE FUNCTION purchase_order_accounting_trigger()
RETURNS TRIGGER AS $$
DECLARE
  v_inventory_account uuid;
  v_ap_account uuid;
  v_total_cost numeric;
  v_je_id uuid;
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

  -- Use the NET total (total_amount) which already accounts for all discounts
  v_total_cost := COALESCE(NEW.total_amount, 0);

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
$$ LANGUAGE plpgsql;


-- ============================================================
-- Fix 2: Cancel trigger must use NEW.total_amount (net) and reverse payment journal entries
-- ============================================================
CREATE OR REPLACE FUNCTION purchase_order_cancellation_trigger()
RETURNS TRIGGER AS $$
DECLARE
  v_inventory_account uuid;
  v_ap_account uuid;
  v_cash_account uuid;
  v_payment_account uuid;
  v_total_cost numeric;
  v_payment RECORD;
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

  -- Use NET total for inventory reversal
  v_total_cost := COALESCE(NEW.total_amount, 0);

  IF v_total_cost > 0 THEN
    -- Post reversal of receipt: Dr. AP / Cr. Inventory
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

    -- Reverse account balances for the receipt
    PERFORM increment_account_balance(v_inventory_account, -v_total_cost);
    PERFORM increment_account_balance(v_ap_account, v_total_cost);
  END IF;

  -- Reverse all payment journal entries for this PO
  -- For each payment: the original was Dr AP / Cr Cash. Reversal is Dr Cash / Cr AP.
  FOR v_payment IN
    SELECT amount, payment_method
    FROM payments
    WHERE reference_type = 'purchase_order'
      AND reference_id = NEW.id
      AND COALESCE(status, 'completed') != 'cancelled'
  LOOP
    -- Find the payment method's cash/bank account
    SELECT pm.account_id INTO v_payment_account
    FROM payment_methods pm
    WHERE pm.code = v_payment.payment_method AND pm.is_active = true
    LIMIT 1;

    IF v_payment_account IS NULL THEN
      SELECT id INTO v_cash_account FROM accounts WHERE code = '1001' LIMIT 1;
    ELSE
      v_cash_account := v_payment_account;
    END IF;

    IF v_cash_account IS NOT NULL AND v_payment.amount > 0 THEN
      -- Reverse the payment: Dr Cash / Cr AP (undoes the original Dr AP / Cr Cash)
      PERFORM post_journal_entry(
        'Payment Reversed (Cancellation) - ' || COALESCE(NEW.po_number, 'PO'),
        CURRENT_DATE,
        'purchase_cancellation',
        NEW.id,
        json_build_array(
          json_build_object('account_id', v_cash_account, 'debit', v_payment.amount, 'credit', 0, 'description', 'Cash restored - ' || COALESCE(NEW.po_number, 'PO')),
          json_build_object('account_id', v_ap_account, 'debit', 0, 'credit', v_payment.amount, 'description', 'AP reinstated - ' || COALESCE(NEW.po_number, 'PO'))
        )::json,
        NULL,
        NEW.supplier_id
      );
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- Fix 3: Payment trigger must update PO amount_paid when a payment is inserted
-- ============================================================
CREATE OR REPLACE FUNCTION payment_po_amount_paid_trigger()
RETURNS TRIGGER AS $$
DECLARE
  v_po RECORD;
BEGIN
  -- Only for payments made to purchase orders
  IF NEW.payment_type = 'made' AND NEW.reference_type = 'purchase_order' THEN
    SELECT amount_paid, total_amount INTO v_po
    FROM purchase_orders WHERE id = NEW.reference_id;

    IF v_po.amount_paid IS NOT NULL THEN
      UPDATE purchase_orders
      SET amount_paid = amount_paid + NEW.amount,
          updated_at = now()
      WHERE id = NEW.reference_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payment_po_amount_paid ON payments;
CREATE TRIGGER trg_payment_po_amount_paid
  AFTER INSERT ON payments
  FOR EACH ROW
  EXECUTE FUNCTION payment_po_amount_paid_trigger();
