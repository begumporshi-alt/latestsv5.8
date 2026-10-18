/*
## account_monthly_net RPC (2026-10-18)

Month-by-month net (debit - credit) for one GL account over a range —
same per-month figure the reports page used to get by calling
period_net_debit once per month (12 sequential round trips).
Keeps the ledger as the COGS/profit basis for the Overview trend chart.
SECURITY DEFINER read-only, same pattern as period_net_debit.
*/

CREATE OR REPLACE FUNCTION public.account_monthly_net(
  p_account_id uuid,
  p_start_date date,
  p_end_date date
)
RETURNS TABLE (
  month text,
  net numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    to_char(date_trunc('month', je.entry_date), 'YYYY-MM') AS month,
    SUM(jl.debit - jl.credit) AS net
  FROM journal_lines jl
  JOIN journal_entries je ON jl.journal_entry_id = je.id
  WHERE jl.account_id = p_account_id
    AND je.entry_date >= p_start_date
    AND je.entry_date <= p_end_date
  GROUP BY 1
  ORDER BY 1;
$$;

GRANT EXECUTE ON FUNCTION public.account_monthly_net(uuid, date, date) TO authenticated;
