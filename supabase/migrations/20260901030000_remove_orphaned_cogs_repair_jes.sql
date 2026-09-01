-- Remove the 26 orphaned `cogs_repair` journal entries.
--
-- Background: migration 20260827000100 (2026-08-26) repaired COGS
-- over/under-statements by posting correction JEs (reference_type
-- 'cogs_repair', description 'COGS repair for <invoice>: restate ...')
-- against the ORIGINAL bad JEs, which were left in place.
--
-- Since then the bad JEs have been removed — the 2026-08-31 duplicate
-- cleanup deleted most of them, and the 20260901020000 mismatch repair
-- deleted + reposted the rest (INV-940540/629/634, POS-00590024, ...).
-- Every affected invoice now carries correct COGS from its own
-- ^COGS JEs (get_cogs_audit(): 580/580 CONSISTENT), so all 26 correction
-- JEs are double-applied orphans:
--   * the credit-side ones (e.g. INV-940540 -2,007,845.87,
--     INV-940634 -898,864.56, INV-940629 -403,481.37) suppress COGS
--     that no longer exists
--   * the debit-side ones (e.g. POS-00590024 +5,407.38) add on top of
--     already-correct postings
-- Net effect on GL 5000: -3,463,284.88 — enough to swing total COGS
-- to a net credit (-1.16M) on the reports page.
--
-- Deletion goes through delete_duplicate_cogs_je (the descriptions match
-- ^COGS) so every removal is captured in cogs_deletion_audit.

DO $$
DECLARE
  v_je  RECORD;
  v_res jsonb;
  v_n   integer := 0;
BEGIN
  FOR v_je IN
    SELECT je.id, je.entry_number
    FROM journal_entries je
    WHERE je.reference_type = 'cogs_repair'
    ORDER BY je.entry_number
  LOOP
    v_res := delete_duplicate_cogs_je(
      v_je.id,
      'Remove orphaned cogs_repair correction: the bad COGS JE it corrected has been deleted and replaced by a correct posting (2026-08-31 cleanup + 20260901020000 repair), making this correction a double-application',
      'cogs-repair-orphan-cleanup'
    );
    IF NOT (v_res->>'success')::boolean THEN
      RAISE EXCEPTION 'Failed to delete % (%): %', v_je.entry_number, v_je.id, v_res->>'error';
    END IF;
    RAISE NOTICE 'Deleted %', v_je.entry_number;
    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE 'Deleted % orphaned cogs_repair JEs', v_n;
END $$;
