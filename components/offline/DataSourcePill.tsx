'use client';

/**
 * "Where is this page's data coming from?" pill — and what this device has
 * written.
 *
 * Three sources feed a page and they look identical once rendered:
 *   - the online database (a live PostgREST response)
 *   - the local database on this device (the encrypted replica)
 *   - a cached snapshot taken earlier (the page-level cache)
 *
 * The pill names the highest-priority source the CURRENT page has actually
 * used, and the popover breaks the page's reads down by source. Provenance is
 * recorded by the read paths themselves (lib/offline/data-source), so pages do
 * not have to opt in — every page in the shell reports it.
 *
 * The same popover carries the write lifecycle (lib/offline/write-status). A
 * save has two facts worth stating — the server has it, and this device's copy
 * has caught up — but announcing them in a banner on every save is noise. Here
 * they are a count that runs down to zero in the corner of the pill, with the
 * per-write detail one click away.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { usePathname, useRouter } from 'next/navigation';
import {
  Archive,
  CheckCircle2,
  ChevronDown,
  CloudOff,
  CloudUpload,
  Database,
  HardDrive,
  HardDriveDownload,
  Loader2,
  RefreshCw,
  ShieldQuestion,
  TriangleAlert,
  X,
} from 'lucide-react';
import {
  getDataSourceSnapshot,
  subscribeDataSource,
  syncDataSourcePage,
  type DataSourceKind,
} from '@/lib/offline/data-source';
import {
  dismissWrite,
  getWriteState,
  subscribeWriteState,
  type WriteActivity,
  type WritePhase,
} from '@/lib/offline/write-status';
import { useOffline } from '@/lib/offline/provider';

interface SourceMeta {
  label: string;
  short: string;
  icon: typeof Database;
  dot: string;
  pill: string;
  row: string;
}

const SOURCE_META: Record<DataSourceKind, SourceMeta> = {
  server: {
    label: 'Online database',
    short: 'Live database',
    icon: Database,
    dot: 'bg-emerald-500',
    pill: 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100',
    row: 'text-emerald-700',
  },
  replica: {
    label: 'Local database on this device',
    short: 'Local database',
    icon: HardDrive,
    dot: 'bg-blue-500',
    pill: 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100',
    row: 'text-blue-700',
  },
  cache: {
    label: 'Cached snapshot',
    short: 'Cached data',
    icon: Archive,
    dot: 'bg-amber-500',
    pill: 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100',
    row: 'text-amber-700',
  },
  none: {
    label: 'Nothing loaded yet',
    short: 'No data yet',
    icon: ShieldQuestion,
    dot: 'bg-slate-400',
    pill: 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100',
    row: 'text-slate-600',
  },
};

interface WriteCopy {
  text: string;
  icon: typeof CheckCircle2;
  tone: string;
  spin?: boolean;
}

const WRITE_COPY: Record<WritePhase, WriteCopy> = {
  saving: { text: 'Saving to server…', icon: Loader2, tone: 'text-blue-600', spin: true },
  committed: { text: 'Server saved · updating device copy', icon: CloudUpload, tone: 'text-blue-600' },
  synced: { text: 'Saved on server and device', icon: CheckCircle2, tone: 'text-emerald-600' },
  deferred: { text: 'Server saved · device copy pending', icon: HardDriveDownload, tone: 'text-amber-600' },
  queued: { text: 'Saved on device · waiting to sync', icon: HardDriveDownload, tone: 'text-amber-600' },
  failed: { text: 'Not saved', icon: TriangleAlert, tone: 'text-red-600' },
};

/** RPC names a cashier would recognise; everything else is humanised. */
const RPC_LABELS: Record<string, string> = {
  receive_grn: 'Goods receipt',
  create_opening_batch: 'Opening stock',
  create_stock_reduction: 'Stock reduction',
  sync_stock_adjustment: 'Stock adjustment',
};

