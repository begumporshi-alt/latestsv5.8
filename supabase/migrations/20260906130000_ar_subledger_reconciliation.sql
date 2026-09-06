-- Journal audit follow-up (2026-09-06): GL-vs-subledger AR reconciliations.
--
-- The 2026-09-06 audit left 7 active invoices where GL AR != invoices.balance_due.
-- Forensics showed GL and the live payment rows AGREE with each other on every
-- case; the subledger (invoices.amount_paid / balance_due) is what drifted —
-- each invoice's amount_paid missed one or more payments that DID post to the
-- GL (an edit-era bug: payments applied around an invoice edit bumped the GL
-- but not amount_paid). Repairs anchor on the GL + live payment rows:
--
--   INV-940607    paid in full 74,000.02 (PAY-996935) but amount_paid said
--                 66,773.62 → 7,226.40 fictitious "due"
--   INV-940566    paid in full 148,766.47 (EDIT-INV-940566) but amount_paid
--                 said 148,076.47; its bad_debt 16.67 belongs to a REVERSED
--                 payment (PAY-996829, no JE ever posted) → stale
--   INV-940605    PAY-996959 (750) applied to the GL but not amount_paid →
--                 750 fictitious "due" (true due 16,489.33)
--   POS-00589750  PAY-997057 (19,100) posted to the GL but never reached
--                 amount_paid (19,100 fictitious "due"); additionally the same
--                 bad debt 792.35 was written off TWICE on 2026-08-30:
--                 PAY-997228 (1,000 + 792.35, JE-964723) and a duplicate
--                 PAY-997235 (0 + 792.35, JE-964730) → delete the duplicate
--                 JE (balance rollback) + its phantom payment row
--   POS-00589983  fully settled (6,650 + bad_debt 7.6) but the bad-debt JE was
--                 dropped when the edit flow reversed PAY-997045 and reposted
--                 only the 6,650 payment → backfill Dr 5600 / Cr 1100 7.60
--   INV-940623    AR JE posted 7,118.60256 while the invoice total is
--                 7,120.0512 (edit-era pre-final-total posting) → top-up
--   POS-00589653  test1-customer invoice (৳4) — left as test residue (immaterial)
--
-- Section 7: the 43 legacy July payment rows on cancelled invoices (৳285,587,
-- paid and cancelled the SAME DAY, 2026-07-13..17 — early cancel-flow era).
-- They never posted JEs (net-zero in the GL) and were never marked reversed,
-- so collection statistics have been counting them as live receipts. Every
-- other payment on a cancelled invoice is is_reversed=true; mark these the
-- same way (kept for audit trail; no GL impact — no JE existed). Whether the
-- cash was physically refunded is a bank question, not a ledger one.

BEGIN;

-- ── S1–S4: subledger sync to GL truth (explicit, guarded per invoice) ──
DO $sync$
DECLARE
  r RECORD;
BEGIN
  FOR r IN VALUES
    ('INV-940607', 74000.02, 0, 'paid'),
    ('INV-940566', 148766.47, 0, 'paid'),
    ('INV-940605', 20750.00, 0, 'partially_paid'),
    ('POS-00589750', 181519.41, 792.35, 'paid')
  LOOP
    UPDATE invoices
       SET amount_paid = r.column2,
           bad_debt_amount = r.column3,
           status = r.column4,
           updated_at = now()
     WHERE invoice_number = r.column1
       AND status <> 'cancelled';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invoice % not found or cancelled — aborting sync', r.column1;
    END IF;
    RAISE NOTICE 'Synced % → amount_paid %, bad_debt %, status %', r.column1, r.column2, r.column3, r.column4;
  END LOOP;
END
$sync$;

-- ── S4b: delete the duplicate bad-debt JE and its phantom payment ──
DO $dupe$
DECLARE
  v_je_id uuid;
  v_line RECORD;
BEGIN
  SELECT id INTO v_je_id FROM journal_entries
   WHERE entry_number = 'JE-964730' AND reference_type = 'payment'
     AND description LIKE '%PAY-997235%' AND total_credit = 792.35;
  IF v_je_id IS NULL THEN
    RAISE NOTICE 'JE-964730 not found (already cleaned)';
    RETURN;
  END IF;

  -- Roll back each line's accounts.balance effect, then delete lines + entry.
  FOR v_line IN SELECT * FROM journal_lines WHERE journal_entry_id = v_je_id LOOP
    UPDATE accounts a
       SET balance = CASE
             WHEN a.account_type IN ('liability','equity','revenue')
               THEN a.balance - v_line.credit + v_line.debit
             ELSE a.balance - v_line.debit + v_line.credit
           END
     WHERE a.id = v_line.account_id;
  END LOOP;
  DELETE FROM journal_lines WHERE journal_entry_id = v_je_id;
  DELETE FROM journal_entries WHERE id = v_je_id;

  DELETE FROM payments WHERE payment_number = 'PAY-997235' AND amount = 0 AND bad_debt_amount = 792.35;
  RAISE NOTICE 'Deleted duplicate bad-debt JE-964730 + phantom PAY-997235';
