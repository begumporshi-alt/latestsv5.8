-- Correct the entry_date on the four Phase 3 entries.
--
-- They were posted at 2026-10-31 04:36 Asia/Dhaka, but Postgres current_date
-- resolves in UTC, so record_fund_transfer() and reverse_supplier_payment()
-- stamped them 2026-10-30. Anything posted between 00:00 and 05:59 Dhaka gets
-- the previous day's date.
--
-- This only moves the date. Debit/credit are untouched, so account balances
-- and the trial balance are unaffected (verified before and after).
-- trg_journal_entry_audit logs the change.
--
-- Safe to re-run: the WHERE clause only matches rows still on the old date.

BEGIN;

UPDATE journal_entries
   SET entry_date = DATE '2026-10-31'
 WHERE entry_number IN ('JE-969291', 'JE-969292', 'JE-969293', 'JE-969294')
   AND entry_date = DATE '2026-10-30';

DO $$
DECLARE
  v_fixed int;
  v_diff  numeric;
BEGIN
  SELECT count(*) INTO v_fixed
    FROM journal_entries
   WHERE entry_number IN ('JE-969291', 'JE-969292', 'JE-969293', 'JE-969294')
     AND entry_date = DATE '2026-10-31';

  SELECT round(sum(debit) - sum(credit), 2) INTO v_diff FROM journal_lines;

  RAISE NOTICE 'entry dates corrected: % rows now on 2026-10-31', v_fixed;
  RAISE NOTICE 'trial balance difference: %', v_diff;
  RAISE NOTICE 'balances: cash=%, bank=%',
    (SELECT round(balance, 2) FROM accounts WHERE code = '1001'),
    (SELECT round(balance, 2) FROM accounts WHERE code = '1026');
END $$;

COMMIT;
