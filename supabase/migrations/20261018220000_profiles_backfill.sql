-- Backfill profiles from auth.users and auto-create on signup.
-- The notifications feature (target_role RLS + notification_reads FK)
-- requires a profiles row per user, but no code path ever created one.

INSERT INTO profiles (id, email, full_name, role, is_active)
SELECT u.id,
       coalesce(u.email, ''),
       coalesce(u.raw_user_meta_data->>'full_name', split_part(coalesce(u.email, ''), '@', 1)),
       'super_admin',
       true
FROM auth.users u
WHERE NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = u.id)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO profiles (id, email, full_name, role, is_active)
  VALUES (
    NEW.id,
    coalesce(NEW.email, ''),
    coalesce(NEW.raw_user_meta_data->>'full_name', split_part(coalesce(NEW.email, ''), '@', 1)),
    'sales_executive',
    true
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
