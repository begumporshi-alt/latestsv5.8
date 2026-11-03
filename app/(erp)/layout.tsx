'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import Sidebar from '@/components/layout/Sidebar';
import Header from '@/components/layout/Header';
import QuickActionDrawer from '@/components/ui/QuickActionDrawer';
import RoleRouteGuard from '@/components/layout/RoleRouteGuard';
import SessionGate from '@/components/layout/SessionGate';
import { Toaster } from '@/components/ui/toaster';
import { OfflineProvider } from '@/lib/offline/provider';
import QueryProvider from '@/components/providers/QueryProvider';
import OfflineBanner from '@/components/offline/OfflineBanner';
import OfflineDataNotice from '@/components/offline/OfflineDataNotice';
import { getLastUser, rememberUser } from '@/lib/offline/session';
import { networkMonitor } from '@/lib/offline/network';
import { getSupabaseConfig } from '@/lib/runtime-config';
import { mark } from '@/lib/perf/cold-start';
import { setCurrencyFormat, type CurrencyFormat } from '@/lib/format';
import { Menu, PanelLeftClose, PanelLeft, CloudOff } from 'lucide-react';

/** Resolve with the promise's value, or null after `ms` — never rejects. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * Probe the Supabase auth endpoint itself. This answers the question the
 * session gate actually has: can a token refresh possibly succeed right now?
 * The app server can be up (localhost, LAN, a same-region CDN) while the
 * auth service that issued the session is not — a /api/ping probe would
 * call that state "online" and bounce an otherwise-working offline user to
 * /login after the late-session wait gives up.
 */
