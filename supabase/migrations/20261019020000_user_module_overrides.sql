-- ============================================================
-- Per-user module access overrides
-- ============================================================
-- Super admins can deviate individual users from their role's default
-- module access. A row here wins over the role matrix for that module;
-- absence of a row means "use the role default".
--
--   module_prefix  matches a prefix in lib/permissions.ts ROUTE_RULES
--   allowed        true = always open, false = always denied
--
-- SELECT is open (offline replica sync + managers viewing the tab);
-- writes are super_admin only, made directly from the Users & Roles tab.

CREATE TABLE IF NOT EXISTS public.user_module_access (
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  module_prefix text NOT NULL,
  allowed boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, module_prefix)
);

ALTER TABLE public.user_module_access ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS uma_select ON public.user_module_access;
CREATE POLICY uma_select ON public.user_module_access
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS uma_insert ON public.user_module_access;
CREATE POLICY uma_insert ON public.user_module_access
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(ARRAY['super_admin']) AND public.is_active_user());

DROP POLICY IF EXISTS uma_update ON public.user_module_access;
CREATE POLICY uma_update ON public.user_module_access
  FOR UPDATE TO authenticated
  USING (public.has_role(ARRAY['super_admin']) AND public.is_active_user())
  WITH CHECK (public.has_role(ARRAY['super_admin']) AND public.is_active_user());

DROP POLICY IF EXISTS uma_delete ON public.user_module_access;
CREATE POLICY uma_delete ON public.user_module_access
  FOR DELETE TO authenticated
  USING (public.has_role(ARRAY['super_admin']) AND public.is_active_user());
