'use client';

/**
 * Sync Center — the offline cockpit.
 *
 * Shows connectivity + sync state, everything queued/pending (in order),
 * conflicts with the server's row for side-by-side resolution, failed items
 * with the server error, recently synced results (e.g. the real invoice
 * number assigned to an offline POS order), and the local-security posture
 * (at-rest encryption status, sign-out wipes local data).
 */

import { useCallback, useEffect, useState } from 'react';
import {
  RefreshCw, CloudOff, Cloud, AlertTriangle, CheckCircle2, Clock,
  ShieldCheck, Trash2, RotateCcw, ArrowRightLeft, XCircle, Loader2,
} from 'lucide-react';
import { useOffline } from '@/lib/offline/provider';
import {
  listOutbox, unsealPayload, unsealServerResult, unsealConflictData,
  resolveConflictOverwrite, resolveConflictKeepServer, retryFailedItem,
  discardItem, clearResolvedItems,
} from '@/lib/offline/outbox';
import type { OutboxItem } from '@/lib/offline/db';
import { replicaStatus, replicateAll, type ReplicaStatus } from '@/lib/offline/replica';
import { getWarmStatus, runWarm, type WarmStatus } from '@/lib/offline/warm';
import { Database, FileBarChart, RefreshCw as RefreshIcon } from 'lucide-react';
import InstallCard from '@/components/pwa/InstallCard';
import StorageBackupCard from '@/components/offline/StorageBackupCard';

const OP_LABELS: Record<string, string> = {
  'invoice.create': 'POS sale',
  'product.create': 'New product',
  'product.update': 'Product edit',
  'customer.create': 'New customer',
  'customer.update': 'Customer edit',
  'employee.create': 'New employee',
  'employee.update': 'Employee edit',
  'attendance.mark': 'Attendance mark',
  'attendance.details': 'Attendance details',
};

function opLabel(op: string): string {
  return OP_LABELS[op] ?? op;
}

