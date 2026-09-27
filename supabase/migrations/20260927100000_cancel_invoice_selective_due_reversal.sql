-- ============================================================================
-- Selective due-collection reversal on invoice cancellation
--
-- When cancelling an invoice that had previous dues collected alongside it at POS
-- (via payments.collected_with_invoice_id), cashiers may want to keep the old
-- debt payment as valid while cancelling only the new merchandise sale.
--
-- 1. Updates cancel_invoice with optional p_reverse_due_collections boolean (default true):
--    - When true (default): voids linked due payments, refunds them, restores older invoices'
--      unpaid balances, and reverses the AR/payment journals.
--    - When false: unlinks linked payments (collected_with_invoice_id = NULL) and tags
--      notes, preserving the payments as standalone debt collections on the older invoices.
--
-- 2. Updates sync_invoice_cancel to forward reverse_due_collections from offline payload.
--
-- cancel_invoice is DROPPED first (adding a parameter to CREATE OR REPLACE
-- would otherwise leave the old 3-arg version in place as an overload), so the
-- client-facing grant is re-asserted at the bottom of this file.
-- ============================================================================

DROP FUNCTION IF EXISTS public.cancel_invoice(uuid, text, text);

CREATE OR REPLACE FUNCTION public.cancel_invoice(
  p_invoice_id uuid,
  p_reason text,
  p_cancelled_by text,
  p_reverse_due_collections boolean DEFAULT true
)
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

  -- Reverse AR and Revenue (net of the invoice's VAT and shipping)
  v_vat := LEAST(COALESCE(v_invoice.tax_amount, 0), v_invoice.total_amount);
  v_shipping := LEAST(COALESCE(v_invoice.shipping_cost, 0), GREATEST(0, v_invoice.total_amount - v_vat));
  IF v_vat > 0 AND v_vat_account IS NULL THEN
    RAISE EXCEPTION 'Invoice % carries VAT (%) but VAT Payable account (2100) is missing', v_invoice.invoice_number, v_vat;
  END IF;
  IF v_shipping > 0 AND v_shipping_account IS NULL THEN
    RAISE EXCEPTION 'Invoice % carries shipping (%) but Shipping Income account (4020) is missing', v_invoice.invoice_number, v_shipping;
  END IF;
  IF v_ar_account IS NOT NULL AND v_revenue_account IS NOT NULL THEN
    v_lines := to_json(ARRAY[]::json[]);
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_revenue_account, 'debit', v_invoice.total_amount - v_vat - v_shipping, 'credit', 0,
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
      'account_id', v_ar_account, 'debit', 0, 'credit', v_invoice.total_amount,
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

  -- Split the reversal: the quick-sell portion was credited to the account
  -- the source shop was paid from; only the stocked portion restores 1200.
  SELECT COALESCE(SUM(ii.quantity * ii.cost_price), 0) INTO v_qs_cogs
  FROM invoice_items ii JOIN products pr ON pr.id = ii.product_id
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

  -- Restore stock + record stock movements (STOCKED items only)
  FOR v_item IN SELECT ii.* FROM invoice_items ii JOIN products pr ON pr.id = ii.product_id WHERE ii.invoice_id = p_invoice_id AND pr.track_inventory LOOP
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

  -- FIFO: Restore batch quantities for all invoice items (restore_fifo is a
  -- natural no-op for non-stock items — they have no consumption rows)
  FOR v_item IN SELECT * FROM invoice_items WHERE invoice_id = p_invoice_id LOOP
    PERFORM restore_fifo(v_item.id);
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
    'stock_restored', v_stock_restored,
    'journal_reversed', v_journal_reversed,
    'due_collections_reversed', v_total_due_reversed,
    'due_collections_retained', v_due_retained,
    'advance_applications_reversed', v_total_advance_reversed
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_invoice_cancel(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_res jsonb;
  v_reverse_dues boolean;
BEGIN
  v_reverse_dues := coalesce((p_payload->>'reverse_due_collections')::boolean, true);

  v_res := public.cancel_invoice(
    (p_payload->>'invoice_id')::uuid,
    p_payload->>'reason',
    coalesce(p_payload->>'cancelled_by', 'Offline sync'),
    v_reverse_dues
  );

  if coalesce((v_res->>'success')::boolean, false) then
    return v_res || jsonb_build_object('status', 'synced');
  end if;
  raise exception 'invoice.cancel: %', coalesce(v_res->>'error', 'cancel_invoice failed');
END;
$$;

-- cancel_invoice was dropped and recreated above; re-assert the client grant
-- instead of relying on the schema's default privileges.
GRANT EXECUTE ON FUNCTION public.cancel_invoice(uuid, text, text, boolean) TO authenticated;
