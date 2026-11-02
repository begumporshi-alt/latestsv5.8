-- Quick Balance Sheet: five named accounts, point-in-time.
--
-- A deliberately narrow view — fixed assets, inventory, receivables, payables
-- and sales revenue. Cash, bank and expense accounts are excluded by design,
-- so the result does NOT balance and must never be presented as a trial
-- balance.
--
-- Balances are computed exactly as get_balance_sheet() computes them, so the
-- two statements agree for the accounts they share. In particular the as-of
-- filter belongs in WHERE, not in the LEFT JOIN's ON clause: putting it in ON
-- keeps the journal line (with a NULL entry) and its amounts still sum.

CREATE OR REPLACE FUNCTION public.get_quick_balance_sheet(p_as_of date DEFAULT CURRENT_DATE)
RETURNS TABLE(line_key text, label text, code text, balance numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $$
  WITH wanted(line_key, label, code, sort_order) AS (
    VALUES
      ('fixed_assets', 'Fixed Assets',        '1004', 1),
      ('inventory',    'Inventory',           '1200', 2),
      ('receivables',  'Accounts Receivable', '1100', 3),
      ('payables',     'Accounts Payable',    '2000', 4),
      ('revenue',      'Sales Revenue',       '4000', 5)
  ),
  acct AS (
    SELECT a.code,
           CASE WHEN a.account_type IN ('liability', 'equity', 'revenue')
                THEN COALESCE(SUM(jl.credit - jl.debit), 0)
                ELSE COALESCE(SUM(jl.debit - jl.credit), 0)
           END AS balance
      FROM accounts a
      LEFT JOIN journal_lines jl ON jl.account_id = a.id
      LEFT JOIN journal_entries je ON je.id = jl.journal_entry_id
     WHERE (jl.id IS NULL OR (je.is_posted = true AND je.entry_date <= p_as_of))
     GROUP BY a.id, a.code, a.account_type
  )
  SELECT w.line_key,
         w.label,
         w.code,
         COALESCE(acct.balance, 0)::numeric AS balance
    FROM wanted w
    LEFT JOIN acct ON acct.code = w.code
   ORDER BY w.sort_order;
$$;

COMMENT ON FUNCTION public.get_quick_balance_sheet(date) IS
  'Five-account point-in-time snapshot (fixed assets, inventory, receivables, payables, sales revenue). Excludes cash, bank and expenses; not a trial balance.';
