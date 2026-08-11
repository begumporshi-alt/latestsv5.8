-- Fix: Remove phantom "CORRECTION - Excess COGS" entries
-- These were created by a cleanup migration that double-counted COGS reversals.
-- For edited invoices, the edit_invoice function already reverses old COGS and posts new ones.
-- The cleanup migration added another credit on top, making net COGS too low.

DO $$
DECLARE
  v_deleted_count integer;
BEGIN
  -- Delete journal lines for phantom CORRECTION entries
  DELETE FROM journal_lines
  WHERE journal_entry_id IN (
    SELECT id FROM journal_entries WHERE description ILIKE '%CORRECTION%Excess%COGS%'
  );

  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % journal lines from CORRECTION entries', v_deleted_count;

  -- Delete the phantom CORRECTION journal entries
  DELETE FROM journal_entries
  WHERE description ILIKE '%CORRECTION%Excess%COGS%';

  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % CORRECTION journal entries', v_deleted_count;
END $$;

-- Recalculate all account balances from journal lines
DO $$
DECLARE
  acc RECORD;
  v_total_debit numeric;
  v_total_credit numeric;
  v_balance numeric;
BEGIN
  FOR acc IN SELECT id, account_type FROM accounts LOOP
    SELECT COALESCE(SUM(debit), 0) INTO v_total_debit
    FROM journal_lines jl JOIN journal_entries je ON jl.journal_entry_id = je.id
    WHERE jl.account_id = acc.id AND je.is_posted = true;

    SELECT COALESCE(SUM(credit), 0) INTO v_total_credit
    FROM journal_lines jl JOIN journal_entries je ON jl.journal_entry_id = je.id
    WHERE jl.account_id = acc.id AND je.is_posted = true;

    IF acc.account_type IN ('asset', 'expense') THEN
      v_balance := v_total_debit - v_total_credit;
    ELSE
      v_balance := v_total_credit - v_total_debit;
    END IF;

    UPDATE accounts SET balance = v_balance WHERE id = acc.id;
  END LOOP;
END $$;
