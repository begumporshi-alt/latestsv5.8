-- Journal system audit (2026-09-06), Phase-0 data repairs.
--
-- Verification findings this migration repairs:
--   1. PAY-997247 (2026-09-02, ৳67,984 receivable collection against manual
--      receivable JE-960296) recorded a payments row but never posted its
--      journal entry → 1300 Manual Receivable overstated, bank understated.
--   2. The same customer's ৳32,016 invoice payment (POS-00590142) was
--      recorded twice: correctly as PAY-997249 (reference_type 'invoice',
--      JE-964861 posted) and as PAY-997248 (reference_type 'receivable'
--      whose reference_id matches no row in any table). The phantom row
--      reduces no subledger and has no JE, but pollutes per-customer
--      collection totals by ৳32,016.
--   3. Six orphaned JEs from deleted 2026-08-30 TEST invoices/payments
--      (TEST-POS-*, EDIT-TEST-*, EDIT-FINAL-TEST, EDIT-TEST-FIX-001) still
--      carry GL effects: 3 AR JEs (Dr 1100/Cr 4000, ৳40) and 3 payment JEs
--      (Dr 1001/Cr 1100, ৳390).
--   4. All 16 sales_return JEs have reference_id NULL — they predate the
--      20260901160000 atomic RPC (which does set it); backfill from
--      sales_returns.journal_entry_id so they group and link like every
--      other document type.
--   5. Seven entries share entry_number JE-000001 (2026-07-11 era) —
--      blocks the unique index planned for entry_number.
--   6. The 14 historical receivable-collection JEs ("Payment received for
--      JE-xxxxxx") have reference_id NULL, so payment→JE linkage and orphan
--      checks cannot see them.
--
-- Reported, deliberately NOT repaired (owner decisions):
--   • 7 active invoices where GL AR ≠ balance_due (−৳29,439 total, edit-era
--     artifacts: POS-00589750 −20,793; INV-940607 −7,226; INV-940605 −750;
--     INV-940566 −673; POS-00589983 +7.60; POS-00589653 −2; INV-940623 −1.45)
--   • 43 non-reversed July payments (৳285K) on cancelled invoices whose
--     payments never hit the GL (net zero in GL, but real-cash question)
--   • JE-964089 'test_batch' (৳1,500): its inventory batch row was deleted,
--     but the 2026-09-01 cutover baseline already absorbed the difference
--     (GL 1200 ≈ batch ledger within ৳3.12) — deleting it now would CREATE
--     a ৳1,500 wedge.

BEGIN;

-- ── Section 1: backfill the missing collection JE for PAY-997247 ──
DO $section1$
DECLARE
  v_payment RECORD;
  v_cash_account uuid;
  v_mr_account uuid;
  v_je_id uuid;
BEGIN
  SELECT * INTO v_payment FROM payments WHERE payment_number = 'PAY-997247';
  SELECT id INTO v_mr_account FROM accounts WHERE code = '1300' LIMIT 1;

  IF v_payment.id IS NOT NULL AND v_mr_account IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM journal_entries je
     WHERE je.reference_type = 'payment' AND je.reference_id = v_payment.id
  ) THEN
    SELECT pm.account_id INTO v_cash_account
      FROM payment_methods pm
     WHERE pm.code = v_payment.payment_method AND pm.is_active = true
     LIMIT 1;
    IF v_cash_account IS NULL THEN
      SELECT id INTO v_cash_account FROM accounts WHERE code = '1001' LIMIT 1;
    END IF;

    v_je_id := post_journal_entry(
      'Payment received for JE-960296 (backfill: collection JE was never posted)',
      v_payment.payment_date,
      'payment',
      v_payment.id,
      json_build_array(
        json_build_object('account_id', v_cash_account, 'debit', v_payment.amount, 'credit', 0,
          'description', 'Bank transfer received for manual receivable JE-960296'),
        json_build_object('account_id', v_mr_account, 'debit', 0, 'credit', v_payment.amount,
          'description', 'Manual receivable collected (PAY-997247)')
      )::json,
      v_payment.customer_id
    );
    RAISE NOTICE 'Section 1: posted collection JE % for PAY-997247 (%)', v_je_id, v_payment.amount;
  ELSE
    RAISE NOTICE 'Section 1: skipped (payment missing, 1300 missing, or JE already exists)';
  END IF;
END
$section1$;

