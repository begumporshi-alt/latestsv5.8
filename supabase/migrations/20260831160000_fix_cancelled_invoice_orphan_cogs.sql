-- Migration: 20260831160000_fix_cancelled_invoice_orphan_cogs.sql
--
-- Problem: When an invoice is cancelled, cancel_invoice() reverses COGS using
-- the FIFO consumption total. But invoices that have BOTH a lump COGS JE and
-- per-item COGS JEs (double-trigger bug) post MORE COGS than the FIFO total,
-- so the reversal only offsets the lump JE — the per-item JEs stay orphaned
-- in the GL forever, inflating account 5000 (e.g. POS-00590095: +৳560,583 orphan).
--
-- Fixes:
--   1. cancel_invoice(): compute reversal amount from the ACTUAL posted COGS
--      journal entries (net of prior reversals) instead of FIFO consumption.
--      Guarantees exact reversal no matter how many COGS JEs exist.
--   2. get_cogs_audit(): include cancelled/draft invoices and flag them as
--      CANCELLED_ORPHAN (expected COGS = 0, journal > 0) so they appear on the
--      audit page and can be cleaned via bulk fix.
--   3. delete_duplicate_cogs_je(): relax the is_posted guard difference — allow
--      deleting ALL COGS JEs of a cancelled invoice (postings AND their
--      reversals net to zero, so removing both is GL-neutral and removes orphans).

-- ─────────────────────────────────────────────────────────────
-- 1. cancel_invoice(): reversal amount from posted JEs, not FIFO
--    (DROP first: original returns json, this returns jsonb)
-- ─────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS cancel_invoice(uuid, text, text);

