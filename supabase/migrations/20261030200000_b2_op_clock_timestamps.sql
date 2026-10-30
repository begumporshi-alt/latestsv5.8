-- B2 — timestamps: every replayed path reads the op clock (plan §28.5).
--
-- B1 pinned sisolution.op_at for the whole sync_apply transaction; B2 moves
-- the readers. Every function below is reachable from sync_apply (computed
-- from the live call graph: handler calls + trigger firings on the tables
-- handlers write) and contained now()/current_date/current_timestamp; each
-- becomes op_at()/op_date(), so a replayed op writes the op's clock instead
-- of the replay machine's. Online callers omit p_at, op_at() falls back to
-- now(), and behaviour is unchanged byte for byte.
--
-- Deliberately still on the wall clock:
--   * consume_fifo's expiry filter and sync_invoice_create's store-credit
--     expiry filter — clock-DEPENDENT decisions, reserved for B5.
--   * sync_apply's own coalesce(p_at, now()) — the definition of op_at.
--   * everything not reachable from sync_apply: report functions (reads),
--     direct-RPC write paths (write_off_product_stock, collect_customer_*,
--     record_manual_receivable_payment, pay_supplier_outstanding), the
--     overdue cron, handle_new_user, and the generate_* numbering functions
--     (B4).
--   * clock_timestamp() sites — fallback document numbers, B4.
--
-- Column defaults: every public business-table column defaulting to now()
-- now defaults to op_at() (same fallback logic). sync_% tables are excluded:
-- their defaults are receipt times (sync_applied_items.applied_at), which
-- must stay the server clock.
--
-- Regenerated from the pinned lab schema (fingerprint 300ac140…) at
-- commit b6d6938; regenerate rather than hand-edit if the set changes.

begin;

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
    SET status = 'cancelled', amount_paid = 0, total_amount = 0, subtotal = 0, bad_debt_amount = 0, updated_at = op_at()
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
  SET status = 'cancelled', updated_at = op_at()
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
      COALESCE(v_invoice.invoice_date, op_date()),
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
      COALESCE(v_invoice.invoice_date, op_date()),
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
                  updated_at = op_at();

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
           updated_at = op_at()
     WHERE ca.id = v_app.advance_id;

    IF v_ar_account IS NOT NULL AND v_adv_account IS NOT NULL AND COALESCE(v_app.amount, 0) > 0 THEN
      PERFORM post_journal_entry(
        'Reverse advance application - ' || v_invoice.invoice_number,
        COALESCE(v_invoice.invoice_date, op_date()),
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
    UPDATE payments SET is_reversed = true, updated_at = op_at() WHERE id = v_payment.id;

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
      v_pay_refund, v_payment.payment_method, op_date(), v_payment.payment_number,
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
          COALESCE(v_invoice.invoice_date, op_date()),
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
      UPDATE payments SET is_reversed = true, updated_at = op_at() WHERE id = v_payment.id;

      SELECT 'RVP-' || COALESCE(MAX(CAST(SUBSTRING(payment_number FROM 5) AS INTEGER)) + 1, 1)
      INTO v_rev_pay_num FROM payments WHERE payment_number LIKE 'RVP-%';

      INSERT INTO payments (payment_number, payment_type, reference_type, reference_id, customer_id, supplier_id,
      amount, payment_method, payment_date, reference_number, notes)
      VALUES (
        v_rev_pay_num, 'refund', 'invoice', p_invoice_id, v_payment.customer_id, v_payment.supplier_id,
        v_payment.amount, v_payment.payment_method, op_date(), v_payment.payment_number,
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
            updated_at = op_at()
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
            COALESCE(v_invoice.invoice_date, op_date()),
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
           updated_at = op_at()
     WHERE collected_with_invoice_id = p_invoice_id
       AND is_reversed = false;
  END IF;

  -- Mark invoice cancelled
  UPDATE invoices
  SET status = 'cancelled', amount_paid = 0, total_amount = 0, subtotal = 0, bad_debt_amount = 0, updated_at = op_at()
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
$function$

CREATE OR REPLACE FUNCTION public.cash_out_store_credit(p_credit_id uuid, p_amount numeric, p_payment_account_id uuid, p_notes text DEFAULT NULL::text, p_expected_updated_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_credit customer_store_credits%rowtype;
  v_pay_account accounts%rowtype;
  v_acc_2200 uuid;
  v_redemption_id uuid;
  v_je_id uuid;
  v_entry_number text;
  v_new_balance numeric;
  v_notes text;
begin
  select * into v_credit from customer_store_credits
    where id = p_credit_id for update;
  if not found then
    raise exception 'cash_out_store_credit: store credit not found';
  end if;

  if v_credit.status <> 'active' then
    raise exception 'cash_out_store_credit: credit % is % — only active credits can be refunded in cash',
      v_credit.credit_number, v_credit.status;
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'cash_out_store_credit: amount must be greater than 0';
  end if;

  if p_amount > v_credit.balance then
    raise exception 'cash_out_store_credit: amount % exceeds the remaining balance %',
      p_amount, v_credit.balance;
  end if;

  -- Offline sync passes the updated_at the device last saw; a mismatch means
  -- the credit changed server-side since (same guard as store_credit.expire).
  if p_expected_updated_at is not null
     and v_credit.updated_at <> p_expected_updated_at then
    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'Store credit changed on the server since this device last saw it',
      'server_row', to_jsonb(v_credit));
  end if;

  select * into v_pay_account from accounts where id = p_payment_account_id;
  if not found then
    raise exception 'cash_out_store_credit: payment account not found';
  end if;
  if v_pay_account.account_type <> 'asset' or not v_pay_account.is_active then
    raise exception 'cash_out_store_credit: % (%) is not an active cash/bank account',
      v_pay_account.name, v_pay_account.code;
  end if;

  select id into v_acc_2200 from accounts where code = '2200' limit 1;
  if v_acc_2200 is null then
    raise exception 'cash_out_store_credit: Customer Refund Payable account (2200) not found';
  end if;

  v_notes := nullif(trim(coalesce(p_notes, '') || case when coalesce(p_notes, '') <> '' then ' — ' end
    || 'Cash refund via ' || v_pay_account.code || ' ' || v_pay_account.name), '');

  -- Redemption row: trg_update_credit_balance decrements balance and flips
  -- status to 'redeemed' when it reaches zero.
  insert into store_credit_redemptions (store_credit_id, customer_id, invoice_id, amount, notes)
  values (v_credit.id, v_credit.customer_id, null, p_amount, v_notes)
  returning id into v_redemption_id;

  -- Settle the liability: Dr 2200 / Cr the account the money left.
  select public.post_journal_entry(
    'Store credit cash refund ' || v_credit.credit_number || ' — via ' || v_pay_account.name,
    op_date(),
    'store_credit_cash_out',
    v_credit.id,
    json_build_array(
      json_build_object('account_id', v_acc_2200, 'debit', p_amount, 'credit', 0,
        'description', 'Store credit settled in cash — ' || v_credit.credit_number),
      json_build_object('account_id', p_payment_account_id, 'debit', 0, 'credit', p_amount,
        'description', 'Cash refund to customer — ' || v_credit.credit_number)
    )::json,
    v_credit.customer_id
  ) into v_je_id;

  select entry_number into v_entry_number from journal_entries where id = v_je_id;
  select balance into v_new_balance from customer_store_credits where id = v_credit.id;

  return jsonb_build_object(
    'status', 'synced',
    'credit_id', v_credit.id,
    'credit_number', v_credit.credit_number,
    'redemption_id', v_redemption_id,
    'journal_entry_id', v_je_id,
    'entry_number', v_entry_number,
    'new_balance', v_new_balance);
end;
$function$

CREATE OR REPLACE FUNCTION public.consume_fifo(p_invoice_item_id uuid, p_product_id uuid, p_warehouse_id uuid, p_quantity numeric, p_unit_cost numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_remaining numeric := p_quantity;
  v_batch record;
  v_consume numeric;
  v_wh uuid;
  v_cogs numeric;
  v_cf numeric;
  v_fallback_base_cost numeric;
  v_avg_base_cost numeric;
  v_strategy text;
  v_allow_oversell boolean;
BEGIN
  -- Quick-sell (non-stock) products never consume batches: there is nothing
  -- to consume, and booking the shortfall as an IOU layer would fabricate
  -- negative phantom stock. The line's manually entered cost is final.
  IF NOT COALESCE((SELECT p.track_inventory FROM products p WHERE p.id = p_product_id), true) THEN
    RETURN;
  END IF;

  -- If warehouse_id is NULL, find default warehouse
  v_wh := COALESCE(p_warehouse_id, (
    SELECT id FROM warehouses WHERE is_default = true AND is_active = true LIMIT 1
  ));

  IF v_wh IS NULL THEN
    RAISE WARNING 'consume_fifo: No warehouse found for product %', p_product_id;
    RETURN;
  END IF;

  -- Check if already consumed (idempotency guard)
  IF EXISTS (SELECT 1 FROM invoice_item_batch_consumption WHERE invoice_item_id = p_invoice_item_id) THEN
    RETURN;
  END IF;

  -- Allocation strategy: 'fefo' consumes earliest-expiry batches first,
  -- 'fifo' (default) consumes oldest stock first. Read from the shared
  -- inventory settings key so POS preview and backend deduction agree.
  SELECT COALESCE(setting_value->>'batch_allocation_method', 'fifo'),
         COALESCE(setting_value->>'allow_oversell', 'true') = 'true'
    INTO v_strategy, v_allow_oversell
   FROM app_settings
  WHERE setting_key = 'inventory';
  v_strategy := COALESCE(v_strategy, 'fifo');
  v_allow_oversell := COALESCE(v_allow_oversell, true);

  -- Effective conversion factor of THIS item (sale units -> base units).
  SELECT CASE
           WHEN COALESCE(ii.quantity, 0) > 0 AND COALESCE(ii.base_quantity, 0) > 0
           THEN ii.base_quantity / ii.quantity
           ELSE 1
         END
    INTO v_cf
   FROM invoice_items ii
  WHERE ii.id = p_invoice_item_id;
  v_cf := COALESCE(NULLIF(v_cf, 0), 1);

  FOR v_batch IN
    SELECT id, quantity_remaining, unit_cost
      FROM inventory_batches
     WHERE product_id = p_product_id
       AND warehouse_id = v_wh
       AND quantity_remaining > 0
       AND (expiry_date IS NULL OR expiry_date >= CURRENT_DATE /* B5: expiry decision stays on the wall clock for now */)
     ORDER BY
       CASE WHEN v_strategy = 'fefo' THEN expiry_date END ASC NULLS LAST,
       created_at ASC,
       id ASC
  LOOP
    EXIT WHEN v_remaining <= 0;

    v_consume := LEAST(v_remaining, v_batch.quantity_remaining);
    v_cogs := v_consume * v_batch.unit_cost;

    UPDATE inventory_batches
       SET quantity_remaining = quantity_remaining - v_consume
     WHERE id = v_batch.id;

    INSERT INTO invoice_item_batch_consumption (
      invoice_item_id, batch_id, product_id, warehouse_id,
      quantity_consumed, unit_cost, cogs_amount
    ) VALUES (
      p_invoice_item_id, v_batch.id, p_product_id, v_wh,
      v_consume, v_batch.unit_cost, v_cogs
    );

    v_remaining := v_remaining - v_consume;
  END LOOP;

  IF v_remaining > 0 THEN
    -- Oversell guard: when disabled, a sale beyond the ledger aborts the
    -- whole invoice insert (the trigger runs inside its transaction) instead
    -- of writing a negative IOU layer.
    IF NOT v_allow_oversell THEN
      RAISE EXCEPTION 'Insufficient stock: sale is short by % base unit(s) for product % in warehouse % (only % in the FIFO ledger). Enable "Allow selling beyond stock" in Settings > Inventory to permit overselling.',
        v_remaining,
        COALESCE((SELECT p.name FROM products p WHERE p.id = p_product_id), p_product_id::text),
        COALESCE((SELECT w.name FROM warehouses w WHERE w.id = v_wh), v_wh::text),
        GREATEST((SELECT COALESCE(SUM(quantity_remaining), 0) FROM inventory_batches
                   WHERE product_id = p_product_id AND warehouse_id = v_wh), 0);
    END IF;

    DECLARE
      v_fallback_id uuid;
    BEGIN
      v_fallback_base_cost := p_unit_cost / v_cf;

      INSERT INTO inventory_batches (
        product_id, warehouse_id, batch_number, quantity_received,
        quantity_remaining, unit_cost, batch_type, notes
      ) VALUES (
        p_product_id, v_wh, 'FIFO-SHORTFALL-' || substr(p_product_id::text, 1, 8),
        0, -v_remaining, v_fallback_base_cost, 'adjustment',
        'consume_fifo shortfall IOU: sold beyond available batches (invoice_item ' || p_invoice_item_id::text || ')'
      ) RETURNING id INTO v_fallback_id;

      INSERT INTO invoice_item_batch_consumption (
        invoice_item_id, batch_id, product_id, warehouse_id,
        quantity_consumed, unit_cost, cogs_amount
      ) VALUES (
        p_invoice_item_id, v_fallback_id, p_product_id, v_wh,
        v_remaining, v_fallback_base_cost, v_remaining * v_fallback_base_cost
      );
    END;
  END IF;

  SELECT SUM(cogs_amount) / NULLIF(SUM(quantity_consumed), 0)
    INTO v_avg_base_cost
    FROM invoice_item_batch_consumption
   WHERE invoice_item_id = p_invoice_item_id;

  UPDATE invoice_items
     SET cost_price = COALESCE(v_avg_base_cost * v_cf, p_unit_cost)
   WHERE id = p_invoice_item_id;
END
$function$

CREATE OR REPLACE FUNCTION public.consume_fifo(p_product_id uuid, p_warehouse_id uuid, p_quantity numeric, p_invoice_item_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_remaining_to_consume numeric := p_quantity;
  v_batch RECORD;
  v_consume_qty numeric;
  v_cogs_total decimal(15,2) := 0;
  v_fallback_cost decimal(15,2);
  v_fallback_batch_id uuid;
BEGIN
  IF p_quantity <= 0 THEN
    RETURN 0;
  END IF;

  FOR v_batch IN
    SELECT id, unit_cost, quantity_remaining
    FROM inventory_batches
    WHERE product_id = p_product_id
      AND warehouse_id = p_warehouse_id
      AND quantity_remaining > 0
    ORDER BY created_at ASC, id ASC
    FOR UPDATE
  LOOP
    EXIT WHEN v_remaining_to_consume <= 0;

    v_consume_qty := LEAST(v_batch.quantity_remaining, v_remaining_to_consume);

    UPDATE inventory_batches
    SET quantity_remaining = quantity_remaining - v_consume_qty
    WHERE id = v_batch.id;

    INSERT INTO invoice_item_batch_consumption (
      invoice_item_id, batch_id, product_id, warehouse_id,
      quantity_consumed, unit_cost, cogs_amount
    ) VALUES (
      p_invoice_item_id, v_batch.id, p_product_id, p_warehouse_id,
      v_consume_qty, v_batch.unit_cost, v_consume_qty * v_batch.unit_cost
    );

    v_cogs_total := v_cogs_total + (v_consume_qty * v_batch.unit_cost);
    v_remaining_to_consume := v_remaining_to_consume - v_consume_qty;
  END LOOP;

  IF v_remaining_to_consume > 0 THEN
    SELECT COALESCE(cost_price, 0) INTO v_fallback_cost
    FROM products WHERE id = p_product_id;

    v_fallback_batch_id := gen_random_uuid();

    INSERT INTO inventory_batches (
      id, product_id, warehouse_id, batch_number,
      quantity_received, quantity_remaining, unit_cost,
      batch_type, reference_type, notes
    ) VALUES (
      v_fallback_batch_id, p_product_id, p_warehouse_id, 'ADJ-' || p_invoice_item_id::text,
      0, -v_remaining_to_consume, v_fallback_cost,
      'adjustment', 'invoice_item', 'Negative adjustment - sold without sufficient stock (FIFO fallback)'
    );

    INSERT INTO invoice_item_batch_consumption (
      invoice_item_id, batch_id, product_id, warehouse_id,
      quantity_consumed, unit_cost, cogs_amount
    ) VALUES (
      p_invoice_item_id, v_fallback_batch_id, p_product_id, p_warehouse_id,
      v_remaining_to_consume, v_fallback_cost, v_remaining_to_consume * v_fallback_cost
    );

    v_cogs_total := v_cogs_total + (v_remaining_to_consume * v_fallback_cost);
  END IF;

  RETURN v_cogs_total;
END;
$function$

CREATE OR REPLACE FUNCTION public.convert_quotation_to_invoice(p_quotation_id uuid, p_options jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_quote quotations%ROWTYPE;
  v_invoice_id uuid;
  v_invoice_number text;
  v_invoice_date date := COALESCE(NULLIF(p_options->>'invoice_date', '')::date, op_date());
  v_payment_type text := COALESCE(NULLIF(p_options->>'payment_type', ''), 'credit');
  v_payment_method text := COALESCE(NULLIF(p_options->>'payment_method', ''), 'cash');
  v_amount_paid numeric;
  v_invoice_status text;
  v_pay_num text;
  v_item RECORD;
  v_cf numeric;
  v_cost numeric;
  v_shortfall_notes jsonb := COALESCE(p_options->'shortfall_notes', '{}'::jsonb);
  v_items_count int := 0;
BEGIN
  IF v_payment_type NOT IN ('credit', 'partial', 'full') THEN
    RAISE EXCEPTION 'Invalid payment type "%" (expected credit, partial or full)', v_payment_type;
  END IF;

  -- Lock the quotation so two tabs cannot double-convert concurrently.
  SELECT * INTO v_quote FROM quotations WHERE id = p_quotation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quotation not found';
  END IF;
  IF v_quote.status = 'converted' THEN
    RAISE EXCEPTION 'Quotation % is already converted', v_quote.quote_number;
  END IF;

  SELECT count(*) INTO v_items_count FROM quotation_items WHERE quotation_id = p_quotation_id;
  IF v_items_count = 0 THEN
    RAISE EXCEPTION 'Quotation % has no items to convert', v_quote.quote_number;
  END IF;

  -- Payment amount and resulting invoice status (same rules the modal had).
  v_amount_paid := CASE v_payment_type
    WHEN 'full'   THEN v_quote.total_amount
    WHEN 'credit' THEN 0
    ELSE COALESCE(NULLIF(p_options->>'amount_paid', '')::numeric, 0)
  END;
  IF v_payment_type = 'partial'
     AND (v_amount_paid <= 0 OR v_amount_paid >= v_quote.total_amount) THEN
    RAISE EXCEPTION 'Partial payment amount must be greater than 0 and less than the total amount (%)', v_quote.total_amount;
  END IF;
  v_invoice_status := CASE
    WHEN v_payment_type = 'full' THEN 'paid'
    WHEN v_payment_type = 'partial' AND v_amount_paid > 0 THEN 'partially_paid'
    WHEN v_payment_type = 'credit' THEN 'sent'
    ELSE 'draft'
  END;

  v_invoice_number := 'INV-' || LPAD(nextval('invoice_seq')::TEXT, 6, '0');

  INSERT INTO invoices (
    invoice_number, customer_id, quotation_id, invoice_date,
    subtotal, discount_amount, tax_amount, shipping_cost, total_amount, amount_paid,
    status, is_pos, reference
  ) VALUES (
    v_invoice_number, v_quote.customer_id, p_quotation_id, v_invoice_date,
    v_quote.subtotal, v_quote.discount_amount, v_quote.tax_amount, COALESCE(v_quote.shipping_cost, 0), v_quote.total_amount, v_amount_paid,
    v_invoice_status, false, v_quote.reference
  ) RETURNING id INTO v_invoice_id;

  -- Items go through the normal triggers (scale guard, consume_fifo, COGS
  -- journal). Cost is derived per item on the SALE-unit scale:
  -- product_units.cost_price is already per that unit; products.cost_price
  -- is per BASE unit and must be scaled by the item's own conversion factor
  -- (unit_conversion_factor, falling back to base_quantity / quantity for
  -- legacy rows that never stored one).
  FOR v_item IN
    SELECT qi.*,
           p.name AS p_name,
           p.cost_price AS p_cost,
           pu.cost_price AS pu_cost
      FROM quotation_items qi
      JOIN products p ON p.id = qi.product_id
      LEFT JOIN product_units pu
             ON pu.product_id = qi.product_id
            AND pu.is_sale_unit
            AND pu.unit_name = qi.unit_name
     WHERE qi.quotation_id = p_quotation_id
     ORDER BY qi.sort_order NULLS LAST, qi.id
  LOOP
    v_cf := COALESCE(
      NULLIF(v_item.unit_conversion_factor, 0),
      CASE WHEN COALESCE(v_item.quantity, 0) > 0 THEN v_item.base_quantity / v_item.quantity END,
      1);
    v_cost := COALESCE(
      NULLIF(v_item.pu_cost, 0),
      NULLIF(v_item.p_cost, 0) * v_cf,
      0);

    INSERT INTO invoice_items (
      invoice_id, product_id, quantity, unit_price, cost_price,
      discount_percent, tax_rate, subtotal,
      unit_name, unit_conversion_factor, base_quantity, warehouse_id, description
    ) VALUES (
      v_invoice_id, v_item.product_id, v_item.quantity, v_item.unit_price, v_cost,
      COALESCE(v_item.discount_percent, 0), COALESCE(v_item.tax_rate, 0), v_item.subtotal,
      v_item.unit_name, v_item.unit_conversion_factor, COALESCE(v_item.base_quantity, v_item.quantity),
      v_item.warehouse_id,
      v_shortfall_notes ->> (v_item.product_id::text)
    );

    INSERT INTO cost_price_history (
      product_id, product_name, product_sku, invoice_id,
      unit, quantity, unit_price,
      cost_price_per_qty, cost_price_for_added_qty,
      total_cost_price_single, total_cost_price_added
    ) VALUES (
      v_item.product_id, v_item.p_name, '', v_invoice_id,
      COALESCE(v_item.unit_name, 'pcs'), v_item.quantity, v_item.unit_price,
      v_cost, v_cost * v_item.quantity,
      v_cost, v_cost * v_item.quantity
    );
  END LOOP;

  IF v_amount_paid > 0 THEN
    SELECT 'PAY-' || LPAD((COALESCE(MAX(CAST(SUBSTRING(payment_number FROM 5) AS INTEGER)), 0) + 1)::TEXT, 6, '0')
      INTO v_pay_num
      FROM payments WHERE payment_number LIKE 'PAY-%';

    INSERT INTO payments (
      payment_number, payment_type, reference_type, reference_id, customer_id,
      amount, payment_method, payment_date, reference_number, notes, payment_for
    ) VALUES (
      v_pay_num, 'received', 'invoice', v_invoice_id, v_quote.customer_id,
      v_amount_paid, v_payment_method, v_invoice_date,
      NULLIF(p_options->>'reference_number', ''),
      COALESCE(NULLIF(p_options->>'notes', ''),
               CASE WHEN v_payment_type = 'full'
                    THEN 'Full payment at invoice conversion'
                    ELSE 'Partial payment at invoice conversion' END),
      'paid_invoice_pay'
    );
  END IF;

  UPDATE quotations
     SET status = 'converted',
         converted_to = v_invoice_id,
         updated_at = op_at()
   WHERE id = p_quotation_id;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_id', v_invoice_id,
    'invoice_number', v_invoice_number,
    'invoice_status', v_invoice_status,
    'amount_paid', v_amount_paid
  );
END $function$

CREATE OR REPLACE FUNCTION public.create_opening_batch(p_product_id uuid, p_warehouse_id uuid, p_quantity numeric, p_unit_cost numeric, p_batch_type text DEFAULT 'opening'::text, p_reference_type text DEFAULT 'product_creation'::text, p_reference_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text, p_tenant_id uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_batch_id uuid;
  v_amount numeric := ROUND(p_quantity * p_unit_cost, 2);
  v_account_1200 uuid;
  v_account_3900 uuid;
  v_batch_number text;
  v_credit_account_id uuid;
  v_credit_desc text;
  v_product_name text;
  v_product_sku text;
  v_warehouse_name text;
  v_header text;
  v_owed numeric;
  v_absorbed numeric;
  v_absorb_left numeric;
  v_take numeric;
  v_iou record;
  v_net_qty numeric;
  v_ledger_sum numeric;
BEGIN
  -- Lookup product + warehouse for human-readable journal descriptions
  SELECT name, sku INTO v_product_name, v_product_sku
    FROM products WHERE id = p_product_id;
  SELECT name INTO v_warehouse_name FROM warehouses WHERE id = p_warehouse_id;

  v_product_name := COALESCE(v_product_name, 'Unknown Product');
  v_product_sku := COALESCE(v_product_sku, 'N/A');
  v_warehouse_name := COALESCE(v_warehouse_name, 'Unknown Warehouse');

  -- 1. Generate a batch number for traceability
  v_batch_number := UPPER(COALESCE(p_batch_type, 'OPENING')) || '-' ||
                    to_char(op_date(), 'YYYYMMDD') || '-' ||
                    substring(p_product_id::text, 1, 8);

  -- 2. Absorb oversell IOU layers (negative batches) before posting. The
  --    oldest IOU is covered first, exactly like receive_grn, so a receipt
  --    can never pay the same debt twice.
  v_net_qty := p_quantity;
  IF p_quantity > 0 THEN
    SELECT COALESCE(-SUM(quantity_remaining), 0) INTO v_owed
      FROM inventory_batches
     WHERE product_id = p_product_id AND warehouse_id = p_warehouse_id
       AND quantity_remaining < 0;
    v_absorbed := LEAST(v_owed, p_quantity);
    v_net_qty := p_quantity - v_absorbed;
    IF v_absorbed > 0 THEN
      v_absorb_left := v_absorbed;
      FOR v_iou IN
        SELECT id, quantity_remaining
          FROM inventory_batches
         WHERE product_id = p_product_id AND warehouse_id = p_warehouse_id
           AND quantity_remaining < 0
         ORDER BY created_at ASC, id ASC
         FOR UPDATE
      LOOP
        EXIT WHEN v_absorb_left <= 0;
        v_take := LEAST(-v_iou.quantity_remaining, v_absorb_left);
        UPDATE inventory_batches
           SET quantity_remaining = quantity_remaining + v_take
         WHERE id = v_iou.id;
        v_absorb_left := v_absorb_left - v_take;
      END LOOP;
    END IF;
  END IF;

  -- 3. Insert the inventory batch at the NET quantity (what the frontend
  --    expects back as the batch id).
  INSERT INTO inventory_batches (
    tenant_id, product_id, warehouse_id, batch_number,
    quantity_received, quantity_remaining, unit_cost,
    batch_type, reference_type, reference_id, notes, created_at
  ) VALUES (
    p_tenant_id, p_product_id, p_warehouse_id, v_batch_number,
    v_net_qty, v_net_qty, p_unit_cost,
    p_batch_type, p_reference_type, p_reference_id, p_notes, op_date()
  ) RETURNING id INTO v_batch_id;

  -- 4. On-hand counter: resync from the batch ledger (source of truth),
  --    same as receive_grn. The caller's blind counter write (user-typed
  --    target) is replaced by ledger truth — with healing, the first units
  --    of an adjustment cover the hidden IOU debt the floored counter
  --    never showed.
  SELECT COALESCE(SUM(quantity_remaining), 0) INTO v_ledger_sum
    FROM inventory_batches
   WHERE product_id = p_product_id AND warehouse_id = p_warehouse_id;

  UPDATE inventory_items
     SET quantity_on_hand = v_ledger_sum, updated_at = op_at()
   WHERE product_id = p_product_id AND warehouse_id = p_warehouse_id;
  IF NOT FOUND THEN
    INSERT INTO inventory_items (tenant_id, product_id, warehouse_id, quantity_on_hand)
    VALUES (p_tenant_id, p_product_id, p_warehouse_id, v_ledger_sum);
  END IF;

  -- 5. Post journal entry: Dr 1200 / Cr 3900 for BOTH opening and
  --    adjustment batches. Quantity corrections are equity, not P&L
  --    variance (owner decision 2026-09-07); account 5900 is legacy with
  --    no writers since this migration. Amount stays on the paper
  --    quantity — the absorbed IOU value is part of that correction.
  IF v_amount > 0 THEN
    SELECT id INTO v_account_1200 FROM accounts
      WHERE code = '1200' AND tenant_id = p_tenant_id;

    IF v_account_1200 IS NULL THEN
      RAISE WARNING 'Account 1200 missing for tenant %; batch % created without GL entry',
        p_tenant_id, v_batch_id;
      RETURN v_batch_id;
    END IF;

    SELECT id INTO v_account_3900 FROM accounts
      WHERE code = '3900' AND tenant_id = p_tenant_id;
    IF v_account_3900 IS NULL THEN
      RAISE WARNING 'Account 3900 missing for tenant %; batch % created without GL entry',
        p_tenant_id, v_batch_id;
      RETURN v_batch_id;
    END IF;
    v_credit_account_id := v_account_3900;

    IF p_batch_type = 'opening' THEN
      v_credit_desc := 'Opening balance equity offset';
      v_header := 'Opening stock';
    ELSE
      v_credit_desc := 'Opening Balance Equity (quantity correction)';
      v_header := 'Stock adjustment';
    END IF;

    -- Human-readable description: "Stock adjustment - test20 (test-0020): 5 @ 2.00 in Main Warehouse"
    v_header := v_header || ' - ' || v_product_name || ' (' || v_product_sku || '): '
      || p_quantity || ' @ ' || p_unit_cost || ' in ' || v_warehouse_name;

    PERFORM post_journal_entry(
      p_description := v_header,
      p_entry_date := op_date(),
      p_reference_type := p_reference_type,
      p_reference_id := p_reference_id,
      p_lines := json_build_array(
        json_build_object(
          'account_id', v_account_1200,
          'debit', v_amount,
          'description', 'Inventory received: ' || v_product_name || ' (' || v_product_sku || ') in ' || v_warehouse_name
        ),
        json_build_object(
          'account_id', v_credit_account_id,
          'credit', v_amount,
          'description', v_credit_desc
        )
      )
    );
  END IF;

  RETURN v_batch_id;
END;
$function$

CREATE OR REPLACE FUNCTION public.create_stock_reduction(p_product_id uuid, p_warehouse_id uuid, p_quantity numeric, p_unit_cost numeric, p_reference_type text DEFAULT 'stock_adjustment'::text, p_reference_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT 'Stock decrease adjustment'::text, p_tenant_id uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid, p_debit_account_code text DEFAULT '3900'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_remaining_qty numeric := p_quantity;
  v_reduce_qty numeric;
  v_batch_cost numeric;
  v_consumed_value numeric := 0;
  v_batch_id uuid;
  v_audit_batch_id uuid;
  -- journal amount is finalized after consumption: the real layer value
  -- consumed plus any shortfall at the passed cost (batch-accurate GL).
  v_amount numeric := 0;
  v_account_1200 uuid;
  v_debit_account uuid;
  v_product_name text;
  v_product_sku text;
  v_warehouse_name text;
  v_header text;
BEGIN
  IF p_quantity <= 0 THEN
    RETURN NULL;
  END IF;

  -- Lookup product + warehouse for human-readable journal descriptions
  SELECT name, sku INTO v_product_name, v_product_sku
    FROM products WHERE id = p_product_id;
  SELECT name INTO v_warehouse_name FROM warehouses WHERE id = p_warehouse_id;

  v_product_name := COALESCE(v_product_name, 'Unknown Product');
  v_product_sku := COALESCE(v_product_sku, 'N/A');
  v_warehouse_name := COALESCE(v_warehouse_name, 'Unknown Warehouse');

  -- 1. Reduce quantity_remaining from oldest batches first (FIFO)
  v_consumed_value := 0;
  FOR v_batch_id, v_batch_cost IN
    SELECT ib.id, ib.unit_cost
    FROM inventory_batches ib
    WHERE ib.product_id = p_product_id
      AND ib.warehouse_id = p_warehouse_id
      AND ib.quantity_remaining > 0
    ORDER BY ib.created_at ASC, ib.id ASC
    FOR UPDATE
  LOOP
    EXIT WHEN v_remaining_qty <= 0;

    -- Only consume what this batch actually holds (and never more than remaining)
    SELECT LEAST(quantity_remaining, v_remaining_qty)
      INTO v_reduce_qty
      FROM inventory_batches WHERE id = v_batch_id;

    UPDATE inventory_batches
    SET quantity_remaining = quantity_remaining - v_reduce_qty
    WHERE id = v_batch_id;

    v_consumed_value := v_consumed_value + (v_reduce_qty * v_batch_cost);
    v_remaining_qty := v_remaining_qty - v_reduce_qty;
  END LOOP;

  -- 2. Insert a reduction batch ONLY for the shortfall the real layers could
  --    not cover (an over-reduction IOU). A fully-covered reduction is already
  --    recorded by the layer consumption + stock movement + journal entry —
  --    adding a full-qty audit row here double-subtracted the batch ledger
  --    against the GL whenever real stock was consumed (bug fixed 2026-09-01).
  IF v_remaining_qty > 0 THEN
    INSERT INTO inventory_batches (
      tenant_id, product_id, warehouse_id, batch_number,
      quantity_received, quantity_remaining, unit_cost,
      batch_type, reference_type, reference_id, notes, created_at
    ) VALUES (
      p_tenant_id, p_product_id, p_warehouse_id,
      'REDUCE-' || to_char(op_date(), 'YYYYMMDD') || '-' || substring(p_product_id::text, 1, 8),
      0, -v_remaining_qty, p_unit_cost,
      'adjustment', p_reference_type, p_reference_id, p_notes, op_date()
    ) RETURNING id INTO v_audit_batch_id;
  END IF;

  -- 3. Post journal entry at the value actually consumed (layer costs), plus
  --    any uncovered shortfall at the passed cost. The debit account is the
  --    caller's choice: 3900 for quantity corrections (owner decision
  --    2026-09-07), 5900 Inventory Adjustment for genuine losses such as a
  --    write-off.
  v_amount := ROUND(v_consumed_value + (v_remaining_qty * p_unit_cost), 2);
  IF v_amount > 0 THEN
    SELECT id INTO v_account_1200 FROM accounts
      WHERE code = '1200' AND tenant_id = p_tenant_id;
    SELECT id INTO v_debit_account FROM accounts
      WHERE code = p_debit_account_code AND tenant_id = p_tenant_id;

    IF v_account_1200 IS NOT NULL AND v_debit_account IS NOT NULL THEN
      v_header := 'Stock reduction - ' || v_product_name || ' (' || v_product_sku || '): '
        || p_quantity || ' @ ' || p_unit_cost || ' in ' || v_warehouse_name;

      PERFORM post_journal_entry(
        p_description := v_header,
        p_entry_date := op_date(),
        p_reference_type := p_reference_type,
        p_reference_id := p_reference_id,
        p_lines := json_build_array(
          json_build_object(
            'account_id', v_debit_account,
            'debit', v_amount,
            'description', 'Inventory reduction: ' || v_product_name || ' (' || v_product_sku || ') in ' || v_warehouse_name
          ),
          json_build_object(
            'account_id', v_account_1200,
            'credit', v_amount,
            'description', 'Inventory released (FIFO layers depleted): ' || v_product_name
          )
        )
      );
    ELSE
      RAISE WARNING 'Accounts 1200 or % missing for tenant %; batch % created without GL entry',
        p_debit_account_code, p_tenant_id, v_audit_batch_id;
    END IF;
  END IF;

  PERFORM heal_negative_batches_and_resync(p_product_id, p_warehouse_id);

  RETURN v_audit_batch_id;
END;
$function$

CREATE OR REPLACE FUNCTION public.deduct_stock_on_invoice_item()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_invoice_record RECORD;
  v_target_wh uuid;
  v_qty_to_deduct numeric;
  v_inv_id uuid;
  v_current_qty numeric;
  v_product_cost numeric;
  v_ledger_sum numeric;
  v_oversold numeric;
  v_oversold_text text;
BEGIN
  -- Quick-sell (non-stock) products carry no inventory counter and no stock
  -- movement; nothing to deduct.
  IF NOT COALESCE((SELECT p.track_inventory FROM products p WHERE p.id = NEW.product_id), true) THEN
    RETURN NEW;
  END IF;

  -- Get the invoice record
  SELECT * INTO v_invoice_record FROM invoices WHERE id = NEW.invoice_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- Skip if invoice is cancelled
  IF v_invoice_record.status = 'cancelled' THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM stock_movements
    WHERE reference_id = NEW.invoice_id
      AND reference_type = 'invoice'
      AND product_id = NEW.product_id
      AND movement_type = 'sale'
      AND notes LIKE '%invoice_item:' || NEW.id::text || '%'
  ) THEN
    RETURN NEW;
  END IF;

  v_qty_to_deduct := COALESCE(NEW.base_quantity, NEW.quantity);

  v_target_wh := NEW.warehouse_id;

  IF v_target_wh IS NULL THEN
    SELECT id INTO v_target_wh FROM warehouses WHERE is_default = true AND is_active = true LIMIT 1;
    IF v_target_wh IS NULL THEN
      SELECT id INTO v_target_wh FROM warehouses WHERE is_active = true LIMIT 1;
    END IF;
  END IF;

  IF v_target_wh IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT id, quantity_on_hand INTO v_inv_id, v_current_qty
  FROM inventory_items
  WHERE product_id = NEW.product_id AND warehouse_id = v_target_wh
  FOR UPDATE;

  -- This trigger runs before consume_fifo creates this sale's consumption
  -- rows (and any IOU batch), so the ledger sum here is the pre-sale truth.
  -- The counter is resynced to ledger_sum - qty rather than decremented
  -- blindly: the ledger is the source of truth and legacy drift heals here.
  SELECT COALESCE(SUM(quantity_remaining), 0) INTO v_ledger_sum
    FROM inventory_batches
   WHERE product_id = NEW.product_id AND warehouse_id = v_target_wh;

  IF v_inv_id IS NOT NULL THEN
    UPDATE inventory_items
    SET quantity_on_hand = v_ledger_sum - v_qty_to_deduct,
        updated_at = op_at()
    WHERE id = v_inv_id;
  ELSE
    INSERT INTO inventory_items (product_id, warehouse_id, quantity_on_hand, quantity_reserved, quantity_incoming)
    VALUES (NEW.product_id, v_target_wh, v_ledger_sum - v_qty_to_deduct, 0, 0);
  END IF;

  SELECT cost_price INTO v_product_cost FROM products WHERE id = NEW.product_id;

  v_oversold_text := NULL;
  v_oversold := v_qty_to_deduct - v_ledger_sum;
  IF v_oversold > 0 THEN
    v_oversold_text := CASE WHEN v_oversold = FLOOR(v_oversold)
                            THEN FLOOR(v_oversold)::bigint::text
                            ELSE v_oversold::text END;
  END IF;

  INSERT INTO stock_movements (
    product_id, warehouse_id, movement_type, quantity,
    unit_cost, reference_type, reference_id, reference_number, notes
  ) VALUES (
    NEW.product_id, v_target_wh, 'sale', -v_qty_to_deduct,
    COALESCE(v_product_cost, 0), 'invoice', NEW.invoice_id,
    v_invoice_record.invoice_number,
    'Stock deduction for sale - invoice_item:' || NEW.id::text
      || COALESCE(' — OVERSOLD by ' || v_oversold_text || ' base unit(s) beyond stock (IOU created)', '')
  );

  RETURN NEW;
END;
$function$

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
  v_new_date := COALESCE((p_new_data->>'invoice_date')::date, op_date());
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
      UPDATE inventory_items SET quantity_on_hand = quantity_on_hand + v_qty, updated_at = op_at()
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
      'REVERSAL - AR - Invoice ' || v_invoice.invoice_number || ' EDIT', COALESCE(v_invoice.invoice_date, op_date()), 'invoice_edit', p_invoice_id,
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
           updated_at = op_at()
     WHERE ca.id = v_app.advance_id;

    IF v_ar_account IS NOT NULL AND v_adv_account IS NOT NULL AND COALESCE(v_app.amount, 0) > 0 THEN
      PERFORM post_journal_entry(
        'Reverse advance application - ' || v_invoice.invoice_number,
        COALESCE(v_invoice.invoice_date, op_date()),
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
    VALUES ('REV-' || COALESCE(v_payment.payment_number, 'PAY'), CASE WHEN v_payment.payment_type = 'received' THEN 'refund' ELSE 'payment' END, v_payment.payment_method, v_payment.amount, op_date(), 'invoice_edit', p_invoice_id, v_invoice.invoice_number, 'Reversal payment for edited invoice ' || v_invoice.invoice_number, 'reversal_payment', COALESCE(v_payment.customer_id, v_invoice.customer_id));
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
      status = 'draft', edit_count = COALESCE(edit_count, 0) + 1, updated_at = op_at()
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
        edited_at = op_at(),
        edit_note = COALESCE(p_reason, 'Invoice ' || v_invoice.invoice_number || ' was edited'),
        updated_at = op_at()
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
          COALESCE(v_new_date, op_date()),
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
            COALESCE(v_new_date, op_date()),
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
    UPDATE customers SET outstanding_balance = (SELECT COALESCE(SUM(balance_due), 0) FROM invoices WHERE customer_id = v_invoice.customer_id AND status IN ('sent', 'partially_paid', 'unpaid', 'overdue')), updated_at = op_at() WHERE id = v_invoice.customer_id;
  END IF;
  IF v_new_customer IS NOT NULL AND v_new_customer <> v_invoice.customer_id THEN
    UPDATE customers SET outstanding_balance = (SELECT COALESCE(SUM(balance_due), 0) FROM invoices WHERE customer_id = v_new_customer AND status IN ('sent', 'partially_paid', 'unpaid', 'overdue')), updated_at = op_at() WHERE id = v_new_customer;
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
$function$

CREATE OR REPLACE FUNCTION public.heal_negative_batches_and_resync(p_product_id uuid, p_warehouse_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_owed       numeric;
  v_absorbed   numeric := 0;
  v_take       numeric;
  v_batch      RECORD;
  v_ledger_sum numeric;
BEGIN
  IF p_product_id IS NULL OR p_warehouse_id IS NULL THEN
    RETURN;
  END IF;

  SELECT -COALESCE(SUM(quantity_remaining), 0) INTO v_owed
    FROM inventory_batches
   WHERE product_id = p_product_id
     AND warehouse_id = p_warehouse_id
     AND quantity_remaining < 0;

  IF v_owed > 0 THEN
    FOR v_batch IN
      SELECT id, quantity_remaining
        FROM inventory_batches
       WHERE product_id = p_product_id
         AND warehouse_id = p_warehouse_id
         AND quantity_remaining > 0
       ORDER BY created_at DESC, id DESC
       FOR UPDATE
    LOOP
      EXIT WHEN v_owed <= 0;
      v_take := LEAST(v_batch.quantity_remaining, v_owed);
      UPDATE inventory_batches
         SET quantity_remaining = quantity_remaining - v_take
       WHERE id = v_batch.id;
      v_owed := v_owed - v_take;
      v_absorbed := v_absorbed + v_take;
    END LOOP;

    FOR v_batch IN
      SELECT id, quantity_remaining
        FROM inventory_batches
       WHERE product_id = p_product_id
         AND warehouse_id = p_warehouse_id
         AND quantity_remaining < 0
       ORDER BY created_at ASC, id ASC
       FOR UPDATE
    LOOP
      EXIT WHEN v_absorbed <= 0;
      v_take := LEAST(-v_batch.quantity_remaining, v_absorbed);
      UPDATE inventory_batches
         SET quantity_remaining = quantity_remaining + v_take
       WHERE id = v_batch.id;
      v_absorbed := v_absorbed - v_take;
    END LOOP;
  END IF;

  SELECT COALESCE(SUM(quantity_remaining), 0) INTO v_ledger_sum
    FROM inventory_batches
   WHERE product_id = p_product_id
     AND warehouse_id = p_warehouse_id;

  UPDATE inventory_items
     SET quantity_on_hand = v_ledger_sum, updated_at = op_at()
   WHERE product_id = p_product_id
     AND warehouse_id = p_warehouse_id;
END;
$function$

CREATE OR REPLACE FUNCTION public.invoice_accounting_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
v_ar_account uuid;
v_revenue_account uuid;
v_vat_account uuid;
v_shipping_account uuid;
v_entry_id uuid;
v_total numeric;
v_vat numeric;
v_shipping numeric;
v_should_post boolean := false;
v_lines json;
BEGIN
-- Get account IDs
SELECT id INTO v_ar_account FROM accounts WHERE code = '1100' LIMIT 1;
SELECT id INTO v_revenue_account FROM accounts WHERE code = '4000' LIMIT 1;
SELECT id INTO v_vat_account FROM accounts WHERE code = '2100' LIMIT 1;
SELECT id INTO v_shipping_account FROM accounts WHERE code = '4020' LIMIT 1;

IF v_ar_account IS NULL OR v_revenue_account IS NULL THEN
RETURN NEW;
END IF;

v_total := COALESCE(NEW.total_amount, 0);
v_vat := LEAST(COALESCE(NEW.tax_amount, 0), v_total);
-- Shipping splits out of revenue like VAT, clamped so the goods-revenue
-- credit can never go negative.
v_shipping := LEAST(COALESCE(NEW.shipping_cost, 0), GREATEST(0, v_total - v_vat));
IF v_total <= 0 THEN
RETURN NEW;
END IF;

IF v_vat > 0 AND v_vat_account IS NULL THEN
RAISE EXCEPTION 'Invoice % carries VAT (%) but VAT Payable account (2100) is missing', NEW.invoice_number, v_vat;
END IF;
IF v_shipping > 0 AND v_shipping_account IS NULL THEN
RAISE EXCEPTION 'Invoice % carries shipping (%) but Shipping Income account (4020) is missing', NEW.invoice_number, v_shipping;
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

-- Post: Debit AR (gross), Credit Sales Revenue (goods), Credit VAT Payable,
-- Credit Shipping Income. Zero legs are omitted (vat=0 and shipping=0 posts
-- exactly the two lines the pre-shipping version posted).
v_lines := to_json(ARRAY[]::json[]);
v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
'account_id', v_ar_account, 'debit', v_total, 'credit', 0, 'description', 'AR for invoice ' || NEW.invoice_number
)))::json);
v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
'account_id', v_revenue_account, 'debit', 0, 'credit', v_total - v_vat - v_shipping, 'description',
CASE WHEN v_vat > 0 OR v_shipping > 0
THEN 'Sales revenue (net of VAT and shipping) for invoice ' || NEW.invoice_number
ELSE 'Sales revenue for invoice ' || NEW.invoice_number END
)))::json);
IF v_vat > 0 THEN
v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
'account_id', v_vat_account, 'debit', 0, 'credit', v_vat, 'description', 'VAT payable for invoice ' || NEW.invoice_number
)))::json);
END IF;
IF v_shipping > 0 THEN
v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
'account_id', v_shipping_account, 'debit', 0, 'credit', v_shipping, 'description', 'Shipping income for invoice ' || NEW.invoice_number
)))::json);
END IF;

