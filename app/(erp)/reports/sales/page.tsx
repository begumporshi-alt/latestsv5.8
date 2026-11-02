'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  BarChart3,
  Calendar,
  Download,
  Layers,
  Loader2,
  Package,
  Printer,
  Receipt,
  RefreshCw,
  Search,
  ShoppingCart,
  Table2,
  Tag,
  TrendingUp,
  Users,
  X,
  CloudOff,
  ChevronDown,
} from 'lucide-react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';
import { formatAxisCurrency, formatCurrency } from '@/lib/format';
import { useProfile } from '@/hooks/use-profile';
import Pagination from '@/components/ui/AppPagination';
import SalesReportDocument, { type CompanyInfo } from '@/components/reports/SalesReportDocument';
import RevenueCompositionCard from '@/components/reports/RevenueCompositionCard';
import {
  DonutChart,
  HorizontalBarChart,
  ParetoChart,
  dimensionTotal,
  toChartData,
} from '@/components/reports/SalesCharts';
import {
  DIMENSIONS,
  PERIOD_OPTIONS,
  fetchSalesBreakdown,
  marginPct,
  salesKeys,
  type BreakdownRow,
  type Dimension,
  type View,
} from '@/lib/reports/sales-report';
import {
  usePrefetchBreakdown,
  useReportPeriod,
  useSalesBreakdown,
  useSalesDetail,
  useSalesSummary,
} from '@/lib/reports/use-sales-report';
import {
  DIMENSION_TABS,
  useSalesReportStore,
  type ChartMetric,
  type PrintScope,
} from '@/lib/reports/sales-report-store';
import { printReportDocument } from '@/lib/reports/print-report';

type SortKey = 'name' | 'quantity' | 'invoice_count' | 'revenue' | 'cost' | 'profit';

const TAB_ICON: Record<View, typeof TrendingUp> = {
  summary: TrendingUp,
  product: Package,
  brand: Tag,
  category: Layers,
  customer: Users,
};

