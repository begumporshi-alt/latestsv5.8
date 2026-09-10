'use client';

/**
 * Shown when a page read had no offline copy (lib/offline/read-fallback).
 *
 * Without this, a page whose data was never loaded on this device while
 * online would just render empty — indistinguishable from "the app is
 * broken". The notice says exactly what happened and what fixes it.
 */

import { useEffect, useState } from 'react';
import { CloudOff, RefreshCw, X } from 'lucide-react';
import { subscribeOfflineMiss } from '@/lib/offline/read-fallback';
import { networkMonitor } from '@/lib/offline/network';

export default function OfflineDataNotice() {
  const [missing, setMissing] = useState<string[]>([]);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const unsubscribe = subscribeOfflineMiss((info) => {
      setMissing((prev) => (prev.includes(info.target) ? prev : [...prev, info.target].slice(-6)));
    });
    // Coming back online clears the notice — the next load fetches live data.
    const unsubNetwork = networkMonitor.subscribe((state) => {
      if (state.online) {
        setMissing([]);
        setDismissed(false);
      }
    });
    return () => {
      unsubscribe();
      unsubNetwork();
    };
  }, []);

  if (dismissed || missing.length === 0) return null;

  return (
    <div className="flex items-center gap-2 px-4 py-1.5 text-xs font-medium border-b bg-slate-100 text-slate-700 border-slate-200">
      <CloudOff className="w-3.5 h-3.5 shrink-0" />
      <span className="truncate">
        Some data here isn&rsquo;t available offline yet — it was never opened on this device while online.
        Reconnect once and reload to save a copy.
      </span>
      <button
        onClick={() => window.location.reload()}
        className="ml-auto shrink-0 inline-flex items-center gap-1 underline underline-offset-2 hover:text-slate-900"
      >
        <RefreshCw className="w-3 h-3" /> Retry
      </button>
      <button
        onClick={() => setDismissed(true)}
        className="shrink-0 hover:text-slate-900"
        aria-label="Dismiss"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
