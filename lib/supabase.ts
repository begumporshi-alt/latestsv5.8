import { supabaseRaw } from './supabase-raw';
import { withOfflineReads } from './offline/read-fallback';

/**
 * The app-wide Supabase client.
 *
 * Reads are wrapped with a transparent offline fallback (see
 * lib/offline/read-fallback.ts): while online nothing changes, and when the
 * network is gone every read serves its last successful result from the
 * encrypted local cache — so pages keep showing their last-known data instead
 * of going blank. Writes, auth, storage and realtime pass straight through.
 *
 * The offline internals import `supabaseRaw` (lib/supabase-raw.ts) instead —
 * they must see true network failures.
 */
export const supabase = withOfflineReads(supabaseRaw);

export type { User, Session } from '@supabase/supabase-js';
