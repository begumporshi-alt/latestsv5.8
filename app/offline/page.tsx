'use client';

/**
 * Fallback page precached by the service worker: shown when a navigation
 * fails offline AND that route has no cached shell. The offline-capable
 * modules are linked directly so the user lands somewhere useful instead of
 * a dead end.
 */

import { useEffect } from 'react';
import Link from 'next/link';
import { CloudOff, RefreshCw, LayoutDashboard, ShoppingCart, Package, Users, ArrowLeftRight } from 'lucide-react';

const SHORTCUTS = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/sales/pos', label: 'POS', icon: ShoppingCart },
  { href: '/inventory', label: 'Inventory', icon: Package },
  { href: '/crm', label: 'Customers', icon: Users },
  { href: '/sync', label: 'Sync Center', icon: ArrowLeftRight },
];

export default function OfflineFallbackPage() {
  // When the connection comes back, leave this page automatically.
  useEffect(() => {
    const onOnline = () => window.location.reload();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, []);

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-6">
      <div className="text-center max-w-lg">
        <div className="w-16 h-16 bg-amber-500/10 rounded-2xl flex items-center justify-center mx-auto mb-5">
          <CloudOff className="w-8 h-8 text-amber-400" />
        </div>
        <h1 className="text-xl font-bold text-white mb-2">You&rsquo;re offline</h1>
        <p className="text-sm text-slate-400 mb-1">
          This page hasn&rsquo;t been opened on this device yet, so there&rsquo;s no saved copy of it.
        </p>
        <p className="text-xs text-slate-500 mb-6">
          Everything you visited while online stays available — open it once with a connection and it will
          be here next time.
        </p>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-6">
          {SHORTCUTS.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className="flex items-center justify-center gap-2 px-3 py-2.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded-lg text-sm font-medium transition"
            >
              <Icon className="w-4 h-4" /> {label}
            </Link>
          ))}
        </div>

        <button
          onClick={() => window.location.reload()}
          className="inline-flex items-center gap-2 px-4 py-2 border border-slate-700 hover:bg-slate-800 text-slate-300 rounded-lg text-sm transition"
        >
          <RefreshCw className="w-4 h-4" /> Try again
        </button>
        <p className="text-[11px] text-slate-600 mt-4">
          This page reloads on its own as soon as the connection returns.
        </p>
      </div>
    </div>
  );
}
