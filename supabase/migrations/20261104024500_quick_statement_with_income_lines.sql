-- Quick statement: the four pinned balance-sheet accounts plus every revenue
-- and expense account that carries a balance.
--
-- Why a new function rather than extending get_quick_balance_sheet():
-- that one returns a fixed five-row shape (line_key/label/code/balance) which
-- the merged frontend and any other caller already depend on. Adding a section
-- column changes the contract, so it gets its own name and the old function is
-- left untouched.
--
-- Why EVERY revenue account and not just 4000:
-- a net profit line is only meaningful when the income side is complete.
-- Today 4001 Sales Revenue — Manual (no COGS) holds ৳836,883 and 4020 Shipping
-- Income ৳12,845; reporting revenue as 4000 alone would understate profit by
-- ৳849,728 against the full expense total. The page labels the section
-- "selected accounts" so the scope stays visible.
--
-- Balances use the same CTE as get_balance_sheet(), including the rule that the
-- as-of filter belongs in WHERE and not in the LEFT JOIN's ON clause — putting
-- it in ON keeps the journal line (with a NULL entry) and its amounts still sum.
--
-- Accounts with a zero balance are dropped from the revenue/expense lists: they
-- add rows without adding information. A zero balance means a zero change, so
-- nothing is lost from the range view either.

CREATE OR REPLACE FUNCTION public.get_quick_statement(p_as_of date DEFAULT CURRENT_DATE)
RETURNS TABLE(section text, code text, label text, balance numeric, sort_order int)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $$
  WITH acct AS (
    SELECT a.id,
           a.code,
           a.name,
           a.account_type,
           CASE WHEN a.account_type IN ('liability', 'equity', 'revenue')
                THEN COALESCE(SUM(jl.credit - jl.debit), 0)
                ELSE COALESCE(SUM(jl.debit - jl.credit), 0)
           END AS balance
      FROM accounts a
      LEFT JOIN journal_lines jl ON jl.account_id = a.id
      LEFT JOIN journal_entries je ON je.id = jl.journal_entry_id
     WHERE (jl.id IS NULL OR (je.is_posted = true AND je.entry_date <= p_as_of))
     GROUP BY a.id, a.code, a.name, a.account_type
  ),
  pinned(section, code, label, sort_order) AS (
    VALUES
      ('asset',     '1004', 'Fixed Assets',        10),
      ('asset',     '1200', 'Inventory',           20),
      ('asset',     '1100', 'Accounts Receivable', 30),
      ('liability', '2000', 'Accounts Payable',    10)
  )
  SELECT p.section,
         p.code,
         p.label,
         COALESCE(a.balance, 0)::numeric AS balance,
         p.sort_order
    FROM pinned p
    LEFT JOIN acct a ON a.code = p.code
  UNION ALL
  SELECT a.account_type,
         a.code,
         a.name,
         a.balance,
         -- Codes are 4-digit numeric today (44/44 checked); the regex keeps a
         -- future non-numeric code sorting last instead of raising 22P02 and
         -- taking the whole statement down.
         CASE WHEN a.code ~ '^[0-9]+$' THEN a.code::int ELSE 999999 END
    FROM acct a
   WHERE a.account_type IN ('revenue', 'expense')
     AND a.balance <> 0
   ORDER BY 1, 5, 2;
$$;

COMMENT ON FUNCTION public.get_quick_statement(date) IS
  'Quick statement: fixed assets, inventory, receivables, payables plus every revenue and expense account with a non-zero balance. Excludes cash and bank; not a trial balance.';

GRANT EXECUTE ON FUNCTION public.get_quick_statement(date) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_quick_statement(date) TO anon;
GRANT EXECUTE ON FUNCTION public.get_quick_statement(date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_quick_statement(date) TO service_role;