v_entry_id := post_journal_entry(
'Accounts Receivable - Invoice ' || NEW.invoice_number,
COALESCE(NEW.invoice_date, op_date()),
'invoice',
NEW.id,
v_lines,
NEW.customer_id
);

RETURN NEW;
END;
$function$

CREATE OR REPLACE FUNCTION public.invoice_status_cogs_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_cogs uuid;
  v_inv uuid;
  v_item RECORD;
  v_wh uuid;
  v_qty numeric;
  v_amt decimal(15,2);
  v_total_cogs decimal(15,2) := 0;
  v_cogs_desc text;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'draft' AND NEW.status IN ('sent', 'partially_paid', 'paid') THEN
    SELECT id INTO v_cogs FROM accounts WHERE code = '5000' LIMIT 1;
    SELECT id INTO v_inv FROM accounts WHERE code = '1200' LIMIT 1;
    IF v_cogs IS NULL OR v_inv IS NULL THEN RETURN NEW; END IF;

    v_wh := COALESCE(NEW.warehouse_id, (SELECT id FROM warehouses WHERE is_default = true AND is_active = true LIMIT 1));

    FOR v_item IN SELECT * FROM invoice_items WHERE invoice_id = NEW.id ORDER BY sort_order LOOP
      -- FIFO consumption is denominated in BASE units
      v_qty := COALESCE(v_item.base_quantity, v_item.quantity);
      IF v_qty <= 0 THEN CONTINUE; END IF;

      PERFORM 1 FROM invoice_item_batch_consumption WHERE invoice_item_id = v_item.id;
      IF FOUND THEN
        SELECT COALESCE(SUM(cogs_amount), 0) INTO v_amt
        FROM invoice_item_batch_consumption WHERE invoice_item_id = v_item.id;
        IF v_amt > 0 THEN
          v_total_cogs := v_total_cogs + v_amt;
        END IF;
        CONTINUE;
      END IF;

      -- Non-stock items: consume_fifo returns immediately (no consumption
      -- rows, no cost overwrite) and the amount below reads 0, so the loop
      -- naturally skips them into the Quick Sell Cost JE posted after it.
      PERFORM consume_fifo(v_item.id, v_item.product_id, COALESCE(v_item.warehouse_id, v_wh), v_qty, COALESCE(v_item.cost_price, 0));
      SELECT COALESCE(SUM(cogs_amount), 0) INTO v_amt FROM invoice_item_batch_consumption WHERE invoice_item_id = v_item.id;
      IF v_amt > 0 THEN
        v_total_cogs := v_total_cogs + v_amt;
      END IF;
    END LOOP;

    IF v_total_cogs > 0 THEN
      v_cogs_desc := 'COGS - ' || NEW.invoice_number || ' (' ||
        (SELECT count(*) FROM invoice_items WHERE invoice_id = NEW.id) || ' items, total: ' || v_total_cogs || ')';

      PERFORM 1 FROM journal_entries
      WHERE reference_type = 'invoice' AND reference_id = NEW.id AND description LIKE 'COGS%';
      IF NOT FOUND THEN
        PERFORM post_journal_entry(v_cogs_desc, COALESCE(NEW.invoice_date, op_date()), 'invoice', NEW.id,
          json_build_array(
            json_build_object('account_id', v_cogs, 'debit', v_total_cogs, 'credit', 0, 'description', 'COGS (FIFO)'),
            json_build_object('account_id', v_inv, 'debit', 0, 'credit', v_total_cogs, 'description', 'Inventory released (FIFO)')
          )::json, NEW.customer_id);
      END IF;
    END IF;

    -- Quick-sell cost leg (no-op when the invoice has no non-stock items;
    -- idempotent when edit_invoice STEP 7b already posted it).
    PERFORM post_quick_sell_cost_je(NEW.id);
  END IF;
  RETURN NEW;
END
$function$

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
        COALESCE(NEW.payment_date, op_date()),
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
        COALESCE(NEW.payment_date, op_date()),
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
        COALESCE(NEW.payment_date, op_date()),
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
        COALESCE(NEW.payment_date, op_date()),
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
$function$

CREATE OR REPLACE FUNCTION public.payment_po_amount_paid_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
          updated_at = op_at()
      WHERE id = NEW.reference_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$

CREATE OR REPLACE FUNCTION public.post_cogs_je_from_item_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_invoice RECORD;
  v_cogs_account uuid;
  v_inventory_account uuid;
  v_total_cogs decimal(15,2) := 0;
  v_lines json[] := '{}';
  v_line_count int := 0;
  v_item RECORD;
  v_product RECORD;
  v_cogs_amount decimal(15,2);
  v_qty numeric;
  v_desc text;
  v_existing_je_id uuid;
  v_old_cogs_net numeric;
  v_old_inv_net numeric;
  v_new_cogs_net numeric;
  v_new_inv_net numeric;
