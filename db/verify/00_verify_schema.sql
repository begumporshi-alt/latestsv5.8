-- ============================================================================
-- 00_verify_schema.sql
--
-- Post-build assertions. Every check raises an exception on failure, so
-- apply.sh stops if the database does not look like the reference build.
-- Safe to run more than once.
-- ============================================================================
DO $$
DECLARE
  v_tables int; v_funcs int; v_policies int; v_triggers int;
  v_constraints int; v_rls_missing int;
BEGIN
  SELECT count(*) INTO v_tables     FROM pg_tables WHERE schemaname='public';
  SELECT count(*) INTO v_funcs      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public';
  SELECT count(*) INTO v_policies   FROM pg_policies WHERE schemaname='public';
  SELECT count(*) INTO v_triggers   FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
                                     JOIN pg_namespace n ON n.oid=c.relnamespace
                                     WHERE NOT t.tgisinternal AND n.nspname='public';
  SELECT count(*) INTO v_constraints FROM pg_constraint WHERE connamespace='public'::regnamespace;

  RAISE NOTICE 'tables=% functions=% policies=% triggers=% constraints=%',
    v_tables, v_funcs, v_policies, v_triggers, v_constraints;

  IF v_tables <> 79 THEN
    RAISE EXCEPTION 'expected 79 public tables, found %', v_tables;
  END IF;
  IF v_funcs < 186 THEN
    RAISE EXCEPTION 'expected at least 186 public functions, found %', v_funcs;
  END IF;
  IF v_policies <> 222 THEN
    RAISE EXCEPTION 'expected 222 RLS policies, found %', v_policies;
  END IF;
  IF v_triggers <> 77 THEN
    RAISE EXCEPTION 'expected 77 triggers, found %', v_triggers;
  END IF;
  IF v_constraints <> 242 THEN
    RAISE EXCEPTION 'expected 242 constraints, found %', v_constraints;
  END IF;

  -- Every business table must have RLS enabled. Production intentionally leaves
  -- its internal audit/repair tables unprotected; anything else is a defect.
  SELECT count(*) INTO v_rls_missing
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity
    AND c.relname NOT LIKE '%audit%'
    AND c.relname NOT LIKE '%repair%'
    AND c.relname NOT LIKE '%log%';
  IF v_rls_missing > 0 THEN
    RAISE EXCEPTION '% business table(s) have RLS disabled', v_rls_missing;
  END IF;

  -- the duplicate accounting triggers must not exist: they double-post journals
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN ('invoice_accounting','payment_accounting')
             AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'duplicate accounting triggers present (would double-post journal entries)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='stock_movement_accounting' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'stock_movement_accounting trigger present (double-counts COGS)';
  END IF;

  -- production removed the constrained numeric types; make sure they are relaxed
  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema='public' AND data_type='numeric'
        AND numeric_precision IS NULL) < 140 THEN
    RAISE EXCEPTION 'numeric columns were not relaxed to unconstrained numeric';
  END IF;

  -- Journal numbering must be able to produce a fresh number.
  -- get_next_journal_number() derives MAX(digits) + 1 from every row matching
  -- 'JE-%', then LPADs to 6 characters. LPAD truncates longer input, so a single
  -- row carrying more than 6 digits (e.g. an opening entry numbered
  -- JE-OPENING-YYYYMMDD) collapses the next number onto an existing one and
  -- every journal posting fails with a duplicate key. Assert the seed state is
  -- clean and that the generator actually returns an unused number.
  IF EXISTS (SELECT 1 FROM journal_entries
             WHERE entry_number LIKE 'JE-%'
               AND length(regexp_replace(entry_number,'[^0-9]','','g')) > 6) THEN
    RAISE EXCEPTION 'a JE- row carries more than 6 digits; get_next_journal_number() will truncate and collide';
  END IF;
  IF EXISTS (SELECT 1 FROM journal_entries WHERE entry_number = get_next_journal_number()) THEN
    RAISE EXCEPTION 'get_next_journal_number() returned an entry_number that already exists (%)',
      get_next_journal_number();
  END IF;

  RAISE NOTICE 'schema verification passed';
END $$;
