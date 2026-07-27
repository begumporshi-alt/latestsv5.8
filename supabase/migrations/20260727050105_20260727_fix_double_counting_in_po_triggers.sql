-- ============================================================
-- Fix: Remove double-counting from receipt and cancel triggers
-- post_journal_entry already updates account balances correctly,
-- so the additional increment_account_balance calls are double-counting.
-- ============================================================

CREATE OR REPLACE FUNCTION purchase_order_accounting_trigger()
RETURNS TRIGGER AS $$
DECLARE
  v_inventory_account uuid;
  v_ap_account uuid;
  v_total_cost numeric;
  v_je_id uuid;
BEGIN
  IF NEW.status != 'received' THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'received' THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_inventory_account FROM accounts WHERE code = '1200' LIMIT 1;
  SELECT id INTO v_ap_account FROM accounts WHERE code = '2000' LIMIT 1;

  IF v_inventory_account IS NULL OR v_ap_account IS NULL THEN
    RETURN NEW;
  END IF;

  -- Use NET total (total_amount) which accounts for all discounts
  v_total_cost := COALESCE(NEW.total_amount, 0);

  IF v_total_cost <= 0 THEN
    RETURN NEW;
  END IF;

  -- post_journal_entry handles account balance updates internally
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

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


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
  IF NEW.status != 'cancelled' THEN
    RETURN NEW;
  END IF;
  IF OLD.status NOT IN ('received', 'partially_received') THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_inventory_account FROM accounts WHERE code = '1200' LIMIT 1;
  SELECT id INTO v_ap_account FROM accounts WHERE code = '2000' LIMIT 1;

  IF v_inventory_account IS NULL OR v_ap_account IS NULL THEN
    RETURN NEW;
  END IF;

  v_total_cost := COALESCE(NEW.total_amount, 0);

  IF v_total_cost > 0 THEN
    -- post_journal_entry handles account balance updates internally
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
  END IF;

  -- Reverse all payment journal entries for this PO
  FOR v_payment IN
    SELECT amount, payment_method
    FROM payments
    WHERE reference_type = 'purchase_order'
      AND reference_id = NEW.id
      AND COALESCE(status, 'completed') != 'cancelled'
  LOOP
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
