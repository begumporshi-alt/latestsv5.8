'use client';

/**
 * Connectivity + sync status pill for the Header's right-actions cluster.
 * Clicking it opens the Sync Center.
 */

import { useRouter } from 'next/navigation';
import { CloudOff, Cloud, RefreshCw, AlertTriangle } from 'lucide-react';
import { useOffline } from '@/lib/offline/provider';

export default function OfflineStatusPill() {
  const router = useRouter();
  const { online, engine, counts } = useOffline();

  const queued = counts.pending + counts.syncing;
  const attention = counts.conflict + counts.failed;

  const label = !online
    ? `Offline${queued > 0 ? ` · ${queued} queued` : ''}`
    : engine.running
      ? 'Syncing…'
      : attention > 0
        ? `Sync issue${attention > 1 ? `s (${attention})` : ''}`
        : queued > 0
          ? `${queued} queued`
          : 'Online';

  const cls = !online
    ? 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
    : engine.running
      ? 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100'
      : attention > 0
        ? 'bg-red-50 text-red-700 border-red-200 hover:bg-red-100'
        : 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100';

  const Icon = !online
    ? CloudOff
    : engine.running
      ? RefreshCw
      : attention > 0
        ? AlertTriangle
        : Cloud;

  return (
    <button
      onClick={() => router.push('/sync')}
      title="Offline & sync status — open Sync Center"
      className={`flex items-center gap-1.5 h-8 px-2.5 rounded-lg border text-xs font-medium transition-colors ${cls}`}
    >
      <Icon className={`w-3.5 h-3.5 ${engine.running ? 'animate-spin' : ''}`} />
      <span className="hidden sm:inline">{label}</span>
      {queued > 0 && (
        <span className="min-w-[16px] h-4 px-1 rounded-full bg-white/70 text-[10px] font-bold flex items-center justify-center">
          {queued > 99 ? '99+' : queued}
        </span>
      )}
    </button>
  );
}
