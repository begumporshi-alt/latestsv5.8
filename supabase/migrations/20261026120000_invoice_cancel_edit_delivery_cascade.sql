-- ============================================================================
-- Delivery challan lifecycle: follow the invoice
-- ============================================================================
-- Owner decision 2026-10-26: a challan is a satellite of its invoice.
-- 1. deliveries.status gains 'cancelled'; cancel_invoice cascade-cancels every
--    challan converted from the invoice (no status gate anymore).
-- 2. The delivered-block on edit_invoice is removed; STEP 6b now syncs every
--    challan regardless of status, preserves partial delivered_quantity
--    (LEAST of old progress vs new qty) and stamps was_edited/edited_at/edit_note.
-- 3. No stamp on the printed challan; the tag lives in the UI lists only.
-- ============================================================================

ALTER TABLE deliveries DROP CONSTRAINT IF EXISTS deliveries_status_check;
ALTER TABLE deliveries ADD CONSTRAINT deliveries_status_check
  CHECK (status IN ('pending','assigned','in_transit','delivered','failed','returned','cancelled'));

ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS was_edited boolean NOT NULL DEFAULT false;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS edited_at timestamptz;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS edit_note text;

CREATE OR REPLACE FUNCTION public.cancel_invoice(p_invoice_id uuid, p_reason text, p_cancelled_by text, p_reverse_due_collections boolean DEFAULT true)
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
  -- Sales-return netting: a completed return already refunded the customer and
  -- already restocked/reversed its own share of revenue, VAT, shipping and
  -- COGS, so the cancellation reverses only the remainder.
  v_already_refunded numeric := 0;
  v_ar_net numeric := 0;
  v_vat_returned numeric := 0;
  v_shipping_returned numeric := 0;
  v_cogs_returned numeric := 0;
  v_returned_base numeric := 0;
  v_pay_refund numeric := 0;
  v_refund_left numeric := 0;
  v_refund_offset numeric := 0;
  v_total_refunded numeric := 0;
  v_payments_total numeric := 0;
  v_item_stock_restored boolean := false;
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
  -- Cascade: cancel every delivery challan converted from this invoice
  UPDATE deliveries
  SET status = 'cancelled', updated_at = now()
  WHERE invoice_id = p_invoice_id AND status <> 'cancelled';

  SELECT id INTO v_ar_account FROM accounts WHERE code = '1100' LIMIT 1;
  SELECT id INTO v_revenue_account FROM accounts WHERE code = '4000' LIMIT 1;
  SELECT id INTO v_cogs_account FROM accounts WHERE code = '5000' LIMIT 1;
  SELECT id INTO v_inventory_account FROM accounts WHERE code = '1200' LIMIT 1;
  SELECT id INTO v_vat_account FROM accounts WHERE code = '2100' LIMIT 1;
  SELECT id INTO v_shipping_account FROM accounts WHERE code = '4020' LIMIT 1;
  SELECT id INTO v_default_wh FROM warehouses WHERE is_default = true LIMIT 1;

  -- ---------------------------------------------------------------------
  -- Linked sales returns still in force.
  --
  -- Each one ALREADY: refunded the customer (cash, store credit or advance),
  -- restocked the returned units (inventory_items + batches via
  -- restore_fifo_on_return) and posted its own JE reversing the returned share
  -- of revenue, VAT, shipping and COGS. Cancelling the invoice must reverse
  -- only the REMAINDER — otherwise the returned portion is reversed a second
  -- time (stock over-restored, COGS credited twice, revenue and AR doubly
  -- reversed) while the return's payout stays out of the till.
  --
  -- The ledger is the source of truth for the reversed GL amounts, and
  -- invoices.refunded_amount for the money already paid back.
  -- ---------------------------------------------------------------------
  v_already_refunded := COALESCE(v_invoice.refunded_amount, 0);

  IF EXISTS (SELECT 1 FROM sales_returns WHERE invoice_id = p_invoice_id AND status <> 'void') THEN
    SELECT COALESCE(SUM(jl.debit - jl.credit), 0) INTO v_vat_returned
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.journal_entry_id
     WHERE je.is_posted
       AND je.reference_type = 'sales_return'
       AND je.reference_id IN (SELECT id FROM sales_returns WHERE invoice_id = p_invoice_id AND status <> 'void')
       AND jl.account_id = v_vat_account;

    SELECT COALESCE(SUM(jl.debit - jl.credit), 0) INTO v_shipping_returned
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.journal_entry_id
     WHERE je.is_posted
       AND je.reference_type = 'sales_return'
       AND je.reference_id IN (SELECT id FROM sales_returns WHERE invoice_id = p_invoice_id AND status <> 'void')
       AND jl.account_id = v_shipping_account;

    -- The return CREDITS COGS, so the reversed amount is -SUM(debit - credit)
    SELECT COALESCE(-SUM(jl.debit - jl.credit), 0) INTO v_cogs_returned
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.journal_entry_id
     WHERE je.is_posted
       AND je.reference_type = 'sales_return'
       AND je.reference_id IN (SELECT id FROM sales_returns WHERE invoice_id = p_invoice_id AND status <> 'void')
       AND jl.account_id = v_cogs_account;

    SELECT COALESCE(SUM(r.returned_base), 0) INTO v_returned_base
      FROM public.sales_return_base_units(p_invoice_id) r;
  END IF;

  -- Collections still standing on this invoice. Needed before the AR reversal
  -- so the receivable lands on exactly zero: the reversing credit is
  -- (total - min(collections, already refunded)) and the cash refund issued
  -- below is max(0, collections - already refunded) — the two together clear
  -- AR and leave the customer exactly whole, whatever the refund mix was.
  SELECT COALESCE(SUM(amount), 0) INTO v_payments_total
    FROM payments
   WHERE reference_type = 'invoice' AND reference_id = p_invoice_id AND is_reversed = false;

  -- Reverse AR and Revenue, net of the invoice's VAT, shipping and the portion
  -- already reversed by linked sales returns.
  v_ar_net := GREATEST(0, COALESCE(v_invoice.total_amount, 0) - LEAST(v_payments_total, v_already_refunded));
  v_vat := LEAST(COALESCE(v_invoice.tax_amount, 0), v_invoice.total_amount);
  v_shipping := LEAST(COALESCE(v_invoice.shipping_cost, 0), GREATEST(0, v_invoice.total_amount - v_vat));
  v_vat := LEAST(GREATEST(0, v_vat - v_vat_returned), v_ar_net);
  v_shipping := LEAST(GREATEST(0, v_shipping - v_shipping_returned), GREATEST(0, v_ar_net - v_vat));
  IF v_vat > 0 AND v_vat_account IS NULL THEN
    RAISE EXCEPTION 'Invoice % carries VAT (%) but VAT Payable account (2100) is missing', v_invoice.invoice_number, v_vat;
  END IF;
  IF v_shipping > 0 AND v_shipping_account IS NULL THEN
    RAISE EXCEPTION 'Invoice % carries shipping (%) but Shipping Income account (4020) is missing', v_invoice.invoice_number, v_shipping;
  END IF;
  IF v_ar_net > 0 AND v_ar_account IS NOT NULL AND v_revenue_account IS NOT NULL THEN
    v_lines := to_json(ARRAY[]::json[]);
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_revenue_account, 'debit', v_ar_net - v_vat - v_shipping, 'credit', 0,
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
      'account_id', v_ar_account, 'debit', 0, 'credit', v_ar_net,
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

  -- Net of the COGS a linked sales return already reversed (its JE credits
  -- 5000 for the returned cost), so the cancellation only reverses the rest.
  v_cogs_total := GREATEST(0, v_cogs_total - v_cogs_returned);

  -- Split the reversal: the quick-sell portion was credited to the account
  -- the source shop was paid from; only the stocked portion restores 1200.
  SELECT COALESCE(SUM(GREATEST(0, ii.quantity - COALESCE(r.returned_qty, 0)) * ii.cost_price), 0) INTO v_qs_cogs
  FROM invoice_items ii
  JOIN products pr ON pr.id = ii.product_id
  LEFT JOIN public.sales_return_base_units(p_invoice_id) r ON r.invoice_item_id = ii.id
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

  -- Restore stock + record stock movements (STOCKED items only), net of the
  -- units a linked sales return already put back on the shelf.
  FOR v_item IN
    SELECT ii.*, COALESCE(r.returned_base, 0) AS returned_base
      FROM invoice_items ii
      JOIN products pr ON pr.id = ii.product_id
      LEFT JOIN public.sales_return_base_units(p_invoice_id) r ON r.invoice_item_id = ii.id
     WHERE ii.invoice_id = p_invoice_id AND pr.track_inventory
  LOOP
    v_qty := GREATEST(0, COALESCE(v_item.base_quantity, v_item.quantity) - v_item.returned_base);
    IF v_qty <= 0 THEN
      CONTINUE;  -- every unit on this line was already returned and restocked
    END IF;

    INSERT INTO inventory_items (tenant_id, product_id, warehouse_id, quantity_on_hand, quantity_reserved, quantity_incoming)
    VALUES ('00000000-0000-0000-0000-000000000001', v_item.product_id, COALESCE(v_item.warehouse_id, v_default_wh), v_qty, 0, 0)
    ON CONFLICT (product_id, warehouse_id)
    DO UPDATE SET quantity_on_hand = inventory_items.quantity_on_hand + EXCLUDED.quantity_on_hand,
                  updated_at = now();

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
    v_item_stock_restored := true;
  END LOOP;
  v_stock_restored := v_item_stock_restored;

  -- FIFO: restore batch quantities for the units still out. restore_fifo would
  -- hand back the item's FULL consumption, double-counting the units a return
  -- already restored through restore_fifo_on_return, so the restore is capped
  -- at (consumed - returned). Non-stock items have no consumption rows (natural
  -- no-op) and every consumption row is cleared either way.
  FOR v_item IN
    SELECT ii.id,
           GREATEST(0, COALESCE(ii.base_quantity, ii.quantity) - COALESCE(r.returned_base, 0)) AS restore_base
      FROM invoice_items ii
      LEFT JOIN public.sales_return_base_units(p_invoice_id) r ON r.invoice_item_id = ii.id
     WHERE ii.invoice_id = p_invoice_id
  LOOP
    PERFORM restore_fifo_partial(v_item.id, v_item.restore_base);
  END LOOP;

  -- Heal any IOU layers the restore repaid + resync counters from the ledger
  FOR v_item IN
    SELECT DISTINCT ii.product_id, COALESCE(ii.warehouse_id, v_default_wh) AS wh
      FROM invoice_items ii
      JOIN products pr ON pr.id = ii.product_id
     WHERE ii.invoice_id = p_invoice_id AND pr.track_inventory
  LOOP
    PERFORM heal_negative_batches_and_resync(v_item.product_id, v_item.wh);
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

  -- Cancel payments. Money already paid back through a linked sales return is
  -- NOT refunded a second time: invoices.refunded_amount is netted off the
  -- refunds, oldest payment first, so the customer ends up exactly whole (paid
  -- X, already refunded R via the return, refunded X - R here).
  v_refund_left := v_already_refunded;

  FOR v_payment IN SELECT * FROM payments WHERE reference_type = 'invoice' AND reference_id = p_invoice_id AND is_reversed = false ORDER BY payment_date, payment_number LOOP
    v_total_payments := v_total_payments + v_payment.amount;
    UPDATE payments SET is_reversed = true, updated_at = now() WHERE id = v_payment.id;

    v_pay_refund := COALESCE(v_payment.amount, 0);
    IF v_refund_left > 0 AND v_pay_refund > 0 THEN
      IF v_refund_left >= v_pay_refund THEN
        v_refund_left := v_refund_left - v_pay_refund;
        v_refund_offset := v_refund_offset + v_pay_refund;
        v_pay_refund := 0;
      ELSE
        v_pay_refund := v_pay_refund - v_refund_left;
        v_refund_offset := v_refund_offset + v_refund_left;
        v_refund_left := 0;
      END IF;
    END IF;

    IF v_pay_refund <= 0 THEN
      CONTINUE;  -- this collection was already paid back through the return
    END IF;

    v_total_refunded := v_total_refunded + v_pay_refund;

    SELECT 'RVP-' || COALESCE(MAX(CAST(SUBSTRING(payment_number FROM 5) AS INTEGER)) + 1, 1)
    INTO v_rev_pay_num FROM payments WHERE payment_number LIKE 'RVP-%';

    INSERT INTO payments (payment_number, payment_type, reference_type, reference_id, customer_id, supplier_id,
    amount, payment_method, payment_date, reference_number, notes)
    VALUES (
      v_rev_pay_num, 'refund', 'invoice', p_invoice_id, v_payment.customer_id, v_payment.supplier_id,
      v_pay_refund, v_payment.payment_method, CURRENT_DATE, v_payment.payment_number,
      CASE WHEN v_refund_offset > 0
           THEN 'Auto-refund on invoice cancellation (net of ' || v_already_refunded || ' already refunded on linked sales returns)'
           ELSE 'Auto-refund on invoice cancellation' END
    );

    IF v_ar_account IS NOT NULL AND COALESCE(v_pay_refund, 0) > 0 THEN
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
            json_build_object('account_id', v_ar_account, 'debit', v_pay_refund, 'credit', 0,
              'description', 'Restore AR for reversed payment ' || v_payment.payment_number),
            json_build_object('account_id', v_payment_account, 'debit', 0, 'credit', v_pay_refund,
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
    'payments_refunded', v_total_refunded,
    'refund_offset_by_returns', v_refund_offset,
    'returns_refunded_total', v_already_refunded,
    'stock_qty_already_returned', v_returned_base,
    'stock_restored', v_stock_restored,
    'journal_reversed', v_journal_reversed,
    'due_collections_reversed', v_total_due_reversed,
    'due_collections_retained', v_due_retained,
    'advance_applications_reversed', v_total_advance_reversed
  );
