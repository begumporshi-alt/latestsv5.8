'use client';

import { useEffect, useState, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import { Activity, Search, Filter, ChevronLeft, ChevronRight, FileText, ShoppingCart, Package, User, DollarSign, Truck, Settings, ClipboardList, Database, CircleAlert as AlertCircle } from 'lucide-react';

interface ActivityLog {
  id: string;
  action: string;
  entity_type: string;
  entity_label: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  user_id: string | null;
}

const PAGE_SIZE = 20;

const actionIcons: Record<string, { icon: typeof FileText; color: string; bg: string }> = {
  create: { icon: FileText, color: 'text-green-600', bg: 'bg-green-100' },
  insert: { icon: FileText, color: 'text-green-600', bg: 'bg-green-100' },
  update: { icon: ClipboardList, color: 'text-blue-600', bg: 'bg-blue-100' },
  edit: { icon: ClipboardList, color: 'text-blue-600', bg: 'bg-blue-100' },
  delete: { icon: AlertCircle, color: 'text-red-600', bg: 'bg-red-100' },
  cancel: { icon: AlertCircle, color: 'text-red-600', bg: 'bg-red-100' },
  sale: { icon: ShoppingCart, color: 'text-green-600', bg: 'bg-green-100' },
  purchase: { icon: Package, color: 'text-amber-600', bg: 'bg-amber-100' },
  payment: { icon: DollarSign, color: 'text-emerald-600', bg: 'bg-emerald-100' },
  delivery: { icon: Truck, color: 'text-purple-600', bg: 'bg-purple-100' },
  customer: { icon: User, color: 'text-indigo-600', bg: 'bg-indigo-100' },
  supplier: { icon: User, color: 'text-cyan-600', bg: 'bg-cyan-100' },
  inventory: { icon: Database, color: 'text-slate-600', bg: 'bg-slate-100' },
  settings: { icon: Settings, color: 'text-gray-600', bg: 'bg-gray-100' },
  default: { icon: Activity, color: 'text-slate-600', bg: 'bg-slate-100' },
};

function getIconConfig(action: string, entityType: string) {
  const a = action.toLowerCase();
  if (a.includes('create') || a.includes('insert')) return actionIcons.create;
  if (a.includes('update') || a.includes('edit')) return actionIcons.update;
  if (a.includes('delete') || a.includes('cancel')) return actionIcons.delete;
  if (a.includes('sale') || a.includes('invoice')) return actionIcons.sale;
  if (a.includes('purchase') || a.includes('grn')) return actionIcons.purchase;
  if (a.includes('payment') || a.includes('refund')) return actionIcons.payment;
  if (a.includes('deliver')) return actionIcons.delivery;
  if (a.includes('customer')) return actionIcons.customer;
  if (a.includes('supplier')) return actionIcons.supplier;
  if (a.includes('inventor') || a.includes('stock') || a.includes('product')) return actionIcons.inventory;
  if (a.includes('setting') || a.includes('config')) return actionIcons.settings;
  if (entityType.includes('sale') || entityType.includes('invoice')) return actionIcons.sale;
  if (entityType.includes('purchase') || entityType.includes('grn')) return actionIcons.purchase;
  if (entityType.includes('payment')) return actionIcons.payment;
  if (entityType.includes('deliver')) return actionIcons.delivery;
  if (entityType.includes('customer')) return actionIcons.customer;
  if (entityType.includes('supplier')) return actionIcons.supplier;
  if (entityType.includes('product') || entityType.includes('inventor')) return actionIcons.inventory;
  return actionIcons.default;
}

function formatActionLabel(action: string): string {
  return action
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

type PeriodKey = 'today' | 'yesterday' | 'week' | 'month' | 'all';

const periodConfig: Record<PeriodKey, { label: string; days: number | null }> = {
  today:      { label: 'Today',      days: 0 },
  yesterday:  { label: 'Yesterday',  days: 1 },
  week:       { label: 'This Week',  days: 7 },
  month:      { label: 'This Month', days: 30 },
  all:        { label: 'All Time',   days: null },
};

export default function ActivityPage() {
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [search, setSearch] = useState('');
  const [period, setPeriod] = useState<PeriodKey>('today');
  const [actionFilter, setActionFilter] = useState('all');

  // Get unique action types from loaded data for the filter dropdown
  const actionTypes = useMemo(() => {
    const set = new Set<string>();
    logs.forEach(l => set.add(l.action));
    return Array.from(set).sort();
  }, [logs]);

  useEffect(() => {
    loadActivities();
  }, [period, actionFilter, page]);

  useEffect(() => {
    if (page !== 0) setPage(0);
  }, [period, actionFilter]);

  async function loadActivities() {
    setLoading(true);

    let query = supabase.from('activity_logs').select('*', { count: 'exact' });

    // Period filter
    if (period === 'today') {
      const todayStr = new Date().toISOString().split('T')[0];
      query = query.gte('created_at', `${todayStr}T00:00:00`);
    } else if (period === 'yesterday') {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yStr = yesterday.toISOString().split('T')[0];
      const todayStr = new Date().toISOString().split('T')[0];
      query = query.gte('created_at', `${yStr}T00:00:00`).lt('created_at', `${todayStr}T00:00:00`);
    } else if (period === 'week' || period === 'month') {
      const days = periodConfig[period].days!;
      const start = new Date();
      start.setDate(start.getDate() - days);
      query = query.gte('created_at', start.toISOString());
    }

    // Action type filter
    if (actionFilter !== 'all') {
      query = query.eq('action', actionFilter);
    }

    query = query.order('created_at', { ascending: false }).range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    const { data, count, error } = await query;

    if (error) {
      setLogs([]);
      setTotalCount(0);
    } else {
      setLogs((data || []) as ActivityLog[]);
      setTotalCount(count || 0);
    }
    setLoading(false);
  }

  const filteredLogs = useMemo(() => {
    if (!search) return logs;
    const s = search.toLowerCase();
    return logs.filter(l =>
      l.action.toLowerCase().includes(s) ||
      (l.entity_label || '').toLowerCase().includes(s) ||
      l.entity_type.toLowerCase().includes(s)
    );
  }, [logs, search]);

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  const stats = useMemo(() => {
    const todayLogs = logs.filter(l => {
      const d = new Date(l.created_at);
      const today = new Date();
      return d.toDateString() === today.toDateString();
    });
    return {
      total: totalCount,
      today: todayLogs.length,
    };
  }, [logs, totalCount]);

  return (
    <div className="space-y-5 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Recent Activity</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Track all actions across the system
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="bg-white border border-border rounded-lg px-3 py-1.5 text-sm">
            <span className="text-muted-foreground">Total: </span>
            <span className="font-bold text-foreground">{stats.total}</span>
          </div>
          <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-1.5 text-sm">
            <span className="text-green-700">Today: </span>
            <span className="font-bold text-green-700">{stats.today}</span>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl border border-border p-3 shadow-sm flex flex-wrap gap-3">
        {/* Period filter */}
        <div className="flex items-center gap-1.5">
          <Filter className="w-3.5 h-3.5 text-muted-foreground mr-1" />
          {(Object.keys(periodConfig) as PeriodKey[]).map(key => (
            <button
              key={key}
              onClick={() => setPeriod(key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                period === key
                  ? 'bg-blue-600 text-white'
                  : 'border border-border text-muted-foreground hover:bg-muted'
              }`}
            >
              {periodConfig[key].label}
            </button>
          ))}
        </div>

        <div className="w-px h-7 bg-border" />

        {/* Action type filter */}
        <select
          value={actionFilter}
          onChange={e => setActionFilter(e.target.value)}
          className="border border-border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 bg-white"
        >
          <option value="all">All Actions</option>
          {actionTypes.map(a => (
            <option key={a} value={a}>{formatActionLabel(a)}</option>
          ))}
        </select>

        {/* Search */}
        <div className="relative flex-1 min-w-[160px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search activities..."
            className="w-full pl-8 pr-4 py-1.5 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          />
        </div>
      </div>

      {/* Activity List */}
      <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
        {loading ? (
          <div className="p-8 space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 animate-pulse">
                <div className="w-9 h-9 rounded-full bg-muted" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3 bg-muted rounded w-1/3" />
                  <div className="h-2.5 bg-muted rounded w-1/4" />
                </div>
              </div>
            ))}
          </div>
        ) : filteredLogs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16">
            <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-3">
              <Activity className="w-6 h-6 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-muted-foreground">No activities found</p>
            <p className="text-xs text-muted-foreground/70 mt-1">
              {period === 'today' ? 'No activity has been recorded today yet.' : 'Try changing the filters.'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {filteredLogs.map((log) => {
              const config = getIconConfig(log.action, log.entity_type);
              const Icon = config.icon;
              return (
                <div key={log.id} className="flex items-start gap-3 px-4 py-3 hover:bg-muted/20 transition-colors">
                  <div className={`w-9 h-9 rounded-full ${config.bg} flex items-center justify-center shrink-0`}>
                    <Icon className={`w-4 h-4 ${config.color}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-foreground">
                        {formatActionLabel(log.action)}
                      </span>
                      {log.entity_type && (
                        <span className="text-xs text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded">
                          {log.entity_type.replace(/_/g, ' ')}
                        </span>
                      )}
                    </div>
                    {log.entity_label && (
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">
                        {log.entity_label}
                      </p>
                    )}
                    {log.metadata && typeof log.metadata === 'object' && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {Object.entries(log.metadata).slice(0, 3).map(([k, v]) => (
                          <span key={k} className="text-[10px] text-muted-foreground bg-muted/40 px-1.5 py-0.5 rounded">
                            {k}: {typeof v === 'object' ? '...' : String(v).slice(0, 30)}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-xs text-muted-foreground">
                      {new Date(log.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                    </div>
                    <div className="text-[10px] text-muted-foreground/70 mt-0.5">
                      {formatTimeAgo(log.created_at)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Pagination */}
        {!loading && totalCount > PAGE_SIZE && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-border">
            <p className="text-xs text-muted-foreground">
              Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, totalCount)} of {totalCount}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0}
                className="w-7 h-7 flex items-center justify-center rounded-lg border border-border hover:bg-muted transition disabled:opacity-40"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-xs text-muted-foreground font-medium">
                Page {page + 1} of {totalPages}
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className="w-7 h-7 flex items-center justify-center rounded-lg border border-border hover:bg-muted transition disabled:opacity-40"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
