-- Round balance_due to 2 decimals so rounding-tolerance payments stop
-- leaving sub-paisa "dues" on fully paid invoices.
--
-- Problem: every payment-application path (pos_due_collection,
-- collect_customer_payment, and the offline sync_apply variants) marks an
-- invoice 'paid' when the remaining balance is <= 0.01, because payments are
-- stored at 2-decimal precision while total_amount keeps full float precision
-- (e.g. total 2080.1308, paid 2080.13). The generated balance_due column kept
-- the raw residue, so 11 fully paid invoices showed balance_due values like
-- 0.0008 / 0.0096.
--
-- Fix: round the generated expression to 2 decimals — the same precision the
-- status tolerance already uses. Verified live: 11 paid invoices with
-- 0 < |balance_due| <= 0.011, and no unpaid-status invoice with due <= 0.011
-- (so no real small dues are masked by this change).
--
-- Fix: the status tolerance treats a remaining balance of <= 0.01 as fully
-- paid, so the generated column must agree: round to 2 decimals AND clamp the
-- tolerance band to zero. Verified live before applying: no unpaid-status
-- invoice had a due <= 0.011, so no real small due is masked by the clamp.
-- (Plain round() was tried first and still left +0.01 display residues on
-- paid invoices, because residues like 0.0096 round up.)

ALTER TABLE public.invoices
  ALTER COLUMN balance_due
  SET EXPRESSION AS (
    CASE
      WHEN abs(total_amount - amount_paid - bad_debt_amount) <= 0.01 THEN 0::numeric
      ELSE round((total_amount - amount_paid - bad_debt_amount)::numeric, 2)
    END
  );

-- Verification after applying:
--   SELECT count(*) FROM invoices WHERE status = 'paid' AND balance_due <> 0;
--   -- expected: only genuine overpayments (negative balance_due)
--   SELECT count(*) FROM invoices
--   WHERE status IN ('sent','partially_paid','unpaid','overdue') AND balance_due <= 0.01 AND balance_due > 0;
--   -- expected: 0