CREATE OR REPLACE FUNCTION public.cancel_invoice(
  p_invoice_id uuid,
  p_reason text,
  p_cancelled_by text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  -- Restore advance payments
  UPDATE customer_advances
  SET remaining_balance = remaining_balance + amount_used, amount_used = 0, updated_at = now()
  WHERE invoice_id = p_invoice_id AND amount_used > 0;

  -- Reverse customer balance effect
  UPDATE customers
  SET balance = balance - (v_invoice.total_amount - COALESCE(v_invoice.amount_paid, 0)),
      total_purchases = total_purchases - v_invoice.total_amount,
      updated_at = now()
  WHERE id = v_invoice.customer_id;

  -- Cancel payments
  FOR v_payment IN SELECT * FROM payments WHERE reference_type = 'invoice' AND reference_id = p_invoice_id AND is_reversed = false LOOP
    v_total_payments := v_total_payments + v_payment.amount;
    UPDATE payments SET is_reversed = true, updated_at = now() WHERE id = v_payment.id;

    SELECT 'RVP-' || COALESCE(MAX(CAST(SUBSTRING(payment_number FROM 5) AS INTEGER)) + 1, 1)
    INTO v_rev_pay_num FROM payments WHERE payment_number LIKE 'RVP-%';

    INSERT INTO payments (payment_number, payment_type, reference_type, reference_id, customer_id, supplier_id,
      amount, payment_method, payment_date, reference_number, notes, created_by)
    VALUES (
      v_rev_pay_num, 'refund', 'invoice', p_invoice_id, v_payment.customer_id, v_payment.supplier_id,
      v_payment.amount, v_payment.payment_method, CURRENT_DATE, v_payment.payment_number,
      'Auto-refund on invoice cancellation', auth.uid()
    );
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
$$;

COMMENT ON FUNCTION cancel_invoice(uuid,text,text) IS
'Cancelled invoices now reverse the FULL posted COGS (net of prior reversals) instead of the FIFO
consumption total — fixes orphan per-item COGS JEs left in the GL when an invoice has both lump
and per-item COGS postings.';

-- ─────────────────────────────────────────────────────────────
-- 2. get_cogs_audit(): include cancelled invoices; flag CANCELLED_ORPHAN only
--    when the net GL 5000 impact of COGS postings + cancel reversals is
--    nonzero (true orphan), incl. stray-reversal-only cases. Reversal JEs are
--    included in cogs_journal_entries so the fix flow deletes both sides.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_cogs_audit()
RETURNS TABLE (
  aud_invoice_id            uuid,
  invoice_number            text,
  invoice_date              date,
  invoice_status            text,
  invoice_total             numeric,
  customer_name             text,
  warehouse_name            text,
  item_count                integer,
  expected_cogs_a           numeric,
  expected_cogs_b           numeric,
  journal_cogs_c            numeric,
  journal_je_count          integer,
  fifo_cogs_d               numeric,
  cogs_journal_entries      jsonb,
  keeper_je_id              uuid,
  keeper_je_total           numeric,
  keeper_je_diff            numeric,
  all_je_diff               numeric,
  issue_type                text,
  fix_action                text,
  balance_impact            numeric,
  audit_status              text,
  has_per_item_je           boolean,
  has_lump_je               boolean,
  per_item_je_ids           uuid[],
  lump_je_ids               uuid[],
  fifo_consumptions         jsonb,
  item_fifo_totals          jsonb,
  root_cause                text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invoice     RECORD;
  v_je          RECORD;
  v_consume     RECORD;
  v_item_cnt    integer := 0;
  v_is_per_item boolean;

  v_expected_a       numeric := 0;
  v_expected_b       numeric := 0;
  v_journal_cogs     numeric := 0;
  v_fifo_cogs        numeric := 0;
  v_je_count         integer := 0;
  v_keeper_je_id     uuid;
  v_keeper_total     numeric := 0;
  v_keeper_diff      numeric := 999999999;
  v_all_je_diff      numeric := 0;
  v_balance_impact   numeric := 0;
  v_fix_action       text := 'NONE';
  v_issue_type       text := 'EXACT';
  v_audit_status     text := 'CONSISTENT';
  v_has_per_item     boolean := false;
  v_has_lump         boolean := false;
  v_per_item_ids     uuid[]  := '{}';
  v_lump_ids         uuid[]  := '{}';
  v_cogs_jes         jsonb := '[]'::jsonb;
  v_fifo_conset      jsonb := '[]'::jsonb;
  v_item_fifo_ttls   jsonb := '[]'::jsonb;
  v_root_cause       text := NULL;
  v_per_item_total   numeric := 0;
  v_lump_total       numeric := 0;
  v_is_cancelled     boolean := false;
  v_reversal_count   integer := 0;
  v_reversal_total   numeric := 0;
  v_net_gl5000       numeric := 0;
BEGIN
  FOR v_invoice IN
    SELECT i.id, i.invoice_number, i.invoice_date, i.status,
           i.total_amount, i.customer_id, i.warehouse_id,
           c.name AS customer_name, w.name AS warehouse_name
    FROM   invoices i
    LEFT   JOIN customers c ON c.id = i.customer_id
    LEFT   JOIN warehouses w ON w.id = i.warehouse_id
    WHERE  i.status != 'draft'
    ORDER  BY i.invoice_date ASC, i.invoice_number ASC
  LOOP
    v_is_cancelled := (v_invoice.status = 'cancelled');

    -- ── Source A: SUM(items.quantity * cost_price) ──────────
    SELECT COALESCE(SUM(quantity * cost_price), 0), COUNT(*)
    INTO   v_expected_a, v_item_cnt
    FROM   invoice_items
    WHERE  invoice_id = v_invoice.id AND quantity > 0;

    -- Cancelled invoices have zero expected COGS
    IF v_is_cancelled THEN
      v_expected_a := 0;
    END IF;

    -- ── Source B: cost_price_history ────────────────────────
    SELECT COALESCE(SUM(quantity * cost_price_per_qty), 0)
    INTO   v_expected_b
    FROM   cost_price_history
    WHERE  invoice_id = v_invoice.id;
    IF v_is_cancelled THEN v_expected_b := 0; END IF;

    -- ── Source C: COGS journal entries ──────────────────────
    v_cogs_jes := '[]'::jsonb;
    v_je_count := 0;
    v_journal_cogs := 0;
    v_per_item_ids := '{}';
    v_lump_ids := '{}';
    v_has_per_item := false;
    v_has_lump := false;
    v_per_item_total := 0;
    v_lump_total := 0;
    v_reversal_count := 0;
    v_reversal_total := 0;
    v_net_gl5000 := 0;

    FOR v_je IN
      SELECT je.id, je.entry_date, je.description, je.total_debit,
             je.reference_type, je.reference_id, je.is_posted,
             je.entry_number
      FROM   journal_entries je
      WHERE  je.reference_type IN ('invoice', 'invoice_edit')
        AND  je.reference_id   = v_invoice.id
        AND  je.description ~* '^COGS'
        AND  je.is_posted = true
      ORDER  BY je.entry_date ASC, je.id ASC
    LOOP
      v_je_count := v_je_count + 1;
      v_journal_cogs := v_journal_cogs + v_je.total_debit;

      BEGIN
        v_is_per_item := (v_je.description ~ ' - .+ - Item ');
        v_has_per_item := v_has_per_item OR v_is_per_item;
        v_has_lump := v_has_lump OR NOT v_is_per_item;

        IF v_is_per_item THEN
          v_per_item_ids := array_append(v_per_item_ids, v_je.id);
          v_per_item_total := v_per_item_total + v_je.total_debit;
        ELSE
          v_lump_ids := array_append(v_lump_ids, v_je.id);
          v_lump_total := v_lump_total + v_je.total_debit;
        END IF;
      END;

      v_cogs_jes := v_cogs_jes || jsonb_build_array(jsonb_build_object(
        'id',            v_je.id,
        'entry_number',  v_je.entry_number,
        'entry_date',    v_je.entry_date,
        'description',   v_je.description,
        'total_debit',   v_je.total_debit,
        'is_per_item',   v_is_per_item,
        'diff_from_expected', ROUND((v_je.total_debit - v_expected_a)::numeric, 2)
      ));
    END LOOP;

    -- Cancel reversals (invoice_cancel): include them in the JE list so the
    -- fix flow removes originals AND reversals together (GL-neutral cleanup).
    FOR v_je IN
      SELECT je.id, je.entry_date, je.description, je.total_debit,
             je.reference_type, je.reference_id, je.is_posted,
             je.entry_number
      FROM   journal_entries je
      WHERE  je.reference_type = 'invoice_cancel'
        AND  je.reference_id   = v_invoice.id
        AND  je.description ~* '^Reverse COGS'
        AND  je.is_posted = true
      ORDER  BY je.entry_date ASC, je.id ASC
    LOOP
      v_reversal_count := v_reversal_count + 1;
      v_reversal_total := v_reversal_total + v_je.total_debit;
      v_cogs_jes := v_cogs_jes || jsonb_build_array(jsonb_build_object(
        'id',            v_je.id,
        'entry_number',  v_je.entry_number,
        'entry_date',    v_je.entry_date,
        'description',   v_je.description,
        'total_debit',   v_je.total_debit,
        'is_per_item',   false,
        'is_reversal',   true,
        'diff_from_expected', 0
      ));
    END LOOP;

    -- Net GL 5000 impact across ALL COGS postings + reversals.
    -- A cancelled invoice is only clean when this nets to ~zero.
    SELECT COALESCE(SUM(jl.debit - jl.credit), 0)
    INTO   v_net_gl5000
    FROM   journal_lines jl
    JOIN   journal_entries je ON je.id = jl.journal_entry_id
    JOIN   accounts a ON a.id = jl.account_id
    WHERE  je.reference_type IN ('invoice', 'invoice_edit', 'invoice_cancel')
      AND  je.reference_id   = v_invoice.id
      AND  (je.description ~* '^COGS' OR je.description ~* '^Reverse COGS')
      AND  je.is_posted = true
      AND  a.code = '5000';

    -- ── Source D: FIFO consumption ─────────────────────────
    v_fifo_conset := '[]'::jsonb;
    v_fifo_cogs := 0;
    v_item_fifo_ttls := '[]'::jsonb;

    FOR v_consume IN
      SELECT iic.id, iic.invoice_item_id, iic.batch_id,
             iic.quantity_consumed AS consume_qty, iic.unit_cost, iic.cogs_amount,
             p.name AS product_name, p.sku AS product_sku,
             ib.batch_number,
             ii.product_id, ii.quantity AS item_qty, ii.cost_price AS item_cost_price,
             ROW_NUMBER() OVER (PARTITION BY iic.invoice_item_id ORDER BY ib.created_at ASC) AS batch_seq
      FROM   invoice_item_batch_consumption iic
      JOIN   invoice_items ii ON ii.id = iic.invoice_item_id
      JOIN   products p ON p.id = ii.product_id
      JOIN   inventory_batches ib ON ib.id = iic.batch_id
      WHERE  ii.invoice_id = v_invoice.id
      ORDER  BY ii.id, batch_seq
    LOOP
      v_fifo_cogs := v_fifo_cogs + COALESCE(v_consume.cogs_amount, 0);
      v_fifo_conset := v_fifo_conset || jsonb_build_array(jsonb_build_object(
        'consumption_id',   v_consume.id,
        'invoice_item_id',  v_consume.invoice_item_id,
        'batch_id',         v_consume.batch_id,
        'batch_number',     v_consume.batch_number,
        'product_name',     v_consume.product_name,
        'sku',              v_consume.product_sku,
        'batch_seq',        v_consume.batch_seq,
        'consume_qty',     v_consume.consume_qty,
        'cost_per_unit',   v_consume.unit_cost,
        'total_cost',       v_consume.cogs_amount,
        'item_qty',         v_consume.item_qty,
        'item_cost_price', v_consume.item_cost_price
      ));
    END LOOP;

    v_item_fifo_ttls := (
      SELECT jsonb_agg(row_to_json(t))
      FROM   (
        SELECT ii2.id AS invoice_item_id,
               p2.name AS product_name,
               p2.sku,
               ii2.quantity AS item_qty,
               ii2.cost_price AS item_cost_price,
               COALESCE(SUM(iibc.cogs_amount), 0) AS fifo_total,
               COUNT(iibc.id) AS batch_count,
               CASE WHEN ABS(COALESCE(SUM(iibc.cogs_amount),0) - (ii2.quantity * ii2.cost_price)) < 0.01
                    THEN 'EXACT' ELSE 'DRIFT' END AS fifo_vs_cost
        FROM   invoice_items ii2
        JOIN   products p2 ON p2.id = ii2.product_id
        LEFT   JOIN invoice_item_batch_consumption iibc ON iibc.invoice_item_id = ii2.id
        WHERE  ii2.invoice_id = v_invoice.id
        GROUP  BY ii2.id, p2.name, p2.sku, ii2.quantity, ii2.cost_price
        ORDER  BY ii2.id
      ) t
    );

    -- ── Auto-detect keeper JE ──────────────────────────────
    v_keeper_je_id   := NULL;
    v_keeper_total   := 0;
    v_keeper_diff    := 999999999;
    v_balance_impact := 0;

    IF v_je_count = 0 AND v_reversal_count = 0 THEN
      IF v_is_cancelled THEN
        -- Cancelled with no COGS JEs = clean
        v_audit_status := 'CONSISTENT';
        v_issue_type   := 'EXACT';
        v_fix_action   := 'NONE';
        v_root_cause   := NULL;
      ELSE
        v_audit_status := 'MISSING';
        v_issue_type   := 'MISSING';
        v_fix_action   := 'CREATE_JE';
        v_root_cause   := 'NO_COGS_JE';
      END IF;

    ELSIF v_is_cancelled THEN
      -- ── Cancelled invoice with COGS postings/reversals ──
      -- Correct end state: net GL 5000 impact of zero. Flag only when the
      -- postings and reversals do NOT cancel out (true orphan amount).
      IF ABS(v_net_gl5000) > 1.00 THEN
        v_keeper_je_id := NULL;
        v_keeper_total := 0;
        v_keeper_diff  := 0;
        v_audit_status := 'CANCELLED_ORPHAN';
        v_issue_type   := 'CANCELLED_ORPHAN';
        v_fix_action   := 'DELETE_ALL_COGS';
        v_root_cause   := CASE
                            WHEN v_net_gl5000 > 0 THEN 'CANCELLED_NOT_FULLY_REVERSED'
                            ELSE 'CANCELLED_STRAY_REVERSAL'
                          END;
        v_balance_impact := v_net_gl5000;  -- signed orphan net on GL 5000
      ELSE
        v_audit_status := 'CONSISTENT';
        v_issue_type   := 'EXACT';
        v_fix_action   := 'NONE';
        v_root_cause   := 'CANCELLED_FULLY_REVERSED';
      END IF;

    ELSIF v_je_count >= 1 THEN
      FOR v_je IN
        SELECT je.id, je.total_debit,
               ABS(je.total_debit - v_expected_a) AS diff
        FROM   journal_entries je
        WHERE  je.reference_type IN ('invoice', 'invoice_edit')
          AND  je.reference_id   = v_invoice.id
          AND  je.description ~* '^COGS'
          AND  je.is_posted = true
        ORDER  BY ABS(je.total_debit - v_expected_a) ASC, je.entry_date ASC
      LOOP
        IF v_keeper_je_id IS NULL THEN
          v_keeper_je_id  := v_je.id;
          v_keeper_total  := v_je.total_debit;
          v_keeper_diff   := v_je.diff;
        ELSE
          v_balance_impact := v_balance_impact + v_je.total_debit;
        END IF;
      END LOOP;

      IF v_keeper_diff <= 1.00
         OR (v_expected_a > 0 AND v_keeper_diff <= v_expected_a * 0.01 + 10)
         OR (v_expected_a = 0 AND v_keeper_diff = 0) THEN
        IF v_je_count = 1 THEN
          v_audit_status := 'CONSISTENT';
          v_issue_type   := 'EXACT';
          v_fix_action   := 'NONE';
          v_root_cause   := NULL;
        ELSE
          v_audit_status := 'DUPLICATE_COGS';
          v_issue_type   := 'DUPLICATE_COGS';
          v_fix_action   := 'DELETE_DUPLICATES';
          v_root_cause   := CASE
            WHEN v_has_per_item AND v_has_lump THEN 'DOUBLE_TRIGGER'
            ELSE 'MULTIPLE_JES'
          END;
        END IF;
      ELSE
        v_audit_status := 'MISMATCH';
        v_issue_type   := 'MISMATCH';
        v_fix_action   := 'REVIEW_MANUALLY';
        v_root_cause   := 'KEEPER_OUTSIDE_TOLERANCE';
      END IF;
    END IF;

    -- ── Emit row ──────────────────────────────────────────
    aud_invoice_id      := v_invoice.id;
    invoice_number      := v_invoice.invoice_number;
    invoice_date        := v_invoice.invoice_date;
    invoice_status      := v_invoice.status;
    invoice_total       := v_invoice.total_amount;
    customer_name       := v_invoice.customer_name;
    warehouse_name      := v_invoice.warehouse_name;
    item_count          := COALESCE(v_item_cnt, 0);
    expected_cogs_a     := ROUND(v_expected_a, 2);
    expected_cogs_b     := ROUND(v_expected_b, 2);
    journal_cogs_c      := ROUND(v_journal_cogs, 2);
    journal_je_count    := v_je_count;
    fifo_cogs_d         := ROUND(v_fifo_cogs, 2);
    cogs_journal_entries := v_cogs_jes;
    keeper_je_id        := v_keeper_je_id;
    keeper_je_total     := ROUND(v_keeper_total, 2);
    keeper_je_diff      := ROUND(v_keeper_diff, 2);
    all_je_diff         := ROUND(v_all_je_diff, 2);
    issue_type          := v_issue_type;
    fix_action          := v_fix_action;
    balance_impact      := ROUND(v_balance_impact, 2);
    audit_status        := v_audit_status;
    has_per_item_je     := v_has_per_item;
    has_lump_je         := v_has_lump;
    per_item_je_ids     := v_per_item_ids;
    lump_je_ids         := v_lump_ids;
    fifo_consumptions   := v_fifo_conset;
    item_fifo_totals    := v_item_fifo_ttls;
    root_cause          := v_root_cause;

    RETURN NEXT;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION get_cogs_audit() IS
'Per-invoice COGS audit incl. cancelled invoices (CANCELLED_ORPHAN status when COGS JEs were not
fully reversed). Compares items×cost_price (A), cost_price_history (B), journal COGS (C), FIFO (D).';

-- ─────────────────────────────────────────────────────────────
-- 3. Allow bulk delete of ALL COGS JEs on cancelled invoices
--    (postings + reversals net to zero, so removing both is GL-neutral
--     except for the orphan amount — exactly what we want to remove)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION delete_duplicate_cogs_je(
  p_je_id      uuid,
  p_reason     text,
  p_username   text DEFAULT 'system'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_je        journal_entries%ROWTYPE;
  v_invoice   invoices%ROWTYPE;
  v_result    jsonb;
  v_lines     integer := 0;
  v_invoice_is_cancelled boolean := false;
BEGIN
  IF p_reason IS NULL OR TRIM(p_reason) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Reason is required');
  END IF;

  SELECT * INTO v_je FROM journal_entries WHERE id = p_je_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success',       true,
      'idempotent',    true,
      'message',       'Journal entry not found — already deleted or never existed',
      'je_id',         p_je_id
    );
  END IF;

  -- Guard: must be COGS entry (postings or their reversals)
  IF v_je.description NOT ILIKE 'COGS%' AND v_je.description NOT ILIKE 'Reverse COGS%' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Only COGS journal entries can be deleted via this function');
  END IF;

  -- Guard: cannot delete draft (unposted) entries
  IF v_je.is_posted = false THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot delete draft (unposted) journal entries');
  END IF;

  -- Fetch linked invoice
  BEGIN
    SELECT * INTO v_invoice FROM invoices WHERE id = v_je.reference_id;
    v_invoice_is_cancelled := (v_invoice.status = 'cancelled');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  -- Guard: reversal entries may only be deleted when their invoice is cancelled
  -- (for active invoices, reversals are legitimate corrections — keep them)
  IF v_je.description ILIKE 'Reverse COGS%' AND NOT v_invoice_is_cancelled THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot delete a reversal entry of an active invoice');
  END IF;

  -- Audit trail before delete
  CREATE TABLE IF NOT EXISTS cogs_deletion_audit (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    je_id           uuid NOT NULL,
    invoice_id      uuid,
    invoice_number  text,
    entry_number    text,
    description     text,
    total_debit     numeric,
    total_credit    numeric,
    entry_date      date,
    deleted_by      text,
    reason          text,
    deleted_at      timestamptz DEFAULT NOW(),
    balance_impact  numeric
  );

  INSERT INTO cogs_deletion_audit
    (je_id, invoice_id, invoice_number, entry_number, description,
     total_debit, total_credit, entry_date, deleted_by, reason, balance_impact)
  VALUES
    (p_je_id, v_je.reference_id, v_invoice.invoice_number, v_je.entry_number,
     v_je.description, v_je.total_debit, v_je.total_credit,
     v_je.entry_date, p_username, p_reason,
     CASE WHEN v_je.total_debit > 0 THEN v_je.total_debit ELSE v_je.total_credit END)
  ON CONFLICT DO NOTHING;

  DELETE FROM journal_lines WHERE journal_entry_id = p_je_id;
  GET DIAGNOSTICS v_lines = ROW_COUNT;

  DELETE FROM journal_entries WHERE id = p_je_id;

  v_result := jsonb_build_object(
    'success',       true,
    'idempotent',    false,
    'je_id',         p_je_id,
    'invoice_id',    v_je.reference_id,
    'invoice_number',v_invoice.invoice_number,
    'description',   v_je.description,
    'debit_removed', v_je.total_debit,
    'lines_removed', v_lines,
    'reason',        p_reason,
    'deleted_by',    p_username,
    'deleted_at',    NOW()
  );

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION delete_duplicate_cogs_je(uuid,text,text) IS
'Deletes COGS journal entries with guards. Reversal entries are only deletable when the linked
invoice is cancelled (clean-up of fully-cancelled COGS postings). Audit trail in cogs_deletion_audit.';
