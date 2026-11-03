'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { formatCurrency, formatAxisCurrency, formatRelativeTime, formatDate } from '@/lib/format';
import { tokenizeSearch, matchesTokens, rankRows } from '@/lib/search';
import { toast } from '@/hooks/use-toast';
import {
  EMPTY_STATS,
  useDashboardCharts,
  useDashboardInventory,
  useDashboardOverview,
  useRefreshDashboard,
} from '@/lib/dashboard';
import {
  PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, LineChart, Line, ResponsiveContainer
} from 'recharts';
import { ShoppingCart, TrendingUp, Package, Truck, Receipt, CreditCard, ArrowUpRight, Clock, CircleCheck as CheckCircle2, Circle as XCircle, Users, ShoppingBag, Wallet, Plus, Banknote, X, Search, ChevronDown, RefreshCw, TriangleAlert as AlertTriangle } from 'lucide-react';
import AppPagination from '@/components/ui/AppPagination';
import { LoadingWave, StatValueSlot, LoadingRows, LoadingChart, LoadingDonut } from '@/components/ui/loading-wave';

const deliveryStatusConfig = {
  pending: { label: 'Pending', color: 'text-orange-500', bg: 'bg-orange-50', icon: Clock },
  in_transit: { label: 'In Transit', color: 'text-blue-500', bg: 'bg-blue-50', icon: Truck },
  delivered: { label: 'Delivered', color: 'text-green-600', bg: 'bg-green-50', icon: CheckCircle2 },
  failed: { label: 'Failed', color: 'text-red-500', bg: 'bg-red-50', icon: XCircle },
};

const activityIcons: Record<string, { icon: React.ElementType; color: string }> = {
  invoice: { icon: Receipt, color: 'text-blue-600 bg-blue-50' },
  payment_received: { icon: CheckCircle2, color: 'text-green-600 bg-green-50' },
  purchase_order: { icon: ShoppingBag, color: 'text-orange-600 bg-orange-50' },
  delivery: { icon: Truck, color: 'text-purple-600 bg-purple-50' },
  product: { icon: Package, color: 'text-teal-600 bg-teal-50' },

  online_order: { icon: ShoppingCart, color: 'text-yellow-600 bg-yellow-50' },
};

