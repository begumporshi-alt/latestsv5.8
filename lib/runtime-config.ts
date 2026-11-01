/**
 * Runtime Supabase connection config.
 *
 * The packaged app must be able to switch which Supabase the ERP talks to
 * (local standby stack, user's hosted Supabase, a LAN host) without a
 * rebuild — but NEXT_PUBLIC_* values are inlined into client bundles at
 * build time and cannot be changed at runtime. Resolution therefore is:
 *
 *   1. window.__SUPABASE_CONFIG__ — injected per page load by the root
 *      layout from the SERVER's runtime env (see app/layout.tsx). This is
 *      the authoritative source in the packaged app.
 *   2. localStorage cache — covers boots where the injected script did not
 *      run (e.g. stale cached HTML served by the service worker).
 *   3. Build-time NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY —
 *      today's behavior, unchanged fallback.
 *
 * The service-role key never flows through here: it is server-side only
 * (lib/admin-auth.ts reads it from process.env directly).
 */

export interface SupabaseConfig {
  url: string;
  anonKey: string;
}

const INJECTED_KEY = '__SUPABASE_CONFIG__';

// The cache key is scoped to the Supabase project this build was compiled
// against. Without that, a device booting from stale cached HTML keeps
// reading a config that points at the PREVIOUS project and silently writes
// there after a cutover. Scoping the key makes the old entry unreachable the
// moment the build targets a new project ref, with no manual bump required.
function buildProjectRef(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return 'runtime';
  const host = url.replace(/^https?:\/\//, '').split('/')[0];
  return host.split('.')[0] || 'runtime';
}

/**
 * Cache key the resolved config is written under.
 *
 * Exported because the project ref is part of the key: any tooling that seeds
 * or clears this cache must use this value rather than a literal, or it will
 * write to a key nothing reads. (The unit tests learned that the hard way —
 * they kept asserting the pre-scoping key and silently rotted.)
 */
export const RUNTIME_CONFIG_CACHE_KEY = `sisolution.runtime-config.${buildProjectRef()}`;
const CACHE_KEY = RUNTIME_CONFIG_CACHE_KEY;
// Pre-cutover builds wrote to the unscoped key; drop it so a stale config
// cannot linger in storage after this version is deployed.
const LEGACY_CACHE_KEY = 'sisolution.runtime-config';

declare global {
  interface Window {
    [INJECTED_KEY]?: SupabaseConfig;
  }
}

function sanitize(config: SupabaseConfig | null | undefined): SupabaseConfig | null {
  if (!config || typeof config.url !== 'string' || typeof config.anonKey !== 'string') return null;
  if (!/^https?:\/\//.test(config.url) || !config.anonKey) return null;
  return { url: config.url.replace(/\/+$/, ''), anonKey: config.anonKey };
}

export function getSupabaseConfig(): SupabaseConfig {
  if (typeof window !== 'undefined') {
    const injected = sanitize(window[INJECTED_KEY]);
    if (injected) {
      try {
        window.localStorage.setItem(CACHE_KEY, JSON.stringify(injected));
        window.localStorage.removeItem(LEGACY_CACHE_KEY);
      } catch { /* private mode etc. */ }
      return injected;
    }
    try {
      // Drop any pre-scoping entry BEFORE the early return below. On the
      // (common) cache-hit path an early return would otherwise skip this
      // cleanup, leaving the previous project's config in storage forever —
      // exactly the lingering state this scoping exists to prevent.
      window.localStorage.removeItem(LEGACY_CACHE_KEY);
      const cached = sanitize(JSON.parse(window.localStorage.getItem(CACHE_KEY) ?? 'null'));
      if (cached) return cached;
    } catch { /* corrupt cache — fall through */ }
  }
  // Server side (and any client fallback): runtime env, which on the server
  // IS the live supervisor-provided value.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (url && anonKey) return { url: url.replace(/\/+$/, ''), anonKey };
  throw new Error('Supabase connection config is missing: no injected config, cache, or NEXT_PUBLIC_* env.');
}
