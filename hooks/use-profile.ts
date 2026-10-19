'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { ModuleOverrides } from '@/lib/permissions';

export interface ProfileInfo {
  role: string;
  full_name: string;
  /** Per-user module overrides (user_module_access). Absent = role defaults. */
  moduleOverrides?: ModuleOverrides;
}

// Module-level dedupe: several components (sidebar, route guard, settings)
// need the role on every page; one fetch per uid per session is enough.
let fetched: { uid: string; profile: ProfileInfo } | null = null;
let inflight: Promise<ProfileInfo | null> | null = null;

function cacheKey(uid: string) {
  return `erpProfile:${uid}`;
}

async function loadProfile(): Promise<ProfileInfo | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.id) return null;

  if (fetched?.uid === user.id) return fetched.profile;

  if (!inflight) {
    inflight = (async () => {
      try {
        const { data } = await supabase
          .from('profiles')
          .select('role, full_name')
          .eq('id', user.id)
          .single();
        if (!data) return null;
        // Overrides are optional enrichment: on failure the role defaults
        // apply (fail-open, same contract as the role itself).
        const { data: overrides } = await supabase
          .from('user_module_access')
          .select('module_prefix, allowed')
          .eq('user_id', user.id);
        const moduleOverrides: ModuleOverrides | undefined = overrides?.length
          ? Object.fromEntries(overrides.map(o => [o.module_prefix, o.allowed]))
          : undefined;
        const profile: ProfileInfo = { role: data.role, full_name: data.full_name, moduleOverrides };
        fetched = { uid: user.id, profile };
        try { localStorage.setItem(cacheKey(user.id), JSON.stringify(profile)); } catch { /* private mode */ }
        return profile;
      } finally {
        inflight = null;
      }
    })();
  }
  return inflight;
}

function readCache(uid: string): ProfileInfo | null {
  try {
    const raw = localStorage.getItem(cacheKey(uid));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Current user's profile (role + name). Returns a cached copy instantly when
 * available so guards never flash or block render, and refreshes in the
 * background. A null role must be treated as "no restriction" by callers —
 * the app keeps working when the profile can't be fetched (offline).
 */
export function useProfile(): { profile: ProfileInfo | null; loading: boolean } {
  const [profile, setProfile] = useState<ProfileInfo | null>(() => {
    if (typeof window === 'undefined') return null;
    return fetched?.profile ?? null;
  });
  const [loading, setLoading] = useState(!fetched);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Instant paint from cache while the fresh fetch runs.
      if (!profile && typeof window !== 'undefined') {
        const { data: { user } } = await supabase.auth.getUser();
        const uid = user?.id;
        if (uid) {
          const cached = readCache(uid);
          if (cached && !cancelled) setProfile(cached);
        }
      }
      const fresh = await loadProfile();
      if (!cancelled && fresh) setProfile(fresh);
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { profile, loading };
}