export default function SalesReportPage() {
  const period = useSalesReportStore((s) => s.period);
  const dateFrom = useSalesReportStore((s) => s.dateFrom);
  const dateTo = useSalesReportStore((s) => s.dateTo);
  const view = useSalesReportStore((s) => s.view);
  const displayMode = useSalesReportStore((s) => s.displayMode);
  const topN = useSalesReportStore((s) => s.topN);
  const metric = useSalesReportStore((s) => s.metric);
  const printScope = useSalesReportStore((s) => s.printScope);
  const setPeriod = useSalesReportStore((s) => s.setPeriod);
  const setCustomRange = useSalesReportStore((s) => s.setCustomRange);
  const setView = useSalesReportStore((s) => s.setView);
  const setDisplayMode = useSalesReportStore((s) => s.setDisplayMode);
  const setTopN = useSalesReportStore((s) => s.setTopN);
  const setMetric = useSalesReportStore((s) => s.setMetric);
  const setPrintScope = useSalesReportStore((s) => s.setPrintScope);

  const resolved = useReportPeriod();
  const { start, end } = resolved;

  const queryClient = useQueryClient();
  const prefetchBreakdown = usePrefetchBreakdown(start, end);
  const { profile } = useProfile();

  const summaryQuery = useSalesSummary(start, end);
  const summary = summaryQuery.data;

  const dimension: Dimension | null = view === 'summary' ? null : view;
  const breakdownQuery = useSalesBreakdown(dimension ?? 'product', start, end, {
    enabled: dimension !== null,
    placeholderRows: dimension ? summary?.dimensions[dimension].rows : undefined,
  });

  const companyQuery = useQuery({
    queryKey: ['settings', 'company'],
    queryFn: async (): Promise<CompanyInfo> => {
      const { data } = await supabase
        .from('app_settings')
        .select('setting_value')
        .eq('setting_key', 'company')
        .maybeSingle();
      const value = (data?.setting_value || {}) as Partial<CompanyInfo>;
      return {
        name: value.name || 'SI Building Solutions',
        address: value.address,
        phone: value.phone,
        email: value.email,
        logo_url: value.logo_url,
      };
    },
    staleTime: 30 * 60_000,
  });

  // --- transient view state (never persisted: a report should reopen clean) --
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('revenue');
  const [sortAsc, setSortAsc] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [drill, setDrill] = useState<{ dim: Dimension; id: string | null; name: string } | null>(null);
  const drillQuery = useSalesDetail(drill?.dim ?? null, drill?.id ?? null, start, end, !!drill);

  const [printMenu, setPrintMenu] = useState(false);
  const [printBusy, setPrintBusy] = useState(false);
  const [fullRows, setFullRows] = useState<Partial<Record<Dimension, BreakdownRow[]>>>({});
  const printRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSearch('');
    setPage(1);
  }, [view, period, dateFrom, dateTo]);

  // ------------------------------------------------------------------ rows --

  const rows: BreakdownRow[] = useMemo(() => {
    if (!dimension) return [];
    return breakdownQuery.data ?? summary?.dimensions[dimension].rows ?? [];
  }, [dimension, breakdownQuery.data, summary]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matched = q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows;
    return [...matched].sort((a, b) => {
      if (sortKey === 'name') return sortAsc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
      return sortAsc ? a[sortKey] - b[sortKey] : b[sortKey] - a[sortKey];
    });
  }, [rows, search, sortKey, sortAsc]);

  const totals = useMemo(
    () =>
      filteredRows.reduce(
        (acc, r) => ({
          quantity: acc.quantity + r.quantity,
          invoice_count: acc.invoice_count + r.invoice_count,
          revenue: acc.revenue + r.revenue,
          cost: acc.cost + r.cost,
          profit: acc.profit + r.profit,
        }),
        { quantity: 0, invoice_count: 0, revenue: 0, cost: 0, profit: 0 },
      ),
    [filteredRows],
  );

  const safePage = Math.min(page, Math.max(1, Math.ceil(filteredRows.length / pageSize)));
  const pagedRows = useMemo(
    () => filteredRows.slice((safePage - 1) * pageSize, safePage * pageSize),
    [filteredRows, safePage, pageSize],
  );

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc(!sortAsc);
    else {
      setSortKey(key);
      setSortAsc(key === 'name');
    }
  }

  // ----------------------------------------------------------------- chart --

  const chartLimit = topN === 0 ? Math.min(rows.length, 60) : topN;
  const chartData = useMemo(
    () => toChartData(rows, metric, chartLimit),
    [rows, metric, chartLimit],
  );
  // Denominator for every chart share: the whole dimension, not the top-N cut.
  const chartTotal = useMemo(() => dimensionTotal(rows, metric), [rows, metric]);

  // ----------------------------------------------------------------- print --

  async function handlePrint(scope: PrintScope) {
    setPrintMenu(false);
    setPrintBusy(true);
    try {
      if (scope === 'full') {
        // Printing every section needs every full list. This is the one place
        // a deliberate, user-initiated fetch of all four is correct.
        const lists = await Promise.all(
          DIMENSIONS.map((dim) =>
            queryClient.ensureQueryData({
              queryKey: salesKeys.breakdown(dim, start, end),
              queryFn: () => fetchSalesBreakdown(dim, start, end),
              staleTime: 5 * 60_000,
            }),
          ),
        );
        setFullRows(
          DIMENSIONS.reduce<Partial<Record<Dimension, BreakdownRow[]>>>((acc, dim, i) => {
            acc[dim] = lists[i];
            return acc;
          }, {}),
        );
      } else {
        setFullRows((prev) => {
          const next: Partial<Record<Dimension, BreakdownRow[]>> = {};
          if (dimension) next[dimension] = breakdownQuery.data ?? summary?.dimensions[dimension].rows;
          return next;
        });
      }

      setPrintScope(scope);
      // Two frames: one for the store update, one for the document commit.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );

      const title = `Sales report · ${resolved.label}`;
      const opened = printReportDocument(printRef.current, title);
      if (!opened) {
        // Popup blocked — the same node is print-visible, so the in-page path
        // produces the identical document.
        window.print();
      }
    } finally {
      setPrintBusy(false);
    }
  }

  // ------------------------------------------------------------------ csv ---

  function exportToCSV() {
    let csv = '';
    let filename = 'sales_report';

    if (view === 'summary' && summary) {
      const header = 'Month,Revenue,Cost,Gross Profit\n';
      csv =
        header +
        summary.monthly
          .map((m) => `${m.month},${m.revenue.toFixed(2)},${m.cost.toFixed(2)},${(m.revenue - m.cost).toFixed(2)}`)
          .join('\n');
      filename = `sales_summary_${start}_to_${end}`;
    } else {
      const label = view === 'product' ? 'Product' : view === 'brand' ? 'Brand' : view === 'category' ? 'Category' : 'Customer';
      csv =
        `${label},Quantity,Invoices,Revenue,Cost,Profit,Margin %\n` +
        filteredRows
          .map(
            (r) =>
              `"${r.name.replace(/"/g, '""')}",${r.quantity},${r.invoice_count},${r.revenue.toFixed(2)},${r.cost.toFixed(2)},${r.profit.toFixed(2)},${marginPct(r.profit, r.revenue).toFixed(1)}`,
          )
          .join('\n') +
        `\nTOTAL,${totals.quantity},${totals.invoice_count},${totals.revenue.toFixed(2)},${totals.cost.toFixed(2)},${totals.profit.toFixed(2)},${marginPct(totals.profit, totals.revenue).toFixed(1)}`;
      filename = `sales_by_${view}_${start}_to_${end}`;
    }

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---------------------------------------------------------------- render --

  const kpis = summary?.kpis;
  const isOfflineSource = summary?.source === 'cache' || summary?.source === 'replica';
  const loading = summaryQuery.isLoading;

  return (
    <>
      <div className="space-y-5 animate-fade-in print:hidden">
        {/* ---------------------------------------------------------- header */}
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Sales report</h1>
            <p className="text-muted-foreground text-sm mt-0.5 flex items-center gap-1.5">
              <Calendar className="w-3.5 h-3.5" />
              {resolved.label}
              <span className="text-muted-foreground/60">·</span>
              <span className="tabular-nums">
                {start} to {end}
              </span>
            </p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={period}
              onChange={(e) => setPeriod(e.target.value as typeof period)}
              className="border border-border rounded-lg px-3 py-2 text-sm focus:outline-none bg-white"
            >
              {PERIOD_OPTIONS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>

            {period === 'custom' && (
              <div className="flex items-center gap-1">
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setCustomRange(e.target.value, dateTo)}
                  className="border border-border rounded-lg px-2 py-1.5 text-sm focus:outline-none"
                />
                <span className="text-muted-foreground">–</span>
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setCustomRange(dateFrom, e.target.value)}
                  className="border border-border rounded-lg px-2 py-1.5 text-sm focus:outline-none"
                />
              </div>
            )}

            <button
              onClick={() => queryClient.invalidateQueries({ queryKey: ['sales-report'] })}
              title="Refresh"
              className="flex items-center gap-1.5 border border-border px-3 py-2 rounded-lg text-sm hover:bg-muted transition"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${summaryQuery.isFetching ? 'animate-spin' : ''}`} />
            </button>

            <div className="relative">
              <button
                onClick={() => setPrintMenu((v) => !v)}
                disabled={printBusy || loading}
                className="flex items-center gap-1.5 border border-border px-3 py-2 rounded-lg text-sm hover:bg-muted transition disabled:opacity-50"
              >
                {printBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Printer className="w-3.5 h-3.5" />}
                Print
                <ChevronDown className="w-3 h-3" />
              </button>
              {printMenu && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setPrintMenu(false)} />
                  <div className="absolute right-0 mt-1 w-64 bg-white border border-border rounded-lg shadow-lg z-20 overflow-hidden">
                    <button
                      onClick={() => handlePrint('current')}
                      className="w-full text-left px-3 py-2.5 hover:bg-muted/60 transition"
                    >
                      <div className="text-sm font-medium text-foreground">Current view</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        Cover page + {view === 'summary' ? 'summary only' : 'this section, every row'}
                      </div>
                    </button>
                    <button
                      onClick={() => handlePrint('full')}
                      className="w-full text-left px-3 py-2.5 hover:bg-muted/60 transition border-t border-border"
                    >
                      <div className="text-sm font-medium text-foreground">Full report</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        Cover + product, brand, category and customer
                      </div>
                    </button>
                  </div>
                </>
              )}
            </div>

            <button
              onClick={exportToCSV}
              disabled={loading}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition disabled:opacity-50"
            >
              <Download className="w-4 h-4" />
              Export
            </button>
          </div>
        </div>

        {/* ------------------------------------------------- offline notice */}
        {isOfflineSource && summary && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <CloudOff className="w-4 h-4 shrink-0 mt-0.5" />
            <div>
              {summary.source === 'replica' ? (
                <>
                  <span className="font-medium">Computed on this device.</span> The connection is
                  unavailable, so figures come from the local replica — accurate as of the last
                  sync, and may exclude sales made on other devices since then.
                </>
              ) : (
                <>
                  <span className="font-medium">Showing the last saved copy.</span> This period was
                  loaded while online and is being served from the device cache.
                </>
              )}
            </div>
          </div>
        )}

        {/* ------------------------------------------------------------ KPIs */}
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
          </div>
        ) : summaryQuery.isError ? (
          <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-center">
            <p className="text-sm font-medium text-red-900">Could not load the sales report</p>
            <p className="text-xs text-red-700 mt-1">
              {(summaryQuery.error as Error)?.message || 'Unknown error'}
            </p>
            <button
              onClick={() => summaryQuery.refetch()}
              className="mt-3 text-xs font-medium text-red-900 underline"
            >
              Try again
            </button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
              <KpiCard
                label="Revenue"
                value={formatCurrency(kpis?.revenue ?? 0)}
                hint="net of VAT, shipping and cart discount"
                icon={<TrendingUp className="w-4 h-4 text-blue-600" />}
              />
              <KpiCard
                label="Invoices"
                value={(kpis?.orders ?? 0).toLocaleString('en-US')}
                hint="cancelled and draft excluded"
                icon={<Receipt className="w-4 h-4 text-slate-500" />}
              />
              <KpiCard
                label="Sales returns"
                value={formatCurrency(kpis?.returns ?? 0)}
                hint="account 4050"
                icon={<ShoppingCart className="w-4 h-4 text-amber-500" />}
                tone="negative"
              />
              <KpiCard
                label="COGS"
                value={formatCurrency(kpis?.cogs ?? 0)}
                hint={
                  kpis && kpis.revenue > 0
                    ? `${((kpis.cogs / kpis.revenue) * 100).toFixed(1)}% of revenue`
                    : 'account 5000'
                }
                icon={<Package className="w-4 h-4 text-amber-500" />}
                tone="negative"
              />
              <KpiCard
                label="Gross profit"
                value={formatCurrency(kpis?.gross_profit ?? 0)}
                hint={kpis ? `${marginPct(kpis.gross_profit, kpis.revenue).toFixed(1)}% margin` : ''}
                icon={<TrendingUp className="w-4 h-4 text-green-600" />}
                tone="positive"
              />
              <KpiCard
                label="Avg. invoice"
                value={formatCurrency(kpis?.avg_invoice ?? 0)}
                hint="per invoice"
                icon={<Receipt className="w-4 h-4 text-slate-500" />}
              />
            </div>

            {/* ------------------------------------------------------- tabs */}
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex gap-1 bg-muted/50 p-1 rounded-xl w-fit overflow-x-auto">
                {DIMENSION_TABS.map((t) => {
                  const Icon = TAB_ICON[t.id];
                  const active = view === t.id;
                  return (
                    <button
                      key={t.id}
                      onClick={() => setView(t.id)}
                      onMouseEnter={() => t.id !== 'summary' && prefetchBreakdown(t.id as Dimension)}
                      onFocus={() => t.id !== 'summary' && prefetchBreakdown(t.id as Dimension)}
                      className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition whitespace-nowrap ${
                        active ? 'bg-white text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <Icon className="w-4 h-4" />
                      {t.label}
                    </button>
                  );
                })}
              </div>

              {view !== 'summary' && (
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="flex items-center bg-muted/50 rounded-lg p-0.5">
                    <button
                      onClick={() => setDisplayMode(view, 'table')}
                      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition ${
                        displayMode[view] === 'table' ? 'bg-white shadow-sm text-foreground' : 'text-muted-foreground'
                      }`}
                    >
                      <Table2 className="w-3.5 h-3.5" />
                      Table
                    </button>
                    <button
                      onClick={() => setDisplayMode(view, 'chart')}
                      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition ${
                        displayMode[view] === 'chart' ? 'bg-white shadow-sm text-foreground' : 'text-muted-foreground'
                      }`}
                    >
                      <BarChart3 className="w-3.5 h-3.5" />
                      Chart
                    </button>
                  </div>

                  {displayMode[view] === 'chart' && (
                    <>
                      <select
                        value={metric}
                        onChange={(e) => setMetric(e.target.value as ChartMetric)}
                        className="border border-border rounded-lg px-2.5 py-1.5 text-xs bg-white focus:outline-none"
                      >
                        <option value="revenue">Revenue</option>
                        <option value="profit">Gross profit</option>
                        <option value="quantity">Quantity</option>
                      </select>
                      <select
                        value={topN}
                        onChange={(e) => setTopN(Number(e.target.value))}
                        className="border border-border rounded-lg px-2.5 py-1.5 text-xs bg-white focus:outline-none"
                      >
                        <option value={10}>Top 10</option>
                        <option value={25}>Top 25</option>
                        <option value={50}>Top 50</option>
                        <option value={0}>All</option>
                      </select>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* ---------------------------------------------------- summary */}
            {view === 'summary' && (
              <div className="space-y-4">
                {/* A trend needs at least two points. For a single-month period
                    the series has one bucket, which Recharts draws as a lone
                    dot on an otherwise empty axis — it reads as a broken chart
                    rather than as information. The KPI strip above already
                    carries that month's figures, so the card is omitted. Same
                    rule as the printed document. */}
                {(summary?.monthly.length ?? 0) > 1 && (
                  <div className="bg-white rounded-xl border border-border p-5 shadow-sm">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-sm font-semibold text-foreground">Revenue &amp; gross profit trend</h3>
                      <span className="text-xs text-muted-foreground">
                        {summary?.monthly.length} months with activity
                      </span>
                    </div>
                    <ResponsiveContainer width="100%" height={280}>
                      <LineChart data={(summary?.monthly ?? []).map((m) => ({ ...m, profit: m.revenue - m.cost, label: m.month.slice(2) }))}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                        <XAxis dataKey="label" tick={{ fontSize: 10.5, fill: '#64748b' }} axisLine={false} tickLine={false} />
                        <YAxis
                          // Nine-figure currency ticks ("1,50,000,000.00") need a
                          // wider axis box; the 60px default clips the leading digits.
                          width={96}
                          tick={{ fontSize: 10.5, fill: '#64748b' }}
                          axisLine={false}
                          tickLine={false}
                          tickFormatter={(v) => formatAxisCurrency(v)}
                        />
                        <Tooltip
                          formatter={(v: number) => [formatCurrency(v), '']}
                          contentStyle={{ fontSize: 11, borderRadius: 8, border: '1px solid #e2e8f0' }}
                        />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                        <Line type="monotone" dataKey="revenue" stroke="#1e3a6e" strokeWidth={2} name="Revenue" dot={false} isAnimationActive={false} />
                        <Line type="monotone" dataKey="profit" stroke="#4caf50" strokeWidth={2} name="Gross profit" dot={false} isAnimationActive={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <RevenueCompositionCard
                    title="Revenue by category"
                    subtitle="Share of net revenue"
                    rows={summary?.dimensions.category.rows ?? []}
                    total={kpis?.revenue ?? 0}
                    totalMembers={summary?.dimensions.category.total}
                    onOpen={() => setView('category')}
                  />
                  <RevenueCompositionCard
                    title="Revenue by brand"
                    subtitle="Share of net revenue"
                    rows={summary?.dimensions.brand.rows ?? []}
                    total={kpis?.revenue ?? 0}
                    totalMembers={summary?.dimensions.brand.total}
                    onOpen={() => setView('brand')}
                  />
                  <RevenueCompositionCard
                    title="Revenue by product"
                    subtitle="Top products by revenue"
                    rows={summary?.dimensions.product.rows ?? []}
                    total={kpis?.revenue ?? 0}
                    totalMembers={summary?.dimensions.product.total}
                    onOpen={() => setView('product')}
                  />
                  <RevenueCompositionCard
                    title="Revenue by customer"
                    subtitle="Concentration in the top accounts"
                    rows={summary?.dimensions.customer.rows ?? []}
                    total={kpis?.revenue ?? 0}
                    totalMembers={summary?.dimensions.customer.total}
                    onOpen={() => setView('customer')}
                  />
                </div>
              </div>
            )}

            {/* -------------------------------------------------- dimension */}
            {view !== 'summary' && dimension && (
              <div className="space-y-4">
                {displayMode[view] === 'chart' ? (
                  <div className="bg-white rounded-xl border border-border p-5 shadow-sm">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-sm font-semibold text-foreground">
                        {metric === 'revenue' ? 'Revenue' : metric === 'profit' ? 'Gross profit' : 'Quantity'} by{' '}
                        {view}
                      </h3>
                      <span className="text-xs text-muted-foreground">
                        {chartData.length} of {rows.length} shown
                      </span>
                    </div>

                    {dimension === 'customer' ? (
                      <ParetoChart
                        data={chartData}
                        metric={metric}
                        totalValue={chartTotal}
                        height={Math.max(340, Math.min(chartData.length, 15) * 26 + 120)}
                      />
                    ) : dimension === 'brand' || dimension === 'category' ? (
                      <DonutChart
                        data={chartData}
                        metric={metric}
                        height={320}
                        totalValue={chartTotal}
                        totalMembers={Math.max(rows.length - chartData.length, 0)}
                      />
                    ) : (
                      <HorizontalBarChart
                        data={chartData}
                        metric={metric}
                        height={Math.max(320, chartData.length * 26)}
                      />
                    )}
                  </div>
                ) : (
                  <div className="table-wrapper">
                    <div className="px-4 py-3 border-b border-border flex items-center justify-between flex-wrap gap-2">
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold text-foreground capitalize">Sales by {view}</h3>
                        {breakdownQuery.isFetching && (
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
                        )}
                        {breakdownQuery.isPlaceholderData && (
                          <span className="text-xs text-muted-foreground">loading full list…</span>
                        )}
                      </div>
                      <div className="relative">
                        <Search className="w-3.5 h-3.5 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2" />
                        <input
                          value={search}
                          onChange={(e) => {
                            setSearch(e.target.value);
                            setPage(1);
                          }}
                          placeholder={`Search ${view}…`}
                          className="border border-border rounded-lg pl-8 pr-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 w-56"
                        />
                      </div>
                    </div>

                    <table className="w-full">
                      <thead>
                        <tr className="bg-muted/40 border-b border-border">
                          {(
                            [
                              ['#', null],
                              [view === 'product' ? 'Product' : view === 'brand' ? 'Brand' : view === 'category' ? 'Category' : 'Customer', 'name'],
                              ['Qty sold', 'quantity'],
                              ['Invoices', 'invoice_count'],
                              ['Revenue', 'revenue'],
                              ['Cost', 'cost'],
                              ['Profit', 'profit'],
                              ['Margin', null],
                              ['% of rev', null],
                            ] as [string, SortKey | null][]
                          ).map(([label, key], idx) => (
                            <th
                              key={idx}
                              onClick={key ? () => toggleSort(key) : undefined}
                              className={`text-left text-xs font-semibold text-muted-foreground px-4 py-3 ${
                                key ? 'cursor-pointer hover:text-foreground select-none' : ''
                              }`}
                            >
                              {label}
                              {key === sortKey ? (sortAsc ? ' ▲' : ' ▼') : ''}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {pagedRows.length > 0 ? (
                          pagedRows.map((r, i) => (
                            <tr
                              key={r.id ?? `idx-${i}`}
                              onClick={() => setDrill({ dim: dimension, id: r.id, name: r.name })}
                              className="hover:bg-muted/30 transition-colors cursor-pointer"
                              title="Click to see the invoices behind this row"
                            >
                              <td className="px-4 py-2.5 text-sm text-muted-foreground">
                                {(safePage - 1) * pageSize + i + 1}
                              </td>
                              <td className="px-4 py-2.5 text-sm font-semibold text-foreground">{r.name}</td>
                              <td className="px-4 py-2.5 text-sm text-foreground">
                                {Math.round(r.quantity).toLocaleString('en-US')}
                                {r.unit ? <span className="text-muted-foreground text-xs ml-1">{r.unit}</span> : null}
                              </td>
                              <td className="px-4 py-2.5 text-sm text-foreground">{r.invoice_count}</td>
                              <td className="px-4 py-2.5 text-sm font-semibold text-foreground tabular-nums">
                                {formatCurrency(r.revenue)}
                              </td>
                              <td className="px-4 py-2.5 text-sm text-muted-foreground tabular-nums">
                                {formatCurrency(r.cost)}
                              </td>
                              <td
                                className={`px-4 py-2.5 text-sm font-semibold tabular-nums ${
                                  r.profit >= 0 ? 'text-green-600' : 'text-red-600'
                                }`}
                              >
                                {formatCurrency(r.profit)}
                              </td>
                              <td className="px-4 py-2.5">
                                <span
                                  className={`text-xs font-medium tabular-nums ${
                                    r.profit >= 0 ? 'text-green-600' : 'text-red-600'
                                  }`}
                                >
                                  {marginPct(r.profit, r.revenue).toFixed(1)}%
                                </span>
                              </td>
                              <td className="px-4 py-2.5">
                                <span className="text-xs text-muted-foreground tabular-nums">
                                  {totals.revenue > 0 ? ((r.revenue / totals.revenue) * 100).toFixed(1) : '0.0'}%
                                </span>
                              </td>
                            </tr>
                          ))
                        ) : (
                          <tr>
                            <td colSpan={9} className="px-4 py-10 text-center text-muted-foreground text-sm">
                              {breakdownQuery.isLoading
                                ? 'Loading…'
                                : search
                                  ? 'No matches for your search'
                                  : `No ${view} sales in this period`}
                            </td>
                          </tr>
                        )}
                      </tbody>
                      {filteredRows.length > 0 && (
                        <tfoot>
                          <tr className="bg-muted/40 border-t border-border font-semibold">
                            <td className="px-4 py-3 text-sm text-foreground" colSpan={2}>
                              TOTAL
                            </td>
                            <td className="px-4 py-3 text-sm text-foreground tabular-nums">
                              {Math.round(totals.quantity).toLocaleString('en-US')}
                            </td>
                            <td className="px-4 py-3 text-sm text-foreground tabular-nums">{totals.invoice_count}</td>
                            <td className="px-4 py-3 text-sm text-foreground tabular-nums">{formatCurrency(totals.revenue)}</td>
                            <td className="px-4 py-3 text-sm text-muted-foreground tabular-nums">{formatCurrency(totals.cost)}</td>
                            <td
                              className={`px-4 py-3 text-sm tabular-nums ${
                                totals.profit >= 0 ? 'text-green-600' : 'text-red-600'
                              }`}
                            >
                              {formatCurrency(totals.profit)}
                            </td>
                            <td className="px-4 py-3 text-xs text-foreground tabular-nums">
                              {marginPct(totals.profit, totals.revenue).toFixed(1)}%
                            </td>
                            <td className="px-4 py-3" />
                          </tr>
                        </tfoot>
                      )}
                    </table>

                    {filteredRows.length > 0 && (
                      <Pagination
                        page={safePage}
                        pageSize={pageSize}
                        total={filteredRows.length}
                        onPageChange={setPage}
                        onPageSizeChange={(size) => setPageSize(size)}
                      />
                    )}
                  </div>
                )}
              </div>
            )}

            <p className="text-xs text-muted-foreground leading-relaxed">
              Revenue is the invoice-line subtotal after allocating each invoice&apos;s cart discount
              pro-rata, excluding VAT and shipping. COGS in the summary strip is the ledger figure
              (account 5000, matching the P&amp;L); dimension tables use the cost price recorded on
              each line at the time of sale
              {kpis && Math.abs(kpis.cogs - kpis.cogs_line) >= 0.5
                ? `, which differs from the ledger by ${formatCurrency(kpis.cogs - kpis.cogs_line)}`
                : ''}
              . Cancelled and draft invoices are excluded. Click any row for its invoices.
            </p>
          </>
        )}
      </div>

      {/* ----------------------------------------------------------- drill */}
      {drill && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 print:hidden"
          onClick={() => setDrill(null)}
        >
          <div className="absolute inset-0 bg-black/50" />
          <div
            className="relative bg-white rounded-xl shadow-xl border border-border w-full max-w-3xl max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <div>
                <h3 className="text-sm font-bold text-foreground">{drill.name}</h3>
                <p className="text-xs text-muted-foreground">
                  Invoices · {start} to {end}
                </p>
              </div>
              <button onClick={() => setDrill(null)} className="p-1.5 hover:bg-muted rounded-lg transition">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="overflow-y-auto flex-1">
              {drillQuery.isLoading ? (
                <div className="flex items-center justify-center py-10">
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600" />
                </div>
              ) : (drillQuery.data?.length ?? 0) === 0 ? (
                <div className="text-center py-10 text-muted-foreground text-sm">No invoices found</div>
              ) : (
                <table className="w-full">
                  <thead className="sticky top-0 bg-white">
                    <tr className="bg-muted/40 border-b border-border">
                      {['Invoice #', 'Date', 'Customer', 'Qty', 'Revenue', 'Cost', 'Profit'].map((h) => (
                        <th key={h} className="text-left text-xs font-semibold text-muted-foreground px-4 py-2.5">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {(drillQuery.data ?? []).map((d) => (
                      <tr key={d.invoice_id} className="hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-2.5 text-sm font-semibold text-blue-600">{d.invoice_number}</td>
                        <td className="px-4 py-2.5 text-sm text-foreground">{d.invoice_date}</td>
                        <td className="px-4 py-2.5 text-sm text-foreground">{d.customer_name || '—'}</td>
                        <td className="px-4 py-2.5 text-sm text-foreground">{Math.round(d.quantity)}</td>
                        <td className="px-4 py-2.5 text-sm font-semibold text-foreground tabular-nums">
                          {formatCurrency(d.revenue)}
                        </td>
                        <td className="px-4 py-2.5 text-sm text-muted-foreground tabular-nums">
                          {formatCurrency(d.cost)}
                        </td>
                        <td
                          className={`px-4 py-2.5 text-sm font-semibold tabular-nums ${
                            d.revenue - d.cost >= 0 ? 'text-green-600' : 'text-red-600'
                          }`}
                        >
                          {formatCurrency(d.revenue - d.cost)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-muted/40 border-t border-border font-semibold">
                      <td className="px-4 py-2.5 text-sm" colSpan={3}>
                        TOTAL ({(drillQuery.data ?? []).length} invoices)
                      </td>
                      <td className="px-4 py-2.5 text-sm">
                        {Math.round((drillQuery.data ?? []).reduce((s, d) => s + d.quantity, 0))}
                      </td>
                      <td className="px-4 py-2.5 text-sm tabular-nums">
                        {formatCurrency((drillQuery.data ?? []).reduce((s, d) => s + d.revenue, 0))}
                      </td>
                      <td className="px-4 py-2.5 text-sm text-muted-foreground tabular-nums">
                        {formatCurrency((drillQuery.data ?? []).reduce((s, d) => s + d.cost, 0))}
                      </td>
                      <td className="px-4 py-2.5 text-sm text-green-600 tabular-nums">
                        {formatCurrency((drillQuery.data ?? []).reduce((s, d) => s + d.revenue - d.cost, 0))}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {/*
        The printable document. Hidden on screen, visible only when printing:
        `print-modal` re-enables visibility inside globals.css's print block,
        which is what makes the in-page fallback (popup blocked) produce the
        same A4 sheets as the popup path.
      */}
      <div ref={printRef} className="hidden print:block print-modal">
        {summary && (
          <SalesReportDocument
            summary={summary}
            fullRows={fullRows}
            periodLabel={resolved.label}
            scope={printScope}
            activeView={view}
            metric={metric}
            company={companyQuery.data ?? { name: 'SI Building Solutions' }}
            preparedBy={profile?.full_name || 'Admin'}
            isOffline={isOfflineSource}
            syncedAt={summary.fetchedAt}
          />
        )}
      </div>

      <div className="hidden print:block text-center text-xs text-muted-foreground mt-4">
        <Link href="/reports" className="no-underline text-muted-foreground">
          Reports &amp; analytics
        </Link>
      </div>
    </>
  );
}

function KpiCard({
  label,
  value,
  hint,
  icon,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  hint: string;
  icon: React.ReactNode;
  tone?: 'neutral' | 'positive' | 'negative';
}) {
  const valueClass =
    tone === 'positive' ? 'text-green-600' : tone === 'negative' ? 'text-foreground' : 'text-foreground';
  return (
    <div className="bg-white rounded-xl border border-border p-4 shadow-sm">
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-xs text-muted-foreground">{label}</p>
        {icon}
      </div>
      <p className={`text-lg font-bold tabular-nums ${valueClass}`}>{value}</p>
      <p className="text-xs text-muted-foreground mt-1 leading-tight">{hint}</p>
    </div>
  );
}
