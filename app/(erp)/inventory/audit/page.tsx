'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/format';
import { printNode } from '@/lib/print';
import { toast } from '@/hooks/use-toast';
import {
  RefreshCw, Printer, AlertTriangle, CheckCircle2, Info, Trash2,
  ShieldCheck, Layers, History as HistoryIcon,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReconCheck {
  sort_key: number;
  check_name: string;
  status: 'ok' | 'drift' | 'info';
  drift: number;
  details: string;
}

interface Layer {
  layer_id: string;
  batch_number: string | null;
  product_id: string;
  product_name: string;
  product_sku: string;
  warehouse: string | null;
  kind: 'ADJ' | 'REDUCE' | 'IOU' | 'UNNAMED' | 'OTHER';
  quantity_remaining: number;
  unit_cost: number;
  value: number;
  created_at: string;
  pair_positive_qty: number;
  pair_positive_value: number;
  pair_net_qty: number;
  counter_qty: number;
}

interface DriftAccount {
  account_id: string;
  code: string;
  name: string;
  account_type: string;
  cached_balance: number;
  lines_balance: number;
  gap: number;
}

interface LogRow {
  id: number;
  checked_at: string;
  all_ok: boolean;
  // stored as {"checks": [...]} (array_agg wrapped in to_jsonb), but tolerate a bare array
  checks: unknown;
}

function logChecks(h: LogRow): { sort_key: number; check_name: string; status: string; drift: number; details: string }[] {
  const c = h.checks;
  if (Array.isArray(c)) return c as { sort_key: number; check_name: string; status: string; drift: number; details: string }[];
  if (c && typeof c === 'object' && Array.isArray((c as { checks?: unknown }).checks)) {
    return (c as { checks: { sort_key: number; check_name: string; status: string; drift: number; details: string }[] }).checks;
  }
  return [];
}

type Tab = 'layers' | 'balances' | 'history';

const KIND_META: Record<string, { label: string; className: string; desc: string }> = {
  ADJ: { label: 'Oversell IOU', className: 'bg-red-50 text-red-700 border-red-200', desc: 'a sale took more units than the ledger held (old flow, before the warn-and-confirm gate)' },
  REDUCE: { label: 'Reduction', className: 'bg-orange-50 text-orange-700 border-orange-200', desc: 'stock was reduced on a product whose ledger was already empty' },
  IOU: { label: 'Live IOU', className: 'bg-amber-50 text-amber-700 border-amber-200', desc: 'a recent deliberate oversell — someone confirmed "Sell anyway" at the counter' },
  UNNAMED: { label: 'Unnamed', className: 'bg-slate-100 text-slate-600 border-slate-300', desc: 'an old test-era row with no batch number' },
  OTHER: { label: 'Other', className: 'bg-slate-100 text-slate-600 border-slate-300', desc: 'an unclassified negative layer' },
};

const STATUS_STYLE: Record<string, { border: string; badge: string; icon: typeof CheckCircle2 }> = {
  ok: { border: 'border-emerald-200 bg-emerald-50/40', badge: 'bg-emerald-100 text-emerald-700', icon: CheckCircle2 },
  drift: { border: 'border-red-300 bg-red-50/50', badge: 'bg-red-100 text-red-700', icon: AlertTriangle },
  info: { border: 'border-amber-200 bg-amber-50/40', badge: 'bg-amber-100 text-amber-700', icon: Info },
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function InventoryAuditPage() {
  const [loading, setLoading] = useState(true);
  const [checks, setChecks] = useState<ReconCheck[]>([]);
  const [layers, setLayers] = useState<Layer[]>([]);
  const [drift, setDrift] = useState<DriftAccount[]>([]);
  const [history, setHistory] = useState<LogRow[]>([]);

  const [tab, setTab] = useState<Tab>('layers');
  const [kindFilter, setKindFilter] = useState<string>('all');
  const [warehouseFilter, setWarehouseFilter] = useState<string>('all');
  const [search, setSearch] = useState('');

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showPurge, setShowPurge] = useState(false);
  const [purgeReason, setPurgeReason] = useState('');
  const [purging, setPurging] = useState(false);

  const [repairOpen, setRepairOpen] = useState(false);
  const [repairing, setRepairing] = useState(false);

  const sheetRef = useRef<HTMLDivElement>(null);

  // -------------------------------------------------------------------------
  // Data loading
  // -------------------------------------------------------------------------

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [reconRes, layersRes, driftRes, logRes] = await Promise.all([
        supabase.rpc('get_inventory_reconciliation'),
        supabase.rpc('get_negative_inventory_layers'),
        supabase.rpc('get_account_balance_drift'),
        supabase.from('inventory_reconciliation_log')
          .select('*').order('checked_at', { ascending: false }).limit(30),
      ]);
      if (reconRes.error) throw reconRes.error;
      if (layersRes.error) throw layersRes.error;
      if (driftRes.error) throw driftRes.error;
      if (logRes.error) throw logRes.error;

      setChecks(((reconRes.data || []) as ReconCheck[]).sort((a, b) => a.sort_key - b.sort_key));
      setLayers((layersRes.data || []) as Layer[]);
      setDrift((driftRes.data || []) as DriftAccount[]);
      setHistory((logRes.data || []) as LogRow[]);
    } catch (e: unknown) {
      toast({
        title: 'Failed to load audit data',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // -------------------------------------------------------------------------
  // Layers filtering / selection
  // -------------------------------------------------------------------------

  const warehouses = useMemo(() => {
    const s = new Set<string>();
    layers.forEach(l => { if (l.warehouse) s.add(l.warehouse); });
    return Array.from(s).sort();
  }, [layers]);

  const filteredLayers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return layers.filter(l => {
      if (kindFilter !== 'all' && l.kind !== kindFilter) return false;
      if (warehouseFilter !== 'all' && (l.warehouse || '—') !== warehouseFilter) return false;
      if (q) {
        const hay = `${l.product_name} ${l.product_sku} ${l.batch_number || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [layers, kindFilter, warehouseFilter, search]);

  const totalDrag = useMemo(
    () => filteredLayers.reduce((s, l) => s + Math.abs(Number(l.value)), 0),
    [filteredLayers]);

  const selectedLayers = useMemo(
    () => layers.filter(l => selected.has(l.layer_id)),
    [layers, selected]);

  const selectedValue = useMemo(
    () => selectedLayers.reduce((s, l) => s + Math.abs(Number(l.value)), 0),
    [selectedLayers]);

  const toggleSelected = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAllFiltered = () => setSelected(new Set(filteredLayers.map(l => l.layer_id)));

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const runPurge = async () => {
    setPurging(true);
    try {
      const { data, error } = await supabase.rpc('purge_negative_inventory_layers', {
        p_layer_ids: Array.from(selected),
        p_reason: purgeReason.trim(),
        p_username: 'inventory-audit-page',
      });
      if (error) throw error;
      const result = data as { success?: boolean; error?: string; purged?: number; total_value?: number; je_number?: string; counters_updated?: number };
      if (!result?.success) throw new Error(result?.error || 'Purge failed');
      toast({
        title: `Purged ${result.purged} layer${result.purged === 1 ? '' : 's'}`,
        description: `${formatCurrency(result.total_value || 0)} restated to Inventory — journal entry ${result.je_number}, ${result.counters_updated ?? 0} counter pair(s) rebuilt.`,
      });
      setSelected(new Set());
      setPurgeReason('');
      setShowPurge(false);
      await loadData();
    } catch (e: unknown) {
      toast({ title: 'Purge failed', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    } finally {
      setPurging(false);
    }
  };

  const runRepair = async () => {
    setRepairing(true);
    try {
      const { data, error } = await supabase.rpc('recompute_account_balances', {
        p_username: 'inventory-audit-page',
      });
      if (error) throw error;
      const result = data as { success?: boolean; changed?: number; accounts?: { code: string; old: number; new: number; delta: number }[] };
      if (!result?.success) throw new Error('Recompute failed');
      const detail = (result.accounts || [])
        .map(a => `${a.code} ${a.delta >= 0 ? '+' : ''}${formatCurrency(a.delta)}`)
        .join(' · ');
      toast({
        title: result.changed ? `Repaired ${result.changed} account balance${result.changed === 1 ? '' : 's'}` : 'No drift — nothing to repair',
        description: detail || 'All cached balances already match their journal lines.',
      });
      setRepairOpen(false);
      await loadData();
    } catch (e: unknown) {
      toast({ title: 'Repair failed', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    } finally {
      setRepairing(false);
    }
  };

  // -------------------------------------------------------------------------
  // Count sheet (printable, off-screen)
  // -------------------------------------------------------------------------

  const sheetPairs = useMemo(() => {
    const map = new Map<string, { name: string; sku: string; warehouse: string; net: number; positive: number; drag: number }>();
    for (const l of filteredLayers) {
      const key = `${l.product_id}|${l.warehouse || '—'}`;
      const cur = map.get(key) || {
        name: l.product_name, sku: l.product_sku, warehouse: l.warehouse || '—',
        net: Number(l.pair_net_qty), positive: Number(l.pair_positive_qty), drag: 0,
      };
      cur.drag += Math.abs(Number(l.quantity_remaining));
      map.set(key, cur);
    }
    return Array.from(map.values()).sort((a, b) =>
      a.warehouse.localeCompare(b.warehouse) || a.name.localeCompare(b.name));
  }, [filteredLayers]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (loading && checks.length === 0) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="text-center">
          <div className="w-10 h-10 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-muted-foreground text-sm">Loading inventory audit...</p>
        </div>
      </div>
    );
  }

  const checkBySort = (k: number) => checks.find(c => c.sort_key === k);
  const negCheck = checkBySort(5);
  const driftCheck = checkBySort(4);

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Inventory Audit</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Live health of the three inventory records — batch ledger, availability counters and the GL —
            with the tools to act when they disagree.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadData}
            disabled={loading}
            className="inline-flex items-center gap-2 px-3 py-2 text-sm border border-border rounded-lg hover:bg-muted transition disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            onClick={() => printNode(sheetRef.current)}
            disabled={sheetPairs.length === 0}
            className="inline-flex items-center gap-2 px-3 py-2 text-sm border border-border rounded-lg hover:bg-muted transition disabled:opacity-50"
          >
            <Printer className="w-4 h-4" />
            Print Count Sheet
          </button>
        </div>
      </div>

      {/* Overview: reconciliation checks */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {checks.map(c => {
          const style = STATUS_STYLE[c.status] || STATUS_STYLE.info;
          const Icon = style.icon;
          const clickable =
            (c.sort_key === 5 && layers.length > 0) || (c.sort_key === 4 && drift.length > 0);
          return (
            <button
              key={c.sort_key}
              onClick={() => { if (c.sort_key === 5) setTab('layers'); else if (c.sort_key === 4) setTab('balances'); }}
              className={`text-left rounded-xl border p-4 transition ${style.border} ${clickable ? 'hover:shadow-sm cursor-pointer' : 'cursor-default'}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Icon className={`w-4 h-4 shrink-0 ${c.status === 'ok' ? 'text-emerald-600' : c.status === 'drift' ? 'text-red-600' : 'text-amber-600'}`} />
                  <span className="text-sm font-semibold truncate">{c.check_name}</span>
                </div>
                <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full shrink-0 ${style.badge}`}>
                  {c.status}
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-2 leading-relaxed">{c.details}</p>
            </button>
          );
        })}
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2 border-b border-border pb-3 flex-wrap">
        {([
          ['layers', 'Negative Layers', Layers, layers.length],
          ['balances', 'Balance Cache', ShieldCheck, drift.length],
          ['history', 'History', HistoryIcon, history.length],
        ] as [Tab, string, typeof Layers, number][]).map(([key, label, Icon, count]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border transition ${
              tab === key
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-white text-foreground hover:bg-muted border-border'
            }`}
          >
            <Icon className="w-4 h-4" />
            {label}
            <span className={`text-xs px-1.5 py-0.5 rounded ${tab === key ? 'bg-white/20' : 'bg-muted'}`}>{count}</span>
          </button>
        ))}
      </div>

      {/* ----------------------------------------------------------------- */}
      {/* Tab: Negative Layers                                              */}
      {/* ----------------------------------------------------------------- */}
      {tab === 'layers' && (
        <div className="space-y-3">
          {/* Plain-language legend so a new person understands the page without training */}
          <div className="rounded-xl border border-border bg-muted/30 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Info className="w-4 h-4 text-blue-600 shrink-0" />
              What is an IOU layer?
            </div>
            <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed">
              When a sale or stock reduction asks for more units than the FIFO batch ledger holds, the
              missing units are recorded as a <b>negative layer — an &ldquo;IOU&rdquo;</b> (&ldquo;I owe you&rdquo;): a marker
              that the ledger owes stock it never received. The books stay balanced, but the product&rsquo;s
              net stock reads lower than the shelf may actually hold. Each layer below is therefore a
              decision: <b>purge it once a physical count confirms the stock is really there, or keep it
              if the goods truly left.</b>
            </p>
            <div className="flex flex-wrap gap-x-5 gap-y-1.5 mt-2.5">
              {Object.entries(KIND_META).map(([, m]) => (
                <span key={m.label} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap ${m.className}`}>
                    {m.label}
                  </span>
                  {m.desc}
                </span>
              ))}
            </div>
          </div>

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={kindFilter}
              onChange={e => setKindFilter(e.target.value)}
              className="border border-border rounded-lg px-2.5 py-1.5 text-sm bg-white"
            >
              <option value="all">All kinds</option>
              {Object.entries(KIND_META).map(([k, m]) => (
                <option key={k} value={k}>{m.label}</option>
              ))}
            </select>
            <select
              value={warehouseFilter}
              onChange={e => setWarehouseFilter(e.target.value)}
              className="border border-border rounded-lg px-2.5 py-1.5 text-sm bg-white"
            >
              <option value="all">All warehouses</option>
              {warehouses.map(w => <option key={w} value={w}>{w}</option>)}
            </select>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search product, SKU or batch…"
              className="border border-border rounded-lg px-3 py-1.5 text-sm bg-white w-64"
            />
            <span className="text-sm text-muted-foreground ml-auto">
              {filteredLayers.length} layer{filteredLayers.length === 1 ? '' : 's'} · drag{' '}
              <span className="font-semibold text-red-600">{formatCurrency(totalDrag)}</span>
            </span>
          </div>

          {/* Selection bar */}
          {selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-2.5">
              <span className="text-sm text-blue-900">
                <b>{selected.size}</b> selected · <b>{formatCurrency(selectedValue)}</b> of negative value
              </span>
              <div className="ml-auto flex items-center gap-2">
                <button onClick={selectAllFiltered} className="text-sm text-blue-700 hover:underline">
                  Select all filtered
                </button>
                <button onClick={() => setSelected(new Set())} className="text-sm text-blue-700 hover:underline">
                  Clear
                </button>
                <button
                  onClick={() => setShowPurge(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold bg-red-600 hover:bg-red-700 text-white rounded-lg transition"
                >
                  <Trash2 className="w-4 h-4" />
                  Purge Selected
                </button>
              </div>
            </div>
          )}

          {/* Table */}
          <div className="rounded-xl border border-border bg-white overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr className="text-left text-xs uppercase tracking-wide">
                  <th className="px-3 py-2.5 w-8">
                    <input
                      type="checkbox"
                      checked={filteredLayers.length > 0 && filteredLayers.every(l => selected.has(l.layer_id))}
                      onChange={e => e.target.checked ? selectAllFiltered() : setSelected(new Set())}
                    />
                  </th>
                  <th className="px-3 py-2.5">Product</th>
                  <th className="px-3 py-2.5">Warehouse</th>
                  <th className="px-3 py-2.5">Kind</th>
                  <th className="px-3 py-2.5 hidden lg:table-cell">Batch</th>
                  <th className="px-3 py-2.5 text-right">Qty</th>
                  <th className="px-3 py-2.5 text-right hidden md:table-cell">Unit Cost</th>
                  <th className="px-3 py-2.5 text-right">Value</th>
                  <th className="px-3 py-2.5 text-right hidden xl:table-cell">Pair Positive</th>
                  <th className="px-3 py-2.5 text-right hidden xl:table-cell">Net / Counter</th>
                  <th className="px-3 py-2.5 hidden xl:table-cell">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredLayers.map(l => {
                  const meta = KIND_META[l.kind] || KIND_META.OTHER;
                  return (
                    <tr key={l.layer_id} className={selected.has(l.layer_id) ? 'bg-blue-50/50' : 'hover:bg-muted/30'}>
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={selected.has(l.layer_id)}
                          onChange={() => toggleSelected(l.layer_id)}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-medium">{l.product_name}</div>
                        <div className="text-[11px] text-muted-foreground">{l.product_sku || '—'}</div>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">{l.warehouse || '—'}</td>
                      <td className="px-3 py-2">
                        <span
                          title={meta.desc}
                          className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap ${meta.className}`}
                        >
                          {meta.label}
                        </span>
                      </td>
                      <td className="px-3 py-2 hidden lg:table-cell">
                        <span className="font-mono text-[11px] text-muted-foreground" title={l.batch_number || '(no batch number)'}>
                          {(l.batch_number || '(unnamed)').length > 22 ? (l.batch_number || '(unnamed)').slice(0, 21) + '…' : (l.batch_number || '(unnamed)')}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-red-600">
                        {Number(l.quantity_remaining).toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-right font-mono hidden md:table-cell">
                        {formatCurrency(l.unit_cost)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono font-semibold text-red-600">
                        {formatCurrency(l.value)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono hidden xl:table-cell" title="Positive stock at this product + warehouse (qty · value)">
                        {Number(l.pair_positive_qty).toLocaleString()} · {formatCurrency(l.pair_positive_value)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono hidden xl:table-cell" title="Net ledger qty / availability counter for the pair">
                        {Number(l.pair_net_qty).toLocaleString()} / {Number(l.counter_qty).toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground hidden xl:table-cell whitespace-nowrap">
                        {new Date(l.created_at).toLocaleDateString()}
                      </td>
                    </tr>
                  );
                })}
                {filteredLayers.length === 0 && (
                  <tr>
                    <td colSpan={11} className="px-3 py-10 text-center text-muted-foreground">
                      No negative layers match the filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-muted-foreground leading-relaxed">
            Print the count sheet and compare each product&rsquo;s <i>System Net</i> with the shelf:
            where the shelf holds <b>more</b> than System Net, the IOU is a data artifact — safe to
            purge. Where it matches (or is lower), the goods really left — keep the layer.
            {negCheck ? ` (Currently ${negCheck.drift} layer(s).)` : ''}
          </p>
        </div>
      )}

      {/* ----------------------------------------------------------------- */}
      {/* Tab: Balance Cache                                                */}
      {/* ----------------------------------------------------------------- */}
      {tab === 'balances' && (
        <div className="space-y-3">
          {drift.length === 0 ? (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-6 text-center">
              <CheckCircle2 className="w-8 h-8 text-emerald-600 mx-auto mb-2" />
              <p className="font-semibold text-emerald-800">All account balances match their journal lines.</p>
              <p className="text-sm text-muted-foreground mt-1">
                The cached <code className="text-xs">accounts.balance</code> column agrees with the journal for every account.
                If a flow ever drifts it again (it will show on the overview above), come back here and repair.
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">
                  {drift.length} account{drift.length === 1 ? '' : 's'} where the cached balance disagrees with the
                  journal lines. The journal itself is unaffected — this repairs the cache only.
                </p>
                <button
                  onClick={() => setRepairOpen(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition shrink-0"
                >
                  <ShieldCheck className="w-4 h-4" />
                  Repair Balances
                </button>
              </div>
              <div className="rounded-xl border border-border bg-white overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-muted-foreground">
                    <tr className="text-left text-xs uppercase tracking-wide">
                      <th className="px-3 py-2.5">Code</th>
                      <th className="px-3 py-2.5">Account</th>
                      <th className="px-3 py-2.5">Type</th>
                      <th className="px-3 py-2.5 text-right">Cached Balance</th>
                      <th className="px-3 py-2.5 text-right">From Journal Lines</th>
                      <th className="px-3 py-2.5 text-right">Gap</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {drift.map(a => (
                      <tr key={a.account_id} className="hover:bg-muted/30">
                        <td className="px-3 py-2 font-mono">{a.code}</td>
                        <td className="px-3 py-2">{a.name}</td>
                        <td className="px-3 py-2 capitalize text-muted-foreground">{a.account_type}</td>
                        <td className="px-3 py-2 text-right font-mono">{formatCurrency(a.cached_balance)}</td>
                        <td className="px-3 py-2 text-right font-mono">{formatCurrency(a.lines_balance)}</td>
                        <td className="px-3 py-2 text-right font-mono font-semibold text-red-600">
                          {a.gap >= 0 ? '+' : ''}{formatCurrency(a.gap)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* ----------------------------------------------------------------- */}
      {/* Tab: History                                                      */}
      {/* ----------------------------------------------------------------- */}
      {tab === 'history' && (
        <div className="rounded-xl border border-border bg-white overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr className="text-left text-xs uppercase tracking-wide">
                <th className="px-3 py-2.5">Checked At</th>
                <th className="px-3 py-2.5">Overall</th>
                <th className="px-3 py-2.5">Checks</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {history.map(h => (
                <tr key={h.id} className="hover:bg-muted/30">
                  <td className="px-3 py-2 whitespace-nowrap">
                    {new Date(h.checked_at).toLocaleString()}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded-full ${
                      h.all_ok ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                      {h.all_ok ? 'All OK' : 'Drift'}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1.5">
                      {logChecks(h)
                        .slice()
                        .sort((a, b) => a.sort_key - b.sort_key)
                        .map(c => (
                          <span
                            key={c.sort_key}
                            title={`${c.check_name}: ${c.details}`}
                            className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded ${
                              c.status === 'ok' ? 'bg-emerald-50 text-emerald-700'
                                : c.status === 'drift' ? 'bg-red-50 text-red-700'
                                : 'bg-amber-50 text-amber-700'}`}
                          >
                            <span className={`w-1.5 h-1.5 rounded-full ${
                              c.status === 'ok' ? 'bg-emerald-500'
                                : c.status === 'drift' ? 'bg-red-500' : 'bg-amber-500'}`} />
                            {c.check_name}
                          </span>
                        ))}
                    </div>
                  </td>
                </tr>
              ))}
              {history.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-3 py-10 text-center text-muted-foreground">
                    No snapshots yet (nightly at 02:05).
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ----------------------------------------------------------------- */}
      {/* Purge confirm modal                                               */}
      {/* ----------------------------------------------------------------- */}
      {showPurge && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[120] p-4">
          <div className="bg-white rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-white z-10">
              <h2 className="text-base font-bold">
                Purge {selected.size} negative layer{selected.size === 1 ? '' : 's'}
              </h2>
              <button onClick={() => setShowPurge(false)} className="text-muted-foreground hover:text-foreground text-xl leading-none">×</button>
            </div>
            <div className="p-6 space-y-4">
              <div className="rounded-lg bg-muted/40 p-3 space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Layers selected</span>
                  <span className="font-semibold">{selectedLayers.length}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Distinct products</span>
                  <span className="font-semibold">
                    {new Set(selectedLayers.map(l => `${l.product_id}|${l.warehouse}`)).size}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Negative value</span>
                  <span className="font-semibold text-red-600">{formatCurrency(selectedValue)}</span>
                </div>
              </div>

              <div>
                <p className="text-sm font-medium mb-2">What will be recorded</p>
                <div className="rounded-lg border border-border overflow-hidden text-sm">
                  <table className="w-full">
                    <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 text-left">Account</th>
                        <th className="px-3 py-2 text-right">Debit</th>
                        <th className="px-3 py-2 text-right">Credit</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      <tr>
                        <td className="px-3 py-2">1200 · Inventory Asset</td>
                        <td className="px-3 py-2 text-right font-mono">{formatCurrency(selectedValue)}</td>
                        <td className="px-3 py-2 text-right font-mono">—</td>
                      </tr>
                      <tr>
                        <td className="px-3 py-2">3900 · Opening Balance Equity</td>
                        <td className="px-3 py-2 text-right font-mono">—</td>
                        <td className="px-3 py-2 text-right font-mono">{formatCurrency(selectedValue)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900 leading-relaxed">
                The selected layers are <b>permanently zeroed</b> and inventory value rises by{' '}
                <b>{formatCurrency(selectedValue)}</b>; availability for these products rises with it.
                Do this <b>only after a physical count confirms the stock is actually on the shelf</b> (print the
                count sheet first). If the goods really left, cancel and keep the layers — they are honest records.
                Everything is audit-logged with your reason.
              </div>

              <div>
                <label className="block text-sm font-medium mb-1.5">
                  Reason (required, written to the audit log)
                </label>
                <textarea
                  value={purgeReason}
                  onChange={e => setPurgeReason(e.target.value)}
                  rows={3}
                  placeholder="e.g. Physical count 2026-09-03 confirmed stock on shelf for these products"
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500/20"
                />
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <button
                  onClick={() => setShowPurge(false)}
                  className="px-4 py-2 text-sm border border-border rounded-lg hover:bg-muted transition"
                >
                  Cancel
                </button>
                <button
                  onClick={runPurge}
                  disabled={!purgeReason.trim() || purging}
                  className="px-4 py-2 text-sm font-semibold bg-red-600 hover:bg-red-700 text-white rounded-lg transition disabled:opacity-50"
                >
                  {purging ? 'Purging…' : `Purge ${selected.size} layer${selected.size === 1 ? '' : 's'}`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ----------------------------------------------------------------- */}
      {/* Balance repair confirm modal                                      */}
      {/* ----------------------------------------------------------------- */}
      {repairOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[120] p-4">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl">
            <div className="p-6 space-y-4">
              <h2 className="text-base font-bold">Repair account balance cache</h2>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Recompute every account&rsquo;s cached balance from its journal lines? The journal entries themselves
                are not touched — only the <code className="text-xs">accounts.balance</code> cache is rewritten to
                match them. {drift.length} account{drift.length === 1 ? '' : 's'} currently drift. Audit-logged.
              </p>
              <div className="flex justify-end gap-2">
                <button onClick={() => setRepairOpen(false)} className="px-4 py-2 text-sm border border-border rounded-lg hover:bg-muted transition">
                  Cancel
                </button>
                <button
                  onClick={runRepair}
                  disabled={repairing}
                  className="px-4 py-2 text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition disabled:opacity-50"
                >
                  {repairing ? 'Repairing…' : 'Repair'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ----------------------------------------------------------------- */}
      {/* Off-screen printable count sheet                                  */}
      {/* ----------------------------------------------------------------- */}
      <div className="absolute -left-[9999px] top-0" aria-hidden="true">
        <div ref={sheetRef} className="bg-white p-6 text-black" style={{ width: '760px' }}>
          <div className="flex items-baseline justify-between border-b-2 border-black pb-2 mb-3">
            <h1 className="text-lg font-bold">Physical Count Sheet — Negative-Layer Products</h1>
            <span className="text-xs">{new Date().toLocaleString()}</span>
          </div>
          <p className="text-xs mb-3 leading-relaxed">
            These products carry negative FIFO layers (IOUs). Count the shelf and write the counted quantity.
            <b> If the shelf holds MORE than the System Net, the IOU is a data artifact — purge that layer from
            Inventory Audit.</b> If the shelf matches (or is lower), the goods really left — keep the layer.
          </p>
          <table className="w-full border-collapse text-xs" style={{ tableLayout: 'fixed' }}>
            <thead>
              <tr>
                {['#', 'Product', 'SKU', 'Warehouse', 'System Net', 'IOU Drag', 'Counted', 'Difference'].map(h => (
                  <th key={h} className="border border-black px-1.5 py-1.5 text-left bg-gray-100">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sheetPairs.map((p, i) => (
                <tr key={`${p.warehouse}|${p.sku}|${p.name}|${i}`}>
                  <td className="border border-black px-1.5 py-2 text-center">{i + 1}</td>
                  <td className="border border-black px-1.5 py-2">{p.name}</td>
                  <td className="border border-black px-1.5 py-2">{p.sku || '—'}</td>
                  <td className="border border-black px-1.5 py-2">{p.warehouse}</td>
                  <td className="border border-black px-1.5 py-2 text-right font-mono">{p.net.toLocaleString()}</td>
                  <td className="border border-black px-1.5 py-2 text-right font-mono">−{p.drag.toLocaleString()}</td>
                  <td className="border border-black px-1.5 py-2" style={{ height: '24px' }}>&nbsp;</td>
                  <td className="border border-black px-1.5 py-2">&nbsp;</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[10px] mt-2 text-gray-600">
            System Net = positive FIFO layers − negative layers at that warehouse (what the ledger believes is on the
            shelf). IOU Drag = units the negative layers subtract. Generated by Inventory Audit · {filteredLayers.length} layer(s) shown.
          </p>
        </div>
      </div>
    </div>
  );
}
