-- Batch 3 of the 2026-09-06 gap audit (P0-3 balance sheet prerequisites).
--
-- Two data repairs + the balance-sheet RPC:
--
-- 1. Account 5900 (Inventory Adjustment, expense) carried a Tk 7,268,841.85
--    net CREDIT — stock that entered via adjustment-up entries and the
--    pre-journal backfill (JE-964714) was credited to the variance account
--    and never offset. Stock originating without a purchase belongs in
--    Opening Balance Equity (3900) — the same place create_opening_batch and
--    the FIFO-cutover baseline post it. One audited reclass JE moves the
--    accumulated net credit out; 5900 keeps its variance history and nets
--    to ~0. Future routine adjustments keep using 5900 by design.
--
-- 2. Account 4001 was typed EQUITY but holds Tk 836,883 of manual-receivable
--    SALES revenue — invisible to the P&L and misplaced on any balance sheet.
--    Retyped to revenue (credit-normal in both types, so no balance math
--    changes) and renamed to say what it actually is.
--
-- 3. get_balance_sheet(p_as_of): set-based balance sheet grouped by account
--    type, with current earnings (no closing entries exist) and an
--    Assets = Liabilities + Equity + Earnings proof.

-- ── 1. Reclass 5900's accumulated net credit to Opening Balance Equity ──
DO $$
DECLARE
  v_5900 uuid;
  v_3900 uuid;
  v_net_credit numeric;
BEGIN
  SELECT id INTO v_5900 FROM accounts WHERE code = '5900' LIMIT 1;
  SELECT id INTO v_3900 FROM accounts WHERE code = '3900' LIMIT 1;
  IF v_5900 IS NULL OR v_3900 IS NULL THEN
    RAISE NOTICE 'reclass skipped: 5900/3900 missing';
    RETURN;
  END IF;

  -- already done? (idempotency marker)
  IF EXISTS (SELECT 1 FROM journal_entries
             WHERE reference_type = 'balance_adjustment'
               AND description LIKE 'Inventory Adjustment reclass to Opening Balance Equity%') THEN
    RAISE NOTICE 'reclass already applied';
    RETURN;
  END IF;

  SELECT COALESCE(SUM(jl.credit - jl.debit), 0) INTO v_net_credit
  FROM journal_lines jl
  JOIN journal_entries je ON je.id = jl.journal_entry_id AND je.is_posted = true
  WHERE jl.account_id = v_5900;

  IF v_net_credit > 0.01 THEN
    PERFORM post_journal_entry(
      'Inventory Adjustment reclass to Opening Balance Equity (2026-09-07)',
      CURRENT_DATE,
      'balance_adjustment',
      NULL,
      json_build_array(
        json_build_object('account_id', v_5900, 'debit', v_net_credit, 'credit', 0,
          'description', 'Reclass accumulated adjustment credits (stock entered without purchase) to equity'),
        json_build_object('account_id', v_3900, 'debit', 0, 'credit', v_net_credit,
          'description', 'Opening Balance Equity: stock entered via adjustments/backfill')
      )::json,
      NULL,
      NULL
    );
    RAISE NOTICE 'reclass posted: %', v_net_credit;
  ELSE
    RAISE NOTICE 'no net credit to reclass (%)', v_net_credit;
  END IF;
END $$;

-- ── 2. Retype + rename 4001 ──
UPDATE accounts
   SET account_type = 'revenue',
       name = 'Sales Revenue — Manual (no COGS)'
 WHERE code = '4001'
   AND account_type = 'equity';

-- ── 3. Balance sheet RPC ──
CREATE OR REPLACE FUNCTION public.get_balance_sheet(p_as_of date DEFAULT CURRENT_DATE)
RETURNS TABLE(section text, code text, name text, balance numeric)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = 'public'
AS $function$
  WITH acct AS (
    SELECT a.id, a.code, a.name, a.account_type, a.is_active,
           CASE WHEN a.account_type IN ('liability', 'equity', 'revenue')
                THEN COALESCE(SUM(jl.credit - jl.debit), 0)
                ELSE COALESCE(SUM(jl.debit - jl.credit), 0)
           END AS balance
      FROM accounts a
      LEFT JOIN journal_lines jl ON jl.account_id = a.id
      LEFT JOIN journal_entries je ON je.id = jl.journal_entry_id
     -- The as-of/posted filter must live in WHERE, not in the LEFT JOIN's ON
     -- clause: putting it in ON keeps the journal LINE (with a NULL entry)
     -- and its amounts still sum, silently ignoring the date.
     WHERE (jl.id IS NULL OR (je.is_posted = true AND je.entry_date <= p_as_of))
       AND (a.is_active = true
            OR EXISTS (SELECT 1 FROM journal_lines jl2 WHERE jl2.account_id = a.id))
     GROUP BY a.id, a.code, a.name, a.account_type, a.is_active
  ),
  totals AS (
    SELECT
      COALESCE(SUM(balance) FILTER (WHERE account_type = 'asset'), 0) AS assets,
      COALESCE(SUM(balance) FILTER (WHERE account_type = 'liability'), 0) AS liabilities,
      COALESCE(SUM(balance) FILTER (WHERE account_type = 'equity'), 0) AS equity,
      COALESCE(SUM(balance) FILTER (WHERE account_type = 'revenue'), 0) AS revenue,
      COALESCE(SUM(balance) FILTER (WHERE account_type = 'expense'), 0) AS expenses
    FROM acct
  )
  SELECT 'asset', code, name, balance FROM acct WHERE account_type = 'asset' AND balance <> 0
  UNION ALL
  SELECT 'liability', code, name, balance FROM acct WHERE account_type = 'liability' AND balance <> 0
  UNION ALL
  SELECT 'equity', code, name, balance FROM acct WHERE account_type = 'equity' AND balance <> 0
  UNION ALL
  SELECT 'equity', '—', 'Current Earnings (Revenue − Expenses, to date)', revenue - expenses FROM totals
  UNION ALL
  SELECT 'summary', 'TOTAL_ASSETS', 'Total Assets', assets FROM totals
  UNION ALL
  SELECT 'summary', 'TOTAL_LIABILITIES', 'Total Liabilities', liabilities FROM totals
  UNION ALL
  SELECT 'summary', 'TOTAL_EQUITY', 'Total Equity (incl. Current Earnings)', equity + revenue - expenses FROM totals
  UNION ALL
  SELECT 'summary', 'TOTAL_LIAB_EQUITY', 'Total Liabilities + Equity', liabilities + equity + revenue - expenses FROM totals
  UNION ALL
  SELECT 'summary', 'DIFFERENCE', 'Assets − (Liabilities + Equity) — must be 0',
         assets - (liabilities + equity + revenue - expenses) FROM totals
  ORDER BY 1, 2;
$function$;

GRANT EXECUTE ON FUNCTION public.get_balance_sheet(date) TO authenticated;
