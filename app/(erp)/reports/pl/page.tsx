'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/format';
import { Calendar, Download, Printer, RefreshCw, Building2 } from 'lucide-react';

interface PnLData {
  salesRevenue: number;
  salesReturns: number;
  netSalesRevenue: number;
  otherRevenue: { name: string; amount: number }[];
  totalOtherRevenue: number;
  totalRevenue: number;
  costOfGoodsSold: number;
  estimatedManualCogs: number;
  totalCogs: number;
  grossProfit: number;
  operatingExpenses: { name: string; amount: number }[];
  totalOperatingExpenses: number;
  operatingProfit: number;
  netProfit: number;
  netProfitBeforeEstimate: number;
  manualCogsPercent: number;
}

export default function PLPage() {
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<'this_month' | 'last_month' | 'this_quarter' | 'last_quarter' | 'this_year' | 'last_year' | 'custom'>('this_month');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [periodLabel, setPeriodLabel] = useState('');

  const [data, setData] = useState<PnLData>({
    salesRevenue: 0,
    salesReturns: 0,
    netSalesRevenue: 0,
    otherRevenue: [],
    totalOtherRevenue: 0,
    totalRevenue: 0,
    costOfGoodsSold: 0,
    estimatedManualCogs: 0,
    totalCogs: 0,
    grossProfit: 0,
    operatingExpenses: [],
    totalOperatingExpenses: 0,
    operatingProfit: 0,
    netProfit: 0,
    netProfitBeforeEstimate: 0,
    manualCogsPercent: 90,
  });

  const [companySettings, setCompanySettings] = useState({ name: 'SI Building Solutions.', address: '' });

  useEffect(() => { loadData(); loadSettings(); }, [period, customFrom, customTo]);

  async function loadSettings() {
    const { data } = await supabase.from('app_settings').select('setting_value').eq('setting_key', 'company').maybeSingle();
    if (data?.setting_value) setCompanySettings(prev => ({ ...prev, ...data.setting_value }));
  }

  async function loadData() {
    setLoading(true);

    const now = new Date();
    const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const monthName = (d: Date) => d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    let startDate: string;
    let endDate: string;
    let label: string;
    const y = now.getFullYear();
    const m = now.getMonth();
    const qs = Math.floor(m / 3) * 3;

    if (period === 'this_month') {
      startDate = ymd(new Date(y, m, 1));
      endDate = ymd(new Date(y, m + 1, 0));
      label = `For the Month Ended ${monthName(new Date(y, m + 1, 0))}`;
    } else if (period === 'last_month') {
      startDate = ymd(new Date(y, m - 1, 1));
      endDate = ymd(new Date(y, m, 0));
      label = `For the Month Ended ${monthName(new Date(y, m, 0))}`;
    } else if (period === 'this_quarter') {
      startDate = ymd(new Date(y, qs, 1));
      endDate = ymd(new Date(y, qs + 3, 0));
      label = `For the Quarter Ended ${monthName(new Date(y, qs + 3, 0))}`;
    } else if (period === 'last_quarter') {
      const lqs = qs - 3;
      startDate = ymd(new Date(y, lqs, 1));
      endDate = ymd(new Date(y, lqs + 3, 0));
      label = `For the Quarter Ended ${monthName(new Date(y, lqs + 3, 0))}`;
    } else if (period === 'this_year') {
      startDate = ymd(new Date(y, 0, 1));
      endDate = ymd(new Date(y, 11, 31));
      label = `For the Year Ended December 31, ${y}`;
    } else if (period === 'last_year') {
      startDate = ymd(new Date(y - 1, 0, 1));
      endDate = ymd(new Date(y - 1, 11, 31));
      label = `For the Year Ended December 31, ${y - 1}`;
    } else {
      // custom — wait for both bounds
      if (!customFrom || !customTo) { setLoading(false); return; }
      startDate = customFrom;
      endDate = customTo;
      label = `From ${startDate} to ${endDate}`;
    }

    setPeriodLabel(label);

    const [invoicesRes, accountsRes] = await Promise.all([
      // Drafts post no journal entries, so they are not revenue yet
      supabase.from('invoices').select('total_amount, tax_amount, shipping_cost').gte('invoice_date', startDate).lte('invoice_date', endDate).neq('status', 'cancelled').neq('status', 'draft'),
      supabase.from('accounts').select('id, code, name, account_type'),
    ]);

    // Gross sales revenue from non-cancelled invoices, NET of VAT and shipping —
    // the GL posts goods sales to 4000, VAT to 2100 and shipping to 4020 (which
    // appears below as its own revenue row), so this matches the ledger.
    const salesRevenue = (invoicesRes.data || []).reduce((s, inv) => s + Number(inv.total_amount) - Number(inv.tax_amount || 0) - Number(inv.shipping_cost || 0), 0);

    // Helper: sum journal lines for an account within period (DB-side filtering via RPC)
    async function periodNetDebit(accountId: string): Promise<number> {
      const { data } = await supabase.rpc('period_net_debit', {
        p_account_id: accountId,
        p_start_date: startDate,
        p_end_date: endDate,
      });
      return Number(data || 0);
    }

    async function periodNetCredit(accountId: string): Promise<number> {
      const { data } = await supabase.rpc('period_net_credit', {
        p_account_id: accountId,
        p_start_date: startDate,
        p_end_date: endDate,
      });
      return Number(data || 0);
    }

    const allAccounts = accountsRes.data || [];

    // Net per account (no clamping): a credit balance on an expense account is a
    // contra that REDUCES the section, not something to hide — clamping made a
    // Tk 7.3M credit on Inventory Adjustment invisible instead of netting it.
    // Sales Returns & Allowances (contra-revenue, code 4050) — deduct from revenue
    const returnsAccount = allAccounts.find(a => a.code === '4050');
    const salesReturns = returnsAccount ? await periodNetDebit(returnsAccount.id) : 0;

    // COGS (code 5000) — expense account, positive balance = cost incurred
    const cogsAccount = allAccounts.find(a => a.code === '5000');
    const costOfGoodsSold = cogsAccount ? await periodNetDebit(cogsAccount.id) : 0;

    // Non-4000 revenue accounts, each listed under its REAL name. The old
    // single "Service Revenue" lump mislabeled 4001 (Sales Revenue - Manual,
    // no COGS) as service revenue — 4001 manual sales are sales, not services.
    const otherRevenueAccounts = allAccounts.filter(a => a.account_type === 'revenue' && a.code !== '4000');
    const otherRevenue: { name: string; amount: number }[] = [];
    let totalOtherRevenue = 0;
    let manualRevenue = 0; // 4001 Sales Revenue - Manual (no COGS)
    for (const acc of otherRevenueAccounts) {
      const netCredit = await periodNetCredit(acc.id);
      // keep non-zero rows including negatives (a contra credit nets the section)
      if (netCredit !== 0) {
        otherRevenue.push({ name: acc.name, amount: netCredit });
        totalOtherRevenue += netCredit;
      }
      if (acc.code === '4001') manualRevenue = netCredit;
    }
    otherRevenue.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

    const netSalesRevenue = salesRevenue - salesReturns;
    const totalRevenue = netSalesRevenue + totalOtherRevenue;

    // Estimated COGS for manual sales — owner-set % in Settings (P&L Estimates).
    // Presentation-only: nothing is posted to the GL (posting would fabricate
    // inventory consumption and break the 1200-vs-FIFO tie-out).
    const { data: estRes } = await supabase.from('app_settings').select('setting_value').eq('setting_key', 'pl_estimates').maybeSingle();
    const manualCogsPercent = Number(estRes?.setting_value?.manual_cogs_percent ?? 90);
    const estimatedManualCogs = manualRevenue > 0
      ? Math.round(manualRevenue * manualCogsPercent) / 100
      : 0;
    const totalCogs = costOfGoodsSold + estimatedManualCogs;
    const grossProfit = totalRevenue - totalCogs;

    // Operating expenses: all expense accounts except COGS (5000), Sales Returns (4050), Discount Given (4200)
    const EXCLUDED_CODES = new Set(['5000', '4050', '4200']);
    const expenseAccounts = allAccounts.filter(a =>
      a.account_type === 'expense' && !EXCLUDED_CODES.has(a.code)
    );
    const operatingExpenses: { name: string; amount: number }[] = [];
    let totalOperatingExpenses = 0;
    for (const acc of expenseAccounts) {
      const netDebit = await periodNetDebit(acc.id);
      // include credit-balance accounts as negative (contra) rows — they net the section
      if (netDebit !== 0) {
        operatingExpenses.push({ name: acc.name, amount: netDebit });
        totalOperatingExpenses += netDebit;
      }
    }
    operatingExpenses.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

    const operatingProfit = grossProfit - totalOperatingExpenses;
    const netProfit = operatingProfit;
    const netProfitBeforeEstimate = netProfit + estimatedManualCogs;

    setData({
      salesRevenue,
      salesReturns,
      netSalesRevenue,
      otherRevenue,
      totalOtherRevenue,
      totalRevenue,
      costOfGoodsSold,
      estimatedManualCogs,
      totalCogs,
      grossProfit,
      operatingExpenses,
      totalOperatingExpenses,
      operatingProfit,
      netProfit,
      netProfitBeforeEstimate,
      manualCogsPercent,
    });

    setLoading(false);
  }

  function exportToCSV() {
    const rows = [
      ['PROFIT & LOSS STATEMENT'],
      [periodLabel],
      [''],
      ['REVENUE'],
      ['Gross Sales Revenue', data.salesRevenue],
      ['Less: Sales Returns & Allowances', -data.salesReturns],
      ['Net Sales Revenue', data.netSalesRevenue],
      ...data.otherRevenue.map(r => [r.name, r.amount]),
      ['Total Net Revenue', data.totalRevenue],
      [''],
      ['COST OF GOODS SOLD'],
      ['Cost of Goods Sold', data.costOfGoodsSold],
      ...(data.estimatedManualCogs > 0 ? [['Estimated COGS - Manual Sales (no COGS posted)', data.estimatedManualCogs]] : []),
      ['Total COGS', data.totalCogs],
      [''],
      ['GROSS PROFIT', data.grossProfit],
      [''],
      ['OPERATING EXPENSES'],
      ...data.operatingExpenses.map(e => [e.name, e.amount]),
      ['Total Operating Expenses', data.totalOperatingExpenses],
      [''],
      ['OPERATING PROFIT / NET PROFIT', data.netProfit],
      ...(data.estimatedManualCogs > 0 ? [['Memo: Net Profit before estimated manual COGS', data.netProfitBeforeEstimate]] : []),
    ];
    const csv = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'profit_loss_statement.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  function formatMoney(amount: number): string {
    if (amount < 0) return `(${formatCurrency(Math.abs(amount))})`;
    return formatCurrency(amount);
  }

  return (
    <div className="space-y-5 animate-fade-in print-modal">
      {/* P&L Explanation Panel */}
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-5 print:hidden">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center flex-shrink-0 mt-0.5">
            <Building2 className="w-4 h-4 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-bold text-blue-900 mb-2">How the Profit &amp; Loss Statement Works</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-blue-800">
              <div className="space-y-2">
                <div>
                  <span className="font-semibold block">Sales Revenue</span>
                  Sum of all non-cancelled invoices in the period (by invoice date).
                </div>
                <div>
                  <span className="font-semibold block">Sales Returns &amp; Allowances</span>
                  Net debit balance on account code 4050 from journal entries in the period. Deducted from gross revenue.
                </div>
                <div>
                  <span className="font-semibold block">Cost of Goods Sold (COGS)</span>
                  Net debit balance on account code 5000. Automatically posted when each invoice is created via the accounting trigger — records the cost of inventory items sold.
                </div>
              </div>
              <div className="space-y-2">
                <div>
                  <span className="font-semibold block">Gross Profit = Net Revenue − COGS</span>
                  Profit before operating expenses. Shows whether your core selling activity is profitable.
                </div>
                <div>
                  <span className="font-semibold block">Operating Expenses</span>
                  Net debit on all expense accounts (except COGS 5000, Sales Returns 4050, Discount Given 4200) during the period. Includes salaries, rent, utilities, etc. logged in the Journal.
                </div>
                <div>
                  <span className="font-semibold block">Net Profit = Gross Profit − Operating Expenses</span>
                  The bottom line. Negative values mean a net loss for the period.
                </div>
              </div>
            </div>
            <p className="text-xs text-blue-600 mt-3 border-t border-blue-200 pt-2">
              <strong>Period:</strong> Switch between This Month, This Quarter, or This Year using the selector above. All figures are filtered by the journal entry date and invoice date within the selected window.
            </p>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between flex-wrap gap-3 print:hidden">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Profit &amp; Loss Statement</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Standard accounting format</p>
        </div>
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-muted-foreground" />
          <select value={period} onChange={e => setPeriod(e.target.value as typeof period)} className="border border-border rounded-lg px-3 py-2 text-sm focus:outline-none bg-white">
            <option value="this_month">This Month</option>
            <option value="last_month">Last Month</option>
            <option value="this_quarter">This Quarter</option>
            <option value="last_quarter">Last Quarter</option>
            <option value="this_year">This Year</option>
            <option value="last_year">Last Year</option>
            <option value="custom">Custom Range</option>
          </select>
          {period === 'custom' && (
            <div className="flex items-center gap-1">
              <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} className="border border-border rounded-lg px-2 py-1.5 text-sm" />
              <span className="text-xs text-muted-foreground">to</span>
              <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} className="border border-border rounded-lg px-2 py-1.5 text-sm" />
            </div>
          )}
          <button onClick={loadData} className="flex items-center gap-1.5 border border-border px-3 py-2 rounded-lg text-sm hover:bg-muted transition">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => window.print()} className="flex items-center gap-1.5 border border-border px-3 py-2 rounded-lg text-sm hover:bg-muted transition">
            <Printer className="w-3.5 h-3.5" />
          </button>
          <button onClick={exportToCSV} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition">
            <Download className="w-4 h-4" />Export
          </button>
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 shadow-sm max-w-3xl mx-auto print:shadow-none print:border-none">
        <div className="text-center py-6 border-b border-gray-200">
          <div className="flex items-center justify-center gap-2 mb-2">
            <Building2 className="w-5 h-5 text-gray-600" />
            <h2 className="text-lg font-bold text-gray-900 tracking-wide">{companySettings.name}</h2>
          </div>
          <h3 className="text-base font-semibold text-gray-800 mt-2">PROFIT &amp; LOSS STATEMENT</h3>
          <p className="text-sm text-gray-500 mt-1">{periodLabel}</p>
        </div>

        {loading ? (
          <div className="px-8 py-12 text-center text-gray-400">Loading financial data...</div>
        ) : (
          <div className="px-6 py-4">
            {/* REVENUE */}
            <SectionHeader title="REVENUE" />
            <table className="w-full text-sm">
              <tbody>
                <StatementRow label="Gross Sales Revenue" amount={data.salesRevenue} />
                {data.salesReturns > 0 && (
                  <StatementRow label="Less: Sales Returns &amp; Allowances" amount={-data.salesReturns} isDeduction />
                )}
                <StatementRow label="Net Sales Revenue" amount={data.netSalesRevenue} isBold />
                {data.otherRevenue.map(r => (
                  <StatementRow key={r.name} label={r.name} amount={r.amount} />
                ))}
                <TotalRow label="Total Net Revenue" amount={data.totalRevenue} variant="blue" />
              </tbody>
            </table>

            {/* COGS */}
            <SectionHeader title="COST OF GOODS SOLD" className="mt-4" />
            <table className="w-full text-sm">
              <tbody>
                <StatementRow label="Cost of Goods Sold" amount={data.costOfGoodsSold} />
                {data.estimatedManualCogs > 0 && (
                  <StatementRow label="Estimated COGS — Manual Sales (no COGS posted)" amount={data.estimatedManualCogs} />
                )}
                <TotalRow label="Total COGS" amount={data.totalCogs} variant="orange" />
              </tbody>
            </table>

            <ProfitRow label="GROSS PROFIT" amount={data.grossProfit} />

            {/* OPERATING EXPENSES */}
            <SectionHeader title="OPERATING EXPENSES" className="mt-4" />
            <table className="w-full text-sm">
              <tbody>
                {data.operatingExpenses.length > 0 ? (
                  data.operatingExpenses.map((exp, i) => (
                    <StatementRow key={i} label={exp.name} amount={exp.amount} />
                  ))
                ) : (
                  <StatementRow label="No operating expenses recorded this period" amount={0} />
                )}
                <TotalRow label="Total Operating Expenses" amount={data.totalOperatingExpenses} variant="orange" />
              </tbody>
            </table>

            <div className={`flex justify-between items-center py-4 px-4 mt-4 rounded-lg ${data.netProfit >= 0 ? 'bg-green-600' : 'bg-red-600'}`}>
              <span className="text-base font-bold text-white tracking-wide">NET PROFIT / (LOSS)</span>
              <span className="text-xl font-bold text-white">{formatMoney(data.netProfit)}</span>
            </div>

            {data.estimatedManualCogs > 0 && (
              <div className="mt-3 bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 text-xs text-gray-500 leading-relaxed">
                <p>
                  <strong className="text-gray-700">Memo — Net Profit before estimated manual COGS: {formatMoney(data.netProfitBeforeEstimate)}.</strong>{' '}
                  The &ldquo;Estimated COGS — Manual Sales&rdquo; line applies the configured {data.manualCogsPercent}% to this
                  period&rsquo;s Sales Revenue — Manual (no COGS). It is a presentation estimate only and is not posted to
                  the general ledger — the dashboard, balance sheet and trial balance remain GL-based.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SectionHeader({ title, className = '' }: { title: string; className?: string }) {
  return (
    <div className={`py-2 px-4 bg-blue-50 border-b border-t border-gray-200 ${className}`}>
      <h4 className="text-xs font-bold text-blue-700 tracking-wide">{title}</h4>
    </div>
  );
}

function StatementRow({ label, amount, isDeduction = false, isBold = false }: { label: string; amount: number; isDeduction?: boolean; isBold?: boolean }) {
  const isNeg = amount < 0 || isDeduction;
  const abs = Math.abs(amount);
  return (
    <tr className="border-b border-gray-100 hover:bg-gray-50/50">
      <td className={`py-2.5 pl-4 text-gray-700 ${isBold ? 'font-semibold' : ''}`}>{label}</td>
      <td className="py-2.5 pr-4 text-right font-medium tabular-nums">
        {isNeg ? (
          <span className="text-red-600">({formatCurrency(abs)})</span>
        ) : (
          <span className={isBold ? 'text-gray-900 font-bold' : 'text-gray-800'}>{formatCurrency(abs)}</span>
        )}
      </td>
    </tr>
  );
}

function TotalRow({ label, amount, variant }: { label: string; amount: number; variant: 'blue' | 'orange' }) {
  const bgClass = variant === 'blue' ? 'bg-blue-100' : 'bg-orange-50';
  const textClass = variant === 'blue' ? 'text-blue-800' : 'text-orange-800';
  return (
    <tr className={`${bgClass} border-b border-gray-200`}>
      <td className="py-2.5 pl-4 font-semibold text-gray-800">{label}</td>
      <td className="py-2.5 pr-4 text-right font-bold tabular-nums">
        <span className={textClass}>{formatCurrency(amount)}</span>
      </td>
    </tr>
  );
}

function ProfitRow({ label, amount }: { label: string; amount: number }) {
  const isPositive = amount >= 0;
  return (
    <div className={`flex justify-between items-center py-3 px-4 mt-3 rounded-lg ${isPositive ? 'bg-green-100 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
      <span className="text-sm font-bold text-gray-800 tracking-wide">{label}</span>
      <span className={`text-lg font-bold tabular-nums ${isPositive ? 'text-green-700' : 'text-red-700'}`}>{formatCurrency(amount)}</span>
    </div>
  );
}
