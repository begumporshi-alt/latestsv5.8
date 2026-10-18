'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { formatCurrency, formatAxisCurrency } from '@/lib/format';
import { fetchAll } from '@/lib/fetch-all';
import {
  TrendingUp, Package, Users, Download, FileSpreadsheet, Calendar,
  ArrowRight, RefreshCw, Printer, Search, X, Tag, Layers, ShoppingCart, Receipt
} from 'lucide-react';
import {
  LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend
} from 'recharts';

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#6b7280', '#0ea5e9', '#d946ef', '#14b8a6', '#f97316'];

type Dimension = 'product' | 'brand' | 'category' | 'customer';
type View = 'summary' | Dimension;

interface BreakdownRow {
  id: string | null;
  name: string;
  unit: string | null;
  quantity: number;
  invoice_count: number;
  revenue: number;
  cost: number;
  profit: number;
}
interface MonthlyRow { month: string; revenue: number; cost: number }
interface DetailRow {
  invoice_id: string;
  invoice_number: string;
  invoice_date: string;
  customer_name: string | null;
  quantity: number;
  revenue: number;
  cost: number;
}

type SortKey = 'name' | 'quantity' | 'invoice_count' | 'revenue' | 'cost' | 'profit';

export default function SalesReportPage() {
  const [period, setPeriod] = useState('this_month');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [view, setView] = useState<View>('summary');
  const [loading, setLoading] = useState(true);
  const [dimLoading, setDimLoading] = useState<Dimension | null>(null);

  const [kpis, setKpis] = useState({ revenue: 0, orders: 0, returns: 0, cogs: 0, grossProfit: 0 });
  const [monthly, setMonthly] = useState<MonthlyRow[]>([]);
  const [breakdown, setBreakdown] = useState<Partial<Record<Dimension, BreakdownRow[]>>>({});

  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('revenue');
  const [sortAsc, setSortAsc] = useState(false);

  const [drill, setDrill] = useState<{ dim: Dimension; id: string | null; name: string } | null>(null);
  const [drillRows, setDrillRows] = useState<DetailRow[]>([]);
  const [drillLoading, setDrillLoading] = useState(false);

  const [refreshKey, setRefreshKey] = useState(0);

  // toISOString() renders local midnight as the previous UTC day (GMT+6 →
  // "This Month" would start on the 30th of the prior month). Build the
  // calendar date from local components instead.
  const toISODate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  function getDateRange(p: string): { startDate: string; endDate: string | null } {
    const now = new Date();
    const today = toISODate(now);
    switch (p) {
      case 'today': return { startDate: today, endDate: today };
      case 'this_week': {
        const ws = new Date(now); ws.setDate(ws.getDate() - ws.getDay());
        return { startDate: toISODate(ws), endDate: today };
      }
      case 'this_month': return { startDate: toISODate(new Date(now.getFullYear(), now.getMonth(), 1)), endDate: null };
      case 'this_quarter': {
        const qs = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
        return { startDate: toISODate(qs), endDate: null };
      }
      case 'this_year': return { startDate: toISODate(new Date(now.getFullYear(), 0, 1)), endDate: null };
      case 'custom': return { startDate: dateFrom || today, endDate: dateTo || null };
      default: return { startDate: today, endDate: null };
    }
  }

  const { startDate, endDate } = getDateRange(period);
  const today = toISODate(new Date());
  const effectiveStart = startDate;
  const effectiveEnd = endDate || today;

  useEffect(() => { loadSummary(); setBreakdown({}); }, [period, dateFrom, dateTo, refreshKey]);
  useEffect(() => {
    setSearch('');
    if (view !== 'summary' && !breakdown[view] && !dimLoading) loadBreakdown(view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  async function loadSummary() {
    setLoading(true);
    const [invoicesRes, accountsRes] = await Promise.all([
      fetchAll(() => supabase.from('invoices').select('total_amount, tax_amount, shipping_cost')
        .neq('status', 'cancelled').neq('status', 'draft')
        .gte('invoice_date', effectiveStart).lte('invoice_date', effectiveEnd)
        .order('invoice_date').order('id')),
      supabase.from('accounts').select('id, code').in('code', ['5000', '4050']),
    ]);

    const revenue = (invoicesRes || []).reduce((s: number, i: any) => s + Number(i.total_amount) - Number(i.tax_amount || 0) - Number(i.shipping_cost || 0), 0);

    const cogsAcc = (accountsRes.data || []).find((a: any) => a.code === '5000');
    const retAcc = (accountsRes.data || []).find((a: any) => a.code === '4050');
    const [cogsRes, retRes] = await Promise.all([
      cogsAcc ? supabase.rpc('period_net_debit', { p_account_id: cogsAcc.id, p_start_date: effectiveStart, p_end_date: effectiveEnd }) : Promise.resolve({ data: 0 }),
      retAcc ? supabase.rpc('period_net_debit', { p_account_id: retAcc.id, p_start_date: effectiveStart, p_end_date: effectiveEnd }) : Promise.resolve({ data: 0 }),
    ]);
    const cogs = Number(cogsRes.data || 0);
    const returns = Number(retRes.data || 0);

    setKpis({ revenue, orders: invoicesRes?.length || 0, returns, cogs, grossProfit: revenue - returns - cogs });

    const { data: monthlyData } = await supabase.rpc('sales_monthly', { p_start_date: effectiveStart, p_end_date: effectiveEnd });
    setMonthly(fillMonths((monthlyData || []) as MonthlyRow[]));

    // Summary shows the top-products table and category pie — fetch those
    // dimensions up front too (By Brand / By Customer still load on demand).
    const [prodRes, catRes] = await Promise.all([
      supabase.rpc('sales_breakdown', { p_dimension: 'product', p_start_date: effectiveStart, p_end_date: effectiveEnd }),
      supabase.rpc('sales_breakdown', { p_dimension: 'category', p_start_date: effectiveStart, p_end_date: effectiveEnd }),
    ]);
    setBreakdown(prev => ({
      ...prev,
      product: (prodRes.data || []) as BreakdownRow[],
      category: (catRes.data || []) as BreakdownRow[],
    }));
    setLoading(false);
  }

  // The RPC only returns months that have sales — pad the gaps so the
  // trend line shows zero-months instead of skipping them.
  function fillMonths(rows: MonthlyRow[]): MonthlyRow[] {
    const map = new Map(rows.map(r => [r.month, r]));
    const out: MonthlyRow[] = [];
    const cur = new Date(effectiveStart + 'T00:00:00');
    const end = new Date(effectiveEnd + 'T00:00:00');
    let guard = 0;
    while (cur <= end && guard < 60) {
      const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`;
      const row = map.get(key);
      out.push({ month: key, revenue: Number(row?.revenue || 0), cost: Number(row?.cost || 0) });
      cur.setMonth(cur.getMonth() + 1);
      guard++;
    }
    return out;
  }

  async function loadBreakdown(dim: Dimension) {
    setDimLoading(dim);
    const { data, error } = await supabase.rpc('sales_breakdown', {
      p_dimension: dim, p_start_date: effectiveStart, p_end_date: effectiveEnd,
    });
    if (!error) {
      setBreakdown(prev => ({ ...prev, [dim]: (data || []) as BreakdownRow[] }));
    }
    setDimLoading(null);
  }

  const rows = view === 'summary' ? (breakdown.product || []).slice(0, 10) : (breakdown[view as Dimension] || []);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matched = q ? rows.filter((r: BreakdownRow) => r.name.toLowerCase().includes(q)) : rows;
    const sorted = [...matched].sort((a: BreakdownRow, b: BreakdownRow) => {
      if (sortKey === 'name') return sortAsc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
      return sortAsc ? a[sortKey] - b[sortKey] : b[sortKey] - a[sortKey];
    });
    return sorted;
  }, [rows, search, sortKey, sortAsc]);

  const totals = useMemo(() => filteredRows.reduce((acc, r) => ({
    quantity: acc.quantity + r.quantity,
    invoice_count: acc.invoice_count + r.invoice_count,
    revenue: acc.revenue + r.revenue,
    cost: acc.cost + r.cost,
    profit: acc.profit + r.profit,
  }), { quantity: 0, invoice_count: 0, revenue: 0, cost: 0, profit: 0 }), [filteredRows]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(key === 'name'); }
  }

  function openDrill(dim: Dimension, row: BreakdownRow) {
    setDrill({ dim, id: row.id, name: row.name });
    setDrillRows([]);
    setDrillLoading(true);
    supabase.rpc('sales_breakdown_detail', {
      p_dimension: dim, p_dimension_id: row.id, p_start_date: effectiveStart, p_end_date: effectiveEnd,
    }).then(({ data }) => {
      setDrillRows((data || []) as DetailRow[]);
      setDrillLoading(false);
    });
  }

  function exportToCSV() {
    let csv = '';
    let filename = 'sales_report';
    if (view === 'summary') {
      csv = 'Month,Revenue,Cost,Gross Profit\n' + monthly.map(m => `${m.month},${m.revenue},${m.cost},${m.revenue - m.cost}`).join('\n');
    } else {
      filename = `sales_by_${view}`;
      csv = `${view === 'product' ? 'Product' : view === 'brand' ? 'Brand' : view === 'category' ? 'Category' : 'Customer'},Quantity,Invoices,Revenue,Cost,Profit,Margin %\n`
        + filteredRows.map(r => `"${r.name}",${r.quantity},${r.invoice_count},${r.revenue},${r.cost},${r.profit},${r.revenue > 0 ? ((r.profit / r.revenue) * 100).toFixed(1) : 0}`).join('\n')
        + `\nTOTAL,${totals.quantity},${totals.invoice_count},${totals.revenue},${totals.cost},${totals.profit},${totals.revenue > 0 ? ((totals.profit / totals.revenue) * 100).toFixed(1) : 0}`;
    }
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}_${effectiveStart}_to_${effectiveEnd}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const views: { id: View; label: string; icon: any }[] = [
    { id: 'summary', label: 'Summary', icon: TrendingUp },
    { id: 'product', label: 'By Product', icon: Package },
    { id: 'brand', label: 'By Brand', icon: Tag },
    { id: 'category', label: 'By Category', icon: Layers },
    { id: 'customer', label: 'By Customer', icon: Users },
  ];

  const periodLabel = { today: 'Today', this_week: 'This Week', this_month: 'This Month', this_quarter: 'This Quarter', this_year: 'This Year', custom: 'Custom Range' }[period] || period;

  const chartData = monthly.map(m => ({ ...m, profit: m.revenue - m.cost, label: m.month.slice(2) }));

  return (
    <div className="space-y-5 animate-fade-in print-modal">
      <div className="hidden print:block mb-4 border-b border-border pb-3">
        <h1 className="text-xl font-bold">Sales Report</h1>
        <p className="text-sm text-muted-foreground">Period: {effectiveStart} to {effectiveEnd} · Generated {new Date().toLocaleString()}</p>
      </div>

      <div className="flex items-center justify-between flex-wrap gap-3 print:hidden">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Sales Report</h1>
          <p className="text-muted-foreground text-sm mt-0.5 flex items-center gap-1.5"><Calendar className="w-3.5 h-3.5" />{periodLabel}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select value={period} onChange={e => setPeriod(e.target.value)} className="border border-border rounded-lg px-3 py-2 text-sm focus:outline-none bg-white">
            <option value="today">Today</option>
            <option value="this_week">This Week</option>
            <option value="this_month">This Month</option>
            <option value="this_quarter">This Quarter</option>
            <option value="this_year">This Year</option>
            <option value="custom">Custom Range</option>
          </select>
          {period === 'custom' && (
            <div className="flex items-center gap-1">
              <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="border border-border rounded-lg px-2 py-1.5 text-sm focus:outline-none" />
              <span className="text-muted-foreground">-</span>
              <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="border border-border rounded-lg px-2 py-1.5 text-sm focus:outline-none" />
            </div>
          )}
          <button onClick={() => setRefreshKey(k => k + 1)} className="flex items-center gap-1.5 border border-border px-3 py-2 rounded-lg text-sm hover:bg-muted transition">
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

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 print:grid-cols-6">
            <div className="stat-card">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs text-muted-foreground">Revenue</p>
                <TrendingUp className="w-4 h-4 text-green-500" />
              </div>
              <p className="text-lg font-bold text-foreground">{formatCurrency(kpis.revenue)}</p>
              <p className="text-xs text-muted-foreground mt-1">net of VAT &amp; shipping</p>
            </div>
            <div className="stat-card">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs text-muted-foreground">Invoices</p>
                <Receipt className="w-4 h-4 text-blue-500" />
              </div>
              <p className="text-2xl font-bold text-foreground">{kpis.orders}</p>
              <p className="text-xs text-muted-foreground mt-1">non-cancelled</p>
            </div>
            <div className="stat-card">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs text-muted-foreground">Sales Returns</p>
                <ShoppingCart className="w-4 h-4 text-orange-500" />
              </div>
              <p className="text-lg font-bold text-red-600">{kpis.returns > 0 ? formatCurrency(kpis.returns) : '—'}</p>
              <p className="text-xs text-muted-foreground mt-1">account 4050</p>
            </div>
            <div className="stat-card">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs text-muted-foreground">COGS</p>
                <Package className="w-4 h-4 text-amber-500" />
              </div>
              <p className="text-lg font-bold text-red-600">{formatCurrency(kpis.cogs)}</p>
              <p className="text-xs text-muted-foreground mt-1">{kpis.revenue > 0 ? ((kpis.cogs / kpis.revenue) * 100).toFixed(1) : 0}% of revenue</p>
            </div>
            <div className="stat-card">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs text-muted-foreground">Gross Profit</p>
                <TrendingUp className="w-4 h-4 text-green-500" />
              </div>
              <p className="text-lg font-bold text-green-600">{formatCurrency(kpis.grossProfit)}</p>
              <p className="text-xs font-medium mt-1">{kpis.revenue > 0 ? ((kpis.grossProfit / kpis.revenue) * 100).toFixed(1) : 0}% margin</p>
            </div>
            <div className="stat-card">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs text-muted-foreground">Avg. Invoice</p>
                <Receipt className="w-4 h-4 text-purple-500" />
              </div>
              <p className="text-lg font-bold text-foreground">{formatCurrency(kpis.orders > 0 ? kpis.revenue / kpis.orders : 0)}</p>
              <p className="text-xs text-muted-foreground mt-1">per invoice</p>
            </div>
          </div>

          <div className="flex gap-1 bg-muted/50 p-1 rounded-xl w-fit overflow-x-auto print:hidden">
            {views.map(v => (
              <button
                key={v.id}
                onClick={() => setView(v.id)}
                className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition whitespace-nowrap ${view === v.id ? 'bg-white text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              >
                <v.icon className="w-4 h-4" />
                {v.label}
              </button>
            ))}
          </div>

          {view === 'summary' && (
            <div className="space-y-4">
              <div className="bg-white rounded-xl border border-border p-5 shadow-sm">
                <h3 className="text-sm font-semibold text-foreground mb-4">Revenue &amp; Gross Profit Trend</h3>
                <ResponsiveContainer width="100%" height={280}>
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} tickFormatter={v => formatAxisCurrency(v)} />
                    <Tooltip formatter={(v: number) => [formatCurrency(v), '']} contentStyle={{ fontSize: 11, borderRadius: 8 }} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line type="monotone" dataKey="revenue" stroke="#3b82f6" strokeWidth={2} name="Revenue" dot={false} />
                    <Line type="monotone" dataKey="profit" stroke="#10b981" strokeWidth={2} name="Gross Profit" dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="table-wrapper">
                  <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-foreground">Top 10 Products</h3>
                    <button onClick={() => setView('product')} className="text-xs text-blue-600 hover:underline flex items-center gap-1">View all <ArrowRight className="w-3 h-3" /></button>
                  </div>
                  <table className="w-full">
                    <thead><tr className="bg-muted/40 border-b border-border">
                      {['#', 'Product', 'Qty', 'Revenue', 'Profit'].map(h => <th key={h} className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">{h}</th>)}
                    </tr></thead>
                    <tbody className="divide-y divide-border">
                      {rows.length > 0 ? rows.map((p, i) => (
                        <tr key={p.id || i} className="hover:bg-muted/30 transition-colors">
                          <td className="px-4 py-2.5 text-sm text-muted-foreground">{i + 1}</td>
                          <td className="px-4 py-2.5 text-sm font-semibold text-foreground">{p.name}</td>
                          <td className="px-4 py-2.5 text-sm text-foreground">{p.quantity}</td>
                          <td className="px-4 py-2.5 text-sm font-semibold text-foreground">{formatCurrency(p.revenue)}</td>
                          <td className={`px-4 py-2.5 text-sm font-semibold ${p.profit > 0 ? 'text-green-600' : 'text-red-600'}`}>{formatCurrency(p.profit)}</td>
                        </tr>
                      )) : (
                        <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground text-sm">No product sales in this period</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="bg-white rounded-xl border border-border p-5 shadow-sm">
                  <h3 className="text-sm font-semibold text-foreground mb-4">Revenue by Category</h3>
                  {(breakdown.category || []).length > 0 ? (
                    <div className="flex items-center gap-4">
                      <ResponsiveContainer width={160} height={160}>
                        <PieChart>
                          <Pie data={(breakdown.category || []).slice(0, 8)} cx="50%" cy="50%" innerRadius={45} outerRadius={70} paddingAngle={2} dataKey="revenue">
                            {(breakdown.category || []).slice(0, 8).map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                          </Pie>
                          <Tooltip formatter={(v: number) => [formatCurrency(v), '']} contentStyle={{ fontSize: 11, borderRadius: 8 }} />
                        </PieChart>
                      </ResponsiveContainer>
                      <div className="flex-1 space-y-2">
                        {(breakdown.category || []).slice(0, 8).map((cat, i) => (
                          <div key={cat.id || i} className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-1.5">
                              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                              <span className="text-xs text-muted-foreground truncate">{cat.name}</span>
                            </div>
                            <span className="text-xs font-semibold text-foreground">{formatCurrency(cat.revenue)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="text-center py-8 text-muted-foreground text-sm">
                      {dimLoading === 'category' ? 'Loading…' : 'No category data in this period'}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {view !== 'summary' && (
            <div className="table-wrapper">
              <div className="px-4 py-3 border-b border-border flex items-center justify-between flex-wrap gap-2">
                <h3 className="text-sm font-semibold text-foreground capitalize">Sales by {view}</h3>
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder={`Search ${view}…`}
                    className="border border-border rounded-lg pl-8 pr-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 w-56"
                  />
                </div>
              </div>
              {dimLoading === view ? (
                <div className="flex items-center justify-center py-12">
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600" />
                </div>
              ) : (
                <table className="w-full">
                  <thead><tr className="bg-muted/40 border-b border-border">
                    {[['#', null], [view === 'product' ? 'Product' : view === 'brand' ? 'Brand' : view === 'category' ? 'Category' : 'Customer', 'name'],
                      ['Qty Sold', 'quantity'], ['Invoices', 'invoice_count'], ['Revenue', 'revenue'], ['Cost', 'cost'], ['Profit', 'profit'],
                      ['Margin', null], ['% of Rev', null]].map(([h, key], idx) => (
                      <th
                        key={idx}
                        onClick={key ? () => toggleSort(key as SortKey) : undefined}
                        className={`text-left text-xs font-semibold text-muted-foreground px-4 py-3 ${key ? 'cursor-pointer hover:text-foreground select-none' : ''}`}
                      >
                        {h}{key === sortKey ? (sortAsc ? ' ▲' : ' ▼') : ''}
                      </th>
                    ))}
                  </tr></thead>
                  <tbody className="divide-y divide-border">
                    {filteredRows.length > 0 ? filteredRows.map((r, i) => {
                      return (
                        <tr
                          key={r.id || `idx-${i}`}
                          onClick={() => openDrill(view as Dimension, r)}
                          className="hover:bg-muted/30 transition-colors cursor-pointer"
                          title="Click to see invoices"
                        >
                          <td className="px-4 py-2.5 text-sm text-muted-foreground">{i + 1}</td>
                          <td className="px-4 py-2.5 text-sm font-semibold text-foreground">{r.name}</td>
                          <td className="px-4 py-2.5 text-sm text-foreground">
                            {r.quantity}{r.unit ? <span className="text-muted-foreground text-xs ml-1">{r.unit}</span> : null}
                          </td>
                          <td className="px-4 py-2.5 text-sm text-foreground">{r.invoice_count}</td>
                          <td className="px-4 py-2.5 text-sm font-semibold text-foreground">{formatCurrency(r.revenue)}</td>
                          <td className="px-4 py-2.5 text-sm text-red-600">{formatCurrency(r.cost)}</td>
                          <td className={`px-4 py-2.5 text-sm font-semibold ${r.profit > 0 ? 'text-green-600' : 'text-red-600'}`}>{formatCurrency(r.profit)}</td>
                          <td className="px-4 py-2.5">
                            <span className={`text-xs font-medium ${r.profit > 0 ? 'text-green-600' : 'text-red-600'}`}>
                              {r.revenue > 0 ? ((r.profit / r.revenue) * 100).toFixed(1) : 0}%
                            </span>
                          </td>
                          <td className="px-4 py-2.5">
                            <span className="text-xs text-muted-foreground">{totals.revenue > 0 ? ((r.revenue / totals.revenue) * 100).toFixed(1) : 0}%</span>
                          </td>
                        </tr>
                      );
                    }) : (
                      <tr><td colSpan={9} className="px-4 py-8 text-center text-muted-foreground text-sm">
                        {search ? 'No matches for your search' : `No ${view} sales in this period`}
                      </td></tr>
                    )}
                  </tbody>
                  {filteredRows.length > 0 && (
                    <tfoot>
                      <tr className="bg-muted/40 border-t border-border font-semibold">
                        <td className="px-4 py-3 text-sm text-foreground" colSpan={2}>TOTAL</td>
                        <td className="px-4 py-3 text-sm text-foreground">{totals.quantity}</td>
                        <td className="px-4 py-3 text-sm text-foreground">{totals.invoice_count}</td>
                        <td className="px-4 py-3 text-sm text-foreground">{formatCurrency(totals.revenue)}</td>
                        <td className="px-4 py-3 text-sm text-red-600">{formatCurrency(totals.cost)}</td>
                        <td className="px-4 py-3 text-sm text-green-600">{formatCurrency(totals.profit)}</td>
                        <td className="px-4 py-3 text-xs text-foreground">{totals.revenue > 0 ? ((totals.profit / totals.revenue) * 100).toFixed(1) : 0}%</td>
                        <td className="px-4 py-3" />
                      </tr>
                    </tfoot>
                  )}
                </table>
              )}
            </div>
          )}

          <p className="text-xs text-muted-foreground print:hidden">
            Revenue basis: invoice line subtotals (VAT and shipping are billed at invoice level).
            COGS basis: cost price recorded on each line at time of sale. Click any row to see its invoices.
          </p>
        </>
      )}

      {drill && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 print:hidden" onClick={() => setDrill(null)}>
          <div className="absolute inset-0 bg-black/50" />
          <div className="relative bg-white rounded-xl shadow-xl border border-border w-full max-w-3xl max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <div>
                <h3 className="text-sm font-bold text-foreground">{drill.name}</h3>
                <p className="text-xs text-muted-foreground">Invoices · {effectiveStart} to {effectiveEnd}</p>
              </div>
              <button onClick={() => setDrill(null)} className="p-1.5 hover:bg-muted rounded-lg transition">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="overflow-y-auto flex-1">
              {drillLoading ? (
                <div className="flex items-center justify-center py-10">
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600" />
                </div>
              ) : drillRows.length === 0 ? (
                <div className="text-center py-10 text-muted-foreground text-sm">No invoices found</div>
              ) : (
                <table className="w-full">
                  <thead className="sticky top-0 bg-white">
                    <tr className="bg-muted/40 border-b border-border">
                      {['Invoice #', 'Date', 'Customer', 'Qty', 'Revenue', 'Cost', 'Profit'].map(h => (
                        <th key={h} className="text-left text-xs font-semibold text-muted-foreground px-4 py-2.5">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {drillRows.map(d => (
                      <tr key={d.invoice_id} className="hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-2.5 text-sm font-semibold text-blue-600">{d.invoice_number}</td>
                        <td className="px-4 py-2.5 text-sm text-foreground">{d.invoice_date}</td>
                        <td className="px-4 py-2.5 text-sm text-foreground">{d.customer_name || '—'}</td>
                        <td className="px-4 py-2.5 text-sm text-foreground">{d.quantity}</td>
                        <td className="px-4 py-2.5 text-sm font-semibold text-foreground">{formatCurrency(d.revenue)}</td>
                        <td className="px-4 py-2.5 text-sm text-red-600">{formatCurrency(d.cost)}</td>
                        <td className={`px-4 py-2.5 text-sm font-semibold ${d.revenue - d.cost > 0 ? 'text-green-600' : 'text-red-600'}`}>{formatCurrency(d.revenue - d.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-muted/40 border-t border-border font-semibold">
                      <td className="px-4 py-2.5 text-sm" colSpan={3}>TOTAL ({drillRows.length} invoices)</td>
                      <td className="px-4 py-2.5 text-sm">{drillRows.reduce((s, d) => s + d.quantity, 0)}</td>
                      <td className="px-4 py-2.5 text-sm">{formatCurrency(drillRows.reduce((s, d) => s + d.revenue, 0))}</td>
                      <td className="px-4 py-2.5 text-sm text-red-600">{formatCurrency(drillRows.reduce((s, d) => s + d.cost, 0))}</td>
                      <td className="px-4 py-2.5 text-sm text-green-600">{formatCurrency(drillRows.reduce((s, d) => s + d.revenue - d.cost, 0))}</td>
                    </tr>
                  </tfoot>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="hidden print:block text-center text-xs text-muted-foreground mt-4">
        <Link href="/reports" className="no-underline text-muted-foreground">Reports &amp; Analytics</Link> · Sales Report · {effectiveStart} to {effectiveEnd}
      </div>
    </div>
  );
}
