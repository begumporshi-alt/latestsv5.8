-- Fix COGS journal entries for multi-unit products
-- Step 1: Delete duplicate COGS entries (keep only the latest one per invoice)
-- Step 2: Update remaining COGS entry to correct amount
-- Step 3: Recalculate affected account balances

DO $$
DECLARE
  v_inv RECORD;
  v_je_id uuid;
  v_correct_cogs decimal(15,2);
  v_cogs_account_id uuid;
  v_inventory_account_id uuid;
BEGIN
  -- Get COGS (5000) and Inventory (1200) account IDs
  SELECT id INTO v_cogs_account_id FROM accounts WHERE code = '5000' LIMIT 1;
  SELECT id INTO v_inventory_account_id FROM accounts WHERE code = '1200' LIMIT 1;

  -- Loop over invoices that have COGS entries
  FOR v_inv IN
    SELECT DISTINCT inv.id, inv.invoice_number
    FROM invoices inv
    JOIN journal_entries je ON je.reference_id = inv.id AND je.reference_type = 'invoice' AND je.description LIKE 'COGS%'
    ORDER BY inv.invoice_number
  LOOP
    -- Calculate correct COGS from invoice_items
    SELECT COALESCE(SUM(ii.quantity * ii.cost_price), 0) INTO v_correct_cogs
    FROM invoice_items ii
    WHERE ii.invoice_id = v_inv.id AND ii.cost_price > 0;

    -- Keep only the latest COGS entry, delete the rest
    SELECT id INTO v_je_id
    FROM journal_entries
    WHERE reference_type = 'invoice' AND reference_id = v_inv.id AND description LIKE 'COGS%'
    ORDER BY created_at DESC
    LIMIT 1;

    -- Delete journal lines and entries for all OTHER COGS entries
    DELETE FROM journal_lines WHERE journal_entry_id IN (
      SELECT id FROM journal_entries
      WHERE reference_type = 'invoice' AND reference_id = v_inv.id
        AND description LIKE 'COGS%' AND id != v_je_id
    );
    DELETE FROM journal_entries
    WHERE reference_type = 'invoice' AND reference_id = v_inv.id
      AND description LIKE 'COGS%' AND id != v_je_id;

    -- Update the remaining COGS entry's lines to correct amounts
    IF v_correct_cogs > 0 THEN
      UPDATE journal_lines SET debit = v_correct_cogs
      WHERE journal_entry_id = v_je_id AND account_id = v_cogs_account_id;
      UPDATE journal_lines SET credit = v_correct_cogs
      WHERE journal_entry_id = v_je_id AND account_id = v_inventory_account_id;
      UPDATE journal_entries SET total_debit = v_correct_cogs, total_credit = v_correct_cogs
      WHERE id = v_je_id;
    ELSE
      -- No cost - delete the COGS entry entirely
      DELETE FROM journal_lines WHERE journal_entry_id = v_je_id;
      DELETE FROM journal_entries WHERE id = v_je_id;
    END IF;
  END LOOP;
END $$;

-- Recalculate all account balances from journal lines
DO $$
DECLARE
  acc RECORD;
  v_total_debit decimal(15,2);
  v_total_credit decimal(15,2);
  v_balance decimal(15,2);
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