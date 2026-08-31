'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { formatCurrency, formatDate } from '@/lib/format';
import { toast } from '@/hooks/use-toast';
import { Bell, Package, Search, ChevronLeft, ChevronRight, Filter, RefreshCw, Trash2, CheckCircle, Clock, ShoppingBag, Download } from 'lucide-react';
import type { PurchaseReminder } from '@/lib/types';
import Pagination from '@/components/ui/AppPagination';

interface ReminderWithDetails extends Omit<PurchaseReminder, 'product' | 'quotation'> {
  product?: { id: string; name: string; sku: string; unit: string; cost_price: number; min_stock_level: number; image_url?: string };
  quotation?: { quote_number: string; customer?: { name: string } };
}

export default function PurchaseRemindersPage() {
  const router = useRouter();
  const [reminders, setReminders] = useState<ReminderWithDetails[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'pending' | 'fulfilled' | 'cancelled'>('all');
  const [selectedReminders, setSelectedReminders] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const pageSize = 20;

  useEffect(() => { loadReminders(); }, []);

  async function loadReminders() {
    setLoading(true);
    const { data } = await supabase
      .from('purchase_reminders')
      .select('*, product:products(id, name, sku, unit, cost_price, min_stock_level, image_url), quotation:quotations(quote_number, customer:customers(name))')
      .order('created_at', { ascending: false });
    setReminders((data || []) as any);
    setLoading(false);
  }

  async function dismissReminder(id: string) {
    await supabase.from('purchase_reminders').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', id);
    setReminders(prev => prev.map(r => r.id === id ? { ...r, status: 'cancelled' as const } : r));
    setSelectedReminders(prev => { const next = new Set(prev); next.delete(id); return next; });
    toast({ title: 'Dismissed', description: 'Reminder dismissed' });
  }

  async function bulkDismiss() {
    if (selectedReminders.size === 0) return;
    const ids = Array.from(selectedReminders);
    await supabase.from('purchase_reminders').update({ status: 'cancelled', updated_at: new Date().toISOString() }).in('id', ids);
    setReminders(prev => prev.map(r => selectedReminders.has(r.id) ? { ...r, status: 'cancelled' as const } : r));
    setSelectedReminders(new Set());
    toast({ title: 'Dismissed', description: `${ids.length} reminders dismissed` });
  }

  function toggleSelect(id: string) {
    setSelectedReminders(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function selectAll() {
    const filtered = getFilteredReminders();
    if (selectedReminders.size === filtered.length) {
      setSelectedReminders(new Set());
    } else {
      setSelectedReminders(new Set(filtered.map(r => r.id)));
    }
  }

  function createBulkPO() {
    if (selectedReminders.size === 0) return;
    const pendingSelected = reminders.filter(r => selectedReminders.has(r.id) && r.status === 'pending');
    const productIds = pendingSelected.map(r => r.product_id).filter(Boolean);
    if (productIds.length === 0) return;
    sessionStorage.setItem('bulkReminderProducts', JSON.stringify(productIds));
    sessionStorage.setItem('bulkReminderIds', JSON.stringify(pendingSelected.map(r => r.id)));
    router.push('/purchases');
  }

  function exportReminders() {
    const filtered = getFilteredReminders();
    const rows = filtered.map((r, i) => ({
      '#': i + 1,
      Product: r.product?.name || '',
      SKU: r.product?.sku || '',
      'Current Stock': r.current_stock,
      'Qty Needed': r.quantity_needed,
      'Est. Cost': r.product?.cost_price ? r.product.cost_price * r.quantity_needed : 0,
      Status: r.status,
      'Quotation': r.quotation?.quote_number || '',
      Customer: r.quotation?.customer?.name || '',
      'Created': formatDate(r.created_at),
      'Fulfilled': r.fulfilled_at ? formatDate(r.fulfilled_at) : '',
    }));
    const csv = [
      Object.keys(rows[0] || {}).join(','),
      ...rows.map(row => Object.values(row).map(v => `"${v}"`).join(','))
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `purchase-reminders-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: 'Exported', description: `${rows.length} reminders exported to CSV` });
  }

  function getFilteredReminders() {
    return reminders.filter(r => {
      if (filterStatus !== 'all' && r.status !== filterStatus) return false;
      if (search) {
        const q = search.toLowerCase();
        const name = r.product?.name?.toLowerCase() || '';
        const sku = r.product?.sku?.toLowerCase() || '';
        const quotNum = r.quotation?.quote_number?.toLowerCase() || '';
        if (!name.includes(q) && !sku.includes(q) && !quotNum.includes(q)) return false;
      }
      return true;
    });
  }

  const filtered = getFilteredReminders();
  const paged = filtered.slice((page - 1) * pageSize, page * pageSize);

  const stats = {
    total: reminders.length,
    pending: reminders.filter(r => r.status === 'pending').length,
    fulfilled: reminders.filter(r => r.status === 'fulfilled').length,
    cancelled: reminders.filter(r => r.status === 'cancelled').length,
    totalValue: reminders.filter(r => r.status === 'pending' && r.product?.cost_price)
      .reduce((s, r) => s + (r.product!.cost_price * r.quantity_needed), 0),
  };

  const statusConfig = {
    pending: { label: 'Pending', color: 'text-amber-600', bg: 'bg-amber-100', icon: Clock },
    fulfilled: { label: 'Fulfilled', color: 'text-green-600', bg: 'bg-green-100', icon: CheckCircle },
    cancelled: { label: 'Cancelled', color: 'text-gray-500', bg: 'bg-gray-100', icon: Trash2 },
  };

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link href="/purchases" className="text-muted-foreground hover:text-foreground transition">
              <ChevronLeft className="w-4 h-4" />
            </Link>
            <h1 className="text-2xl font-bold text-foreground">Purchase Reminders</h1>
          </div>
          <p className="text-muted-foreground text-sm mt-0.5">Track products marked for purchase from quotation low stock</p>
        </div>
        <div className="flex items-center gap-2">
          {selectedReminders.size > 0 && (
            <>
              <button
                onClick={createBulkPO}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition"
              >
                <ShoppingBag className="w-4 h-4" />
                Create PO ({selectedReminders.size})
              </button>
              <button
                onClick={bulkDismiss}
                className="flex items-center gap-2 px-4 py-2 border border-red-300 text-red-600 hover:bg-red-50 rounded-lg text-sm font-semibold transition"
              >
                <Trash2 className="w-4 h-4" />
                Dismiss ({selectedReminders.size})
              </button>
            </>
          )}
          <button
            onClick={exportReminders}
            className="flex items-center gap-2 border border-border hover:bg-muted text-foreground px-3 py-2 rounded-lg text-sm font-semibold transition"
          >
            <Download className="w-4 h-4" />
            Export
          </button>
          <button
            onClick={loadReminders}
            className="flex items-center gap-2 border border-border hover:bg-muted text-foreground px-3 py-2 rounded-lg text-sm font-semibold transition"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        {[
          { label: 'Total Reminders', value: stats.total, color: 'text-blue-500 bg-blue-50' },
          { label: 'Pending', value: stats.pending, color: 'text-amber-500 bg-amber-50' },
          { label: 'Fulfilled', value: stats.fulfilled, color: 'text-green-500 bg-green-50' },
          { label: 'Cancelled', value: stats.cancelled, color: 'text-gray-500 bg-gray-50' },
          { label: 'Pending Value', value: formatCurrency(stats.totalValue), color: 'text-purple-500 bg-purple-50' },
        ].map(s => (
          <div key={s.label} className="stat-card flex items-center gap-3">
            <div className={`w-10 h-10 rounded-full flex items-center justify-center ${s.color} shrink-0`}>
              <Bell className="w-5 h-5" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{s.label}</p>
              <p className="text-lg font-bold text-foreground">{s.value}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-border p-4 shadow-sm flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search by product name, SKU, or quotation number..."
            className="w-full pl-8 pr-4 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          />
        </div>
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-muted-foreground" />
          <select
            value={filterStatus}
            onChange={e => { setFilterStatus(e.target.value as any); setPage(1); }}
            className="border border-border rounded-lg px-3 py-2 text-sm focus:outline-none"
          >
            <option value="all">All Status</option>
            <option value="pending">Pending</option>
            <option value="fulfilled">Fulfilled</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
        <button
          onClick={selectAll}
          className="text-xs px-3 py-2 border border-border rounded-lg hover:bg-muted transition"
        >
          {selectedReminders.size === filtered.length && filtered.length > 0 ? 'Deselect All' : 'Select All'}
        </button>
      </div>

      <div className="table-wrapper">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-muted/40 border-b border-border">
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={selectedReminders.size === filtered.length && filtered.length > 0}
                    onChange={selectAll}
                    className="rounded"
                  />
                </th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Product</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Current Stock</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Qty Needed</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Est. Cost</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Quotation</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Status</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Date</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i}>{Array.from({ length: 9 }).map((_, j) => <td key={j} className="px-4 py-3"><div className="h-4 bg-muted rounded animate-pulse" /></td>)}</tr>
                ))
              ) : paged.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-muted-foreground text-sm">
                    {filterStatus === 'all' && !search ? 'No purchase reminders yet' : 'No reminders match your filters'}
                  </td>
                </tr>
              ) : paged.map(r => {
                const prod = r.product;
                const quot = r.quotation;
                const cfg = statusConfig[r.status as keyof typeof statusConfig] || statusConfig.pending;
                const StatusIcon = cfg.icon;
                return (
                  <tr key={r.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3">
                      {r.status === 'pending' && (
                        <input
                          type="checkbox"
                          checked={selectedReminders.has(r.id)}
                          onChange={() => toggleSelect(r.id)}
                          className="rounded"
                        />
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 bg-amber-50 rounded-lg overflow-hidden shrink-0 flex items-center justify-center">
                          {prod?.image_url ? (
                            <img src={prod.image_url} alt="" className="w-full h-full object-cover" />
                          ) : (
                            <Package className="w-4 h-4 text-amber-500" />
                          )}
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-foreground">{prod?.name || 'Unknown'}</p>
                          <p className="text-xs text-muted-foreground">{prod?.sku || ''}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className={`text-sm font-bold ${(r.current_stock || 0) === 0 ? 'text-red-500' : 'text-amber-500'}`}>
                        {r.current_stock}
                      </span>
                      {prod?.min_stock_level ? <span className="text-[10px] text-muted-foreground ml-1">(min: {prod.min_stock_level})</span> : null}
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-semibold text-blue-600">{r.quantity_needed}</td>
                    <td className="px-4 py-3 text-right text-sm font-semibold text-foreground">
                      {prod?.cost_price ? formatCurrency(prod.cost_price * r.quantity_needed) : '—'}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {quot ? (
                        <span>
                          <span className="text-blue-600 font-medium">{quot.quote_number}</span>
                          {quot.customer?.name && <span className="text-muted-foreground ml-1">({quot.customer.name})</span>}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 badge-status ${cfg.bg} ${cfg.color}`}>
                        <StatusIcon className="w-3 h-3" />
                        {cfg.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{formatDate(r.created_at)}</td>
                    <td className="px-4 py-3 text-right">
                      {r.status === 'pending' && (
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => {
                              sessionStorage.setItem('bulkReminderProducts', JSON.stringify([r.product_id]));
                              sessionStorage.setItem('bulkReminderIds', JSON.stringify([r.id]));
                              router.push('/purchases');
                            }}
                            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-blue-50 text-muted-foreground hover:text-blue-600 transition"
                            title="Create PO"
                          >
                            <ShoppingBag className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => dismissReminder(r.id)}
                            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-red-50 text-muted-foreground hover:text-red-600 transition"
                            title="Dismiss"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Pagination
          page={page}
          pageSize={pageSize}
          total={filtered.length}
          onPageChange={setPage}
          onPageSizeChange={(s) => { setPage(1); }}
        />
      </div>
    </div>
  );
}
