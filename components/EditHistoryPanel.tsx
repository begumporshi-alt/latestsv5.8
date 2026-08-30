'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/format';
import {
  History, Clock, User, FileText, ArrowRight, BookOpen,
  Package, PackageMinus, PackagePlus, ArrowUpRight, ArrowDownLeft,
  Receipt, CreditCard, RefreshCw, TrendingDown, TrendingUp
} from 'lucide-react';

/* ── types ── */
interface EditHistoryPanelProps {
  invoiceId: string;
}

interface TimelineEvent {
  id: string;
  timestamp: string;
  sortKey: string;
  type: 'edit_history' | 'journal_entry' | 'stock_movement';
  /* edit_history */
  editEntry?: any;
  /* journal_entry */
  je?: any;
  jeLines?: any[];
  /* stock_movement */
  sm?: any;
}

/* ── main component ── */
export default function EditHistoryPanel({ invoiceId }: EditHistoryPanelProps) {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [accountMap, setAccountMap] = useState<Record<string, { name: string; code: string }>>({});

  useEffect(() => {
    loadTimeline();
  }, [invoiceId]);

  async function loadTimeline() {
    setLoading(true);

    // Fetch all data in parallel
    const [histRes, jeRes, smRes, acctsRes] = await Promise.all([
      supabase
        .from('invoice_edit_history')
        .select('*')
        .eq('invoice_id', invoiceId)
        .order('edited_at', { ascending: true }),
      supabase
        .from('journal_entries')
        .select('*, journal_lines!journal_lines_journal_entry_id_fkey(*)')
        .eq('reference_type', 'invoice')
        .eq('reference_id', invoiceId)
        .order('created_at', { ascending: true }),
      supabase
        .from('stock_movements')
        .select('*, products(name, sku)')
        .eq('reference_id', invoiceId)
        .order('created_at', { ascending: true }),
      supabase
        .from('accounts')
        .select('id, name, code'),
    ]);

    // Build account lookup
    const accts: Record<string, { name: string; code: string }> = {};
    for (const a of acctsRes.data || []) {
      accts[a.id] = { name: a.name, code: a.code };
    }
    setAccountMap(accts);

    // Merge into unified timeline
    const evts: TimelineEvent[] = [];

    for (const h of histRes.data || []) {
      evts.push({
        id: `hist-${h.id}`,
        timestamp: h.edited_at,
        sortKey: h.edited_at,
        type: 'edit_history',
        editEntry: h,
      });
    }

    for (const je of jeRes.data || []) {
      evts.push({
        id: `je-${je.id}`,
        timestamp: je.created_at,
        sortKey: je.entry_date + 'T' + je.created_at,
        type: 'journal_entry',
        je,
        jeLines: je.journal_lines || [],
      });
    }

    for (const sm of smRes.data || []) {
      evts.push({
        id: `sm-${sm.id}`,
        timestamp: sm.created_at,
        sortKey: sm.created_at,
        type: 'stock_movement',
        sm,
      });
    }

    // Sort chronologically (oldest first = top)
    evts.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

    setEvents(evts);
    setLoading(false);
  }

  if (loading) {
    return <div className="p-4 text-center text-sm text-muted-foreground">Loading timeline…</div>;
  }

  if (events.length === 0) {
    return (
      <div className="p-8 text-center">
        <History className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
        <p className="text-sm text-muted-foreground">No activity recorded for this invoice</p>
      </div>
    );
  }

  return (
    <div className="max-h-[500px] overflow-y-auto">
      <div className="relative">
        {/* Timeline vertical line */}
        <div className="absolute left-5 top-0 bottom-0 w-px bg-border" />

        <div className="space-y-0">
          {events.map((evt, idx) => (
            <div key={evt.id} className="relative pl-12">
              {/* Timeline dot */}
              <div className={`absolute left-3 top-4 w-4 h-4 rounded-full border-2 border-background z-10 ${
                evt.type === 'journal_entry' ? 'bg-purple-500' :
                evt.type === 'stock_movement'
                  ? (evt.sm?.movement_type === 'sale' ? 'bg-red-500' : 'bg-green-500')
                  : 'bg-blue-500'
              }`} />

              <div className={`py-3 ${idx < events.length - 1 ? 'border-b border-border/50' : ''}`}>
                {/* Timestamp */}
                <div className="text-[10px] text-muted-foreground mb-1 font-mono">
                  {new Date(evt.timestamp).toLocaleString()}
                </div>

                {evt.type === 'edit_history' && <EditHistoryEvent entry={evt.editEntry} />}
                {evt.type === 'journal_entry' && <JournalEntryEvent je={evt.je!} lines={evt.jeLines || []} accountMap={accountMap} />}
                {evt.type === 'stock_movement' && <StockMovementEvent sm={evt.sm} />}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── sub-components ── */

function EditHistoryEvent({ entry }: { entry: any }) {
  const changes = diffFields(entry.snapshot_before, entry.snapshot_after);

  return (
    <div className="bg-blue-50/40 border border-blue-100 rounded-lg p-3">
      <div className="flex items-center gap-2">
        <RefreshCw className="w-3.5 h-3.5 text-blue-600" />
        <span className="text-sm font-medium text-blue-800">
          {entry.change_type?.replace(/,/g, ' • ')}
        </span>
      </div>

      <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
        {entry.edited_by_name && (
          <span className="flex items-center gap-1"><User className="w-3 h-3" />{entry.edited_by_name}</span>
        )}
      </div>

      {entry.reason && (
        <div className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 bg-amber-50 px-2 py-1.5 rounded">
          <FileText className="w-3 h-3 shrink-0 mt-0.5" />
          <span>{entry.reason}</span>
        </div>
      )}

      {changes.length > 0 && (
        <div className="mt-2 space-y-1">
          {changes.map((c: any, i: number) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground font-medium">{c.field}:</span>
              <span className="text-red-500 line-through">{c.from}</span>
              <ArrowRight className="w-3 h-3 text-muted-foreground" />
              <span className="text-green-600 font-medium">{c.to}</span>
            </div>
          ))}
        </div>
      )}

      {entry.snapshot_before?.items && entry.snapshot_after?.items && (
        <details className="mt-2">
          <summary className="text-xs text-blue-600 cursor-pointer hover:underline">View item-level changes</summary>
          <ItemDiff beforeItems={entry.snapshot_before.items} afterItems={entry.snapshot_after.items} />
        </details>
      )}
    </div>
  );
}

function JournalEntryEvent({ je, lines, accountMap }: { je: any; lines: any[]; accountMap: Record<string, { name: string; code: string }> }) {
  const isCogs = je.description?.toLowerCase().includes('cogs');
  const isAr = je.description?.toLowerCase().includes('accounts receivable') || je.description?.toLowerCase().includes('ar ');
  const isPayment = je.description?.toLowerCase().includes('payment');
  const isReversal = je.description?.toLowerCase().includes('revers') || je.description?.toLowerCase().includes('edit');

  let bgColor = 'bg-purple-50/40';
  let borderColor = 'border-purple-100';
  let iconColor = 'text-purple-600';
  let labelColor = 'text-purple-800';

  if (isCogs) { bgColor = 'bg-orange-50/40'; borderColor = 'border-orange-100'; iconColor = 'text-orange-600'; labelColor = 'text-orange-800'; }
  else if (isPayment) { bgColor = 'bg-green-50/40'; borderColor = 'border-green-100'; iconColor = 'text-green-600'; labelColor = 'text-green-800'; }
  else if (isReversal) { bgColor = 'bg-amber-50/40'; borderColor = 'border-amber-100'; iconColor = 'text-amber-600'; labelColor = 'text-amber-800'; }

  return (
    <div className={`${bgColor} border ${borderColor} rounded-lg p-3`}>
      <div className="flex items-center gap-2">
        <BookOpen className={`w-3.5 h-3.5 ${iconColor}`} />
        <span className={`text-sm font-medium ${labelColor}`}>
          {je.entry_number}
        </span>
        <span className="text-xs text-muted-foreground">•</span>
        <span className="text-xs text-muted-foreground">{je.description}</span>
      </div>

      <div className="mt-2 space-y-1">
        {lines.map((line: any, i: number) => {
          const acct = accountMap[line.account_id];
          const amt = parseFloat(line.debit) > 0 ? parseFloat(line.debit) : parseFloat(line.credit);
          const isDebit = parseFloat(line.debit) > 0;
          return (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className={`inline-block w-10 text-center font-semibold rounded px-1 py-0.5 text-[10px] ${
                isDebit ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'
              }`}>
                {isDebit ? 'DR' : 'CR'}
              </span>
              <span className="font-medium text-foreground">{formatCurrency(amt)}</span>
              <span className="text-muted-foreground">
                {acct ? `${acct.code} ${acct.name}` : 'Unknown account'}
              </span>
              {line.description && (
                <span className="text-muted-foreground/70 italic">— {line.description}</span>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-1.5 text-[10px] text-muted-foreground">
        Posted: {new Date(je.created_at).toLocaleTimeString()}
      </div>
    </div>
  );
}

function StockMovementEvent({ sm }: { sm: any }) {
  const isSale = sm.movement_type === 'sale';
  const qty = Math.abs(parseFloat(sm.quantity));
  const productName = sm.products?.name || 'Unknown';
  const sku = sm.products?.sku || '';

  return (
    <div className={`rounded-lg p-3 border ${
      isSale
        ? 'bg-red-50/40 border-red-100'
        : 'bg-green-50/40 border-green-100'
    }`}>
      <div className="flex items-center gap-2">
        {isSale ? (
          <PackageMinus className="w-3.5 h-3.5 text-red-600" />
        ) : (
          <PackagePlus className="w-3.5 h-3.5 text-green-600" />
        )}
        <span className={`text-sm font-medium ${
          isSale ? 'text-red-800' : 'text-green-800'
        }`}>
          {isSale ? 'Stock Out' : 'Stock In'}
        </span>
        <span className={`inline-block text-xs font-semibold rounded px-1.5 py-0.5 ${
          isSale ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'
        }`}>
          {isSale ? `−${qty}` : `+${qty}`}
        </span>
      </div>

      <div className="mt-1.5 text-xs text-foreground">
        <span className="font-medium">{productName}</span>
        {sku && <span className="text-muted-foreground ml-1">({sku})</span>}
        <span className="text-muted-foreground ml-1">× {formatCurrency(sm.unit_cost)}</span>
      </div>

      {sm.notes && (
        <div className="mt-1 text-[10px] text-muted-foreground italic truncate" title={sm.notes}>
          {sm.notes}
        </div>
      )}
    </div>
  );
}

/* ── helpers ── */

function formatValue(val: unknown): string {
  if (val === null || val === undefined) return '—';
  if (typeof val === 'number') return formatCurrency(val);
  if (typeof val === 'string') return val;
  if (typeof val === 'object') return JSON.stringify(val).slice(0, 100);
  return String(val);
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

function ItemDiff({ beforeItems, afterItems }: { beforeItems: any[]; afterItems: any[] }) {
  const beforeMap = new Map(beforeItems.map((i: any) => [i.product_id, i]));
  const afterMap = new Map(afterItems.map((i: any) => [i.product_id, i]));
  const allProductIds = new Set([...beforeMap.keys(), ...afterMap.keys()]);

  const rows: { productId: string; type: string; before?: any; after?: any }[] = [];
  for (const pid of allProductIds) {
    const b = beforeMap.get(pid);
    const a = afterMap.get(pid);
    if (b && !a) rows.push({ productId: pid, type: 'removed', before: b });
    else if (!b && a) rows.push({ productId: pid, type: 'added', after: a });
    else if (b && a && JSON.stringify(b) !== JSON.stringify(a)) rows.push({ productId: pid, type: 'modified', before: b, after: a });
  }

  if (rows.length === 0) return <p className="text-xs text-muted-foreground mt-1">No item-level changes</p>;

  return (
    <div className="mt-1 border border-border rounded-lg overflow-hidden">
      <table className="w-full text-xs">
        <thead className="bg-muted/30">
          <tr>
            <th className="text-left px-2 py-1 font-medium text-muted-foreground">Product ID</th>
            <th className="text-center px-2 py-1 font-medium text-muted-foreground">Change</th>
            <th className="text-right px-2 py-1 font-medium text-muted-foreground">Qty</th>
            <th className="text-right px-2 py-1 font-medium text-muted-foreground">Price</th>
            <th className="text-right px-2 py-1 font-medium text-muted-foreground">Subtotal</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r, i) => (
            <tr key={i} className={r.type === 'added' ? 'bg-green-50/50' : r.type === 'removed' ? 'bg-red-50/50' : ''}>
              <td className="px-2 py-1 text-muted-foreground font-mono text-[10px]">{r.productId.slice(0, 8)}...</td>
              <td className="px-2 py-1 text-center">
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                  r.type === 'added' ? 'bg-green-100 text-green-700' :
                  r.type === 'removed' ? 'bg-red-100 text-red-700' :
                  'bg-amber-100 text-amber-700'
                }`}>{r.type}</span>
              </td>
              <td className="px-2 py-1 text-right">
                {r.type === 'modified' ? (
                  <span><span className="text-red-500 line-through">{r.before.quantity}</span> → <span className="text-green-600">{r.after.quantity}</span></span>
                ) : (r.before?.quantity ?? r.after?.quantity ?? '—')}
              </td>
              <td className="px-2 py-1 text-right">
                {r.type === 'modified' ? (
                  <span><span className="text-red-500 line-through">{formatCurrency(r.before.unit_price)}</span> → <span className="text-green-600">{formatCurrency(r.after.unit_price)}</span></span>
                ) : formatCurrency(r.before?.unit_price ?? r.after?.unit_price ?? 0)}
              </td>
              <td className="px-2 py-1 text-right">
                {r.type === 'modified' ? (
                  <span><span className="text-red-500 line-through">{formatCurrency(r.before.subtotal)}</span> → <span className="text-green-600">{formatCurrency(r.after.subtotal)}</span></span>
                ) : formatCurrency(r.before?.subtotal ?? r.after?.subtotal ?? 0)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
