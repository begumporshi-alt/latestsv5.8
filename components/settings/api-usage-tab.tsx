'use client';

/**
 * Settings → API Usage.
 *
 * Shows what THIS device's Supabase traffic is made of, from the local
 * egress tracker (lib/telemetry/egress-tracker.ts). Read entirely from
 * IndexedDB — the page itself costs zero egress. Bytes are the DECOMPRESSED
 * payload size (Content-Length is not CORS-exposed), i.e. an upper bound on
 * billed wire bytes; endpoint shares are the signal. Project-wide totals
 * live in the Supabase dashboard.
 */

import { useCallback, useEffect, useState } from 'react';
import { Activity, BarChart3, Info, Trash2 } from 'lucide-react';
import {
  clearEgressData,
  getEgressSummary,
  isEgressTrackingEnabled,
  setEgressTrackingEnabled,
  type EgressSummary,
} from '@/lib/telemetry/egress-tracker';

function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

const MAX_BAR_DAYS = 14;

export function ApiUsageTab() {
  const [enabled, setEnabled] = useState(true);
  const [summary, setSummary] = useState<EgressSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(() => {
    setEnabled(isEgressTrackingEnabled());
    void getEgressSummary().then(setSummary).finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const onToggle = (on: boolean) => {
    setEgressTrackingEnabled(on);
    setEnabled(on);
    // Reload so the "tracking disabled" state and any pre-disable data show.
    void getEgressSummary().then(setSummary);
  };

  const onClear = async () => {
    if (!window.confirm('Delete all locally collected API usage data on this device?')) return;
    setClearing(true);
    await clearEgressData();
    load();
    setClearing(false);
  };

  const days = summary?.days || [];
  const endpoints = summary?.endpoints || [];
  const top = endpoints.slice(0, 10);
  const maxDayBytes = Math.max(1, ...days.slice(-MAX_BAR_DAYS).map((d) => d.bytes));
  const totalBytes = endpoints.reduce((s, e) => s + e.bytes, 0);
  const rpcBytes = endpoints.filter((e) => e.endpoint.startsWith('rpc:')).reduce((s, e) => s + e.bytes, 0);
  const tableBytes = endpoints.filter((e) => e.endpoint.startsWith('table:')).reduce((s, e) => s + e.bytes, 0);
  const otherBytes = totalBytes - rpcBytes - tableBytes;

  return (
    <div>
      <div className="px-6 py-4 border-b border-border flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-bold">API Usage (this device)</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            What this device&apos;s Supabase traffic is made of — measured locally, zero added egress
          </p>
        </div>
        <label className="flex items-center gap-2 cursor-pointer select-none shrink-0 pt-1">
          <span className="text-xs text-muted-foreground">{enabled ? 'Tracking on' : 'Tracking off'}</span>
          <button
            role="switch"
            aria-checked={enabled}
            onClick={() => onToggle(!enabled)}
            className={`relative w-10 h-5 rounded-full transition ${enabled ? 'bg-blue-600' : 'bg-slate-300'}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition ${enabled ? 'translate-x-5' : ''}`} />
          </button>
        </label>
      </div>

      <div className="p-6 space-y-5">
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800 flex gap-2">
          <Info className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            Sizes are the <strong>decompressed</strong> payload (Supabase doesn&apos;t expose
            Content-Length cross-origin), an upper bound on billed egress — the endpoint
            <strong> shares</strong> are the signal. This page reads only local IndexedDB and adds no
            network traffic. Project-wide totals per day are in the Supabase dashboard.
          </div>
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading usage data...</p>
        ) : !enabled && totalBytes === 0 ? (
          <p className="text-sm text-muted-foreground">
            Tracking is off and no data has been collected yet. Turn it on, use the app for a
            while, and this page will show which tables and RPCs your device downloads.
          </p>
        ) : (
          <>
            {/* Stat strip */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="rounded-xl border border-border p-3">
                <p className="text-xs text-muted-foreground">Today</p>
                <p className="text-lg font-bold">{formatBytes(summary?.todayBytes || 0)}</p>
                <p className="text-[11px] text-muted-foreground">{(summary?.todayRequests || 0).toLocaleString()} requests</p>
              </div>
              <div className="rounded-xl border border-border p-3">
                <p className="text-xs text-muted-foreground">Tracked total</p>
                <p className="text-lg font-bold">{formatBytes(totalBytes)}</p>
                <p className="text-[11px] text-muted-foreground">{summary?.trackedSince ? `since ${summary.trackedSince}` : '—'}</p>
              </div>
              <div className="rounded-xl border border-border p-3">
                <p className="text-xs text-muted-foreground">Tables</p>
                <p className="text-lg font-bold">{formatBytes(tableBytes)}</p>
                <p className="text-[11px] text-muted-foreground">{totalBytes ? Math.round((tableBytes / totalBytes) * 100) : 0}% of payload</p>
              </div>
              <div className="rounded-xl border border-border p-3">
                <p className="text-xs text-muted-foreground">RPCs</p>
                <p className="text-lg font-bold">{formatBytes(rpcBytes)}</p>
                <p className="text-[11px] text-muted-foreground">{totalBytes ? Math.round((rpcBytes / totalBytes) * 100) : 0}% · other {formatBytes(otherBytes)}</p>
              </div>
            </div>

            {/* 14-day bars */}
            {days.length > 0 && (
              <div className="rounded-xl border border-border p-4">
                <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-3">
                  <BarChart3 className="w-4 h-4 text-muted-foreground" /> Daily payload (last {Math.min(MAX_BAR_DAYS, days.length)} days)
                </h3>
                <div className="flex items-end gap-1.5 h-24">
                  {days.slice(-MAX_BAR_DAYS).map((d) => (
                    <div key={d.day} className="flex-1 flex flex-col items-center gap-1 group">
                      <div
                        className="w-full bg-blue-500/80 rounded-t hover:bg-blue-600 transition"
                        style={{ height: `${Math.max(2, Math.round((d.bytes / maxDayBytes) * 76))}px` }}
                        title={`${d.day}: ${formatBytes(d.bytes)} · ${d.requests.toLocaleString()} requests`}
                      />
                      <span className="text-[9px] text-muted-foreground">{d.day.slice(5)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Top endpoints */}
            {top.length > 0 && (
              <div className="rounded-xl border border-border overflow-hidden">
                <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                  <h3 className="text-sm font-semibold">Top endpoints by payload</h3>
                  <button
                    onClick={onClear}
                    disabled={clearing}
                    className="text-xs text-red-600 hover:text-red-700 flex items-center gap-1 disabled:opacity-50"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Clear data
                  </button>
                </div>
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-muted-foreground text-xs">
                    <tr>
                      <th className="px-4 py-2 text-left font-medium">Endpoint</th>
                      <th className="px-4 py-2 text-right font-medium">Requests</th>
                      <th className="px-4 py-2 text-right font-medium">Payload</th>
                      <th className="px-4 py-2 text-right font-medium">Share</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {top.map((e) => (
                      <tr key={e.endpoint}>
                        <td className="px-4 py-2 font-mono text-xs">
                          <span className={`mr-1.5 rounded px-1 py-0.5 text-[9px] font-semibold uppercase align-middle ${
                            e.endpoint.startsWith('rpc:') ? 'bg-purple-100 text-purple-700' : 'bg-slate-100 text-slate-600'
                          }`}>
                            {e.endpoint.startsWith('rpc:') ? 'rpc' : 'table'}
                          </span>
                          {e.endpoint.replace(/^(table|rpc):/, '')}
                        </td>
                        <td className="px-4 py-2 text-right text-muted-foreground">{e.requests.toLocaleString()}</td>
                        <td className="px-4 py-2 text-right font-semibold">{formatBytes(e.bytes)}</td>
                        <td className="px-4 py-2 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <div className="w-16 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                              <div className="h-full bg-blue-500 rounded-full" style={{ width: `${totalBytes ? Math.round((e.bytes / totalBytes) * 100) : 0}%` }} />
                            </div>
                            <span className="text-xs text-muted-foreground w-9 text-right">{totalBytes ? Math.round((e.bytes / totalBytes) * 100) : 0}%</span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {!enabled && totalBytes > 0 && (
              <p className="text-xs text-muted-foreground">
                Tracking is currently OFF — the numbers above are frozen as of when it was
                turned off. Turn it back on to resume collecting.
              </p>
            )}
            {enabled && totalBytes === 0 && (
              <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Activity className="w-3.5 h-3.5" /> Tracking is on — browse a few pages and reload this tab to see data.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
