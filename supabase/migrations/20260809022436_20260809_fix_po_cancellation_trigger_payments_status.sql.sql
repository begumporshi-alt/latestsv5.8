
-- Fix purchase_order_cancellation_trigger: payments table has no "status" column.
-- Use is_reversed instead to determine which payments are active.

CREATE OR REPLACE FUNCTION public.purchase_order_cancellation_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
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

  -- Reverse all non-reversed payment journal entries for this PO
  FOR v_payment IN
    SELECT amount, payment_method
    FROM payments
    WHERE reference_type = 'purchase_order'
      AND reference_id = NEW.id
      AND is_reversed = false
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
$function$;
