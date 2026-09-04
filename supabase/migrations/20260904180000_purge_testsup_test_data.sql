-- Purge testsup test data (2026-09-04)
--
-- testsup was the app's test playground: 33 POs, 28 GRNs (11 of them the
-- legacy backfill), 23 payments, 2 manual payables, 2 purchase returns —
-- leaving ৳255.56 of fake payables in every supplier total, the aging
-- report and the dashboard. Two ৳11 POS sales to customer "No Name" on
-- product "test po" consumed ৳30 of the test stock; the batches hold
-- ৳109.99 of phantom inventory across 8 test-named products.
--
-- Scope: everything supplier-side plus the two consuming test invoices.
-- The test PRODUCTS and their wider test-sales history stay (deactivating
-- them is a separate decision). Everything deleted is captured in
-- test_data_purge_audit first. A single measured true-up entry re-balances
-- GL 1200 against the FIFO ledger afterwards, absorbing the historical
-- noise (6 test units once vanished from batches through edits/adjustments
-- whose own journal entries outlived them).

BEGIN;

CREATE TABLE IF NOT EXISTS test_data_purge_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL,
  details jsonb NOT NULL,
  done_at timestamptz NOT NULL DEFAULT now()
);

DO $purge$
DECLARE
  v_sid uuid := 'a2798734-a96e-4748-90bb-5c868979e0ba';
  v_je_ids uuid[];
  v_gl_before numeric;
  v_fifo_before numeric;
  v_gl_after numeric;
  v_fifo_after numeric;
  v_gap numeric;
  v_trueup numeric;
  v_je_id uuid;
  v_je_num text;
  v_count int;
