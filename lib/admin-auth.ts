import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';

// Server-only helpers for admin API routes. The service-role key must never
// reach the client; every route resolves the caller's identity from their
// forwarded access token and checks their role in profiles before acting.

const SERVICE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
// This repo stores the service key as NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY
// (server-side .env only); accept the conventional name too.
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY;

export { SERVICE_URL, SERVICE_ROLE_KEY };

export type AdminContext = { user: User; admin: SupabaseClient };

export async function assertRole(
  authHeader: string | null,
  roles: string[],
): Promise<AdminContext | null> {
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length)
    : null;
  if (!token || !SERVICE_URL || !SERVICE_ROLE_KEY) return null;

  const admin = createClient(SERVICE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) return null;

  const { data: profile } = await admin
    .from('profiles')
    .select('role, is_active')
    .eq('id', userData.user.id)
    .single();

  // Deactivated accounts keep a valid token for up to the JWT expiry, so the
  // role check alone isn't enough — their admin-API calls must also fail.
  if (!profile || profile.is_active === false || !roles.includes(profile.role)) return null;
  return { user: userData.user, admin };
}

export async function assertSuperAdmin(authHeader: string | null): Promise<AdminContext | null> {
  return assertRole(authHeader, ['super_admin']);
}
