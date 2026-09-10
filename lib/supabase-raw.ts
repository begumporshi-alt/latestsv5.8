/**
 * The raw Supabase client — no offline interception.
 *
 * The offline internals (replica, outbox, sync engine, caches, gates) must see
 * the true network outcome: a failure has to stay a failure so they can mark
 * the app offline, keep the previous local data, and stop a replication run.
 * The app-wide client exported by lib/supabase.ts wraps this one with a
 * transparent read fallback (lib/offline/read-fallback.ts) — never import the
 * wrapped client from inside the offline layer.
 */
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabaseRaw = createClient(supabaseUrl, supabaseAnonKey);