function humanise(value: string): string {
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function writeTitle(activity: WriteActivity): string {
  if (activity.label) return activity.label;
  if (activity.target === 'outbox') return 'Offline change';
  if (activity.target.startsWith('rpc ')) {
    const name = activity.target.slice(4);
    return RPC_LABELS[name] ?? humanise(name);
  }
  return humanise(activity.target);
}

function ago(ts: number | undefined, now: number): string {
  if (!ts) return 'not yet';
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 3) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

export default function DataSourcePill() {
  const router = useRouter();
  const pathname = usePathname();
  const { online } = useOffline();
  const sources = useSyncExternalStore(
    subscribeDataSource,
    getDataSourceSnapshot,
    getDataSourceSnapshot,
  );
  const writes = useSyncExternalStore(subscribeWriteState, getWriteState, getWriteState);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // A page that reads nothing would otherwise sit on "Reading…" forever.
  const [settled, setSettled] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  /**
   * The popover is portaled to <body> and positioned from the button's rect.
   *
   * The header is `sticky z-30`, which makes it a stacking context: a child's
   * `z-50` is capped at the header's own level, so the POS cart — a later
   * sibling in the page — painted straight over the panel. The header's search
   * dropdown solves the same problem the same way.
   */
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(
    null,
  );

  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const measure = () => {
      const el = buttonRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const width = Math.min(320, window.innerWidth - 16);
      const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
      const top = rect.bottom + 6;
      setPos({ top, left, width, maxHeight: Math.max(200, window.innerHeight - top - 12) });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open]);

  // Provenance is keyed by pathname inside the store; this just swaps the
  // visible snapshot to the route the user is on.
  useEffect(() => {
    syncDataSourcePage();
    setSettled(false);
    const timer = setTimeout(() => setSettled(true), 2_500);
    return () => clearTimeout(timer);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, [open]);

  const primary = sources.primary;
  const meta = SOURCE_META[primary ?? 'none'];

  const label = !online
    ? primary === 'replica'
      ? 'Offline · local data'
      : primary === 'cache'
        ? 'Offline · cached data'
        : 'Offline'
    : primary === null
      ? settled
        ? 'No data yet'
        : 'Reading…'
      : meta.short;

  const Icon = !online ? CloudOff : meta.icon;
  const pillClass = !online
    ? 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
    : primary === null
      ? SOURCE_META.none.pill
      : meta.pill;

  const rows: DataSourceKind[] = ['server', 'replica', 'cache'];

  const justSaved =
    writes.pending === 0 &&
    writes.failed === 0 &&
    writes.queued === 0 &&
    writes.items.some((item) => item.phase === 'synced');

  const summary =
    writes.failed > 0
      ? `${writes.failed} failed`
      : writes.pending > 0
        ? `${writes.pending} in progress`
        : writes.queued > 0
          ? `${writes.queued} queued`
          : justSaved
            ? 'All saved'
            : 'Idle';

  const summaryTone =
    writes.failed > 0
      ? 'text-red-600'
      : writes.pending > 0
        ? 'text-blue-600'
        : writes.queued > 0
          ? 'text-amber-600'
          : justSaved
            ? 'text-emerald-600'
            : 'text-muted-foreground';

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`Data source for this page: ${!online ? 'offline' : meta.label}${
          writes.pending > 0 ? ` · ${writes.pending} change${writes.pending === 1 ? '' : 's'} saving` : ''
        }`}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`flex items-center gap-1.5 h-8 px-2.5 rounded-lg border text-xs font-medium transition-colors ${pillClass}`}
      >
        <Icon className="w-3.5 h-3.5" />
        <span className="hidden md:inline">{label}</span>
        {writes.pending > 0 ? (
          <span
            aria-label={`${writes.pending} change${writes.pending === 1 ? '' : 's'} saving`}
            className="inline-flex items-center gap-0.5 rounded-full bg-white/80 px-1.5 py-px text-[10px] font-bold text-blue-700"
          >
            <Loader2 className="w-3 h-3 animate-spin" />
            {writes.pending}
          </span>
        ) : writes.failed > 0 ? (
          <span
            aria-label={`${writes.failed} change${writes.failed === 1 ? '' : 's'} failed`}
            className="inline-flex items-center gap-0.5 rounded-full bg-red-600 px-1.5 py-px text-[10px] font-bold text-white"
          >
            <TriangleAlert className="w-3 h-3" />
            {writes.failed}
          </span>
        ) : justSaved ? (
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" aria-hidden />
        ) : null}
        <ChevronDown className={`w-3 h-3 hidden md:block transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open &&
        pos &&
        typeof document !== 'undefined' &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[60]" onClick={() => setOpen(false)} />
            <div
              role="dialog"
              aria-label="Data sources and writes for this page"
              style={{
                position: 'fixed',
                top: pos.top,
                left: pos.left,
                width: pos.width,
                maxHeight: pos.maxHeight,
              }}
              className="overflow-y-auto bg-white border border-border rounded-xl shadow-xl z-[70] animate-fade-in"
            >
              <div className="px-3.5 pt-3 pb-2 border-b border-border">
                <p className="text-xs font-semibold text-foreground">Where this page&apos;s data comes from</p>
                <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{pathname}</p>
              </div>

              <div className="px-3.5 py-2 border-b border-border">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] font-semibold text-foreground">Writes from this device</p>
                  <span className={`text-[10px] font-semibold ${summaryTone}`} aria-live="polite">
                    {summary}
                  </span>
                </div>

                {writes.items.length === 0 ? (
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    Nothing saved from this device yet.
                  </p>
                ) : (
                  <ul className="mt-1.5 space-y-1.5">
                    {writes.items.slice(0, 4).map((item) => {
                      const copy = WRITE_COPY[item.phase];
                      const RowIcon = copy.icon;
                      return (
                        <li key={item.id} className="flex items-start gap-2">
                          <RowIcon
                            className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${copy.tone} ${copy.spin ? 'animate-spin' : ''}`}
                          />
                          <div className="min-w-0 flex-1">
                            <p className="text-[11px] font-medium leading-snug text-foreground truncate">
                              {writeTitle(item)}
                            </p>
                            <p className="text-[10px] text-muted-foreground leading-snug">
                              {copy.text}
                              {item.writes > 1 ? ` · ${item.writes} changes` : ''}
                              {' · '}
                              {ago(item.updatedAt, now)}
                            </p>
                            {item.phase === 'failed' && item.error && (
                              <p className="text-[10px] text-red-600 leading-snug mt-0.5 break-words line-clamp-2">
                                {item.error}
                              </p>
                            )}
                          </div>
                          {item.phase === 'failed' && (
                            <button
                              type="button"
                              onClick={() => dismissWrite(item.id)}
                              className="text-muted-foreground hover:text-foreground shrink-0"
                              aria-label={`Dismiss failed write: ${writeTitle(item)}`}
                            >
                              <X className="w-3 h-3" />
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {writes.items.length > 4 && (
                  <p className="text-[10px] text-muted-foreground mt-1">
                    +{writes.items.length - 4} more
                  </p>
                )}
              </div>

              <ul className="py-1.5">
                {rows.map((kind) => {
                  const rowMeta = SOURCE_META[kind];
                  const RowIcon = rowMeta.icon;
                  const count = sources.counts[kind] ?? 0;
                  const active = primary === kind;
                  return (
                    <li
                      key={kind}
                      className={`flex items-center gap-2.5 px-3.5 py-2 ${active ? 'bg-muted/40' : ''}`}
                    >
                      <RowIcon className={`w-3.5 h-3.5 shrink-0 ${count > 0 ? rowMeta.row : 'text-muted-foreground'}`} />
                      <div className="min-w-0 flex-1">
                        <p className={`text-[11px] font-medium leading-snug ${count > 0 ? 'text-foreground' : 'text-muted-foreground'}`}>
                          {rowMeta.label}
                        </p>
                        <p className="text-[10px] text-muted-foreground">
                          {count > 0 ? `${count} read${count === 1 ? '' : 's'} · ${ago(sources.lastAt[kind], now)}` : 'not used on this page'}
                        </p>
                      </div>
                      {active && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${rowMeta.dot}`} />}
                    </li>
                  );
                })}
              </ul>

              <div className="px-3.5 py-2.5 border-t border-border bg-muted/20 rounded-b-xl">
                <p className="text-[10px] leading-relaxed text-muted-foreground">
                  Live server data wins; if a read cannot reach it, the local database on this
                  device answers, and a cached snapshot is the last resort.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    router.push('/sync');
                  }}
                  className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-blue-700 hover:text-blue-800"
                >
                  <RefreshCw className="w-3 h-3" />
                  Open Sync Center
                </button>
              </div>
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
