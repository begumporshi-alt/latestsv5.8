'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/format';
import { Download, Printer, RefreshCw, Calendar, Banknote, TrendingUp, TrendingDown, ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

interface FlowRow {
  section: string;
  label: string;
  label2: string | null;
  opening: number | string;
  inflow: number | string;
  outflow: number | string;
  closing: number | string;
}

type Preset = 'this_month' | 'last_month' | 'this_quarter' | 'this_year' | 'custom';

export default function CashFlowPage() {
  const [preset, setPreset] = useState<Preset>('this_month');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [rows, setRows] = useState<FlowRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { load(); }, [preset, customFrom, customTo]);

  function ymd(d: Date) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function getRange(): { from: string; to: string } {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    if (preset === 'this_month') return { from: ymd(new Date(y, m, 1)), to: ymd(now) };
    if (preset === 'last_month') return { from: ymd(new Date(y, m - 1, 1)), to: ymd(new Date(y, m, 0)) };
    if (preset === 'this_quarter') return { from: ymd(new Date(y, Math.floor(m / 3) * 3, 1)), to: ymd(now) };
    if (preset === 'this_year') return { from: ymd(new Date(y, 0, 1)), to: ymd(now) };
    return { from: customFrom, to: customTo };
  }

  async function load() {
    setLoading(true);
    setError(null);
    const { from, to } = getRange();
    const { data, error: rpcError } = await supabase.rpc('get_cash_flow', {
      p_from: from || null,
      p_to: to || null,
    });
    if (rpcError) {
      setError(rpcError.message);
      setRows([]);
    } else {
      setRows((data || []) as FlowRow[]);
    }
    setLoading(false);
  }

  const accounts = rows.filter(r => r.section === 'account');
  const months = rows
    .filter(r => r.section === 'month')
    .map(r => ({
      month: r.label,
      inflow: Number(r.inflow),
      outflow: Number(r.outflow),
      net: Number(r.closing),
    }));
  const categories = rows.filter(r => r.section === 'category')
    .map(r => ({ label: r.label2 || r.label, inflow: Number(r.inflow), outflow: Number(r.outflow), net: Number(r.closing) }))
    .sort((a, b) => (b.inflow + b.outflow) - (a.inflow + a.outflow));

  const totalIn = accounts.reduce((s, r) => s + Number(r.inflow), 0);
  const totalOut = accounts.reduce((s, r) => s + Number(r.outflow), 0);
  const net = totalIn - totalOut;

  function exportCsv() {
    const { from, to } = getRange();
    const lines: string[] = [
      'CASH FLOW STATEMENT',
      `${from || 'beginning'} to ${to || 'today'}`,
      '',
      'BY ACCOUNT',
      'Account,Type,Opening,Cash In,Cash Out,Closing',
      ...accounts.map(r => `"${r.label}",${r.label2},${Number(r.opening).toFixed(2)},${Number(r.inflow).toFixed(2)},${Number(r.outflow).toFixed(2)},${Number(r.closing).toFixed(2)}`),
      '',
      'BY MONTH',
      'Month,Cash In,Cash Out,Net',
      ...months.map(m => `${m.month},${m.inflow.toFixed(2)},${m.outflow.toFixed(2)},${m.net.toFixed(2)}`),
      '',
      'BY SOURCE',
      'Source,Cash In,Cash Out,Net',
      ...categories.map(c => `"${c.label}",${c.inflow.toFixed(2)},${c.outflow.toFixed(2)},${c.net.toFixed(2)}`),
    ];
    const csv = '\uFEFF' + lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cash_flow.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-5 animate-fade-in print-modal">
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-5 print:hidden">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center flex-shrink-0 mt-0.5">
            <Banknote className="w-4 h-4 text-white" />
          </div>
          <div className="text-xs text-blue-800 space-y-1">
            <p className="text-sm font-bold text-blue-900">How the Cash Flow Statement Works</p>
            <p><strong>Every movement on cash and bank accounts</strong> (Cash in Hand, bKash, bank accounts) from the journal — money physically arriving and leaving, regardless of when the sale or purchase was booked.</p>
            <p><strong>Cash In</strong> = debits to cash/bank (receipts). <strong>Cash Out</strong> = credits (payments). The <strong>Source</strong> table shows what drove it: invoice payments, supplier payments, expenses, returns.</p>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between flex-wrap gap-3 print:hidden">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Cash Flow</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Money in and out of cash & bank accounts</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Calendar className="w-4 h-4 text-muted-foreground" />
          <select value={preset} onChange={e => setPreset(e.target.value as Preset)} className="border border-border rounded-lg px-3 py-2 text-sm bg-white">
            <option value="this_month">This Month</option>
            <option value="last_month">Last Month</option>
            <option value="this_quarter">This Quarter</option>
            <option value="this_year">This Year</option>
            <option value="custom">Custom Range</option>
          </select>
          {preset === 'custom' && (
            <div className="flex items-center gap-1">
              <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} className="border border-border rounded-lg px-2 py-1.5 text-sm" />
              <span className="text-muted-foreground text-xs">to</span>
              <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} className="border border-border rounded-lg px-2 py-1.5 text-sm" />
            </div>
          )}
          <button onClick={load} className="flex items-center gap-1.5 border border-border px-3 py-2 rounded-lg text-sm hover:bg-muted transition">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => window.print()} className="flex items-center gap-1.5 border border-border px-3 py-2 rounded-lg text-sm hover:bg-muted transition">
            <Printer className="w-3.5 h-3.5" />
          </button>
          <button onClick={exportCsv} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition">
            <Download className="w-4 h-4" />Export
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700 print:hidden">{error}</div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="stat-card">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs text-muted-foreground">Cash In</p>
                <ArrowDownLeft className="w-4 h-4 text-green-500" />
              </div>
              <p className="text-2xl font-bold text-green-600">{formatCurrency(totalIn)}</p>
            </div>
            <div className="stat-card">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs text-muted-foreground">Cash Out</p>
                <ArrowUpRight className="w-4 h-4 text-red-500" />
              </div>
              <p className="text-2xl font-bold text-red-600">{formatCurrency(totalOut)}</p>
            </div>
            <div className="stat-card">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs text-muted-foreground">Net Cash Movement</p>
                {net >= 0 ? <TrendingUp className="w-4 h-4 text-green-500" /> : <TrendingDown className="w-4 h-4 text-red-500" />}
              </div>
              <p className={`text-2xl font-bold ${net >= 0 ? 'text-green-600' : 'text-red-600'}`}>{formatCurrency(net)}</p>
            </div>
          </div>

          {months.length > 0 && (
            <div className="bg-white rounded-xl border border-border p-5 shadow-sm">
              <h3 className="text-sm font-semibold text-foreground mb-4">Monthly Cash Movement</h3>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={months}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} tickFormatter={(v: number) => `${(v / 100000).toFixed(1)}L`} />
                  <Tooltip formatter={(v: number) => [formatCurrency(v), '']} contentStyle={{ fontSize: 11, borderRadius: 8 }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="inflow" fill="#10b981" radius={[4, 4, 0, 0]} name="Cash In" />
                  <Bar dataKey="outflow" fill="#ef4444" radius={[4, 4, 0, 0]} name="Cash Out" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          <div className="table-wrapper">
            <div className="px-4 py-3 border-b border-border">
              <h3 className="text-sm font-semibold text-foreground">By Account</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-muted/40 border-b border-border">
                    {['Account', 'Type', 'Opening', 'Cash In', 'Cash Out', 'Closing'].map(h => (
                      <th key={h} className={`${h === 'Account' || h === 'Type' ? 'text-left' : 'text-right'} text-xs font-semibold text-muted-foreground px-4 py-3`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {accounts.map(r => (
                    <tr key={r.label} className="hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3 text-sm font-medium text-foreground">{r.label}</td>
                      <td className="px-4 py-3 text-sm"><span className={`badge-status ${r.label2 === 'cash' ? 'bg-green-50 text-green-600' : 'bg-blue-50 text-blue-600'} capitalize`}>{r.label2}</span></td>
                      <td className="px-4 py-3 text-right text-sm text-muted-foreground tabular-nums">{formatCurrency(Number(r.opening))}</td>
                      <td className="px-4 py-3 text-right text-sm text-green-600 font-medium tabular-nums">{formatCurrency(Number(r.inflow))}</td>
                      <td className="px-4 py-3 text-right text-sm text-red-600 font-medium tabular-nums">{formatCurrency(Number(r.outflow))}</td>
                      <td className="px-4 py-3 text-right text-sm font-bold text-foreground tabular-nums">{formatCurrency(Number(r.closing))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="table-wrapper">
            <div className="px-4 py-3 border-b border-border">
              <h3 className="text-sm font-semibold text-foreground">What Drove the Cash</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-muted/40 border-b border-border">
                    {['Source', 'Cash In', 'Cash Out', 'Net'].map(h => (
                      <th key={h} className={`${h === 'Source' ? 'text-left' : 'text-right'} text-xs font-semibold text-muted-foreground px-4 py-3`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {categories.map(c => (
                    <tr key={c.label} className="hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3 text-sm font-medium text-foreground">{c.label}</td>
                      <td className="px-4 py-3 text-right text-sm text-green-600 tabular-nums">{c.inflow > 0 ? formatCurrency(c.inflow) : '—'}</td>
                      <td className="px-4 py-3 text-right text-sm text-red-600 tabular-nums">{c.outflow > 0 ? formatCurrency(c.outflow) : '—'}</td>
                      <td className={`px-4 py-3 text-right text-sm font-medium tabular-nums ${c.net >= 0 ? 'text-green-600' : 'text-red-600'}`}>{formatCurrency(c.net)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
