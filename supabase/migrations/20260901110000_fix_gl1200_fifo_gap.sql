-- ============================================================
-- Migration: Fix GL 1200 vs FIFO gap — purchase double-posting and
--            missing pre-journal-era batch entries
-- Date: 2026-09-01
--
-- VERIFIED FINDINGS (live DB audit 2026-09-01):
--
--   1. PURCHASE DOUBLE-POSTING. trg_po_accounting (AFTER UPDATE ON
--      purchase_orders → purchase_order_accounting_trigger) posts a
--      "Goods Received - PO-#x" journal (Dr 1200 / Cr 2000 at the PO's
--      FULL total_amount, reference_type='purchase_receipt') whenever a
--      PO's status becomes 'received'. The ONLY code path that sets that
--      status is the GRN save handler — which also creates the batches
--      and (since 20260901080000) posts the GRN journal via
--      post_grn_journal at the ACTUAL received value. Result: every
--      fully-received PO is journaled twice. 45 of 47 purchase_receipt
--      JEs duplicate a GRN journal (৳631,574.49 of the ৳631,581.44
--      total); the GRN side matches batch value exactly on all 47,
--      while the PO side even understates 4 POs (it uses PO total, not
--      received value). The remaining 2 (PO-000004/000008, ৳6.95) have
--      no batches at all.
--
--   2. PRE-JOURNAL-ERA BATCHES. Before the 2026-08-29 ERP-standard
--      routing, stock increases created inventory_batches without any
--      journal entry:
--        - adjustment batches: ৳9,560,074.60 received vs ৳6,730,337.86
--          journaled on 1200 → ৳2,829,736.74 missing (Dr 1200/Cr 5900)
--        - product_creation opening batches: ৳860,877.80 received vs
--          ৳62,585.00 journaled → ৳798,292.80 missing (Dr 1200/Cr 3900)
--
-- THIS MIGRATION:
--   A. Drops trg_po_accounting + its function (post_grn_journal is the
--      single, correct purchase-journal path from now on).
--   B. Deletes all 47 purchase_receipt journal entries (balance-
--      reversing, audited in gl_fifo_repair_audit).
--   C. Backfills the missing pre-journal-era batch journals as two
--      consolidated entries dated 2026-08-28 (the last pre-fix day),
--      following create_opening_batch's conventions (adjustment →
--      Cr 5900, opening/creation → Cr 3900).
--
-- NOT touched (verified legitimate or out of scope):
--   - 'invoice_item' negative batches (৳-310,936.53): FIFO-fallback
--     rows for sales without sufficient batch stock.
--   - stock reduction credits (GL ৳114,780.60 = negative audit batch
--     rows exactly).
--   - The remaining GL-vs-FIFO residual (~৳7.5M) is the 2026-08-08
--     FIFO-cutover divergence (GL ৳17.35M vs reconstructed opening
--     batches ৳10.77M) plus pre-FIFO-era strays — a baseline accounting
--     decision, reported to the user, not mechanically repairable.
--
-- Expected GL 1200 after this migration:
--   23,485,470.64 - 631,581.44 + 3,628,029.54 = 26,481,918.74
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- A. Remove the PO-status accounting trigger for good
-- ─────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_po_accounting ON purchase_orders;
DROP FUNCTION IF EXISTS purchase_order_accounting_trigger();

