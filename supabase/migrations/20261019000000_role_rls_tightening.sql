-- ============================================================
-- Role-aware RLS tightening (phase 2 of user & role management)
-- ============================================================
-- WHAT CHANGES
--   1. profiles: block clients from changing their own role / is_active.
--      Previously profiles_update allowed the row owner to update ANY
--      column, so a sales_executive could self-promote to super_admin
--      from the browser console. Privileged changes now only happen
--      through /api/admin/users, which runs with the service role
--      (auth.uid() is NULL there, so the trigger lets it pass).
--
--   2. Write policies on high-risk tables were "true" — every signed-in
--      user could create/modify accounting records, POs, suppliers, HR
--      records and company settings. Now restricted by role:
--        app_settings                     super_admin, manager
--        accounts, journal_entries        super_admin, manager, accountant
--        purchase_orders, suppliers       super_admin, manager, inventory_manager
--        employees, attendance            super_admin, manager
--
--   3. SELECT stays open on all of these: the offline replica syncs whole
--      tables with the user's own token, and role-filtered reads would
--      break sync for restricted roles. Read-side filtering can come with
--      per-role sync scopes later.
--
-- SAFETY
--   Idempotent: drop + recreate. POS-side tables (invoices, payments,
--   customers, deliveries...) keep their existing open write policies so
--   every role's sales flows keep working.

-- ── Role helper ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.has_role(p_roles text[])
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = ANY (p_roles)
  );
$$;

-- ── 1. profiles: no client-side role / is_active changes ─────
CREATE OR REPLACE FUNCTION public.profiles_protect_privileged()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL
     AND (NEW.role IS DISTINCT FROM OLD.role
          OR NEW.is_active IS DISTINCT FROM OLD.is_active) THEN
    RAISE EXCEPTION 'role and active status can only be changed by an administrator';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_protect_privileged ON public.profiles;
CREATE TRIGGER trg_profiles_protect_privileged
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_protect_privileged();

-- ── 2. Role-restricted write policies ────────────────────────
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
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'rrt_select', r.tablename);

    -- The permissive legacy policies ("true") remain, so these new
    -- permissive policies only narrow who the SET of permissive policies
    -- lets through after they are dropped below. We drop the legacy ones
    -- right after creating the replacements to avoid a window where no
    -- policy matches (default deny) breaking concurrent writes.
    EXECUTE format($f$
      CREATE POLICY rrt_insert ON public.%I FOR INSERT TO authenticated
      WITH CHECK (public.has_role(%L::text[]))
    $f$, r.tablename, r.roles);
    EXECUTE format($f$
      CREATE POLICY rrt_update ON public.%I FOR UPDATE TO authenticated
      USING (public.has_role(%L::text[]))
      WITH CHECK (public.has_role(%L::text[]))
    $f$, r.tablename, r.roles, r.roles);
    EXECUTE format($f$
      CREATE POLICY rrt_delete ON public.%I FOR DELETE TO authenticated
      USING (public.has_role(%L::text[]))
    $f$, r.tablename, r.roles);
  END LOOP;
END;
$$;

-- Drop the legacy open write policies (their names from 001_core_schema /
-- 002_business_operations). Any policy not matched here simply stays —
-- harmless, since the table remains protected by its permissive ORs only
-- if such a policy grants more than the new ones.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT policyname, tablename FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('app_settings','accounts','journal_entries',
                        'purchase_orders','suppliers','employees','attendance')
      AND cmd IN ('INSERT','UPDATE','DELETE')
      AND policyname NOT IN ('rrt_insert','rrt_update','rrt_delete')
  LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', r.policyname, r.tablename);
  END LOOP;
END;
$$;