-- ── Section 2: delete the phantom duplicate payment row PAY-997248 ──
-- Guards: exact row shape, dangling reference (not a journal_entries row),
-- and no JE references it. The real payment is PAY-997249.
DELETE FROM payments p
 WHERE p.payment_number = 'PAY-997248'
   AND p.payment_type = 'received'
   AND p.reference_type = 'receivable'
   AND p.amount = 32016
   AND p.payment_date = '2026-09-02'
   AND p.reference_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM journal_entries x WHERE x.id = p.reference_id)
   AND NOT EXISTS (SELECT 1 FROM journal_entries je WHERE je.reference_type = 'payment' AND je.reference_id = p.id);

-- ── Section 3: delete the 6 orphaned TEST JEs with balance rollback ──
DO $section3$
DECLARE
  v_je RECORD;
  v_count integer := 0;
BEGIN
  FOR v_je IN
    SELECT je.id, je.entry_number
      FROM journal_entries je
     WHERE je.entry_number IN ('JE-964214','JE-964227','JE-964228','JE-964247','JE-964273','JE-964283')
       AND (je.reference_type IN ('invoice','invoice_edit','invoice_cancel')
              AND NOT EXISTS (SELECT 1 FROM invoices t WHERE t.id = je.reference_id)
            OR je.reference_type = 'payment'
              AND NOT EXISTS (SELECT 1 FROM payments t WHERE t.id = je.reference_id))
  LOOP
    -- Reverse each line's effect on accounts.balance (mirror of post_journal_entry).
    UPDATE accounts a
       SET balance = CASE
             WHEN a.account_type IN ('liability','equity','revenue')
               THEN a.balance - l.credit + l.debit
             ELSE a.balance - l.debit + l.credit
           END
      FROM journal_lines l
     WHERE l.journal_entry_id = v_je.id
       AND a.id = l.account_id;

    DELETE FROM journal_lines WHERE journal_entry_id = v_je.id;
    DELETE FROM journal_entries WHERE id = v_je.id;
    v_count := v_count + 1;
    RAISE NOTICE 'Section 3: deleted orphaned % (%)', v_je.entry_number, v_je.id;
  END LOOP;
  RAISE NOTICE 'Section 3: deleted % orphaned TEST JEs', v_count;
END
$section3$;

-- ── Section 4: backfill sales_return JE reference_ids ──
UPDATE journal_entries je
   SET reference_id = sr.id
  FROM sales_returns sr
 WHERE sr.journal_entry_id = je.id
   AND je.reference_type = 'sales_return'
   AND je.reference_id IS NULL;

-- ── Section 5: de-duplicate entry_number JE-000001 ──
-- Keep the earliest entry on JE-000001, renumber the rest above the
-- current MAX (JE-nnnnnn format — anything else breaks
-- get_next_journal_number's digit-stripping MAX()).
DO $section5$
DECLARE
  r RECORD;
  v_next integer;
  v_count integer := 0;
BEGIN
  SELECT COALESCE(MAX(CAST(NULLIF(regexp_replace(entry_number, '[^0-9]', '', 'g'), '') AS integer)), 0)
    INTO v_next
    FROM journal_entries WHERE entry_number LIKE 'JE-%';

  FOR r IN
    SELECT id
      FROM journal_entries
     WHERE entry_number = 'JE-000001'
       AND id <> (SELECT id FROM journal_entries WHERE entry_number = 'JE-000001'
                   ORDER BY created_at, id LIMIT 1)
     ORDER BY created_at, id
  LOOP
    v_next := v_next + 1;
    UPDATE journal_entries SET entry_number = 'JE-' || LPAD(v_next::text, 6, '0') WHERE id = r.id;
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'Section 5: renumbered % duplicate JE-000001 entries', v_count;
END
$section5$;

-- ── Section 6: link the historical receivable-collection JEs to their
-- payment rows (match on the receivable JE named in the description plus
-- the amount / bad-debt leg) ──
UPDATE journal_entries je
   SET reference_id = p.id
  FROM payments p
  JOIN journal_entries rje ON rje.id = p.reference_id
 WHERE je.reference_type = 'payment'
   AND je.reference_id IS NULL
   AND p.reference_type = 'receivable'
   AND ( (je.description = 'Payment received for ' || rje.entry_number
          AND je.total_debit = p.amount)
      OR (je.description = 'Bad debt write-off for ' || rje.entry_number
          AND je.total_debit = p.bad_debt_amount) );

-- ── Final: recompute the balance cache from lines and verify the rollback
-- in Section 3 was exact (any drift it reports beyond the expected accounts
-- would surface here) ──
DO $verify$
DECLARE
  v_result jsonb;
BEGIN
  v_result := recompute_account_balances('journal-audit-2026-09-06');
  RAISE NOTICE 'Recompute: %', v_result::text;
END
$verify$;

COMMIT;
