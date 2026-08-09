
-- Fix cancel_invoice function: balance_due is a GENERATED ALWAYS column
-- and cannot be set directly. Remove it from UPDATE and zero out the
-- source columns (total_amount, amount_paid, bad_debt_amount) so
-- balance_due auto-computes to 0.

CREATE OR REPLACE FUNCTION public.cancel_invoice(
  p_invoice_id uuid,
  p_reason text DEFAULT NULL,
  p_cancelled_by text DEFAULT NULL
) RETURNS json
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
  v_cogs_total       decimal(15,2) := 0;
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
    RETURN json_build_object('success', true, 'message', 'Draft invoice cancelled (no reversals needed)');
  END IF;

  SELECT EXISTS(SELECT 1 FROM deliveries WHERE invoice_id = p_invoice_id AND status = 'delivered') INTO v_has_deliveries;
  IF v_has_deliveries THEN
    RETURN json_build_object('success', false, 'error', 'Cannot cancel an invoice that has been delivered. Please process a return instead.');
  END IF;

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

  -- FIFO: Calculate COGS total from consumption records BEFORE restoring
  SELECT COALESCE(SUM(cogs_amount), 0) INTO v_cogs_total
  FROM invoice_item_batch_consumption
  WHERE invoice_item_id IN (SELECT id FROM invoice_items WHERE invoice_id = p_invoice_id);

  -- FIFO: Restore batch quantities for all invoice items
  FOR v_item IN SELECT * FROM invoice_items WHERE invoice_id = p_invoice_id LOOP
    PERFORM restore_fifo(v_item.id);
  END LOOP;

  -- If no consumption records existed, compute from cost_price
  IF v_cogs_total = 0 THEN
    FOR v_item IN SELECT * FROM invoice_items WHERE invoice_id = p_invoice_id LOOP
      v_cogs_total := v_cogs_total + (COALESCE(v_item.cost_price, 0) * COALESCE(v_item.quantity, 0));
    END LOOP;
  END IF;

  -- Reverse COGS
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

  -- Reverse payments
  FOR v_payment IN SELECT * FROM payments WHERE reference_id = p_invoice_id AND reference_type = 'invoice' AND is_reversed = false LOOP
    v_total_payments := v_total_payments + v_payment.amount;
    UPDATE payments SET is_reversed = true WHERE id = v_payment.id;
    SELECT generate_payment_number() INTO v_rev_pay_num;
    INSERT INTO payments (
      payment_number, payment_type, reference_type, reference_id, customer_id,
      amount, payment_method, payment_date, is_reversed, payment_for,
      notes, created_at
    ) VALUES (
      v_rev_pay_num, 'received', 'invoice_cancel', p_invoice_id, v_invoice.customer_id,
      v_payment.amount, v_payment.payment_method, COALESCE(v_invoice.invoice_date, CURRENT_DATE),
      false, 'reversal_payment',
      'Reversal of payment for cancelled invoice ' || v_invoice.invoice_number, now()
    );
  END LOOP;

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

  FOR v_sr IN SELECT * FROM sales_returns WHERE invoice_id = p_invoice_id LOOP
    UPDATE sales_returns SET status = 'void', updated_at = now() WHERE id = v_sr.id;
  END LOOP;

  -- balance_due is a GENERATED ALWAYS column: (total_amount - amount_paid - bad_debt_amount)
  -- Zero out the source columns so balance_due auto-computes to 0
  UPDATE invoices
  SET status = 'cancelled',
      amount_paid = 0,
      total_amount = 0,
      subtotal = 0,
      bad_debt_amount = 0,
      updated_at = now()
  WHERE id = p_invoice_id;

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
