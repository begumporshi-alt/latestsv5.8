'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/format';
import { Download, Printer, TriangleAlert as AlertTriangle, CircleCheck as CheckCircle2, Calendar, Building2, RefreshCw } from 'lucide-react';

interface BsRow {
  section: string;
  code: string;
  name: string;
  balance: number | string;
}

export default function BalanceSheetPage() {
  const [asOf, setAsOf] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  });
  const [rows, setRows] = useState<BsRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [companyName, setCompanyName] = useState('SI Building Solutions.');

  useEffect(() => { loadSettings(); }, []);
  useEffect(() => { load(); }, [asOf]);

  async function loadSettings() {
    const { data } = await supabase.from('app_settings').select('setting_value').eq('setting_key', 'company').maybeSingle();
    if (data?.setting_value?.name) setCompanyName(data.setting_value.name);
  }

  async function load() {
    setLoading(true);
    setError(null);
    const { data, error: rpcError } = await supabase.rpc('get_balance_sheet', { p_as_of: asOf });
    if (rpcError) {
      setError(rpcError.message);
      setRows([]);
    } else {
      setRows((data || []) as BsRow[]);
    }
    setLoading(false);
  }

  const assets = rows.filter(r => r.section === 'asset');
  const liabilities = rows.filter(r => r.section === 'liability');
  const equity = rows.filter(r => r.section === 'equity');
  const summary = Object.fromEntries(rows.filter(r => r.section === 'summary').map(r => [r.code, Number(r.balance)]));
  const difference = summary['DIFFERENCE'] ?? 0;
  const inBalance = Math.abs(difference) < 0.01;

  function exportCsv() {
    const escape = (v: any) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines: string[] = [
      'BALANCE SHEET',
      `As of ${asOf}`,
      '',
      'ASSETS',
      ...assets.map(r => `${escape(r.code)} ${escape(r.name)},${Number(r.balance).toFixed(2)}`),
      `Total Assets,${(summary['TOTAL_ASSETS'] ?? 0).toFixed(2)}`,
      '',
      'LIABILITIES',
      ...liabilities.map(r => `${escape(r.code)} ${escape(r.name)},${Number(r.balance).toFixed(2)}`),
      `Total Liabilities,${(summary['TOTAL_LIABILITIES'] ?? 0).toFixed(2)}`,
      '',
      'EQUITY',
      ...equity.map(r => `${escape(r.code)} ${escape(r.name)},${Number(r.balance).toFixed(2)}`),
      `Total Equity incl. Current Earnings,${(summary['TOTAL_EQUITY'] ?? 0).toFixed(2)}`,
      '',
      `Total Liabilities + Equity,${(summary['TOTAL_LIAB_EQUITY'] ?? 0).toFixed(2)}`,
      `Balance check (Assets - Liabilities + Equity),${difference.toFixed(2)}`,
    ];
    const csv = '\uFEFF' + lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `balance_sheet_${asOf}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const sectionHead = (label: string) => (
    <div className="px-4 py-2 border-b border-t border-border bg-blue-50">
      <h4 className="text-xs font-bold text-blue-700 tracking-wide">{label}</h4>
    </div>
  );

  const accountRow = (r: BsRow) => (
    <tr key={`${r.section}-${r.code}-${r.name}`} className="border-b border-gray-100 hover:bg-gray-50/50">
      <td className="py-2.5 pl-4 text-sm text-gray-700">
        <span className="font-mono text-xs text-gray-400 mr-2">{r.code}</span>{r.name}
      </td>
      <td className="py-2.5 pr-4 text-right text-sm font-medium text-gray-800 tabular-nums">{formatCurrency(Number(r.balance))}</td>
    </tr>
  );

  return (
    <div className="space-y-5 animate-fade-in print-modal">
      {/* Explanation panel */}
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-5 print:hidden">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center flex-shrink-0 mt-0.5">
            <Building2 className="w-4 h-4 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-bold text-blue-900 mb-2">How the Balance Sheet Works</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-blue-800">
              <div className="space-y-2">
                <div>
                  <span className="font-semibold block">Assets = Liabilities + Equity</span>
                  Everything the business owns (cash, bank, receivables, inventory) is financed either by others (payables, VAT/WHT payable) or by the owner (equity plus earnings to date).
                </div>
                <div>
                  <span className="font-semibold block">Current Earnings</span>
                  Revenue minus expenses accumulated to the as-of date. There are no year-end closing entries yet, so earnings are shown as part of equity rather than rolled into a Retained Earnings account.
                </div>
              </div>
              <div className="space-y-2">
                <div>
                  <span className="font-semibold block">As-of Date</span>
                  The sheet shows balances at the end of the selected date — every posted journal entry up to and including that date counts. Back-date to see the position at any point in time.
                </div>
                <div>
                  <span className="font-semibold block">Balance Check</span>
                  The green banner proves Assets − (Liabilities + Equity) = 0 from the journal itself. If it ever shows a non-zero figure, stop and reconcile before trusting the numbers.
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between flex-wrap gap-3 print:hidden">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Balance Sheet</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Assets, liabilities and equity as of a date</p>
        </div>
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-muted-foreground" />
          <input
            type="date"
            value={asOf}
            onChange={e => setAsOf(e.target.value)}
            className="border border-border rounded-lg px-3 py-2 text-sm bg-white"
          />
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
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex gap-3 print:hidden">
          <AlertTriangle className="w-5 h-5 text-red-500 shrink-0" />
          <div className="text-sm text-red-700">{error}</div>
        </div>
      )}

      <div className="bg-white rounded-lg border border-gray-200 shadow-sm max-w-3xl mx-auto print:shadow-none print:border-none">
        <div className="text-center py-6 border-b border-gray-200">
          <div className="flex items-center justify-center gap-2 mb-2">
            <Building2 className="w-5 h-5 text-gray-600" />
            <h2 className="text-lg font-bold text-gray-900 tracking-wide">{companyName}</h2>
          </div>
          <h3 className="text-base font-semibold text-gray-800 mt-2">BALANCE SHEET</h3>
          <p className="text-sm text-gray-500 mt-1">As of {asOf}</p>
        </div>

        {loading ? (
          <div className="px-8 py-12 text-center text-gray-400">Loading balances…</div>
        ) : (
          <div className="px-6 py-4 space-y-6">
            {/* ASSETS */}
            <div>
              {sectionHead('ASSETS')}
              <table className="w-full text-sm">
                <tbody>
                  {assets.length > 0 ? assets.map(accountRow) : (
                    <tr><td className="py-3 pl-4 text-gray-400" colSpan={2}>No asset balances</td></tr>
                  )}
                  <tr className="bg-blue-50 border-b border-gray-200">
                    <td className="py-2.5 pl-4 font-semibold text-gray-800">Total Assets</td>
                    <td className="py-2.5 pr-4 text-right font-bold tabular-nums text-blue-800">{formatCurrency(summary['TOTAL_ASSETS'] ?? 0)}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* LIABILITIES */}
            <div>
              {sectionHead('LIABILITIES')}
              <table className="w-full text-sm">
                <tbody>
                  {liabilities.length > 0 ? liabilities.map(accountRow) : (
                    <tr><td className="py-3 pl-4 text-gray-400" colSpan={2}>No liability balances</td></tr>
                  )}
                  <tr className="bg-blue-50 border-b border-gray-200">
                    <td className="py-2.5 pl-4 font-semibold text-gray-800">Total Liabilities</td>
                    <td className="py-2.5 pr-4 text-right font-bold tabular-nums text-blue-800">{formatCurrency(summary['TOTAL_LIABILITIES'] ?? 0)}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* EQUITY */}
            <div>
              {sectionHead('EQUITY')}
              <table className="w-full text-sm">
                <tbody>
                  {equity.map(accountRow)}
                  <tr className="bg-blue-50 border-b border-gray-200">
                    <td className="py-2.5 pl-4 font-semibold text-gray-800">Total Equity (incl. Current Earnings)</td>
                    <td className="py-2.5 pr-4 text-right font-bold tabular-nums text-blue-800">{formatCurrency(summary['TOTAL_EQUITY'] ?? 0)}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* PROOF */}
            <div className={`flex justify-between items-center py-4 px-4 mt-4 rounded-lg ${inBalance ? 'bg-green-600' : 'bg-red-600'}`}>
              <span className="text-base font-bold text-white tracking-wide">
                {inBalance ? 'ASSETS = LIABILITIES + EQUITY' : 'OUT OF BALANCE'}
              </span>
              <span className="text-xl font-bold text-white tabular-nums">
                {formatCurrency(summary['TOTAL_ASSETS'] ?? 0)} = {formatCurrency(summary['TOTAL_LIAB_EQUITY'] ?? 0)}
              </span>
            </div>
            {!inBalance && (
              <p className="text-xs text-red-600 text-center">Difference: {formatCurrency(difference)} — reconcile the journal before trusting these figures.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
