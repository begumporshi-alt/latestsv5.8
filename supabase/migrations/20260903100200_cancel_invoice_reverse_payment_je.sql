-- Restore the payment-reversal journal entry in cancel_invoice, which the
-- 20260902130000 rework dropped while fixing the dead-column aborts.
--
-- Without it, cancelling a paid invoice leaves the original payment JE
-- (Dr Cash / Cr AR) posted with no counter-entry: AR carries a credit
-- balance and Cash stays overstated by the refunded amount. Earlier
-- function versions did post a "Reverse Payment - Cancelled <inv>" JE, but
-- as a single unbalanced line (Dr AR only, no Cr Cash).
--
-- This migration:
--   1. Recreates cancel_invoice posting a BALANCED per-payment reversal
--      (Dr AR / Cr the payment's cash account, mirroring the original
--      payment JE which used payment_methods.account_id ?? 1001).
--   2. Backfills the missing reversal for every reversed payment on a
--      cancelled invoice that still has its original JE posted and whose
--      invoice has no "Reverse Payment" JE yet (69 payments found,
--      ~৳235K, incl. INV-940649/PAY-997254 from today's fix).
--   3. Adds the missing Cr Cash line to the 25 historical single-line
--      (unbalanced, ৳957.50 total) "Reverse Payment" JEs.
--   4. Drops created_by from the refund-payment INSERT: the column's FK
--      targets profiles(id), a table the app abandoned (0 rows — no
--      payment in the system sets created_by), so auth.uid() from the UI
--      aborted every cancellation with a FK violation one statement after
--      the updated_at one.
--
-- Not touched: invoice-edit refunds (REV-PAY-*/REV-EDIT-*, reference_type
-- 'invoice_edit') — that flow DELETES the original payment's JE and posts
-- a fresh one for the new payment, so its refund rows are informational
-- and journaling them would double-reverse.

BEGIN;

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
  SELECT id INTO v_default_wh FROM warehouses WHERE is_default = true LIMIT 1;

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

-- ── Backfill 1: missing payment-reversal JEs on cancelled invoices ──
-- Anchor strictly on payments whose original JE is still posted (69 rows
-- at time of writing); payments with no JE never hit the GL, and invoices
-- that already carry a "Reverse Payment" JE (older function versions) are
-- skipped. Dated at the invoice's cancellation date when recorded in
-- invoice_edit_history, else today.
DO $backfill$
DECLARE
  v_payment RECORD;
  v_ar_account uuid;
  v_cash_account uuid;
  v_cancel_date date;
  v_count integer := 0;
  v_total numeric := 0;
BEGIN
  SELECT id INTO v_ar_account FROM accounts WHERE code = '1100' LIMIT 1;
  IF v_ar_account IS NULL THEN
    RAISE EXCEPTION 'Backfill aborted: AR account 1100 not found';
  END IF;

  FOR v_payment IN
    SELECT p.id AS payment_id, p.amount, p.payment_number, p.payment_method,
           p.customer_id, p.reference_id AS invoice_id
      FROM payments p
     WHERE p.reference_type = 'invoice'
       AND p.is_reversed = true
       AND EXISTS (SELECT 1 FROM invoices i WHERE i.id = p.reference_id AND i.status = 'cancelled')
       AND NOT EXISTS (
             SELECT 1 FROM journal_entries x
              WHERE x.reference_type = 'invoice_cancel'
                AND x.reference_id = p.reference_id
                AND x.description LIKE 'Reverse Payment%')
       AND EXISTS (
             SELECT 1 FROM journal_entries je
              WHERE je.reference_type = 'payment'
                AND je.reference_id = p.id
                AND je.is_posted = true)
     ORDER BY p.created_at
  LOOP
    -- Cash account: mirror the original payment JE's debit side if possible.
    SELECT jl.account_id INTO v_cash_account
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.journal_entry_id
     WHERE je.reference_type = 'payment' AND je.reference_id = v_payment.payment_id
       AND jl.debit > 0
     ORDER BY jl.sort_order
     LIMIT 1;
    IF v_cash_account IS NULL THEN
      SELECT pm.account_id INTO v_cash_account
        FROM payment_methods pm
       WHERE pm.code = v_payment.payment_method AND pm.is_active = true
       LIMIT 1;
    END IF;
    IF v_cash_account IS NULL THEN
      SELECT id INTO v_cash_account FROM accounts WHERE code = '1001' LIMIT 1;
    END IF;

    SELECT COALESCE((SELECT h.created_at::date
                      FROM invoice_edit_history h
                     WHERE h.invoice_id = v_payment.invoice_id
                       AND h.change_type = 'cancelled'
                     ORDER BY h.created_at DESC LIMIT 1), CURRENT_DATE)
      INTO v_cancel_date;

    PERFORM post_journal_entry(
      'Reverse Payment - Cancelled ' || (SELECT invoice_number FROM invoices WHERE id = v_payment.invoice_id),
      v_cancel_date,
      'invoice_cancel',
      v_payment.invoice_id,
      json_build_array(
        json_build_object('account_id', v_ar_account, 'debit', v_payment.amount, 'credit', 0,
          'description', 'Backfill: restore AR for reversed payment ' || v_payment.payment_number),
        json_build_object('account_id', v_cash_account, 'debit', 0, 'credit', v_payment.amount,
          'description', 'Backfill: refund ' || v_payment.payment_number)
      )::json,
      v_payment.customer_id
    );
    v_count := v_count + 1;
    v_total := v_total + v_payment.amount;
  END LOOP;

  RAISE NOTICE 'Backfill 1: posted % payment-reversal JEs, total %', v_count, v_total;
END
$backfill$;

-- ── Backfill 2: add the missing Cr Cash line to the historical
-- single-line (unbalanced) "Reverse Payment" JEs ──
DO $repair$
DECLARE
  v_je RECORD;
  v_cash_account uuid;
  v_amount numeric;
  v_count integer := 0;
BEGIN
  FOR v_je IN
    SELECT je.id, je.entry_number, je.reference_id AS invoice_id,
           COALESCE(je.total_debit, 0) AS amount
      FROM journal_entries je
     WHERE je.description LIKE 'Reverse Payment - Cancelled%'
       AND COALESCE(je.total_debit, 0) > 0
       AND COALESCE(je.total_credit, 0) = 0
       AND NOT EXISTS (SELECT 1 FROM journal_lines jl
                        WHERE jl.journal_entry_id = je.id AND jl.credit > 0)
  LOOP
    -- Cash account: from the invoice's reversed payments' original JEs.
    SELECT jl.account_id INTO v_cash_account
      FROM journal_lines jl
      JOIN journal_entries je2 ON je2.id = jl.journal_entry_id
      JOIN payments p ON p.id = je2.reference_id
     WHERE je2.reference_type = 'payment'
       AND p.reference_type = 'invoice'
       AND p.reference_id = v_je.invoice_id
       AND jl.debit > 0
     ORDER BY je2.entry_date, jl.sort_order
     LIMIT 1;
    IF v_cash_account IS NULL THEN
      SELECT id INTO v_cash_account FROM accounts WHERE code = '1001' LIMIT 1;
    END IF;

    v_amount := v_je.amount;
    INSERT INTO journal_lines (journal_entry_id, account_id, description, debit, credit, sort_order)
    VALUES (v_je.id, v_cash_account,
            'Backfill: cash side of reversed payments (JE was posted Dr AR only)',
            0, v_amount, 1);

    UPDATE journal_entries SET total_credit = v_amount WHERE id = v_je.id;

    -- Maintain accounts.balance the same way post_journal_entry does.
    UPDATE accounts
       SET balance = CASE
             WHEN account_type IN ('asset', 'expense') THEN balance - v_amount
             WHEN account_type IN ('liability', 'equity', 'revenue') THEN balance + v_amount
             ELSE balance - v_amount
           END
     WHERE id = v_cash_account;

    v_count := v_count + 1;
  END LOOP;

  RAISE NOTICE 'Backfill 2: balanced % single-line Reverse Payment JEs', v_count;
END
$repair$;

COMMIT;
