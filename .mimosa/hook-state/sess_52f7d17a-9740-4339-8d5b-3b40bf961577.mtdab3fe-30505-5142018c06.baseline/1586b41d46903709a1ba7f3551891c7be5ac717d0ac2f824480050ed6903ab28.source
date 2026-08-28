'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCurrency, formatDate } from '@/lib/format';
import { Store, ShoppingCart, Package, Eye, TrendingUp, Users, Search, ExternalLink } from 'lucide-react';
import type { OnlineOrder } from '@/lib/types';

const statusColors: Record<string, { bg: string; color: string }> = {
  pending: { bg: 'bg-gray-100', color: 'text-gray-600' },
  confirmed: { bg: 'bg-blue-100', color: 'text-blue-600' },
  processing: { bg: 'bg-purple-100', color: 'text-purple-600' },
  shipped: { bg: 'bg-orange-100', color: 'text-orange-600' },
  delivered: { bg: 'bg-green-100', color: 'text-green-600' },
  cancelled: { bg: 'bg-red-100', color: 'text-red-600' },
  refunded: { bg: 'bg-pink-100', color: 'text-pink-600' },
};

const paymentColors: Record<string, string> = {
  cod: 'bg-gray-100 text-gray-700',
  bkash: 'bg-pink-100 text-pink-700',
  nagad: 'bg-orange-100 text-orange-700',
  rocket: 'bg-purple-100 text-purple-700',
  bank_transfer: 'bg-blue-100 text-blue-700',
  sslcommerz: 'bg-teal-100 text-teal-700',
};

export default function OnlineStorePage() {
  const [orders, setOrders] = useState<OnlineOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);
    const { data } = await supabase.from('online_orders').select('*').order('created_at', { ascending: false });
    setOrders(data || []);
    setLoading(false);
  }

  const filtered = orders.filter(o =>
    (!search || o.order_number.toLowerCase().includes(search.toLowerCase()) || o.customer_name.toLowerCase().includes(search.toLowerCase())) &&
    (!filterStatus || o.status === filterStatus)
  );

  const stats = {
    totalOrders: orders.length,
    revenue: orders.filter(o => o.payment_status === 'paid').reduce((s, o) => s + o.total_amount, 0),
    pending: orders.filter(o => o.status === 'pending').length,
    delivered: orders.filter(o => o.status === 'delivered').length,
  };

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Online Store</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Manage your e-commerce orders and catalog</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="flex items-center gap-2 border border-border px-4 py-2 rounded-lg text-sm hover:bg-muted transition">
            <ExternalLink className="w-4 h-4" />View Store
          </button>
          <button className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition">
            <Package className="w-4 h-4" />Manage Products
          </button>
        </div>
      </div>

      {/* Store Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Visitors Today', value: '1,450', change: '+15.2%', icon: Users, color: 'text-blue-500 bg-blue-50' },
          { label: 'Total Orders', value: stats.totalOrders || 6, change: '+8.6%', icon: ShoppingCart, color: 'text-green-500 bg-green-50' },
          { label: 'Online Revenue', value: formatCurrency(stats.revenue || 19400), change: '+12.9%', icon: TrendingUp, color: 'text-purple-500 bg-purple-50' },
          { label: 'Pending Orders', value: stats.pending || 1, change: '', icon: Package, color: 'text-amber-500 bg-amber-50' },
        ].map(s => (
          <div key={s.label} className="stat-card flex items-center gap-3">
            <div className={`w-10 h-10 rounded-full flex items-center justify-center ${s.color}`}><s.icon className="w-5 h-5" /></div>
            <div>
              <p className="text-xs text-muted-foreground">{s.label}</p>
              <p className="text-lg font-bold text-foreground">{s.value}</p>
              {s.change && <p className="text-xs text-green-600 font-medium">{s.change}</p>}
            </div>
          </div>
        ))}
      </div>

      {/* Online Products Banner */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-700 rounded-xl p-5 text-white">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-bold text-lg mb-1">Your Online Store is Live</h3>
            <p className="text-blue-100 text-sm">Customers can browse and order products from your digital catalog.</p>
            <div className="flex gap-3 mt-3">
              <div className="bg-white/20 rounded-lg px-3 py-1.5 text-sm"><span className="font-semibold">12</span> Online Products</div>
              <div className="bg-white/20 rounded-lg px-3 py-1.5 text-sm"><span className="font-semibold">3.2%</span> Conversion Rate</div>
            </div>
          </div>
          <Store className="w-16 h-16 text-blue-200 opacity-50" />
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl border border-border p-4 shadow-sm flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search orders..." className="w-full pl-8 pr-4 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
        </div>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="border border-border rounded-lg px-3 py-2 text-sm focus:outline-none">
          <option value="">All Status</option>
          {Object.keys(statusColors).map(k => <option key={k} value={k}>{k.charAt(0).toUpperCase() + k.slice(1)}</option>)}
        </select>
      </div>

      {/* Orders Table */}
      <div className="table-wrapper">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-muted/40 border-b border-border">
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Order #</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Customer</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">City</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Payment</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Amount</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Status</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Date</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading ? Array.from({length: 5}).map((_, i) => (
                <tr key={i}>{Array.from({length: 8}).map((_, j) => <td key={j} className="px-4 py-3"><div className="h-4 bg-muted rounded animate-pulse" /></td>)}</tr>
              )) : filtered.map(o => {
                const statusCfg = statusColors[o.status] || statusColors.pending;
                return (
                  <tr key={o.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3"><span className="text-sm font-semibold text-blue-600">{o.order_number}</span></td>
                    <td className="px-4 py-3">
                      <div>
                        <p className="text-sm font-semibold text-foreground">{o.customer_name}</p>
                        <p className="text-xs text-muted-foreground">{o.customer_phone}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-foreground">{o.customer_city || '—'}</td>
                    <td className="px-4 py-3">
                      <span className={`badge-status ${paymentColors[o.payment_method] || 'bg-gray-100 text-gray-700'} uppercase`}>{o.payment_method}</span>
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-semibold text-foreground">{formatCurrency(o.total_amount)}</td>
                    <td className="px-4 py-3">
                      <span className={`badge-status ${statusCfg.bg} ${statusCfg.color} capitalize`}>{o.status}</span>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{formatDate(o.created_at)}</td>
                    <td className="px-4 py-3 text-right">
                      <button className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-blue-50 text-muted-foreground hover:text-blue-600 transition ml-auto"><Eye className="w-3.5 h-3.5" /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-3 border-t border-border"><p className="text-xs text-muted-foreground">{filtered.length} orders</p></div>
      </div>
    </div>
  );
}
