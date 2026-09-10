'use client';

/**
 * Sync Center card: local storage health + encrypted backup/restore.
 *
 * - Persistence: shows whether the browser has granted persistent storage
 *   (non-evictable) and lets the user re-request it.
 * - Quota: usage vs the browser's grant, from navigator.storage.estimate().
 * - Backup: export the entire local database to a passphrase-encrypted
 *   .sibak file on disk, and restore it (this device or a new one).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  HardDrive, ShieldCheck, AlertTriangle, Download, Upload, Loader2, KeyRound, X,
} from 'lucide-react';
import {
  getStorageStatus, requestPersistentStorage, type StorageStatus,
} from '@/lib/offline/persistence';
import { exportBackupFile, importBackup, BackupUserMismatchError } from '@/lib/offline/backup';
import { getMeta } from '@/lib/offline/db';
import { useOffline } from '@/lib/offline/provider';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function timeAgo(ts: number | null): string {
  if (!ts) return 'never';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

type Message = { kind: 'ok' | 'err'; text: string } | null;

export default function StorageBackupCard() {
  const { counts } = useOffline();
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [lastExport, setLastExport] = useState<number | null>(null);
  const [busy, setBusy] = useState<'persist' | 'export' | 'restore' | null>(null);
  const [modal, setModal] = useState<'export' | 'restore' | null>(null);
  const [message, setMessage] = useState<Message>(null);

  const refresh = useCallback(() => {
    void getStorageStatus().then(setStatus);
    void getMeta<number>('backup:last_export').then(v => setLastExport(v ?? null));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function onRequestPersistence() {
    setBusy('persist');
    try {
      const granted = await requestPersistentStorage();
      if (granted) setMessage({ kind: 'ok', text: 'Storage is now persistent — the browser will not evict the local database.' });
      else setMessage({ kind: 'err', text: 'The browser declined persistent storage. Installed PWAs and regularly-used sites are usually granted it — try again after installing the app.' });
    } finally {
      setBusy(null);
      refresh();
    }
  }

  const queuedCount = counts.pending + counts.syncing + counts.conflict + counts.failed;

  return (
    <>
      <section className="bg-white rounded-xl border border-border p-4 shadow-sm">
        <h2 className="text-sm font-bold text-foreground flex items-center gap-2">
          <HardDrive className="w-4 h-4 text-indigo-500" /> Local storage &amp; backup
          <span className="text-xs font-normal text-muted-foreground">
            — persistence, quota and the encrypted backup file
          </span>
        </h2>

        <div className="grid sm:grid-cols-2 gap-4 mt-3">
          {/* Persistence */}
          <div className="border border-border rounded-lg px-3 py-2.5">
            <p className="text-xs text-muted-foreground mb-1.5">Eviction protection</p>
            {status === null ? (
              <p className="text-sm text-muted-foreground">Checking…</p>
            ) : !status.supported ? (
              <div>
                <p className="text-sm font-semibold text-amber-600 flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4" /> Best-effort storage
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  This browser (Safari) doesn&apos;t honor persistence requests — export a backup file to be safe.
                </p>
              </div>
            ) : status.persisted ? (
              <p className="text-sm font-semibold text-emerald-600 flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4" /> Persistent
              </p>
            ) : (
              <div>
                <p className="text-sm font-semibold text-amber-600 flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4" /> Not persistent yet
                </p>
                <p className="text-xs text-muted-foreground mt-1">The browser may evict this data under disk pressure.</p>
                <button
                  onClick={onRequestPersistence}
                  disabled={busy !== null}
                  className="mt-2 flex items-center gap-1.5 px-3 py-1.5 text-xs border border-border rounded-lg hover:bg-muted transition disabled:opacity-50"
                >
                  {busy === 'persist' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                  Request persistence
                </button>
              </div>
            )}
          </div>

          {/* Quota */}
          <div className="border border-border rounded-lg px-3 py-2.5">
            <p className="text-xs text-muted-foreground mb-1.5">Storage used</p>
            {status?.usage != null && status?.quota != null && status.quota > 0 ? (
              <>
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${status.usage / status.quota > 0.8 ? 'bg-red-500' : 'bg-emerald-500'}`}
                    style={{ width: `${Math.min(100, (status.usage / status.quota) * 100)}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground mt-1.5">
                  {formatBytes(status.usage)} of {formatBytes(status.quota)} available
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Quota unknown in this browser.</p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 mt-4 pt-3 border-t border-border">
          <p className="text-xs text-muted-foreground flex-1 min-w-[180px]">
            Last backup exported: <span className="font-medium text-foreground">{timeAgo(lastExport)}</span>
          </p>
          <button
            onClick={() => setModal('export')}
            disabled={busy !== null}
            className="flex items-center gap-1.5 px-3 py-2 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-semibold transition disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" /> Export encrypted backup
          </button>
          <button
            onClick={() => setModal('restore')}
            disabled={busy !== null}
            className="flex items-center gap-1.5 px-3 py-2 text-xs border border-border rounded-lg hover:bg-muted transition disabled:opacity-50"
          >
            <Upload className="w-3.5 h-3.5" /> Restore from backup
          </button>
        </div>

        {message && (
          <p className={`mt-3 text-xs rounded-lg px-3 py-2 ${
            message.kind === 'ok' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
          }`}>
            {message.text}
          </p>
        )}
      </section>

      {modal === 'export' && (
        <ExportModal
          queuedCount={queuedCount}
          onClose={() => setModal(null)}
          onDone={(filename) => {
            setModal(null);
            setMessage({
              kind: 'ok',
              text: `Backup saved: ${filename}. It is in your Downloads folder — move it somewhere safe. It holds all business data and opens only with your passphrase.`,
            });
            refresh();
          }}
        />
      )}
      {modal === 'restore' && (
        <RestoreModal
          onClose={() => setModal(null)}
          onDone={(summary) => {
            setModal(null);
            setMessage({
              kind: 'ok',
              text: `Restored ${summary.rowsImported.toLocaleString()} rows${summary.sameUser
                ? ` · ${summary.outboxImported} queued change${summary.outboxImported === 1 ? '' : 's'} imported`
                : ' (read-only replica — the backup belongs to another account)'}. Refreshing from server…`,
            });
            refresh();
          }}
        />
      )}
    </>
  );
}

function ExportModal({ queuedCount, onClose, onDone }: {
  queuedCount: number;
  onClose: () => void;
  onDone: (filename: string) => void;
}) {
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const valid = pass.length >= 8 && pass === confirm;

  async function submit() {
    if (!valid || working) return;
    setWorking(true);
    setErr(null);
    try {
      const filename = await exportBackupFile(pass);
      onDone(filename);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[120] p-4">
      <div className="bg-white rounded-xl w-full max-w-md shadow-2xl">
        <div className="flex items-start gap-3 px-5 py-4 border-b border-border">
          <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
            <KeyRound className="w-5 h-5 text-blue-500" />
          </div>
          <div className="flex-1">
            <h3 className="text-base font-bold text-foreground">Export encrypted backup</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              One file with the full local database — all replica tables, cached pages and queued changes — sealed with your passphrase.
            </p>
          </div>
          <button onClick={onClose} disabled={working} className="text-muted-foreground hover:text-foreground transition p-1">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-5 py-4 space-y-3">
          {queuedCount > 0 && (
            <div className="bg-amber-50 border border-amber-200 text-amber-700 rounded-lg px-3 py-2 text-xs">
              {queuedCount} queued change{queuedCount === 1 ? '' : 's'} will be included in the file and re-imported on restore.
            </div>
          )}
          <div>
            <label className="text-xs font-medium text-foreground">Passphrase</label>
            <input
              type="password" value={pass} onChange={e => setPass(e.target.value)} disabled={working}
              autoComplete="new-password"
              className="mt-1 w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="At least 8 characters"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-foreground">Confirm passphrase</label>
            <input
              type="password" value={confirm} onChange={e => setConfirm(e.target.value)} disabled={working}
              autoComplete="new-password"
              className="mt-1 w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              onKeyDown={e => { if (e.key === 'Enter') void submit(); }}
            />
          </div>
          {pass.length > 0 && pass.length < 8 && <p className="text-xs text-amber-600">Passphrase must be at least 8 characters.</p>}
          {confirm.length > 0 && pass !== confirm && <p className="text-xs text-red-600">Passphrases don&apos;t match.</p>}
          {err && <p className="text-xs text-red-600">{err}</p>}
          <p className="text-xs text-muted-foreground">
            The passphrase cannot be recovered. If you forget it, the backup cannot be opened.
          </p>
        </div>
        <div className="flex gap-2 px-5 py-4 border-t border-border">
          <button
            onClick={onClose} disabled={working}
            className="flex-1 py-2.5 px-4 rounded-lg border border-border text-sm font-medium text-foreground hover:bg-muted transition disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => void submit()} disabled={!valid || working}
            className="flex-1 py-2.5 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold transition disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {working ? <><Loader2 className="w-4 h-4 animate-spin" /> Encrypting…</> : 'Export backup'}
          </button>
        </div>
      </div>
    </div>
  );
}

function RestoreModal({ onClose, onDone }: {
  onClose: () => void;
  onDone: (summary: { rowsImported: number; outboxImported: number; sameUser: boolean }) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [pass, setPass] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState<string | null>(null); // backup's userId when it belongs to another account
  const [working, setWorking] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function submit() {
    if (!file || !pass || working) return;
    setWorking(true);
    setErr(null);
    try {
      const summary = await importBackup(file, pass, { allowDifferentUser: mismatch !== null });
      onDone(summary);
    } catch (e) {
      if (e instanceof BackupUserMismatchError) {
        setMismatch(e.backupUserId);
      } else {
        setErr(e instanceof Error ? e.message : 'Restore failed');
      }
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[120] p-4">
      <div className="bg-white rounded-xl w-full max-w-md shadow-2xl">
        <div className="flex items-start gap-3 px-5 py-4 border-b border-border">
          <div className="w-10 h-10 rounded-full bg-indigo-50 flex items-center justify-center shrink-0">
            <Upload className="w-5 h-5 text-indigo-500" />
          </div>
          <div className="flex-1">
            <h3 className="text-base font-bold text-foreground">Restore from backup</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Replaces the local database on this device with the file&apos;s contents.
            </p>
          </div>
          <button onClick={onClose} disabled={working} className="text-muted-foreground hover:text-foreground transition p-1">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div>
            <label className="text-xs font-medium text-foreground">Backup file (.sibak)</label>
            <input
              ref={fileRef}
              type="file" accept=".sibak,application/json" disabled={working}
              onChange={e => { setFile(e.target.files?.[0] ?? null); setMismatch(null); setErr(null); }}
              className="mt-1 w-full text-sm border border-border rounded-lg px-3 py-2 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:bg-muted file:text-foreground file:text-xs"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-foreground">Passphrase</label>
            <input
              type="password" value={pass} onChange={e => setPass(e.target.value)} disabled={working}
              autoComplete="off"
              className="mt-1 w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              onKeyDown={e => { if (e.key === 'Enter') void submit(); }}
            />
          </div>
          {mismatch && (
            <div className="bg-amber-50 border border-amber-200 text-amber-700 rounded-lg px-3 py-2 text-xs">
              This backup was exported by a different user account. Only the read-only replica can be restored —
              cached pages and queued changes stay as they are on this device. Continue?
            </div>
          )}
          {err && <p className="text-xs text-red-600">{err}</p>}
          <p className="text-xs text-muted-foreground">
            A fresh replication runs right after the restore — the server stays the source of truth.
            Queued changes that hadn&apos;t synced yet are imported and will sync normally.
          </p>
        </div>
        <div className="flex gap-2 px-5 py-4 border-t border-border">
          <button
            onClick={onClose} disabled={working}
            className="flex-1 py-2.5 px-4 rounded-lg border border-border text-sm font-medium text-foreground hover:bg-muted transition disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => void submit()} disabled={!file || !pass || working}
            className="flex-1 py-2.5 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold transition disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {working ? <><Loader2 className="w-4 h-4 animate-spin" /> Restoring…</> : mismatch ? 'Restore replica only' : 'Restore backup'}
          </button>
        </div>
      </div>
    </div>
  );
}