async function authReachable(timeoutMs: number): Promise<boolean> {
  let base: string;
  let apiKey: string;
  try {
    const config = getSupabaseConfig();
    base = config.url;
    apiKey = config.anonKey;
  } catch {
    return true; // no config available — don't let this probe block anything
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/auth/v1/health`, {
      cache: 'no-store',
      signal: controller.signal,
      headers: { apikey: apiKey },
    });
    return res.status > 0; // any completed HTTP response proves reachability
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export default function ERPLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [offlineUser, setOfflineUser] = useState<{ email: string | null } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('sidebarCollapsed');
    if (saved) setSidebarCollapsed(saved === 'true');
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase.from('app_settings').select('*').eq('setting_key', 'currency').maybeSingle();
        if (cancelled) return;
        if (data?.setting_value) {
          setCurrencyFormat(data.setting_value as Partial<CurrencyFormat>);
          localStorage.setItem('currencyFormat', JSON.stringify(data.setting_value));
        }
      } catch {
        const cached = localStorage.getItem('currencyFormat');
        if (cached && !cancelled) setCurrencyFormat(JSON.parse(cached));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // Cold-start checkpoint: everything the POS needs (mount, catalogue
      // load, first tile) is gated behind this resolution.
      mark('auth:gate-start');

      // The gate stays blocking on purpose.
      //
      // An earlier version rendered the shell optimistically whenever a user
      // was remembered on this device, to skip this wait. It was removed: the
      // wait is 5-400 ms in the normal case (a local read, or one token
      // refresh), so the saving was invisible — and in the one case where it
      // was visible, a session that never resolves, rendering the app meant
      // showing the previous user's cached catalogue and then bouncing them to
      // /login seconds later. Slow and wrong beat fast and wrong.
      //
      // What actually made the first POS open slow was elsewhere and is fixed:
      // the cache read no longer waits on this token refresh (lib/offline/
      // session.ts resolveUserId), and the snapshot rebuild no longer blocks
      // the grid (lib/offline/cache.ts staleWhileRevalidate).

      // auth-js can stall for tens of seconds when the access token is
      // expired and the network is unreachable (lock + refresh attempts).
      // Cap the wait — an offline device must open the app promptly.
      const first = await withTimeout(supabase.auth.getSession(), 4000);
      if (cancelled) return;
      const session = first?.data?.session ?? null;
      if (session) {
        void rememberUser(session.user);
        mark('auth:gate-end');
        setLoading(false);
        return;
      }
      // No live session. auth-js keeps the stored session but resolves null
      // once the access token has expired and the network is gone — that must
      // NOT bounce an offline device to /login (which needs internet). What
      // decides between the offline shell and waiting for a late refresh is
      // whether the AUTH service is reachable — not this app server, which
      // can be up while the auth service that issued the session is down.
      const last = await getLastUser();
      if (last) {
        const authAlive = await authReachable(3000);
        if (cancelled) return;
        if (!authAlive) {
          setOfflineUser({ email: last.email });
          mark('auth:gate-end');
          setLoading(false);
          return;
        }
        // Online but no session yet: a slow token refresh may still land.
        const late = await withTimeout(supabase.auth.getSession(), 6000);
        if (!cancelled && late?.data?.session) {
          void rememberUser(late.data.session.user);
          mark('auth:gate-end');
          setLoading(false);
          return;
        }
      }
      mark('auth:gate-end');
      if (!cancelled) router.replace('/login');
    })();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        void (async () => {
          // The Header's sign-out clears the remembered user BEFORE calling
          // signOut(), so a last user that still exists means this event was
          // NOT user-initiated: auth-js removed a session whose token refresh
          // failed (GoTrueClient _recoverAndRefresh). When the auth service
          // is unreachable that is an outage, not a sign-out — bouncing to
          // /login (which needs internet) would lock the user out of their
          // own cached data. Keep them in the offline shell instead; after
          // reconnect a reload re-runs the gate and restores the session.
          const last = await getLastUser();
          if (cancelled) return;
          if (last) {
            if (!networkMonitor.getState().online) {
              setOfflineUser({ email: last.email });
              return;
            }
            const alive = await authReachable(4000);
            if (cancelled) return;
            if (!alive) {
              setOfflineUser({ email: last.email });
              return;
            }
          }
          router.replace('/login');
        })();
        return;
      }
      if (session?.user) {
        void rememberUser(session.user);
        setOfflineUser(null);
      }
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [router]);

  function toggleSidebarCollapsed() {
    setSidebarCollapsed(prev => {
      const newValue = !prev;
      localStorage.setItem('sidebarCollapsed', String(newValue));
      return newValue;
    });
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="text-center">
          <div className="w-10 h-10 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-slate-400 text-sm">Loading ERP...</p>
        </div>
      </div>
    );
  }

  return (
    <QueryProvider>
    <OfflineProvider>
    <div className="flex min-h-screen bg-background">
      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar — hidden on mobile, collapsible on lg+ */}
      <div className={`
        fixed inset-y-0 left-0 z-50 lg:sticky lg:top-0 lg:self-start lg:z-auto
        transform transition-all duration-300 ease-in-out
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
        ${sidebarCollapsed ? 'lg:w-[60px]' : 'lg:w-auto'}
      `}>
        <Sidebar collapsed={sidebarCollapsed} />
      </div>

      {/* Collapse toggle button - desktop only */}
      <button
        onClick={toggleSidebarCollapsed}
        className="hidden lg:flex fixed left-0 top-1/2 -translate-y-1/2 z-30 w-5 h-12 items-center justify-center bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition-colors rounded-r-lg"
        style={{ left: sidebarCollapsed ? '60px' : '220px' }}
        title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {sidebarCollapsed ? <PanelLeft className="w-3.5 h-3.5" /> : <PanelLeftClose className="w-3.5 h-3.5" />}
      </button>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Mobile menu button - fixed position */}
        <div className="lg:hidden fixed top-0 left-0 right-0 z-30 flex items-center gap-2 px-4 py-3 bg-slate-900/95 backdrop-blur-sm border-b border-slate-800">
          <button
            onClick={() => setSidebarOpen(true)}
            className="text-white p-2 rounded-lg bg-slate-800 hover:bg-slate-700 transition-colors"
          >
            <Menu className="w-5 h-5" />
          </button>
          <span className="text-white font-bold text-sm tracking-tight">SI Building ERP</span>
        </div>
        {/* Spacer for mobile fixed header */}
        <div className="lg:hidden h-14" />

        <Header onMenuToggle={() => setSidebarOpen(!sidebarOpen)} />

        {offlineUser && (
          <div className="flex items-center gap-2 px-4 py-1.5 text-xs font-medium border-b bg-slate-100 text-slate-700 border-slate-200">
            <CloudOff className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">
              Working offline{offlineUser.email ? ` as ${offlineUser.email}` : ''} — your sign-in refreshes
              automatically when the connection returns.
            </span>
          </div>
        )}

        <OfflineBanner />
        <OfflineDataNotice />

        <main className="flex-1 overflow-auto p-4 md:p-6 animate-fade-in">
          <RoleRouteGuard>
            {children}
          </RoleRouteGuard>
        </main>
      </div>

      {/* Global Quick Action Drawer */}
      <QuickActionDrawer />
      <SessionGate />
      <Toaster />
    </div>
    </OfflineProvider>
    </QueryProvider>
  );
}
