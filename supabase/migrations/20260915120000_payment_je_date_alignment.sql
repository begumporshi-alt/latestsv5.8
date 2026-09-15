-- Align payment journal entry dates with their payment rows.
--
-- A payment's edit path can change payment_date without re-dating the JE
-- that payment_accounting_trigger posted (it dates from NEW.payment_date at
-- INSERT time, so later payment edits leave the JE behind). Surfaced by the
-- period statement: PAY-997227 and PAY-997229 were inserted dated 2026-08-30,
-- their payment_date corrected to 2026-09-01 on 2026-09-03 — the JEs kept
-- 2026-08-30 and fell out of the customers' September statements. The
-- payment row is the authoritative business date.
--
-- The UPDATE fires trg_journal_entry_audit (entry_date is in its column
-- list), so activity_logs records each re-dated entry.

UPDATE journal_entries je
   SET entry_date = p.payment_date
  FROM payments p
 WHERE je.reference_type = 'payment'
   AND je.reference_id = p.id
   AND p.payment_date IS NOT NULL
   AND je.entry_date <> p.payment_date;
