'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/format';
import { ChartBar as BarChart3, TrendingUp, Package, Users, Download, FileSpreadsheet, Calendar, ArrowRight, RefreshCw, Printer, Info } from 'lucide-react';
import {
  BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend, LineChart, Line
} from 'recharts';

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#6b7280'];

type ReportTab = 'overview' | 'sales' | 'inventory' | 'customers' | 'pl';

export default function ReportsPage() {
  const [activeTab, setActiveTab] = useState<ReportTab>('overview');
  const [period, setPeriod] = useState('today');
  const [loading, setLoading] = useState(true);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const [stats, setStats] = useState({
    totalRevenue: 0,
    totalPurchases: 0,
    grossProfit: 0,
    netProfit: 0,
    totalOrders: 0,
    totalCustomers: 0,
    totalProducts: 0,
    inventoryValue: 0,
    cogsActual: 0,
    salesReturnsTotal: 0,
    totalOperatingExpenses: 0,
  });
  const [monthlyData, setMonthlyData] = useState<{ month: string; sales: number; purchases: number; profit: number }[]>([]);
  const [categoryData, setCategoryData] = useState<{ name: string; revenue: number; color: string }[]>([]);
  const [topProducts, setTopProducts] = useState<{ name: string; sales: number; revenue: number; cost: number; profit: number; unit?: string }[]>([]);
  const [topCustomers, setTopCustomers] = useState<{ name: string; purchases: number; revenue: number }[]>([]);

  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => { loadReportData(); }, [period, dateFrom, dateTo, refreshKey]);

  async function loadReportData() {
    setLoading(true);
    const { startDate, endDate } = getDateRange(period);
    const effectiveStart = dateFrom || startDate;
    // When dateTo is not set and endDate is null (open-ended ranges like this_month/quarter/year),
    // use today as the upper bound instead of undefined — passing undefined to .lte() breaks Supabase queries.
    const today = new Date().toISOString().split('T')[0];
    const effectiveEnd = dateTo || endDate || today;

    // Build query helpers that only apply .lte when we have a real end date
    const applyDateRange = (query: any, column: string) => {
      let q = query.gte(column, effectiveStart);
      if (effectiveEnd) q = q.lte(column, effectiveEnd);
      return q;
    };

    // Supabase caps queries at 1000 rows by default. Paginate inventory_items to fetch all.
    const [
      invoicesRes, purchasesRes, customersRes, productsRes,
      topProductsRes, topCustomersRes, paymentsRes, accountsRes
    ] = await Promise.all([
      applyDateRange(supabase.from('invoices').select('total_amount, subtotal, invoice_date, status').neq('status', 'cancelled'), 'invoice_date'),
      applyDateRange(supabase.from('purchase_orders').select('total_amount'), 'order_date'),
      supabase.from('customers').select('total_purchases'),
      supabase.from('products').select('id, unit'),
      applyDateRange(supabase.from('invoice_items').select('product_id, quantity, subtotal, unit_name, product:products(name, cost_price)').order('quantity', { ascending: false }).limit(50), 'created_at'),
      supabase.from('customers').select('name, total_purchases').order('total_purchases', { ascending: false }).limit(10),
      applyDateRange(supabase.from('payments').select('amount').eq('payment_type', 'received'), 'payment_date'),
      supabase.from('accounts').select('id, code, name, account_type').eq('is_active', true),
    ]);

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
    const invItemsRes = { data: allInvItems };

    const totalRevenue = (invoicesRes.data || []).reduce((s: number, i: any) => s + Number(i.total_amount), 0);
    const totalPurchases = (purchasesRes.data || []).reduce((s: number, p: any) => s + Number(p.total_amount), 0);

    // COGS from Chart of Accounts journal lines
    const cogsAccount = (accountsRes.data || []).find((a: any) =>
      a.name.toLowerCase().includes('cost of goods sold') || a.name.toLowerCase().includes('cogs')
    );
    let cogsActual = 0;
    if (cogsAccount) {
      const { data: cogsLines } = await supabase
        .from('journal_lines')
        .select('debit, credit, journal_entry:journal_entries!inner(entry_date)')
        .eq('account_id', cogsAccount.id);
      cogsActual = (cogsLines || []).filter((l: any) => {
        const d = l.journal_entry?.entry_date;
        if (!d) return false;
        if (d < effectiveStart) return false;
        if (effectiveEnd && d > effectiveEnd) return false;
        return true;
      }).reduce((s: number, l: any) => s + Number(l.debit || 0) - Number(l.credit || 0), 0);
    }

    // Sales Returns & Allowances from Chart of Accounts
    const salesReturnsAccount = (accountsRes.data || []).find((a: any) =>
      a.name.toLowerCase().includes('sales return') || a.name.toLowerCase().includes('allowance')
    );
    let salesReturnsTotal = 0;
    if (salesReturnsAccount) {
      const { data: srLines } = await supabase
        .from('journal_lines')
        .select('debit, credit, journal_entry:journal_entries!inner(entry_date)')
        .eq('account_id', salesReturnsAccount.id);
      salesReturnsTotal = (srLines || []).filter((l: any) => {
        const d = l.journal_entry?.entry_date;
        if (!d) return false;
        if (d < effectiveStart) return false;
        if (effectiveEnd && d > effectiveEnd) return false;
        return true;
      }).reduce((s: number, l: any) => s + Number(l.debit || 0) - Number(l.credit || 0), 0);
    }

    // Operating Expenses from Chart of Accounts (exclude COGS, Sales Returns, Discount Given)
    const OPEX_EXCLUDED = new Set(['5000', '4050', '4200']);
    const opexAccounts = (accountsRes.data || []).filter((a: any) =>
      a.account_type === 'expense' &&
      !OPEX_EXCLUDED.has(a.code) &&
      !a.name.toLowerCase().includes('cost of goods') &&
      !a.name.toLowerCase().includes('sales return')
    );
    let totalOperatingExpenses = 0;
    for (const acc of opexAccounts) {
      const { data: opexLines } = await supabase
        .from('journal_lines')
        .select('debit, credit, journal_entry:journal_entries!inner(entry_date)')
        .eq('account_id', acc.id);
      const netDebit = (opexLines || []).filter((l: any) => {
        const d = l.journal_entry?.entry_date;
        if (!d) return false;
        if (d < effectiveStart) return false;
        if (effectiveEnd && d > effectiveEnd) return false;
        return true;
      }).reduce((s: number, l: any) => s + Number(l.debit || 0) - Number(l.credit || 0), 0);
      totalOperatingExpenses += Math.max(0, netDebit);
    }

    const grossProfit = totalRevenue - Math.max(0, salesReturnsTotal) - Math.max(0, cogsActual);
    const netProfit = grossProfit - Math.max(0, totalOperatingExpenses);
    const inventoryValue = (invItemsRes.data || []).reduce((s: number, item: any) => s + (Number(item.quantity_on_hand) * Number(item.product?.cost_price || 0)), 0);

    setStats({
      totalRevenue,
      totalPurchases,
      grossProfit,
      netProfit,
      totalOrders: invoicesRes.data?.length || 0,
      totalCustomers: customersRes.data?.length || 0,
      totalProducts: productsRes.data?.length || 0,
      inventoryValue,
      cogsActual,
      salesReturnsTotal,
      totalOperatingExpenses,
    });

    const productMap: Record<string, { name: string; sales: number; revenue: number; cost: number; unit?: string }> = {};
    (topProductsRes.data || []).forEach((item: any) => {
      if (item.product) {
        const id = item.product_id;
        if (!productMap[id]) productMap[id] = { name: item.product.name, sales: 0, revenue: 0, cost: 0, unit: item.unit_name };
        productMap[id].sales += Number(item.quantity);
        productMap[id].revenue += Number(item.subtotal);
        productMap[id].cost += Number(item.quantity) * Number(item.product.cost_price || 0);
      }
    });
    setTopProducts(Object.values(productMap).map(p => ({ ...p, profit: p.revenue - p.cost })).sort((a, b) => b.revenue - a.revenue).slice(0, 10));

    setTopCustomers((topCustomersRes.data || []).map((c: any) => ({
      name: c.name,
      purchases: 0,
      revenue: c.total_purchases,
    })));

    const monthly = await getMonthlyData();
    setMonthlyData(monthly);

    const catData = await getCategoryRevenue(effectiveStart, effectiveEnd || null);
    setCategoryData(catData);

    setLoading(false);
  }

  function getDateRange(period: string): { startDate: string; endDate: string | null } {
    const now = new Date();
    const today = now.toISOString().split('T')[0];

    switch (period) {
      case 'today':
        return { startDate: today, endDate: today };
      case 'this_week':
        const weekStart = new Date(now.setDate(now.getDate() - now.getDay())).toISOString().split('T')[0];
        return { startDate: weekStart, endDate: today };
      case 'this_month':
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
        return { startDate: monthStart, endDate: null };
      case 'this_quarter':
        const quarterStart = Math.floor(now.getMonth() / 3) * 3;
        const qStart = new Date(now.getFullYear(), quarterStart, 1).toISOString().split('T')[0];
        return { startDate: qStart, endDate: null };
      case 'this_year':
        const yearStart = new Date(now.getFullYear(), 0, 1).toISOString().split('T')[0];
        return { startDate: yearStart, endDate: null };
      case 'custom':
        return { startDate: dateFrom || today, endDate: dateTo || null };
      default:
        return { startDate: today, endDate: null };
    }
  }

  async function getMonthlyData() {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const result: { month: string; sales: number; purchases: number; profit: number }[] = [];

    const currentMonth = new Date().getMonth();
    for (let i = 0; i <= currentMonth; i++) {
      const startDate = new Date(new Date().getFullYear(), i, 1).toISOString().split('T')[0];
      const endDate = new Date(new Date().getFullYear(), i + 1, 0).toISOString().split('T')[0];

      const [invRes, poRes, stockRes] = await Promise.all([
        supabase.from('invoices').select('total_amount').gte('invoice_date', startDate).lt('invoice_date', endDate).neq('status', 'cancelled'),
        supabase.from('purchase_orders').select('total_amount').gte('order_date', startDate).lt('order_date', endDate),
        supabase.from('stock_movements').select('quantity, unit_cost').eq('movement_type', 'sale').gte('created_at', startDate).lt('created_at', endDate),
      ]);

      const sales = (invRes.data || []).reduce((s: number, inv: any) => s + Number(inv.total_amount), 0);
      const purchases = (poRes.data || []).reduce((s: number, po: any) => s + Number(po.total_amount), 0);
      const cogs = (stockRes.data || []).reduce((s: number, m: any) => s + Math.abs(Number(m.quantity)) * Number(m.unit_cost || 0), 0);

      result.push({ month: months[i], sales, purchases, profit: sales - cogs });
    }

    return result;
  }

  async function getCategoryRevenue(startDate: string, endDate: string | null) {
    let query = supabase
      .from('invoice_items')
      .select('subtotal, product:products(category:categories(name))')
      .gte('created_at', startDate);
    if (endDate) query = query.lte('created_at', endDate);
    const { data } = await query;

    const catTotals: Record<string, number> = {};
    (data || []).forEach((item: any) => {
      const catName = item.product?.category?.name || 'Others';
      catTotals[catName] = (catTotals[catName] || 0) + Number(item.subtotal);
    });

    return Object.entries(catTotals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, revenue], i) => ({ name, revenue, color: COLORS[i] }));
  }

  function exportToCSV() {
    let csv = '';
    let filename = '';

    switch (activeTab) {
      case 'sales':
        csv = 'Month,Sales,Purchases,Gross Profit\n' + monthlyData.map(m => `${m.month},${m.sales},${m.purchases},${m.profit}`).join('\n');
        filename = 'sales_report.csv';
        break;
      case 'inventory':
        csv = 'Product,Units Sold,Revenue,Cost,Profit\n' + topProducts.map(p => `"${p.name}",${p.sales},${p.revenue},${p.cost},${p.profit}`).join('\n');
        filename = 'inventory_report.csv';
        break;
      case 'customers':
        csv = 'Customer,Total Revenue\n' + topCustomers.map(c => `"${c.name}",${c.revenue}`).join('\n');
        filename = 'customers_report.csv';
        break;
      default:
        csv = 'Month,Sales,Purchases,Profit\n' + monthlyData.map(m => `${m.month},${m.sales},${m.purchases},${m.profit}`).join('\n');
        filename = 'overview_report.csv';
    }

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handlePrint() {
    window.print();
  }

  const tabs = [
    { id: 'overview', label: 'Overview', icon: BarChart3 },
    { id: 'sales', label: 'Sales', icon: TrendingUp },
    { id: 'inventory', label: 'Inventory', icon: Package },
    { id: 'customers', label: 'Customers', icon: Users },
    { id: 'pl', label: 'P&L', icon: FileSpreadsheet },
  ];

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Reports & Analytics</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Business intelligence and performance insights</p>
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
          <button onClick={handlePrint} className="flex items-center gap-1.5 border border-border px-3 py-2 rounded-lg text-sm hover:bg-muted transition">
            <Printer className="w-3.5 h-3.5" />
          </button>
          <button onClick={exportToCSV} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition">
            <Download className="w-4 h-4" />Export
          </button>
        </div>
      </div>

      <div className="flex gap-1 bg-muted/50 p-1 rounded-xl w-fit overflow-x-auto">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as ReportTab)}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition whitespace-nowrap ${activeTab === tab.id ? 'bg-white text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="stat-card">
          <div className="flex items-center justify-between mb-1">
            <p className="text-xs text-muted-foreground">Total Revenue</p>
            <TrendingUp className="w-4 h-4 text-green-500" />
          </div>
          <p className="text-2xl font-bold text-foreground">{formatCurrency(stats.totalRevenue)}</p>
          <p className="text-xs text-muted-foreground mt-1">{stats.totalOrders} orders</p>
        </div>
        <div className="stat-card">
          <div className="flex items-center justify-between mb-1">
            <p className="text-xs text-muted-foreground">Cost of Goods Sold</p>
            <Package className="w-4 h-4 text-amber-500" />
          </div>
          <p className="text-2xl font-bold text-red-600">{formatCurrency(Math.max(0, stats.cogsActual))}</p>
          <p className="text-xs text-muted-foreground mt-1">{stats.totalRevenue > 0 ? ((Math.max(0, stats.cogsActual) / stats.totalRevenue) * 100).toFixed(1) : 0}% of revenue</p>
        </div>
        <div className="stat-card">
          <div className="flex items-center justify-between mb-1">
            <p className="text-xs text-muted-foreground">Gross Profit</p>
            <BarChart3 className="w-4 h-4 text-blue-500" />
          </div>
          <p className="text-2xl font-bold text-green-600">{formatCurrency(stats.grossProfit)}</p>
          <p className="text-xs font-medium mt-1">{stats.totalRevenue > 0 ? ((stats.grossProfit / stats.totalRevenue) * 100).toFixed(1) : 0}% margin</p>
        </div>
        <div className="stat-card">
          <div className="flex items-center justify-between mb-1">
            <p className="text-xs text-muted-foreground">Inventory Value</p>
            <Package className="w-4 h-4 text-purple-500" />
          </div>
          <p className="text-2xl font-bold text-foreground">{formatCurrency(stats.inventoryValue)}</p>
          <p className="text-xs text-muted-foreground mt-1">{stats.totalProducts} products</p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      ) : (
        <>
          {activeTab === 'overview' && (
            <>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="bg-white rounded-xl border border-border p-5 shadow-sm">
                  <h3 className="text-sm font-semibold text-foreground mb-4">Sales vs Profit Trend</h3>
                  <ResponsiveContainer width="100%" height={250}>
                    <LineChart data={monthlyData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} tickFormatter={v => `${(v/1000).toFixed(0)}K`} />
                      <Tooltip formatter={(v: number) => [formatCurrency(v), '']} contentStyle={{ fontSize: 11, borderRadius: 8 }} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Line type="monotone" dataKey="sales" stroke="#3b82f6" strokeWidth={2} name="Sales" dot={false} />
                      <Line type="monotone" dataKey="profit" stroke="#10b981" strokeWidth={2} name="Profit" dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>

                <div className="bg-white rounded-xl border border-border p-5 shadow-sm">
                  <h3 className="text-sm font-semibold text-foreground mb-4">Revenue by Category</h3>
                  {categoryData.length > 0 ? (
                    <div className="flex items-center gap-4">
                      <ResponsiveContainer width={160} height={160}>
                        <PieChart>
                          <Pie data={categoryData} cx="50%" cy="50%" innerRadius={45} outerRadius={70} paddingAngle={2} dataKey="revenue">
                            {categoryData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                          </Pie>
                          <Tooltip formatter={(v: number) => [formatCurrency(v), '']} contentStyle={{ fontSize: 11, borderRadius: 8 }} />
                        </PieChart>
                      </ResponsiveContainer>
                      <div className="flex-1 space-y-2">
                        {categoryData.map(cat => (
                          <div key={cat.name} className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-1.5">
                              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: cat.color }} />
                              <span className="text-xs text-muted-foreground truncate">{cat.name}</span>
                            </div>
                            <span className="text-xs font-semibold text-foreground">{formatCurrency(cat.revenue)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="text-center py-8 text-muted-foreground text-sm">No category data available</div>
                  )}
                </div>
              </div>

              <div className="table-wrapper">
                <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-foreground">Top Selling Products</h3>
                  <Link href="/reports/inventory" className="text-xs text-blue-600 hover:underline flex items-center gap-1">View Full Report <ArrowRight className="w-3 h-3" /></Link>
                </div>
                <table className="w-full">
                  <thead><tr className="bg-muted/40 border-b border-border">
                    {['#', 'Product', 'Units Sold', 'Revenue', 'Cost', 'Profit', 'Margin'].map(h => <th key={h} className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">{h}</th>)}
                  </tr></thead>
                  <tbody className="divide-y divide-border">
                    {topProducts.length > 0 ? topProducts.slice(0, 5).map((p, i) => (
                      <tr key={i} className="hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-3 text-sm text-muted-foreground">{i + 1}</td>
                        <td className="px-4 py-3 text-sm font-semibold text-foreground">{p.name}</td>
                        <td className="px-4 py-3 text-sm text-foreground">{p.sales} <span className="text-muted-foreground text-xs">{p.unit || 'units'}</span></td>
                        <td className="px-4 py-3 text-sm font-semibold text-foreground">{formatCurrency(p.revenue)}</td>
                        <td className="px-4 py-3 text-sm text-red-600">{formatCurrency(p.cost)}</td>
                        <td className="px-4 py-3 text-sm font-semibold text-green-600">{formatCurrency(p.profit)}</td>
                        <td className="px-4 py-3">
                          <span className={`text-xs font-medium ${p.profit > 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {p.revenue > 0 ? ((p.profit / p.revenue) * 100).toFixed(1) : 0}%
                          </span>
                        </td>
                      </tr>
                    )) : (
                      <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground text-sm">No product sales data</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {activeTab === 'sales' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="bg-white rounded-xl border border-border p-5 shadow-sm">
                <h3 className="text-sm font-semibold text-foreground mb-4">Monthly Sales Trend</h3>
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={monthlyData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} tickFormatter={v => `${(v/1000).toFixed(0)}K`} />
                    <Tooltip formatter={(v: number) => [formatCurrency(v), '']} contentStyle={{ fontSize: 11, borderRadius: 8 }} />
                    <Bar dataKey="sales" fill="#3b82f6" radius={[4, 4, 0, 0]} name="Sales" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="bg-white rounded-xl border border-border p-5 shadow-sm">
                <h3 className="text-sm font-semibold text-foreground mb-4">Profit Margin Trend</h3>
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={monthlyData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} tickFormatter={v => `${(v/1000).toFixed(0)}K`} />
                    <Tooltip formatter={(v: number) => [formatCurrency(v), '']} contentStyle={{ fontSize: 11, borderRadius: 8 }} />
                    <Bar dataKey="profit" fill="#10b981" radius={[4, 4, 0, 0]} name="Gross Profit" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {activeTab === 'inventory' && (
            <div className="table-wrapper">
              <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                <h3 className="text-sm font-semibold text-foreground">Top Products by Revenue</h3>
                <Link href="/reports/inventory" className="text-xs text-blue-600 hover:underline flex items-center gap-1">Full Inventory Report <ArrowRight className="w-3 h-3" /></Link>
              </div>
              <table className="w-full">
                <thead><tr className="bg-muted/40 border-b border-border">
                  {['#', 'Product', 'Units Sold', 'Revenue', 'Cost', 'Profit', 'Margin'].map(h => <th key={h} className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">{h}</th>)}
                </tr></thead>
                <tbody className="divide-y divide-border">
                  {topProducts.map((p, i) => (
                    <tr key={i} className="hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3 text-sm text-muted-foreground">{i + 1}</td>
                      <td className="px-4 py-3 text-sm font-semibold text-foreground">{p.name}</td>
                      <td className="px-4 py-3 text-sm text-foreground">{p.sales} <span className="text-muted-foreground text-xs">{p.unit || 'units'}</span></td>
                      <td className="px-4 py-3 text-sm font-semibold text-foreground">{formatCurrency(p.revenue)}</td>
                      <td className="px-4 py-3 text-sm text-red-600">{formatCurrency(p.cost)}</td>
                      <td className="px-4 py-3 text-sm font-semibold text-green-600">{formatCurrency(p.profit)}</td>
                      <td className="px-4 py-3">
                        <span className={`text-xs font-medium ${p.profit > 0 ? 'text-green-600' : 'text-red-600'}`}>
                          {p.revenue > 0 ? ((p.profit / p.revenue) * 100).toFixed(1) : 0}%
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === 'customers' && (
            <div className="table-wrapper">
              <div className="px-4 py-3 border-b border-border">
                <h3 className="text-sm font-semibold text-foreground">Top Customers by Revenue</h3>
              </div>
              <table className="w-full">
                <thead><tr className="bg-muted/40 border-b border-border">
                  {['#', 'Customer', 'Total Revenue'].map(h => <th key={h} className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">{h}</th>)}
                </tr></thead>
                <tbody className="divide-y divide-border">
                  {topCustomers.map((c, i) => (
                    <tr key={i} className="hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3 text-sm text-muted-foreground">{i + 1}</td>
                      <td className="px-4 py-3 text-sm font-semibold text-foreground">{c.name}</td>
                      <td className="px-4 py-3 text-sm font-semibold text-foreground">{formatCurrency(c.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === 'pl' && (
            <div className="space-y-4 max-w-3xl mx-auto">
              {/* How it works panel */}
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
                <div className="flex items-start gap-3">
                  <Info className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-bold text-blue-900 mb-1.5">How This P&amp;L Is Calculated</p>
                    <div className="text-xs text-blue-800 space-y-1">
                      <p><strong>Sales Revenue</strong> — total of all non-cancelled invoices (current year).</p>
                      <p><strong>Sales Returns</strong> — deducted from revenue when sales return refunds are recorded.</p>
                      <p><strong>COGS</strong> — auto-posted from inventory cost when each invoice is raised (account 5000).</p>
                      <p><strong>Gross Profit</strong> = Net Revenue − COGS. Shows raw selling profitability.</p>
                      <p><strong>Operating Expenses</strong> — journal entries posted to expense accounts (salaries, rent, utilities, etc.).</p>
                      <p><strong>Net Profit</strong> = Gross Profit − Operating Expenses. The bottom line.</p>
                    </div>
                    <Link href="/reports/pl" className="inline-flex items-center gap-1 text-xs text-blue-600 font-semibold mt-2 hover:underline">
                      View Full Statement <ArrowRight className="w-3 h-3" />
                    </Link>
                  </div>
                </div>
              </div>

            <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
              <div className="flex items-center justify-between px-6 py-4 bg-gradient-to-r from-slate-700 to-slate-800">
                <h3 className="text-lg font-bold text-white">Profit & Loss Statement</h3>
                <Link href="/reports/pl" className="text-xs text-blue-300 hover:text-white hover:underline flex items-center gap-1">Full Statement <ArrowRight className="w-3 h-3" /></Link>
              </div>

              {/* Revenue Section */}
              <div className="px-6 py-2 bg-blue-50 border-b border-border">
                <span className="text-xs font-bold text-blue-700 tracking-wide">REVENUE</span>
              </div>
              <div className="flex justify-between items-center px-6 py-2 border-b border-gray-100">
                <span className="text-sm text-gray-700">Sales Revenue</span>
                <span className="text-sm font-medium text-gray-800">{formatCurrency(stats.totalRevenue)}</span>
              </div>
              {stats.salesReturnsTotal > 0 && (
                <div className="flex justify-between items-center px-6 py-2 border-b border-gray-100">
                  <span className="text-sm text-gray-700">Sales Returns &amp; Allowances</span>
                  <span className="text-sm font-medium text-red-600">({formatCurrency(stats.salesReturnsTotal)})</span>
                </div>
              )}
              <div className="flex justify-between items-center px-6 py-2 bg-blue-50 border-b border-border">
                <span className="text-sm font-semibold text-gray-800">Total Revenue</span>
                <span className="text-sm font-bold text-blue-800">{formatCurrency(stats.totalRevenue - stats.salesReturnsTotal)}</span>
              </div>

              {/* COGS Section */}
              <div className="px-6 py-2 bg-orange-50 border-b border-border">
                <span className="text-xs font-bold text-orange-700 tracking-wide">COST OF GOODS SOLD (COGS)</span>
              </div>
              <div className="flex justify-between items-center px-6 py-2 border-b border-gray-100">
                <span className="text-sm text-gray-700">Cost of Goods Sold</span>
                <span className="text-sm font-medium text-red-600">({formatCurrency(Math.max(0, stats.cogsActual))})</span>
              </div>
              <div className="flex justify-between items-center px-6 py-2 bg-orange-50 border-b border-border">
                <span className="text-sm font-semibold text-gray-800">Total COGS</span>
                <span className="text-sm font-bold text-orange-800">({formatCurrency(Math.max(0, stats.cogsActual))})</span>
              </div>

              {/* Gross Profit */}
              <div className="flex justify-between items-center px-6 py-3 bg-green-100 border-b border-border">
                <span className="text-sm font-bold text-gray-800">GROSS PROFIT</span>
                <span className="text-lg font-bold text-green-700">{formatCurrency(stats.grossProfit)}</span>
              </div>

              {/* Operating Expenses from Chart of Accounts */}
              <div className="px-6 py-2 bg-red-50 border-b border-border">
                <span className="text-xs font-bold text-red-700 tracking-wide">OPERATING EXPENSES</span>
              </div>
              <div className="flex justify-between items-center px-6 py-2 border-b border-gray-100">
                <span className="text-sm text-gray-700">Operating Expenses</span>
                <span className="text-sm font-medium text-red-600">({formatCurrency(stats.totalOperatingExpenses)})</span>
              </div>
              <div className="flex justify-between items-center px-6 py-2 bg-red-50 border-b border-border">
                <span className="text-sm font-semibold text-gray-800">Total Operating Expenses</span>
                <span className="text-sm font-bold text-red-800">({formatCurrency(stats.totalOperatingExpenses)})</span>
              </div>

              {/* Operating Profit */}
              <div className="flex justify-between items-center px-6 py-3 bg-green-50 border-b border-border">
                <span className="text-sm font-bold text-gray-800">OPERATING PROFIT</span>
                <span className="text-lg font-bold text-green-700">{formatCurrency(stats.grossProfit - stats.totalOperatingExpenses)}</span>
              </div>

              {/* Net Profit */}
              <div className="flex justify-between items-center px-6 py-4 bg-green-600">
                <span className="text-base font-bold text-white tracking-wide">NET PROFIT</span>
                <span className="text-2xl font-bold text-white">{formatCurrency(stats.netProfit)}</span>
              </div>
            </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
