'use client';

/**
 * Segment error boundary for every (erp) route — rendered INSIDE the ERP
 * layout, so the sidebar and header stay usable while the failed page shows a
 * recoverable message instead of a blank screen.
 *
 * The offline case is the important one: a page whose data was never loaded
 * on this device cannot work offline, and that must look like a message, not
 * like the app being broken.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { TriangleAlert as AlertTriangle, RefreshCw, CloudOff, LayoutDashboard, ShoppingCart, Package, ArrowLeftRight } from 'lucide-react';

const OFFLINE_SHORTCUTS = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/sales/pos', label: 'POS', icon: ShoppingCart },
  { href: '/inventory', label: 'Inventory', icon: Package },
  { href: '/sync', label: 'Sync Center', icon: ArrowLeftRight },
];

export default function ErpError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    setOffline(typeof navigator !== 'undefined' && !navigator.onLine);
    console.error('[erp] page error:', error);
  }, [error]);

  return (
    <div className="flex items-center justify-center min-h-[60vh] p-6">
      <div className="max-w-md w-full text-center">
        <div
          className={`w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4 ${
            offline ? 'bg-amber-500/10' : 'bg-red-500/10'
          }`}
        >
          {offline ? (
            <CloudOff className="w-7 h-7 text-amber-500" />
          ) : (
            <AlertTriangle className="w-7 h-7 text-red-500" />
          )}
        </div>

        <h1 className="text-lg font-bold mb-1.5">
          {offline ? 'This page isn’t available offline yet' : 'This page hit an error'}
        </h1>
        <p className="text-sm text-muted-foreground mb-1">
          {offline
            ? 'It needs one online visit to save a local copy. Your data is safe, and anything queued will sync.'
            : 'Your data is safe. Try again — if it keeps failing, the Sync Center shows what the app is doing.'}
        </p>
        {error.digest && <p className="text-[11px] text-muted-foreground/70 mb-4">Reference: {error.digest}</p>}

        <div className="flex items-center justify-center gap-2 flex-wrap mb-5">
          <button
            onClick={() => reset()}
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition"
          >
            <RefreshCw className="w-4 h-4" /> Try again
          </button>
          {OFFLINE_SHORTCUTS.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className="inline-flex items-center gap-2 px-3 py-2 border border-border hover:bg-muted rounded-lg text-sm transition"
            >
              <Icon className="w-4 h-4" /> {label}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
