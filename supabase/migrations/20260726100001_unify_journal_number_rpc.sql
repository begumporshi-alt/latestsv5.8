/*
# Unify Journal Number RPC Names

Two RPC functions existed that both generated journal entry numbers:
- get_next_journal_number() — from 008_accounting_automation and 20260703 migrations
- generate_journal_number() — from 20260710_serial_document_numbers migration

Both called nextval('journal_entry_seq') so they produced the same sequence, but
having two names is a maintenance hazard. The canonical name is get_next_journal_number().

This migration makes generate_journal_number() an alias that delegates to
get_next_journal_number(), so any code (DB triggers, frontend) still referencing
the old name continues to work without generating a duplicate sequence value.
*/

CREATE OR REPLACE FUNCTION generate_journal_number()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN get_next_journal_number();
END;
$$;

GRANT EXECUTE ON FUNCTION generate_journal_number() TO anon, authenticated;
