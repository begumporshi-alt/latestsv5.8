-- 2026-09-03: Fix edit_invoice's journal-entry balance rollbacks.
--
-- STEP 3 (old COGS JE deletion) and the payment-JE deletion loop rolled the
-- cached accounts.balance back with `UPDATE accounts ... FROM journal_lines`.
-- PostgreSQL's UPDATE ... FROM does NOT aggregate multiple join rows: when the
-- deleted JE held several lines on one account (every multi-item sale's COGS
-- JE since 2026-09-01 carries one Dr 5000 + one Cr 1200 line PER ITEM), only
-- ONE arbitrary line per account was subtracted. Editing INV-940648 on
-- 2026-09-02 (its 12-items-per-account COGS JE of Tk 616,356) rolled back a
-- single arbitrary Tk 72,000 line per account, leaving the cache Tk 544,356
-- out on 1200 (low) and 5000 (high). The journal LINES were deleted whole and
-- replaced, so the journal and the batch ledger stayed correct — only the
-- denormalized balance cache drifted (reconciliation check 4 red since the
-- 2026-09-03 02:05 snapshot).
--
-- This migration:
--   1. re-creates edit_invoice with both rollbacks aggregated per account
--      (correlated SUM subquery; also pins search_path on this SECURITY
--      DEFINER function), and
--   2. recomputes every drifted cached balance from journal lines (audited
--      into account_balance_recompute_audit) — expected: exactly 1200 and
--      5000 change by -/+544,356.00 — then
--   3. verifies the reconciliation balance-cache check is clean.
--
-- Verified before writing: edit_invoice is the ONLY live function with the
-- unsafe pattern (delete_duplicate_cogs_je / delete_grn_journal use a safe
-- per-line loop; cancel_invoice has no UPDATE accounts).

BEGIN;

