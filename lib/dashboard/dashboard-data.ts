/**
 * Dashboard data layer.
 *
 * Split into three queries by cost, not by section, because the page's job is
 * to show numbers fast:
 *
 *   overview   ~14 small reads (KPI row, lists, dues). The only thing the
 *              operator needs on arrival, so it must not queue behind anything.
 *   charts     sales_monthly RPC + a full products scan for the category mix.
 *              The scan is the reason the pie chart used to hold up the KPIs.
 *   inventory  getInventoryValue() + the reconciliation RPC. Both walk the
 *              stock ledger; the slowest work on the page by a wide margin.
 *
 * Everything reads through `supabase` directly. Offline is already handled one
 * layer down: `lib/offline/read-fallback.ts` wraps the client, caches every
 * select result sealed and per-user, and answers from the local replica when
 * the network is gone. Adding `cachedQuery` on top would have meant a third
 * cache with a third staleness clock over the same rows.
 */

import { supabase } from '@/lib/supabase';
import { getInventoryValue } from '@/lib/inventory-value';
import type { Customer } from '@/lib/types';

export interface DashboardStats {
  todaySales: number;
  monthlySales: number;
  inventoryItems: number;
  receivables: number;
  payables: number;
  totalExpenses: number;
  todayCollection: number;
  deliveryPending: number;
  deliveryInTransit: number;
  deliveryDelivered: number;
  deliveryFailed: number;
  onlineOrders: number;
  onlineRevenue: number;
}

export interface DueRow {
  id: string;
  name: string;
  due: number;
}

export interface SalesPoint {
  month: string;
  sales: number;
  profit: number;
}

export interface CategorySlice {
  name: string;
  value: number;
  color: string;
}

export interface DashboardOverview {
  stats: DashboardStats;
  lowStockItems: any[];
  topCustomers: Customer[];
  invoiceDues: DueRow[];
  manualDues: DueRow[];
  recentActivities: any[];
}

export interface DashboardCharts {
  salesChartData: SalesPoint[];
  categoryData: CategorySlice[];
}

export interface DashboardInventory {
  /** null when the valuation RPC failed — distinct from a genuine zero. */
  inventoryValue: number | null;
  reconciliation: any[];
}

export const CATEGORY_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#6b7280'];

export const EMPTY_STATS: DashboardStats = {
  todaySales: 0,
  monthlySales: 0,
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
};

export const dashboardKeys = {
  all: ['dashboard'] as const,
  overview: () => ['dashboard', 'overview'] as const,
  charts: () => ['dashboard', 'charts'] as const,
  inventory: () => ['dashboard', 'inventory'] as const,
};

const toISODate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/* ------------------------------------------------------------------ */