-- ─────────────────────────────────────────────────────────────
-- B. Audit table
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gl_fifo_repair_audit (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action        text NOT NULL,   -- delete_purchase_receipt_je | backfill_missing_batch_journal
  je_id         uuid,
  entry_number  text,
  description   text,
  amount        numeric,
  reason        text,
  done_at       timestamptz DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────
-- C. Delete all purchase_receipt journal entries
--    (superseded by the GRN journal family; every deletion reverses
--    accounts.balance exactly as post_journal_entry applied it)
-- ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_je   journal_entries%ROWTYPE;
  v_line journal_lines%ROWTYPE;
  v_deleted integer := 0;
  v_amount  numeric := 0;
BEGIN
  FOR v_je IN
    SELECT * FROM journal_entries
    WHERE reference_type = 'purchase_receipt'
    ORDER BY entry_date, id
  LOOP
    FOR v_line IN SELECT * FROM journal_lines WHERE journal_entry_id = v_je.id LOOP
      UPDATE accounts
      SET balance = CASE
        WHEN account_type IN ('liability', 'equity', 'revenue')
          THEN balance - (v_line.credit - v_line.debit)
        ELSE balance - (v_line.debit - v_line.credit)
      END
      WHERE id = v_line.account_id;
    END LOOP;

    INSERT INTO gl_fifo_repair_audit
      (action, je_id, entry_number, description, amount, reason)
    VALUES
      ('delete_purchase_receipt_je', v_je.id, v_je.entry_number, v_je.description,
       GREATEST(COALESCE(v_je.total_debit, 0), COALESCE(v_je.total_credit, 0)),
       'duplicate of the GRN journal for the same receipt (PO-status trigger)');

    DELETE FROM journal_lines WHERE journal_entry_id = v_je.id;
    DELETE FROM journal_entries WHERE id = v_je.id;

    v_deleted := v_deleted + 1;
    v_amount := v_amount + GREATEST(COALESCE(v_je.total_debit, 0), COALESCE(v_je.total_credit, 0));
  END LOOP;

  RAISE NOTICE 'Deleted % purchase_receipt journal entries worth %', v_deleted, v_amount;
END $$;

-- ─────────────────────────────────────────────────────────────
-- D. Backfill missing pre-journal-era batch journals
-- ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_sa_journaled  numeric;
  v_sa_batches    numeric;
  v_sa_missing    numeric;
  v_pc_journaled  numeric;
  v_pc_batches    numeric;
  v_pc_missing    numeric;
  v_je_id         uuid;
  v_acct_1200     uuid;
  v_acct_5900     uuid;
  v_acct_3900     uuid;
BEGIN
  SELECT id INTO v_acct_1200 FROM accounts WHERE code = '1200' LIMIT 1;
  SELECT id INTO v_acct_5900 FROM accounts WHERE code = '5900' LIMIT 1;
  SELECT id INTO v_acct_3900 FROM accounts WHERE code = '3900' LIMIT 1;
  IF v_acct_1200 IS NULL OR v_acct_5900 IS NULL OR v_acct_3900 IS NULL THEN
    RAISE EXCEPTION 'accounts 1200/5900/3900 not found — aborting backfill';
  END IF;

  -- Stock adjustments: batches created before journal integration
  SELECT COALESCE(SUM(jl.debit), 0) INTO v_sa_journaled
  FROM journal_lines jl
  JOIN journal_entries je ON je.id = jl.journal_entry_id
  JOIN accounts a ON a.id = jl.account_id
  WHERE je.reference_type = 'stock_adjustment' AND a.code = '1200';

  SELECT COALESCE(SUM(quantity_received * unit_cost), 0) INTO v_sa_batches
  FROM inventory_batches
  WHERE batch_type = 'adjustment' AND reference_type = 'stock_adjustment';

  v_sa_missing := ROUND(v_sa_batches - v_sa_journaled, 2);
  RAISE NOTICE 'Stock adjustments: batches %, journaled %, missing %', v_sa_batches, v_sa_journaled, v_sa_missing;

  IF v_sa_missing > 0.01 THEN
    v_je_id := post_journal_entry(
      p_description    := 'Backfill: stock adjustments pre-dating journal integration (batches without GL entries)',
      p_entry_date     := DATE '2026-08-28',
      p_reference_type := 'stock_adjustment',
      p_reference_id   := NULL,
      p_lines          := json_build_array(
        json_build_object('account_id', v_acct_1200, 'debit', v_sa_missing,
                          'description', 'Inventory received (backfill)'),
        json_build_object('account_id', v_acct_5900, 'credit', v_sa_missing,
                          'description', 'Inventory adjustment variance (backfill)')
      )
    );
    INSERT INTO gl_fifo_repair_audit
      (action, je_id, amount, reason)
    VALUES ('backfill_missing_batch_journal', v_je_id, v_sa_missing,
            'adjustment batches ' || v_sa_batches || ' minus journaled ' || v_sa_journaled);
  END IF;

  -- Product-creation opening stock: batches created before journal integration
  SELECT COALESCE(SUM(jl.debit), 0) INTO v_pc_journaled
  FROM journal_lines jl
  JOIN journal_entries je ON je.id = jl.journal_entry_id
  JOIN accounts a ON a.id = jl.account_id
  WHERE je.reference_type = 'product_creation' AND a.code = '1200';

  SELECT COALESCE(SUM(quantity_received * unit_cost), 0) INTO v_pc_batches
  FROM inventory_batches
  WHERE batch_type = 'opening' AND reference_type = 'product_creation';

  v_pc_missing := ROUND(v_pc_batches - v_pc_journaled, 2);
  RAISE NOTICE 'Product creation openings: batches %, journaled %, missing %', v_pc_batches, v_pc_journaled, v_pc_missing;

  IF v_pc_missing > 0.01 THEN
    v_je_id := post_journal_entry(
      p_description    := 'Backfill: product-creation opening stock pre-dating journal integration (batches without GL entries)',
      p_entry_date     := DATE '2026-08-28',
      p_reference_type := 'product_creation',
      p_reference_id   := NULL,
      p_lines          := json_build_array(
        json_build_object('account_id', v_acct_1200, 'debit', v_pc_missing,
                          'description', 'Inventory received (backfill)'),
        json_build_object('account_id', v_acct_3900, 'credit', v_pc_missing,
                          'description', 'Opening balance equity offset (backfill)')
      )
    );
    INSERT INTO gl_fifo_repair_audit
      (action, je_id, amount, reason)
    VALUES ('backfill_missing_batch_journal', v_je_id, v_pc_missing,
            'product_creation batches ' || v_pc_batches || ' minus journaled ' || v_pc_journaled);
  END IF;

  RAISE NOTICE 'GL 1200 backfill complete: adjustments %, product creation %', v_sa_missing, v_pc_missing;
END $$;