CREATE OR REPLACE FUNCTION public.edit_invoice(p_invoice_id uuid, p_new_data json, p_edited_by text DEFAULT NULL::text, p_reason text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_invoice RECORD;
  v_ar_account uuid;
  v_revenue_account uuid;
  v_cogs_account uuid;
  v_inventory_account uuid;
  v_cash_account uuid;
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
  v_has_deliveries boolean;
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
BEGIN
  SELECT * INTO v_invoice FROM invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Invoice not found');
  END IF;

  IF v_invoice.status = 'cancelled' THEN
    RETURN json_build_object('success', false, 'error', 'Cannot edit a cancelled invoice');
  END IF;

  SELECT EXISTS(SELECT 1 FROM deliveries WHERE invoice_id = p_invoice_id AND status = 'delivered') INTO v_has_deliveries;
  IF v_has_deliveries THEN
    RETURN json_build_object('success', false, 'error', 'Cannot edit an invoice that has been delivered. Please process a return instead.');
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

  FOR v_i IN SELECT generate_series(0, json_array_length(v_new_items) - 1) LOOP
    v_new_item := v_new_items->v_i;
    v_new_subtotal := v_new_subtotal + (v_new_item->>'quantity')::numeric * (v_new_item->>'unit_price')::numeric * (1 - COALESCE((v_new_item->>'discount_percent')::numeric, 0) / 100);
  END LOOP;

  v_cart_discount_amount := (v_new_subtotal * v_new_cart_discount_percent) / 100;
  v_new_total := GREATEST(0, v_new_subtotal - v_cart_discount_amount - v_new_extra_discount);

  IF v_invoice.amount_paid >= v_invoice.total_amount AND v_invoice.total_amount > 0 THEN
    v_old_payment_term := 'full';
  ELSIF v_invoice.amount_paid > 0 THEN
    v_old_payment_term := 'partial';
  ELSE
    v_old_payment_term := 'credit';
  END IF;

  SELECT id INTO v_ar_account FROM accounts WHERE code = '1100' LIMIT 1;
  SELECT id INTO v_revenue_account FROM accounts WHERE code = '4000' LIMIT 1;
  SELECT id INTO v_cogs_account FROM accounts WHERE code = '5000' LIMIT 1;
  SELECT id INTO v_inventory_account FROM accounts WHERE code = '1200' LIMIT 1;
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
    'total_amount', v_invoice.total_amount, 'amount_paid', v_invoice.amount_paid, 'status', v_invoice.status,
    'payment_term', v_old_payment_term, 'payments', v_old_payments,
    'items', (SELECT json_agg(json_build_object('product_id', ii.product_id, 'quantity', ii.quantity, 'unit_price', ii.unit_price, 'discount_percent', ii.discount_percent, 'subtotal', ii.subtotal, 'unit_name', ii.unit_name, 'base_quantity', ii.base_quantity, 'warehouse_id', ii.warehouse_id)) FROM invoice_items ii WHERE ii.invoice_id = p_invoice_id)
  ) INTO v_old_snapshot;

  -- STEP 1: FIFO - Restore batch quantities for old items FIRST
  FOR v_item IN SELECT * FROM invoice_items WHERE invoice_id = p_invoice_id LOOP
    PERFORM restore_fifo(v_item.id);
  END LOOP;

  -- STEP 1b: Restore stock for old items (PRESERVE original sale movements)
  FOR v_item IN SELECT * FROM invoice_items WHERE invoice_id = p_invoice_id LOOP
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
      -- NOTE: We DO NOT delete original sale movements here anymore to preserve audit trail
    END IF;
  END LOOP;

  -- STEP 2: Reverse AR + Revenue journal entry
  IF v_ar_account IS NOT NULL AND v_revenue_account IS NOT NULL AND v_invoice.total_amount > 0 THEN
    PERFORM post_journal_entry(
      'REVERSAL - AR - Invoice ' || v_invoice.invoice_number || ' EDIT', COALESCE(v_invoice.invoice_date, CURRENT_DATE), 'invoice_edit', p_invoice_id,
      json_build_array(
        json_build_object('account_id', v_ar_account, 'debit', 0, 'credit', v_invoice.total_amount, 'description', 'Reverse AR for edited invoice ' || v_invoice.invoice_number),
        json_build_object('account_id', v_revenue_account, 'debit', v_invoice.total_amount, 'credit', 0, 'description', 'Reverse revenue for edited invoice ' || v_invoice.invoice_number)
      )::json, v_invoice.customer_id
    );
  END IF;

  -- STEP 3: Delete original COGS journal entries and roll back account balances
  FOR v_je_id IN
    SELECT je.id FROM journal_entries je
    WHERE je.reference_type = 'invoice'
      AND je.reference_id = p_invoice_id
      AND je.description LIKE 'COGS%'
  LOOP
    -- Aggregated rollback: subtract the SUM of every line this JE posted to
    -- the account. (The old UPDATE ... FROM join picked ONE arbitrary line per
    -- account whenever the JE held several lines on it — multi-item COGS JEs
    -- carry one Dr 5000 + one Cr 1200 line PER ITEM — so most of the balance
    -- effect stayed in the cache; surfaced as the Tk 544,356 1200/5000 drift
    -- after the 2026-09-02 INV-940648 edit.)
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

  -- STEP 4: Reverse original payments AND mark them as reversed
  FOR v_payment IN SELECT * FROM payments WHERE reference_type = 'invoice' AND reference_id = p_invoice_id AND is_reversed = false LOOP
    INSERT INTO payments (payment_number, payment_type, payment_method, amount, payment_date, reference_type, reference_id, reference_number, notes, payment_for)
    VALUES ('REV-' || COALESCE(v_payment.payment_number, 'PAY'), CASE WHEN v_payment.payment_type = 'received' THEN 'refund' ELSE 'payment' END, v_payment.payment_method, v_payment.amount, CURRENT_DATE, 'invoice_edit', p_invoice_id, v_invoice.invoice_number, 'Reversal payment for edited invoice ' || v_invoice.invoice_number, 'reversal_payment');
    UPDATE payments SET is_reversed = true WHERE id = v_payment.id;
  END LOOP;

  -- Delete original payment journal entries and roll back account balances
  FOR v_je_id IN
    SELECT je.id FROM journal_entries je
    WHERE je.reference_type = 'payment'
      AND je.reference_id IN (SELECT id FROM payments WHERE reference_type = 'invoice' AND reference_id = p_invoice_id)
  LOOP
    -- Same aggregated rollback as STEP 3 (SUM all of the JE's lines per account).
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

  -- STEP 5: Update invoice header
  UPDATE invoices
  SET customer_id = v_new_customer, invoice_date = v_new_date, due_date = v_new_due_date, notes = v_new_notes,
      reference = v_new_reference,
      subtotal = v_new_subtotal, cart_discount_percent = v_new_cart_discount_percent, extra_discount = v_new_extra_discount,
      discount_amount = v_cart_discount_amount, total_amount = v_new_total, amount_paid = 0,
      status = 'draft', edit_count = COALESCE(edit_count, 0) + 1, updated_at = now()
  WHERE id = p_invoice_id;

  -- STEP 5b: Set session flag to prevent DELETE trigger from double-restoring stock
  PERFORM set_config('app.edit_invoice_active', 'true', true);

  -- STEP 6: Re-insert items
  DELETE FROM invoice_items WHERE invoice_id = p_invoice_id;
  FOR v_i IN SELECT generate_series(0, json_array_length(v_new_items) - 1) LOOP
    v_new_item := v_new_items->v_i;
    INSERT INTO invoice_items (invoice_id, product_id, quantity, unit_price, cost_price, discount_percent, tax_rate, subtotal, unit_name, unit_conversion_factor, base_quantity, warehouse_id, sort_order)
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

  -- STEP 6b: Sync delivery_items
  FOR v_delivery IN SELECT id FROM deliveries WHERE invoice_id = p_invoice_id AND status != 'delivered' LOOP
    DELETE FROM delivery_items WHERE delivery_id = v_delivery.id;
    FOR v_i IN SELECT generate_series(0, json_array_length(v_new_items) - 1) LOOP
      v_new_item := v_new_items->v_i;
      INSERT INTO delivery_items (delivery_id, product_id, quantity, delivered_quantity, unit_name, base_quantity)
      VALUES (
        v_delivery.id,
        (v_new_item->>'product_id')::uuid,
        (v_new_item->>'quantity')::numeric,
        0,
        NULLIF(v_new_item->>'unit_name', ''),
        COALESCE((v_new_item->>'base_quantity')::numeric, (v_new_item->>'quantity')::numeric)
      );
    END LOOP;
  END LOOP;

  -- STEP 7: Re-post AR + Revenue for new total
  IF v_ar_account IS NOT NULL AND v_revenue_account IS NOT NULL AND v_new_total > 0 THEN
    PERFORM post_journal_entry(
      'AR - Invoice ' || v_invoice.invoice_number || ' EDITED', v_new_date, 'invoice', p_invoice_id,
      json_build_array(
        json_build_object('account_id', v_ar_account, 'debit', v_new_total, 'credit', 0, 'description', 'AR for edited invoice ' || v_invoice.invoice_number),
        json_build_object('account_id', v_revenue_account, 'debit', 0, 'credit', v_new_total, 'description', 'Revenue for edited invoice ' || v_invoice.invoice_number)
      )::json, v_new_customer
    );
  END IF;

  -- STEP 7b: Post COGS journal entry for new items (FIXED: fallback to cost_price * quantity when no FIFO)
  IF v_cogs_account IS NOT NULL AND v_inventory_account IS NOT NULL THEN
    DECLARE
      v_cogs_total decimal(15,2) := 0;
      v_has_fifo_data boolean := false;
    BEGIN
      -- Check if we have any FIFO consumption data for new items
      FOR v_item IN SELECT ii.*, p.name as product_name, p.sku FROM invoice_items ii JOIN products p ON ii.product_id = p.id WHERE ii.invoice_id = p_invoice_id ORDER BY ii.sort_order LOOP
        v_cost := 0;
        SELECT COALESCE(SUM(cogs_amount), 0) INTO v_cost
        FROM invoice_item_batch_consumption WHERE invoice_item_id = v_item.id;
        
        IF v_cost > 0 THEN
          v_cogs_total := v_cogs_total + v_cost;
          v_has_fifo_data := true;
        END IF;
      END LOOP;
      
      -- If we have FIFO data, post it
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
        -- FALLBACK: Calculate COGS from cost_price * quantity for items without FIFO data
        v_cogs_total := 0;
        FOR v_item IN SELECT ii.*, p.name as product_name, p.sku FROM invoice_items ii JOIN products p ON ii.product_id = p.id WHERE ii.invoice_id = p_invoice_id ORDER BY ii.sort_order LOOP
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
      INSERT INTO payments (payment_number, payment_type, payment_method, amount, payment_date, reference_type, reference_id, reference_number, notes, payment_for)
      VALUES ('EDIT-' || v_invoice.invoice_number, 'received', v_new_payment_method, v_new_partial_amount, v_new_date, 'invoice', p_invoice_id, v_invoice.invoice_number, 'Partial payment for edited invoice ' || v_invoice.invoice_number, 'paid_invoice_pay')
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
      INSERT INTO payments (payment_number, payment_type, payment_method, amount, payment_date, reference_type, reference_id, reference_number, notes, payment_for)
      VALUES ('EDIT-' || v_invoice.invoice_number, 'received', v_new_payment_method, v_new_total, v_new_date, 'invoice', p_invoice_id, v_invoice.invoice_number, 'Payment for edited invoice ' || v_invoice.invoice_number, 'paid_invoice_pay')
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
      UPDATE invoices SET status = 'paid', amount_paid = v_new_total WHERE id = p_invoice_id;
    ELSE
      UPDATE invoices SET status = 'paid', amount_paid = 0 WHERE id = p_invoice_id;
    END IF;
  END IF;

  -- STEP 9: Record edit history
  SELECT json_build_object('customer_id', v_new_customer, 'invoice_date', v_new_date, 'due_date', v_new_due_date, 'notes', v_new_notes, 'reference', v_new_reference, 'subtotal', v_new_subtotal, 'cart_discount_percent', v_new_cart_discount_percent, 'extra_discount', v_new_extra_discount, 'total_amount', v_new_total, 'payment_term', v_new_payment_term, 'payment_method', v_new_payment_method, 'items', v_new_items) INTO v_new_snapshot;

  INSERT INTO invoice_edit_history (invoice_id, invoice_number, edited_by_name, change_type, reason, snapshot_before, snapshot_after, old_value, new_value)
  VALUES (p_invoice_id, v_invoice.invoice_number, p_edited_by, 'full_edit', p_reason, v_old_snapshot, v_new_snapshot, v_old_snapshot, v_new_snapshot);

  -- STEP 10: Update customer outstanding_balance
  IF v_invoice.customer_id IS NOT NULL THEN
    UPDATE customers SET outstanding_balance = (SELECT COALESCE(SUM(balance_due), 0) FROM invoices WHERE customer_id = v_invoice.customer_id AND status IN ('sent', 'partially_paid', 'unpaid', 'overdue')), updated_at = now() WHERE id = v_invoice.customer_id;
  END IF;
  IF v_new_customer IS NOT NULL AND v_new_customer <> v_invoice.customer_id THEN
    UPDATE customers SET outstanding_balance = (SELECT COALESCE(SUM(balance_due), 0) FROM invoices WHERE customer_id = v_new_customer AND status IN ('sent', 'partially_paid', 'unpaid', 'overdue')), updated_at = now() WHERE id = v_new_customer;
  END IF;

  RETURN json_build_object('success', true, 'invoice_id', p_invoice_id, 'old_total', v_invoice.total_amount, 'new_total', v_new_total);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 2) One-time repair: recompute every cached account balance from its journal
