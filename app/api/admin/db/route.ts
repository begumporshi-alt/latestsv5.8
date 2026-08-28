import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Server-side proxy for the db-backup / db-restore Supabase Edge Functions.
//
// The Edge Functions require a super_admin caller (see their index.ts). We
// resolve the caller's identity server-side from the forwarded access token
// and reject anything that is not an authenticated super_admin before proxying.
//
// The edge functions run with the service-role key, so this route MUST NOT be
// reachable by anyone who is not a super_admin.

const SERVICE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // server-only

function unauthorized(message: string) {
  return NextResponse.json({ error: message }, { status: 401 });
}

function forbidden(message: string) {
  return NextResponse.json({ error: message }, { status: 403 });
}

async function assertSuperAdmin(authHeader: string | null) {
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length)
    : null;
  if (!token) return null;

  if (!SERVICE_URL || !SERVICE_ROLE_KEY) return null;

  const admin = createClient(SERVICE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) return null;

  const { data: profile } = await admin
    .from('profiles')
    .select('role')
    .eq('id', userData.user.id)
    .single();

  if (!profile || profile.role !== 'super_admin') return null;
  return userData.user;
}

async function handler(req: Request) {
  // We only ever proxy to a fixed Supabase endpoint, never to user input.
  const functionName = req.method === 'GET' ? 'db-backup' : 'db-restore';
  const url = `${SERVICE_URL}/functions/v1/${functionName}`;

  const authHeader = req.headers.get('Authorization');
  const user = await assertSuperAdmin(authHeader);
  if (!user) return forbidden('super_admin role required');

  // Forward the caller's original access token so the Edge Function can
  // re-validate it with auth.getUser(). The service-role key stays server-side.
  const headers: Record<string, string> = {
    Authorization: authHeader!,
    apikey: SERVICE_ROLE_KEY!,
    'Content-Type': 'application/json',
  };

  try {
    if (req.method === 'GET') {
      const upstream = await fetch(url, { headers });
      if (!upstream.ok) {
        const err = await upstream.json().catch(() => ({ error: upstream.statusText }));
        return NextResponse.json(err, { status: upstream.status });
      }
      const blob = await upstream.blob();
      const filename = `erp-backup-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
      return new NextResponse(blob, {
        headers: {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      });
    }

    // POST restore
    const body = await req.text();
    const upstream = await fetch(url, { method: 'POST', headers, body });
    const result = await upstream.json().catch(() => ({ error: upstream.statusText }));
    return NextResponse.json(result, { status: upstream.ok ? 200 : (upstream.status || 500) });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Backup/Restore failed' }, { status: 502 });
  }
}

export const GET = handler;
export const POST = handler;
