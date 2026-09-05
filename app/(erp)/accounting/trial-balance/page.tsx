'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/format';
import { toast } from '@/hooks/use-toast';
import { Download, Printer, TriangleAlert as AlertTriangle, CircleCheck as CheckCircle2, Calendar, FileText } from 'lucide-react';

interface TrialBalanceRow {
  account_id: string;
  code: string;
  name: string;
  account_type: string;
  is_active: boolean;
  opening: number | string;
  period_debit: number | string;
  period_credit: number | string;
  closing: number | string;
}

interface UnbalancedEntry {
  id: string;
  entry_number: string;
  entry_date: string;
  reference_type: string | null;
  total_debit: number | string;
  total_credit: number | string;
  line_debit: number | string;
  line_credit: number | string;
}

const PRESETS = [
  { value: 'this_month', label: 'This Month' },
  { value: 'last_month', label: 'Last Month' },
  { value: 'this_quarter', label: 'This Quarter' },
  { value: 'this_year', label: 'This Year' },
  { value: 'all', label: 'All Time' },
  { value: 'custom', label: 'Custom' },
] as const;

type Preset = typeof PRESETS[number]['value'];

export default function TrialBalancePage() {
  const [preset, setPreset] = useState<Preset>('this_month');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [rows, setRows] = useState<TrialBalanceRow[]>([]);
  const [unbalanced, setUnbalanced] = useState<UnbalancedEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { load(); }, [preset, customFrom, customTo]);

  // Local dates, not UTC (same lesson as the journal page's "Today" bug).
  function ymd(d: Date) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function getRange() {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    if (preset === 'this_month') return { from: ymd(new Date(y, m, 1)), to: ymd(now) };
    if (preset === 'last_month') return { from: ymd(new Date(y, m - 1, 1)), to: ymd(new Date(y, m, 0)) };
    if (preset === 'this_quarter') return { from: ymd(new Date(y, Math.floor(m / 3) * 3, 1)), to: ymd(now) };
    if (preset === 'this_year') return { from: ymd(new Date(y, 0, 1)), to: ymd(now) };
    if (preset === 'custom') return { from: customFrom, to: customTo };
    return { from: '', to: '' };
  }

  async function load() {
    setLoading(true);
    setError(null);
    const { from, to } = getRange();
    const [tbRes, ubRes] = await Promise.all([
      supabase.rpc('get_trial_balance', { p_from: from || null, p_to: to || null }),
      supabase.rpc('get_unbalanced_journal_entries'),
    ]);
    if (tbRes.error) {
      setError(tbRes.error.message);
      setRows([]);
    } else {
      setRows((tbRes.data || []).filter((r: TrialBalanceRow) =>
        Number(r.opening) !== 0 || Number(r.period_debit) !== 0 || Number(r.period_credit) !== 0 || Number(r.closing) !== 0));
    }
    setUnbalanced(ubRes.error ? [] : (ubRes.data || []));
    setLoading(false);
  }

  const active = rows;
  const totals = active.reduce((acc, r) => ({
    openingDr: acc.openingDr + Math.max(0, Number(r.opening)),
    openingCr: acc.openingCr + Math.max(0, -Number(r.opening)),
    periodDebit: acc.periodDebit + Number(r.period_debit),
    periodCredit: acc.periodCredit + Number(r.period_credit),
    closingDr: acc.closingDr + Math.max(0, Number(r.closing)),
    closingCr: acc.closingCr + Math.max(0, -Number(r.closing)),
  }), { openingDr: 0, openingCr: 0, periodDebit: 0, periodCredit: 0, closingDr: 0, closingCr: 0 });
  const inBalance = Math.abs(totals.closingDr - totals.closingCr) < 0.01;

  function exportCsv() {
    const escape = (v: any) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const { from, to } = getRange();
    const header = `TRIAL BALANCE${from || to ? ` (${from || 'beginning'} to ${to || 'today'})` : ' (all time)'}`;
    const lines = [
      header,
      ['Code', 'Account', 'Type', 'Opening Debit', 'Opening Credit', 'Period Debit', 'Period Credit', 'Closing Debit', 'Closing Credit'].join(','),
      ...active.map(r => [
        escape(r.code), escape(r.name), escape(r.account_type),
        Number(r.opening) > 0.005 ? Number(r.opening) : '',
        Number(r.opening) < -0.005 ? -Number(r.opening) : '',
        Number(r.period_debit) || '',
        Number(r.period_credit) || '',
        Number(r.closing) > 0.005 ? Number(r.closing) : '',
        Number(r.closing) < -0.005 ? -Number(r.closing) : '',
      ].join(',')),
      ['', 'TOTAL', '', totals.openingDr || '', totals.openingCr || '', totals.periodDebit || '', totals.periodCredit || '', totals.closingDr || '', totals.closingCr || ''].join(','),
    ];
    const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trial-balance-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: 'Exported', description: 'Trial balance exported to CSV' });
  }

  const cell = (n: number) => (Math.abs(n) < 0.005 ? <span className="text-muted-foreground/50">—</span> : formatCurrency(Math.abs(n)));

  return (
    <div className="space-y-5 animate-fade-in print-modal">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Trial Balance</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Every account&apos;s debits and credits for a period — total debits must equal total credits</p>
        </div>
        <div className="flex items-center gap-2 print:hidden">
          <button onClick={exportCsv} className="flex items-center gap-2 border border-border hover:bg-muted px-4 py-2 rounded-lg text-sm font-semibold transition">
            <Download className="w-4 h-4" />Export CSV
          </button>
          <button onClick={() => window.print()} className="flex items-center gap-2 border border-border hover:bg-muted px-4 py-2 rounded-lg text-sm font-semibold transition">
            <Printer className="w-4 h-4" />Print
          </button>
        </div>
      </div>

      {/* Balance status */}
      {!loading && !error && (
        <div className={`rounded-xl border p-4 flex items-center gap-3 ${inBalance ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
          {inBalance ? (
            <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0" />
          ) : (
            <AlertTriangle className="w-5 h-5 text-red-600 shrink-0" />
          )}
          <div className="text-sm">
            {inBalance ? (
              <p className="text-green-700">
                <strong>In balance.</strong> Total closing debits equal total closing credits — {formatCurrency(totals.closingDr)} on each side across {active.length} account{active.length === 1 ? '' : 's'}.
              </p>
            ) : (
              <p className="text-red-700">
                <strong>Out of balance by {formatCurrency(Math.abs(totals.closingDr - totals.closingCr))}.</strong> Total debits ({formatCurrency(totals.closingDr)}) ≠ total credits ({formatCurrency(totals.closingCr)}).
              </p>
            )}
          </div>
        </div>
      )}

      {/* Unbalanced entries banner */}
      {!loading && unbalanced.length > 0 && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 space-y-2 print:hidden">
          <div className="flex items-center gap-2 text-sm font-semibold text-red-700">
            <AlertTriangle className="w-4 h-4" />
            {unbalanced.length} unbalanced journal {unbalanced.length === 1 ? 'entry' : 'entries'}
          </div>
          <div className="space-y-1">
            {unbalanced.slice(0, 10).map(u => (
              <div key={u.id} className="flex items-center justify-between bg-red-100/60 rounded px-2 py-1 text-xs">
                <Link href={`/accounting/journal?highlight=${u.id}`} className="font-mono font-semibold text-red-700 hover:underline">
                  {u.entry_number}
                </Link>
                <span className="text-red-600">
                  Dr {formatCurrency(Number(u.line_debit))} / Cr {formatCurrency(Number(u.line_credit))}
                  {Number(u.total_debit) !== Number(u.line_debit) && ' (header disagrees with lines)'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Period filter */}
      <div className="bg-white rounded-xl border border-border p-4 shadow-sm space-y-3 print:hidden">
        <div className="flex flex-wrap items-center gap-2">
          <Calendar className="w-4 h-4 text-muted-foreground shrink-0" />
          {PRESETS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setPreset(opt.value)}
              aria-pressed={preset === opt.value}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${preset === opt.value ? 'bg-blue-600 text-white' : 'bg-muted/50 text-muted-foreground hover:bg-muted'}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {preset === 'custom' && (
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <label className="flex items-center gap-2">
              <span className="text-muted-foreground">From</span>
              <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} className="border border-border rounded-lg px-3 py-1.5 text-sm" />
            </label>
            <label className="flex items-center gap-2">
              <span className="text-muted-foreground">To</span>
              <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} className="border border-border rounded-lg px-3 py-1.5 text-sm" />
            </label>
          </div>
        )}
      </div>

      {/* Trial balance table */}
      <div className="table-wrapper">
        <div className="overflow-x-auto print:overflow-visible">
          <table className="w-full min-w-[900px] print:min-w-0">
            <thead>
              <tr className="bg-muted/40 border-b border-border">
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Code</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Account</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Type</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Opening Debit</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Opening Credit</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Period Debit</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Period Credit</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Closing Debit</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Closing Credit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 9 }).map((_, j) => (
                      <td key={j} className="px-4 py-3"><div className="h-4 bg-muted rounded animate-pulse" /></td>
                    ))}
                  </tr>
                ))
              ) : error ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-sm">
                    <AlertTriangle className="w-10 h-10 mx-auto mb-3 text-red-300" />
                    <p className="font-medium text-red-600">Failed to load trial balance</p>
                    <p className="text-xs mt-1 text-muted-foreground">{error}</p>
                    <button onClick={() => load()} className="mt-3 px-3 py-1.5 border border-border rounded-lg text-xs hover:bg-muted">Retry</button>
                  </td>
                </tr>
              ) : active.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-muted-foreground text-sm">
                    <FileText className="w-10 h-10 mx-auto mb-3 text-muted-foreground/30" />
                    <p className="font-medium">No account activity in this period</p>
                    <p className="text-xs mt-1">Try a wider date range</p>
                  </td>
                </tr>
              ) : (
                active.map(r => (
                  <tr key={r.account_id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3 text-sm font-mono text-muted-foreground">{r.code}</td>
                    <td className="px-4 py-3 text-sm">
                      <Link href={`/accounting/accounts/${r.account_id}`} className="font-medium text-foreground hover:text-blue-600 hover:underline">
                        {r.name}
                      </Link>
                      {!r.is_active && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">inactive</span>}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground capitalize">{r.account_type}</td>
                    <td className="px-4 py-3 text-sm text-right text-green-700">{cell(Number(r.opening) > 0 ? Number(r.opening) : 0)}</td>
                    <td className="px-4 py-3 text-sm text-right text-red-600">{cell(Number(r.opening) < 0 ? Number(r.opening) : 0)}</td>
                    <td className="px-4 py-3 text-sm text-right text-green-700">{cell(Number(r.period_debit))}</td>
                    <td className="px-4 py-3 text-sm text-right text-red-600">{cell(Number(r.period_credit))}</td>
                    <td className="px-4 py-3 text-sm text-right font-semibold text-green-700">{cell(Number(r.closing) > 0 ? Number(r.closing) : 0)}</td>
                    <td className="px-4 py-3 text-sm text-right font-semibold text-red-600">{cell(Number(r.closing) < 0 ? Number(r.closing) : 0)}</td>
                  </tr>
                ))
              )}
            </tbody>
            {!loading && !error && active.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-border bg-muted/30 font-semibold">
                  <td colSpan={3} className="px-4 py-3 text-sm">TOTAL ({active.length} accounts)</td>
                  <td className="px-4 py-3 text-sm text-right text-green-700">{totals.openingDr ? formatCurrency(totals.openingDr) : '—'}</td>
                  <td className="px-4 py-3 text-sm text-right text-red-600">{totals.openingCr ? formatCurrency(totals.openingCr) : '—'}</td>
                  <td className="px-4 py-3 text-sm text-right text-green-700">{formatCurrency(totals.periodDebit)}</td>
                  <td className="px-4 py-3 text-sm text-right text-red-600">{formatCurrency(totals.periodCredit)}</td>
                  <td className="px-4 py-3 text-sm text-right text-green-700">{formatCurrency(totals.closingDr)}</td>
                  <td className="px-4 py-3 text-sm text-right text-red-600">{formatCurrency(totals.closingCr)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}