END;
$function$;




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
  v_bad_debt_account uuid;
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
  v_delivered_map json;
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
  v_shipping_account uuid;
  v_new_shipping numeric := 0;
  v_old_shipping numeric := 0;
  v_lines json;
  v_new_cost_method text;
  v_adv_account uuid;
  v_app RECORD;
  v_total_advance_reversed numeric := 0;
BEGIN
  SELECT * INTO v_invoice FROM invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Invoice not found');
  END IF;

  IF v_invoice.status = 'cancelled' THEN
    RETURN json_build_object('success', false, 'error', 'Cannot edit a cancelled invoice');
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
  v_new_shipping := COALESCE((p_new_data->>'shipping_cost')::numeric, 0);
  v_new_cost_method := NULLIF(p_new_data->>'cost_payment_method', '');

  FOR v_i IN SELECT generate_series(0, json_array_length(v_new_items) - 1) LOOP
    v_new_item := v_new_items->v_i;
    v_new_subtotal := v_new_subtotal + (v_new_item->>'quantity')::numeric * (v_new_item->>'unit_price')::numeric * (1 - COALESCE((v_new_item->>'discount_percent')::numeric, 0) / 100);
  END LOOP;

  v_cart_discount_amount := (v_new_subtotal * v_new_cart_discount_percent) / 100;
  v_new_total := GREATEST(0, v_new_subtotal - v_cart_discount_amount - v_new_extra_discount);
  SELECT COALESCE(s.setting_value->>'mode', 'exclusive') INTO v_vat_mode
  FROM app_settings s WHERE s.setting_key = 'vat';
  v_vat_mode := COALESCE(v_vat_mode, 'exclusive');
  IF v_vat_mode = 'exclusive' THEN
    v_new_total := v_new_total + v_new_tax;
  END IF;
  v_new_shipping := GREATEST(0, v_new_shipping);
  v_new_total := v_new_total + v_new_shipping;

  IF v_invoice.amount_paid >= v_invoice.total_amount AND v_invoice.total_amount > 0 THEN
    v_old_payment_term := 'full';
  ELSIF v_invoice.amount_paid > 0 THEN
    v_old_payment_term := 'partial';
  ELSE
    v_old_payment_term := 'credit';
  END IF;

  SELECT id INTO v_ar_account FROM accounts WHERE code = '1100' LIMIT 1;
  SELECT id INTO v_bad_debt_account FROM accounts WHERE code = '5600' LIMIT 1;
  SELECT id INTO v_revenue_account FROM accounts WHERE code = '4000' LIMIT 1;
  SELECT id INTO v_cogs_account FROM accounts WHERE code = '5000' LIMIT 1;
  SELECT id INTO v_inventory_account FROM accounts WHERE code = '1200' LIMIT 1;
  SELECT id INTO v_vat_account FROM accounts WHERE code = '2100' LIMIT 1;
  SELECT id INTO v_shipping_account FROM accounts WHERE code = '4020' LIMIT 1;
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
    'shipping_cost', COALESCE(v_invoice.shipping_cost, 0),
    'total_amount', v_invoice.total_amount, 'amount_paid', v_invoice.amount_paid, 'status', v_invoice.status,
    'payment_term', v_old_payment_term, 'payments', v_old_payments,
    'cost_payment_method', v_invoice.cost_payment_method,
    'items', (SELECT json_agg(json_build_object('product_id', ii.product_id, 'quantity', ii.quantity, 'unit_price', ii.unit_price, 'discount_percent', ii.discount_percent, 'subtotal', ii.subtotal, 'unit_name', ii.unit_name, 'base_quantity', ii.base_quantity, 'warehouse_id', ii.warehouse_id)) FROM invoice_items ii WHERE ii.invoice_id = p_invoice_id)
  ) INTO v_old_snapshot;

  -- STEP 1: FIFO - Restore batch quantities for old items FIRST
  FOR v_item IN SELECT * FROM invoice_items WHERE invoice_id = p_invoice_id LOOP
    PERFORM restore_fifo(v_item.id);
  END LOOP;

  -- STEP 1b: Restore stock for old STOCKED items (PRESERVE original sale movements)
  FOR v_item IN SELECT ii.* FROM invoice_items ii JOIN products pr ON pr.id = ii.product_id WHERE ii.invoice_id = p_invoice_id AND pr.track_inventory LOOP
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
    END IF;
  END LOOP;

  -- Heal any IOU layers the restore repaid + resync counters from the ledger
  -- (old items still exist here, so this covers every pair the edit touches)
  FOR v_item IN
    SELECT DISTINCT ii.product_id, COALESCE(ii.warehouse_id, v_default_wh) AS wh
      FROM invoice_items ii
      JOIN products pr ON pr.id = ii.product_id
     WHERE ii.invoice_id = p_invoice_id AND pr.track_inventory
  LOOP
    PERFORM heal_negative_batches_and_resync(v_item.product_id, v_item.wh);
  END LOOP;

  -- STEP 2: Reverse AR + Revenue journal entry (net of the invoice's VAT and shipping)
  v_old_tax := LEAST(COALESCE(v_invoice.tax_amount, 0), v_invoice.total_amount);
  v_old_shipping := LEAST(COALESCE(v_invoice.shipping_cost, 0), GREATEST(0, v_invoice.total_amount - v_old_tax));
  IF v_old_tax > 0 AND v_vat_account IS NULL THEN
    RAISE EXCEPTION 'Invoice % carries VAT (%) but VAT Payable account (2100) is missing', v_invoice.invoice_number, v_old_tax;
  END IF;
  IF v_old_shipping > 0 AND v_shipping_account IS NULL THEN
    RAISE EXCEPTION 'Invoice % carries shipping (%) but Shipping Income account (4020) is missing', v_invoice.invoice_number, v_old_shipping;
  END IF;
  IF v_ar_account IS NOT NULL AND v_revenue_account IS NOT NULL AND v_invoice.total_amount > 0 THEN
    v_lines := to_json(ARRAY[]::json[]);
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_ar_account, 'debit', 0, 'credit', v_invoice.total_amount, 'description', 'Reverse AR for edited invoice ' || v_invoice.invoice_number)))::json);
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_revenue_account, 'debit', v_invoice.total_amount - v_old_tax - v_old_shipping, 'credit', 0, 'description',
      CASE WHEN v_old_tax > 0 OR v_old_shipping > 0
           THEN 'Reverse revenue (net of VAT and shipping) for edited invoice ' || v_invoice.invoice_number
           ELSE 'Reverse revenue for edited invoice ' || v_invoice.invoice_number END)))::json);
    IF v_old_tax > 0 THEN
      v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
        'account_id', v_vat_account, 'debit', v_old_tax, 'credit', 0, 'description', 'Reverse VAT for edited invoice ' || v_invoice.invoice_number)))::json);
    END IF;
    IF v_old_shipping > 0 THEN
      v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
        'account_id', v_shipping_account, 'debit', v_old_shipping, 'credit', 0, 'description', 'Reverse shipping income for edited invoice ' || v_invoice.invoice_number)))::json);
    END IF;
    PERFORM post_journal_entry(
      'REVERSAL - AR - Invoice ' || v_invoice.invoice_number || ' EDIT', COALESCE(v_invoice.invoice_date, CURRENT_DATE), 'invoice_edit', p_invoice_id,
      v_lines, v_invoice.customer_id
    );
  END IF;

  -- STEP 3: Delete original COGS journal entries (including the Quick Sell
  -- Cost JE, so the edit below re-posts it from the new lines) and roll back
  -- account balances
  FOR v_je_id IN
    SELECT je.id FROM journal_entries je
    WHERE je.reference_type = 'invoice'
      AND je.reference_id = p_invoice_id
      AND (je.description LIKE 'COGS%' OR je.description LIKE 'Quick Sell Cost%')
  LOOP
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

  -- Restore advance applications (sub-ledger) AND reverse their journal, so the
  -- general ledger and the customer's wallets agree again before the invoice is rewritten. Without this an edited advance-paid invoice
  -- was reset to unpaid while the wallet stayed spent, and re-entering a cash
  -- payment on the edit double-counted the same money.
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
    END IF;

    v_total_advance_reversed := v_total_advance_reversed + COALESCE(v_app.amount, 0);
  END LOOP;

  DELETE FROM customer_advance_applications WHERE invoice_id = p_invoice_id;

  -- STEP 4: Reverse original payments AND mark them as reversed
  FOR v_payment IN SELECT * FROM payments WHERE reference_type = 'invoice' AND reference_id = p_invoice_id AND is_reversed = false LOOP
    INSERT INTO payments (payment_number, payment_type, payment_method, amount, payment_date, reference_type, reference_id, reference_number, notes, payment_for, customer_id)
    VALUES ('REV-' || COALESCE(v_payment.payment_number, 'PAY'), CASE WHEN v_payment.payment_type = 'received' THEN 'refund' ELSE 'payment' END, v_payment.payment_method, v_payment.amount, CURRENT_DATE, 'invoice_edit', p_invoice_id, v_invoice.invoice_number, 'Reversal payment for edited invoice ' || v_invoice.invoice_number, 'reversal_payment', COALESCE(v_payment.customer_id, v_invoice.customer_id));
    UPDATE payments SET is_reversed = true WHERE id = v_payment.id;
  END LOOP;

  -- Delete original payment journal entries and roll back account balances
  FOR v_je_id IN
    SELECT je.id FROM journal_entries je
    WHERE je.reference_type = 'payment'
      AND je.reference_id IN (SELECT id FROM payments WHERE reference_type = 'invoice' AND reference_id = p_invoice_id)
  LOOP
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

  -- STEP 5: Update invoice header (cost_payment_method preserved unless the
  -- edit payload supplies a new one)
  UPDATE invoices
  SET customer_id = v_new_customer, invoice_date = v_new_date, due_date = v_new_due_date, notes = v_new_notes,
      reference = v_new_reference,
      subtotal = v_new_subtotal, cart_discount_percent = v_new_cart_discount_percent, extra_discount = v_new_extra_discount,
      discount_amount = v_cart_discount_amount, total_amount = v_new_total, tax_amount = v_new_tax, shipping_cost = v_new_shipping, amount_paid = 0,
      cost_payment_method = COALESCE(v_new_cost_method, cost_payment_method),
      status = 'draft', edit_count = COALESCE(edit_count, 0) + 1, updated_at = now()
  WHERE id = p_invoice_id;

  -- STEP 5b: Set session flag to prevent DELETE trigger from double-restoring stock
  PERFORM set_config('app.edit_invoice_active', 'true', true);

  -- STEP 6: Re-insert items
  DELETE FROM invoice_items WHERE invoice_id = p_invoice_id;
  FOR v_i IN SELECT generate_series(0, json_array_length(v_new_items) - 1) LOOP
    v_new_item := v_new_items->v_i;
    INSERT INTO invoice_items (invoice_id, product_id, quantity, unit_price, cost_price, discount_percent, tax_rate, subtotal, unit_name, unit_conversion_factor, base_quantity, warehouse_id, source_shop, sort_order)
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
      NULLIF(v_new_item->>'source_shop', ''),
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

  -- STEP 6b: Sync delivery challans (any status) with the edited invoice
  FOR v_delivery IN SELECT id FROM deliveries WHERE invoice_id = p_invoice_id LOOP
    SELECT COALESCE(json_object_agg(product_id::text, delivered_quantity), '{}'::json)
      INTO v_delivered_map
      FROM delivery_items WHERE delivery_id = v_delivery.id;
    DELETE FROM delivery_items WHERE delivery_id = v_delivery.id;
    FOR v_i IN SELECT generate_series(0, json_array_length(v_new_items) - 1) LOOP
      v_new_item := v_new_items->v_i;
      INSERT INTO delivery_items (delivery_id, product_id, quantity, delivered_quantity, unit_name, base_quantity)
      VALUES (
        v_delivery.id,
        (v_new_item->>'product_id')::uuid,
        (v_new_item->>'quantity')::numeric,
        LEAST(COALESCE((v_delivered_map->>(v_new_item->>'product_id'))::numeric, 0), (v_new_item->>'quantity')::numeric),
        NULLIF(v_new_item->>'unit_name', ''),
        COALESCE((v_new_item->>'base_quantity')::numeric, (v_new_item->>'quantity')::numeric)
      );
    END LOOP;
    UPDATE deliveries
    SET was_edited = true,
        edited_at = now(),
        edit_note = COALESCE(p_reason, 'Invoice ' || v_invoice.invoice_number || ' was edited'),
        updated_at = now()
    WHERE id = v_delivery.id;
  END LOOP;

  -- STEP 7: Re-post AR + Revenue for new total (revenue net of VAT and shipping).
  IF v_ar_account IS NOT NULL AND v_revenue_account IS NOT NULL AND v_new_total > 0 THEN
    IF v_new_tax > 0 AND v_vat_account IS NULL THEN
      RAISE EXCEPTION 'Edited invoice % carries VAT (%) but VAT Payable account (2100) is missing', v_invoice.invoice_number, v_new_tax;
    END IF;
    IF v_new_shipping > 0 AND v_shipping_account IS NULL THEN
      RAISE EXCEPTION 'Edited invoice % carries shipping (%) but Shipping Income account (4020) is missing', v_invoice.invoice_number, v_new_shipping;
    END IF;
    v_lines := to_json(ARRAY[]::json[]);
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_ar_account, 'debit', v_new_total, 'credit', 0, 'description', 'AR for edited invoice ' || v_invoice.invoice_number)))::json);
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_revenue_account, 'debit', 0, 'credit', v_new_total - v_new_tax - v_new_shipping, 'description',
      CASE WHEN v_new_tax > 0 OR v_new_shipping > 0
           THEN 'Revenue (net of VAT and shipping) for edited invoice ' || v_invoice.invoice_number
           ELSE 'Revenue for edited invoice ' || v_invoice.invoice_number END)))::json);
    IF v_new_tax > 0 THEN
      v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
        'account_id', v_vat_account, 'debit', 0, 'credit', v_new_tax, 'description', 'VAT payable for edited invoice ' || v_invoice.invoice_number)))::json);
    END IF;
    IF v_new_shipping > 0 THEN
      v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
        'account_id', v_shipping_account, 'debit', 0, 'credit', v_new_shipping, 'description', 'Shipping income for edited invoice ' || v_invoice.invoice_number)))::json);
    END IF;
    PERFORM post_journal_entry(
      'Accounts Receivable - Invoice ' || v_invoice.invoice_number || ' EDITED', v_new_date, 'invoice', p_invoice_id,
      v_lines, v_new_customer
    );
  END IF;

  -- STEP 7b: Post COGS journal entry for new items. Non-stock (quick-sell)
  -- items post through post_quick_sell_cost_je against the account the source
  -- shop was paid from — never Inventory 1200 — and are excluded from the
  -- no-FIFO fallback below.
  IF v_cogs_account IS NOT NULL AND v_inventory_account IS NOT NULL THEN
    DECLARE
      v_cogs_total decimal(15,2) := 0;
      v_has_fifo_data boolean := false;
      v_has_nonstock boolean := false;
    BEGIN
      SELECT EXISTS(
        SELECT 1 FROM invoice_items ii JOIN products pr ON pr.id = ii.product_id
         WHERE ii.invoice_id = p_invoice_id AND NOT pr.track_inventory
           AND ii.quantity > 0 AND COALESCE(ii.cost_price, 0) > 0
      ) INTO v_has_nonstock;
      IF v_has_nonstock THEN
        PERFORM post_quick_sell_cost_je(p_invoice_id);
      END IF;

      FOR v_item IN SELECT ii.*, p.name as product_name, p.sku FROM invoice_items ii JOIN products p ON ii.product_id = p.id WHERE ii.invoice_id = p_invoice_id ORDER BY ii.sort_order LOOP
        v_cost := 0;
        SELECT COALESCE(SUM(cogs_amount), 0) INTO v_cost
        FROM invoice_item_batch_consumption WHERE invoice_item_id = v_item.id;

        IF v_cost > 0 THEN
          v_cogs_total := v_cogs_total + v_cost;
          v_has_fifo_data := true;
        END IF;
      END LOOP;

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
        -- FALLBACK: stocked items without FIFO data only. Non-stock items are
        -- handled by post_quick_sell_cost_je above.
        v_cogs_total := 0;
        FOR v_item IN SELECT ii.*, p.name as product_name, p.sku FROM invoice_items ii JOIN products p ON ii.product_id = p.id WHERE ii.invoice_id = p_invoice_id AND p.track_inventory ORDER BY ii.sort_order LOOP
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
      INSERT INTO payments (payment_number, payment_type, payment_method, amount, payment_date, reference_type, reference_id, reference_number, notes, payment_for, customer_id)
      VALUES ('EDIT-' || v_invoice.invoice_number, 'received', v_new_payment_method, v_new_partial_amount, v_new_date, 'invoice', p_invoice_id, v_invoice.invoice_number, 'Partial payment for edited invoice ' || v_invoice.invoice_number, 'paid_invoice_pay', v_new_customer)
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
      INSERT INTO payments (payment_number, payment_type, payment_method, amount, payment_date, reference_type, reference_id, reference_number, notes, payment_for, customer_id)
      VALUES ('EDIT-' || v_invoice.invoice_number, 'received', v_new_payment_method, v_new_total, v_new_date, 'invoice', p_invoice_id, v_invoice.invoice_number, 'Payment for edited invoice ' || v_invoice.invoice_number, 'paid_invoice_pay', v_new_customer)
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
      -- The invoice is being re-marked fully collected. If a bad-debt write-off
      -- was ever posted against it, reverse it now, otherwise AR is credited
      -- twice for the same money (once by the write-off JE, once by this payment).
      IF COALESCE(v_invoice.bad_debt_amount, 0) > 0 AND v_ar_account IS NOT NULL AND v_bad_debt_account IS NOT NULL THEN
        PERFORM post_journal_entry(
          'REVERSAL - Bad debt write-off - Invoice ' || v_invoice.invoice_number || ' EDITED', v_new_date, 'invoice_edit', p_invoice_id,
          json_build_array(
            json_build_object('account_id', v_ar_account, 'debit', v_invoice.bad_debt_amount, 'credit', 0, 'description', 'Bad-debt write-off reversed (fully collected) for ' || v_invoice.invoice_number),
            json_build_object('account_id', v_bad_debt_account, 'debit', 0, 'credit', v_invoice.bad_debt_amount, 'description', 'Reverse bad-debt expense for ' || v_invoice.invoice_number)
          )::json, v_new_customer
        );
      END IF;
      UPDATE invoices SET status = 'paid', amount_paid = v_new_total, bad_debt_amount = 0 WHERE id = p_invoice_id;
    ELSE
      UPDATE invoices SET status = 'paid', amount_paid = 0 WHERE id = p_invoice_id;
    END IF;
  END IF;

  -- STEP 9: Record edit history
  SELECT json_build_object('customer_id', v_new_customer, 'invoice_date', v_new_date, 'due_date', v_new_due_date, 'notes', v_new_notes, 'reference', v_new_reference, 'subtotal', v_new_subtotal, 'cart_discount_percent', v_new_cart_discount_percent, 'extra_discount', v_new_extra_discount, 'shipping_cost', v_new_shipping, 'total_amount', v_new_total, 'payment_term', v_new_payment_term, 'payment_method', v_new_payment_method, 'items', v_new_items) INTO v_new_snapshot;

  INSERT INTO invoice_edit_history (invoice_id, invoice_number, edited_by_name, change_type, reason, snapshot_before, snapshot_after, old_value, new_value)
  VALUES (p_invoice_id, v_invoice.invoice_number, p_edited_by, 'full_edit', p_reason, v_old_snapshot, v_new_snapshot, v_old_snapshot, v_new_snapshot);

  -- STEP 10: Update customer outstanding_balance
  IF v_invoice.customer_id IS NOT NULL THEN
    UPDATE customers SET outstanding_balance = (SELECT COALESCE(SUM(balance_due), 0) FROM invoices WHERE customer_id = v_invoice.customer_id AND status IN ('sent', 'partially_paid', 'unpaid', 'overdue')), updated_at = now() WHERE id = v_invoice.customer_id;
  END IF;
  IF v_new_customer IS NOT NULL AND v_new_customer <> v_invoice.customer_id THEN
    UPDATE customers SET outstanding_balance = (SELECT COALESCE(SUM(balance_due), 0) FROM invoices WHERE customer_id = v_new_customer AND status IN ('sent', 'partially_paid', 'unpaid', 'overdue')), updated_at = now() WHERE id = v_new_customer;
  END IF;

  -- Final counter resync: the re-inserted items re-fired the deduct trigger,
  -- which floors the counter at 0 on oversell; set it back to the ledger sum.
  FOR v_item IN
    SELECT DISTINCT ii.product_id, COALESCE(ii.warehouse_id, v_default_wh) AS wh
      FROM invoice_items ii
      JOIN products pr ON pr.id = ii.product_id
     WHERE ii.invoice_id = p_invoice_id AND pr.track_inventory
  LOOP
    PERFORM heal_negative_batches_and_resync(v_item.product_id, v_item.wh);
  END LOOP;

  RETURN json_build_object('success', true, 'invoice_id', p_invoice_id, 'old_total', v_invoice.total_amount, 'new_total', v_new_total,
    'advance_applications_reversed', v_total_advance_reversed);
END;
$function$;



