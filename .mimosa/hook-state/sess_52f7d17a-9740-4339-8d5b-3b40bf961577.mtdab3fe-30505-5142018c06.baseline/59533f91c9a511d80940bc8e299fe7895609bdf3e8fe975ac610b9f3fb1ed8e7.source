'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/format';
import { History, Download, Search, Calendar, User, FileText, ArrowRight, Filter } from 'lucide-react';

interface EditHistoryEntry {
  id: string;
  invoice_id: string;
  invoice_number: string;
  edited_by_name: string | null;
  edited_at: string;
  change_type: string;
  field_changed: string | null;
  reason: string | null;
  snapshot_before: Record<string, unknown> | null;
  snapshot_after: Record<string, unknown> | null;
}

export default function EditHistoryReportPage() {
  const [history, setHistory] = useState<EditHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [changeTypeFilter, setChangeTypeFilter] = useState('all');
  const [editorFilter, setEditorFilter] = useState('all');
  const [editors, setEditors] = useState<string[]>([]);

  useEffect(() => { loadHistory(); }, []);

  async function loadHistory() {
    setLoading(true);
    let query = supabase
      .from('invoice_edit_history')
      .select('*')
      .order('edited_at', { ascending: false });

    if (dateFrom) query = query.gte('edited_at', dateFrom);
    if (dateTo) query = query.lte('edited_at', dateTo + 'T23:59:59');

    const { data, error } = await query.limit(500);
    if (error) {
      console.error('Error loading edit history:', error);
      setHistory([]);
    } else {
      setHistory((data || []) as EditHistoryEntry[]);
      const uniqueEditors = [...new Set((data || []).map((e: any) => e.edited_by_name).filter(Boolean))] as string[];
      setEditors(uniqueEditors);
    }
    setLoading(false);
  }

  function applyFilters() {
    loadHistory();
  }

  function exportCSV() {
    const headers = ['Invoice Number', 'Edited At', 'Editor', 'Change Type', 'Field Changed', 'Reason', 'Old Value', 'New Value'];
    const rows = filteredHistory.map(e => [
      e.invoice_number,
      new Date(e.edited_at).toLocaleString(),
      e.edited_by_name || '—',
      e.change_type,
      e.field_changed || '—',
      e.reason || '—',
      e.snapshot_before ? JSON.stringify(e.snapshot_before).slice(0, 200) : '—',
      e.snapshot_after ? JSON.stringify(e.snapshot_after).slice(0, 200) : '—',
    ]);
    const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `invoice-edit-history-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const filteredHistory = history.filter(e => {
    if (searchTerm && !e.invoice_number.toLowerCase().includes(searchTerm.toLowerCase())) return false;
    if (changeTypeFilter !== 'all' && !e.change_type.includes(changeTypeFilter)) return false;
    if (editorFilter !== 'all' && e.edited_by_name !== editorFilter) return false;
    return true;
  });

  function formatValue(val: unknown): string {
    if (val === null || val === undefined) return '—';
    if (typeof val === 'number') return formatCurrency(val);
    if (typeof val === 'string') return val;
    return JSON.stringify(val).slice(0, 80);
  }

  function diffFields(before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined): { field: string; from: string; to: string }[] {
    if (!before || !after) return [];
    const changes: { field: string; from: string; to: string }[] = [];
    const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of allKeys) {
      if (key === 'items') continue;
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
        changes.push({ field: key, from: formatValue(before[key]), to: formatValue(after[key]) });
      }
    }
    return changes;
  }

  return (
    <div className="p-4 sm:p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold flex items-center gap-2">
            <History className="w-6 h-6 text-blue-600" />
            Invoice Edit History
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Track all modifications made to invoices — who changed what, when, and why</p>
        </div>
        <button onClick={exportCSV} disabled={filteredHistory.length === 0} className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-50">
          <Download className="w-4 h-4" />
          Export CSV
        </button>
      </div>

      {/* Filters */}
      <div className="bg-white border border-border rounded-xl p-4 space-y-4">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Filter className="w-4 h-4" />
          Filters
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div>
            <label className="block text-xs font-medium mb-1">From Date</label>
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">To Date</label>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Invoice #</label>
            <input type="text" value={searchTerm} onChange={e => setSearchTerm(e.target.value)} placeholder="Search..." className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Change Type</label>
            <select value={changeTypeFilter} onChange={e => setChangeTypeFilter(e.target.value)} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20">
              <option value="all">All Changes</option>
              <option value="header_edit">Header Edit</option>
              <option value="full_edit">Item Changes</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Editor</label>
            <select value={editorFilter} onChange={e => setEditorFilter(e.target.value)} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20">
              <option value="all">All Editors</option>
              {editors.map(e => <option key={e} value={e}>{e}</option>)}
            </select>
          </div>
        </div>
        <div className="flex justify-end">
          <button onClick={applyFilters} className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition">
            <Search className="w-4 h-4" />
            Apply Filters
          </button>
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-white border border-border rounded-xl p-4">
          <p className="text-xs text-muted-foreground">Total Edits</p>
          <p className="text-2xl font-bold text-blue-600">{filteredHistory.length}</p>
        </div>
        <div className="bg-white border border-border rounded-xl p-4">
          <p className="text-xs text-muted-foreground">Invoices Affected</p>
          <p className="text-2xl font-bold text-green-600">{new Set(filteredHistory.map(e => e.invoice_id)).size}</p>
        </div>
        <div className="bg-white border border-border rounded-xl p-4">
          <p className="text-xs text-muted-foreground">Header Edits</p>
          <p className="text-2xl font-bold text-amber-600">{filteredHistory.filter(e => e.change_type.includes('header_edit')).length}</p>
        </div>
        <div className="bg-white border border-border rounded-xl p-4">
          <p className="text-xs text-muted-foreground">Item Changes</p>
          <p className="text-2xl font-bold text-purple-600">{filteredHistory.filter(e => e.change_type.includes('full_edit')).length}</p>
        </div>
      </div>

      {/* History table */}
      <div className="bg-white border border-border rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-sm text-muted-foreground">Loading edit history...</div>
        ) : filteredHistory.length === 0 ? (
          <div className="p-12 text-center">
            <History className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">No edit history found for the selected filters</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted/40">
                <tr>
                  <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Edited At</th>
                  <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Invoice #</th>
                  <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Editor</th>
                  <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Change Type</th>
                  <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Reason</th>
                  <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Key Changes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredHistory.map(entry => {
                  const changes = diffFields(entry.snapshot_before || undefined, entry.snapshot_after || undefined);
                  return (
                    <tr key={entry.id} className="hover:bg-muted/20 transition">
                      <td className="px-4 py-3 text-sm whitespace-nowrap">
                        <div className="flex items-center gap-1 text-muted-foreground">
                          <Calendar className="w-3 h-3" />
                          {new Date(entry.edited_at).toLocaleDateString()}
                        </div>
                        <div className="text-xs text-muted-foreground ml-4">{new Date(entry.edited_at).toLocaleTimeString()}</div>
                      </td>
                      <td className="px-4 py-3 text-sm font-semibold text-blue-600">{entry.invoice_number}</td>
                      <td className="px-4 py-3 text-sm">
                        <div className="flex items-center gap-1">
                          <User className="w-3 h-3 text-muted-foreground" />
                          {entry.edited_by_name || '—'}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm">
                        <div className="flex flex-wrap gap-1">
                          {entry.change_type.split(',').map((ct, i) => (
                            <span key={i} className={`px-2 py-0.5 rounded text-[10px] font-medium ${
                              ct.trim() === 'header_edit' ? 'bg-amber-100 text-amber-700' :
                              ct.trim() === 'full_edit' ? 'bg-purple-100 text-purple-700' :
                              'bg-blue-100 text-blue-700'
                            }`}>{ct.trim().replace(/_/g, ' ')}</span>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm max-w-xs">
                        {entry.reason ? (
                          <div className="flex items-start gap-1 text-xs text-amber-700">
                            <FileText className="w-3 h-3 shrink-0 mt-0.5" />
                            <span className="line-clamp-2">{entry.reason}</span>
                          </div>
                        ) : <span className="text-muted-foreground text-xs">—</span>}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {changes.length > 0 ? (
                          <div className="space-y-0.5">
                            {changes.slice(0, 3).map((c, i) => (
                              <div key={i} className="flex items-center gap-1.5 text-xs">
                                <span className="text-muted-foreground font-medium">{c.field}:</span>
                                <span className="text-red-500 line-through">{c.from}</span>
                                <ArrowRight className="w-3 h-3 text-muted-foreground" />
                                <span className="text-green-600 font-medium">{c.to}</span>
                              </div>
                            ))}
                            {changes.length > 3 && <span className="text-xs text-blue-600">+{changes.length - 3} more</span>}
                          </div>
                        ) : <span className="text-muted-foreground text-xs">Item-level changes</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
