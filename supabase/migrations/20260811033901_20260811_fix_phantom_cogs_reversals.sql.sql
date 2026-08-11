-- Fix: Remove phantom COGS reversal entries that have no matching original COGS entry
-- These were created when the backfill migration (20260811_fix_cogs_journal_entries_for_multi_unit)
-- deleted original COGS entries for cancelled/edited invoices but left the reversal entries behind.
-- This caused net COGS (account 5000) to be artificially reduced, showing 0 or negative on the Sales page.

DO $$
DECLARE
  v_deleted_count integer;
BEGIN
  -- Delete journal lines for phantom COGS reversals
  DELETE FROM journal_lines
  WHERE journal_entry_id IN (
    SELECT je.id
    FROM journal_entries je
    WHERE je.description ILIKE '%REVERSAL%COGS%'
      AND NOT EXISTS(
        SELECT 1 FROM journal_entries je2
        WHERE je2.reference_id = je.reference_id
          AND je2.reference_type = 'invoice'
          AND je2.description ILIKE 'COGS%'
      )
  );

  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % journal lines from phantom COGS reversals', v_deleted_count;

  -- Delete the phantom COGS reversal journal entries themselves
  DELETE FROM journal_entries
  WHERE description ILIKE '%REVERSAL%COGS%'
    AND NOT EXISTS(
      SELECT 1 FROM journal_entries je2
      WHERE je2.reference_id = journal_entries.reference_id
        AND je2.reference_type = 'invoice'
        AND je2.description ILIKE 'COGS%'
    );

  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % phantom COGS reversal journal entries', v_deleted_count;
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
