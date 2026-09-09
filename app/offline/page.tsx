'use client';

/**
 * Fallback page precached by the service worker: shown when a navigation
 * fails offline AND that route was never visited while online.
 */

import Link from 'next/link';
import { CloudOff, Wifi, RefreshCw } from 'lucide-react';

export default function OfflineFallbackPage() {
  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-6">
      <div className="text-center max-w-md">
        <div className="w-16 h-16 bg-amber-500/10 rounded-2xl flex items-center justify-center mx-auto mb-5">
          <CloudOff className="w-8 h-8 text-amber-400" />
        </div>
        <h1 className="text-xl font-bold text-white mb-2">You&rsquo;re offline</h1>
        <p className="text-sm text-slate-400 mb-1">
          This page hasn&rsquo;t been opened on this device before, so there&rsquo;s no cached copy to show.
        </p>
        <p className="text-xs text-slate-500 mb-6">
          Pages you visited while online stay available offline — the POS, products, customers, sales and
          employee records all work from their local cache.
        </p>
        <div className="flex items-center justify-center gap-3">
          <Link
            href="/dashboard"
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition"
          >
            <Wifi className="w-4 h-4" /> Go to cached Dashboard
          </Link>
          <button
            onClick={() => window.location.reload()}
            className="flex items-center gap-2 px-4 py-2 border border-slate-700 hover:bg-slate-800 text-slate-300 rounded-lg text-sm transition"
          >
            <RefreshCw className="w-4 h-4" /> Retry
          </button>
        </div>
      </div>
    </div>
  );
}
