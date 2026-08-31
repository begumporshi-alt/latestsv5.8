'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Download, FileText,
  Loader2, RefreshCw, Search, Trash2, X, XCircle,
} from 'lucide-react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend, BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/format';
import Pagination from '@/components/ui/AppPagination';

interface COGSJournalEntry {
  id: string;
  entry_number: string;
  entry_date: string;
  description: string;
  total_debit: number;
  is_per_item: boolean;
  diff_from_expected: number;
}

interface FIFOConsumption {
  consumption_id: string;
  invoice_item_id: string;
  batch_id: string;
  batch_number: string;
  product_name: string;
  sku: string;
  batch_seq: number;
  consume_qty: number;
  cost_per_unit: number;
  total_cost: number;
  item_qty: number;
  item_cost_price: number;
}

interface ItemFIFOTotal {
  invoice_item_id: string;
  product_name: string;
  sku: string;
  item_qty: number;
  item_cost_price: number;
  fifo_total: number;
  batch_count: number;
  fifo_vs_cost: string;
}

interface AuditRow {
  invoice_id: string;
  invoice_number: string;
  invoice_date: string;
  invoice_status: string;
  invoice_total: number;
  customer_name: string;
  warehouse_name: string;
  item_count: number;
  expected_cogs_a: number;
  expected_cogs_b: number;
  journal_cogs_c: number;
  journal_je_count: number;
  fifo_cogs_d: number;
  cogs_journal_entries: COGSJournalEntry[];
  keeper_je_id: string;
  keeper_je_total: number;
  keeper_je_diff: number;
  all_je_diff: number;
  issue_type: string;
  fix_action: string;
  balance_impact: number;
  audit_status: string;
  has_per_item_je: boolean;
  has_lump_je: boolean;
  per_item_je_ids: string[];
  lump_je_ids: string[];
  fifo_consumptions: FIFOConsumption[];
  item_fifo_totals: ItemFIFOTotal[];
  root_cause: string;
}

type Filter = 'all' | 'duplicate' | 'mismatch' | 'missing' | 'consistent';

const STATUS_COLORS: Record<string, string> = {
  CONSISTENT: '#10b981',
  DUPLICATE_COGS: '#ef4444',
  MISMATCH: '#f59e0b',
  MISSING: '#a855f7',
};

const STATUS_LABELS: Record<string, string> = {
  CONSISTENT: 'Consistent',
  DUPLICATE_COGS: 'Duplicate COGS',
  MISMATCH: 'Mismatch',
  MISSING: 'Missing',
};

const FIX_COLORS: Record<string, string> = {
  NONE: '#10b981',
  DELETE_DUPLICATES: '#ef4444',
  REVIEW_MANUALLY: '#f59e0b',
  CREATE_JE: '#a855f7',
};

