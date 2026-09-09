'use client';

/**
 * Slim banner rendered under the Header whenever the app is offline or has
 * items waiting to sync. Keeps offline state impossible to miss without
 * blocking any interaction.
 */

import Link from 'next/link';
import { CloudOff, RefreshCw, AlertTriangle } from 'lucide-react';
import { useOffline } from '@/lib/offline/provider';

export default function OfflineBanner() {
  const { online, engine, counts } = useOffline();
  const waiting = counts.pending + counts.syncing;
  const attention = counts.conflict + counts.failed;

  if (online && waiting === 0 && !engine.running && attention === 0) return null;

  if (online && attention === 0 && !engine.running) return null;

  return (
    <div
      className={`flex items-center gap-2 px-4 py-1.5 text-xs font-medium border-b ${
        !online
          ? 'bg-amber-50 text-amber-800 border-amber-200'
          : engine.running
            ? 'bg-blue-50 text-blue-800 border-blue-200'
            : 'bg-red-50 text-red-800 border-red-200'
      }`}
    >
      {!online ? (
        <CloudOff className="w-3.5 h-3.5 shrink-0" />
      ) : engine.running ? (
        <RefreshCw className="w-3.5 h-3.5 shrink-0 animate-spin" />
      ) : (
        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
      )}
      <span className="truncate">
        {!online
          ? `Offline — working from cached data.${waiting > 0 ? ` ${waiting} change${waiting > 1 ? 's' : ''} queued for sync.` : ''}`
          : engine.running
            ? 'Syncing queued changes with the server…'
            : `Sync needs attention: ${counts.conflict} conflict${counts.conflict === 1 ? '' : 's'}, ${counts.failed} failed.`}
      </span>
      <Link
        href="/sync"
        className={`ml-auto shrink-0 underline underline-offset-2 ${
          !online ? 'hover:text-amber-900' : engine.running ? 'hover:text-blue-900' : 'hover:text-red-900'
        }`}
      >
        Open Sync Center
      </Link>
    </div>
  );
}
