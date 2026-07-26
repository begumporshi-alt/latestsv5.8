/*
# Fix Account Classifications

## Issues Fixed

### Issue 1 — Account 4100 misclassified as 'revenue'
Account 4100 "Sales Returns & Allowances" is a contra-revenue account that must behave
as debit-normal (like expenses). It was typed as 'revenue', causing debits to decrease
its balance instead of increase it, and causing the P&L on the Accounting page to
add its balance to revenue instead of subtracting it.

Fix: change account_type to 'expense' (consistent with how account 4050 was fixed in
migration 20260702065107). Recalculate balance from posted journal lines.

### Issue 2 — Accounts 5100 and 5200 are dead/conflicting
5100 "Purchase Returns" (expense) and 5200 "Purchase Returns & Allowances" (revenue)
are never used by any trigger or frontend code. They also conflict with journal template
codes used by the UI (templates expect 5100 = Salaries, 5200 = Rent — see frontend fix).

Fix: rename these accounts to match their intended use in journal templates, and correct
their types. The journal template in accounting/journal/page.tsx expects:
  5100 = Salaries & Wages (expense)
  5200 = Rent Expense (expense)
  5300 = Utilities (expense)
  5400 = Marketing & Advertising (expense)
  5500 = Transport & Delivery (expense)
  5600 = Bad Debt Expense (expense)

We upsert all of these so the templates always work regardless of what was seeded before.
*/

-- Step 1: Fix account 4100 — change type to expense (debit-normal) and recalculate balance
UPDATE accounts
SET
  name = 'Sales Returns & Allowances',
  account_type = 'expense',
  balance = COALESCE((
    SELECT SUM(jl.debit - jl.credit)
    FROM journal_lines jl
    JOIN journal_entries je ON jl.journal_entry_id = je.id
    WHERE jl.account_id = accounts.id
      AND je.is_posted = true
  ), 0)
WHERE code = '4100';

-- Step 2: Fix account 5100 — was "Purchase Returns" (expense, unused)
--         Rename to "Salaries & Wages" which is what the journal templates expect
UPDATE accounts
SET
  name = 'Salaries & Wages',
  account_type = 'expense'
WHERE code = '5100';

-- Step 3: Fix account 5200 — was "Purchase Returns & Allowances" (revenue, unused, wrong type)
--         Rename to "Rent Expense" which is what the journal templates expect
UPDATE accounts
SET
  name = 'Rent Expense',
  account_type = 'expense'
WHERE code = '5200';

-- Step 4: Ensure all expense accounts used by journal templates exist
-- (using ON CONFLICT so existing accounts are updated, new ones are created)
INSERT INTO accounts (code, name, account_type, is_cash, is_bank, balance, is_active)
VALUES
  ('5300', 'Utilities',              'expense', false, false, 0, true),
  ('5400', 'Marketing & Advertising','expense', false, false, 0, true),
  ('5500', 'Transport & Delivery',   'expense', false, false, 0, true),
  ('5600', 'Bad Debt Expense',       'expense', false, false, 0, true)
ON CONFLICT (tenant_id, code) DO UPDATE
  SET
    name         = EXCLUDED.name,
    account_type = EXCLUDED.account_type,
    is_active    = true;

-- Step 5: Ensure cash account 1001 exists (journal templates credit this for expenses)
-- Many places reference 1001 "Cash in Hand"; the seed data uses 1000.
-- Insert 1001 if it doesn't already exist — some DB instances may use 1000 only.
INSERT INTO accounts (code, name, account_type, is_cash, is_bank, balance, is_active)
VALUES ('1001', 'Cash in Hand', 'asset', true, false, 0, true)
ON CONFLICT (tenant_id, code) DO NOTHING;

-- Step 6: Ensure 1002 bank account exists (used by bank deposit/withdrawal templates)
INSERT INTO accounts (code, name, account_type, is_cash, is_bank, balance, is_active)
VALUES ('1002', 'Dhaka Bank Current A/C', 'asset', false, true, 0, true)
ON CONFLICT (tenant_id, code) DO NOTHING;