export async function fetchDashboardOverview(): Promise<DashboardOverview> {
  const now = new Date();
  const today = toISODate(now);
  const monthStart = toISODate(new Date(now.getFullYear(), now.getMonth(), 1));
  const yearStart = toISODate(new Date(now.getFullYear(), 0, 1));

  const [
    todayInvRes, monthlyInvRes, customersRes, suppliersRes,
    dlvRes, onlineOrdersRes, topCustRes, unpaidInvRes, recvEntriesRes, recvPaymentsRes,
    lowStockRes, actRes, expensesRes, todayCollectionRes,
  ] = await Promise.all([
    supabase.from('invoices').select('total_amount').eq('invoice_date', today).neq('status', 'cancelled'),
    supabase.from('invoices').select('total_amount, created_at').gte('invoice_date', monthStart).neq('status', 'cancelled'),
    supabase.from('customers').select('outstanding_balance'),
    supabase.from('suppliers').select('outstanding_balance'),
    supabase.from('deliveries').select('status'),
    supabase.from('online_orders').select('total_amount, status').gte('created_at', monthStart),
    supabase.from('customers').select('*').order('total_purchases', { ascending: false }).limit(5),
    supabase.from('invoices').select('customer_id, balance_due, customer:customers(id, name)').not('status', 'in', '("cancelled","refunded","paid")').gt('balance_due', 0),
    supabase.from('journal_entries').select('id, customer_id, total_debit, customer:customers(id, name)').eq('reference_type', 'receivable').eq('is_posted', true),
    supabase.from('payments').select('reference_id, amount').eq('reference_type', 'receivable').eq('is_reversed', false),
    supabase.from('inventory_items').select('quantity_on_hand, product:products(id, name, sku, min_stock_level, image_url)').lt('quantity_on_hand', 20).limit(5),
    supabase.from('activity_logs').select('*').order('created_at', { ascending: false }).limit(5),
    supabase.from('journal_entries').select('total_debit, entry_date').eq('reference_type', 'manual').eq('is_posted', true).gte('entry_date', yearStart),
    supabase.from('payments').select('amount').eq('payment_date', today).eq('payment_type', 'received').neq('is_reversed', true).neq('payment_for', 'reversal_payment'),
  ]);

  // Stat-card row count — a zero-payload head count instead of paginating the
  // whole inventory_items table through the wire just to count it.
  const { count: invItemCount } = await supabase
    .from('inventory_items')
    .select('id', { count: 'exact', head: true });

  const todaySales = (todayInvRes.data || []).reduce((s: number, i: any) => s + Number(i.total_amount), 0);
  const monthlySales = (monthlyInvRes.data || []).reduce((s: number, i: any) => s + Number(i.total_amount), 0);
  const receivables = (customersRes.data || []).reduce((s: number, c: any) => s + Number(c.outstanding_balance), 0);
  const payables = (suppliersRes.data || []).reduce((s: number, s2: any) => s + Number(s2.outstanding_balance), 0);

  const deliveries = dlvRes.data || [];
  const onlineOrders = onlineOrdersRes.data || [];
  const totalExpenses = (expensesRes.data || []).reduce((s: number, e: any) => s + Number(e.total_debit), 0);
  const todayCollection = (todayCollectionRes.data || []).reduce((s: number, p: any) => s + Number(p.amount), 0);

  const deliveryStats: Record<string, number> = { pending: 0, in_transit: 0, delivered: 0, failed: 0 };
  deliveries.forEach((d: any) => { if (deliveryStats[d.status] !== undefined) deliveryStats[d.status]++; });

  const stats: DashboardStats = {
    todaySales,
    monthlySales,
    inventoryItems: invItemCount ?? 0,
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
  };

  const lowStock = (lowStockRes.data || []).filter((i: any) => i.product && i.quantity_on_hand < (i.product.min_stock_level || 20));
  const lowStockItems = lowStock.slice(0, 3);
  const topCustomers = (topCustRes.data || []) as Customer[];

  // Invoice dues per customer: unpaid invoice balances (same rule as the sales page)
  const invDueMap = new Map<string, DueRow>();
  (unpaidInvRes.data || []).forEach((i: any) => {
    if (!i.customer_id || !i.customer) return;
    const entry = invDueMap.get(i.customer_id) || { id: i.customer.id ?? i.customer_id, name: i.customer.name, due: 0 };
    entry.due += Number(i.balance_due || 0);
    invDueMap.set(i.customer_id, entry);
  });
  const invoiceDues = [...invDueMap.values()].filter((d) => d.due > 0).sort((a, b) => b.due - a.due).slice(0, 5);

  // Manual dues per customer: receivable journal entries minus payments against them
  const paidByEntry = new Map<string, number>();
  (recvPaymentsRes.data || []).forEach((p: any) => {
    if (p.reference_id) paidByEntry.set(p.reference_id, (paidByEntry.get(p.reference_id) || 0) + Number(p.amount || 0));
  });
  const manualDueMap = new Map<string, DueRow>();
  (recvEntriesRes.data || []).forEach((e: any) => {
    if (!e.customer_id || !e.customer) return;
    const outstanding = Number(e.total_debit || 0) - (paidByEntry.get(e.id) || 0);
    if (outstanding <= 0) return;
    const entry = manualDueMap.get(e.customer_id) || { id: e.customer.id ?? e.customer_id, name: e.customer.name, due: 0 };
    entry.due += outstanding;
    manualDueMap.set(e.customer_id, entry);
  });
  const manualDues = [...manualDueMap.values()].sort((a, b) => b.due - a.due).slice(0, 5);

  return {
    stats,
    lowStockItems,
    topCustomers,
    invoiceDues,
    manualDues,
    recentActivities: actRes.data || [],
  };
}

/* ------------------------------------------------------------------ */

export async function fetchDashboardCharts(): Promise<DashboardCharts> {
  const [salesChartData, categoryData] = await Promise.all([fetchSalesSeries(), fetchCategoryMix()]);
  return { salesChartData, categoryData };
}

async function fetchSalesSeries(): Promise<SalesPoint[]> {
  // Rolling last-6-months window ending with the current month — the old
  // version hardcoded Jan–Jun, so from July onward the chart never showed
  // current data. sales_monthly (same source as /reports/sales) returns real
  // revenue and COGS-based cost; the old profit line was a flat 35% estimate.
  const now = new Date();
  const start = toISODate(new Date(now.getFullYear(), now.getMonth() - 5, 1));
  const end = toISODate(new Date(now.getFullYear(), now.getMonth() + 1, 0));
  const { data } = await supabase.rpc('sales_monthly', { p_start_date: start, p_end_date: end });
  const byMonth = new Map(((data || []) as any[]).map((r: any) => [r.month, r]));

  const months: { key: string; label: string }[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleString('en-US', { month: 'short' }),
    });
  }

  return months.map(({ key, label }) => {
    const row = byMonth.get(key) as any;
    const revenue = Number(row?.revenue || 0);
    const cost = Number(row?.cost || 0);
    return { month: label, sales: revenue, profit: revenue - cost };
  });
}

async function fetchCategoryMix(): Promise<CategorySlice[]> {
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
      color: CATEGORY_COLORS[i],
    }));
}

/* ------------------------------------------------------------------ */

export async function fetchDashboardInventory(): Promise<DashboardInventory> {
  const [invResult, reconRes] = await Promise.all([
    getInventoryValue(supabase),
    supabase.rpc('get_inventory_reconciliation'),
  ]);

  const reconciliation = (((reconRes.data || []) as any[])).sort((a: any, b: any) => a.sort_key - b.sort_key);

  // getInventoryValue() swallows its own failures and reports source 'error'
  // with total 0. Passing that through would print a failed valuation as a
  // real ৳0, so it becomes null and the card renders an em dash instead.
  return {
    inventoryValue: invResult.source === 'error' ? null : invResult.total,
    reconciliation,
  };
}
