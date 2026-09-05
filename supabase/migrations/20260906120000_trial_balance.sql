-- Trial balance (2026-09-06 journal audit, Phase 3).
--
-- The app had no report proving total debits = total credits — the most
-- basic ledger check. Two RPCs:
--   get_trial_balance(p_from, p_to): per active account — signed opening
--     (debit-credit before p_from), period debit/credit sums, signed closing
--     (up to p_to). NULL dates mean unbounded on that side. The page splits
--     the signed values into classic Debit/Credit columns; ΣDr = ΣCr across
--     closing balances holds exactly when every entry balances.
--   get_unbalanced_journal_entries(): every posted entry whose line sums
--     don't balance or disagree with its header totals — should stay empty;
--     the page banners it with links into the journal.

BEGIN;

-- Return shape changed during development (is_active added): replace cleanly.
DROP FUNCTION IF EXISTS public.get_trial_balance(date, date);

CREATE OR REPLACE FUNCTION public.get_trial_balance(p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS TABLE(
  account_id uuid,
  code text,
  name text,
  account_type text,
  is_active boolean,
  opening numeric,
  period_debit numeric,
  period_credit numeric,
  closing numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $fn$
  SELECT a.id AS account_id,
         a.code, a.name, a.account_type, a.is_active,
         COALESCE(SUM(CASE WHEN p_from IS NULL OR je.entry_date < p_from
                           THEN jl.debit - jl.credit ELSE 0 END), 0) AS opening,
         COALESCE(SUM(CASE WHEN (p_from IS NULL OR je.entry_date >= p_from)
                            AND (p_to IS NULL OR je.entry_date <= p_to)
                           THEN jl.debit ELSE 0 END), 0) AS period_debit,
         COALESCE(SUM(CASE WHEN (p_from IS NULL OR je.entry_date >= p_from)
                            AND (p_to IS NULL OR je.entry_date <= p_to)
                           THEN jl.credit ELSE 0 END), 0) AS period_credit,
         COALESCE(SUM(CASE WHEN p_to IS NULL OR je.entry_date <= p_to
                           THEN jl.debit - jl.credit ELSE 0 END), 0) AS closing
    FROM accounts a
    LEFT JOIN journal_lines jl ON jl.account_id = a.id
    LEFT JOIN journal_entries je ON je.id = jl.journal_entry_id AND je.is_posted = true
   -- Deactivated accounts that still carry journal history stay in — dropping
   -- them (the first draft filtered is_active) hid Tk 40,100 on a closed bank
   -- account and broke the debits = credits proof.
   WHERE a.is_active = true
      OR EXISTS (SELECT 1 FROM journal_lines jl2 WHERE jl2.account_id = a.id)
   GROUP BY a.id, a.code, a.name, a.account_type, a.is_active
   ORDER BY a.code;
$fn$;

CREATE OR REPLACE FUNCTION public.get_unbalanced_journal_entries()
RETURNS TABLE(
  id uuid,
  entry_number text,
  entry_date date,
  reference_type text,
  total_debit numeric,
  total_credit numeric,
  line_debit numeric,
  line_credit numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $fn$
  SELECT je.id, je.entry_number, je.entry_date, je.reference_type,
         je.total_debit, je.total_credit,
         COALESCE(SUM(jl.debit), 0), COALESCE(SUM(jl.credit), 0)
    FROM journal_entries je
    LEFT JOIN journal_lines jl ON jl.journal_entry_id = je.id
   WHERE je.is_posted = true
   GROUP BY je.id, je.entry_number, je.entry_date, je.reference_type, je.total_debit, je.total_credit
  HAVING abs(COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0)) > 0.005
      OR abs(je.total_debit - COALESCE(SUM(jl.debit), 0)) > 0.005
      OR abs(je.total_credit - COALESCE(SUM(jl.credit), 0)) > 0.005
   ORDER BY je.entry_date DESC;
$fn$;

COMMIT;