BEGIN
  -- Only fire on INSERT
  IF TG_OP != 'INSERT' THEN
    RETURN NEW;
  END IF;

  -- Get the parent invoice
  SELECT * INTO v_invoice FROM invoices WHERE id = NEW.invoice_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  -- Only fire when invoice is non-draft (status is sent, partially_paid, or paid)
  IF v_invoice.status NOT IN ('sent', 'partially_paid', 'paid') THEN
    RETURN NEW;
  END IF;

  -- Quick-sell (non-stock) cost leg: Dr 5000 / Cr paid-from account. No-op
  -- when this item (and the invoice) carries no non-stock cost; idempotent
  -- refresh when several items insert in sequence.
  PERFORM post_quick_sell_cost_je(NEW.invoice_id);

  -- Get accounts
  SELECT id INTO v_cogs_account FROM accounts WHERE code = '5000' LIMIT 1;
  SELECT id INTO v_inventory_account FROM accounts WHERE code = '1200' LIMIT 1;
  IF v_cogs_account IS NULL OR v_inventory_account IS NULL THEN
    RETURN NEW;
  END IF;

  -- Check if COGS JE already exists (for UPDATE instead of skip)
  SELECT id INTO v_existing_je_id FROM journal_entries
  WHERE reference_type = 'invoice' AND reference_id = v_invoice.id
  AND description LIKE 'COGS%';

  -- Process ALL items for this invoice
  FOR v_item IN
    SELECT ii.* FROM invoice_items ii
    WHERE ii.invoice_id = NEW.invoice_id
    ORDER BY ii.sort_order
  LOOP
    v_qty := v_item.quantity;
    IF v_qty <= 0 THEN CONTINUE; END IF;

    -- Get COGS from FIFO consumption records
    SELECT COALESCE(SUM(cogs_amount), 0) INTO v_cogs_amount
    FROM invoice_item_batch_consumption
    WHERE invoice_item_id = v_item.id;

    IF v_cogs_amount > 0 THEN
      v_total_cogs := v_total_cogs + v_cogs_amount;
      v_line_count := v_line_count + 1;

      SELECT name, sku INTO v_product FROM products WHERE id = v_item.product_id;

      v_desc := 'COGS (FIFO): ' || COALESCE(v_product.name, 'Unknown') ||
        ' (SKU: ' || COALESCE(v_product.sku, 'N/A') || ') - Qty: ' || v_qty ||
        ' x Avg Cost: ' || round(v_cogs_amount / v_qty, 2) || ' = ' || v_cogs_amount;

      v_lines := array_append(v_lines, json_build_object(
        'account_id', v_cogs_account, 'debit', v_cogs_amount, 'credit', 0,
        'description', v_desc
      ));
      v_lines := array_append(v_lines, json_build_object(
        'account_id', v_inventory_account, 'debit', 0, 'credit', v_cogs_amount,
        'description', 'Inventory released (FIFO): ' || COALESCE(v_product.name, 'Unknown') ||
          ' (Qty: ' || v_qty || ') for ' || v_invoice.invoice_number
      ));
    END IF;
  END LOOP;

  -- Post or UPDATE the aggregated COGS JE
  IF v_total_cogs > 0 THEN
    IF v_existing_je_id IS NOT NULL THEN
      SELECT COALESCE(SUM(debit - credit), 0) INTO v_old_cogs_net
      FROM journal_lines WHERE journal_entry_id = v_existing_je_id AND account_id = v_cogs_account;
      SELECT COALESCE(SUM(debit - credit), 0) INTO v_old_inv_net
      FROM journal_lines WHERE journal_entry_id = v_existing_je_id AND account_id = v_inventory_account;

      DELETE FROM journal_lines WHERE journal_entry_id = v_existing_je_id;

      FOR i IN 1..array_length(v_lines, 1) LOOP
        INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit, description, sort_order)
        VALUES (
          v_existing_je_id,
          (v_lines[i]->>'account_id')::uuid,
          (v_lines[i]->>'debit')::decimal(15,2),
          (v_lines[i]->>'credit')::decimal(15,2),
          v_lines[i]->>'description',
          i
        );
      END LOOP;

      UPDATE journal_entries
      SET description = 'COGS - ' || v_invoice.invoice_number || ' (' || v_line_count || ' items, total: ' || v_total_cogs || ')',
          total_debit = v_total_cogs,
          total_credit = v_total_cogs
      WHERE id = v_existing_je_id;

      SELECT COALESCE(SUM(debit - credit), 0) INTO v_new_cogs_net
      FROM journal_lines WHERE journal_entry_id = v_existing_je_id AND account_id = v_cogs_account;
      SELECT COALESCE(SUM(debit - credit), 0) INTO v_new_inv_net
      FROM journal_lines WHERE journal_entry_id = v_existing_je_id AND account_id = v_inventory_account;

      UPDATE accounts
         SET balance = balance + CASE WHEN account_type IN ('liability','equity','revenue')
                                      THEN -(v_new_cogs_net - v_old_cogs_net)
                                      ELSE  (v_new_cogs_net - v_old_cogs_net) END
       WHERE id = v_cogs_account;

      UPDATE accounts
         SET balance = balance + CASE WHEN account_type IN ('liability','equity','revenue')
                                      THEN -(v_new_inv_net - v_old_inv_net)
                                      ELSE  (v_new_inv_net - v_old_inv_net) END
       WHERE id = v_inventory_account;
    ELSE
      PERFORM post_journal_entry(
        'COGS - ' || v_invoice.invoice_number || ' (' || v_line_count || ' items, total: ' || v_total_cogs || ')',
        COALESCE(v_invoice.invoice_date, op_date()),
        'invoice',
        v_invoice.id,
        to_json(v_lines),
        v_invoice.customer_id
      );
    END IF;
  END IF;

  RETURN NEW;
END
$function$

