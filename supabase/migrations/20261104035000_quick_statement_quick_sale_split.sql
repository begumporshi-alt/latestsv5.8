-- Quick statement, revision 2.
--
-- Two changes requested after the first cut:
--
-- 1. 4001 Sales Revenue — Manual (no COGS) is excluded from the revenue list by
--    product decision. It is a real revenue account and still appears on the
--    full balance sheet; it is simply not wanted here. Consequence, stated in
--    the page footnote: net profit is understated by whatever 4001 carries.
--
-- 2. 4000 Sales Revenue is a mixed pot — counter sales, invoiced sales and the
--    Quick Sell form all credit it. The statement now reports how much of that
--    balance came from Quick Sell, in a `sub_amount` column, so the page can
--    print "Sales Revenue (incl. ৳6,73,181 quick sales)".
--
-- How the split is attributed: invoices.is_quick_sell marks an invoice created
-- by the Quick Sell form (see 20260914100000_quick_sell_non_stock.sql). Every
-- journal line touching 4000 that carries an invoice reference joins back to
-- its invoice, so the quick-sale portion is the sum of those lines where the
-- invoice is flagged. Verified: all 2,681 invoice/invoice_edit/invoice_cancel
-- lines on 4000 join; the only unmatched lines are 3 'receivable' postings
-- (৳1,85,336) which are correctly outside the quick-sale share.
--
-- The return type gains a column, and CREATE OR REPLACE cannot change a
-- function's return type, so this drops and recreates. Nothing else in the
-- schema depends on the function.

DROP FUNCTION IF EXISTS public.get_quick_statement(date);

CREATE FUNCTION public.get_quick_statement(p_as_of date DEFAULT CURRENT_DATE)
RETURNS TABLE(
  section text,
  code text,
  label text,
  balance numeric,
  sort_order int,
  sub_amount numeric
)
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
  ),
  quick_sale AS (
    SELECT COALESCE(SUM(jl.credit - jl.debit), 0) AS amount
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.journal_entry_id
      JOIN accounts a ON a.id = jl.account_id
      JOIN invoices i ON i.id = je.reference_id
     WHERE a.code = '4000'
       AND je.is_posted = true
       AND je.entry_date <= p_as_of
       AND je.reference_type IN ('invoice', 'invoice_edit', 'invoice_cancel')
       AND i.is_quick_sell = true
  )
  SELECT p.section,
         p.code,
         p.label,
         COALESCE(a.balance, 0)::numeric AS balance,
         p.sort_order,
         NULL::numeric AS sub_amount
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
         CASE WHEN a.code ~ '^[0-9]+$' THEN a.code::int ELSE 999999 END,
         CASE WHEN a.code = '4000' THEN (SELECT amount FROM quick_sale) END
    FROM acct a
   WHERE a.account_type IN ('revenue', 'expense')
     AND a.balance <> 0
     AND a.code <> '4001'
   ORDER BY 1, 5, 2;
$$;

COMMENT ON FUNCTION public.get_quick_statement(date) IS
  'Quick statement: fixed assets, inventory, receivables, payables plus every revenue (except 4001) and expense account with a non-zero balance. sub_amount on 4000 reports the Quick Sell share of that balance. Excludes cash and bank; not a trial balance.';

GRANT EXECUTE ON FUNCTION public.get_quick_statement(date) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_quick_statement(date) TO anon;
GRANT EXECUTE ON FUNCTION public.get_quick_statement(date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_quick_statement(date) TO service_role;