export default function COGSAuditPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('duplicate');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [fixing, setFixing] = useState(false);
  const [fixProgress, setFixProgress] = useState({ done: 0, total: 0, succeeded: 0, failed: 0 });
  const [fixLog, setFixLog] = useState<string[]>([]);
  const [bulkReason, setBulkReason] = useState('');
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [showReasonModal, setShowReasonModal] = useState<{ invoiceId: string; jeId: string } | null>(null);
  const [singleReason, setSingleReason] = useState('');
  const cancelRef = useRef(false);

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);
    try {
      const { data, error } = await supabase.rpc('get_cogs_audit');
      if (error) throw error;
      setRows((data as AuditRow[]) || []);
    } catch (e: any) {
      console.error('Failed to load COGS audit:', e);
      alert('Failed to load COGS audit: ' + e.message);
    } finally {
      setLoading(false);
    }
  }

  // ── Stats ─────────────────────────────────────────────
  const stats = useMemo(() => {
    const total = rows.length;
    const duplicates = rows.filter(r => r.audit_status === 'DUPLICATE_COGS');
    const mismatches = rows.filter(r => r.audit_status === 'MISMATCH');
    const missing = rows.filter(r => r.audit_status === 'MISSING');
    const consistent = rows.filter(r => r.audit_status === 'CONSISTENT');
    const totalOverstatement = duplicates.reduce((s, r) => s + r.balance_impact, 0);
    const doubleTriggerCount = rows.filter(r => r.root_cause === 'DOUBLE_TRIGGER').length;
    const autoFixableCount = duplicates.length;
    return {
      total, duplicates: duplicates.length, mismatches: mismatches.length,
      missing: missing.length, consistent: consistent.length,
      totalOverstatement, doubleTriggerCount, autoFixableCount,
      duplicateInvoiceIds: new Set(duplicates.map(d => d.invoice_id)),
    };
  }, [rows]);

  // ── Filtered rows ─────────────────────────────────────
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter(r => {
      if (filter === 'duplicate' && r.audit_status !== 'DUPLICATE_COGS') return false;
      if (filter === 'mismatch' && r.audit_status !== 'MISMATCH') return false;
      if (filter === 'missing' && r.audit_status !== 'MISSING') return false;
      if (filter === 'consistent' && r.audit_status !== 'CONSISTENT') return false;
      if (!term) return true;
      return (
        r.invoice_number.toLowerCase().includes(term) ||
        (r.customer_name || '').toLowerCase().includes(term) ||
        (r.warehouse_name || '').toLowerCase().includes(term) ||
        (r.root_cause || '').toLowerCase().includes(term)
      );
    });
  }, [rows, filter, search]);

  const paginated = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }, [filtered, page, pageSize]);

  // ── Selection helpers ─────────────────────────────────
  function toggleSelected(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function selectAllPage() {
    setSelected(prev => {
      const next = new Set(prev);
      paginated.forEach(r => next.add(r.invoice_id));
      return next;
    });
  }
  function deselectAll() { setSelected(new Set()); }
  function selectAllFiltered() {
    const ids = filtered.filter(r => r.audit_status === 'DUPLICATE_COGS').map(r => r.invoice_id);
    setSelected(new Set(ids));
  }

  // ── Single JE delete ─────────────────────────────────
  async function deleteSingleJE(jeId: string, invoiceId: string) {
    if (!singleReason.trim()) { alert('Reason is required'); return; }
    setFixing(true);
    try {
      const { data, error } = await supabase.rpc('delete_duplicate_cogs_je', {
        p_je_id: jeId,
        p_reason: singleReason,
        p_username: 'admin',
      });
      if (error) throw error;
      const result = data as { success: boolean; error?: string };
      if (!result.success) { alert('Delete failed: ' + result.error); return; }
      setShowReasonModal(null);
      setSingleReason('');
      await loadData();
    } catch (e: any) {
      alert('Delete failed: ' + e.message);
    } finally {
      setFixing(false);
    }
  }

  // ── Bulk fix with progress + cancel ───────────────────
  async function runBulkFix() {
    if (!bulkReason.trim()) { alert('Reason is required'); return; }
    if (selected.size === 0) { alert('No invoices selected'); return; }

    setFixing(true);
    cancelRef.current = false;
    setShowBulkModal(false);

    // Build the list of (je_id, reason) pairs from selected invoices
    const targets: { jeId: string; invoiceId: string }[] = [];
    for (const invoiceId of selected) {
      const row = rows.find(r => r.invoice_id === invoiceId);
      if (!row) continue;
      // For each non-keeper JE, add to delete list
      for (const je of row.cogs_journal_entries) {
        if (je.id !== row.keeper_je_id) targets.push({ jeId: je.id, invoiceId });
      }
    }

    setFixProgress({ done: 0, total: targets.length, succeeded: 0, failed: 0 });
    setFixLog([]);

    let succeeded = 0;
    let failed = 0;
    const errors: string[] = [];

    for (let i = 0; i < targets.length; i++) {
      if (cancelRef.current) {
        setFixLog(prev => [...prev, `⏹ Cancelled at ${i}/${targets.length}`]);
        break;
      }
      const { jeId } = targets[i];
      try {
        const { data, error } = await supabase.rpc('delete_duplicate_cogs_je', {
          p_je_id: jeId,
          p_reason: bulkReason,
          p_username: 'admin-bulk',
        });
        if (error) throw error;
        const result = data as { success: boolean; error?: string };
        if (result.success) succeeded++;
        else { failed++; errors.push(`${jeId.slice(0, 8)}: ${result.error}`); }
      } catch (e: any) {
        failed++;
        errors.push(`${jeId.slice(0, 8)}: ${e.message}`);
      }
      setFixProgress({ done: i + 1, total: targets.length, succeeded, failed });
    }

    setFixLog(prev => [...prev, `✅ ${succeeded} succeeded, ${failed} failed`]);
    if (errors.length > 0) {
      setFixLog(prev => [...prev, ...errors.slice(0, 10)]);
    }
    setSelected(new Set());
    await loadData();
    setFixing(false);
  }

  function cancelBulkFix() { cancelRef.current = true; }

  // ── Export CSV ───────────────────────────────────────
  function exportCSV() {
    const header = [
      'Invoice', 'Date', 'Status', 'Customer', 'Items',
      'Expected (A)', 'History (B)', 'Journal (C)', 'FIFO (D)',
      'JE Count', 'Keeper Total', 'Balance Impact', 'Issue Type', 'Fix Action', 'Root Cause',
    ];
    const lines = [header.join(',')];
    rows.forEach(r => {
      lines.push([
        r.invoice_number, r.invoice_date, r.audit_status,
        `"${r.customer_name || ''}"`, r.item_count,
        r.expected_cogs_a, r.expected_cogs_b, r.journal_cogs_c, r.fifo_cogs_d,
        r.journal_je_count, r.keeper_je_total, r.balance_impact,
        r.issue_type, r.fix_action, r.root_cause || '',
      ].join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `cogs-audit-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Chart data ───────────────────────────────────────
  const pieData = useMemo(() => [
    { name: 'Consistent', value: stats.consistent, color: STATUS_COLORS.CONSISTENT },
    { name: 'Duplicate COGS', value: stats.duplicates, color: STATUS_COLORS.DUPLICATE_COGS },
    { name: 'Mismatch', value: stats.mismatches, color: STATUS_COLORS.MISMATCH },
    { name: 'Missing', value: stats.missing, color: STATUS_COLORS.MISSING },
  ], [stats]);

  const rootCauseData = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach(r => {
      const k = r.root_cause || 'NONE';
      m.set(k, (m.get(k) || 0) + 1);
    });
    return Array.from(m.entries()).map(([name, value]) => ({ name, value }));
  }, [rows]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      {/* ── Header ─────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">COGS Audit</h1>
          <p className="text-sm text-gray-500 mt-1">
            Compare sales, items, history, journal, and FIFO COGS for every invoice. Detect and fix duplicates.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadData}
            className="flex items-center gap-2 px-3 py-2 text-sm border rounded hover:bg-gray-50"
          >
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
          <button
            onClick={exportCSV}
            className="flex items-center gap-2 px-3 py-2 text-sm border rounded hover:bg-gray-50"
          >
            <Download className="h-4 w-4" /> Export CSV
          </button>
        </div>
      </div>

      {/* ── Stats cards ────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
        <StatCard label="Total Invoices" value={stats.total} color="#6b7280" />
        <StatCard label="Consistent" value={stats.consistent} color={STATUS_COLORS.CONSISTENT} />
        <StatCard label="Duplicate COGS" value={stats.duplicates} color={STATUS_COLORS.DUPLICATE_COGS} />
        <StatCard label="Mismatch" value={stats.mismatches} color={STATUS_COLORS.MISMATCH} />
        <StatCard label="Missing" value={stats.missing} color={STATUS_COLORS.MISSING} />
        <StatCard
          label="Total Overstatement"
          value={formatCurrency(stats.totalOverstatement)}
          color="#ef4444"
        />
      </div>

      {/* ── Double trigger alert ───────────────────────── */}
      {stats.doubleTriggerCount > 0 && (
        <div className="bg-red-50 border border-red-200 rounded p-4 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-red-600 mt-0.5" />
          <div className="flex-1">
            <h3 className="font-semibold text-red-900">Double COGS Trigger Detected</h3>
            <p className="text-sm text-red-700 mt-1">
              {stats.doubleTriggerCount} invoices have BOTH lump-style and per-item COGS journal entries,
              causing an average double-count of COGS. The duplicate trigger should be dropped from
              <code className="bg-red-100 px-1 rounded">invoice_items</code> to prevent recurrence.
            </p>
            <p className="text-xs text-red-600 mt-2">
              Affected invoices are flagged with <code className="bg-red-100 px-1 rounded">root_cause = DOUBLE_TRIGGER</code>.
              Use the bulk-fix button below to remove the per-item JEs (keepers are auto-detected).
            </p>
          </div>
        </div>
      )}

      {/* ── Charts ─────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white border rounded p-4">
          <h3 className="text-sm font-semibold mb-2">Audit Status Distribution</h3>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70} label={(e) => e.value}>
                {pieData.map((entry, i) => (
                  <Cell key={i} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="bg-white border rounded p-4">
          <h3 className="text-sm font-semibold mb-2">Root Cause Breakdown</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={rootCauseData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} angle={-20} textAnchor="end" height={50} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip />
              <Bar dataKey="value" fill="#3b82f6" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── Filters ────────────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          {(['all', 'duplicate', 'mismatch', 'missing', 'consistent'] as Filter[]).map(f => (
            <button
              key={f}
              onClick={() => { setFilter(f); setPage(1); }}
              className={`px-3 py-1.5 text-sm rounded border ${
                filter === f ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 hover:bg-gray-50'
              }`}
            >
              {f === 'all' ? 'All' : STATUS_LABELS[f.toUpperCase()] || f}
              {f === 'all' && ` (${stats.total})`}
              {f === 'duplicate' && ` (${stats.duplicates})`}
              {f === 'mismatch' && ` (${stats.mismatches})`}
              {f === 'missing' && ` (${stats.missing})`}
              {f === 'consistent' && ` (${stats.consistent})`}
            </button>
          ))}
        </div>
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search invoice, customer, root cause..."
            className="w-full pl-9 pr-3 py-2 text-sm border rounded"
          />
        </div>
      </div>

      {/* ── Bulk action bar ────────────────────────────── */}
      {selected.size > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded p-3 flex items-center gap-3">
          <span className="text-sm font-medium text-blue-900">
            {selected.size} invoice{selected.size > 1 ? 's' : ''} selected
          </span>
          <button
            onClick={() => setShowBulkModal(true)}
            disabled={fixing}
            className="ml-auto flex items-center gap-2 px-3 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" />
            Bulk fix: delete duplicate JEs
          </button>
          <button
            onClick={deselectAll}
            className="flex items-center gap-1 px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded"
          >
            <X className="h-4 w-4" /> Clear
          </button>
          <button
            onClick={selectAllFiltered}
            className="flex items-center gap-1 px-2 py-1.5 text-sm text-blue-700 hover:bg-blue-100 rounded"
          >
            Select all {filter !== 'duplicate' ? 'duplicates' : 'filtered'}
          </button>
        </div>
      )}

      {filter === 'duplicate' && selected.size === 0 && stats.autoFixableCount > 0 && (
        <div className="text-right">
          <button
            onClick={selectAllFiltered}
            className="text-sm text-blue-600 hover:underline"
          >
            Select all {stats.autoFixableCount} duplicates
          </button>
        </div>
      )}

      {/* ── Progress bar (bulk fix running) ────────────── */}
      {fixing && fixProgress.total > 0 && (
        <div className="bg-white border-2 border-blue-300 rounded p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">
              Bulk fix: {fixProgress.done} / {fixProgress.total} journal entries processed
            </span>
            <button
              onClick={cancelBulkFix}
              className="text-sm text-red-600 hover:underline"
            >
              Cancel
            </button>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-3 overflow-hidden">
            <div
              className="h-3 bg-blue-600 transition-all"
              style={{ width: `${(fixProgress.done / fixProgress.total) * 100}%` }}
            />
          </div>
          <div className="flex items-center gap-4 text-xs text-gray-600">
            <span>✅ {fixProgress.succeeded} succeeded</span>
            <span>❌ {fixProgress.failed} failed</span>
            {fixLog.length > 0 && (
              <details className="ml-auto">
                <summary className="cursor-pointer">View log ({fixLog.length})</summary>
                <div className="mt-2 max-h-40 overflow-y-auto text-xs font-mono bg-gray-50 p-2 rounded">
                  {fixLog.map((l, i) => <div key={i}>{l}</div>)}
                </div>
              </details>
            )}
          </div>
        </div>
      )}

      {/* ── Audit table ────────────────────────────────── */}
      <div className="bg-white border rounded overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase text-gray-600">
            <tr>
              <th className="p-2 w-8">
                <input
                  type="checkbox"
                  checked={paginated.length > 0 && paginated.every(r => selected.has(r.invoice_id))}
                  onChange={(e) => e.target.checked ? selectAllPage() : deselectAll()}
                />
              </th>
              <th className="p-2 text-left">Invoice</th>
              <th className="p-2 text-left">Date</th>
              <th className="p-2 text-left">Customer</th>
              <th className="p-2 text-right">Items</th>
              <th className="p-2 text-right">Expected (A)</th>
              <th className="p-2 text-right">History (B)</th>
              <th className="p-2 text-right">Journal (C)</th>
              <th className="p-2 text-right">FIFO (D)</th>
              <th className="p-2 text-center">JEs</th>
              <th className="p-2 text-right">Overstated By</th>
              <th className="p-2 text-left">Status</th>
              <th className="p-2 text-left">Action</th>
              <th className="p-2 w-8"></th>
            </tr>
          </thead>
          <tbody>
            {paginated.length === 0 && (
              <tr>
                <td colSpan={14} className="p-8 text-center text-gray-500">
                  No invoices match the current filter.
                </td>
              </tr>
            )}
            {paginated.map(r => (
              <AuditTableRow
                key={r.invoice_id}
                row={r}
                selected={selected.has(r.invoice_id)}
                expanded={expanded.has(r.invoice_id)}
                onToggleSelect={() => toggleSelected(r.invoice_id)}
                onToggleExpand={() => {
                  setExpanded(prev => {
                    const next = new Set(prev);
                    if (next.has(r.invoice_id)) next.delete(r.invoice_id);
                    else next.add(r.invoice_id);
                    return next;
                  });
                }}
                onDeleteJE={(jeId) => setShowReasonModal({ invoiceId: r.invoice_id, jeId })}
              />
            ))}
          </tbody>
        </table>
      </div>

      <Pagination
        page={page}
        pageSize={pageSize}
        total={filtered.length}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />

      {/* ── Bulk fix modal ─────────────────────────────── */}
      {showBulkModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-lg space-y-4">
            <h2 className="text-lg font-bold">Bulk fix {selected.size} invoices</h2>
            <p className="text-sm text-gray-600">
              This will delete the duplicate COGS journal entries from the selected invoices,
              keeping only the auto-detected keeper JE. Total overstatement removed:
              <span className="font-semibold text-red-600 ml-1">
                {formatCurrency(
                  Array.from(selected).reduce((s, id) => {
                    const r = rows.find(x => x.invoice_id === id);
                    return s + (r?.balance_impact || 0);
                  }, 0)
                )}
              </span>
            </p>
            <div>
              <label className="text-sm font-medium">Reason (required, audit log)</label>
              <textarea
                value={bulkReason}
                onChange={e => setBulkReason(e.target.value)}
                placeholder="e.g. Removing duplicate COGS JEs from double-trigger bug. Keeper auto-detected by lowest diff to expected COGS."
                className="w-full mt-1 p-2 border rounded text-sm"
                rows={3}
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowBulkModal(false)}
                className="px-3 py-2 text-sm border rounded hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={runBulkFix}
                disabled={!bulkReason.trim() || fixing}
                className="px-3 py-2 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
              >
                {fixing ? 'Working...' : `Delete duplicates`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Single delete modal ────────────────────────── */}
      {showReasonModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-lg space-y-4">
            <h2 className="text-lg font-bold">Delete COGS journal entry</h2>
            <p className="text-sm text-gray-600">
              A safety check will run on the server: only COGS entries that are not reversals
              and not linked to payments will be deleted.
            </p>
            <div>
              <label className="text-sm font-medium">Reason (required, audit log)</label>
              <textarea
                value={singleReason}
                onChange={e => setSingleReason(e.target.value)}
                placeholder="e.g. Removing duplicate per-item COGS JE from double-trigger"
                className="w-full mt-1 p-2 border rounded text-sm"
                rows={3}
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setShowReasonModal(null); setSingleReason(''); }}
                className="px-3 py-2 text-sm border rounded hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => deleteSingleJE(showReasonModal.jeId, showReasonModal.invoiceId)}
                disabled={!singleReason.trim() || fixing}
                className="px-3 py-2 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
              >
                {fixing ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <div className="bg-white border rounded p-4">
      <div className="text-xs text-gray-500 uppercase">{label}</div>
      <div className="text-2xl font-bold mt-1" style={{ color }}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  );
}

function AuditTableRow({
  row, selected, expanded, onToggleSelect, onToggleExpand, onDeleteJE,
}: {
  row: AuditRow;
  selected: boolean;
  expanded: boolean;
  onToggleSelect: () => void;
  onToggleExpand: () => void;
  onDeleteJE: (jeId: string) => void;
}) {
  const statusColor = STATUS_COLORS[row.audit_status] || '#6b7280';
  const fixColor = FIX_COLORS[row.fix_action] || '#6b7280';
  const isIssue = row.audit_status !== 'CONSISTENT';

  return (
    <>
      <tr className={`border-t hover:bg-gray-50 ${selected ? 'bg-blue-50' : ''}`}>
        <td className="p-2">
          {isIssue && (
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggleSelect}
            />
          )}
        </td>
        <td className="p-2 font-mono text-xs">{row.invoice_number}</td>
        <td className="p-2 text-xs">{row.invoice_date}</td>
        <td className="p-2 text-xs">{row.customer_name || '—'}</td>
        <td className="p-2 text-right">{row.item_count}</td>
        <td className="p-2 text-right font-mono text-xs">{formatCurrency(row.expected_cogs_a)}</td>
        <td className="p-2 text-right font-mono text-xs">
          {row.expected_cogs_b > 0 ? formatCurrency(row.expected_cogs_b) : '—'}
        </td>
        <td className="p-2 text-right font-mono text-xs">
          {formatCurrency(row.journal_cogs_c)}
        </td>
        <td className="p-2 text-right font-mono text-xs">
          {row.fifo_cogs_d > 0 ? formatCurrency(row.fifo_cogs_d) : '—'}
        </td>
        <td className="p-2 text-center">
          <span className={`inline-block px-1.5 py-0.5 text-xs rounded ${
            row.journal_je_count > 1 ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-700'
          }`}>
            {row.journal_je_count}
          </span>
        </td>
        <td className="p-2 text-right font-mono text-xs">
          {row.balance_impact > 0 ? (
            <span className="text-red-600 font-semibold">+{formatCurrency(row.balance_impact)}</span>
          ) : '—'}
        </td>
        <td className="p-2">
          <span
            className="inline-block px-2 py-0.5 text-xs rounded text-white"
            style={{ backgroundColor: statusColor }}
          >
            {STATUS_LABELS[row.audit_status] || row.audit_status}
          </span>
        </td>
        <td className="p-2">
          <span
            className="inline-block px-2 py-0.5 text-xs rounded"
            style={{
              backgroundColor: `${fixColor}20`,
              color: fixColor,
              border: `1px solid ${fixColor}40`,
            }}
          >
            {row.fix_action}
          </span>
          {row.root_cause && (
            <div className="text-xs text-gray-500 mt-0.5">{row.root_cause}</div>
          )}
        </td>
        <td className="p-2">
          {isIssue && (
            <button
              onClick={onToggleExpand}
              className="text-gray-500 hover:text-gray-700"
              title="Show details"
            >
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
          )}
        </td>
      </tr>
      {expanded && isIssue && (
        <tr className="bg-gray-50">
          <td colSpan={14} className="p-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
              {/* COGS journal entries */}
              <div>
                <h4 className="font-semibold mb-2 text-sm">
                  COGS Journal Entries ({row.cogs_journal_entries.length})
                </h4>
                {row.cogs_journal_entries.length === 0 ? (
                  <p className="text-gray-500">No COGS entries found.</p>
                ) : (
                  <div className="space-y-1">
                    {row.cogs_journal_entries.map(je => {
                      const isKeeper = je.id === row.keeper_je_id;
                      return (
                        <div
                          key={je.id}
                          className={`p-2 rounded border ${
                            isKeeper ? 'border-green-300 bg-green-50' : 'border-red-200 bg-red-50'
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-mono text-xs text-gray-600">
                              {je.entry_number}
                            </span>
                            <span className="font-mono text-xs">
                              {formatCurrency(je.total_debit)}
                              {isKeeper ? (
                                <span className="ml-2 text-green-700">★ KEEPER</span>
                              ) : (
                                <span className="ml-2 text-red-700">
                                  Δ {formatCurrency(je.diff_from_expected)}
                                </span>
                              )}
                            </span>
                          </div>
                          <div className="text-xs text-gray-600 mt-1 truncate" title={je.description}>
                            {je.description}
                          </div>
                          <div className="text-xs text-gray-500 mt-0.5">
                            {je.entry_date} • {je.is_per_item ? 'per-item' : 'lump'}
                          </div>
                          {!isKeeper && (
                            <button
                              onClick={() => onDeleteJE(je.id)}
                              className="mt-1 text-xs text-red-600 hover:underline"
                            >
                              Delete this duplicate
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              {/* FIFO consumptions */}
              <div>
                <h4 className="font-semibold mb-2 text-sm">
                  FIFO Consumption ({row.fifo_consumptions.length} batch draws)
                </h4>
                {row.fifo_consumptions.length === 0 ? (
                  <p className="text-gray-500">No FIFO consumptions (pre-FIFO invoice or stock was 0).</p>
                ) : (
                  <div className="space-y-1 max-h-60 overflow-y-auto">
                    {row.item_fifo_totals.map((it, idx) => (
                      <div key={idx} className="p-2 bg-white border rounded">
                        <div className="flex items-center justify-between">
                          <span className="font-medium">{it.product_name}</span>
                          <span className="font-mono text-xs">
                            FIFO: {formatCurrency(it.fifo_total)} / Item: {formatCurrency(it.item_qty * it.item_cost_price)}
                          </span>
                        </div>
                        <div className="text-xs text-gray-500 mt-0.5">
                          {it.item_qty} × {formatCurrency(it.item_cost_price)} • {it.batch_count} batch{it.batch_count > 1 ? 'es' : ''} • {it.fifo_vs_cost}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
