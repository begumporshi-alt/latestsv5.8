'use client';

import { useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { clearLocalData } from '@/lib/offline/db';
import { clearLastUser } from '@/lib/offline/session';

// Signs a deactivated user out within a poll interval (and on refocus).
// Admin API bans them at the auth layer too, so this mainly shortens the
// window before their still-valid access token stops working in the UI.
// Fails open: any fetch error (offline, network) leaves the session alone.
export default function SessionGate() {
  useEffect(() => {
    let cancelled = false;

    async function check() {
      // Must be getSession (local), not getUser: GoTrue answers 403 for a
      // banned user's still-valid token, which would end the check before
      // the profiles read — the exact case this gate exists for.
      const { data: { session } } = await supabase.auth.getSession();
      const uid = session?.user?.id;
      if (!uid || cancelled) return;
      const { data } = await supabase
        .from('profiles')
        .select('is_active')
        .eq('id', uid)
        .single();
      if (cancelled || !data) return;
      if (data.is_active === false) {
        try { localStorage.removeItem(`erpProfile:${uid}`); } catch { /* private mode */ }
        try { sessionStorage.setItem('deactivatedNotice', '1'); } catch { /* private mode */ }
        // Erase the local copy before ending the session.
        //
        // The header's manual logout already does this; this path did not, so a
        // deactivated account left its sealed cache, its replica and — the part
        // that matters — its non-extractable AES key sitting in IndexedDB. The
        // key is what actually protects the data at rest, and "signed out but
        // still decryptable" is not signed out. Best-effort: a storage failure
        // must not block the sign-out itself.
        try { await clearLocalData(); } catch { /* storage unavailable */ }
        try { await clearLastUser(); } catch { /* storage unavailable */ }
        // The (erp) layout's SIGNED_OUT handler performs the redirect.
        await supabase.auth.signOut();
      }
    }

    check();
    const interval = setInterval(check, 60_000);
    window.addEventListener('focus', check);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener('focus', check);
    };
  }, []);

  return null;
}
