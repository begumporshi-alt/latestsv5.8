import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { assertRole } from '@/lib/admin-auth';

// User management API. GET is visible to super_admin + manager; every
// mutation requires super_admin. All privileged work runs server-side with
// the service-role key after the caller's role is verified from their token.

const ASSIGNABLE_ROLES = [
  'super_admin',
  'manager',
  'sales_executive',
  'inventory_manager',
  'accountant',
  'delivery_staff',
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

// Hand-over password: long enough to be safe, typed from an alphabet with no
// look-alike characters (0/O, 1/l/I) since it will be read off a screen.
function generateTempPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(14);
  let out = '';
  for (let i = 0; i < 14; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export async function GET(req: Request) {
  const ctx = await assertRole(req.headers.get('Authorization'), ['super_admin', 'manager']);
  if (!ctx) return jsonError('super_admin role required', 403);

  const [usersRes, profilesRes] = await Promise.all([
    ctx.admin.auth.admin.listUsers({ perPage: 500 }),
    ctx.admin.from('profiles').select('id, email, full_name, phone, role, is_active, created_at'),
  ]);
  if (usersRes.error) return jsonError(usersRes.error.message, 500);
  if (profilesRes.error) return jsonError(profilesRes.error.message, 500);

  const users = profilesRes.data
    .map(p => {
      const au = usersRes.data.users.find(u => u.id === p.id);
      return {
        id: p.id,
        email: p.email || au?.email || '',
        full_name: p.full_name,
        phone: p.phone || '',
        role: p.role,
        is_active: p.is_active,
        created_at: p.created_at,
        last_sign_in_at: au?.last_sign_in_at ?? null,
        invite_pending: !!au && !au.email_confirmed_at,
      };
    })
    .sort((a, b) =>
      a.is_active !== b.is_active ? (a.is_active ? -1 : 1) : a.full_name.localeCompare(b.full_name),
    );

  return NextResponse.json({ users });
}

export async function POST(req: Request) {
  const ctx = await assertRole(req.headers.get('Authorization'), ['super_admin']);
  if (!ctx) return jsonError('super_admin role required', 403);

  const body = await req.json().catch(() => null);

  if (body?.action === 'invite') {
    const email = String(body.email ?? '').trim().toLowerCase();
    const fullName = String(body.full_name ?? '').trim();
    const role = String(body.role ?? '');
    if (!EMAIL_RE.test(email)) return jsonError('Enter a valid email address', 400);
    if (!fullName) return jsonError('Full name is required', 400);
    if (!ASSIGNABLE_ROLES.includes(role)) return jsonError('Invalid role', 400);

    const { data, error } = await ctx.admin.auth.admin.inviteUserByEmail(email, {
      data: { full_name: fullName },
    });
    if (error) {
      const msg = /already|duplicate/i.test(error.message)
        ? 'A user with this email already exists'
        : error.message;
      return jsonError(msg, 400);
    }

    // on_auth_user_created has already created the profile with the default
    // role; apply the role chosen at invite time.
    const { error: updErr } = await ctx.admin
      .from('profiles')
      .update({ role, full_name: fullName, email })
      .eq('id', data.user.id);
    if (updErr) return jsonError(updErr.message, 500);

    return NextResponse.json({ ok: true });
  }

  if (body?.action === 'reset_password') {
    const id = String(body.id ?? '');
    if (!id) return jsonError('User id required', 400);

    const temp = generateTempPassword();
    const { error } = await ctx.admin.auth.admin.updateUserById(id, { password: temp });
    if (error) return jsonError(error.message, 400);

    return NextResponse.json({ ok: true, temporary_password: temp });
  }

  return jsonError('Unknown action', 400);
}

export async function PATCH(req: Request) {
  const ctx = await assertRole(req.headers.get('Authorization'), ['super_admin']);
  if (!ctx) return jsonError('super_admin role required', 403);

  const body = await req.json().catch(() => null);
  const id = String(body?.id ?? '');
  if (!id) return jsonError('User id required', 400);

  const { data: profiles, error: loadErr } = await ctx.admin
    .from('profiles')
    .select('id, role, is_active');
  if (loadErr) return jsonError(loadErr.message, 500);
  const target = profiles.find(p => p.id === id);
  if (!target) return jsonError('User not found', 404);

  const activeSuperAdmins = profiles.filter(p => p.role === 'super_admin' && p.is_active).length;

  if (body.is_active === false) {
    if (id === ctx.user.id) return jsonError('You cannot deactivate your own account', 400);
    if (target.role === 'super_admin' && activeSuperAdmins <= 1)
      return jsonError('Cannot deactivate the last super_admin', 400);
  }
  if (body.role !== undefined) {
    if (!ASSIGNABLE_ROLES.includes(body.role)) return jsonError('Invalid role', 400);
    if (target.role === 'super_admin' && body.role !== 'super_admin' && activeSuperAdmins <= 1)
      return jsonError('Cannot demote the last super_admin', 400);
  }

  const updates: Record<string, unknown> = {};
  if (body.role !== undefined) updates.role = body.role;
  if (body.full_name !== undefined) updates.full_name = String(body.full_name).trim().slice(0, 100);
  if (body.phone !== undefined) updates.phone = String(body.phone).trim().slice(0, 30);
  if (body.is_active !== undefined) updates.is_active = !!body.is_active;
  if (Object.keys(updates).length === 0) return jsonError('Nothing to update', 400);
  updates.updated_at = new Date().toISOString();

  const { data: updated, error } = await ctx.admin
    .from('profiles')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) return jsonError(error.message, 500);

  return NextResponse.json({ ok: true, user: updated });
}
