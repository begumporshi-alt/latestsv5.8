/*
# Create period_account_balance RPC for efficient date-filtered account queries

## Problem
The reports and P&L pages fetch ALL journal lines for an account, then filter by date in JavaScript.
This is unreliable because:
1. Supabase's !inner join can return nested objects as arrays, making entry_date undefined
2. No DB-side date filtering means fetching unnecessary data
3. Client-side filtering silently produces 0 when the join format is unexpected

## Solution
Create a SECURITY DEFINER function that calculates the net debit (or net credit) for a given
account within a date range, using the journal_entries.entry_date for filtering.

## Usage
- `period_net_debit(account_id, start_date, end_date)` returns SUM(debit - credit) for the period
- Used by reports page and P&L page for COGS, sales returns, and operating expenses

## Security
- SECURITY DEFINER so it can bypass RLS for read-only aggregation
- Read-only function, no data modification
*/

CREATE OR REPLACE FUNCTION public.period_net_debit(
  p_account_id uuid,
  p_start_date date,
  p_end_date date DEFAULT NULL
) RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_result numeric;
BEGIN
  SELECT COALESCE(SUM(jl.debit - jl.credit), 0) INTO v_result
  FROM journal_lines jl
  JOIN journal_entries je ON jl.journal_entry_id = je.id
  WHERE jl.account_id = p_account_id
    AND je.entry_date >= p_start_date
    AND (p_end_date IS NULL OR je.entry_date <= p_end_date);

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.period_net_credit(
  p_account_id uuid,
  p_start_date date,
  p_end_date date DEFAULT NULL
) RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_result numeric;
BEGIN
  SELECT COALESCE(SUM(jl.credit - jl.debit), 0) INTO v_result
  FROM journal_lines jl
  JOIN journal_entries je ON jl.journal_entry_id = je.id
  WHERE jl.account_id = p_account_id
    AND je.entry_date >= p_start_date
    AND (p_end_date IS NULL OR je.entry_date <= p_end_date);

  RETURN v_result;
END;
$$;
