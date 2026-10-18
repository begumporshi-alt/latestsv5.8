-- ============================================================
-- Deactivation enforcement (phase 3 of user & role management)
-- ============================================================
-- WHAT CHANGES
--   Admin API bans/unbans the auth user when is_active flips, which
--   blocks sign-in and token refresh. This migration closes the gap
--   for tokens that are still valid (default expiry ~1h): every
--   role-restricted write policy from phase 2 now also requires the
--   caller's profile row to be is_active.
--
--   SELECT stays open everywhere (offline replica sync). POS-side
--   tables keep their open write policies by design — a deactivated
--   user's client session is terminated by the SessionGate within a
--   minute, and their token dies at expiry.
--
-- SAFETY
--   Idempotent: drop + recreate, same policy names as phase 2.

CREATE OR REPLACE FUNCTION public.is_active_user()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND is_active
  );
$$;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('app_settings',    ARRAY['super_admin','manager']),
      ('accounts',        ARRAY['super_admin','manager','accountant']),
      ('journal_entries', ARRAY['super_admin','manager','accountant']),
      ('purchase_orders', ARRAY['super_admin','manager','inventory_manager']),
      ('suppliers',       ARRAY['super_admin','manager','inventory_manager']),
      ('employees',       ARRAY['super_admin','manager']),
      ('attendance',      ARRAY['super_admin','manager'])
    ) AS t(tablename, roles)
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'rrt_insert', r.tablename);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'rrt_update', r.tablename);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'rrt_delete', r.tablename);

    EXECUTE format($f$
      CREATE POLICY rrt_insert ON public.%I FOR INSERT TO authenticated
      WITH CHECK (public.has_role(%L::text[]) AND public.is_active_user())
    $f$, r.tablename, r.roles);
    EXECUTE format($f$
      CREATE POLICY rrt_update ON public.%I FOR UPDATE TO authenticated
      USING (public.has_role(%L::text[]) AND public.is_active_user())
      WITH CHECK (public.has_role(%L::text[]) AND public.is_active_user())
    $f$, r.tablename, r.roles, r.roles);
    EXECUTE format($f$
      CREATE POLICY rrt_delete ON public.%I FOR DELETE TO authenticated
      USING (public.has_role(%L::text[]) AND public.is_active_user())
    $f$, r.tablename, r.roles);
  END LOOP;
END;
$$;
