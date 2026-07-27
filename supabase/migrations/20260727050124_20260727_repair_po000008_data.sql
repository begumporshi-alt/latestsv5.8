-- ============================================================
-- Repair PO-000008 data corruption
-- ============================================================

-- 1. Fix account balances:
--    Inventory is overstated by 2 (double-counted receipt + gross instead of net)
--    AP is understated by 1 (double-counted receipt at gross + gross return instead of net)
UPDATE accounts SET balance = balance - 2 WHERE code = '1200'; -- Inventory: remove +2 overstatement
UPDATE accounts SET balance = balance + 1 WHERE code = '2000'; -- AP: add back 1 tk

-- 2. Fix PO-000008 amount_paid (payment of 1 tk was made but never recorded on the PO)
UPDATE purchase_orders SET amount_paid = 1 WHERE po_number = 'PO-000008';

-- 3. Link the return to its journal entry
UPDATE purchase_returns SET journal_entry_id = (
  SELECT id FROM journal_entries WHERE reference_type = 'purchase_return' AND reference_id = (
    SELECT id FROM purchase_returns WHERE return_number = 'PRET-083903'
  )
) WHERE return_number = 'PRET-083903';

-- 4. Fix supplier outstanding balance (should be 0 — fully paid, fully returned)
UPDATE suppliers SET outstanding_balance = 0 WHERE name = 'testsup';
