/*
# Fix cancel_invoice: replace non-existent payment_number_seq with generate_payment_number()

## Problem
The cancel_invoice function uses `nextval('payment_number_seq')` but no such sequence exists.
The database uses a `generate_payment_number()` function instead (created in migration 20260710).

## Fix
Replace `nextval('payment_number_seq')` with `generate_payment_number()` call.
*/

CREATE OR REPLACE FUNCTION public.cancel_invoice(p_invoice_id uuid, p_reason text DEFAULT NULL, p_cancelled_by text DEFAULT NULL)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_invoice          RECORD;
  v_ar_account       uuid;
  v_revenue_account  uuid;
  v_cogs_account     uuid;
  v_inventory_account uuid;
  v_default_wh       uuid;
  v_item             RECORD;
  v_qty              numeric;
  v_cost             numeric;
  v_payment          RECORD;
  v_total_payments   numeric := 0;
  v_has_deliveries   boolean;
  v_je_id            uuid;
  v_sr               RECORD;
  v_returned_qty     numeric;
  v_rev_pay_num      text;
BEGIN
  SELECT * INTO v_invoice FROM invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Invoice not found');
  END IF;

  IF v_invoice.status = 'cancelled' THEN
    RETURN json_build_object('success', false, 'error', 'Invoice is already cancelled');
  END IF;

  -- Draft: just mark cancelled, no accounting reversals needed
  IF v_invoice.status = 'draft' THEN
    UPDATE invoices
    SET status = 'cancelled', amount_paid = 0, total_amount = 0, subtotal = 0, updated_at = now()
    WHERE id = p_invoice_id;

    INSERT INTO invoice_edit_history (
      invoice_id, invoice_number, edited_by_name, change_type, reason,
      snapshot_before, snapshot_after
    ) VALUES (
      p_invoice_id, v_invoice.invoice_number, p_cancelled_by, 'cancelled', p_reason,
      json_build_object('status', v_invoice.status, 'total_amount', v_invoice.total_amount),
      json_build_object('status', 'cancelled')
    );
    RETURN json_build_object('success', true, 'message', 'Draft invoice cancelled (no reversals needed)');
  END IF;

  -- Block if completed deliveries exist
  SELECT EXISTS(SELECT 1 FROM deliveries WHERE invoice_id = p_invoice_id AND status = 'delivered') INTO v_has_deliveries;
  IF v_has_deliveries THEN
    RETURN json_build_object('success', false, 'error', 'Cannot cancel an invoice that has been delivered. Please process a return instead.');
  END IF;

  -- Get account IDs
  SELECT id INTO v_ar_account FROM accounts WHERE code = '1100' LIMIT 1;
  SELECT id INTO v_revenue_account FROM accounts WHERE code = '4000' LIMIT 1;
  SELECT id INTO v_cogs_account FROM accounts WHERE code = '5000' LIMIT 1;
  SELECT id INTO v_inventory_account FROM accounts WHERE code = '1200' LIMIT 1;

  -- Reverse AR and Revenue
  IF v_ar_account IS NOT NULL AND v_revenue_account IS NOT NULL THEN
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

  -- Reverse COGS and restore Inventory
  IF v_cogs_account IS NOT NULL AND v_inventory_account IS NOT NULL THEN
    FOR v_item IN SELECT * FROM invoice_items WHERE invoice_id = p_invoice_id LOOP
      v_qty := v_item.quantity;
      v_cost := COALESCE(v_item.cost_price, 0);
      IF v_qty * v_cost > 0 THEN
        PERFORM post_journal_entry(
          'Reverse COGS - Cancelled ' || v_invoice.invoice_number,
          COALESCE(v_invoice.invoice_date, CURRENT_DATE),
          'invoice_cancel',
          p_invoice_id,
          json_build_array(
            json_build_object('account_id', v_inventory_account, 'debit', v_qty * v_cost, 'credit', 0,
            'description', 'Restore inventory for cancelled ' || v_invoice.invoice_number),
            json_build_object('account_id', v_cogs_account, 'debit', 0, 'credit', v_qty * v_cost,
            'description', 'Reverse COGS for cancelled ' || v_invoice.invoice_number)
          )::json,
          v_invoice.customer_id
        );
      END IF;
    END LOOP;
  END IF;

  -- Restore stock
  SELECT id INTO v_default_wh FROM warehouses WHERE is_default = true LIMIT 1;
  FOR v_item IN SELECT * FROM invoice_items WHERE invoice_id = p_invoice_id LOOP
    UPDATE inventory_items
    SET quantity_on_hand = quantity_on_hand + v_item.quantity,
    updated_at = now()
    WHERE product_id = v_item.product_id
    AND warehouse_id = COALESCE(v_item.warehouse_id, v_default_wh);
  END LOOP;

  -- Reverse payments and create reversal payment records
  FOR v_payment IN SELECT * FROM payments WHERE reference_id = p_invoice_id AND reference_type = 'invoice' AND is_reversed = false LOOP
    v_total_payments := v_total_payments + v_payment.amount;

    -- Mark original payment as reversed
    UPDATE payments SET is_reversed = true WHERE id = v_payment.id;

    -- Generate a proper payment number using the existing function
    SELECT generate_payment_number() INTO v_rev_pay_num;

    -- Create reversal payment record
    INSERT INTO payments (
      payment_number, payment_type, reference_type, reference_id, customer_id,
      amount, payment_method, payment_date, is_reversed, payment_for,
      notes, created_at
    ) VALUES (
      v_rev_pay_num,
      'received',
      'invoice_cancel',
      p_invoice_id,
      v_invoice.customer_id,
      v_payment.amount,
      v_payment.payment_method,
      COALESCE(v_invoice.invoice_date, CURRENT_DATE),
      false,
      'reversal_payment',
      'Reversal of payment for cancelled invoice ' || v_invoice.invoice_number,
      now()
    );
  END LOOP;

  -- Reverse payment journal entries
  IF v_total_payments > 0 AND v_ar_account IS NOT NULL THEN
    PERFORM post_journal_entry(
      'Reverse Payment - Cancelled ' || v_invoice.invoice_number,
      COALESCE(v_invoice.invoice_date, CURRENT_DATE),
      'invoice_cancel',
      p_invoice_id,
      json_build_array(
        json_build_object('account_id', v_ar_account, 'debit', v_total_payments, 'credit', 0,
        'description', 'Restore AR for reversed payments - ' || v_invoice.invoice_number)
      )::json,
      v_invoice.customer_id
    );
  END IF;

  -- Handle linked sales returns
  FOR v_sr IN SELECT * FROM sales_returns WHERE invoice_id = p_invoice_id LOOP
    SELECT COALESCE(SUM(quantity), 0) INTO v_returned_qty
    FROM sales_return_items WHERE return_id = v_sr.id;
    -- Mark the return as void since the invoice is cancelled
    UPDATE sales_returns SET status = 'void', updated_at = now() WHERE id = v_sr.id;
  END LOOP;

  -- Mark invoice as cancelled
  UPDATE invoices
  SET status = 'cancelled',
      amount_paid = 0,
      balance_due = 0,
      updated_at = now()
  WHERE id = p_invoice_id;

  -- Record edit history
  INSERT INTO invoice_edit_history (
    invoice_id, invoice_number, edited_by_name, change_type, reason,
    snapshot_before, snapshot_after
  ) VALUES (
    p_invoice_id, v_invoice.invoice_number, p_cancelled_by, 'cancelled', p_reason,
    json_build_object('status', v_invoice.status, 'total_amount', v_invoice.total_amount, 'amount_paid', v_invoice.amount_paid),
    json_build_object('status', 'cancelled', 'total_amount', 0, 'amount_paid', 0)
  );

  RETURN json_build_object('success', true, 'message', 'Invoice cancelled successfully');
END;
$function$;