CREATE OR REPLACE FUNCTION public.post_grn_journal(p_grn_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_grn       goods_receipt_notes%ROWTYPE;
  v_total     numeric(15,2);
  v_inv_acct  uuid;
  v_ap_acct   uuid;
  v_po_number text;
  v_je_id     uuid;
BEGIN
  SELECT * INTO v_grn FROM goods_receipt_notes WHERE id = p_grn_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('posted', false, 'reason', 'GRN not found');
  END IF;

  IF v_grn.status <> 'posted' THEN
    RETURN jsonb_build_object('posted', false, 'reason', 'GRN not posted');
  END IF;

  -- Idempotency: exactly one journal per GRN
  IF EXISTS (SELECT 1 FROM journal_entries
             WHERE reference_type = 'grn' AND reference_id = p_grn_id) THEN
    RETURN jsonb_build_object('posted', false, 'reason', 'journal already exists');
  END IF;

  -- Inventory value received in THIS GRN, from its own FIFO batches —
  -- never from cumulative PO received quantities.
  SELECT COALESCE(SUM(quantity_received * unit_cost), 0)
    INTO v_total
  FROM inventory_batches
  WHERE reference_type = 'grn' AND reference_id = p_grn_id;

  IF v_total <= 0 THEN
    RETURN jsonb_build_object('posted', false, 'reason', 'no inventory batches for this GRN');
  END IF;

  SELECT id INTO v_inv_acct FROM accounts WHERE code = '1200' LIMIT 1;
  SELECT id INTO v_ap_acct   FROM accounts WHERE code = '2000' LIMIT 1;
  IF v_inv_acct IS NULL OR v_ap_acct IS NULL THEN
    RETURN jsonb_build_object('posted', false, 'reason', 'accounts 1200/2000 not found');
  END IF;

  SELECT po_number INTO v_po_number
  FROM purchase_orders WHERE id = v_grn.purchase_order_id;

  v_je_id := post_journal_entry(
    p_description    := 'Goods Received - GRN #' || v_grn.grn_number
                        || COALESCE(' / PO #' || v_po_number, ''),
    p_entry_date     := COALESCE(v_grn.received_date, op_date()),
    p_reference_type := 'grn',
    p_reference_id   := v_grn.id,
    p_lines          := json_build_array(
      json_build_object('account_id', v_inv_acct, 'debit',  v_total,
                        'description', 'Inventory received'),
      json_build_object('account_id', v_ap_acct, 'credit', v_total,
                        'description', 'Accounts Payable - goods received')
    ),
    p_supplier_id    := v_grn.supplier_id
  );

  RETURN jsonb_build_object('posted', true, 'amount', v_total, 'je_id', v_je_id);
END;
$function$

CREATE OR REPLACE FUNCTION public.post_grn_journal(p_grn_id uuid, p_absorbed_value numeric DEFAULT 0, p_absorbed_receipt_value numeric DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_grn       goods_receipt_notes%ROWTYPE;
  v_total     numeric(15,2);
  v_net_value numeric(15,2);
  v_basis_adj numeric(15,2);
  v_inv_acct  uuid;
  v_ap_acct   uuid;
  v_equity_acct uuid;
  v_po_number text;
  v_je_id     uuid;
  v_lines     jsonb;
BEGIN
  SELECT * INTO v_grn FROM goods_receipt_notes WHERE id = p_grn_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('posted', false, 'reason', 'GRN not found');
  END IF;

  IF v_grn.status <> 'posted' THEN
    RETURN jsonb_build_object('posted', false, 'reason', 'GRN not posted');
  END IF;

  -- Idempotency: exactly one journal per GRN
  IF EXISTS (SELECT 1 FROM journal_entries
             WHERE reference_type = 'grn' AND reference_id = p_grn_id) THEN
    RETURN jsonb_build_object('posted', false, 'reason', 'journal already exists');
  END IF;

  -- Gross inventory value received in THIS GRN, from its own FIFO batches —
  -- never from cumulative PO received quantities. For IOU-absorbing receipts
  -- quantity_received is the GROSS physical receipt, so v_total is what the
  -- supplier must actually be paid.
  SELECT COALESCE(SUM(quantity_received * unit_cost), 0)
    INTO v_total
  FROM inventory_batches
  WHERE reference_type = 'grn' AND reference_id = p_grn_id;

  IF v_total <= 0 THEN
    RETURN jsonb_build_object('posted', false, 'reason', 'no inventory batches for this GRN');
  END IF;

  SELECT id INTO v_inv_acct FROM accounts WHERE code = '1200' LIMIT 1;
  SELECT id INTO v_ap_acct   FROM accounts WHERE code = '2000' LIMIT 1;
  IF v_inv_acct IS NULL OR v_ap_acct IS NULL THEN
    RETURN jsonb_build_object('posted', false, 'reason', 'accounts 1200/2000 not found');
  END IF;

  -- Absorbed oversell IOU: the receipt's Dr to Inventory is the LEDGER
  -- valuation gain (net receipt value + IOU reversal at the IOU batches' own
  -- cost), not the gross. The difference between the two cost bases lands on
  -- 3900 (equity — quantity corrections are not P&L), matching how the
  -- oversell itself was posted. With no absorption both adjustments are 0 and
  -- the entry collapses to Dr 1200 G / Cr 2000 G.
  v_net_value := v_total - p_absorbed_receipt_value + p_absorbed_value;
  v_basis_adj := p_absorbed_receipt_value - p_absorbed_value;

  IF ABS(v_basis_adj) > 0.0000001 THEN
    SELECT id INTO v_equity_acct FROM accounts WHERE code = '3900' LIMIT 1;
    IF v_equity_acct IS NULL THEN
      RETURN jsonb_build_object('posted', false, 'reason', 'account 3900 not found');
    END IF;
  END IF;

  v_lines := json_build_array(
    json_build_object('account_id', v_inv_acct, 'debit', v_net_value,
                      'description', 'Inventory received'),
    json_build_object('account_id', v_ap_acct, 'credit', v_total,
                      'description', 'Accounts Payable - goods received')
  );
  IF v_basis_adj > 0 THEN
    v_lines := v_lines || json_build_object('account_id', v_equity_acct, 'debit', v_basis_adj,
                'description', 'IOU absorption cost-basis correction')::jsonb;
  ELSIF v_basis_adj < 0 THEN
    v_lines := v_lines || json_build_object('account_id', v_equity_acct, 'credit', -v_basis_adj,
                'description', 'IOU absorption cost-basis correction')::jsonb;
  END IF;

  SELECT po_number INTO v_po_number
  FROM purchase_orders WHERE id = v_grn.purchase_order_id;

  v_je_id := post_journal_entry(
    p_description    := 'Goods Received - GRN #' || v_grn.grn_number
                        || COALESCE(' / PO #' || v_po_number, ''),
    p_entry_date     := COALESCE(v_grn.received_date, op_date()),
    p_reference_type := 'grn',
    p_reference_id   := v_grn.id,
    p_lines          := v_lines::json,
    p_supplier_id    := v_grn.supplier_id
  );

  RETURN jsonb_build_object('posted', true, 'amount', v_total, 'je_id', v_je_id);
END;
$function$

CREATE OR REPLACE FUNCTION public.post_journal_entry(p_description text, p_lines jsonb, p_entry_date date DEFAULT op_date(), p_reference_type text DEFAULT NULL::text, p_reference_id uuid DEFAULT NULL::uuid, p_tenant_id uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_entry_id uuid;
  v_entry_number text;
  v_total_debit decimal(15,2) := 0;
  v_total_credit decimal(15,2) := 0;
  v_line jsonb;
  v_account_id uuid;
  v_sort_order int := 0;
BEGIN
  v_entry_number := 'JE-' || nextval('journal_entry_seq')::text;
  
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    v_total_debit := v_total_debit + COALESCE((v_line->>'debit')::decimal, 0);
    v_total_credit := v_total_credit + COALESCE((v_line->>'credit')::decimal, 0);
  END LOOP;
  
  INSERT INTO journal_entries (
    tenant_id, entry_number, entry_date, description,
    reference_type, reference_id, total_debit, total_credit, is_posted
  ) VALUES (
    p_tenant_id, v_entry_number, p_entry_date, p_description,
    p_reference_type, p_reference_id, v_total_debit, v_total_credit, true
  ) RETURNING id INTO v_entry_id;
  
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    SELECT id INTO v_account_id FROM accounts WHERE code = (v_line->>'account_code') AND tenant_id = p_tenant_id;
    
    IF v_account_id IS NULL THEN
      RAISE EXCEPTION 'Account not found: %', (v_line->>'account_code');
    END IF;
    
    INSERT INTO journal_lines (
      journal_entry_id, account_id, description, debit, credit, sort_order
    ) VALUES (
      v_entry_id,
      v_account_id,
      v_line->>'description',
      COALESCE((v_line->>'debit')::decimal, 0),
      COALESCE((v_line->>'credit')::decimal, 0),
      v_sort_order
    );
    
    UPDATE accounts SET balance = balance + 
      CASE 
        WHEN account_type IN ('asset', 'expense') THEN 
          COALESCE((v_line->>'debit')::decimal, 0) - COALESCE((v_line->>'credit')::decimal, 0)
        ELSE 
          COALESCE((v_line->>'credit')::decimal, 0) - COALESCE((v_line->>'debit')::decimal, 0)
      END
    WHERE id = v_account_id;
    
    v_sort_order := v_sort_order + 1;
  END LOOP;
  
  RETURN v_entry_id;
END;
$function$

CREATE OR REPLACE FUNCTION public.post_journal_entry(p_description text, p_entry_date date DEFAULT op_date(), p_reference_type text DEFAULT NULL::text, p_reference_id uuid DEFAULT NULL::uuid, p_lines json DEFAULT NULL::json, p_customer_id uuid DEFAULT NULL::uuid, p_supplier_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_entry_id uuid;
  v_total_debit numeric := 0;
  v_total_credit numeric := 0;
  v_line json;
  v_account_id uuid;
  v_debit numeric;
  v_credit numeric;
  v_line_desc text;
  v_sort_order integer := 0;
BEGIN
  IF p_lines IS NULL OR json_array_length(p_lines) = 0 THEN
    RETURN NULL;
  END IF;

  -- Create the journal entry header
  INSERT INTO journal_entries (entry_number, entry_date, description, reference_type, reference_id, total_debit, total_credit, is_posted, customer_id, supplier_id)
  VALUES (get_next_journal_number(), p_entry_date, p_description, p_reference_type, p_reference_id, 0, 0, true, p_customer_id, p_supplier_id)
  RETURNING id INTO v_entry_id;

  -- Process each line using json_array_elements (correct PostgreSQL function)
  FOR v_line IN SELECT * FROM json_array_elements(p_lines) LOOP
    v_account_id := (v_line->>'account_id')::uuid;
    v_debit := COALESCE(CAST(v_line->>'debit' AS numeric), 0);
    v_credit := COALESCE(CAST(v_line->>'credit' AS numeric), 0);
    v_line_desc := v_line->>'description';

    INSERT INTO journal_lines (journal_entry_id, account_id, description, debit, credit, sort_order)
    VALUES (v_entry_id, v_account_id, v_line_desc, v_debit, v_credit, v_sort_order);

    v_total_debit := v_total_debit + v_debit;
    v_total_credit := v_total_credit + v_credit;

    -- Update account balance based on account type
    UPDATE accounts
    SET balance = CASE
      WHEN account_type IN ('asset', 'expense') THEN balance + v_debit - v_credit
      WHEN account_type IN ('liability', 'equity', 'revenue') THEN balance + v_credit - v_debit
      ELSE balance + v_debit - v_credit
    END
    WHERE id = v_account_id;

    v_sort_order := v_sort_order + 1;
  END LOOP;

  -- Update totals on the journal entry
  UPDATE journal_entries SET total_debit = v_total_debit, total_credit = v_total_credit
  WHERE id = v_entry_id;

  RETURN v_entry_id;
END;
$function$

CREATE OR REPLACE FUNCTION public.post_quick_sell_cost_je(p_invoice_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_invoice RECORD;
  v_cogs_account uuid;
  v_paid_account uuid;
  v_item RECORD;
  v_total decimal(15,2) := 0;
  v_item_cost decimal(15,2);
  v_lines json[] := '{}';
  v_line_count int := 0;
  v_existing_je_id uuid;
  v_old_nets jsonb;
  v_new_nets jsonb;
  v_acc record;
BEGIN
  SELECT * INTO v_invoice FROM invoices WHERE id = p_invoice_id;
  IF NOT FOUND OR v_invoice.status IN ('draft', 'cancelled') THEN
    RETURN NULL;
  END IF;

  -- Non-stock items only; stocked items' COGS belongs to the FIFO JE.
  SELECT id INTO v_cogs_account FROM accounts WHERE code = '5000' LIMIT 1;
  IF v_cogs_account IS NULL THEN
    RETURN NULL;
  END IF;

  FOR v_item IN
    SELECT ii.id, ii.quantity, ii.cost_price, ii.source_shop, p.name, p.sku
      FROM invoice_items ii
      JOIN products p ON p.id = ii.product_id
     WHERE ii.invoice_id = p_invoice_id
       AND NOT p.track_inventory
       AND ii.quantity > 0
     ORDER BY ii.sort_order, ii.id
  LOOP
    v_item_cost := ROUND(COALESCE(v_item.cost_price, 0) * v_item.quantity, 2);
    CONTINUE WHEN v_item_cost <= 0;

    v_total := v_total + v_item_cost;
    v_line_count := v_line_count + 1;

    v_lines := array_append(v_lines, json_build_object(
      'account_id', v_cogs_account, 'debit', v_item_cost, 'credit', 0,
      'description', 'Quick Sell Cost (manual): ' || COALESCE(v_item.name, 'Unknown') ||
        ' (SKU: ' || COALESCE(v_item.sku, 'N/A') || ') - Qty: ' || v_item.quantity ||
        ' x Cost: ' || COALESCE(v_item.cost_price, 0) || ' = ' || v_item_cost ||
        CASE WHEN COALESCE(v_item.source_shop, '') <> ''
             THEN ' [bought from: ' || v_item.source_shop || ']' ELSE '' END
    ));
    v_lines := array_append(v_lines, json_build_object(
      'account_id', NULL, 'debit', 0, 'credit', v_item_cost,  -- account filled below
      'description', 'Paid source shop for ' || COALESCE(v_item.name, 'Unknown') ||
        ' (Qty: ' || v_item.quantity || ') for ' || v_invoice.invoice_number
    ));
  END LOOP;

  IF v_total <= 0 THEN
    RETURN NULL;
  END IF;

  v_paid_account := quick_sell_cost_account(v_invoice.cost_payment_method);
  IF v_paid_account IS NULL THEN
    RAISE EXCEPTION 'Quick Sell cost account unavailable: payment method "%" has no GL account and Cash (1001) is missing', COALESCE(v_invoice.cost_payment_method, 'cash');
  END IF;
  -- Fill the credit-side account now that we know the invoice has cost lines.
  FOR i IN 1..array_length(v_lines, 1) LOOP
    IF (v_lines[i]->>'account_id')::text IS NULL THEN
      v_lines[i] := jsonb_set(v_lines[i]::jsonb, '{account_id}', to_jsonb(v_paid_account))::json;
    END IF;
  END LOOP;

  SELECT id INTO v_existing_je_id
    FROM journal_entries
   WHERE reference_type = 'invoice'
     AND reference_id = p_invoice_id
     AND description LIKE 'Quick Sell Cost%'
   ORDER BY entry_date ASC, id ASC
   LIMIT 1;

  IF v_existing_je_id IS NOT NULL THEN
    -- Capture the per-account nets BEFORE replacing lines so accounts.balance
    -- can be adjusted by the delta for every account the JE ever touched
    -- (the paid-from account may itself change between posts).
    SELECT COALESCE(jsonb_object_agg(account_id, net), '{}'::jsonb) INTO v_old_nets
      FROM (SELECT account_id, SUM(debit - credit) AS net
              FROM journal_lines WHERE journal_entry_id = v_existing_je_id
             GROUP BY account_id) t;

    DELETE FROM journal_lines WHERE journal_entry_id = v_existing_je_id;

    FOR i IN 1..array_length(v_lines, 1) LOOP
      INSERT INTO journal_lines (journal_entry_id, account_id, description, debit, credit, sort_order)
      VALUES (
        v_existing_je_id,
        (v_lines[i]->>'account_id')::uuid,
        v_lines[i]->>'description',
        (v_lines[i]->>'debit')::decimal(15,2),
        (v_lines[i]->>'credit')::decimal(15,2),
        i
      );
    END LOOP;

    UPDATE journal_entries
       SET description = 'Quick Sell Cost - ' || v_invoice.invoice_number || ' (' || v_line_count || ' items, total: ' || v_total || ')',
           total_debit = v_total,
           total_credit = v_total
     WHERE id = v_existing_je_id;

    SELECT COALESCE(jsonb_object_agg(account_id, net), '{}'::jsonb) INTO v_new_nets
      FROM (SELECT account_id, SUM(debit - credit) AS net
              FROM journal_lines WHERE journal_entry_id = v_existing_je_id
             GROUP BY account_id) t;

    -- Maintain denormalized balances by the net change per account (same
    -- sign convention as post_journal_entry).
    FOR v_acc IN
      SELECT DISTINCT k AS account_id
        FROM jsonb_object_keys(v_old_nets || v_new_nets) AS k
    LOOP
      UPDATE accounts
         SET balance = balance + CASE
               WHEN account_type IN ('liability', 'equity', 'revenue')
                 THEN -((COALESCE((v_new_nets ->> v_acc.account_id)::numeric, 0)) - (COALESCE((v_old_nets ->> v_acc.account_id)::numeric, 0)))
               ELSE ((COALESCE((v_new_nets ->> v_acc.account_id)::numeric, 0)) - (COALESCE((v_old_nets ->> v_acc.account_id)::numeric, 0)))
             END
       WHERE id = (v_acc.account_id)::uuid;
    END LOOP;

    RETURN v_existing_je_id;
  ELSE
    RETURN post_journal_entry(
      'Quick Sell Cost - ' || v_invoice.invoice_number || ' (' || v_line_count || ' items, total: ' || v_total || ')',
      COALESCE(v_invoice.invoice_date, op_date()),
      'invoice',
      p_invoice_id,
      to_json(v_lines),
      v_invoice.customer_id
    );
  END IF;
END
$function$

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
      op_date(),
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
        op_date(),
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
$function$

CREATE OR REPLACE FUNCTION public.push_notification(p_type text, p_settings_key text, p_title text, p_body text, p_entity_type text DEFAULT NULL::text, p_entity_id uuid DEFAULT NULL::uuid, p_href text DEFAULT NULL::text, p_roles text[] DEFAULT NULL::text[], p_user_id uuid DEFAULT NULL::uuid, p_dedupe_hours integer DEFAULT 0)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_role text;
BEGIN
  IF NOT notification_enabled(p_settings_key) THEN
    RETURN;
  END IF;

  -- Suppress repeats of the same alert about the same entity inside the
  -- dedupe window (used by low stock, where every movement re-crosses).
  IF p_dedupe_hours > 0 AND EXISTS (
    SELECT 1 FROM notifications
    WHERE type = p_type
      AND entity_id IS NOT DISTINCT FROM p_entity_id
      AND created_at > op_at() - make_interval(hours => p_dedupe_hours)
  ) THEN
    RETURN;
  END IF;

  IF p_user_id IS NOT NULL THEN
    INSERT INTO notifications (type, title, body, entity_type, entity_id, href, target_user_id)
    VALUES (p_type, p_title, p_body, p_entity_type, p_entity_id, p_href, p_user_id);
  END IF;

  IF p_roles IS NOT NULL THEN
    FOREACH v_role IN ARRAY p_roles LOOP
      INSERT INTO notifications (type, title, body, entity_type, entity_id, href, target_role)
      VALUES (p_type, p_title, p_body, p_entity_type, p_entity_id, p_href, v_role);
    END LOOP;
  END IF;
END;
$function$

CREATE OR REPLACE FUNCTION public.quick_sell_create(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_key             text;
  v_is_pos          boolean;
  v_number          text;
  v_invoice_id      uuid;
  v_customer        uuid;
  v_date            date;
  v_due_date        date;
  v_payment_term    text;
  v_partial         numeric;
  v_store_credit    numeric;
  v_cash            numeric;
  v_cash_method     text;
  v_cost_method     text;
  v_subtotal        numeric := 0;
  v_total           numeric;
  v_amount_paid     numeric;
  v_status          text;
  v_item            jsonb;
  v_i               int := 0;
  v_product_id      uuid;
  v_name_norm       text;
  v_created_count   int := 0;
  v_reused_count    int := 0;
  v_sku             text;
  v_unit            text;
  v_qty             numeric;
  v_price           numeric;
  v_cost            numeric;
  v_disc            numeric;
  v_remaining       numeric;
  v_redeem          numeric;
  v_scnum           text;
  v_pnum            text;
  v_credit          record;
BEGIN
  v_customer     := (p_payload->>'customer_id')::uuid;
  v_date         := COALESCE((p_payload->>'invoice_date')::date, op_date());
  v_due_date     := NULLIF(p_payload->>'due_date', '')::date;
  v_key          := NULLIF(p_payload->>'idempotency_key', '');
  v_is_pos       := COALESCE((p_payload->>'is_pos')::boolean, true);
  v_payment_term := COALESCE(NULLIF(p_payload->>'payment_term', ''), 'full');
  v_partial      := COALESCE((p_payload->>'partial_amount')::numeric, 0);
  v_store_credit := COALESCE((p_payload->>'store_credit_amount')::numeric, 0);
  v_cash         := COALESCE((p_payload->'cash_payment'->>'amount')::numeric, 0);
  v_cash_method  := COALESCE(NULLIF(p_payload->'cash_payment'->>'method', ''), 'cash');
  v_cost_method  := COALESCE(NULLIF(p_payload->>'cost_payment_method', ''), 'cash');

  IF v_customer IS NULL THEN
    RAISE EXCEPTION 'quick_sell_create: customer_id is required (quick sells are for standing customers)';
  END IF;
  IF p_payload->'items' IS NULL OR jsonb_array_length(p_payload->'items') = 0 THEN
    RAISE EXCEPTION 'quick_sell_create: items array is required';
  END IF;
  IF v_payment_term NOT IN ('full', 'partial', 'credit') THEN
    RAISE EXCEPTION 'quick_sell_create: payment_term must be full, partial or credit';
  END IF;
  IF v_payment_term = 'partial' AND v_partial <= 0 THEN
    RAISE EXCEPTION 'quick_sell_create: partial payment requires partial_amount > 0';
  END IF;
  IF v_cash < 0 OR v_partial < 0 OR v_store_credit < 0 THEN
    RAISE EXCEPTION 'quick_sell_create: payment amounts cannot be negative';
  END IF;

  -- Idempotency: a replayed key returns the original invoice.
  IF v_key IS NOT NULL THEN
    SELECT id, invoice_number INTO v_invoice_id, v_number
      FROM invoices WHERE idempotency_key = v_key;
    IF v_invoice_id IS NOT NULL THEN
      RETURN jsonb_build_object('status', 'duplicate', 'invoice_id', v_invoice_id, 'invoice_number', v_number);
    END IF;
  END IF;

  -- Validate items up front (fail before anything is written).
  FOR v_i IN 0..(jsonb_array_length(p_payload->'items') - 1) LOOP
    v_item := p_payload->'items'->v_i;
    v_qty  := COALESCE((v_item->>'quantity')::numeric, 0);
    v_price := COALESCE((v_item->>'sale_price')::numeric, 0);
    v_cost := COALESCE((v_item->>'cost_price')::numeric, 0);
    IF NULLIF(TRIM(COALESCE(v_item->>'name', '')), '') IS NULL
       AND (v_item->>'product_id')::uuid IS NULL THEN
      RAISE EXCEPTION 'quick_sell_create: item % needs a name or product_id', v_i + 1;
    END IF;
    IF v_qty <= 0 THEN
      RAISE EXCEPTION 'quick_sell_create: item "%" has quantity % — must be > 0', COALESCE(v_item->>'name', v_item->>'product_id'), v_qty;
    END IF;
    IF v_price < 0 OR v_cost < 0 THEN
      RAISE EXCEPTION 'quick_sell_create: item "%" has negative price/cost', COALESCE(v_item->>'name', v_item->>'product_id');
    END IF;
    v_subtotal := v_subtotal + v_qty * v_price * (1 - COALESCE((v_item->>'discount_percent')::numeric, 0) / 100);
  END LOOP;

  v_total := GREATEST(
    0,
    v_subtotal
      - (v_subtotal * COALESCE((p_payload->>'cart_discount_percent')::numeric, 0)) / 100
      - COALESCE((p_payload->>'extra_discount')::numeric, 0)
  ) + COALESCE((p_payload->>'tax_amount')::numeric, 0);

  -- Amount paid / status mirror POS processOrder semantics.
  IF v_payment_term = 'full' THEN
    v_amount_paid := v_total;
    v_status := CASE WHEN v_store_credit > 0 AND (v_total - v_store_credit) > 0
                     THEN 'partially_paid' ELSE 'paid' END;
  ELSIF v_payment_term = 'partial' THEN
    v_amount_paid := LEAST(v_partial, v_total);
    v_status := 'partially_paid';
  ELSE
    v_amount_paid := 0;
    v_status := 'sent';
  END IF;

  IF v_is_pos THEN
    v_number := public.generate_pos_number();
  ELSE
    v_number := public.generate_invoice_number();
  END IF;

  INSERT INTO invoices (invoice_number, customer_id, invoice_date, due_date, subtotal, discount_amount,
    cart_discount_percent, extra_discount, tax_amount, shipping_cost, total_amount, amount_paid,
    status, is_pos, reference, notes, idempotency_key, is_quick_sell, cost_payment_method)
  VALUES (v_number, v_customer, v_date, v_due_date, v_subtotal,
    (v_subtotal * COALESCE((p_payload->>'cart_discount_percent')::numeric, 0)) / 100,
    COALESCE((p_payload->>'cart_discount_percent')::numeric, 0),
    COALESCE((p_payload->>'extra_discount')::numeric, 0),
    COALESCE((p_payload->>'tax_amount')::numeric, 0),
    0,
    v_total, v_amount_paid, v_status, v_is_pos,
    NULLIF(p_payload->>'reference', ''),
    NULLIF(p_payload->>'notes', ''),
    v_key, true, v_cost_method)
  RETURNING id INTO v_invoice_id;

  -- Resolve / create products, then write items + cost history.
  FOR v_i IN 0..(jsonb_array_length(p_payload->'items') - 1) LOOP
    v_item := p_payload->'items'->v_i;
    v_qty  := COALESCE((v_item->>'quantity')::numeric, 0);
    v_price := COALESCE((v_item->>'sale_price')::numeric, 0);
    v_cost := COALESCE((v_item->>'cost_price')::numeric, 0);
    v_disc := COALESCE((v_item->>'discount_percent')::numeric, 0);
    v_unit := COALESCE(NULLIF(v_item->>'unit', ''), 'pcs');
    v_name_norm := LOWER(REGEXP_REPLACE(TRIM(COALESCE(v_item->>'name', '')), '\s+', ' ', 'g'));

    v_product_id := NULLIF(v_item->>'product_id', '')::uuid;

    IF v_product_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM products p WHERE p.id = v_product_id AND NOT p.track_inventory) THEN
        RAISE EXCEPTION 'quick_sell_create: product % is stocked (or missing) — stocked items must be sold through the regular sale flow', v_product_id;
      END IF;
      v_reused_count := v_reused_count + 1;
    ELSE
      SELECT p.id INTO v_product_id
        FROM products p
       WHERE NOT p.track_inventory AND LOWER(REGEXP_REPLACE(TRIM(p.name), '\s+', ' ', 'g')) = v_name_norm
       LIMIT 2;
      IF v_product_id IS NOT NULL THEN
        -- Ambiguous normalized name among non-stock products? (LIMIT 2 caught
        -- at least one; re-check for a second.)
        IF EXISTS (
          SELECT 1 FROM products p2
           WHERE NOT p2.track_inventory
             AND LOWER(REGEXP_REPLACE(TRIM(p2.name), '\s+', ' ', 'g')) = v_name_norm
             AND p2.id <> v_product_id
        ) THEN
          RAISE EXCEPTION 'quick_sell_create: "%" matches several non-stock products — pick one explicitly', v_item->>'name';
        END IF;
        v_reused_count := v_reused_count + 1;
      ELSIF EXISTS (
        SELECT 1 FROM products p
         WHERE p.track_inventory
           AND LOWER(REGEXP_REPLACE(TRIM(p.name), '\s+', ' ', 'g')) = v_name_norm
      ) THEN
        RAISE EXCEPTION 'quick_sell_create: "%" is a stocked product — sell it through the regular sale flow (or receive stock first)', v_item->>'name';
      ELSE
        v_sku := 'QS-' || lpad(nextval('quick_sell_sku_seq')::text, 5, '0');
        INSERT INTO products (sku, name, unit, base_unit, cost_price, sale_price,
                              track_inventory, is_quick_sell, is_active, min_stock_level, description)
        VALUES (v_sku, TRIM(v_item->>'name'), v_unit, v_unit, v_cost, v_price,
                false, true, true, 0, 'Quick-sell (non-stock) item — bought on demand, never stocked')
        RETURNING id INTO v_product_id;
        v_created_count := v_created_count + 1;
      END IF;
    END IF;

    -- Keep the product defaults fresh for next time (cost/price of the most
    -- recent quick sell; single unit so base scale == sale scale).
    UPDATE products
       SET cost_price = v_cost, sale_price = v_price, updated_at = op_at()
     WHERE id = v_product_id AND NOT track_inventory;

    INSERT INTO invoice_items (invoice_id, product_id, quantity, unit_price, cost_price,
      discount_percent, tax_rate, subtotal, unit_name, unit_conversion_factor,
      base_quantity, source_shop, sort_order)
    VALUES (v_invoice_id, v_product_id, v_qty, v_price, v_cost,
      v_disc, 0, v_qty * v_price * (1 - v_disc / 100), v_unit, 1,
      v_qty, NULLIF(v_item->>'source_shop', ''), v_i);

    INSERT INTO cost_price_history (product_id, product_name, product_sku, invoice_id, unit,
      quantity, unit_price, cost_price_per_qty, cost_price_for_added_qty,
      total_cost_price_single, total_cost_price_added)
    SELECT v_product_id, p.name, COALESCE(p.sku, ''), v_invoice_id, v_unit,
      v_qty, v_price, v_cost, v_cost * v_qty, v_cost, v_cost * v_qty
    FROM products p WHERE p.id = v_product_id;
  END LOOP;

  -- The Quick Sell Cost JE is posted by trg_post_cogs_je_from_item_insert on
  -- the item INSERTs above (non-draft invoice). Nothing further needed here.

  -- Store credit redemption: same fresh re-select + oldest-first loop as POS.
  IF v_store_credit > 0 THEN
    v_remaining := v_store_credit;
    FOR v_credit IN
      SELECT id, balance FROM customer_store_credits
       WHERE customer_id = v_customer AND status = 'active'
         AND (expires_at IS NULL OR expires_at > op_at())
       ORDER BY created_at ASC
    LOOP
      EXIT WHEN v_remaining <= 0;
      v_redeem := LEAST(COALESCE(v_credit.balance, 0), v_remaining);
      IF v_redeem > 0 THEN
        INSERT INTO store_credit_redemptions (store_credit_id, customer_id, invoice_id, amount, notes)
        VALUES (v_credit.id, v_customer, v_invoice_id, v_redeem, 'Redeemed for ' || v_number);
        v_remaining := v_remaining - v_redeem;
      END IF;
    END LOOP;

    v_scnum := public.generate_payment_number();
    INSERT INTO payments (payment_number, payment_type, reference_type, reference_id, customer_id,
      amount, payment_method, payment_date, notes, payment_for)
    VALUES ('PAY-SC-' || REPLACE(COALESCE(v_scnum, ''), 'PAY-', ''),
      'received', 'invoice', v_invoice_id, v_customer,
      v_store_credit, 'store_credit', v_date,
      'Store credit redeemed for ' || v_number, 'paid_invoice_pay');
  END IF;

  IF v_cash > 0 THEN
    v_pnum := public.generate_payment_number();
    INSERT INTO payments (payment_number, payment_type, reference_type, reference_id, customer_id,
      amount, payment_method, payment_date, reference_number, notes, payment_for)
    VALUES (COALESCE(v_pnum, 'PAY-' || to_char(op_at(), 'HH24MISS')),
      'received', 'invoice', v_invoice_id, v_customer,
      v_cash, v_cash_method, v_date,
      NULLIF(p_payload->'cash_payment'->>'reference_number', ''),
      'Quick sell ' || v_number, 'paid_invoice_pay');
  END IF;

  RETURN jsonb_build_object(
    'status', 'created',
    'invoice_id', v_invoice_id,
    'invoice_number', v_number,
    'total', v_total,
    'products_created', v_created_count,
    'products_reused', v_reused_count
  );
END
$function$

CREATE OR REPLACE FUNCTION public.receive_grn(p_supplier_id uuid, p_purchase_order_id uuid DEFAULT NULL::uuid, p_warehouse_id uuid DEFAULT NULL::uuid, p_items json DEFAULT NULL::json, p_notes text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid := '00000000-0000-0000-0000-000000000001';
  v_grn_id uuid := gen_random_uuid();
  v_grn_number text;
  v_wh uuid;
  v_item json;
  v_product_id uuid;
  v_po_item_id uuid;
  v_qty numeric;
  v_cost numeric;
  v_expiry date;
  v_item_wh uuid;
  v_poi_warehouse uuid;
  v_first_wh uuid;
  v_mixed_wh boolean := false;
  v_before_cost numeric;
  v_after_cost numeric;
  v_batch_cost numeric;
  v_force_cost boolean := false;
  v_poi_unit_cost numeric;
  v_poi_discount numeric;
  v_inv_item record;
  v_cost_updates jsonb := '[]'::jsonb;
  v_sale_updates jsonb := '[]'::jsonb;
  v_before_sale numeric;
  v_new_sale numeric;
  v_all_received boolean;
  v_some_received boolean;
  v_owed numeric;
  v_absorb_left numeric;
  v_absorbed numeric;
  v_take numeric;
  v_iou record;
  v_net_qty numeric;
  v_ledger_sum numeric;
  -- Absorption accounting (this GRN, all items):
  --   v_absorb_value          = absorbed units valued at the IOU batches' own cost
  --   v_absorb_receipt_value  = same units valued at this receipt's cost
  v_absorb_value numeric := 0;
  v_absorb_receipt_value numeric := 0;
BEGIN
  IF p_supplier_id IS NULL THEN
    RAISE EXCEPTION 'Supplier is required';
  END IF;
  IF p_items IS NULL OR json_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'At least one item with quantity > 0 is required';
  END IF;

  v_wh := COALESCE(
    p_warehouse_id,
    (SELECT id FROM warehouses WHERE is_default AND is_active LIMIT 1),
    (SELECT id FROM warehouses WHERE is_active LIMIT 1)
  );
  IF v_wh IS NULL THEN
    RAISE EXCEPTION 'No active warehouse available';
  END IF;

  v_grn_number := 'GRN-' || to_char(clock_timestamp(), 'YYMMDDHH24MISSUS');

  INSERT INTO goods_receipt_notes (id, tenant_id, grn_number, purchase_order_id, supplier_id,
                                   warehouse_id, received_date, status, notes)
  VALUES (v_grn_id, v_tenant, v_grn_number, p_purchase_order_id, p_supplier_id,
          v_wh, op_date(), 'posted', p_notes);

  FOR v_item IN SELECT * FROM json_array_elements(p_items) LOOP
    v_qty := COALESCE((v_item->>'quantity')::numeric, 0);
    v_cost := COALESCE((v_item->>'unit_cost')::numeric, 0);
    v_expiry := (v_item->>'expiry_date')::date;
    v_product_id := (v_item->>'product_id')::uuid;
    v_po_item_id := NULLIF(v_item->>'po_item_id', '')::uuid;
    v_force_cost := false;
    IF v_qty <= 0 OR v_product_id IS NULL THEN
      CONTINUE;
    END IF;

    -- PO-based receipts cost what the PO line committed to: unit cost minus
    -- the line discount. The client sends the raw pre-discount unit_cost, so
    -- it is ignored here — otherwise batches, movements, and the cost ratchet
    -- all post at the undiscounted price.
    IF v_po_item_id IS NOT NULL THEN
      SELECT unit_cost, COALESCE(discount_percent, 0), warehouse_id
        INTO v_poi_unit_cost, v_poi_discount, v_poi_warehouse
      FROM purchase_order_items WHERE id = v_po_item_id;
      IF FOUND THEN
        v_cost := v_poi_unit_cost * (1 - v_poi_discount / 100);
      END IF;
    END IF;

    -- Each line lands in the warehouse it was raised for: explicit payload
    -- value, else the PO line's "Receive Into" warehouse, else the GRN's
    -- default. This is what makes a PO raised against a warehouse with an
    -- outstanding IOU actually heal that IOU.
    v_item_wh := COALESCE(
      NULLIF(v_item->>'warehouse_id', '')::uuid,
      v_poi_warehouse,
      v_wh
    );
    IF v_first_wh IS NULL THEN
      v_first_wh := v_item_wh;
    ELSIF v_first_wh IS DISTINCT FROM v_item_wh THEN
      v_mixed_wh := true;
    END IF;

    SELECT cost_price INTO v_before_cost FROM products WHERE id = v_product_id;

    -- Absorption math runs before the movement insert so the movement can
    -- carry the IOU marker (mirrors the sale-side "OVERSOLD by N" note).
    SELECT COALESCE(-SUM(quantity_remaining), 0) INTO v_owed
      FROM inventory_batches
     WHERE product_id = v_product_id AND warehouse_id = v_item_wh
       AND quantity_remaining < 0;
    v_absorbed := LEAST(v_owed, v_qty);
    v_net_qty := v_qty - v_absorbed;

    INSERT INTO stock_movements (tenant_id, product_id, warehouse_id, movement_type,
                                 quantity, unit_cost, reference_type, reference_id, reference_number, notes)
    VALUES (v_tenant, v_product_id, v_item_wh, 'purchase', v_qty, v_cost, 'grn', v_grn_id, v_grn_number,
            CASE WHEN v_absorbed > 0 THEN
              'Goods received — absorbed ' || trim_scale(v_absorbed) || ' base unit(s) of OVERSOLD IOU (net ' || trim_scale(v_net_qty) || ' added to stock)'
            ELSE NULL END);

    -- Absorb outstanding oversell IOU layers (negative FIFO-SHORTFALL batches)
    -- into this receipt: drive them back to 0, oldest first, and post the new
    -- batch net of what was owed. Batches and p_qty share the same base-unit
    -- convention, so the arithmetic is direct.
    IF v_absorbed > 0 THEN
      v_absorb_left := v_absorbed;
      FOR v_iou IN
        SELECT id, quantity_remaining, unit_cost
          FROM inventory_batches
         WHERE product_id = v_product_id AND warehouse_id = v_item_wh
           AND quantity_remaining < 0
         ORDER BY created_at ASC, id ASC
         FOR UPDATE
      LOOP
        EXIT WHEN v_absorb_left <= 0;
        v_take := LEAST(-v_iou.quantity_remaining, v_absorb_left);
        UPDATE inventory_batches
           SET quantity_remaining = quantity_remaining + v_take
         WHERE id = v_iou.id;
        v_absorb_value := v_absorb_value + v_take * COALESCE(v_iou.unit_cost, 0);
        v_absorb_receipt_value := v_absorb_receipt_value + v_take * v_cost;
        v_absorb_left := v_absorb_left - v_take;
      END LOOP;
    END IF;

    IF v_po_item_id IS NOT NULL THEN
      UPDATE purchase_order_items
      SET received_quantity = COALESCE(received_quantity, 0) + v_qty
      WHERE id = v_po_item_id;

      -- Push the PO line's intended sale price onto the product master.
      -- Only for PO-based receipts; direct GRNs never touch product prices.
      -- Changes are reported back so the client can confirm what was updated.
      v_new_sale := NULL;
      SELECT poi.sale_price, COALESCE(poi.force_cost_update, false)
        INTO v_new_sale, v_force_cost
      FROM purchase_order_items poi WHERE poi.id = v_po_item_id;
      IF v_new_sale IS NOT NULL THEN
        SELECT sale_price INTO v_before_sale FROM products WHERE id = v_product_id;
        UPDATE products SET sale_price = v_new_sale, updated_at = op_at()
        WHERE id = v_product_id AND sale_price IS DISTINCT FROM v_new_sale;
        IF FOUND THEN
          v_sale_updates := v_sale_updates || jsonb_build_object(
            'product_id', v_product_id,
            'name', (SELECT name FROM products p WHERE p.id = v_product_id),
            'before', COALESCE(v_before_sale, 0),
            'after', v_new_sale
          );
        END IF;
      END IF;
    END IF;

    -- FIFO layer with optional expiry_date. quantity_received keeps the GROSS
    -- physical receipt (what the supplier actually delivered — the FIFO page
    -- and batches modal display it); quantity_remaining carries the net after
    -- IOU absorption. RETURNING gives the batch's unit_cost after the
    -- base-unit normalization trigger ran, so the forced cost write below
    -- compares like-for-like with products.cost_price.
    INSERT INTO inventory_batches (tenant_id, product_id, variant_id, warehouse_id, batch_number,
                                   quantity_received, quantity_remaining, unit_cost, batch_type,
                                   reference_type, reference_id, reference_number, notes, expiry_date)
    VALUES (v_tenant, v_product_id, NULL, v_item_wh,
            v_grn_number || '-' || left(v_product_id::text, 8),
            v_qty, v_net_qty, v_cost, 'purchase',
            'grn', v_grn_id, v_grn_number, COALESCE(p_notes, 'Goods received via GRN'), v_expiry)
    RETURNING unit_cost INTO v_batch_cost;

    -- On-hand counter: resync from the batch ledger (source of truth) instead
    -- of blind-incrementing. This heals the floor-at-0 divergence from
    -- overselling and any legacy counter drift on every receipt.
    SELECT COALESCE(SUM(quantity_remaining), 0) INTO v_ledger_sum
      FROM inventory_batches
     WHERE product_id = v_product_id AND warehouse_id = v_item_wh;

    SELECT ii.id INTO v_inv_item
      FROM inventory_items ii
     WHERE ii.product_id = v_product_id AND ii.warehouse_id = v_item_wh
     LIMIT 1;
    IF v_inv_item.id IS NOT NULL THEN
      UPDATE inventory_items
      SET quantity_on_hand = v_ledger_sum, updated_at = op_at()
      WHERE id = v_inv_item.id;
    ELSE
      INSERT INTO inventory_items (tenant_id, product_id, warehouse_id, quantity_on_hand)
      VALUES (v_tenant, v_product_id, v_wh, v_ledger_sum);
    END IF;

    -- Forced cost override: set the master cost to the received cost even when
    -- it is lower than the current one (the ratchet trigger above only raises).
    IF v_force_cost THEN
      UPDATE products SET cost_price = ROUND(v_batch_cost, 2), updated_at = op_at()
      WHERE id = v_product_id AND cost_price IS DISTINCT FROM ROUND(v_batch_cost, 2);
    END IF;

    SELECT cost_price INTO v_after_cost FROM products WHERE id = v_product_id;
    IF v_force_cost THEN
      IF v_after_cost IS DISTINCT FROM COALESCE(v_before_cost, 0) THEN
        v_cost_updates := v_cost_updates || jsonb_build_object(
          'product_id', v_product_id,
          'name', (SELECT name FROM products p WHERE p.id = v_product_id),
          'before', COALESCE(v_before_cost, 0),
          'after', v_after_cost,
          'forced', true
        );
      END IF;
    ELSIF v_after_cost > COALESCE(v_before_cost, 0) THEN
      v_cost_updates := v_cost_updates || jsonb_build_object(
        'product_id', v_product_id,
        'name', (SELECT name FROM products p WHERE p.id = v_product_id),
        'before', COALESCE(v_before_cost, 0),
        'after', v_after_cost
      );
    END IF;
  END LOOP;

  -- Journal entry (idempotent per GRN). Absorption figures post the gross AP
  -- credit and the IOU cost-basis correction — see migration header.
  PERFORM post_grn_journal(v_grn_id, v_absorb_value, v_absorb_receipt_value);

  -- When every line landed in the same (non-default) warehouse, align the GRN
  -- header so the receipt displays where the goods actually went. Mixed-
  -- warehouse receipts keep the default warehouse on the header.
  IF NOT v_mixed_wh AND v_first_wh IS NOT NULL AND v_first_wh IS DISTINCT FROM v_wh THEN
    UPDATE goods_receipt_notes SET warehouse_id = v_first_wh WHERE id = v_grn_id;
  END IF;

  -- PO status recompute
  IF p_purchase_order_id IS NOT NULL THEN
    SELECT BOOL_AND(COALESCE(i.received_quantity, 0) >= i.quantity),
           BOOL_OR(COALESCE(i.received_quantity, 0) > 0)
      INTO v_all_received, v_some_received
    FROM purchase_order_items i
    WHERE i.purchase_order_id = p_purchase_order_id;

    UPDATE purchase_orders
    SET status = CASE
      WHEN COALESCE(v_all_received, false) THEN 'received'
      WHEN COALESCE(v_some_received, false) THEN 'partially_received'
      ELSE 'approved'
    END
    WHERE id = p_purchase_order_id;
  END IF;

  -- Auto-fulfill pending purchase reminders
  UPDATE purchase_reminders
  SET status = 'fulfilled', fulfilled_at = op_at(), fulfilled_by_grn_id = v_grn_id, updated_at = op_at()
  WHERE status = 'pending'
    AND product_id IN (SELECT (j->>'product_id')::uuid FROM json_array_elements(p_items) j);

  RETURN json_build_object('grn_id', v_grn_id, 'grn_number', v_grn_number,
                           'cost_updates', v_cost_updates, 'sale_price_updates', v_sale_updates);
END $function$

CREATE OR REPLACE FUNCTION public.recompute_customer_balances(p_customer_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_purchases numeric;
  v_outstanding numeric;
BEGIN
  IF p_customer_id IS NULL THEN
    RETURN 0;
  END IF;

  -- total purchases = all non-cancelled invoices + posted manual receivable debits
  SELECT GREATEST(0,
           COALESCE((SELECT SUM(total_amount) FROM invoices
                      WHERE customer_id = p_customer_id
                        AND status <> 'cancelled'), 0)
         + COALESCE((SELECT SUM(total_debit) FROM journal_entries
                      WHERE customer_id = p_customer_id
                        AND reference_type = 'receivable'
                        AND is_posted = true), 0))
    INTO v_purchases;

  -- outstanding = open invoice balances + posted manual receivable debits
  --               − collections (bad-debt write-offs count as collected)
  SELECT GREATEST(0,
           COALESCE((SELECT SUM(balance_due) FROM invoices
                      WHERE customer_id = p_customer_id
                        AND status IN ('sent', 'partially_paid', 'unpaid', 'overdue')), 0)
         + COALESCE((SELECT SUM(total_debit) FROM journal_entries
                      WHERE customer_id = p_customer_id
                        AND reference_type = 'receivable'
                        AND is_posted = true), 0)
         - COALESCE((SELECT SUM(p.amount + COALESCE(p.bad_debt_amount, 0)) FROM payments p
                      WHERE p.reference_type = 'receivable'
                        AND COALESCE(p.is_reversed, false) = false
                        AND p.reference_id IN (
                          SELECT id FROM journal_entries
                           WHERE customer_id = p_customer_id
                             AND reference_type = 'receivable'
                             AND is_posted = true)), 0))
    INTO v_outstanding;

  UPDATE customers
     SET total_purchases = v_purchases,
         outstanding_balance = v_outstanding,
         updated_at = op_at()
   WHERE id = p_customer_id;

  RETURN 1;
END;
$function$

CREATE OR REPLACE FUNCTION public.recompute_supplier_balances(p_supplier_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ap uuid;
  v_outstanding numeric;
  v_purchases numeric;
BEGIN
  SELECT id INTO v_ap FROM accounts WHERE code = '2000' LIMIT 1;
  IF v_ap IS NULL THEN
    RAISE EXCEPTION 'Accounts Payable account (2000) not found';
  END IF;

  IF p_supplier_id IS NOT NULL THEN
    SELECT
      COALESCE(SUM(jl.credit - jl.debit), 0),
      COALESCE(SUM(jl.credit) FILTER (WHERE je.reference_type = 'grn'), 0)
    INTO v_outstanding, v_purchases
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    WHERE jl.account_id = v_ap
      AND je.is_posted = TRUE
      AND (je.supplier_id = p_supplier_id
           OR (je.reference_type = 'grn' AND EXISTS (
                SELECT 1 FROM goods_receipt_notes g
                WHERE g.id = je.reference_id
                  AND g.supplier_id = p_supplier_id)));

    UPDATE suppliers
    SET outstanding_balance = v_outstanding,
        total_purchases = v_purchases,
        updated_at = op_at()
    WHERE id = p_supplier_id;
    RETURN 1;
  END IF;

  WITH attributed AS (
    -- AP lines on JEs that carry the supplier directly
    SELECT je.supplier_id AS sid, je.reference_type, jl.credit, jl.debit
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    WHERE jl.account_id = v_ap
      AND je.is_posted = TRUE
      AND je.supplier_id IS NOT NULL
    UNION ALL
    -- AP lines on GRN JEs, attributed via the GRN row
    -- (supplier_id IS NOT NULL excluded above so no JE is counted twice)
    SELECT g.supplier_id, je.reference_type, jl.credit, jl.debit
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN goods_receipt_notes g ON g.id = je.reference_id
    WHERE jl.account_id = v_ap
      AND je.is_posted = TRUE
      AND je.reference_type = 'grn'
      AND je.supplier_id IS NULL
  ),
  per_supplier AS (
    SELECT sid,
           COALESCE(SUM(credit - debit), 0) AS outstanding,
           COALESCE(SUM(credit) FILTER (WHERE reference_type = 'grn'), 0) AS purchases
    FROM attributed
    GROUP BY sid
  )
  UPDATE suppliers s
  SET outstanding_balance = COALESCE(ps.outstanding, 0),
      total_purchases = COALESCE(ps.purchases, 0),
      updated_at = op_at()
  FROM per_supplier ps
  WHERE s.id = ps.sid;

  UPDATE suppliers s
  SET outstanding_balance = 0,
      total_purchases = 0,
      updated_at = op_at()
  WHERE NOT EXISTS (
    SELECT 1 FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    WHERE jl.account_id = v_ap
      AND je.is_posted = TRUE
      AND (je.supplier_id = s.id
           OR (je.reference_type = 'grn' AND EXISTS (
                SELECT 1 FROM goods_receipt_notes g
                WHERE g.id = je.reference_id AND g.supplier_id = s.id))));

  RETURN (SELECT count(*) FROM suppliers);
END;
$function$

CREATE OR REPLACE FUNCTION public.record_fund_transfer(p_from_account_id uuid, p_to_account_id uuid, p_amount numeric, p_transfer_date date DEFAULT op_date(), p_notes text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_from record;
  v_to record;
  v_description text;
  v_entry_id uuid;
  v_entry_number text;
  v_from_balance numeric;
  v_to_balance numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Transfer amount must be greater than zero';
  END IF;
  IF p_from_account_id IS NULL OR p_to_account_id IS NULL THEN
    RAISE EXCEPTION 'Source and destination accounts are required';
  END IF;
  IF p_from_account_id = p_to_account_id THEN
    RAISE EXCEPTION 'Source and destination accounts must be different';
  END IF;

  SELECT * INTO v_from FROM accounts WHERE id = p_from_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Source account % not found', p_from_account_id;
  END IF;
  SELECT * INTO v_to FROM accounts WHERE id = p_to_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Destination account % not found', p_to_account_id;
  END IF;

  IF NOT v_from.is_active OR NOT v_to.is_active THEN
    RAISE EXCEPTION 'Both accounts must be active';
  END IF;
  IF v_from.account_type <> 'asset' OR NOT (COALESCE(v_from.is_cash, false) OR COALESCE(v_from.is_bank, false)) THEN
    RAISE EXCEPTION 'Source must be a cash or bank account (% %)', v_from.code, v_from.name;
  END IF;
  IF v_to.account_type <> 'asset' OR NOT (COALESCE(v_to.is_cash, false) OR COALESCE(v_to.is_bank, false)) THEN
    RAISE EXCEPTION 'Destination must be a cash or bank account (% %)', v_to.code, v_to.name;
  END IF;

  -- Overdraft guard (owner decision 2026-09-14): a transfer can never drive
  -- the source account negative. accounts.balance is poster-maintained and
  -- reconcilable via recompute_account_balances if it ever drifts.
  IF COALESCE(v_from.balance, 0) < p_amount THEN
    RAISE EXCEPTION 'Insufficient balance in % %: available %, tried to move %',
      v_from.code, v_from.name, COALESCE(v_from.balance, 0), p_amount;
  END IF;

  IF COALESCE(v_from.is_bank, false) AND COALESCE(v_to.is_cash, false) THEN
    v_description := 'Bank Withdrawal';
  ELSIF COALESCE(v_from.is_cash, false) AND COALESCE(v_to.is_bank, false) THEN
    v_description := 'Bank Deposit';
  ELSE
    v_description := 'Fund Transfer';
  END IF;
  v_description := v_description || ': ' || v_from.code || ' ' || v_from.name
    || ' → ' || v_to.code || ' ' || v_to.name;
  IF NULLIF(TRIM(COALESCE(p_notes, '')), '') IS NOT NULL THEN
    v_description := v_description || ' — ' || TRIM(p_notes);
  END IF;

  v_entry_id := public.post_journal_entry(
    v_description,
    COALESCE(p_transfer_date, op_date()),
    'transfer',
    NULL,
    json_build_array(
      json_build_object('account_id', p_to_account_id, 'debit', p_amount, 'credit', 0, 'description', v_description),
      json_build_object('account_id', p_from_account_id, 'debit', 0, 'credit', p_amount, 'description', v_description)
    ),
    NULL,
    NULL
  );

  SELECT entry_number INTO v_entry_number FROM journal_entries WHERE id = v_entry_id;
  SELECT balance INTO v_from_balance FROM accounts WHERE id = p_from_account_id;
  SELECT balance INTO v_to_balance FROM accounts WHERE id = p_to_account_id;

  RETURN json_build_object(
    'id', v_entry_id,
    'entry_number', v_entry_number,
    'from_balance', v_from_balance,
    'to_balance', v_to_balance
  );
END;
$function$

CREATE OR REPLACE FUNCTION public.record_manual_payable_payment(p_payable_je_id uuid, p_amount numeric, p_wht_amount numeric DEFAULT 0, p_payment_date date DEFAULT op_date(), p_payment_method text DEFAULT 'cash'::text, p_cash_account_id uuid DEFAULT NULL::uuid, p_reference_number text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$

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
  v_qs_cogs numeric := 0;
  v_stocked_cogs numeric := 0;
  v_nonstock boolean;
  v_existing_refunds numeric;
  v_capped_refund numeric;
  v_vat_portion numeric := 0;
  v_shipping_portion numeric := 0;
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
  v_shipping_account uuid;
  v_paid_account uuid;
  v_lines json;
  v_new_refunded numeric;
  v_new_status text;
  v_wh uuid;
  v_inv_item record;
  v_adv_account uuid;
  v_adv_app record;
  v_adv_applied numeric := 0;
  v_adv_refund numeric := 0;
  v_cash_refund numeric := 0;
  v_adv_remaining numeric := 0;
  v_adv_take numeric := 0;
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
    SELECT COALESCE(NOT pr.track_inventory, false) INTO v_nonstock
    FROM products pr WHERE pr.id = v_it.product_id;

    v_conversion := CASE
      WHEN v_it.quantity > 0 AND v_it.base_quantity > 0 THEN v_it.base_quantity / v_it.quantity
      ELSE GREATEST(COALESCE(v_it.unit_conversion_factor, 0), 1)
    END;
    v_base_qty := (v_item->>'quantity')::numeric * v_conversion;

    SELECT COALESCE(SUM(cogs_amount), 0), COALESCE(SUM(quantity_consumed), 0)
    INTO v_fifo_cogs, v_fifo_qty
    FROM invoice_item_batch_consumption
    WHERE invoice_item_id = v_it.id;

    -- Non-stock (quick-sell) items have no consumption rows: the original
    -- line cost IS the cost (per sale unit / conversion).
    v_cost_per_base := CASE
      WHEN v_fifo_qty > 0 THEN v_fifo_cogs / v_fifo_qty
      ELSE COALESCE(v_it.cost_price, 0) / v_conversion
    END;

    v_total_refund := v_total_refund
      + (v_item->>'quantity')::numeric * v_it.unit_price * (1 - COALESCE(v_it.discount_percent, 0) / 100);
    v_total_cogs := v_total_cogs + v_base_qty * v_cost_per_base;
    IF v_nonstock THEN
      v_qs_cogs := v_qs_cogs + v_base_qty * v_cost_per_base;
    END IF;
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
  SELECT id INTO v_shipping_account FROM accounts WHERE code = '4020' LIMIT 1;

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

  -- Refund split: money the customer paid from his ADVANCE WALLET goes back to
  -- that wallet (we hold it for him again, Cr 2300) — it never leaves the till
  -- as cash, and it must not become store credit either. Everything else is
  -- refunded through the chosen method exactly as before. The applications for
  -- this invoice are the source of truth for how much advance money is still
  -- funding it, and they are reduced as the money is handed back (so a later
  -- cancel restores only what is left).
  SELECT COALESCE(SUM(amount), 0) INTO v_adv_applied
    FROM customer_advance_applications
   WHERE invoice_id = p_invoice_id AND amount > 0;

  v_adv_refund := ROUND(LEAST(v_capped_refund, v_adv_applied), 2);
  v_cash_refund := ROUND(v_capped_refund - v_adv_refund, 2);

  IF v_adv_refund > 0 THEN
    SELECT id INTO v_adv_account FROM accounts WHERE code = '2300' LIMIT 1;
    IF v_adv_account IS NULL THEN
      RAISE EXCEPTION 'Customer Advances account (2300) is missing — cannot return advance-paid money on return %', v_return_number;
    END IF;

    v_adv_remaining := v_adv_refund;
    FOR v_adv_app IN
      SELECT id, advance_id, amount
        FROM customer_advance_applications
       WHERE invoice_id = p_invoice_id AND amount > 0
       ORDER BY created_at ASC, id ASC
    LOOP
      EXIT WHEN v_adv_remaining <= 0.001;
      v_adv_take := LEAST(v_adv_app.amount, v_adv_remaining);

      UPDATE customer_advances ca
         SET balance = COALESCE(ca.balance, 0) + v_adv_take,
             status = CASE WHEN ca.status IN ('applied', 'refunded') THEN 'active' ELSE ca.status END,
             updated_at = op_at()
       WHERE ca.id = v_adv_app.advance_id;

      IF v_adv_take >= v_adv_app.amount - 0.001 THEN
        DELETE FROM customer_advance_applications WHERE id = v_adv_app.id;
      ELSE
        UPDATE customer_advance_applications
           SET amount = amount - v_adv_take,
               notes = COALESCE(notes, '') || ' | ' || v_adv_take || ' returned to wallet via ' || v_return_number
         WHERE id = v_adv_app.id;
      END IF;

      v_adv_remaining := v_adv_remaining - v_adv_take;
    END LOOP;

    -- What could not be matched back to a wallet (never expected) falls back to
    -- the ordinary refund path rather than posting an unbalanced journal.
    v_adv_refund := ROUND(v_adv_refund - v_adv_remaining, 2);
    v_cash_refund := ROUND(v_capped_refund - v_adv_refund, 2);
  END IF;

  SELECT id INTO v_wh FROM warehouses WHERE is_default AND is_active LIMIT 1;
  v_wh := COALESCE(v_wh, '11000000-0000-0000-0000-000000000001');

  INSERT INTO sales_returns (tenant_id, return_number, invoice_id, customer_id, return_date,
                             total_refund_amount, refund_method, status, notes, created_by)
  VALUES (v_tenant, v_return_number, p_invoice_id, v_invoice.customer_id, op_date(),
          v_capped_refund, COALESCE(p_refund_method, 'store_credit'), 'completed',
          CASE WHEN v_adv_refund > 0
               THEN v_adv_refund || ' returned to the customer advance wallet'
               ELSE NULL END,
          p_created_by)
  RETURNING id INTO v_return_id;

  v_vat_portion := CASE
    WHEN COALESCE(v_invoice.tax_amount, 0) > 0 AND v_invoice.total_amount > 0
    THEN round(v_capped_refund * v_invoice.tax_amount / v_invoice.total_amount, 2)
    ELSE 0 END;
  IF v_vat_portion > 0 AND v_vat_account IS NULL THEN
    RAISE EXCEPTION 'Invoice % carries VAT but VAT Payable account (2100) is missing', v_invoice.invoice_number;
  END IF;

  v_shipping_portion := CASE
    WHEN COALESCE(v_invoice.shipping_cost, 0) > 0 AND v_invoice.total_amount > 0
    THEN round(v_capped_refund * v_invoice.shipping_cost / v_invoice.total_amount, 2)
    ELSE 0 END;
  IF v_shipping_portion > 0 AND v_shipping_account IS NULL THEN
    RAISE EXCEPTION 'Invoice % carries shipping but Shipping Income account (4020) is missing', v_invoice.invoice_number;
  END IF;

  v_lines := to_json(ARRAY[]::json[]);
  IF v_vat_portion > 0 THEN
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_sr_account, 'debit', v_capped_refund - v_vat_portion - v_shipping_portion, 'credit', 0,
      'description', 'Sales Return (net of VAT and shipping) - ' || v_return_number)))::json);
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_vat_account, 'debit', v_vat_portion, 'credit', 0,
      'description', 'VAT reversal for return ' || v_return_number)))::json);
  ELSE
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_sr_account, 'debit', v_capped_refund - v_shipping_portion, 'credit', 0,
      'description', 'Sales Return - ' || v_return_number)))::json);
  END IF;
  IF v_shipping_portion > 0 THEN
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_shipping_account, 'debit', v_shipping_portion, 'credit', 0,
      'description', 'Shipping reversal for return ' || v_return_number)))::json);
  END IF;
  IF v_adv_refund > 0 THEN
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_adv_account, 'debit', 0, 'credit', v_adv_refund,
      'description', 'Advance balance restored - ' || v_return_number)))::json);
  END IF;
  IF v_cash_refund > 0 THEN
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_credit_account, 'debit', 0, 'credit', v_cash_refund,
      'description', CASE WHEN p_refund_method = 'store_credit' THEN 'Customer Store Credit' ELSE 'Refund via ' || COALESCE(p_refund_method, 'payment') END)))::json);
  END IF;
  IF v_total_cogs > 0 THEN
    -- Quick-sell portion was credited to the paid-from account, not 1200.
    v_stocked_cogs := ROUND(v_total_cogs - v_qs_cogs, 2);
    IF v_stocked_cogs > 0 THEN
      v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
        'account_id', v_inv_account, 'debit', v_stocked_cogs, 'credit', 0,
        'description', 'Inventory restored from return')))::json);
    END IF;
    IF v_qs_cogs > 0 THEN
      v_paid_account := quick_sell_cost_account(v_invoice.cost_payment_method);
      IF v_paid_account IS NULL THEN
        RAISE EXCEPTION 'Cannot reverse quick-sell cost for return %: paid-from account unavailable', v_return_number;
      END IF;
      v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
        'account_id', v_paid_account, 'debit', ROUND(v_qs_cogs, 2), 'credit', 0,
        'description', 'Reverse source-shop payment for returned quick-sell items')))::json);
    END IF;
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_cogs_account, 'debit', 0, 'credit', v_total_cogs,
      'description', 'COGS reversal for returned items')))::json);
  END IF;

  v_je_id := post_journal_entry(
    'Sales Return ' || v_return_number || ' - Invoice ' || v_invoice.invoice_number,
    op_date(),
    'sales_return',
    v_return_id,
    v_lines,
    v_invoice.customer_id,
    NULL
  );

  UPDATE sales_returns SET journal_entry_id = v_je_id WHERE id = v_return_id;

  IF p_refund_method <> 'store_credit' AND v_cash_refund > 0 THEN
    INSERT INTO payments (payment_number, payment_type, reference_type, reference_id,
                          customer_id, amount, payment_method, payment_date, notes)
    VALUES (COALESCE(generate_payment_number(), 'PAY-' || to_char(clock_timestamp(), 'YYMMDDHH24MISS')),
            'refund', 'refund', v_je_id, v_invoice.customer_id, v_cash_refund,
            COALESCE(p_refund_method, 'cash'), op_date(),
            'Refund for sales return ' || v_return_number)
    RETURNING id INTO v_payment_id;

    UPDATE sales_returns SET payment_id = v_payment_id WHERE id = v_return_id;
  END IF;

  -- Items: return rows, FIFO restore (batch-accurate), movements, counters.
  -- Non-stock items record the return row ONLY — no batch restore (would
  -- fabricate a positive layer), no stock movement, no counter update.
  FOR v_item IN SELECT * FROM json_array_elements(p_items) LOOP
    IF COALESCE((v_item->>'quantity')::numeric, 0) <= 0 THEN
      CONTINUE;
    END IF;
    SELECT * INTO v_it FROM invoice_items WHERE id = (v_item->>'invoice_item_id')::uuid;
    SELECT COALESCE(NOT pr.track_inventory, false) INTO v_nonstock
    FROM products pr WHERE pr.id = v_it.product_id;

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

    IF NOT v_nonstock THEN
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
        SET quantity_on_hand = quantity_on_hand + v_base_qty, updated_at = op_at()
        WHERE id = v_inv_item.id;
      ELSE
        INSERT INTO inventory_items (tenant_id, product_id, warehouse_id, quantity_on_hand)
        VALUES (v_tenant, v_it.product_id, v_wh, v_base_qty);
      END IF;

      -- Heal any IOU layer the returned units repay + resync counter from ledger
      PERFORM heal_negative_batches_and_resync(v_it.product_id, v_wh);
    END IF;
  END LOOP;

  v_new_refunded := COALESCE(v_invoice.refunded_amount, 0) + v_capped_refund;
  v_new_status := CASE
    WHEN v_new_refunded >= COALESCE(v_invoice.total_amount, 0) THEN 'refunded'
    WHEN COALESCE(v_invoice.total_amount, 0) - COALESCE(v_invoice.bad_debt_amount, 0) - COALESCE(v_invoice.amount_paid, 0) <= 0 THEN 'paid'
    WHEN COALESCE(v_invoice.amount_paid, 0) > 0 THEN 'partially_paid'
    ELSE 'sent'
  END;
  UPDATE invoices SET refunded_amount = v_new_refunded, status = v_new_status, updated_at = op_at()
  WHERE id = p_invoice_id;

  IF p_refund_method = 'store_credit' AND v_invoice.customer_id IS NOT NULL AND v_cash_refund > 0 THEN
    INSERT INTO customer_store_credits (customer_id, sales_return_id, credit_number,
                                        amount, balance, status, notes)
    VALUES (v_invoice.customer_id, v_return_id,
            COALESCE(generate_credit_number(), 'SC-' || to_char(clock_timestamp(), 'YYMMDDHH24MISS')),
            v_cash_refund, v_cash_refund, 'active',
            'Store credit from return ' || v_return_number || ' (Invoice ' || v_invoice.invoice_number || ')');
  END IF;

  RETURN json_build_object(
    'return_id', v_return_id,
    'return_number', v_return_number,
    'journal_entry_id', v_je_id,
    'refund_amount', v_capped_refund,
    'advance_refunded', v_adv_refund,
    'cash_refund_amount', v_cash_refund,
    'cogs_reversal', v_total_cogs
  );
