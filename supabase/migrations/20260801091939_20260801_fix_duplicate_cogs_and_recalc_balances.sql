/*
# Fix Duplicate COGS Entries and Recalculate Account Balances

## Problem
1. Two COGS triggers were firing on the same invoices:
   - `trg_invoice_items_cogs` (AFTER INSERT on invoice_items) — posts one COGS JE per item
   - `trg_invoice_status_cogs` (AFTER UPDATE OF status on invoices) — posts one COGS JE for all items
   This caused 53 invoices to have duplicate COGS journal entries totaling ~161,877 in excess COGS.

2. Stored account balances drifted from actual journal line totals due to:
   - `post_journal_entry()` updating balances inline
   - `increment_account_balance()` RPC being called separately in some code paths (double-counting)
   - The COGS account (5000) stored balance was 4,207,429.90 but actual journal lines net was 1,714,389.9968
   - Similar discrepancies on accounts 4000, 1200, 4100, 2200, 2000, 2300

## Changes
1. Disable the `trg_invoice_items_cogs` trigger — keep only `trg_invoice_status_cogs` which fires on draft→active status transition.
2. Delete duplicate COGS journal entries (keep the earliest JE per invoice, delete later duplicates).
3. Recalculate ALL account balances from journal lines to fix the stored balance drift.

## Important Notes
- The `invoice_status_cogs_trigger` is the correct trigger because it fires once per invoice (not once per item) and only when the invoice transitions from draft to active status.
- The `invoice_items_cogs_trigger` was redundant because it fired on every item insert, creating per-item JEs that duplicated the status-trigger's batch JE.
- Account balances are recalculated as: for asset/expense accounts = SUM(debit - credit); for liability/equity/revenue = SUM(credit - debit).
*/

-- Step 1: Disable the duplicate COGS trigger on invoice_items
DROP TRIGGER IF EXISTS trg_invoice_items_cogs ON invoice_items;

-- Step 2: Delete duplicate COGS journal entries (keep earliest per invoice, delete later ones)
-- We identify duplicates as journal entries with reference_type='invoice' hitting account 5000
-- where there's more than one such JE per invoice_id. We keep the one with the earliest created_at.
DO $$
DECLARE
  dup_je RECORD;
BEGIN
  FOR dup_je IN
    WITH cogs_jes AS (
      SELECT je.id as je_id, je.reference_id as invoice_id, je.created_at
      FROM journal_entries je
      JOIN journal_lines jl ON jl.journal_entry_id = je.id
      JOIN accounts a ON jl.account_id = a.id
      WHERE a.code = '5000' AND je.reference_type = 'invoice'
      GROUP BY je.id, je.reference_id, je.created_at
    ),
    ranked AS (
      SELECT je_id, invoice_id, created_at,
        ROW_NUMBER() OVER (PARTITION BY invoice_id ORDER BY created_at) as rn,
        COUNT(*) OVER (PARTITION BY invoice_id) as cnt
      FROM cogs_jes
    )
    SELECT je_id FROM ranked WHERE cnt > 1 AND rn > 1
  LOOP
    -- Delete journal lines for this duplicate JE
    DELETE FROM journal_lines WHERE journal_entry_id = dup_je.je_id;
    -- Delete the journal entry itself
    DELETE FROM journal_entries WHERE id = dup_je.je_id;
  END LOOP;
END $$;

-- Step 3: Recalculate ALL account balances from journal lines
-- This fixes the drift caused by double-counting from increment_account_balance RPC
DO $$
DECLARE
  acc RECORD;
  calc_balance numeric;
BEGIN
  FOR acc IN SELECT id, account_type FROM accounts WHERE is_active = true LOOP
    SELECT COALESCE(SUM(debit - credit), 0) INTO calc_balance
    FROM journal_lines WHERE account_id = acc.id;

    -- For liability, equity, revenue accounts: balance = credit - debit (opposite sign)
    IF acc.account_type IN ('liability', 'equity', 'revenue') THEN
      calc_balance := -calc_balance;
    END IF;

    UPDATE accounts SET balance = calc_balance WHERE id = acc.id;
  END LOOP;
END $$;
