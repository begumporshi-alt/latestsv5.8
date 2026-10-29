/**
 * The raw Supabase client — no offline interception.
 *
 * The offline internals (replica, outbox, sync engine, caches, gates) must see
 * the true network outcome: a failure has to stay a failure so they can mark
 * the app offline, keep the previous local data, and stop a replication run.
 * The app-wide client exported by lib/supabase.ts wraps this one with a
 * transparent read fallback (lib/offline/read-fallback.ts) — never import the
 * wrapped client from inside the offline layer.
 *
 * The client is created lazily on first access from the runtime connection
 * config (lib/runtime-config.ts), not at module load: NEXT_PUBLIC_* values are
 * build-time inlined, so a module-level createClient would freeze whichever
 * Supabase the build machine pointed at. The Proxy keeps `supabaseRaw` a value
 * export so ~90 import sites are untouched; the offline wrapper in
 * read-fallback.ts already forwards through a Proxy the same way.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { trackedFetch } from './telemetry/egress-tracker';
import { getSupabaseConfig } from './runtime-config';

let instance: SupabaseClient | null = null;

function real(): SupabaseClient {
  if (!instance) {
    const { url, anonKey } = getSupabaseConfig();
    instance = createClient(url, anonKey, {
      global: { fetch: trackedFetch },
    });
  }
  return instance;
}

// trackedFetch observes every request/response (Settings → API Usage) and
// aggregates byte counts locally — it never issues a request itself.
export const supabaseRaw: SupabaseClient = new Proxy({} as SupabaseClient, {
  get: (_target, prop) => Reflect.get(real(), prop),
  has: (_target, prop) => prop in real(),
  ownKeys: () => Reflect.ownKeys(real()),
  getOwnPropertyDescriptor: (_target, prop) => {
    const descriptor = Reflect.getOwnPropertyDescriptor(real(), prop);
    if (descriptor) descriptor.configurable = true;
    return descriptor;
  },
});