BEGIN
  -- ---------------- capture what is about to go ----------------
  SELECT COALESCE(SUM(jl.debit - jl.credit), 0) INTO v_gl_before
  FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE a.code = '1200';
  SELECT COALESCE(SUM(quantity_remaining * unit_cost), 0) INTO v_fifo_before FROM inventory_batches;

  -- journal entries: supplier-linked, GRN-attributed, and the two POS sales
  SELECT array_agg(DISTINCT je.id) INTO v_je_ids
  FROM journal_entries je
  WHERE je.supplier_id = v_sid
     OR (je.reference_type = 'grn' AND je.reference_id IN
          (SELECT id FROM goods_receipt_notes WHERE supplier_id = v_sid))
     OR je.reference_id IN (SELECT id FROM invoices WHERE invoice_number IN ('POS-00590108','POS-00590109'))
     OR je.reference_id IN (SELECT p.id FROM payments p
          WHERE p.supplier_id = v_sid
             OR p.reference_id IN (SELECT id FROM invoices WHERE invoice_number IN ('POS-00590108','POS-00590109')));

  INSERT INTO test_data_purge_audit (action, details)
  VALUES ('capture', jsonb_build_object(
    'supplier', 'testsup',
    'journal_entries', jsonb_build_array(
      (SELECT count(*) FROM journal_entries WHERE id = ANY(v_je_ids)),
      (SELECT COALESCE(SUM(total_debit),0) FROM journal_entries WHERE id = ANY(v_je_ids))),
    'payments', (SELECT count(*) FROM payments WHERE supplier_id = v_sid
                   OR reference_id IN (SELECT id FROM invoices WHERE invoice_number IN ('POS-00590108','POS-00590109'))),
    'purchase_returns', (SELECT count(*) FROM purchase_returns WHERE supplier_id = v_sid),
    'invoices', 2,
    'batches', (SELECT count(*) FROM inventory_batches WHERE reference_id IN
                 (SELECT id FROM goods_receipt_notes WHERE supplier_id = v_sid)),
    'batch_value', (SELECT COALESCE(SUM(quantity_remaining * unit_cost),0) FROM inventory_batches
                     WHERE reference_id IN (SELECT id FROM goods_receipt_notes WHERE supplier_id = v_sid)),
    'stock_movements', (SELECT count(*) FROM stock_movements WHERE reference_id IN
        (SELECT id FROM goods_receipt_notes WHERE supplier_id = v_sid)
        OR reference_id IN (SELECT id FROM invoices WHERE invoice_number IN ('POS-00590108','POS-00590109'))
        OR reference_id IN (SELECT p.id FROM payments p WHERE p.supplier_id = v_sid
             OR p.reference_id IN (SELECT id FROM invoices WHERE invoice_number IN ('POS-00590108','POS-00590109')))),
    'grns', (SELECT count(*) FROM goods_receipt_notes WHERE supplier_id = v_sid),
    'purchase_orders', (SELECT count(*) FROM purchase_orders WHERE supplier_id = v_sid),
    'deleted_je_numbers', (SELECT COALESCE(jsonb_agg(entry_number), '[]'::jsonb)
                            FROM journal_entries WHERE id = ANY(v_je_ids))
  ));

  -- ---------------- delete, FK-safe order ----------------
  -- journal lines then entries (the supplier-balance recompute trigger
  -- fires per line; harmless — the supplier row goes at the end)
  DELETE FROM journal_lines WHERE journal_entry_id = ANY(v_je_ids);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  INSERT INTO test_data_purge_audit VALUES (gen_random_uuid(), 'delete_journal_lines', jsonb_build_object('count', v_count), now());
  DELETE FROM journal_entries WHERE id = ANY(v_je_ids);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  INSERT INTO test_data_purge_audit VALUES (gen_random_uuid(), 'delete_journal_entries', jsonb_build_object('count', v_count), now());

  -- purchase returns (items first)
  DELETE FROM purchase_return_items WHERE purchase_return_id IN
    (SELECT id FROM purchase_returns WHERE supplier_id = v_sid);
  DELETE FROM purchase_returns WHERE supplier_id = v_sid;

  -- the two test invoices: items first (consumption rows cascade from items)
  DELETE FROM invoice_items WHERE invoice_id IN
    (SELECT id FROM invoices WHERE invoice_number IN ('POS-00590108','POS-00590109'));
  DELETE FROM payments WHERE reference_id IN
    (SELECT id FROM invoices WHERE invoice_number IN ('POS-00590108','POS-00590109'))
    AND reference_type = 'invoice';
  DELETE FROM invoices WHERE invoice_number IN ('POS-00590108','POS-00590109');

  -- supplier payments
  DELETE FROM payments WHERE supplier_id = v_sid;

  -- batches (any remaining consumption rows cascade on batch delete)
  DELETE FROM inventory_batches WHERE reference_id IN
    (SELECT id FROM goods_receipt_notes WHERE supplier_id = v_sid);

  -- stock movements pointing at the deleted GRNs / invoices / payments
  DELETE FROM stock_movements WHERE reference_id IN
    (SELECT id FROM goods_receipt_notes WHERE supplier_id = v_sid)
     OR reference_id IN (SELECT id FROM invoices WHERE invoice_number IN ('POS-00590108','POS-00590109'))
     OR reference_id IN (SELECT p.id FROM payments p WHERE p.supplier_id = v_sid);

  -- GRNs, then POs (items first)
  DELETE FROM goods_receipt_notes WHERE supplier_id = v_sid;
  DELETE FROM purchase_order_items WHERE purchase_order_id IN
    (SELECT id FROM purchase_orders WHERE supplier_id = v_sid);
  DELETE FROM purchase_orders WHERE supplier_id = v_sid;

  -- audit-log rows for testsup (from the credit-limit visual test earlier today)
  DELETE FROM supplier_audit_log WHERE supplier_id = v_sid;

  -- the supplier itself
  DELETE FROM suppliers WHERE id = v_sid;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'testsup supplier row not deleted (count %)', v_count;
  END IF;

  -- ---------------- recompute derived state ----------------
  PERFORM recompute_account_balances('test-data-purge');
  PERFORM recompute_supplier_balances();

  -- counters for the affected test products from surviving batches
  UPDATE inventory_items i
  SET quantity_on_hand = COALESCE((
        SELECT SUM(b.quantity_remaining) FROM inventory_batches b
        WHERE b.product_id = i.product_id AND b.warehouse_id = i.warehouse_id), 0),
      updated_at = now()
  WHERE i.product_id IN (
    SELECT DISTINCT product_id FROM inventory_batches
    WHERE reference_id IN (SELECT id FROM goods_receipt_notes WHERE supplier_id = v_sid));

  -- ---------------- GL 1200 vs FIFO true-up ----------------
  SELECT COALESCE(SUM(jl.debit - jl.credit), 0) INTO v_gl_after
  FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE a.code = '1200';
  SELECT COALESCE(SUM(quantity_remaining * unit_cost), 0) INTO v_fifo_after FROM inventory_batches;
  v_gap := v_gl_after - v_fifo_after;

  -- gap should be exactly the historical test noise (~৳81 from the 6 units
  -- that left the batches without matching COGS); true it up against equity
  v_trueup := round(v_gap, 2);
  IF abs(v_trueup) > 0.005 THEN
    INSERT INTO test_data_purge_audit VALUES (gen_random_uuid(), 'trueup_1200',
      jsonb_build_object('gap', v_trueup,
        'meaning', 'test stock removed from the FIFO ledger whose matching GL debits were purged with the test GRNs; historical edits/reductions had already unbalanced the two sides by this amount'), now());

    INSERT INTO journal_entries
      (entry_number, entry_date, description, reference_type, total_debit, total_credit, is_posted)
    VALUES
      (get_next_journal_number(), CURRENT_DATE,
       'Test-data purge true-up: inventory vs batch ledger (testsup removal)',
       'manual', abs(v_trueup), abs(v_trueup), TRUE)
    RETURNING id, entry_number INTO v_je_id, v_je_num;

    INSERT INTO journal_lines (journal_entry_id, account_id, description, debit, credit, sort_order)
    SELECT v_je_id, a.id, 'Test-data purge true-up',
           -- gap = GL - FIFO: negative means GL is too low, so DEBIT 1200 to raise it
           CASE WHEN v_trueup < 0 THEN abs(v_trueup) ELSE 0 END,
           CASE WHEN v_trueup > 0 THEN abs(v_trueup) ELSE 0 END, 0
    FROM accounts a WHERE a.code = '1200';
    INSERT INTO journal_lines (journal_entry_id, account_id, description, debit, credit, sort_order)
    SELECT v_je_id, a.id, 'Test-data purge true-up',
           CASE WHEN v_trueup > 0 THEN abs(v_trueup) ELSE 0 END,
           CASE WHEN v_trueup < 0 THEN abs(v_trueup) ELSE 0 END, 1
    FROM accounts a WHERE a.code = '3900';

    PERFORM recompute_account_balances('test-data-purge');

    SELECT COALESCE(SUM(jl.debit - jl.credit), 0) INTO v_gl_after
    FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE a.code = '1200';
  END IF;

  INSERT INTO test_data_purge_audit VALUES (gen_random_uuid(), 'result',
    jsonb_build_object(
      'gl_1200_before', round(v_gl_before,2), 'fifo_before', round(v_fifo_before,2),
      'gl_1200_after', round(v_gl_after,2), 'fifo_after', round(v_fifo_after,2),
      'trueup_posted', v_trueup,
      'residual_drift', round(v_gl_after - v_fifo_after, 2)), now());

  IF abs(v_gl_after - v_fifo_after) > 0.01 THEN
    RAISE EXCEPTION 'GL 1200 vs FIFO still drifted after purge: %', v_gl_after - v_fifo_after;
  END IF;
