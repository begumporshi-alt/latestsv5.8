-- ============================================================================
-- 02_stock_adjustment.sql
--
-- Verifies the reason-driven stock-adjustment build (migration
-- 20261105160000): the RPC's shape, its reason routing, and the sync_apply
-- branch that reaches it. Run against a migrated database; every failed
-- assertion raises, so apply.sh stops on a bad build. Safe to re-run.
--
-- What it can check statically (pg_catalog) it does; behavioural checks
-- (FIFO consumption, journal routing, conflicts) need a seeded tenant and
-- are covered by the app-side tests and manual verification.
-- ============================================================================
DO $$
DECLARE
  v_prokind char;
  v_secdef boolean;
  v_source text;
BEGIN
  -- 1. The RPC exists as a normal (non-aggregate, non-window) function.
  SELECT p.prokind, p.prosecdef INTO v_prokind, v_secdef
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'sync_stock_adjustment'
    AND pg_function_is_visible(p.oid)
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sync_stock_adjustment(jsonb) is missing';
  END IF;
  IF v_prokind <> 'f' THEN
    RAISE EXCEPTION 'sync_stock_adjustment must be a plain function, found prokind=%', v_prokind;
  END IF;
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'sync_stock_adjustment must be SECURITY DEFINER';
  END IF;

  -- 2. Execute is granted to authenticated and revoked from anon/public —
  -- writes go through the authenticated app or its sync path only.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_routine_grants
    WHERE specific_schema = 'public' AND routine_name = 'sync_stock_adjustment'
      AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'sync_stock_adjustment is not EXECUTE-granted to authenticated';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.role_routine_grants
    WHERE specific_schema = 'public' AND routine_name = 'sync_stock_adjustment'
      AND grantee IN ('anon', 'public') AND privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'sync_stock_adjustment must not be executable by anon/public';
  END IF;

  -- 3. The reason whitelist and the 3900/5900 debit routing live in the
  -- function body. The routing is the accounting policy: only
  -- quantity_correction may touch Opening Balance Equity.
  SELECT prosrc INTO v_source FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'sync_stock_adjustment';
  IF v_source NOT LIKE '%quantity_correction%' THEN
    RAISE EXCEPTION 'sync_stock_adjustment lost the quantity_correction reason';
  END IF;
  IF v_source NOT LIKE $pat$%'damaged'%$pat$ OR v_source NOT LIKE $pat$%'stolen'%$pat$
     OR v_source NOT LIKE $pat$%'expired'%$pat$ OR v_source NOT LIKE $pat$%'destroyed'%$pat$
     OR v_source NOT LIKE $pat$%'obsolete'%$pat$ THEN
    RAISE EXCEPTION 'sync_stock_adjustment lost one of the loss reasons';
  END IF;
  IF v_source NOT LIKE '%v_is_loss%' OR v_source NOT LIKE $pat$%5900%$pat$ THEN
    RAISE EXCEPTION 'sync_stock_adjustment lost the loss/3900-vs-5900 debit routing';
  END IF;

  -- 4. sync_apply dispatches 'stock.adjust' to it.
  SELECT prosrc INTO v_source FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'sync_apply';
  IF v_source NOT LIKE $pat$%'stock.adjust'%$pat$
     OR v_source NOT LIKE '%sync_stock_adjustment%' THEN
    RAISE EXCEPTION 'sync_apply does not dispatch stock.adjust to sync_stock_adjustment';
  END IF;

  RAISE NOTICE '02_stock_adjustment: all assertions passed';
END $$;