END
$dupe$;

-- ── S5: backfill POS-00589983's dropped bad-debt JE ──
DO $bd$
DECLARE
  v_inv_id uuid;
  v_bd_account uuid;
  v_mr_account uuid;
  v_amount numeric := 7.60;
BEGIN
  SELECT id, total_amount, bad_debt_amount INTO v_inv_id FROM invoices
   WHERE invoice_number = 'POS-00589983';
  SELECT id INTO v_bd_account FROM accounts WHERE code = '5600' LIMIT 1;
  SELECT id INTO v_mr_account FROM accounts WHERE code = '1100' LIMIT 1;

  IF v_bd_account IS NULL OR v_mr_account IS NULL THEN
    RAISE NOTICE 'Accounts 5600/1100 missing — skipping';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM journal_entries je
                  JOIN journal_lines jl ON jl.journal_entry_id = je.id
                 WHERE je.reference_type = 'invoice' AND je.reference_id = v_inv_id
                   AND jl.account_id = v_bd_account) THEN
    PERFORM post_journal_entry(
      'Bad Debt Write-off - POS-00589983 (backfill: edit reversal dropped the write-off leg)',
      CURRENT_DATE,
      'invoice',
      v_inv_id,
      json_build_array(
        json_build_object('account_id', v_bd_account, 'debit', v_amount, 'credit', 0,
          'description', 'Bad debt write-off for POS-00589983'),
        json_build_object('account_id', v_mr_account, 'debit', 0, 'credit', v_amount,
          'description', 'AR cleared (bad debt) for POS-00589983')
      )::json
    );
    RAISE NOTICE 'Posted bad-debt backfill for POS-00589983 (%)', v_amount;
  ELSE
    RAISE NOTICE 'POS-00589983 bad-debt JE already exists';
  END IF;
END
$bd$;

-- ── S6: INV-940623 AR top-up to the invoice's true total ──
DO $topup$
DECLARE
  v_inv_id uuid;
  v_total numeric;
  v_net numeric;
  v_diff numeric;
  v_ar_account uuid;
  v_rev_account uuid;
BEGIN
  SELECT id, total_amount INTO v_inv_id, v_total FROM invoices WHERE invoice_number = 'INV-940623';

  SELECT COALESCE(SUM(jl.debit - jl.credit), 0) INTO v_net
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN accounts a ON a.id = jl.account_id
   WHERE a.code = '1100'
     AND (je.reference_id = v_inv_id
          OR EXISTS (SELECT 1 FROM payments p WHERE p.id = je.reference_id AND p.reference_id = v_inv_id));

  v_diff := v_total - v_net;
  IF abs(v_diff) < 0.005 THEN
    RAISE NOTICE 'INV-940623 already reconciled (net % = total %)', v_net, v_total;
    RETURN;
  END IF;
  IF v_diff < 0 THEN
    RAISE EXCEPTION 'INV-940623 GL net (%) exceeds invoice total (%) — manual review needed', v_net, v_total;
  END IF;

  SELECT id INTO v_ar_account FROM accounts WHERE code = '1100' LIMIT 1;
  SELECT id INTO v_rev_account FROM accounts WHERE code = '4000' LIMIT 1;
  PERFORM post_journal_entry(
    'AR top-up - INV-940623 (backfill: original JE posted before the final edited total)',
    (SELECT invoice_date FROM invoices WHERE id = v_inv_id),
    'invoice',
    v_inv_id,
    json_build_array(
      json_build_object('account_id', v_ar_account, 'debit', v_diff, 'credit', 0,
        'description', 'AR top-up for INV-940623'),
      json_build_object('account_id', v_rev_account, 'debit', 0, 'credit', v_diff,
        'description', 'Revenue top-up for INV-940623')
    )::json
  );
  RAISE NOTICE 'INV-940623 topped up by %', v_diff;
END
$topup$;

-- ── S7: void the 43 legacy payment rows on cancelled invoices ──
UPDATE payments p
   SET is_reversed = true,
       notes = COALESCE(p.notes || '; ', '') || 'Voided with invoice cancellation (legacy 2026-07; no JE was posted — kept for audit trail)',
       updated_at = now()
  FROM invoices i
 WHERE i.id = p.reference_id
   AND p.payment_type = 'received' AND p.reference_type = 'invoice'
   AND p.is_reversed = false AND i.status = 'cancelled'
   AND NOT EXISTS (SELECT 1 FROM journal_entries je
                    WHERE je.reference_type = 'payment' AND je.reference_id = p.id);

-- ── Verify: recompute balances so any missed rollback surfaces ──
DO $verify$
DECLARE
  v_result jsonb;
BEGIN
  v_result := recompute_account_balances('journal-audit-ar-recon-2026-09-06');
  RAISE NOTICE 'Recompute: %', v_result::text;
END
$verify$;

COMMIT;
