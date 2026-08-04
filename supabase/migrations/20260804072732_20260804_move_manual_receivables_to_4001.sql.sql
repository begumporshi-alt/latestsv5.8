/*
# Move manual receivable credits from 4000 (Sales Revenue) to 4001 (Sales Revenue - no COGS)

## Problem
Manual receivables were being credited to account 4000 (Sales Revenue), inflating it
by ৳805,559 beyond actual invoice sales. These should go to 4001 instead.

## Fix
1. Move all receivable-type journal credit lines from account 4000 to account 4001
2. Adjust account balances: 4000 decreases by 805,559, 4001 increases by 805,559
*/

-- Get the account IDs
DO $$
DECLARE
  v_4000_id uuid;
  v_4001_id uuid;
  v_moved_amount numeric;
BEGIN
  SELECT id INTO v_4000_id FROM accounts WHERE code = '4000';
  SELECT id INTO v_4001_id FROM accounts WHERE code = '4001';

  -- Calculate total to move
  SELECT COALESCE(SUM(jl.credit), 0) INTO v_moved_amount
  FROM journal_lines jl
  JOIN journal_entries je ON jl.journal_entry_id = je.id
  WHERE jl.account_id = v_4000_id
    AND je.reference_type = 'receivable'
    AND jl.credit > 0;

  -- Move the journal lines from 4000 to 4001
  UPDATE journal_lines jl
  SET account_id = v_4001_id
  FROM journal_entries je
  WHERE jl.journal_entry_id = je.id
    AND jl.account_id = v_4000_id
    AND je.reference_type = 'receivable'
    AND jl.credit > 0;

  -- Adjust account balances
  UPDATE accounts SET balance = balance - v_moved_amount WHERE id = v_4000_id;
  UPDATE accounts SET balance = balance + v_moved_amount WHERE id = v_4001_id;

  RAISE NOTICE 'Moved % from account 4000 to 4001', v_moved_amount;
END $$;
