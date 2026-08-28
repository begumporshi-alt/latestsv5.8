'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { formatCurrency, formatRelativeTime } from '@/lib/format';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts';
import { ShoppingCart, TrendingUp, Package, Truck, Receipt, CreditCard, ArrowUpRight, Clock, CircleCheck as CheckCircle2, Circle as XCircle, Users, ShoppingBag, Wallet, Plus, Banknote, X, Search, ChevronDown, TriangleAlert as AlertTriangle } from 'lucide-react';
import AppPagination from '@/components/ui/AppPagination';
import type { Customer } from '@/lib/types';

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#6b7280'];

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
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({
    todaySales: 0,
    monthlySales: 0,
    inventoryValue: 0,
    inventoryItems: 0,
    receivables: 0,
    payables: 0,
    totalExpenses: 0,
    todayCollection: 0,
    deliveryPending: 0,
    deliveryInTransit: 0,
    deliveryDelivered: 0,
    deliveryFailed: 0,
    onlineOrders: 0,
    onlineRevenue: 0,
  });
  const [salesChartData, setSalesChartData] = useState<{ month: string; sales: number; profit: number }[]>([]);
  const [categoryData, setCategoryData] = useState<{ name: string; value: number; color: string }[]>([]);
  const [topCustomers, setTopCustomers] = useState<Customer[]>([]);
  const [outstandingDues, setOutstandingDues] = useState<Customer[]>([]);
  const [lowStockItems, setLowStockItems] = useState<any[]>([]);
  const [recentActivities, setRecentActivities] = useState<any[]>([]);
  const [showReceivablesModal, setShowReceivablesModal] = useState(false);
  const [showExpensesModal, setShowExpensesModal] = useState(false);

  useEffect(() => {
    loadDashboardData();
  }, []);

  async function loadDashboardData() {
    setLoading(true);
    const today = new Date().toISOString().split('T')[0];
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];

    const yearStart = new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0];

    const [
      todayInvRes, monthlyInvRes, customersRes, suppliersRes,
      dlvRes, onlineOrdersRes, topCustRes, duesRes,
      lowStockRes, actRes, expensesRes, todayCollectionRes
    ] = await Promise.all([
      supabase.from('invoices').select('total_amount').eq('invoice_date', today).neq('status', 'cancelled'),
      supabase.from('invoices').select('total_amount, created_at').gte('invoice_date', monthStart).neq('status', 'cancelled'),
      supabase.from('customers').select('outstanding_balance'),
      supabase.from('suppliers').select('outstanding_balance'),
      supabase.from('deliveries').select('status'),
      supabase.from('online_orders').select('total_amount, status').gte('created_at', monthStart),
      supabase.from('customers').select('*').order('total_purchases', { ascending: false }).limit(5),
      supabase.from('customers').select('*').gt('outstanding_balance', 0).order('outstanding_balance', { ascending: false }).limit(5),
      supabase.from('inventory_items').select('quantity_on_hand, product:products(id, name, sku, min_stock_level, image_url)').lt('quantity_on_hand', 20).limit(5),
      supabase.from('activity_logs').select('*').order('created_at', { ascending: false }).limit(5),
      supabase.from('journal_entries').select('total_debit, entry_date').eq('reference_type', 'manual').eq('is_posted', true).gte('entry_date', yearStart),
      supabase.from('payments').select('amount').eq('payment_date', today).eq('payment_type', 'received').neq('is_reversed', true).neq('payment_for', 'reversal_payment'),
    ]);

    // Paginate inventory_items to avoid the 1000-row Supabase default cap
    let allInvItems: any[] = [];
    {
      let pg = 0;
      while (true) {
        const { data: pageData } = await supabase
          .from('inventory_items')
          .select('quantity_on_hand, product:products(cost_price)')
          .range(pg * 1000, (pg + 1) * 1000 - 1);
        allInvItems = allInvItems.concat(pageData || []);
        if (!pageData || pageData.length < 1000) break;
        pg++;
      }
    }

    const todaySales = (todayInvRes.data || []).reduce((s: number, i: any) => s + Number(i.total_amount), 0);
    const monthlySales = (monthlyInvRes.data || []).reduce((s: number, i: any) => s + Number(i.total_amount), 0);
    const receivables = (customersRes.data || []).reduce((s: number, c: any) => s + Number(c.outstanding_balance), 0);
    const payables = (suppliersRes.data || []).reduce((s: number, s2: any) => s + Number(s2.outstanding_balance), 0);
    const invValue = allInvItems.reduce((s: number, item: any) => s + (Number(item.quantity_on_hand) * Number(item.product?.cost_price || 0)), 0);

    const deliveries = dlvRes.data || [];
    const onlineOrders = onlineOrdersRes.data || [];
    const totalExpenses = (expensesRes.data || []).reduce((s: number, e: any) => s + Number(e.total_debit), 0);
    const todayCollection = (todayCollectionRes.data || []).reduce((s: number, p: any) => s + Number(p.amount), 0);

    const deliveryStats: Record<string, number> = { pending: 0, in_transit: 0, delivered: 0, failed: 0 };
    deliveries.forEach((d: any) => { if (deliveryStats[d.status] !== undefined) deliveryStats[d.status]++; });

    setStats({
      todaySales,
      monthlySales,
      inventoryValue: invValue,
      inventoryItems: allInvItems.length,
      receivables,
      payables,
      totalExpenses,
      todayCollection,
      deliveryPending: deliveryStats.pending,
      deliveryInTransit: deliveryStats.in_transit,
      deliveryDelivered: deliveryStats.delivered,
      deliveryFailed: deliveryStats.failed,
      onlineOrders: onlineOrders.filter((o: any) => o.status !== 'cancelled').length,
      onlineRevenue: onlineOrders.filter((o: any) => o.status !== 'cancelled').reduce((s: number, o: any) => s + Number(o.total_amount), 0),
    });

    const lowStock = (lowStockRes.data || []).filter((i: any) => i.product && i.quantity_on_hand < (i.product.min_stock_level || 20));
    setLowStockItems(lowStock.slice(0, 3));
    setTopCustomers(topCustRes.data || []);
    setOutstandingDues(duesRes.data || []);
    setRecentActivities(actRes.data || []);

    const chartData = await getSalesChartData();
    setSalesChartData(chartData);

    const catData = await getCategoryData();
    setCategoryData(catData);

    setLoading(false);
  }

  async function getSalesChartData() {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];
    const result: { month: string; sales: number; profit: number }[] = [];

    for (let i = 0; i < 6; i++) {
      const startDate = new Date(new Date().getFullYear(), i, 1).toISOString().split('T')[0];
      const endDate = new Date(new Date().getFullYear(), i + 1, 0).toISOString().split('T')[0];

      const { data: invoices } = await supabase
        .from('invoices')
        .select('total_amount, subtotal')
        .gte('invoice_date', startDate)
        .lt('invoice_date', endDate)
        .neq('status', 'cancelled');

      const totalSales = (invoices || []).reduce((s: number, inv: any) => s + Number(inv.total_amount), 0);
      const estimatedProfit = totalSales * 0.35;

      result.push({ month: months[i], sales: totalSales, profit: estimatedProfit });
    }

    return result;
  }

  async function getCategoryData() {
    const { data: products } = await supabase
      .from('products')
      .select('sale_price, category:categories(name), inventory_items(quantity_on_hand)');

    const categoryTotals: Record<string, number> = {};
    (products || []).forEach((p: any) => {
      const catName = p.category?.name || 'Others';
      const stockValue = (p.inventory_items || []).reduce((s: number, i: any) => s + Number(i.quantity_on_hand), 0);
      categoryTotals[catName] = (categoryTotals[catName] || 0) + (stockValue * Number(p.sale_price));
    });

    const total = Object.values(categoryTotals).reduce((a, b) => a + b, 0) || 1;

    return Object.entries(categoryTotals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, value], i) => ({
        name,
        value: Math.round((value / total) * 100),
        color: COLORS[i]
      }));
  }

  const kpis = [
    { label: "Today's Sales", value: formatCurrency(stats.todaySales), icon: ShoppingCart, bg: 'bg-blue-50', color: 'text-blue-500' },
    { label: "Today's Collection", value: formatCurrency(stats.todayCollection), icon: Banknote, bg: 'bg-emerald-50', color: 'text-emerald-500' },
    { label: 'Monthly Revenue', value: formatCurrency(stats.monthlySales), icon: TrendingUp, bg: 'bg-green-50', color: 'text-green-500' },
    { label: 'Inventory Value', value: formatCurrency(stats.inventoryValue), icon: Package, bg: 'bg-purple-50', color: 'text-purple-500' },
    { label: 'Pending Deliveries', value: String(stats.deliveryPending + stats.deliveryInTransit), icon: Truck, bg: 'bg-orange-50', color: 'text-orange-500' },
    { label: 'Receivables', value: formatCurrency(stats.receivables), icon: Receipt, bg: 'bg-red-50', color: 'text-red-500', clickable: true, modal: 'receivables' as const },
    { label: 'Payables', value: formatCurrency(stats.payables), icon: CreditCard, bg: 'bg-amber-50', color: 'text-amber-500' },
    { label: 'Total Expenses', value: formatCurrency(stats.totalExpenses), icon: Wallet, bg: 'bg-rose-50', color: 'text-rose-500', clickable: true, modal: 'expenses' as const },
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
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {kpis.map((kpi) => (
          <div
            key={kpi.label}
            onClick={(kpi as any).clickable ? () => (kpi as any).modal === 'receivables' ? setShowReceivablesModal(true) : setShowExpensesModal(true) : undefined}
            className={`stat-card group ${(kpi as any).clickable ? 'cursor-pointer hover:ring-2 hover:ring-blue-500/20 hover:shadow-md transition-all' : 'cursor-default'}`}
          >
            <div className="flex items-start justify-between mb-2">
              <div>
                <p className="text-xs text-muted-foreground font-medium">{kpi.label}</p>
                <p className="text-xl font-bold text-foreground mt-0.5">{kpi.value}</p>
              </div>
              <div className={`w-10 h-10 ${kpi.bg} rounded-full flex items-center justify-center shrink-0`}>
                <kpi.icon className={`w-5 h-5 ${kpi.color}`} />
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <div className="lg:col-span-3 bg-white rounded-xl border border-border p-5 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-foreground">Sales Overview</h3>
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={salesChartData} margin={{ top: 5, right: 5, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="salesGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} tickFormatter={(v) => `৳${(v/100000).toFixed(0)}L`} />
              <Tooltip contentStyle={{ fontSize: 12, border: '1px solid #e2e8f0', borderRadius: 8 }} formatter={(v: number) => [formatCurrency(v), '']} />
              <Area type="monotone" dataKey="sales" stroke="#3b82f6" strokeWidth={2.5} fill="url(#salesGrad)" dot={{ r: 4, fill: '#3b82f6', strokeWidth: 2, stroke: '#fff' }} name="Sales" />
              <Area type="monotone" dataKey="profit" stroke="#10b981" strokeWidth={2} fill="none" dot={{ r: 3, fill: '#10b981', strokeWidth: 2, stroke: '#fff' }} name="Profit" />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="lg:col-span-2 bg-white rounded-xl border border-border p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-foreground mb-4">Inventory by Category</h3>
          {categoryData.length > 0 ? (
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
            <div className="text-center text-muted-foreground py-8">No category data</div>
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
            {Object.entries(deliveryStatusConfig).map(([key, cfg]) => (
              <div key={key} className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className={`w-7 h-7 ${cfg.bg} rounded-lg flex items-center justify-center`}>
                    <cfg.icon className={`w-3.5 h-3.5 ${cfg.color}`} />
                  </div>
                  <span className="text-sm text-foreground">{cfg.label}</span>
                </div>
                <span className={`text-sm font-bold ${cfg.color}`}>
                  {stats[`delivery${key.charAt(0).toUpperCase() + key.slice(1)}` as keyof typeof stats] || 0}
                </span>
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
            {(topCustomers.length > 0 ? topCustomers : []).slice(0, 5).map((c) => (
              <div key={c.id} className="flex items-center justify-between">
                <Link href={`/crm/${c.id}`} className="flex items-center gap-2 hover:opacity-80 transition">
                  <div className="w-6 h-6 bg-blue-100 rounded-full flex items-center justify-center text-blue-600 text-xs font-bold">
                    {c.name[0]}
                  </div>
                  <span className="text-sm text-foreground truncate max-w-[110px]">{c.name}</span>
                </Link>
                <span className="text-sm font-semibold text-foreground">{formatCurrency(c.total_purchases)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-border p-5 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-foreground">Outstanding Dues</h3>
            <Link href="/crm" className="text-xs text-blue-600 hover:underline font-medium">View all</Link>
          </div>
          <div className="space-y-2.5">
            {(outstandingDues.length > 0 ? outstandingDues : []).slice(0, 5).map((c) => (
              <div key={c.id} className="flex items-center justify-between">
                <Link href={`/crm/${c.id}`} className="text-sm text-foreground truncate max-w-[130px] hover:text-blue-600 transition">{c.name}</Link>
                <span className="text-sm font-semibold text-red-600">{formatCurrency(c.outstanding_balance)}</span>
              </div>
            ))}
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
            {(lowStockItems.length > 0 ? lowStockItems : []).map((item: any, i: number) => (
              <div key={i} className="flex items-center gap-3">
                <div className="w-9 h-9 bg-slate-100 rounded-lg flex items-center justify-center shrink-0">
                  <Package className="w-4 h-4 text-slate-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-foreground truncate">{item.product?.name}</p>
                  <p className="text-[10px] text-muted-foreground">SKU: {item.product?.sku}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-xs font-bold text-red-500">{item.quantity_on_hand} pcs</p>
                  <p className="text-[10px] text-muted-foreground">Min: {item.product?.min_stock_level}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-border p-5 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-foreground">Recent Activities</h3>
            <Link href="/reports/activity" className="text-xs text-blue-600 hover:underline font-medium">View all</Link>
          </div>
          <div className="space-y-3">
            {recentActivities.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-6 text-center">
                <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center mb-2">
                  <Clock className="w-4 h-4 text-muted-foreground" />
                </div>
                <p className="text-xs text-muted-foreground">No recent activity yet</p>
                <p className="text-[10px] text-muted-foreground/70 mt-0.5">Activity will appear as you use the system</p>
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
            <h3 className="text-sm font-semibold text-foreground">Outstanding Dues</h3>
            <Link href="/crm" className="text-xs text-blue-600 hover:underline font-medium">View all</Link>
          </div>
          <div className="space-y-2.5">
            {(outstandingDues.length > 0 ? outstandingDues : []).slice(0, 5).map((c) => (
              <div key={c.id} className="flex items-center justify-between">
                <Link href={`/crm/${c.id}`} className="text-sm text-foreground truncate max-w-[130px] hover:text-blue-600 transition">{c.name}</Link>
                <span className="text-sm font-semibold text-red-600">{formatCurrency(c.outstanding_balance)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-border p-5 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-foreground">Online Store Overview</h3>
          <Link href="/online-store" className="text-xs text-blue-600 hover:underline font-medium">View Dashboard</Link>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-muted/40 rounded-xl p-4 text-center">
            <p className="text-xs text-muted-foreground mb-1">Orders This Month</p>
            <p className="text-lg font-bold text-foreground">{stats.onlineOrders}</p>
          </div>
          <div className="bg-muted/40 rounded-xl p-4 text-center">
            <p className="text-xs text-muted-foreground mb-1">Revenue This Month</p>
            <p className="text-lg font-bold text-foreground">{formatCurrency(stats.onlineRevenue)}</p>
          </div>
          <div className="bg-muted/40 rounded-xl p-4 text-center">
            <p className="text-xs text-muted-foreground mb-1">Pending Deliveries</p>
            <p className="text-lg font-bold text-foreground">{stats.deliveryPending + stats.deliveryInTransit}</p>
          </div>
          <div className="bg-muted/40 rounded-xl p-4 text-center">
            <p className="text-xs text-muted-foreground mb-1">Monthly Expenses</p>
            <p className="text-lg font-bold text-foreground">{formatCurrency(stats.totalExpenses)}</p>
          </div>
        </div>
      </div>

      {showReceivablesModal && (
        <ReceivablesBreakdownModal totalReceivables={stats.receivables} onClose={() => setShowReceivablesModal(false)} />
      )}
      {showExpensesModal && (
        <ExpensesBreakdownModal onClose={() => setShowExpensesModal(false)} />
      )}
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
  const [invPageTotal, setInvPageTotal] = useState(0);

  const [manPage, setManPage] = useState(1);
  const [manTotal, setManTotal] = useState(0);
  const [manData, setManData] = useState<any[]>([]);
  const [manPageTotal, setManPageTotal] = useState(0);

  useEffect(() => { if (tab === 'invoice') loadInvoices(); }, [invPage, search, filterStatus, tab]);
  useEffect(() => { if (tab === 'manual') loadManual(); }, [manPage, search, tab]);

  async function loadInvoices() {
    setLoading(true);
    let baseQuery = supabase
      .from('invoices')
      .select('id, invoice_number, customer:customers(name), status, invoice_date, due_date, total_amount, amount_paid, balance_due', { count: 'exact' })
      .in('status', ['sent', 'partially_paid', 'overdue'])
      .gt('balance_due', 0)
      .order('invoice_date', { ascending: false });

    if (filterStatus) baseQuery = baseQuery.eq('status', filterStatus);

    const from = (invPage - 1) * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const { data, count } = await baseQuery.range(from, to);

    let filtered = data || [];
    if (search.trim()) {
      const q = search.toLowerCase();
      filtered = filtered.filter((i: any) => i.invoice_number?.toLowerCase().includes(q) || (i.customer?.name || '').toLowerCase().includes(q));
    }

    setInvData(filtered);
    setInvTotal(count || 0);
    setInvPageTotal(filtered.reduce((s: number, i: any) => s + Number(i.balance_due || 0), 0));
    setLoading(false);
  }

  async function loadManual() {
    setLoading(true);
    let baseQuery = supabase
      .from('journal_entries')
      .select('id, entry_number, entry_date, description, total_debit, total_credit, customer:customers(name)', { count: 'exact' })
      .eq('reference_type', 'receivable')
      .eq('is_posted', true)
      .gt('total_debit', 0)
      .order('entry_date', { ascending: false });

    const from = (manPage - 1) * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const { data, count } = await baseQuery.range(from, to);

    let filtered = (data || []).map((je: any) => ({
      ...je,
      net_amount: Number(je.total_debit || 0) - Number(je.total_credit || 0),
    }));
    if (search.trim()) {
      const q = search.toLowerCase();
      filtered = filtered.filter((je: any) =>
        je.entry_number?.toLowerCase().includes(q) ||
        (je.description || '').toLowerCase().includes(q) ||
        (je.customer?.name || '').toLowerCase().includes(q)
      );
    }

    setManData(filtered);
    setManTotal(count || 0);
    setManPageTotal(filtered.reduce((s: number, j: any) => s + j.net_amount, 0));
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
              <p className="text-xs text-blue-600 font-medium">From Invoices (this page)</p>
              <p className="text-lg font-bold text-blue-700">{formatCurrency(invPageTotal)}</p>
            </div>
            <div className="bg-purple-50 rounded-lg p-3 border border-purple-100">
              <p className="text-xs text-purple-600 font-medium">Manual Receivables (this page)</p>
              <p className="text-lg font-bold text-purple-700">{formatCurrency(manPageTotal)}</p>
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
                  <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Credit</th>
                  <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Net Amount</th>
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
                    <td className="px-4 py-3 text-right text-sm text-muted-foreground">{formatCurrency(je.total_credit)}</td>
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

  useEffect(() => { loadExpenses(); }, [period, page, search]);

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
    if (search.trim()) {
      const q = search.toLowerCase();
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