function timeAgo(ts: number | null): string {
  if (!ts) return 'never';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function SyncCenterPage() {
  const { online, engine, counts, syncNow, refreshCounts } = useOffline();
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [replica, setReplica] = useState<ReplicaStatus | null>(null);
  const [warm, setWarm] = useState<WarmStatus | null>(null);

  const refresh = useCallback(() => {
    void listOutbox().then(setItems);
    void replicaStatus().then(setReplica);
    void getWarmStatus().then(setWarm);
    refreshCounts();
  }, [refreshCounts]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  async function act(id: string, fn: (item: OutboxItem) => Promise<void>) {
    setBusy(id);
    try {
      const item = items.find((i) => i.id === id);
      if (item) await fn(item);
      refresh();
    } finally {
      setBusy(null);
    }
  }

  const pending = items.filter((i) => i.status === 'pending' || i.status === 'syncing');
  const conflicts = items.filter((i) => i.status === 'conflict');
  const failed = items.filter((i) => i.status === 'failed');
  const synced = items.filter((i) => i.status === 'synced').slice(0, 25);

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Sync Center</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Offline changes, conflict resolution and sync status
          </p>
        </div>
        <button
          onClick={syncNow}
          disabled={engine.running || !online}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition disabled:opacity-60"
        >
          <RefreshCw className={`w-4 h-4 ${engine.running ? 'animate-spin' : ''}`} />
          {engine.running ? 'Syncing…' : 'Sync now'}
        </button>
      </div>

      {/* Status cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="stat-card flex items-center gap-3">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center ${online ? 'bg-emerald-50' : 'bg-amber-50'}`}>
            {online ? <Cloud className="w-5 h-5 text-emerald-500" /> : <CloudOff className="w-5 h-5 text-amber-500" />}
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Connection</p>
            <p className="text-lg font-bold text-foreground">{online ? 'Online' : 'Offline'}</p>
          </div>
        </div>
        <div className="stat-card flex items-center gap-3">
          <div className="w-10 h-10 bg-blue-50 rounded-full flex items-center justify-center">
            <Clock className="w-5 h-5 text-blue-500" />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Last sync</p>
            <p className="text-lg font-bold text-foreground">{timeAgo(engine.lastSyncAt)}</p>
          </div>
        </div>
        <div className="stat-card flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-50 rounded-full flex items-center justify-center">
            <ArrowRightLeft className="w-5 h-5 text-indigo-500" />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Waiting to sync</p>
            <p className="text-lg font-bold text-foreground">{counts.pending + counts.syncing}</p>
          </div>
        </div>
        <div className="stat-card flex items-center gap-3">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center ${counts.conflict + counts.failed > 0 ? 'bg-red-50' : 'bg-emerald-50'}`}>
            <AlertTriangle className={`w-5 h-5 ${counts.conflict + counts.failed > 0 ? 'text-red-500' : 'text-emerald-500'}`} />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Needs attention</p>
            <p className="text-lg font-bold text-foreground">{counts.conflict + counts.failed}</p>
          </div>
        </div>
      </div>

      {engine.notice && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-4 py-3 text-sm flex items-center gap-2">
          <CloudOff className="w-4 h-4 shrink-0" /> {engine.notice}
        </div>
      )}

      {engine.lastError && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">
          Last sync error: {engine.lastError}
        </div>
      )}

      {/* Conflicts */}
      {conflicts.length > 0 && (
        <section className="bg-white rounded-xl border border-red-200 p-4 shadow-sm">
          <h2 className="text-sm font-bold text-foreground mb-1 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-500" /> Conflicts ({conflicts.length})
          </h2>
          <p className="text-xs text-muted-foreground mb-3">
            These records changed on the server after your offline edit was captured. Compare and choose which version to keep.
          </p>
          <div className="space-y-3">
            {conflicts.map(item => (
              <ConflictCard key={item.id} item={item} busy={busy === item.id}
                onOverwrite={() => act(item.id, resolveConflictOverwrite)}
                onKeepServer={() => act(item.id, resolveConflictKeepServer)} />
            ))}
          </div>
        </section>
      )}

      {/* Failed */}
      {failed.length > 0 && (
        <section className="bg-white rounded-xl border border-orange-200 p-4 shadow-sm">
          <h2 className="text-sm font-bold text-foreground mb-1 flex items-center gap-2">
            <XCircle className="w-4 h-4 text-orange-500" /> Failed after retries ({failed.length})
          </h2>
          <div className="space-y-2">
            {failed.map(item => (
              <div key={item.id} className="flex items-center gap-3 border border-border rounded-lg px-3 py-2 text-sm">
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{item.label}</p>
                  <p className="text-xs text-red-600 truncate">{opLabel(item.op)} — {item.lastError}</p>
                </div>
                <button onClick={() => act(item.id, retryFailedItem)} disabled={busy === item.id}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-border rounded-lg hover:bg-muted transition">
                  <RotateCcw className="w-3.5 h-3.5" /> Retry
                </button>
                <button onClick={() => act(item.id, discardItem)} disabled={busy === item.id}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-red-200 text-red-600 rounded-lg hover:bg-red-50 transition">
                  <Trash2 className="w-3.5 h-3.5" /> Discard
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Pending queue */}
      <section className="bg-white rounded-xl border border-border p-4 shadow-sm">
        <h2 className="text-sm font-bold text-foreground mb-3 flex items-center gap-2">
          <Clock className="w-4 h-4 text-indigo-500" /> Queue ({pending.length})
          <span className="text-xs font-normal text-muted-foreground">— applied in order when a connection returns</span>
        </h2>
        {pending.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">Nothing queued. Offline changes you make will appear here.</p>
        ) : (
          <div className="space-y-2">
            {pending.map((item, idx) => (
              <div key={item.id} className="flex items-center gap-3 border border-border rounded-lg px-3 py-2 text-sm">
                <span className="text-xs text-muted-foreground w-5">#{idx + 1}</span>
                {item.status === 'syncing'
                  ? <Loader2 className="w-4 h-4 text-blue-500 animate-spin shrink-0" />
                  : <Clock className="w-4 h-4 text-indigo-400 shrink-0" />}
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{item.label}</p>
                  <p className="text-xs text-muted-foreground">{opLabel(item.op)} · queued {timeAgo(item.createdAt)}</p>
                </div>
                <button onClick={() => act(item.id, discardItem)} disabled={busy === item.id}
                  className="text-xs text-muted-foreground hover:text-red-600 px-2 py-1 transition" title="Discard this change">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Recently synced */}
      <section className="bg-white rounded-xl border border-border p-4 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold text-foreground flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-500" /> Recently synced ({counts.synced})
          </h2>
          {counts.synced + counts.discarded > 0 && (
            <button onClick={() => { void clearResolvedItems().then(refresh); }}
              disabled={busy !== null}
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1.5 px-2 py-1 transition">
              <Trash2 className="w-3.5 h-3.5" /> Clear history
            </button>
          )}
        </div>
        {synced.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No synced items yet.</p>
        ) : (
          <div className="space-y-2">
            {synced.map(item => <SyncedRow key={item.id} item={item} />)}
          </div>
        )}
      </section>

      {/* Local database */}
      <section className="bg-white rounded-xl border border-border p-4 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold text-foreground flex items-center gap-2">
            <Database className="w-4 h-4 text-indigo-500" /> Local Database
            <span className="text-xs font-normal text-muted-foreground">
              — full encrypted copies of all core tables, refreshed every 15 minutes while online
            </span>
          </h2>
          <button
            onClick={() => { void replicateAll(true).then(refresh); }}
            disabled={!online || (replica?.replicating ?? false)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-border rounded-lg hover:bg-muted transition disabled:opacity-50"
          >
            <RefreshIcon className={`w-3.5 h-3.5 ${replica?.replicating ? 'animate-spin' : ''}`} />
            {replica?.replicating ? 'Refreshing…' : 'Refresh now'}
          </button>
        </div>
        {replica && replica.lastFullSync ? (
          <>
            <p className="text-xs text-muted-foreground mb-2">
              Last full refresh {timeAgo(replica.lastFullSync)}
              {replica.tables.reduce((s, t) => s + t.count, 0) > 0 &&
                ` · ${replica.tables.reduce((s, t) => s + t.count, 0).toLocaleString()} rows on this device`}
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
              {replica.tables.map(t => (
                <div key={t.name} className="border border-border rounded-lg px-3 py-2">
                  <p className="text-xs text-muted-foreground truncate">{t.name}</p>
                  <p className="text-lg font-bold text-foreground">{t.count.toLocaleString()}</p>
                  <p className="text-[10px] text-muted-foreground">{t.lastSync ? timeAgo(t.lastSync) : 'never'}</p>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground py-4 text-center">
            {online
              ? 'Building the local database… the first refresh runs automatically.'
              : 'Offline — the local database will refresh when you reconnect.'}
          </p>
        )}
      </section>

      {/* Pre-warmed report views */}
      <section className="bg-white rounded-xl border border-border p-4 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold text-foreground flex items-center gap-2">
            <FileBarChart className="w-4 h-4 text-amber-500" /> Offline Reports
            <span className="text-xs font-normal text-muted-foreground">
              — report pages (P&amp;L, trial balance, aging, balance sheet) compute on the server; their default views are saved here automatically
            </span>
          </h2>
          <button
            onClick={() => { void runWarm(true).then(() => refresh()); }}
            disabled={!online || (warm?.running ?? false)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-border rounded-lg hover:bg-muted transition disabled:opacity-50"
          >
            <RefreshIcon className={`w-3.5 h-3.5 ${warm?.running ? 'animate-spin' : ''}`} />
            {warm?.running ? 'Preparing…' : 'Prepare now'}
          </button>
        </div>
        {warm && warm.lastRun ? (
          <p className="text-xs text-muted-foreground">
            Report views prepared {timeAgo(warm.lastRun)}
            {warm.calls !== null && ` · ${warm.calls.toLocaleString()} queries saved`}
            {warm.failures ? ` · ${warm.failures} failed` : ''}
            {' '}— runs automatically after each database refresh. Changing a period or filter offline still needs one online visit of that view.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground py-2 text-center">
            {online
              ? 'Preparing report views… the first run follows the database refresh above.'
              : 'Offline — report views prepare automatically when you reconnect.'}
          </p>
        )}
      </section>

      {/* Storage persistence + encrypted backup file */}
      <StorageBackupCard />

      {/* Install as app */}
      <InstallCard />

      {/* Security card */}
      <section className="bg-white rounded-xl border border-border p-4 shadow-sm">
        <h2 className="text-sm font-bold text-foreground mb-2 flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-emerald-500" /> Local data security
        </h2>
        <ul className="text-xs text-muted-foreground space-y-1.5">
          <li>• The local database, cached page data and queued changes are all encrypted at rest with AES-256-GCM; the key is a non-extractable CryptoKey held in IndexedDB.</li>
          <li>• The app requests persistent storage so the browser won&apos;t evict the local database under disk pressure — the storage card above shows whether this browser granted it.</li>
          <li>• The entire local database can be exported to a passphrase-encrypted .sibak file (AES-256-GCM via PBKDF2) and restored on any device — treat the file like a database dump: it holds all business data.</li>
          <li>• Sync traffic uses the same authenticated TLS channel as the rest of the app.</li>
          <li>• Signing out wipes the local database, cache, sync queue and encryption key from this device.</li>
          <li>• Each queued change carries a unique id the server remembers, so a repeated sync can never double-apply it.</li>
        </ul>
      </section>
    </div>
  );
}

function ConflictCard({ item, busy, onOverwrite, onKeepServer }: {
  item: OutboxItem;
  busy: boolean;
  onOverwrite: () => void;
  onKeepServer: () => void;
}) {
  const [local, setLocal] = useState<Record<string, unknown> | null>(null);
  const [server, setServer] = useState<{ reason?: string; server_row?: Record<string, unknown> } | null>(null);

  useEffect(() => {
    void unsealPayload<Record<string, unknown>>(item).then(setLocal).catch(() => setLocal(null));
    void unsealConflictData<{ reason?: string; server_row?: Record<string, unknown> }>(item).then(setServer).catch(() => setServer(null));
  }, [item]);

  const serverRow = server?.server_row ?? null;
  const localData = (local?.data ?? local) as Record<string, unknown> | null;
  const changed = serverRow && localData
    ? Object.keys(localData)
        .filter((k) => k !== 'expected_updated_at' && k !== 'force')
        .filter((k) => JSON.stringify((localData as Record<string, unknown>)[k]) !== JSON.stringify((serverRow as Record<string, unknown>)[k]))
    : [];

  return (
    <div className="border border-red-200 rounded-lg p-3">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold truncate">{item.label}</p>
          <p className="text-xs text-muted-foreground">{opLabel(item.op)} · {server?.reason === 'missing' ? 'record no longer exists on the server' : 'changed on the server since your snapshot'}</p>
        </div>
      </div>
      {changed.length > 0 && (
        <div className="grid grid-cols-2 gap-2 text-xs mb-2">
          <div className="bg-blue-50 border border-blue-100 rounded-lg p-2">
            <p className="font-semibold text-blue-700 mb-1">Your version</p>
            {changed.map((k) => (
              <div key={k} className="flex justify-between gap-2">
                <span className="text-muted-foreground">{k}</span>
                <span className="font-medium truncate max-w-[140px]">{String((localData as Record<string, unknown>)[k])}</span>
              </div>
            ))}
          </div>
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-2">
            <p className="font-semibold text-slate-700 mb-1">Server version</p>
            {changed.map((k) => (
              <div key={k} className="flex justify-between gap-2">
                <span className="text-muted-foreground">{k}</span>
                <span className="font-medium truncate max-w-[140px]">{String((serverRow as Record<string, unknown>)[k])}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="flex gap-2">
        <button onClick={onKeepServer} disabled={busy}
          className="flex-1 px-3 py-1.5 text-xs border border-border rounded-lg hover:bg-muted transition">
          Keep server version
        </button>
        <button onClick={onOverwrite} disabled={busy}
          className="flex-1 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition disabled:opacity-60">
          Overwrite server with mine
        </button>
      </div>
    </div>
  );
}

function SyncedRow({ item }: { item: OutboxItem }) {
  const [result, setResult] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    void unsealServerResult<Record<string, unknown>>(item).then(setResult).catch(() => setResult(null));
  }, [item]);

  const detail = result
    ? [
        result.invoice_number ? `assigned ${String(result.invoice_number)}` : null,
        result.payment_number ? `payment ${String(result.payment_number)}` : null,
        result.code ? `code ${String(result.code)}` : null,
      ].filter(Boolean).join(' · ')
    : null;

  return (
    <div className="flex items-center gap-3 border border-border rounded-lg px-3 py-2 text-sm">
      <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="font-medium truncate">{item.label}</p>
        <p className="text-xs text-muted-foreground">
          {opLabel(item.op)} · synced {timeAgo(item.syncedAt ?? item.updatedAt)}
          {detail ? ` · ${detail}` : ''}
        </p>
      </div>
    </div>
  );
}