export default function DashboardPage() {
  // Three queries by cost, not by section. The KPI row must not queue behind
  // the inventory ledger walk, which is what a single aggregate forced it to
  // do before.
  const overview = useDashboardOverview();
  const charts = useDashboardCharts();
  const inventory = useDashboardInventory();
  const refreshDashboard = useRefreshDashboard();
  const [refreshing, setRefreshing] = useState(false);

  // Deliberately the same names the render already used — the 900 lines below
  // are unchanged by this refactor.
  const stats = { ...EMPTY_STATS, ...overview.data?.stats };
  const inventoryValue = inventory.data?.inventoryValue ?? null;
  const salesChartData = charts.data?.salesChartData ?? [];
  const categoryData = charts.data?.categoryData ?? [];
  const topCustomers = overview.data?.topCustomers ?? [];
  const invoiceDues = overview.data?.invoiceDues ?? [];
  const manualDues = overview.data?.manualDues ?? [];
  const lowStockItems = overview.data?.lowStockItems ?? [];
  const recentActivities = overview.data?.recentActivities ?? [];
  const reconChecks = inventory.data?.reconciliation ?? [];

  const [showReceivablesModal, setShowReceivablesModal] = useState(false);
  const [showPayablesModal, setShowPayablesModal] = useState(false);
  const [showExpensesModal, setShowExpensesModal] = useState(false);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await refreshDashboard();
    } finally {
      setRefreshing(false);
    }
  }

  // A KPI whose source has not resolved yet shows a moving placeholder rather
  // than ৳0.00 — a zero is a claim about the business, a placeholder is a claim
  // about the request. `isSuccess` (not `isLoading`) so a background refetch
  // never blanks a figure that is already on screen, and `isPending` drives the
  // animation only while there is genuinely nothing to show: once a query has
  // settled without a figure (error, or a valuation that failed) the card falls
  // back to an em dash, because a wave that never stops would be a lie.
  const overviewPending = overview.isPending;
  const overviewReady = overview.isSuccess;
  const inventoryPending = inventory.isPending;
  const chartsPending = charts.isPending;
  // Distinguishes "the query came back empty" from "the query never came back".
  // Printing "No outstanding invoice dues" over a failed request is the same
  // false claim as printing ৳0.00 over one.
  const overviewFailed = overview.isError;
  const chartsFailed = charts.isError;

  const kpis: {
    label: string;
    value: string;
    loading: boolean;
    waveWidth: string;
    icon: React.ElementType;
    bg: string;
    color: string;
    clickable?: boolean;
    modal?: 'receivables' | 'payables' | 'expenses';
  }[] = [
    { label: "Today's Sales", value: overviewReady ? formatCurrency(stats.todaySales) : '—', loading: overviewPending, waveWidth: '52%', icon: ShoppingCart, bg: 'bg-blue-50', color: 'text-blue-500' },
    { label: "Today's Collection", value: overviewReady ? formatCurrency(stats.todayCollection) : '—', loading: overviewPending, waveWidth: '46%', icon: Banknote, bg: 'bg-emerald-50', color: 'text-emerald-500' },
    { label: 'Monthly Revenue', value: overviewReady ? formatCurrency(stats.monthlySales) : '—', loading: overviewPending, waveWidth: '66%', icon: TrendingUp, bg: 'bg-green-50', color: 'text-green-500' },
    { label: 'Inventory Value', value: inventoryValue != null ? formatCurrency(inventoryValue) : '—', loading: inventoryPending, waveWidth: '58%', icon: Package, bg: 'bg-purple-50', color: 'text-purple-500' },
    { label: 'Pending Deliveries', value: overviewReady ? String(stats.deliveryPending + stats.deliveryInTransit) : '—', loading: overviewPending, waveWidth: '18%', icon: Truck, bg: 'bg-orange-50', color: 'text-orange-500' },
    { label: 'Receivables', value: overviewReady ? formatCurrency(stats.receivables) : '—', loading: overviewPending, waveWidth: '56%', icon: Receipt, bg: 'bg-red-50', color: 'text-red-500', clickable: true, modal: 'receivables' },
    { label: 'Payables', value: overviewReady ? formatCurrency(stats.payables) : '—', loading: overviewPending, waveWidth: '52%', icon: CreditCard, bg: 'bg-amber-50', color: 'text-amber-500', clickable: true, modal: 'payables' },
    { label: 'Total Expenses', value: overviewReady ? formatCurrency(stats.totalExpenses) : '—', loading: overviewPending, waveWidth: '60%', icon: Wallet, bg: 'bg-rose-50', color: 'text-rose-500', clickable: true, modal: 'expenses' },
  ];

  return (
    <div className="space-y-5 max-w-[1400px] mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Dashboard</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Welcome back, Admin!</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/sales" className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg shadow-sm transition-colors">
            <Plus className="w-4 h-4" />
            Create Invoice
          </Link>
          <Link href="/purchases" className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded-lg shadow-sm transition-colors">
            <ShoppingBag className="w-4 h-4" />
            New Purchase
          </Link>
          <Link href="/expenses" className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-rose-600 hover:bg-rose-700 text-white text-sm font-medium rounded-lg shadow-sm transition-colors">
            <Wallet className="w-4 h-4" />
            Add Expense
          </Link>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            title="Re-fetch every figure on this page"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-white border border-border hover:bg-muted/60 text-foreground text-sm font-medium rounded-lg shadow-sm transition-colors disabled:opacity-60"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? 'Refreshing' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {kpis.map((kpi, i) => (
          <div
            key={kpi.label}
            aria-busy={kpi.loading || undefined}
            onClick={kpi.clickable ? () => kpi.modal === 'receivables' ? setShowReceivablesModal(true) : kpi.modal === 'payables' ? setShowPayablesModal(true) : setShowExpensesModal(true) : undefined}
            className={`stat-card group ${kpi.clickable ? 'cursor-pointer hover:ring-2 hover:ring-blue-500/20 hover:shadow-md transition-all' : 'cursor-default'}`}
          >
            <div className="flex items-start justify-between mb-2">
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground font-medium">{kpi.label}</p>
                <StatValueSlot>
                  {kpi.loading ? (
                    <>
                      <LoadingWave width={kpi.waveWidth} delayMs={i * 110} />
                      <span className="sr-only">Loading</span>
                    </>
                  ) : (
                    <p className="text-xl font-bold text-foreground">{kpi.value}</p>
                  )}
                </StatValueSlot>
              </div>
              <div className={`w-10 h-10 ${kpi.bg} rounded-full flex items-center justify-center shrink-0`}>
                <kpi.icon className={`w-5 h-5 ${kpi.color}`} />
              </div>
            </div>
          </div>
        ))}
      </div>

      {reconChecks.length > 0 && (() => {
        const drifted = reconChecks.filter((c: any) => c.status === 'drift');
        const infos = reconChecks.filter((c: any) => c.status === 'info');
        const allOk = drifted.length === 0;
        return (
          <div className={`rounded-xl border p-4 shadow-sm flex flex-wrap items-center gap-x-5 gap-y-2 ${allOk ? 'bg-emerald-50/40 border-emerald-200' : 'bg-red-50/40 border-red-200'}`}>
            <div className="flex items-center gap-2.5">
              {allOk
                ? <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                : <AlertTriangle className="w-5 h-5 text-red-600 shrink-0" />}
              <div>
                <p className={`text-sm font-semibold ${allOk ? 'text-emerald-700' : 'text-red-700'}`}>
                  {allOk ? 'Inventory records in sync' : `${drifted.length} inventory check${drifted.length > 1 ? 's' : ''} drifting`}
                </p>
                <p className="text-xs text-muted-foreground">Stock counter · FIFO batch ledger · GL 1200 — checked live</p>
              </div>
            </div>
            {drifted.map((c: any) => (
              <span key={c.check_name} className="text-xs text-red-700 bg-red-100/70 border border-red-200 px-2.5 py-1 rounded-md">
                {c.check_name}: {c.details}
              </span>
            ))}
            {allOk && infos.map((c: any) => (
              <span key={c.check_name} className="text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded-md">
                {c.check_name}: {c.drift}
              </span>
            ))}
          </div>
        );
      })()}

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <div className="lg:col-span-3 bg-white rounded-xl border border-border p-5 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-foreground">Sales Overview</h3>
          </div>
          {chartsPending ? (
            <LoadingChart height={240} />
          ) : chartsFailed ? (
            <div className="flex h-[240px] items-center justify-center text-sm text-muted-foreground">{"Couldn't load sales"}</div>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={salesChartData} margin={{ top: 5, right: 5, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                <YAxis width={78} tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} tickFormatter={(v) => formatAxisCurrency(Number(v))} />
                <Legend verticalAlign="top" height={24} iconType="circle" wrapperStyle={{ fontSize: 11 }} />
                <Tooltip contentStyle={{ fontSize: 12, border: '1px solid #e2e8f0', borderRadius: 8 }} formatter={(v: number, name: string) => [formatCurrency(v), name]} />
                <Line type="monotone" dataKey="sales" stroke="#3b82f6" strokeWidth={2.5} dot={{ r: 4, fill: '#3b82f6', strokeWidth: 2, stroke: '#fff' }} name="Sales" />
                <Line type="monotone" dataKey="profit" stroke="#10b981" strokeWidth={2} dot={{ r: 3, fill: '#10b981', strokeWidth: 2, stroke: '#fff' }} name="Gross Profit" />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="lg:col-span-2 bg-white rounded-xl border border-border p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-foreground mb-4">Inventory by Category</h3>
          {chartsPending ? (
            <LoadingDonut delayMs={60} />
          ) : categoryData.length > 0 ? (
            <div className="flex items-center gap-4">
              <ResponsiveContainer width={140} height={140}>
                <PieChart>
                  <Pie data={categoryData} cx="50%" cy="50%" innerRadius={42} outerRadius={65} paddingAngle={2} dataKey="value">
                    {categoryData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                  </Pie>
                  <Tooltip formatter={(v: number) => [`${v}%`, '']} contentStyle={{ fontSize: 11, borderRadius: 8 }} />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex-1 space-y-1.5">
                {categoryData.map((cat) => (
                  <div key={cat.name} className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: cat.color }} />
                      <span className="text-[11px] text-muted-foreground truncate">{cat.name}</span>
                    </div>
                    <span className="text-[11px] font-semibold text-foreground shrink-0">{cat.value}%</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-center text-muted-foreground py-8">
              {chartsFailed ? "Couldn't load categories" : 'No category data'}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-border p-5 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-foreground">Delivery Status</h3>
            <Link href="/delivery" className="text-xs text-blue-600 hover:underline font-medium">View all</Link>
          </div>
          <div className="space-y-2.5">
            {Object.entries(deliveryStatusConfig).map(([key, cfg], i) => (
              <div key={key} className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className={`w-7 h-7 ${cfg.bg} rounded-lg flex items-center justify-center`}>
                    <cfg.icon className={`w-3.5 h-3.5 ${cfg.color}`} />
                  </div>
                  <span className="text-sm text-foreground">{cfg.label}</span>
                </div>
                {overviewPending ? (
                  <LoadingWave width="26px" delayMs={i * 90} />
                ) : (
                  <span className={`text-sm font-bold ${cfg.color}`}>
                    {overviewFailed ? '—' : stats[`delivery${key.charAt(0).toUpperCase() + key.slice(1)}` as keyof typeof stats] || 0}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-border p-5 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-foreground">Top Customers</h3>
            <Link href="/crm" className="text-xs text-blue-600 hover:underline font-medium">View all</Link>
          </div>
          <div className="space-y-2.5">
            {overviewPending ? (
              <LoadingRows rows={5} leading="avatar" trailing startDelay={40} />
            ) : overviewFailed ? (
              <p className="text-xs text-muted-foreground py-2">{"Couldn't load customers"}</p>
            ) : (
              topCustomers.slice(0, 5).map((c) => (
                <div key={c.id} className="flex items-center justify-between">
                  <Link href={`/crm/${c.id}`} className="flex items-center gap-2 hover:opacity-80 transition">
                    <div className="w-6 h-6 bg-blue-100 rounded-full flex items-center justify-center text-blue-600 text-xs font-bold">
                      {c.name[0]}
                    </div>
                    <span className="text-sm text-foreground truncate max-w-[110px]">{c.name}</span>
                  </Link>
                  <span className="text-sm font-semibold text-foreground">{formatCurrency(c.total_purchases)}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-border p-5 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-foreground">Invoice Outstanding Dues</h3>
            <Link href="/sales" className="text-xs text-blue-600 hover:underline font-medium">View all</Link>
          </div>
          <div className="space-y-2.5">
            {overviewPending ? (
              <LoadingRows rows={4} trailing startDelay={80} />
            ) : invoiceDues.length > 0 ? invoiceDues.map((c) => (
              <div key={c.id} className="flex items-center justify-between">
                <Link href={`/crm/${c.id}`} className="text-sm text-foreground truncate max-w-[130px] hover:text-blue-600 transition">{c.name}</Link>
                <span className="text-sm font-semibold text-red-600">{formatCurrency(c.due)}</span>
              </div>
            )) : (
              <p className="text-xs text-muted-foreground py-2">
                {overviewFailed ? "Couldn't load invoice dues" : 'No outstanding invoice dues'}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-border p-5 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-foreground">Low Stock Alert</h3>
            <Link href="/inventory" className="text-xs text-blue-600 hover:underline font-medium">View all</Link>
          </div>
          <div className="space-y-3">
            {overviewPending ? (
              <LoadingRows rows={3} leading="thumb" lines={2} trailing startDelay={120} />
            ) : overviewFailed ? (
              <p className="text-xs text-muted-foreground py-2">{"Couldn't load stock alerts"}</p>
            ) : (
              lowStockItems.map((item: any, i: number) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="w-9 h-9 bg-slate-100 rounded-lg flex items-center justify-center shrink-0">
                    <Package className="w-4 h-4 text-slate-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-foreground leading-snug break-words">{item.product?.name}</p>
                    <p className="text-[10px] text-muted-foreground">SKU: {item.product?.sku}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs font-bold text-red-500">{item.quantity_on_hand} pcs</p>
                    <p className="text-[10px] text-muted-foreground">Min: {item.product?.min_stock_level}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-border p-5 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-foreground">Recent Activities</h3>
            <Link href="/reports/activity" className="text-xs text-blue-600 hover:underline font-medium">View all</Link>
          </div>
          <div className="space-y-3">
            {overviewPending ? (
              <LoadingRows rows={4} leading="icon" lines={2} startDelay={160} />
            ) : recentActivities.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-6 text-center">
                <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center mb-2">
                  <Clock className="w-4 h-4 text-muted-foreground" />
                </div>
                <p className="text-xs text-muted-foreground">
                  {overviewFailed ? "Couldn't load activity" : 'No recent activity yet'}
                </p>
                {!overviewFailed && (
                  <p className="text-[10px] text-muted-foreground/70 mt-0.5">Activity will appear as you use the system</p>
                )}
              </div>
            ) : recentActivities.slice(0, 5).map((log: any, i: number) => {
              const cfg = activityIcons[log.entity_type] || activityIcons.invoice;
              return (
                <div key={i} className="flex items-start gap-2.5">
                  <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${cfg.color}`}>
                    <cfg.icon className="w-3.5 h-3.5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] text-foreground leading-snug font-medium">{log.entity_label}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">{formatRelativeTime(log.created_at)}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-border p-5 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-foreground">Manual Outstanding Dues</h3>
            <Link href="/accounting" className="text-xs text-blue-600 hover:underline font-medium">View all</Link>
          </div>
          <div className="space-y-2.5">
            {overviewPending ? (
              <LoadingRows rows={4} trailing startDelay={200} />
            ) : manualDues.length > 0 ? manualDues.map((c) => (
              <div key={c.id} className="flex items-center justify-between">
                <Link href={`/crm/${c.id}`} className="text-sm text-foreground truncate max-w-[130px] hover:text-blue-600 transition">{c.name}</Link>
                <span className="text-sm font-semibold text-red-600">{formatCurrency(c.due)}</span>
              </div>
            )) : (
              <p className="text-xs text-muted-foreground py-2">
                {overviewFailed ? "Couldn't load manual dues" : 'No outstanding manual dues'}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-border p-5 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-foreground">Online Store Overview</h3>
          <Link href="/online-store" className="text-xs text-blue-600 hover:underline font-medium">View Dashboard</Link>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: 'Orders This Month', value: String(stats.onlineOrders), width: '16%' },
            { label: 'Revenue This Month', value: formatCurrency(stats.onlineRevenue), width: '46%' },
            { label: 'Pending Deliveries', value: String(stats.deliveryPending + stats.deliveryInTransit), width: '18%' },
            { label: 'Monthly Expenses', value: formatCurrency(stats.totalExpenses), width: '44%' },
          ].map((cell, i) => (
            <div
              key={cell.label}
              aria-busy={overviewPending || undefined}
              className="bg-muted/40 rounded-xl p-4 text-center"
            >
              <p className="text-xs text-muted-foreground mb-1">{cell.label}</p>
              {overviewPending ? (
                <div className="flex h-7 items-center justify-center">
                  <LoadingWave width={cell.width} delayMs={i * 130} />
                  <span className="sr-only">Loading</span>
                </div>
              ) : (
                <p className="text-lg font-bold text-foreground">{cell.value}</p>
              )}
            </div>
          ))}
        </div>
      </div>

      {showReceivablesModal && (
        <ReceivablesBreakdownModal totalReceivables={stats.receivables} onClose={() => setShowReceivablesModal(false)} />
      )}
      {showPayablesModal && (
        <PayablesAgingModal totalPayables={stats.payables} onClose={() => setShowPayablesModal(false)} />
      )}
      {showExpensesModal && (
        <ExpensesBreakdownModal onClose={() => setShowExpensesModal(false)} />
      )}
    </div>
  );
}

function PayablesAgingModal({ totalPayables, onClose }: { totalPayables: number; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<any[]>([]);
  const [search, setSearch] = useState('');

  useEffect(() => {
    supabase.rpc('get_payables_aging').then(({ data, error }) => {
      if (error) {
        toast({ title: 'Error', description: error.message, variant: 'destructive' });
      }
      setRows((data || []) as any[]);
      setLoading(false);
    });
  }, []);

  const searchTokens = tokenizeSearch(search);
  const filtered = rankRows(
    rows.filter((r: any) => !search || matchesTokens(r, ['supplier_name'], searchTokens)),
    (r: any) => [r.supplier_name || ''],
    searchTokens,
  );
  const sum = (key: string) => filtered.reduce((s: number, r: any) => s + Number(r[key] || 0), 0);

  const BUCKETS = [
    { key: 'bucket_current', label: 'Current (0–30d)' },
    { key: 'bucket_31_60', label: '31–60 days' },
    { key: 'bucket_61_90', label: '61–90 days' },
    { key: 'bucket_90_plus', label: '90+ days' },
  ];

  return (
    <div className="fixed inset-0 bg-black/50 items-center justify-center z-[100] p-4 flex">
      <div className="bg-white rounded-2xl w-full max-w-4xl shadow-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <h2 className="text-base font-bold flex items-center gap-2">
            <CreditCard className="w-5 h-5 text-amber-500" />
            Payables Aging
          </h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>

        <div className="px-6 py-4 border-b border-border shrink-0 space-y-3">
          <div className="flex items-center gap-3">
            <p className="text-sm text-muted-foreground">
              Total payables <span className="font-bold text-foreground">{formatCurrency(totalPayables)}</span>
              <span className="text-muted-foreground"> · {rows.length} supplier{rows.length === 1 ? '' : 's'} with dues</span>
            </p>
            <div className="relative ml-auto">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search supplier..."
                className="pl-8 pr-4 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 w-56" />
            </div>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Payments and credits are applied to the oldest payables first, so each bucket shows the part of the
            balance that has been open for that long. Click a supplier to see their full history.
          </p>
        </div>

        <div className="overflow-y-auto px-6 py-4">
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-10 bg-muted rounded animate-pulse" />)}
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm">No suppliers with dues</div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left text-xs font-semibold text-muted-foreground px-2 py-2">Supplier</th>
                  <th className="text-left text-xs font-semibold text-muted-foreground px-2 py-2">Oldest Open</th>
                  <th className="text-right text-xs font-semibold text-muted-foreground px-2 py-2">Current (0–30d)</th>
                  <th className="text-right text-xs font-semibold text-muted-foreground px-2 py-2">31–60</th>
                  <th className="text-right text-xs font-semibold text-muted-foreground px-2 py-2">61–90</th>
                  <th className="text-right text-xs font-semibold text-muted-foreground px-2 py-2">90+</th>
                  <th className="text-right text-xs font-semibold text-muted-foreground px-2 py-2">Total Due</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((r: any) => (
                  <tr key={r.supplier_id} className="hover:bg-muted/30">
                    <td className="px-2 py-2.5 text-sm">
                      <Link href={`/suppliers/${r.supplier_id}`} className="font-semibold text-blue-600 hover:underline">{r.supplier_name}</Link>
                    </td>
                    <td className="px-2 py-2.5 text-sm text-muted-foreground">{r.oldest_open_date ? formatDate(r.oldest_open_date) : '—'}</td>
                    {BUCKETS.map(b => (
                      <td key={b.key} className={`px-2 py-2.5 text-sm text-right font-mono ${Number(r[b.key]) > 0 && b.key !== 'bucket_current' ? 'text-amber-600 font-semibold' : 'text-foreground'}`}>
                        {Number(r[b.key]) > 0 ? formatCurrency(r[b.key]) : '—'}
                      </td>
                    ))}
                    <td className="px-2 py-2.5 text-sm text-right font-bold text-red-600">{formatCurrency(r.total_due)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border">
                  <td className="px-2 py-2.5 text-sm font-bold" colSpan={2}>Total{filtered.length !== rows.length ? ` (${filtered.length} shown)` : ''}</td>
                  {BUCKETS.map(b => (
                    <td key={b.key} className="px-2 py-2.5 text-sm text-right font-mono font-semibold">{formatCurrency(sum(b.key))}</td>
                  ))}
                  <td className="px-2 py-2.5 text-sm text-right font-bold text-red-600">{formatCurrency(sum('total_due'))}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function ReceivablesBreakdownModal({ totalReceivables, onClose }: { totalReceivables: number; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'invoice' | 'manual'>('invoice');
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  const PAGE_SIZE = 25;
  const [invPage, setInvPage] = useState(1);
  const [invTotal, setInvTotal] = useState(0);
  const [invData, setInvData] = useState<any[]>([]);
  const [invGrandTotal, setInvGrandTotal] = useState(0);

  const [manPage, setManPage] = useState(1);
  const [manTotal, setManTotal] = useState(0);
  const [manData, setManData] = useState<any[]>([]);
  const [manGrandTotal, setManGrandTotal] = useState(0);

  // Debounce the modal search — every keystroke re-ran both queries (one of
  // them unbounded) per character.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => { if (tab === 'invoice') loadInvoices(debouncedSearch); }, [invPage, debouncedSearch, filterStatus, tab]);
  useEffect(() => { if (tab === 'manual') loadManual(debouncedSearch); }, [manPage, debouncedSearch, tab]);

  async function loadInvoices(rawTerm: string) {
    setLoading(true);
    const today = new Date().toISOString().slice(0, 10);
    const term = rawTerm.trim().replace(/[%_,()]/g, '');

    // Search runs server-side (filtering after .range() would only search the
    // current page); customer names are resolved to ids because PostgREST
    // text-search arms can't reliably target aliased embeds.
    let orClause: string | null = null;
    if (term) {
      const { data: custs } = await supabase.from('customers').select('id').ilike('name', `%${term}%`);
      const idList = (custs || []).map((c: any) => c.id).join(',');
      orClause = `invoice_number.ilike.%${term}%,reference.ilike.%${term}%${idList ? `,customer_id.in.(${idList})` : ''}`;
    }

    function buildInvoiceQuery(select: string, opts?: { count?: 'exact' }) {
      let q = supabase
        .from('invoices')
        .select(select, opts)
        .in('status', ['sent', 'partially_paid', 'overdue'])
        .gt('balance_due', 0);

      // 'overdue' is never stored (overdue is computed from due_date), so the
      // filter must match on the due date instead of the status column.
      if (filterStatus === 'overdue') q = q.lt('due_date', today);
      else if (filterStatus) q = q.eq('status', filterStatus);
      if (orClause) q = q.or(orClause);
      return q;
    }

    const from = (invPage - 1) * PAGE_SIZE;
    const [pageRes, allRes] = await Promise.all([
      buildInvoiceQuery('id, invoice_number, reference, customer:customers(name), status, invoice_date, due_date, total_amount, amount_paid, balance_due', { count: 'exact' })
        .order('invoice_date', { ascending: false })
        .range(from, from + PAGE_SIZE - 1),
      buildInvoiceQuery('balance_due'),
    ]);
    if (pageRes.error) toast({ title: 'Error', description: pageRes.error.message, variant: 'destructive' });

    setInvData(pageRes.data || []);
    setInvTotal(pageRes.count || 0);
    setInvGrandTotal((allRes.data || []).reduce((s: number, i: any) => s + Number(i.balance_due || 0), 0));
    setLoading(false);
  }

  async function loadManual(rawTerm: string) {
    setLoading(true);
    const [{ data: jes, error }, { data: pays }] = await Promise.all([
      supabase
        .from('journal_entries')
        .select('id, entry_number, entry_date, description, total_debit, customer:customers(name)')
        .eq('reference_type', 'receivable')
        .eq('is_posted', true)
        .gt('total_debit', 0)
        .order('entry_date', { ascending: false }),
      supabase
        .from('payments')
        .select('reference_id, amount, bad_debt_amount')
        .eq('reference_type', 'receivable')
        .neq('is_reversed', true),
    ]);
    if (error) toast({ title: 'Error', description: error.message, variant: 'destructive' });

    // Manual receivable JEs are recorded balanced (debit = credit) and
    // collections post to separate journal entries, so outstanding is
    // total_debit minus collected payments — never total_debit - total_credit.
    const paidMap = new Map<string, number>();
    (pays || []).forEach((p: any) => {
      if (!p.reference_id) return;
      paidMap.set(p.reference_id, (paidMap.get(p.reference_id) || 0) + Number(p.amount || 0) + Number(p.bad_debt_amount || 0));
    });

    let rows = (jes || []).map((je: any) => {
      const paid = paidMap.get(je.id) || 0;
      return { ...je, paid, net_amount: Number(je.total_debit || 0) - paid };
    }).filter((je: any) => je.net_amount > 0.01);

    if (rawTerm.trim()) {
      const q = rawTerm.toLowerCase();
      rows = rows.filter((je: any) =>
        je.entry_number?.toLowerCase().includes(q) ||
        (je.description || '').toLowerCase().includes(q) ||
        (je.customer?.name || '').toLowerCase().includes(q)
      );
    }

    setManData(rows.slice((manPage - 1) * PAGE_SIZE, manPage * PAGE_SIZE));
    setManTotal(rows.length);
    setManGrandTotal(rows.reduce((s: number, j: any) => s + j.net_amount, 0));
    setLoading(false);
  }

  function getDaysOverdue(inv: any): number {
    if (!inv.due_date) return 0;
    const due = new Date(inv.due_date);
    const today = new Date();
    const diff = Math.floor((today.getTime() - due.getTime()) / (1000 * 60 * 60 * 24));
    return diff > 0 ? diff : 0;
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100] p-4">
      <div className="bg-white rounded-2xl w-full max-w-4xl shadow-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <h2 className="text-base font-bold flex items-center gap-2">
            <Receipt className="w-5 h-5 text-red-500" />
            Receivables Breakdown
          </h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>

        <div className="px-6 py-4 border-b border-border shrink-0 space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-red-50 rounded-lg p-3 border border-red-100">
              <p className="text-xs text-red-600 font-medium">Total Receivables</p>
              <p className="text-lg font-bold text-red-700">{formatCurrency(totalReceivables)}</p>
            </div>
            <div className="bg-blue-50 rounded-lg p-3 border border-blue-100">
              <p className="text-xs text-blue-600 font-medium">From Invoices</p>
              <p className="text-lg font-bold text-blue-700">{formatCurrency(invGrandTotal)}</p>
            </div>
            <div className="bg-purple-50 rounded-lg p-3 border border-purple-100">
              <p className="text-xs text-purple-600 font-medium">Manual Receivables</p>
              <p className="text-lg font-bold text-purple-700">{formatCurrency(manGrandTotal)}</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex bg-muted/50 rounded-lg p-1">
              <button onClick={() => { setTab('invoice'); setInvPage(1); }} className={`px-4 py-1.5 rounded-md text-sm font-medium transition ${tab === 'invoice' ? 'bg-white text-blue-600 shadow-sm' : 'text-muted-foreground'}`}>Invoice Receivables</button>
              <button onClick={() => { setTab('manual'); setManPage(1); }} className={`px-4 py-1.5 rounded-md text-sm font-medium transition ${tab === 'manual' ? 'bg-white text-blue-600 shadow-sm' : 'text-muted-foreground'}`}>Manual Receivables</button>
            </div>
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <input value={search} onChange={e => { setSearch(e.target.value); setInvPage(1); setManPage(1); }} placeholder="Search..." className="w-full pl-8 pr-4 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
            </div>
            {tab === 'invoice' && (
              <select value={filterStatus} onChange={e => { setFilterStatus(e.target.value); setInvPage(1); }} className="border border-border rounded-lg px-3 py-2 text-sm focus:outline-none bg-white">
                <option value="">All Status</option>
                <option value="sent">On Credit</option>
                <option value="partially_paid">Partial</option>
                <option value="overdue">Overdue</option>
              </select>
            )}
          </div>
        </div>

        <div className="overflow-x-auto overflow-y-auto flex-1">
          {tab === 'invoice' ? (
            <table className="w-full">
              <thead className="bg-muted/40 border-b border-border sticky top-0 z-10">
                <tr>
                  <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Invoice #</th>
                  <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Customer</th>
                  <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Date</th>
                  <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Due Date</th>
                  <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Total</th>
                  <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Paid</th>
                  <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Balance</th>
                  <th className="text-center text-xs font-semibold text-muted-foreground px-4 py-3">Overdue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {loading ? Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}><td colSpan={8} className="px-4 py-3"><div className="h-4 bg-muted rounded animate-pulse" /></td></tr>
                )) : invData.length === 0 ? (
                  <tr><td colSpan={8} className="px-4 py-8 text-center text-sm text-muted-foreground">No outstanding invoices</td></tr>
                ) : invData.map((inv: any) => {
                  const days = getDaysOverdue(inv);
                  return (
                    <tr key={inv.id} className="hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3 text-sm font-semibold text-blue-600">{inv.invoice_number}</td>
                      <td className="px-4 py-3 text-sm text-foreground">{inv.customer?.name || 'Walk-in'}</td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">{new Date(inv.invoice_date).toLocaleDateString()}</td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">{inv.due_date ? new Date(inv.due_date).toLocaleDateString() : '—'}</td>
                      <td className="px-4 py-3 text-right text-sm text-foreground">{formatCurrency(inv.total_amount)}</td>
                      <td className="px-4 py-3 text-right text-sm text-green-600">{formatCurrency(inv.amount_paid)}</td>
                      <td className="px-4 py-3 text-right text-sm font-bold text-red-600">{formatCurrency(inv.balance_due)}</td>
                      <td className="px-4 py-3 text-center text-sm">
                        {days > 0 ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-50 text-red-600 text-xs font-medium"><AlertTriangle className="w-3 h-3" />{days}d</span> : <span className="text-muted-foreground text-xs">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <table className="w-full">
              <thead className="bg-muted/40 border-b border-border sticky top-0 z-10">
                <tr>
                  <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Entry #</th>
                  <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Description</th>
                  <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Customer</th>
                  <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Date</th>
                  <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Debit</th>
                  <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Paid</th>
                  <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Outstanding</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {loading ? Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}><td colSpan={7} className="px-4 py-3"><div className="h-4 bg-muted rounded animate-pulse" /></td></tr>
                )) : manData.length === 0 ? (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">No manual receivables</td></tr>
                ) : manData.map((je: any) => (
                  <tr key={je.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3 text-sm font-semibold text-purple-600">{je.entry_number}</td>
                    <td className="px-4 py-3 text-sm text-foreground">{je.description || '—'}</td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{je.customer?.name || '—'}</td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{new Date(je.entry_date).toLocaleDateString()}</td>
                    <td className="px-4 py-3 text-right text-sm text-foreground">{formatCurrency(je.total_debit)}</td>
                    <td className="px-4 py-3 text-right text-sm text-green-600">{formatCurrency(je.paid)}</td>
                    <td className="px-4 py-3 text-right text-sm font-bold text-purple-600">{formatCurrency(je.net_amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {tab === 'invoice' ? (
          <AppPagination page={invPage} pageSize={PAGE_SIZE} total={invTotal} onPageChange={setInvPage} />
        ) : (
          <AppPagination page={manPage} pageSize={PAGE_SIZE} total={manTotal} onPageChange={setManPage} />
        )}

        <div className="border-t border-border px-6 py-3 flex justify-end shrink-0">
          <button onClick={onClose} className="px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Close</button>
        </div>
      </div>
    </div>
  );
}

function ExpensesBreakdownModal({ onClose }: { onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<'today' | 'week' | 'month' | 'quarter' | 'year' | 'all'>('year');
  const [search, setSearch] = useState('');

  const PAGE_SIZE = 25;
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [entries, setEntries] = useState<any[]>([]);
  const [pageTotal, setPageTotal] = useState(0);

  // Client-side filter, but the fetch is period+page bound — debounce so a
  // burst of keystrokes doesn't refetch the page per character.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => { loadExpenses(); }, [period, page, debouncedSearch]);

  async function loadExpenses() {
    setLoading(true);
    const now = new Date();
    let startDate: string | null = null;

    switch (period) {
      case 'today':
        startDate = now.toISOString().split('T')[0];
        break;
      case 'week': {
        const weekAgo = new Date(now);
        weekAgo.setDate(now.getDate() - 7);
        startDate = weekAgo.toISOString().split('T')[0];
        break;
      }
      case 'month':
        startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
        break;
      case 'quarter': {
        const q = Math.floor(now.getMonth() / 3);
        startDate = new Date(now.getFullYear(), q * 3, 1).toISOString().split('T')[0];
        break;
      }
      case 'year':
        startDate = new Date(now.getFullYear(), 0, 1).toISOString().split('T')[0];
        break;
      case 'all':
        startDate = null;
        break;
    }

    let baseQuery = supabase
      .from('journal_entries')
      .select(`
        id, entry_number, entry_date, description, total_debit, total_credit, reference_type,
        lines:journal_lines(account_id, debit, credit, account:accounts(id, code, name, account_type))
      `, { count: 'exact' })
      .eq('is_posted', true)
      .eq('reference_type', 'manual')
      .order('entry_date', { ascending: false })
      .order('created_at', { ascending: false });

    if (startDate) baseQuery = baseQuery.gte('entry_date', startDate);

    const from = (page - 1) * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const { data, count } = await baseQuery.range(from, to);

    let filtered = data || [];
    if (debouncedSearch.trim()) {
      const q = debouncedSearch.toLowerCase();
      filtered = filtered.filter((je: any) =>
        je.entry_number?.toLowerCase().includes(q) ||
        (je.description || '').toLowerCase().includes(q) ||
        je.lines?.some((l: any) => l.account?.name?.toLowerCase().includes(q))
      );
    }

    setEntries(filtered);
    setTotal(count || 0);
    setPageTotal(filtered.reduce((s: number, je: any) => s + Number(je.total_debit || 0), 0));
    setLoading(false);
  }

  const periodLabels: Record<typeof period, string> = {
    today: 'Today',
    week: 'This Week',
    month: 'This Month',
    quarter: 'This Quarter',
    year: 'This Year',
    all: 'All Time',
  };

  function getExpenseAccount(je: any): any | null {
    return je.lines?.find((l: any) => Number(l.debit) > 0 && l.account?.account_type === 'expense') || null;
  }
  function getPaidFromAccount(je: any): any | null {
    return je.lines?.find((l: any) => Number(l.credit) > 0) || null;
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100] p-4">
      <div className="bg-white rounded-2xl w-full max-w-4xl shadow-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <h2 className="text-base font-bold flex items-center gap-2">
            <Wallet className="w-5 h-5 text-rose-500" />
            Total Expenses Breakdown
          </h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>

        <div className="px-6 py-4 border-b border-border shrink-0 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-rose-50 rounded-lg p-3 border border-rose-100">
              <p className="text-xs text-rose-600 font-medium">Total Expenses ({periodLabels[period]})</p>
              <p className="text-lg font-bold text-rose-700">{formatCurrency(pageTotal)}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{total} entries total</p>
            </div>
            <div className="bg-blue-50 rounded-lg p-3 border border-blue-100">
              <p className="text-xs text-blue-600 font-medium">This Page Total</p>
              <p className="text-lg font-bold text-blue-700">{formatCurrency(pageTotal)}</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex bg-muted/50 rounded-lg p-1 flex-wrap">
              {(['today', 'week', 'month', 'quarter', 'year', 'all'] as const).map(p => (
                <button key={p} onClick={() => { setPeriod(p); setPage(1); }} className={`px-3 py-1.5 rounded-md text-xs font-medium transition ${period === p ? 'bg-white text-rose-600 shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
                  {periodLabels[p]}
                </button>
              ))}
            </div>
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder="Search by description, entry #, or account..." className="w-full pl-8 pr-4 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-500/20" />
            </div>
          </div>
        </div>

        <div className="overflow-x-auto overflow-y-auto flex-1">
          <table className="w-full">
            <thead className="bg-muted/40 border-b border-border sticky top-0 z-10">
              <tr>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Entry #</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Date</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Description</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Expense Type</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Paid From</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading ? Array.from({ length: 6 }).map((_, i) => (
                <tr key={i}><td colSpan={6} className="px-4 py-3"><div className="h-4 bg-muted rounded animate-pulse" /></td></tr>
              )) : entries.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">No expense entries for this period</td></tr>
              ) : entries.map((je: any) => {
                const expAcct = getExpenseAccount(je);
                const paidAcct = getPaidFromAccount(je);
                return (
                  <tr key={je.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3 text-sm font-semibold text-rose-600">{je.entry_number}</td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{new Date(je.entry_date).toLocaleDateString()}</td>
                    <td className="px-4 py-3 text-sm text-foreground">{je.description || '—'}</td>
                    <td className="px-4 py-3 text-sm">
                      {expAcct ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-red-50 text-red-700 text-xs rounded-full">{expAcct.account?.name || '—'}</span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{paidAcct ? `${paidAcct.account?.code} - ${paidAcct.account?.name}` : '—'}</td>
                    <td className="px-4 py-3 text-right text-sm font-bold text-rose-600">{formatCurrency(je.total_debit)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <AppPagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />

        <div className="border-t border-border px-6 py-3 flex justify-end shrink-0">
          <button onClick={onClose} className="px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Close</button>
        </div>
      </div>
    </div>
  );
}
