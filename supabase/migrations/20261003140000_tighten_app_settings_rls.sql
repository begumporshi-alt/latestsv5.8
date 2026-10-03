-- app_settings (company settings etc.): revoke anonymous access; ERP pages run
-- as `authenticated`, server scripts use the service key, and offline queued
-- writes go through SECURITY DEFINER sync RPCs that bypass RLS.
DROP POLICY IF EXISTS settings_select ON public.app_settings;
DROP POLICY IF EXISTS settings_insert ON public.app_settings;
DROP POLICY IF EXISTS settings_update ON public.app_settings;
DROP POLICY IF EXISTS settings_delete ON public.app_settings;

CREATE POLICY settings_select ON public.app_settings FOR SELECT TO authenticated USING (true);
CREATE POLICY settings_insert ON public.app_settings FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY settings_update ON public.app_settings FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY settings_delete ON public.app_settings FOR DELETE TO authenticated USING (true);

NOTIFY pgrst, 'reload schema';