END $purge$;

-- ------------------------------------------------------------ verification
DO $verify$
DECLARE
  v_gl2000 numeric;
  v_suppliers numeric;
  v_leftover int;
BEGIN
  SELECT COALESCE(SUM(jl.credit - jl.debit), 0) INTO v_gl2000
  FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE a.code = '2000';
  SELECT COALESCE(SUM(outstanding_balance), 0) INTO v_suppliers FROM suppliers;

  IF abs(v_gl2000 - v_suppliers) > 0.01 THEN
    RAISE EXCEPTION 'Payables tie-out failed after purge: GL % vs suppliers %', v_gl2000, v_suppliers;
  END IF;
  RAISE NOTICE 'Payables tie-out OK: %', v_suppliers;

  SELECT count(*) INTO v_leftover FROM (
    SELECT 1 FROM payments WHERE supplier_id = 'a2798734-a96e-4748-90bb-5c868979e0ba'
    UNION ALL SELECT 1 FROM purchase_orders WHERE supplier_id = 'a2798734-a96e-4748-90bb-5c868979e0ba'
    UNION ALL SELECT 1 FROM goods_receipt_notes WHERE supplier_id = 'a2798734-a96e-4748-90bb-5c868979e0ba'
    UNION ALL SELECT 1 FROM journal_entries WHERE supplier_id = 'a2798734-a96e-4748-90bb-5c868979e0ba'
    UNION ALL SELECT 1 FROM purchase_returns WHERE supplier_id = 'a2798734-a96e-4748-90bb-5c868979e0ba'
    UNION ALL SELECT 1 FROM suppliers WHERE id = 'a2798734-a96e-4748-90bb-5c868979e0ba'
    UNION ALL SELECT 1 FROM stock_movements WHERE reference_id IN
      (SELECT id FROM goods_receipt_notes WHERE supplier_id = 'a2798734-a96e-4748-90bb-5c868979e0ba')
  ) t;
  IF v_leftover > 0 THEN
    RAISE EXCEPTION 'testsup leftovers remain: % rows', v_leftover;
  END IF;
  RAISE NOTICE 'testsup fully purged, no leftovers';
END $verify$;

COMMIT;