--    lines (audited into account_balance_recompute_audit). Idempotent: a
--    second run changes nothing.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  v_derived numeric;
  v_changed integer := 0;
BEGIN
  FOR r IN
    SELECT a.id, a.code, a.name, a.account_type, a.balance
    FROM accounts a
    ORDER BY a.code
  LOOP
    SELECT CASE
             WHEN r.account_type IN ('liability', 'equity', 'revenue')
               THEN COALESCE(SUM(jl.credit - jl.debit), 0)
             ELSE COALESCE(SUM(jl.debit - jl.credit), 0)
           END
      INTO v_derived
    FROM journal_lines jl
    WHERE jl.account_id = r.id;

    IF r.balance IS DISTINCT FROM v_derived THEN
      INSERT INTO account_balance_recompute_audit
        (account_id, code, name, old_balance, new_balance, delta)
      VALUES
        (r.id, r.code, r.name, r.balance, v_derived, v_derived - r.balance);
      UPDATE accounts SET balance = v_derived WHERE id = r.id;
      v_changed := v_changed + 1;
      RAISE NOTICE 'edit_invoice rollback fix: % % % -> %', r.code, r.name, r.balance, v_derived;
    END IF;
  END LOOP;
  RAISE NOTICE 'edit_invoice rollback fix: recomputed % account balance(s)', v_changed;
END $$;

-- ---------------------------------------------------------------------------
-- 3) Post-check: the reconciliation's balance-cache check must now be clean.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_drift int;
BEGIN
  SELECT COUNT(*) INTO v_drift
  FROM get_inventory_reconciliation()
  WHERE sort_key = 4 AND status = 'drift';
  IF v_drift > 0 THEN
    RAISE EXCEPTION 'edit_invoice rollback fix: account balance cache still drifts after recompute';
  END IF;
  RAISE NOTICE 'edit_invoice rollback fix: reconciliation check 4 clean';
END $$;

COMMIT;