END $function$

CREATE OR REPLACE FUNCTION public.restore_stock_on_invoice_item_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_invoice_record RECORD;
  v_target_wh uuid;
  v_qty_to_restore numeric;
  v_inv_id uuid;
  v_product_cost numeric;
  v_existing_movement RECORD;
BEGIN
  -- Quick-sell (non-stock) products have no stock to restore.
  IF NOT COALESCE((SELECT p.track_inventory FROM products p WHERE p.id = OLD.product_id), true) THEN
    RETURN OLD;
  END IF;

  -- Skip if called from within edit_invoice (it handles stock restoration itself)
  IF current_setting('app.edit_invoice_active', true) = 'true' THEN
    RETURN OLD;
  END IF;

  SELECT * INTO v_invoice_record FROM invoices WHERE id = OLD.invoice_id;
  IF NOT FOUND THEN
    RETURN OLD;
  END IF;

  IF v_invoice_record.status = 'cancelled' THEN
    RETURN OLD;
  END IF;

  SELECT * INTO v_existing_movement
  FROM stock_movements
  WHERE reference_id = OLD.invoice_id
    AND reference_type = 'invoice'
    AND product_id = OLD.product_id
    AND movement_type = 'sale'
    AND notes LIKE '%invoice_item:' || OLD.id::text || '%'
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN OLD;
  END IF;

  v_qty_to_restore := ABS(v_existing_movement.quantity);

  v_target_wh := v_existing_movement.warehouse_id;

  IF v_target_wh IS NULL THEN
    v_target_wh := OLD.warehouse_id;
  END IF;

  IF v_target_wh IS NULL THEN
    SELECT id INTO v_target_wh FROM warehouses WHERE is_default = true AND is_active = true LIMIT 1;
  END IF;

  IF v_target_wh IS NULL THEN
    RETURN OLD;
  END IF;

  SELECT id INTO v_inv_id
  FROM inventory_items
  WHERE product_id = OLD.product_id AND warehouse_id = v_target_wh
  FOR UPDATE;

  IF v_inv_id IS NOT NULL THEN
    UPDATE inventory_items
    SET quantity_on_hand = quantity_on_hand + v_qty_to_restore,
        updated_at = op_at()
    WHERE id = v_inv_id;
  ELSE
    INSERT INTO inventory_items (product_id, warehouse_id, quantity_on_hand, quantity_reserved, quantity_incoming)
    VALUES (OLD.product_id, v_target_wh, v_qty_to_restore, 0, 0);
  END IF;

  SELECT cost_price INTO v_product_cost FROM products WHERE id = OLD.product_id;

  INSERT INTO stock_movements (
    product_id, warehouse_id, movement_type, quantity,
    unit_cost, reference_type, reference_id, reference_number, notes
  ) VALUES (
    OLD.product_id, v_target_wh, 'return_in', v_qty_to_restore,
    COALESCE(v_product_cost, 0), 'invoice', OLD.invoice_id,
    v_invoice_record.invoice_number,
    'Stock restoration - invoice item deleted - invoice_item:' || OLD.id::text
  );

  PERFORM heal_negative_batches_and_resync(OLD.product_id, v_target_wh);

  RETURN OLD;
END;
$function$

