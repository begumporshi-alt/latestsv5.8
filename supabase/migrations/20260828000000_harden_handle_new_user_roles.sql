-- ============================================================
-- Harden handle_new_user: deny self-assigned privileged roles
-- ============================================================
-- PROBLEM
--   The signup trigger read raw_user_meta_data->>'role' directly from the
--   client-supplied payload and trusted it. Combined with the old login-page
--   "demo" button (which signed up with role='super_admin'), any visitor could
--   self-provision a super_admin account.
--
-- FIX
--   Self-signups always land on 'store_customer'. Privileged roles
--   (super_admin, manager, accountant, inventory_manager, etc.) can only be
--   assigned by an already-privileged admin through the profiles table, never
--   through signup metadata.
--
-- SAFETY
--   Idempotent: drop+recreate, same trigger name. Does not touch existing
--   profiles or auth.users rows. Anyone who already self-created a privileged
--   profile keeps it (out of scope here; flag for manual review).

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_user();

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  user_role text;
BEGIN
  -- Self-signups get the least-privileged role. Privileged roles are never
  -- taken from client metadata; they are assigned by an admin on the profile.
  user_role := 'store_customer';

  INSERT INTO public.profiles (id, email, full_name, role, tenant_id)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    user_role,
    '00000000-0000-0000-0000-000000000001'::uuid
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Error creating profile for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