CREATE OR REPLACE FUNCTION public.sync_advance_apply(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_advance  customer_advances%rowtype;
  v_amount   numeric;
  v_acc_2300 uuid;
  v_acc_1100 uuid;
begin
  v_amount := coalesce((p_payload->>'amount')::numeric, 0);
  if v_amount <= 0 then
    raise exception 'advance.apply: amount must be greater than 0';
  end if;

  select * into v_advance from customer_advances
    where id = (p_payload->>'advance_id')::uuid for update;
  if not found then
    raise exception 'advance.apply: advance not found';
  end if;
  if v_amount > coalesce(v_advance.balance, 0) + 0.001 then
    return jsonb_build_object(
      'status', 'conflict',
      'reason', format('Advance balance on the server is %s — less than the amount being applied',
        coalesce(v_advance.balance, 0)),
      'server_row', to_jsonb(v_advance)
    );
  end if;

  insert into customer_advance_applications (advance_id, customer_id, invoice_id, amount, notes)
  values (v_advance.id, v_advance.customer_id, (p_payload->>'invoice_id')::uuid, v_amount,
    'Advance ' || v_advance.advance_number || ' applied to invoice');

  update customer_advances set
    balance = coalesce(balance, 0) - v_amount,
    status = case when coalesce(balance, 0) - v_amount <= 0.001 then 'applied' else 'active' end,
    updated_at = op_at()
  where id = v_advance.id;

  select id into v_acc_2300 from accounts where code = '2300' limit 1;
  select id into v_acc_1100 from accounts where code = '1100' limit 1;
  if v_acc_2300 is not null and v_acc_1100 is not null then
    perform public.post_journal_entry(
      'Advance ' || v_advance.advance_number || ' applied to invoice',
      op_date(),
      'advance_application',
      v_advance.id,
      json_build_array(
        json_build_object('account_id', v_acc_2300, 'debit', v_amount, 'credit', 0,
          'description', 'Advance applied - ' || v_advance.advance_number),
        json_build_object('account_id', v_acc_1100, 'debit', 0, 'credit', v_amount,
          'description', 'AR cleared - advance ' || v_advance.advance_number)
      )::json,
      v_advance.customer_id
    );
  end if;

  update invoices set
    amount_paid = coalesce(amount_paid, 0) + v_amount,
    status = case
      when total_amount - (coalesce(amount_paid, 0) + v_amount) - coalesce(bad_debt_amount, 0) <= 0.001
        then 'paid' else 'partially_paid' end,
    updated_at = op_at()
  where id = (p_payload->>'invoice_id')::uuid;

  return jsonb_build_object(
    'status', 'synced',
    'advance_id', v_advance.id,
    'applied_amount', v_amount
  );
end;
$function$

CREATE OR REPLACE FUNCTION public.sync_advance_receive(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_id     uuid;
  v_number text;
begin
  if coalesce((p_payload->>'amount')::numeric, 0) <= 0 then
    raise exception 'advance.receive: amount must be greater than 0';
  end if;

  insert into customer_advances (customer_id, amount, balance, status, payment_method,
    payment_date, reference_number, notes)
  values ((p_payload->>'customer_id')::uuid,
    (p_payload->>'amount')::numeric,
    (p_payload->>'amount')::numeric,
    'active',
    coalesce(p_payload->>'payment_method', 'cash'),
    coalesce(nullif(p_payload->>'payment_date', '')::date, op_date()),
    nullif(p_payload->>'reference_number', ''),
    nullif(p_payload->>'notes', ''))
  returning id, advance_number into v_id, v_number;

  return jsonb_build_object('status', 'synced', 'advance_id', v_id, 'advance_number', v_number);
end;
$function$

CREATE OR REPLACE FUNCTION public.sync_advance_refund(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_advance  customer_advances%rowtype;
  v_amount   numeric;
  v_acc_2300 uuid;
  v_cash_acc uuid;
begin
  v_amount := coalesce((p_payload->>'amount')::numeric, 0);
  if v_amount <= 0 then
    raise exception 'advance.refund: amount must be greater than 0';
  end if;

  select * into v_advance from customer_advances
    where id = (p_payload->>'advance_id')::uuid for update;
  if not found then
    raise exception 'advance.refund: advance not found';
  end if;
  if v_amount > coalesce(v_advance.balance, 0) + 0.001 then
    return jsonb_build_object(
      'status', 'conflict',
      'reason', format('Advance balance on the server is %s — less than the refund amount',
        coalesce(v_advance.balance, 0)),
      'server_row', to_jsonb(v_advance)
    );
  end if;

  insert into customer_advance_refunds (advance_id, customer_id, amount, refund_method,
    refund_date, reference_number, notes)
  values (v_advance.id, v_advance.customer_id, v_amount,
    coalesce(p_payload->>'refund_method', 'cash'),
    coalesce(nullif(p_payload->>'refund_date', '')::date, op_date()),
    nullif(p_payload->>'reference_number', ''),
    nullif(p_payload->>'notes', ''));

  update customer_advances set
    balance = coalesce(balance, 0) - v_amount,
    status = case when coalesce(balance, 0) - v_amount <= 0.001 then 'refunded' else 'active' end,
    updated_at = op_at()
  where id = v_advance.id;

  select id into v_acc_2300 from accounts where code = '2300' limit 1;
  select pm.account_id into v_cash_acc from payment_methods pm
    where pm.code = coalesce(p_payload->>'refund_method', 'cash') and pm.is_active limit 1;
  if v_cash_acc is null then
    select id into v_cash_acc from accounts where code = '1001' limit 1;
  end if;

  if v_acc_2300 is not null and v_cash_acc is not null then
    perform public.post_journal_entry(
      'Advance refund - ' || v_advance.advance_number,
      coalesce(nullif(p_payload->>'refund_date', '')::date, op_date()),
      'advance_refund',
      v_advance.id,
      json_build_array(
        json_build_object('account_id', v_acc_2300, 'debit', v_amount, 'credit', 0,
          'description', 'Advance refunded - ' || v_advance.advance_number),
        json_build_object('account_id', v_cash_acc, 'debit', 0, 'credit', v_amount,
          'description', 'Cash/Bank paid out - refund ' || v_advance.advance_number)
      )::json,
      v_advance.customer_id
    );
  end if;

  return jsonb_build_object(
    'status', 'synced',
    'advance_id', v_advance.id,
    'refunded_amount', v_amount
  );
end;
$function$

CREATE OR REPLACE FUNCTION public.sync_customer_update(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  d            jsonb := p_payload->'data';
  v_id         uuid  := (p_payload->>'id')::uuid;
  v_server_row jsonb;
begin
  select to_jsonb(c) into v_server_row from customers c where c.id = v_id;

  if v_server_row is null then
    return jsonb_build_object('status', 'conflict', 'reason', 'missing', 'server_row', 'null'::jsonb);
  end if;

  if not coalesce((p_payload->>'force')::boolean, false)
     and p_payload ? 'expected_updated_at'
     and (p_payload->>'expected_updated_at')::timestamptz
         is distinct from (v_server_row->>'updated_at')::timestamptz then
    return jsonb_build_object('status', 'conflict', 'reason', 'version_mismatch',
      'server_row', v_server_row);
  end if;

  update customers set
    name = d->>'name', type = d->>'type', phone = nullif(d->>'phone', ''),
    mobile = nullif(d->>'mobile', ''), email = nullif(d->>'email', ''),
    company_name = nullif(d->>'company_name', ''), city = nullif(d->>'city', ''),
    address = nullif(d->>'address', ''), tax_id = nullif(d->>'tax_id', ''),
    tags = case when jsonb_typeof(d->'tags') = 'array' then ARRAY(SELECT jsonb_array_elements_text(d->'tags')) else '{}'::text[] end,
    notes = nullif(d->>'notes', ''),
    credit_limit = coalesce((d->>'credit_limit')::numeric, 0),
    credit_days = coalesce((d->>'credit_days')::int, 0),
    loyalty_points = coalesce((d->>'loyalty_points')::int, 0),
    discount_percent = coalesce((d->>'discount_percent')::numeric, 0),
    is_active = coalesce((d->>'is_active')::boolean, true),
    country = d->>'country',
    updated_at = op_at()
  where id = v_id;

  return jsonb_build_object('status', 'synced', 'customer_id', v_id);
end;
$function$

CREATE OR REPLACE FUNCTION public.sync_delivery_status(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_status text := p_payload->>'status';
begin
  if v_status not in ('pending', 'assigned', 'in_transit', 'delivered', 'failed', 'returned', 'cancelled') then
    raise exception 'delivery.status: invalid status %', v_status;
  end if;

  update deliveries set
    status = v_status,
    delivered_at = case when v_status = 'delivered' then op_at() else delivered_at end,
    updated_at = op_at()
  where id = (p_payload->>'id')::uuid;

  if not found then
    raise exception 'delivery.status: delivery not found';
  end if;

  return jsonb_build_object('status', 'synced', 'delivery_status', v_status);
end;
$function$

CREATE OR REPLACE FUNCTION public.sync_delivery_update(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_d deliveries%rowtype;
begin
  select * into v_d from deliveries where id = (p_payload->>'id')::uuid for update;
  if not found then
    raise exception 'delivery.update: delivery not found';
  end if;

  if coalesce((p_payload->>'force')::boolean, false) = false
     and p_payload ? 'expected_updated_at'
     and p_payload->>'expected_updated_at' <> ''
     and v_d.updated_at <> (p_payload->>'expected_updated_at')::timestamptz then
    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'Delivery changed on the server since this device last saw it',
      'server_row', to_jsonb(v_d)
    );
  end if;

  update deliveries set
    delivery_date   = nullif(p_payload->>'delivery_date', '')::date,
    delivery_address = nullif(p_payload->>'delivery_address', ''),
    delivery_city   = nullif(p_payload->>'delivery_city', ''),
    vehicle_number  = nullif(p_payload->>'vehicle_number', ''),
    notes           = nullif(p_payload->>'notes', ''),
    updated_at      = op_at()
  where id = v_d.id;

  return jsonb_build_object('status', 'synced', 'delivery_id', v_d.id);
end;
$function$

CREATE OR REPLACE FUNCTION public.sync_employee_update(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  d            jsonb := p_payload->'data';
  v_id         uuid  := (p_payload->>'id')::uuid;
  v_server_row jsonb;
begin
  select to_jsonb(e) into v_server_row from employees e where e.id = v_id;

  if v_server_row is null then
    return jsonb_build_object('status', 'conflict', 'reason', 'missing', 'server_row', 'null'::jsonb);
  end if;

  if not coalesce((p_payload->>'force')::boolean, false)
     and p_payload ? 'expected_updated_at'
     and (p_payload->>'expected_updated_at')::timestamptz
         is distinct from (v_server_row->>'updated_at')::timestamptz then
    return jsonb_build_object('status', 'conflict', 'reason', 'version_mismatch',
      'server_row', v_server_row);
  end if;

  update employees set
    employee_id = d->>'employee_id',
    full_name = d->>'full_name',
    designation = d->>'designation',
    department = d->>'department',
    email = nullif(d->>'email', ''),
    phone = nullif(d->>'phone', ''),
    salary = coalesce((d->>'salary')::numeric, 0),
    join_date = (d->>'join_date')::date,
    status = coalesce(d->>'status', 'active'),
    updated_at = op_at()
  where id = v_id;

  return jsonb_build_object('status', 'synced', 'employee_id', v_id);
end;
$function$

CREATE OR REPLACE FUNCTION public.sync_expense_create(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_amount  numeric;
  v_acc_id  uuid;
  v_code    text;
  v_res     json;
begin
  v_amount := coalesce((p_payload->>'amount')::numeric, 0);
  if v_amount <= 0 then
    raise exception 'expense.create: amount must be greater than 0';
  end if;

  v_acc_id := nullif(p_payload->>'expense_account_id', '')::uuid;
  if v_acc_id is null then
    if nullif(p_payload->>'new_account_name', '') is null then
      raise exception 'expense.create: expense_account_id or new_account_name is required';
    end if;
    select '6' || lpad((max((regexp_replace(code, '[^0-9]', '', 'g'))::int) + 1)::text, 3, '0')
      into v_code
      from accounts where code ~ '^6[0-9]{3}$';
    if v_code is null then
      v_code := '6001';
    end if;
    insert into accounts (code, name, account_type)
      values (v_code, p_payload->>'new_account_name', 'expense')
      returning id into v_acc_id;
  end if;

  v_res := public.post_manual_journal_entry(
    coalesce(nullif(p_payload->>'date', '')::date, op_date()),
    coalesce(p_payload->>'description', 'Expense payment'),
    'manual',
    null, null, null,
    json_build_array(
      json_build_object('account_id', v_acc_id, 'debit', v_amount, 'credit', 0,
        'description', p_payload->>'description'),
      json_build_object('account_id', (p_payload->>'paid_from')::uuid, 'debit', 0, 'credit', v_amount,
        'description', p_payload->>'description')
    )::json
  );

  return to_jsonb(v_res) || jsonb_build_object('status', 'synced');
end;
$function$

CREATE OR REPLACE FUNCTION public.sync_expense_update(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_amount numeric;
  v_res    json;
begin
  v_amount := coalesce((p_payload->>'amount')::numeric, 0);
  if v_amount <= 0 then
    raise exception 'expense.update: amount must be greater than 0';
  end if;

  v_res := public.edit_manual_journal_entry(
    (p_payload->>'entry_id')::uuid,
    coalesce(nullif(p_payload->>'date', '')::date, op_date()),
    coalesce(p_payload->>'description', 'Expense payment'),
    json_build_array(
      json_build_object('account_id', (p_payload->>'expense_account_id')::uuid,
        'debit', v_amount, 'credit', 0, 'description', p_payload->>'description'),
      json_build_object('account_id', (p_payload->>'paid_from')::uuid, 'debit', 0, 'credit', v_amount,
        'description', p_payload->>'description')
    )::json,
    false
  );

  return to_jsonb(v_res) || jsonb_build_object('status', 'synced');
end;
$function$

CREATE OR REPLACE FUNCTION public.sync_invoice_create(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_key         text;
  v_is_pos      boolean;
  v_number      text;
  v_invoice_id  uuid;
  v_customer    uuid;
  v_date        date;
  v_store_credit numeric;
  v_cash        numeric;
  v_remaining   numeric;
  v_redeem      numeric;
  v_scnum       text;
  v_pnum        text;
  v_credit      record;
begin
  v_customer     := (p_payload->>'customer_id')::uuid;
  v_date         := (p_payload->>'invoice_date')::date;
  v_store_credit := coalesce((p_payload->>'store_credit_amount')::numeric, 0);
  v_cash         := coalesce((p_payload->'cash_payment'->>'amount')::numeric, 0);
  v_key          := nullif(p_payload->>'idempotency_key', '');
  v_is_pos       := coalesce((p_payload->>'is_pos')::boolean, true);

  if v_customer is null then
    raise exception 'invoice.create: customer_id is required';
  end if;
  if p_payload->'items' is null or jsonb_array_length(p_payload->'items') = 0 then
    raise exception 'invoice.create: items array is required';
  end if;

  -- Same charge intent already applied (a duplicate outbox item)? Hand back
  -- the original invoice; the sync engine treats "duplicate" as applied.
  if v_key is not null then
    select id, invoice_number into v_invoice_id, v_number
    from invoices
    where idempotency_key = v_key;
    if v_invoice_id is not null then
      return jsonb_build_object(
        'status', 'duplicate',
        'invoice_id', v_invoice_id,
        'invoice_number', v_number
      );
    end if;
  end if;

  if v_is_pos then
    v_number := public.generate_pos_number();
  else
    v_number := public.generate_invoice_number();
  end if;

  if p_payload ? 'id' then
    insert into invoices (id, invoice_number, customer_id, invoice_date, due_date, subtotal, discount_amount,
      cart_discount_percent, extra_discount, tax_amount, shipping_cost, total_amount, amount_paid,
      status, is_pos, reference, notes, idempotency_key, client_temp_number)
    values ((p_payload->>'id')::uuid, v_number, v_customer, v_date,
      nullif(p_payload->>'due_date', '')::date,
      coalesce((p_payload->>'subtotal')::numeric, 0),
      coalesce((p_payload->>'discount_amount')::numeric, 0),
      coalesce((p_payload->>'cart_discount_percent')::numeric, 0),
      coalesce((p_payload->>'extra_discount')::numeric, 0),
      coalesce((p_payload->>'tax_amount')::numeric, 0),
      coalesce((p_payload->>'shipping_cost')::numeric, 0),
      coalesce((p_payload->>'total_amount')::numeric, 0),
      coalesce((p_payload->>'amount_paid')::numeric, 0),
      coalesce(p_payload->>'status', 'draft'),
      v_is_pos,
      nullif(p_payload->>'reference', ''),
      nullif(p_payload->>'notes', ''),
      v_key,
      nullif(p_payload->>'temp_number', ''))
    returning id into v_invoice_id;
  else
    insert into invoices (invoice_number, customer_id, invoice_date, due_date, subtotal, discount_amount,
      cart_discount_percent, extra_discount, tax_amount, shipping_cost, total_amount, amount_paid,
      status, is_pos, reference, notes, idempotency_key, client_temp_number)
    values (v_number, v_customer, v_date,
      nullif(p_payload->>'due_date', '')::date,
      coalesce((p_payload->>'subtotal')::numeric, 0),
      coalesce((p_payload->>'discount_amount')::numeric, 0),
      coalesce((p_payload->>'cart_discount_percent')::numeric, 0),
      coalesce((p_payload->>'extra_discount')::numeric, 0),
      coalesce((p_payload->>'tax_amount')::numeric, 0),
      coalesce((p_payload->>'shipping_cost')::numeric, 0),
      coalesce((p_payload->>'total_amount')::numeric, 0),
      coalesce((p_payload->>'amount_paid')::numeric, 0),
      coalesce(p_payload->>'status', 'draft'),
      v_is_pos,
      nullif(p_payload->>'reference', ''),
      nullif(p_payload->>'notes', ''),
      v_key,
      nullif(p_payload->>'temp_number', ''))
    returning id into v_invoice_id;
  end if;

  insert into invoice_items (invoice_id, product_id, description, quantity, unit_price,
    discount_percent, tax_rate, subtotal, cost_price, unit_name, unit_conversion_factor,
    base_quantity, warehouse_id, sort_order)
  select v_invoice_id,
    (r->>'product_id')::uuid,
    nullif(r->>'description', ''),
    (r->>'quantity')::numeric,
    (r->>'unit_price')::numeric,
    coalesce((r->>'discount_percent')::numeric, 0),
    coalesce((r->>'tax_rate')::numeric, 0),
    (r->>'subtotal')::numeric,
    coalesce((r->>'cost_price')::numeric, 0),
    nullif(r->>'unit_name', ''),
    (r->>'unit_conversion_factor')::numeric,
    (r->>'base_quantity')::numeric,
    nullif(r->>'warehouse_id', '')::uuid,
    coalesce(nullif(r->>'sort_order', '')::int, 0)
  from jsonb_array_elements(p_payload->'items') r;

  insert into cost_price_history (product_id, product_name, product_sku, invoice_id, unit,
    quantity, unit_price, cost_price_per_qty, cost_price_for_added_qty,
    total_cost_price_single, total_cost_price_added)
  select (r->>'product_id')::uuid,
    r->>'product_name',
    coalesce(r->>'product_sku', ''),
    v_invoice_id,
    coalesce(r->>'unit', 'pcs'),
    (r->>'quantity')::numeric,
    (r->>'unit_price')::numeric,
    coalesce((r->>'cost_price_per_qty')::numeric, 0),
    coalesce((r->>'cost_price_for_added_qty')::numeric, 0),
    coalesce((r->>'total_cost_price_single')::numeric, 0),
    coalesce((r->>'total_cost_price_added')::numeric, 0)
  from jsonb_array_elements(
    case when jsonb_typeof(p_payload->'cost_history') = 'array'
      then p_payload->'cost_history' else '[]'::jsonb end) r;

  -- Store credit: same fresh re-select + oldest-first redemption loop as POS.
  if v_store_credit > 0 then
    v_remaining := v_store_credit;
    for v_credit in
      select id, balance
      from customer_store_credits
      where customer_id = v_customer
        and status = 'active'
        and (expires_at is null or expires_at > now() /* B5: credit-expiry decision stays on the wall clock for now */)
      order by created_at asc
    loop
      exit when v_remaining <= 0;
      v_redeem := least(coalesce(v_credit.balance, 0), v_remaining);
      if v_redeem > 0 then
        insert into store_credit_redemptions (store_credit_id, customer_id, invoice_id, amount, notes)
        values (v_credit.id, v_customer, v_invoice_id, v_redeem, 'Redeemed for ' || v_number);
        v_remaining := v_remaining - v_redeem;
      end if;
    end loop;

    v_scnum := public.generate_payment_number();
    insert into payments (payment_number, payment_type, reference_type, reference_id, customer_id,
      amount, payment_method, payment_date, notes, payment_for)
    values ('PAY-SC-' || replace(coalesce(v_scnum, ''), 'PAY-', ''),
      'received', 'invoice', v_invoice_id, v_customer,
      v_store_credit, 'store_credit', v_date,
      'Store credit redeemed for ' || v_number, 'paid_invoice_pay');
  end if;

  if v_cash > 0 then
    v_pnum := public.generate_payment_number();
    insert into payments (payment_number, payment_type, reference_type, reference_id, customer_id,
      amount, payment_method, payment_date, reference_number, notes, payment_for)
    values (coalesce(v_pnum, 'PAY-' || to_char(op_at(), 'HH24MISS')),
      'received', 'invoice', v_invoice_id, v_customer,
      v_cash,
      coalesce(p_payload->'cash_payment'->>'method', 'cash'),
      v_date,
      nullif(p_payload->'cash_payment'->>'reference_number', ''),
      coalesce(nullif(p_payload->'cash_payment'->>'notes', ''),
        case when v_store_credit > 0 then 'POS sale (partial store credit)' else 'POS sale' end),
      'paid_invoice_pay');
  end if;

  return jsonb_build_object(
    'status', 'synced',
    'invoice_id', v_invoice_id,
    'invoice_number', v_number
  );
end;
$function$

CREATE OR REPLACE FUNCTION public.sync_invoice_status(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_invoice invoices%rowtype;
  v_status  text;
begin
  v_status := p_payload->>'status';
  if v_status is null or v_status = '' then
    raise exception 'invoice.status: status is required';
  end if;
  if v_status = 'cancelled' then
    raise exception 'invoice.status: use invoice.cancel, not a status update';
  end if;

  select * into v_invoice from invoices where id = (p_payload->>'invoice_id')::uuid for update;
  if not found then
    raise exception 'invoice.status: invoice not found';
  end if;

  if coalesce((p_payload->>'force')::boolean, false) = false
     and p_payload ? 'expected_updated_at'
     and p_payload->>'expected_updated_at' <> ''
     and v_invoice.updated_at <> (p_payload->>'expected_updated_at')::timestamptz then
    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'Invoice changed on the server since this device last saw it',
      'server_row', to_jsonb(v_invoice)
    );
  end if;

  update invoices set status = v_status, updated_at = op_at() where id = v_invoice.id;

  return jsonb_build_object('status', 'synced', 'invoice_status', v_status);
end;
$function$

CREATE OR REPLACE FUNCTION public.sync_payment_create(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_invoice   invoices%rowtype;
  v_amount    numeric;
  v_bad       numeric;
  v_new_bal   numeric;
  v_status    text;
  v_num       text;
  v_collected uuid;
  v_collection uuid;
begin
  v_amount := coalesce((p_payload->>'amount')::numeric, 0);
  v_bad    := coalesce((p_payload->>'bad_debt_amount')::numeric, 0);

  if v_amount + v_bad <= 0 then
    raise exception 'payment.create: amount or bad_debt_amount must be greater than 0';
  end if;

  -- Offline POS due collection link. The queued sale always syncs before this
  -- payment (strict outbox order), so the invoice must exist — if it does
  -- not, the outbox item was discarded manually and this op should fail
  -- loudly in the Sync Center rather than post an unlinked collection.
  v_collected := nullif(p_payload->>'collected_with_invoice_id', '')::uuid;
  if v_collected is not null and not exists (select 1 from invoices where id = v_collected) then
    raise exception 'payment.create: collected_with invoice % not found', v_collected;
  end if;

  select * into v_invoice from invoices where id = (p_payload->>'invoice_id')::uuid for update;
  if not found then
    raise exception 'payment.create: invoice not found';
  end if;
  if v_invoice.status = 'cancelled' then
    raise exception 'payment.create: invoice % is cancelled', v_invoice.invoice_number;
  end if;

  v_new_bal := v_invoice.total_amount
    - (coalesce(v_invoice.amount_paid, 0) + v_amount)
    - (coalesce(v_invoice.bad_debt_amount, 0) + v_bad);
  if v_new_bal < -0.01 and coalesce((p_payload->>'force')::boolean, false) = false then
    return jsonb_build_object(
      'status', 'conflict',
      'reason', format('Payment exceeds balance due (server balance: %s)',
        (v_invoice.total_amount - coalesce(v_invoice.amount_paid, 0) - coalesce(v_invoice.bad_debt_amount, 0))),
      'server_row', to_jsonb(v_invoice)
    );
  end if;

  v_status := case when v_new_bal <= 0.01 then 'paid' else 'partially_paid' end;

  v_num := public.generate_payment_number();
  insert into payments (payment_number, payment_type, reference_type, reference_id, customer_id,
    amount, bad_debt_amount, payment_method, payment_date, reference_number, notes, payment_for,
    collected_with_invoice_id, collection_id)
  values (coalesce(v_num, 'PAY-' || to_char(op_at(), 'HH24MISS')),
    'received', 'invoice', v_invoice.id, v_invoice.customer_id,
    v_amount, coalesce(nullif(p_payload->>'bad_debt_amount', '')::numeric, 0),
    coalesce(p_payload->>'payment_method', 'cash'),
    coalesce(nullif(p_payload->>'payment_date', '')::date, op_date()),
    nullif(p_payload->>'reference_number', ''),
    nullif(p_payload->>'notes', ''),
    coalesce(p_payload->>'payment_for', 'paid_invoice_pay'),
    v_collected,
    nullif(p_payload->>'collection_id', '')::uuid);

  update invoices set
    amount_paid = coalesce(amount_paid, 0) + v_amount,
    bad_debt_amount = coalesce(bad_debt_amount, 0) + v_bad,
    status = v_status,
    updated_at = op_at()
  where id = v_invoice.id;

  return jsonb_build_object(
    'status', 'synced',
    'payment_number', v_num,
    'invoice_status', v_status
  );
end;
$function$

CREATE OR REPLACE FUNCTION public.sync_po_cancel(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_po     purchase_orders%rowtype;
  v_item   record;
  v_wh     uuid;
  v_inv_id uuid;
  v_qty    numeric;
begin
  select * into v_po from purchase_orders where id = (p_payload->>'id')::uuid for update;
  if not found then
    raise exception 'po.cancel: purchase order not found';
  end if;
  if v_po.status = 'cancelled' then
    return jsonb_build_object('status', 'synced', 'po_id', v_po.id,
      'note', 'already cancelled');
  end if;

  update purchase_orders set
    status = 'cancelled',
    amount_paid = total_amount,
    updated_at = op_at()
  where id = v_po.id;
  -- purchase_order_cancellation_trigger reverses the receipt and payment
  -- journal entries and the account balances.

  update payments set is_reversed = true
  where reference_type = 'purchase_order'
    and reference_id = v_po.id
    and is_reversed = false;

  if v_po.status in ('received', 'partially_received') then
    select id into v_wh from warehouses where is_default limit 1;
    for v_item in
      select product_id, quantity, warehouse_id, base_quantity
      from purchase_order_items where purchase_order_id = v_po.id
    loop
      v_qty := coalesce(v_item.base_quantity, v_item.quantity);
      v_inv_id := null;
      if coalesce(v_item.warehouse_id, v_wh) is not null then
        select id into v_inv_id from inventory_items
        where product_id = v_item.product_id
          and warehouse_id = coalesce(v_item.warehouse_id, v_wh)
        limit 1;
        if v_inv_id is not null then
          update inventory_items set
            quantity_on_hand = greatest(0, quantity_on_hand - v_qty),
            updated_at = op_at()
          where id = v_inv_id;
        end if;
        insert into stock_movements (tenant_id, product_id, warehouse_id, movement_type,
          quantity, reference_type, reference_id, reference_number, notes)
        values ('00000000-0000-0000-0000-000000000001', v_item.product_id,
          coalesce(v_item.warehouse_id, v_wh), 'purchase_return', -v_qty,
          'purchase_order', v_po.id, v_po.po_number, 'Stock reversed on PO cancellation');
      end if;
    end loop;
  end if;

  return jsonb_build_object('status', 'synced', 'po_id', v_po.id, 'po_number', v_po.po_number);
end;
$function$

CREATE OR REPLACE FUNCTION public.sync_po_create(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_supplier uuid;
  v_number   text;
  v_paid     numeric := COALESCE((p_payload->>'amount_paid')::numeric, 0);
  v_po_id    uuid;
  v_pnum     text;
BEGIN
  v_supplier := (p_payload->>'supplier_id')::uuid;
  IF v_supplier IS NULL THEN
    RAISE EXCEPTION 'po.create: supplier_id is required';
  END IF;
  IF p_payload->'items' IS NULL OR jsonb_array_length(p_payload->'items') = 0 THEN
    RAISE EXCEPTION 'po.create: items array is required';
  END IF;

  v_number := public.generate_purchase_order_number();

  IF p_payload ? 'id' THEN
    INSERT INTO purchase_orders (id, po_number, supplier_id, order_date, expected_date,
      subtotal, cart_discount_percent, extra_discount, discount_amount, total_amount,
      amount_paid, status, notes, reference)
    VALUES ((p_payload->>'id')::uuid, v_number, v_supplier,
      COALESCE(NULLIF(p_payload->>'order_date', '')::date, op_date()),
      NULLIF(p_payload->>'expected_date', '')::date,
      COALESCE((p_payload->>'subtotal')::numeric, 0),
      COALESCE((p_payload->>'cart_discount_percent')::numeric, 0),
      COALESCE((p_payload->>'extra_discount')::numeric, 0),
      COALESCE((p_payload->>'discount_amount')::numeric, 0),
      COALESCE((p_payload->>'total_amount')::numeric, 0),
      0, 'draft',
      NULLIF(p_payload->>'notes', ''),
      NULLIF(p_payload->>'reference', ''))
    RETURNING id INTO v_po_id;
  ELSE
    INSERT INTO purchase_orders (po_number, supplier_id, order_date, expected_date,
      subtotal, cart_discount_percent, extra_discount, discount_amount, total_amount,
      amount_paid, status, notes, reference)
    VALUES (v_number, v_supplier,
      COALESCE(NULLIF(p_payload->>'order_date', '')::date, op_date()),
      NULLIF(p_payload->>'expected_date', '')::date,
      COALESCE((p_payload->>'subtotal')::numeric, 0),
      COALESCE((p_payload->>'cart_discount_percent')::numeric, 0),
      COALESCE((p_payload->>'extra_discount')::numeric, 0),
      COALESCE((p_payload->>'discount_amount')::numeric, 0),
      COALESCE((p_payload->>'total_amount')::numeric, 0),
      0, 'draft',
      NULLIF(p_payload->>'notes', ''),
      NULLIF(p_payload->>'reference', ''))
    RETURNING id INTO v_po_id;
  END IF;

  INSERT INTO purchase_order_items (purchase_order_id, product_id, quantity, unit_cost,
    discount_percent, subtotal, unit_name, unit_conversion_factor, base_quantity, warehouse_id,
    sale_price, force_cost_update)
  SELECT v_po_id,
    (r->>'product_id')::uuid,
    (r->>'quantity')::numeric,
    (r->>'unit_cost')::numeric,
    COALESCE((r->>'discount_percent')::numeric, 0),
    (r->>'subtotal')::numeric,
    NULLIF(r->>'unit_name', ''),
    NULLIF(r->>'unit_conversion_factor', '')::numeric,
    (r->>'base_quantity')::numeric,
    NULLIF(r->>'warehouse_id', '')::uuid,
    NULLIF(r->>'sale_price', '')::numeric,
    COALESCE((r->>'force_cost_update')::boolean, false)
  FROM jsonb_array_elements(p_payload->'items') r;

  IF v_paid > 0 THEN
    v_pnum := public.generate_purchase_payment_number();
    INSERT INTO payments (payment_number, payment_type, reference_type, reference_id, supplier_id,
      amount, payment_method, payment_date, reference_number, notes, payment_for)
    VALUES (COALESCE(v_pnum, 'POPAY-' || to_char(op_at(), 'HH24MISS')),
      'made', 'purchase_order', v_po_id, v_supplier,
      v_paid,
      COALESCE(p_payload->>'payment_method', 'cash'),
      COALESCE(NULLIF(p_payload->>'payment_date', '')::date, op_date()),
      NULLIF(p_payload->>'payment_reference', ''),
      COALESCE(NULLIF(p_payload->>'payment_notes', ''),
        CASE WHEN v_paid >= (p_payload->>'total_amount')::numeric
          THEN 'Full payment at order time' ELSE 'Partial payment at order time' END),
      'supplier_payment');
  END IF;

  RETURN jsonb_build_object('status', 'synced', 'po_id', v_po_id, 'po_number', v_number);
END;
$function$

CREATE OR REPLACE FUNCTION public.sync_po_payment(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_po    purchase_orders%rowtype;
  v_amount numeric;
  v_wht   numeric;
  v_bal   numeric;
  v_num   text;
begin
  v_amount := coalesce((p_payload->>'amount')::numeric, 0);
  v_wht    := coalesce(nullif(p_payload->>'wht_amount', '')::numeric, 0);
  if v_amount <= 0 then
    raise exception 'po.payment: amount must be greater than 0';
  end if;

  select * into v_po from purchase_orders where id = (p_payload->>'po_id')::uuid for update;
  if not found then
    raise exception 'po.payment: purchase order not found';
  end if;
  if v_po.status = 'cancelled' then
    raise exception 'po.payment: purchase order % is cancelled', v_po.po_number;
  end if;

  v_bal := v_po.total_amount - coalesce(v_po.amount_paid, 0);
  if v_amount > v_bal + 0.01 and coalesce((p_payload->>'force')::boolean, false) = false then
    return jsonb_build_object(
      'status', 'conflict',
      'reason', format('Payment exceeds the outstanding balance (server balance: %s)', v_bal),
      'server_row', to_jsonb(v_po)
    );
  end if;

  v_num := public.generate_purchase_payment_number();
  insert into payments (payment_number, payment_type, reference_type, reference_id, supplier_id,
    amount, wht_amount, payment_method, payment_date, reference_number, notes, payment_for,
    collection_id)
  values (coalesce(v_num, 'POPAY-' || to_char(op_at(), 'HH24MISS')),
    'made', 'purchase_order', v_po.id, v_po.supplier_id,
    v_amount, v_wht,
    coalesce(p_payload->>'payment_method', 'cash'),
    coalesce(nullif(p_payload->>'payment_date', '')::date, op_date()),
    nullif(p_payload->>'reference_number', ''),
    nullif(p_payload->>'notes', ''),
    'supplier_payment',
    nullif(p_payload->>'collection_id', '')::uuid);

  return jsonb_build_object('status', 'synced', 'payment_number', v_num);
end;
$function$

CREATE OR REPLACE FUNCTION public.sync_po_status(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_po     purchase_orders%rowtype;
  v_status text := p_payload->>'status';
BEGIN
  IF v_status IN ('received', 'partially_received') THEN
    RAISE EXCEPTION 'po.status: receiving stock must go through the GRN flow (it maintains FIFO batches and journals)';
  END IF;

  SELECT * INTO v_po FROM purchase_orders WHERE id = (p_payload->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'po.status: purchase order not found';
  END IF;

  IF v_po.status = v_status THEN
    RETURN jsonb_build_object('status', 'synced', 'po_id', v_po.id, 'po_status', v_status);
  END IF;

  IF COALESCE((p_payload->>'force')::boolean, false) = false
     AND p_payload ? 'expected_updated_at'
     AND p_payload->>'expected_updated_at' <> ''
     AND v_po.updated_at <> (p_payload->>'expected_updated_at')::timestamptz THEN
    RETURN jsonb_build_object(
      'status', 'conflict',
      'reason', 'Purchase order changed on the server since this device last saw it',
      'server_row', to_jsonb(v_po)
    );
  END IF;

  UPDATE purchase_orders SET status = v_status, updated_at = op_at() WHERE id = v_po.id;

  RETURN jsonb_build_object('status', 'synced', 'po_id', v_po.id, 'po_status', v_status);
END;
$function$

CREATE OR REPLACE FUNCTION public.sync_po_update(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_po  purchase_orders%rowtype;
  v_new_total numeric;
BEGIN
  SELECT * INTO v_po FROM purchase_orders WHERE id = (p_payload->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'po.update: purchase order not found';
  END IF;
  IF v_po.status = 'cancelled' THEN
    RAISE EXCEPTION 'po.update: purchase order % is cancelled', v_po.po_number;
  END IF;

  IF COALESCE((p_payload->>'force')::boolean, false) = false
     AND p_payload ? 'expected_updated_at'
     AND p_payload->>'expected_updated_at' <> ''
     AND v_po.updated_at <> (p_payload->>'expected_updated_at')::timestamptz THEN
    RETURN jsonb_build_object(
      'status', 'conflict',
      'reason', 'Purchase order changed on the server since this device last saw it',
      'server_row', to_jsonb(v_po)
    );
  END IF;

  v_new_total := COALESCE((p_payload->>'total_amount')::numeric, v_po.total_amount);

  UPDATE purchase_orders SET
    supplier_id  = (p_payload->>'supplier_id')::uuid,
    order_date   = COALESCE(NULLIF(p_payload->>'order_date', '')::date, order_date),
    expected_date = NULLIF(p_payload->>'expected_date', '')::date,
    subtotal     = COALESCE((p_payload->>'subtotal')::numeric, subtotal),
    cart_discount_percent = COALESCE((p_payload->>'cart_discount_percent')::numeric, 0),
    extra_discount = COALESCE((p_payload->>'extra_discount')::numeric, 0),
    discount_amount = COALESCE((p_payload->>'discount_amount')::numeric, 0),
    total_amount = v_new_total,
    notes        = NULLIF(p_payload->>'notes', ''),
    reference    = NULLIF(p_payload->>'reference', ''),
    amount_paid  = LEAST(amount_paid, v_new_total),
    updated_at   = op_at()
  WHERE id = v_po.id;

  DELETE FROM purchase_order_items WHERE purchase_order_id = v_po.id;
  INSERT INTO purchase_order_items (purchase_order_id, product_id, quantity, unit_cost,
    discount_percent, subtotal, unit_name, unit_conversion_factor, base_quantity, warehouse_id,
    sale_price, force_cost_update)
  SELECT v_po.id,
    (r->>'product_id')::uuid,
    (r->>'quantity')::numeric,
    (r->>'unit_cost')::numeric,
    COALESCE((r->>'discount_percent')::numeric, 0),
    (r->>'subtotal')::numeric,
    NULLIF(r->>'unit_name', ''),
    NULLIF(r->>'unit_conversion_factor', '')::numeric,
    (r->>'base_quantity')::numeric,
    NULLIF(r->>'warehouse_id', '')::uuid,
    NULLIF(r->>'sale_price', '')::numeric,
    COALESCE((r->>'force_cost_update')::boolean, false)
  FROM jsonb_array_elements(p_payload->'items') r;

  RETURN jsonb_build_object('status', 'synced', 'po_id', v_po.id, 'po_number', v_po.po_number);
END;
$function$

CREATE OR REPLACE FUNCTION public.sync_product_status(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row products%rowtype;
begin
  select * into v_row from products where id = (p_payload->>'id')::uuid for update;
  if not found then
    raise exception 'product.status: product not found';
  end if;

  if coalesce((p_payload->>'force')::boolean, false) = false
     and p_payload ? 'expected_updated_at'
     and p_payload->>'expected_updated_at' <> ''
     and v_row.updated_at <> (p_payload->>'expected_updated_at')::timestamptz then
    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'Product changed on the server since this device last saw it',
      'server_row', to_jsonb(v_row)
    );
  end if;

  update products set
    is_active = coalesce((p_payload->>'is_active')::boolean, false),
    updated_at = op_at()
  where id = v_row.id;

  return jsonb_build_object('status', 'synced', 'product_id', v_row.id);
end;
$function$

CREATE OR REPLACE FUNCTION public.sync_product_update(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  d          jsonb := p_payload->'data';
  v_pid      uuid  := (p_payload->>'id')::uuid;
  v_tenant   uuid;
  v_server_row jsonb;
  v_current  numeric;
  v_diff     numeric;
  v_inv_id   uuid;
  v_stock    record;
  v_adj_notes text;
begin
  select to_jsonb(p), p.tenant_id into v_server_row, v_tenant
  from products p where p.id = v_pid;

  if v_server_row is null then
    return jsonb_build_object('status', 'conflict', 'reason', 'missing',
      'server_row', 'null'::jsonb);
  end if;

  if not coalesce((p_payload->>'force')::boolean, false)
     and p_payload ? 'expected_updated_at'
     and (p_payload->>'expected_updated_at')::timestamptz
         is distinct from (v_server_row->>'updated_at')::timestamptz then
    return jsonb_build_object('status', 'conflict', 'reason', 'version_mismatch',
      'server_row', v_server_row);
  end if;

  update products set
    name = d->>'name', sku = d->>'sku', unit = d->>'unit', base_unit = d->>'base_unit',
    enable_multi_unit = coalesce((d->>'enable_multi_unit')::boolean, false),
    enable_colors = coalesce((d->>'enable_colors')::boolean, false),
    enable_sizes = coalesce((d->>'enable_sizes')::boolean, false),
    cost_price = coalesce((d->>'cost_price')::numeric, 0),
    sale_price = coalesce((d->>'sale_price')::numeric, 0),
    category_id = nullif(d->>'category_id', '')::uuid,
    brand_id = nullif(d->>'brand_id', '')::uuid,
    min_stock_level = coalesce((d->>'min_stock_level')::numeric, 0),
    description = nullif(d->>'description', ''),
    is_active = coalesce((d->>'is_active')::boolean, true),
    barcode_label_size = nullif(d->>'barcode_label_size', ''),
    barcode_label_width = nullif(d->>'barcode_label_width', '')::numeric,
    barcode_label_height = nullif(d->>'barcode_label_height', '')::numeric,
    updated_at = op_at()
  where id = v_pid;

  if coalesce((d->>'enable_colors')::boolean, false)
     and jsonb_array_length(coalesce(p_payload->'colors', '[]'::jsonb)) > 0 then
    delete from product_colors where product_id = v_pid;
    insert into product_colors (product_id, name, hex_code, image_url, is_default, sort_order)
    select v_pid, r->>'name', r->>'hex_code', nullif(r->>'image_url', ''),
      coalesce((r->>'is_default')::boolean, false), coalesce((r->>'sort_order')::int, 0)
    from jsonb_array_elements(p_payload->'colors') r
    where nullif(r->>'name', '') is not null;
  end if;

  if coalesce((d->>'enable_sizes')::boolean, false)
     and jsonb_array_length(coalesce(p_payload->'sizes', '[]'::jsonb)) > 0 then
    delete from product_sizes where product_id = v_pid;
    insert into product_sizes (product_id, name, dimensions, is_default, sort_order)
    select v_pid, r->>'name', nullif(r->>'dimensions', ''),
      coalesce((r->>'is_default')::boolean, false), coalesce((r->>'sort_order')::int, 0)
    from jsonb_array_elements(p_payload->'sizes') r
    where nullif(r->>'name', '') is not null;
  end if;

  if coalesce((d->>'enable_multi_unit')::boolean, false)
     and jsonb_array_length(coalesce(p_payload->'units', '[]'::jsonb)) > 0 then
    delete from product_units where product_id = v_pid;
    insert into product_units (product_id, unit_name, unit_short, conversion_factor,
      is_base_unit, is_sale_unit, price, cost_price, barcode, sort_order, is_active)
    select v_pid, r->>'unit_name', nullif(r->>'unit_short', ''),
      coalesce((r->>'conversion_factor')::numeric, 1),
      coalesce((r->>'is_base_unit')::boolean, false),
      coalesce((r->>'is_sale_unit')::boolean, false),
      coalesce((r->>'price')::numeric, 0),
      coalesce((r->>'cost_price')::numeric, 0),
      nullif(r->>'barcode', ''),
      coalesce((r->>'sort_order')::int, 0),
      coalesce((r->>'is_active')::boolean, true)
    from jsonb_array_elements(p_payload->'units') r
    where nullif(r->>'unit_name', '') is not null;
  end if;

  -- Stock adjustments against the server's current quantity
  for v_stock in
    select (r->>'warehouse_id')::uuid as warehouse_id,
           (r->>'quantity')::numeric as quantity,
           coalesce((r->>'unit_cost')::numeric, (d->>'cost_price')::numeric, 0) as unit_cost,
           nullif(coalesce(r->>'reason', ''), '') as reason
    from jsonb_array_elements(coalesce(p_payload->'stock', '[]'::jsonb)) r
  loop
    continue when v_stock.quantity is null;
    select quantity_on_hand, id into v_current, v_inv_id
    from inventory_items
    where product_id = v_pid and warehouse_id = v_stock.warehouse_id
    order by created_at asc
    limit 1;

    v_diff := v_stock.quantity - coalesce(v_current, 0);
    continue when v_diff = 0;

    v_adj_notes := case when v_diff > 0 then 'Stock increase adjustment' else 'Stock decrease adjustment' end
                   || case when v_stock.reason is not null then ' — ' || v_stock.reason else '' end;

    if v_inv_id is not null then
      update inventory_items set quantity_on_hand = v_stock.quantity, updated_at = op_at()
      where id = v_inv_id;
    else
      insert into inventory_items (tenant_id, product_id, warehouse_id, quantity_on_hand)
      values (v_tenant, v_pid, v_stock.warehouse_id, v_stock.quantity);
    end if;

    insert into stock_movements (tenant_id, product_id, warehouse_id, movement_type, quantity,
      unit_cost, reference_type, reference_id, notes)
    values (v_tenant, v_pid, v_stock.warehouse_id, 'adjustment', v_diff, v_stock.unit_cost,
      'stock_adjustment', v_pid, v_adj_notes);

    if v_diff > 0 then
      perform public.create_opening_batch(
        v_pid, v_stock.warehouse_id, v_diff, v_stock.unit_cost,
        'adjustment', 'stock_adjustment', v_pid, v_adj_notes);
    else
      perform public.create_stock_reduction(
        v_pid, v_stock.warehouse_id, abs(v_diff), v_stock.unit_cost,
        'stock_adjustment', v_pid, v_adj_notes);
    end if;
  end loop;

  return jsonb_build_object('status', 'synced', 'product_id', v_pid);
end;
$function$

CREATE OR REPLACE FUNCTION public.sync_project_update(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  d     jsonb := p_payload->'data';
  v_row projects%rowtype;
begin
  select * into v_row from projects where id = (p_payload->>'id')::uuid for update;
  if not found then
    raise exception 'project.update: project not found';
  end if;

  if coalesce((p_payload->>'force')::boolean, false) = false
     and p_payload ? 'expected_updated_at'
     and p_payload->>'expected_updated_at' <> ''
     and v_row.updated_at <> (p_payload->>'expected_updated_at')::timestamptz then
    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'Project changed on the server since this device last saw it',
      'server_row', to_jsonb(v_row)
    );
  end if;

  update projects set
    name = case when d ? 'name' then d->>'name' else projects.name end,
    customer_id = case when d ? 'customer_id' then nullif(d->>'customer_id', '')::uuid else projects.customer_id end,
    status = case when d ? 'status' then d->>'status' else projects.status end,
    priority = case when d ? 'priority' then d->>'priority' else projects.priority end,
    start_date = case when d ? 'start_date' then nullif(d->>'start_date', '')::date else projects.start_date end,
    end_date = case when d ? 'end_date' then nullif(d->>'end_date', '')::date else projects.end_date end,
    estimated_budget = case when d ? 'estimated_budget' then nullif(d->>'estimated_budget', '')::numeric else projects.estimated_budget end,
    actual_cost = case when d ? 'actual_cost' then coalesce(nullif(d->>'actual_cost', '')::numeric, 0) else projects.actual_cost end,
    progress_percent = case when d ? 'progress_percent' then coalesce(nullif(d->>'progress_percent', '')::numeric, 0) else projects.progress_percent end,
    location = case when d ? 'location' then nullif(d->>'location', '') else projects.location end,
    description = case when d ? 'description' then nullif(d->>'description', '') else projects.description end,
    updated_at = op_at()
  where id = v_row.id;

  return jsonb_build_object('status', 'synced', 'project_id', v_row.id);
end;
$function$

CREATE OR REPLACE FUNCTION public.sync_purchase_return_create(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_po       purchase_orders%rowtype;
  v_id       uuid;
  v_number   text;
  v_ratio    numeric;
  v_total    numeric := 0;
  v_wh       uuid;
  v_item     jsonb;
  v_po_item  purchase_order_items%rowtype;
  v_inv_id   uuid;
  v_qty      numeric;
  v_refund   numeric;
  v_wh_id    uuid;
  v_rcvd     numeric;
begin
  select * into v_po from purchase_orders where id = (p_payload->>'purchase_order_id')::uuid;
  if not found then
    raise exception 'purchase_return.create: purchase order not found';
  end if;

  if p_payload ? 'id' then
    v_id := (p_payload->>'id')::uuid;
  else
    v_id := gen_random_uuid();
  end if;
  v_number := coalesce(nullif(p_payload->>'return_number', ''),
    'PRET-' || to_char(op_at(), 'HH24MISS'));

  v_ratio := case when coalesce(v_po.subtotal, 0) > 0
    then v_po.total_amount / v_po.subtotal else 1 end;

  select id into v_wh from warehouses where is_default limit 1;

  for v_item in select * from jsonb_array_elements(p_payload->'items')
  loop
    select * into v_po_item from purchase_order_items
      where id = (v_item->>'purchase_order_item_id')::uuid;
    if not found then
      raise exception 'purchase_return.create: PO item not found';
    end if;

    v_qty    := (v_item->>'quantity')::numeric;
    v_wh_id  := coalesce(nullif(v_item->>'warehouse_id', '')::uuid, v_po_item.warehouse_id, v_wh);
    v_refund := v_qty * coalesce(v_po_item.unit_cost, 0) * v_ratio;
    v_total  := v_total + v_refund;

    insert into stock_movements (tenant_id, product_id, warehouse_id, movement_type,
      quantity, unit_cost, reference_type, reference_id, reference_number, notes)
    values ('00000000-0000-0000-0000-000000000001', v_po_item.product_id, v_wh_id,
      'return_out', -v_qty, coalesce(v_po_item.unit_cost, 0),
      'purchase_return', v_id, v_number,
      coalesce(nullif(v_item->>'reason', ''), 'Return to supplier from PO ' || v_po.po_number));

    perform public.reverse_fifo_on_purchase_return(
      v_po_item.product_id, v_wh_id, v_qty, coalesce(v_po_item.unit_cost, 0), v_id, v_number);

    update inventory_items set
      quantity_on_hand = greatest(0, quantity_on_hand - v_qty),
      updated_at = op_at()
    where product_id = v_po_item.product_id and warehouse_id = v_wh_id;

    perform public.heal_negative_batches_and_resync(v_po_item.product_id, v_wh_id);

    v_rcvd := coalesce(v_po_item.received_quantity, v_po_item.quantity);
    update purchase_order_items set received_quantity = greatest(0, v_rcvd - v_qty)
    where id = v_po_item.id;
  end loop;

  insert into purchase_returns (id, return_number, purchase_order_id, supplier_id,
    warehouse_id, return_date, total_amount, status)
  values (v_id, v_number, v_po.id, v_po.supplier_id, v_wh,
    coalesce(nullif(p_payload->>'return_date', '')::date, op_date()),
    v_total, 'completed');

  insert into purchase_return_items (purchase_return_id, product_id, quantity, unit_cost,
    subtotal, reason)
  select v_id,
    pi.product_id,
    (it.item->>'quantity')::numeric,
    coalesce(pi.unit_cost, 0),
    (it.item->>'quantity')::numeric * coalesce(pi.unit_cost, 0) * v_ratio,
    case when it.item->>'reason' in ('defective','wrong_item','quality_issue','overstock','other')
      then it.item->>'reason' else 'other' end
  from (select item from jsonb_array_elements(p_payload->'items') item) it
  join purchase_order_items pi
    on pi.id = (it.item->>'purchase_order_item_id')::uuid;

  return jsonb_build_object('status', 'synced', 'return_id', v_id,
    'return_number', v_number, 'refund_amount', v_total);
end;
$function$

CREATE OR REPLACE FUNCTION public.sync_quotation_create(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_customer uuid;
  v_number   text;
  v_id       uuid;
begin
  v_customer := (p_payload->>'customer_id')::uuid;
  if v_customer is null then
    raise exception 'quotation.create: customer_id is required';
  end if;
  if p_payload->'items' is null or jsonb_array_length(p_payload->'items') = 0 then
    raise exception 'quotation.create: items array is required';
  end if;

  v_number := public.generate_quotation_number();

  if p_payload ? 'id' then
    insert into quotations (id, quote_number, customer_id, issue_date, expiry_date,
      subtotal, cart_discount_percent, extra_discount, discount_amount, tax_amount,
      shipping_cost, total_amount, status, notes, reference)
    values ((p_payload->>'id')::uuid, v_number, v_customer,
      coalesce(nullif(p_payload->>'issue_date', '')::date, op_date()),
      nullif(p_payload->>'expiry_date', '')::date,
      coalesce((p_payload->>'subtotal')::numeric, 0),
      coalesce((p_payload->>'cart_discount_percent')::numeric, 0),
      coalesce((p_payload->>'extra_discount')::numeric, 0),
      coalesce((p_payload->>'discount_amount')::numeric, 0),
      coalesce((p_payload->>'tax_amount')::numeric, 0),
      coalesce((p_payload->>'shipping_cost')::numeric, 0),
      coalesce((p_payload->>'total_amount')::numeric, 0),
      coalesce(p_payload->>'status', 'draft'),
      nullif(p_payload->>'notes', ''),
      nullif(p_payload->>'reference', ''))
    returning id into v_id;
  else
    insert into quotations (quote_number, customer_id, issue_date, expiry_date,
      subtotal, cart_discount_percent, extra_discount, discount_amount, tax_amount,
      shipping_cost, total_amount, status, notes, reference)
    values (v_number, v_customer,
      coalesce(nullif(p_payload->>'issue_date', '')::date, op_date()),
      nullif(p_payload->>'expiry_date', '')::date,
      coalesce((p_payload->>'subtotal')::numeric, 0),
      coalesce((p_payload->>'cart_discount_percent')::numeric, 0),
      coalesce((p_payload->>'extra_discount')::numeric, 0),
      coalesce((p_payload->>'discount_amount')::numeric, 0),
      coalesce((p_payload->>'tax_amount')::numeric, 0),
      coalesce((p_payload->>'shipping_cost')::numeric, 0),
      coalesce((p_payload->>'total_amount')::numeric, 0),
      coalesce(p_payload->>'status', 'draft'),
      nullif(p_payload->>'notes', ''),
      nullif(p_payload->>'reference', ''))
    returning id into v_id;
  end if;

  insert into quotation_items (quotation_id, product_id, quantity, unit_price,
    discount_percent, tax_rate, subtotal, unit_name, unit_conversion_factor,
    base_quantity, warehouse_id)
  select v_id,
    (r->>'product_id')::uuid,
    (r->>'quantity')::numeric,
    (r->>'unit_price')::numeric,
    coalesce((r->>'discount_percent')::numeric, 0),
    coalesce((r->>'tax_rate')::numeric, 0),
    (r->>'subtotal')::numeric,
    nullif(r->>'unit_name', ''),
    nullif(r->>'unit_conversion_factor', '')::numeric,
    (r->>'base_quantity')::numeric,
    nullif(r->>'warehouse_id', '')::uuid
  from jsonb_array_elements(p_payload->'items') r;

  insert into cost_price_history (product_id, product_name, product_sku, quotation_id,
    unit, quantity, unit_price, cost_price_per_qty, cost_price_for_added_qty,
    total_cost_price_single, total_cost_price_added)
  select (r->>'product_id')::uuid,
    r->>'product_name',
    coalesce(r->>'product_sku', ''),
    v_id,
    coalesce(r->>'unit', 'pcs'),
    (r->>'quantity')::numeric,
    (r->>'unit_price')::numeric,
    coalesce((r->>'cost_price_per_qty')::numeric, 0),
    coalesce((r->>'cost_price_for_added_qty')::numeric, 0),
    coalesce((r->>'total_cost_price_single')::numeric, 0),
    coalesce((r->>'total_cost_price_added')::numeric, 0)
  from jsonb_array_elements(
    case when jsonb_typeof(p_payload->'cost_history') = 'array'
      then p_payload->'cost_history' else '[]'::jsonb end) r;

  return jsonb_build_object('status', 'synced', 'quotation_id', v_id, 'quote_number', v_number);
end;
$function$

CREATE OR REPLACE FUNCTION public.sync_quotation_status(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_q      quotations%rowtype;
  v_status text := p_payload->>'status';
begin
  if v_status not in ('draft', 'sent', 'accepted', 'rejected', 'expired', 'cancelled', 'converted') then
    raise exception 'quotation.status: invalid status %', v_status;
  end if;

  select * into v_q from quotations where id = (p_payload->>'id')::uuid for update;
  if not found then
    raise exception 'quotation.status: quotation not found';
  end if;

  if coalesce((p_payload->>'force')::boolean, false) = false
     and p_payload ? 'expected_updated_at'
     and p_payload->>'expected_updated_at' <> ''
     and v_q.updated_at <> (p_payload->>'expected_updated_at')::timestamptz then
    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'Quotation changed on the server since this device last saw it',
      'server_row', to_jsonb(v_q)
    );
  end if;

  update quotations set status = v_status, updated_at = op_at() where id = v_q.id;

  return jsonb_build_object('status', 'synced', 'quotation_id', v_q.id, 'quotation_status', v_status);
end;
$function$

CREATE OR REPLACE FUNCTION public.sync_quotation_update(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_q quotations%rowtype;
begin
  select * into v_q from quotations where id = (p_payload->>'id')::uuid for update;
  if not found then
    raise exception 'quotation.update: quotation not found';
  end if;

  if coalesce((p_payload->>'force')::boolean, false) = false
     and p_payload ? 'expected_updated_at'
     and p_payload->>'expected_updated_at' <> ''
     and v_q.updated_at <> (p_payload->>'expected_updated_at')::timestamptz then
    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'Quotation changed on the server since this device last saw it',
      'server_row', to_jsonb(v_q)
    );
  end if;

  update quotations set
    customer_id  = (p_payload->>'customer_id')::uuid,
    issue_date   = coalesce(nullif(p_payload->>'issue_date', '')::date, issue_date),
    expiry_date  = nullif(p_payload->>'expiry_date', '')::date,
    subtotal     = coalesce((p_payload->>'subtotal')::numeric, 0),
    cart_discount_percent = coalesce((p_payload->>'cart_discount_percent')::numeric, 0),
    extra_discount = coalesce((p_payload->>'extra_discount')::numeric, 0),
    discount_amount = coalesce((p_payload->>'discount_amount')::numeric, 0),
    tax_amount   = coalesce((p_payload->>'tax_amount')::numeric, 0),
    shipping_cost = coalesce((p_payload->>'shipping_cost')::numeric, 0),
    total_amount = coalesce((p_payload->>'total_amount')::numeric, 0),
    notes        = nullif(p_payload->>'notes', ''),
    reference    = nullif(p_payload->>'reference', ''),
    updated_at   = op_at()
  where id = v_q.id;

  delete from quotation_items where quotation_id = v_q.id;
  delete from cost_price_history where quotation_id = v_q.id;

  insert into quotation_items (quotation_id, product_id, quantity, unit_price,
    discount_percent, tax_rate, subtotal, unit_name, unit_conversion_factor,
    base_quantity, warehouse_id)
  select v_q.id,
    (r->>'product_id')::uuid,
    (r->>'quantity')::numeric,
    (r->>'unit_price')::numeric,
    coalesce((r->>'discount_percent')::numeric, 0),
    coalesce((r->>'tax_rate')::numeric, 0),
    (r->>'subtotal')::numeric,
    nullif(r->>'unit_name', ''),
    nullif(r->>'unit_conversion_factor', '')::numeric,
    (r->>'base_quantity')::numeric,
    nullif(r->>'warehouse_id', '')::uuid
  from jsonb_array_elements(p_payload->'items') r;

  insert into cost_price_history (product_id, product_name, product_sku, quotation_id,
    unit, quantity, unit_price, cost_price_per_qty, cost_price_for_added_qty,
    total_cost_price_single, total_cost_price_added)
  select (r->>'product_id')::uuid,
    r->>'product_name',
    coalesce(r->>'product_sku', ''),
    v_q.id,
    coalesce(r->>'unit', 'pcs'),
    (r->>'quantity')::numeric,
    (r->>'unit_price')::numeric,
    coalesce((r->>'cost_price_per_qty')::numeric, 0),
    coalesce((r->>'cost_price_for_added_qty')::numeric, 0),
    coalesce((r->>'total_cost_price_single')::numeric, 0),
    coalesce((r->>'total_cost_price_added')::numeric, 0)
  from jsonb_array_elements(
    case when jsonb_typeof(p_payload->'cost_history') = 'array'
      then p_payload->'cost_history' else '[]'::jsonb end) r;

  return jsonb_build_object('status', 'synced', 'quotation_id', v_q.id);
end;
$function$

CREATE OR REPLACE FUNCTION public.sync_stock_transfer_create(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id      uuid := (p_payload->>'id')::uuid;
  v_number  text := p_payload->>'transfer_number';
  v_product uuid := (p_payload->>'product_id')::uuid;
  v_from    uuid := (p_payload->>'from_warehouse_id')::uuid;
  v_to      uuid := (p_payload->>'to_warehouse_id')::uuid;
  v_qty     numeric := (p_payload->>'quantity')::numeric;
  v_cost    numeric := coalesce((p_payload->>'unit_cost')::numeric, 0);
  v_notes   text;
  v_inv_id  uuid;
BEGIN
  IF v_qty IS NULL OR v_qty <= 0 THEN
    RAISE EXCEPTION 'stock_transfer.create: quantity must be greater than 0';
  END IF;
  IF v_from = v_to THEN
    RAISE EXCEPTION 'stock_transfer.create: source and destination warehouse are the same';
  END IF;

  INSERT INTO stock_movements (tenant_id, product_id, warehouse_id, movement_type,
    quantity, unit_cost, reference_type, reference_id, reference_number, notes)
  VALUES ('00000000-0000-0000-0000-000000000001', v_product, v_from, 'transfer_out',
    -v_qty, v_cost, 'transfer', v_id, v_number,
    coalesce(nullif(p_payload->>'notes', ''), 'Transfer out'));

  INSERT INTO stock_movements (tenant_id, product_id, warehouse_id, movement_type,
    quantity, unit_cost, reference_type, reference_id, reference_number, notes)
  VALUES ('00000000-0000-0000-0000-000000000001', v_product, v_to, 'transfer_in',
    v_qty, v_cost, 'transfer', v_id, v_number,
    coalesce(nullif(p_payload->>'notes', ''), 'Transfer in'));

  PERFORM public.transfer_fifo_batches(v_product, v_from, v_to, v_qty, v_id, v_number);

  UPDATE inventory_items SET
    quantity_on_hand = GREATEST(0, quantity_on_hand - v_qty),
    updated_at = op_at()
  WHERE product_id = v_product AND warehouse_id = v_from;

  SELECT id INTO v_inv_id FROM inventory_items
  WHERE product_id = v_product AND warehouse_id = v_to LIMIT 1;
  IF v_inv_id IS NOT NULL THEN
    UPDATE inventory_items SET
      quantity_on_hand = quantity_on_hand + v_qty,
      updated_at = op_at()
    WHERE id = v_inv_id;
  ELSE
    INSERT INTO inventory_items (tenant_id, product_id, warehouse_id, quantity_on_hand)
    VALUES ('00000000-0000-0000-0000-000000000001', v_product, v_to, v_qty);
  END IF;

  PERFORM heal_negative_batches_and_resync(v_product, v_from);
  PERFORM heal_negative_batches_and_resync(v_product, v_to);

  RETURN jsonb_build_object('status', 'synced', 'transfer_id', v_id,
    'transfer_number', v_number);
END;
$function$

CREATE OR REPLACE FUNCTION public.sync_store_credit_expire(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_credit customer_store_credits%rowtype;
begin
  select * into v_credit from customer_store_credits
    where id = (p_payload->>'credit_id')::uuid for update;
  if not found then
    raise exception 'store_credit.expire: credit not found';
  end if;

  if coalesce((p_payload->>'force')::boolean, false) = false
     and p_payload ? 'expected_updated_at'
     and p_payload->>'expected_updated_at' <> ''
     and v_credit.updated_at <> (p_payload->>'expected_updated_at')::timestamptz then
    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'Store credit changed on the server since this device last saw it',
      'server_row', to_jsonb(v_credit)
    );
  end if;

  update customer_store_credits set status = 'expired', updated_at = op_at() where id = v_credit.id;

  return jsonb_build_object('status', 'synced', 'credit_id', v_credit.id);
end;
$function$

CREATE OR REPLACE FUNCTION public.sync_store_credit_issue(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_amount  numeric;
  v_number  text;
  v_id      uuid;
  v_acc_2200 uuid;
begin
  v_amount := coalesce((p_payload->>'amount')::numeric, 0);
  if v_amount <= 0 then
    raise exception 'store_credit.issue: amount must be greater than 0';
  end if;
  if nullif(p_payload->>'debit_account_id', '') is null then
    raise exception 'store_credit.issue: debit_account_id is required';
  end if;

  v_number := public.generate_credit_number();

  if p_payload ? 'id' then
    insert into customer_store_credits (id, credit_number, customer_id, amount, balance,
      status, notes, expires_at)
    values ((p_payload->>'id')::uuid, v_number, (p_payload->>'customer_id')::uuid,
      v_amount, v_amount, 'active',
      nullif(p_payload->>'notes', '') , nullif(p_payload->>'expires_at', '')::date)
    returning id into v_id;
  else
    insert into customer_store_credits (credit_number, customer_id, amount, balance,
      status, notes, expires_at)
    values (v_number, (p_payload->>'customer_id')::uuid,
      v_amount, v_amount, 'active',
      nullif(p_payload->>'notes', ''), nullif(p_payload->>'expires_at', '')::date)
    returning id into v_id;
  end if;

  select id into v_acc_2200 from accounts where code = '2200' limit 1;
  if v_acc_2200 is null then
    raise exception 'store_credit.issue: Customer Refund Payable account (2200) not found';
  end if;

  perform public.post_journal_entry(
    'Store credit issued ' || v_number || ' — ' || coalesce(p_payload->>'customer_name', 'customer'),
    op_date(),
    'store_credit',
    v_id,
    json_build_array(
      json_build_object('account_id', (p_payload->>'debit_account_id')::uuid,
        'debit', v_amount, 'credit', 0, 'description', 'Store credit issued'),
      json_build_object('account_id', v_acc_2200, 'debit', 0, 'credit', v_amount,
        'description', 'Store credit liability')
    )::json,
    (p_payload->>'customer_id')::uuid
  );

  return jsonb_build_object('status', 'synced', 'credit_id', v_id, 'credit_number', v_number);
end;
$function$

CREATE OR REPLACE FUNCTION public.sync_supplier_payable_payment(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_res json;
begin
  v_res := public.record_manual_payable_payment(
    (p_payload->>'payable_je_id')::uuid,
    (p_payload->>'amount')::numeric,
    coalesce(nullif(p_payload->>'wht_amount', '')::numeric, 0),
    coalesce(nullif(p_payload->>'payment_date', '')::date, op_date()),
    coalesce(p_payload->>'payment_method', 'cash'),
    (p_payload->>'cash_account_id')::uuid,
    nullif(p_payload->>'reference_number', ''),
    coalesce(p_payload->>'notes', 'Supplier payment'));

  return to_jsonb(v_res) || jsonb_build_object('status', 'synced');
end;
$function$

CREATE OR REPLACE FUNCTION public.sync_supplier_update(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  d        jsonb := p_payload->'data';
  v_row    suppliers%rowtype;
begin
  select * into v_row from suppliers where id = (p_payload->>'id')::uuid for update;
  if not found then
    raise exception 'supplier.update: supplier not found';
  end if;

  if coalesce((p_payload->>'force')::boolean, false) = false
     and p_payload ? 'expected_updated_at'
     and p_payload->>'expected_updated_at' <> ''
     and v_row.updated_at <> (p_payload->>'expected_updated_at')::timestamptz then
    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'Supplier changed on the server since this device last saw it',
      'server_row', to_jsonb(v_row)
    );
  end if;

  update suppliers set
    name          = case when d ? 'name' then d->>'name' else suppliers.name end,
    code          = case when d ? 'code' then d->>'code' else suppliers.code end,
    phone         = case when d ? 'phone' then nullif(d->>'phone', '') else suppliers.phone end,
    email         = case when d ? 'email' then nullif(d->>'email', '') else suppliers.email end,
    mobile        = case when d ? 'mobile' then nullif(d->>'mobile', '') else suppliers.mobile end,
    company_name  = case when d ? 'company_name' then nullif(d->>'company_name', '') else suppliers.company_name end,
    city          = case when d ? 'city' then nullif(d->>'city', '') else suppliers.city end,
    address       = case when d ? 'address' then nullif(d->>'address', '') else suppliers.address end,
    credit_limit  = case when d ? 'credit_limit' then coalesce(nullif(d->>'credit_limit', '')::numeric, 0) else suppliers.credit_limit end,
    credit_days   = case when d ? 'credit_days' then coalesce(nullif(d->>'credit_days', '')::int, 0) else suppliers.credit_days end,
    rating        = case when d ? 'rating' then nullif(d->>'rating', '')::numeric else suppliers.rating end,
    is_active     = case when d ? 'is_active' then coalesce((d->>'is_active')::boolean, true) else suppliers.is_active end,
    updated_at    = op_at()
  where id = v_row.id;

  return jsonb_build_object('status', 'synced', 'supplier_id', v_row.id);
end;
$function$

CREATE OR REPLACE FUNCTION public.sync_transfer_create(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_res json;
begin
  v_res := public.record_fund_transfer(
    (p_payload->>'from_account_id')::uuid,
    (p_payload->>'to_account_id')::uuid,
    (p_payload->>'amount')::numeric,
    coalesce(nullif(p_payload->>'date', '')::date, op_date()),
    nullif(p_payload->>'notes', '')
  );

  return to_jsonb(v_res) || jsonb_build_object('status', 'synced');
end;
$function$

CREATE OR REPLACE FUNCTION public.touch_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = op_at();
  RETURN NEW;
END;
$function$

CREATE OR REPLACE FUNCTION public.update_credit_balance_on_redemption()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  UPDATE customer_store_credits
  SET balance = balance - NEW.amount,
      status = CASE WHEN balance - NEW.amount <= 0 THEN 'redeemed' ELSE status END,
      updated_at = op_at()
  WHERE id = NEW.store_credit_id;

  RETURN NEW;
END;
$function$

-- Column defaults (112 columns): now() -> op_at().
alter table public.account_balance_recompute_audit alter column done_at set default op_at();
alter table public.accounts alter column created_at set default op_at();
alter table public.accounts alter column updated_at set default op_at();
alter table public.activity_logs alter column created_at set default op_at();
alter table public.app_settings alter column updated_at set default op_at();
alter table public.attendance alter column created_at set default op_at();
alter table public.attendance alter column updated_at set default op_at();
alter table public.bank_reconciliation_items alter column reconciled_at set default op_at();
alter table public.bank_reconciliation_items alter column updated_at set default op_at();
alter table public.batch_cost_correction_audit alter column corrected_at set default op_at();
alter table public.brands alter column created_at set default op_at();
alter table public.brands alter column updated_at set default op_at();
alter table public.categories alter column created_at set default op_at();
alter table public.categories alter column updated_at set default op_at();
alter table public.cogs_scale_fix_audit alter column created_at set default op_at();
alter table public.cost_price_history alter column created_at set default op_at();
alter table public.cost_price_history alter column recorded_at set default op_at();
alter table public.cost_price_history_repair_audit alter column created_at set default op_at();
alter table public.customer_advance_applications alter column created_at set default op_at();
alter table public.customer_advance_refunds alter column created_at set default op_at();
alter table public.customer_advance_refunds alter column refund_date set default op_date();
alter table public.customer_advances alter column created_at set default op_at();
alter table public.customer_advances alter column payment_date set default op_date();
alter table public.customer_advances alter column updated_at set default op_at();
alter table public.customer_notes alter column created_at set default op_at();
alter table public.customer_store_credits alter column created_at set default op_at();
alter table public.customer_store_credits alter column updated_at set default op_at();
alter table public.customer_totals_recompute_audit alter column done_at set default op_at();
alter table public.customers alter column created_at set default op_at();
alter table public.customers alter column updated_at set default op_at();
alter table public.cutover_baseline_adjustment_audit alter column created_at set default op_at();
alter table public.deliveries alter column created_at set default op_at();
alter table public.deliveries alter column updated_at set default op_at();
alter table public.employees alter column created_at set default op_at();
alter table public.employees alter column updated_at set default op_at();
alter table public.gl_fifo_repair_audit alter column done_at set default op_at();
alter table public.goods_receipt_notes alter column created_at set default op_at();
alter table public.goods_receipt_notes alter column received_date set default op_date();
alter table public.goods_receipt_notes alter column updated_at set default op_at();
alter table public.grn_journal_cleanup_audit alter column done_at set default op_at();
alter table public.inventory_batches alter column created_at set default op_at();
alter table public.inventory_batches alter column updated_at set default op_at();
alter table public.inventory_counter_rebuild_audit alter column run_at set default op_at();
alter table public.inventory_items alter column created_at set default op_at();
alter table public.inventory_items alter column updated_at set default op_at();
alter table public.inventory_layer_purge_audit alter column purged_at set default op_at();
alter table public.inventory_reconciliation_log alter column checked_at set default op_at();
alter table public.invoice_edit_history alter column created_at set default op_at();
alter table public.invoice_edit_history alter column edited_at set default op_at();
alter table public.invoice_item_batch_consumption alter column created_at set default op_at();
alter table public.invoice_items alter column updated_at set default op_at();
alter table public.invoices alter column created_at set default op_at();
alter table public.invoices alter column invoice_date set default op_date();
alter table public.invoices alter column updated_at set default op_at();
alter table public.journal_entries alter column created_at set default op_at();
alter table public.journal_entries alter column entry_date set default op_date();
alter table public.notification_reads alter column read_at set default op_at();
alter table public.notifications alter column created_at set default op_at();
alter table public.online_orders alter column created_at set default op_at();
alter table public.online_orders alter column updated_at set default op_at();
alter table public.pasted_invoice_repair_audit alter column created_at set default op_at();
alter table public.payment_attribution_repair_audit alter column repaired_at set default op_at();
alter table public.payment_methods alter column created_at set default op_at();
alter table public.payment_methods alter column updated_at set default op_at();
alter table public.payments alter column created_at set default op_at();
alter table public.payments alter column payment_date set default op_date();
alter table public.payments alter column updated_at set default op_at();
alter table public.product_colors alter column created_at set default op_at();
alter table public.product_colors alter column updated_at set default op_at();
alter table public.product_sizes alter column created_at set default op_at();
alter table public.product_sizes alter column updated_at set default op_at();
alter table public.product_units alter column created_at set default op_at();
alter table public.product_units alter column updated_at set default op_at();
alter table public.product_variants alter column created_at set default op_at();
alter table public.products alter column created_at set default op_at();
alter table public.products alter column updated_at set default op_at();
alter table public.profiles alter column created_at set default op_at();
alter table public.profiles alter column updated_at set default op_at();
alter table public.project_tasks alter column created_at set default op_at();
alter table public.projects alter column created_at set default op_at();
alter table public.projects alter column updated_at set default op_at();
alter table public.purchase_orders alter column created_at set default op_at();
alter table public.purchase_orders alter column order_date set default op_date();
alter table public.purchase_orders alter column updated_at set default op_at();
alter table public.purchase_reminders alter column created_at set default op_at();
alter table public.purchase_reminders alter column updated_at set default op_at();
alter table public.purchase_return_items alter column created_at set default op_at();
alter table public.purchase_returns alter column created_at set default op_at();
alter table public.purchase_returns alter column return_date set default op_date();
alter table public.purchase_returns alter column updated_at set default op_at();
alter table public.quotations alter column created_at set default op_at();
alter table public.quotations alter column issue_date set default op_date();
alter table public.quotations alter column updated_at set default op_at();
alter table public.reduction_gl_wedge_repair_audit alter column repaired_at set default op_at();
alter table public.sales_return_invoice_repair_audit alter column repaired_at set default op_at();
alter table public.sales_return_items alter column created_at set default op_at();
alter table public.sales_returns alter column created_at set default op_at();
alter table public.sales_returns alter column return_date set default op_date();
alter table public.sales_returns alter column updated_at set default op_at();
alter table public.stock_movements alter column created_at set default op_at();
alter table public.stock_reduction_repair_audit alter column repaired_at set default op_at();
alter table public.store_credit_redemptions alter column created_at set default op_at();
alter table public.supplier_audit_log alter column done_at set default op_at();
alter table public.supplier_balance_repair_audit alter column done_at set default op_at();
alter table public.suppliers alter column created_at set default op_at();
alter table public.suppliers alter column updated_at set default op_at();
alter table public.unit_types alter column created_at set default op_at();
alter table public.unit_types alter column updated_at set default op_at();
alter table public.user_module_access alter column updated_at set default op_at();
alter table public.warehouses alter column created_at set default op_at();
alter table public.warehouses alter column updated_at set default op_at();
alter table public.warranty_records alter column created_at set default op_at();
commit;
