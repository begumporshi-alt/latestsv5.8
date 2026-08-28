'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/format';
import { History, Clock, User, FileText, ArrowRight } from 'lucide-react';
import type { InvoiceEditHistory } from '@/lib/types';

interface EditHistoryPanelProps {
  invoiceId: string;
}

export default function EditHistoryPanel({ invoiceId }: EditHistoryPanelProps) {
  const [history, setHistory] = useState<InvoiceEditHistory[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadHistory();
  }, [invoiceId]);

  async function loadHistory() {
    setLoading(true);
    const { data } = await supabase
      .from('invoice_edit_history')
      .select('*')
      .eq('invoice_id', invoiceId)
      .order('edited_at', { ascending: false });

    setHistory((data || []) as InvoiceEditHistory[]);
    setLoading(false);
  }

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

  if (loading) {
    return <div className="p-4 text-center text-sm text-muted-foreground">Loading edit history...</div>;
  }

  if (history.length === 0) {
    return (
      <div className="p-8 text-center">
        <History className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
        <p className="text-sm text-muted-foreground">No edits have been made to this invoice</p>
      </div>
    );
  }

  return (
    <div className="max-h-[400px] overflow-y-auto">
      <div className="divide-y divide-border">
        {history.map((entry, idx) => {
          const changes = diffFields(entry.snapshot_before as Record<string, unknown> | undefined, entry.snapshot_after as Record<string, unknown> | undefined);
          const isLatest = idx === 0;
          return (
            <div key={entry.id} className={`p-4 ${isLatest ? 'bg-blue-50/30' : ''}`}>
              <div className="flex items-start gap-3">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${isLatest ? 'bg-blue-100 text-blue-600' : 'bg-muted text-muted-foreground'}`}>
                  <History className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-foreground">{entry.change_type.replace(/,/g, ' • ')}</span>
                    {isLatest && <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 text-[10px] font-medium rounded">Latest</span>}
                  </div>
                  <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {new Date(entry.edited_at).toLocaleString()}
                    </span>
                    {entry.edited_by_name && (
                      <span className="flex items-center gap-1">
                        <User className="w-3 h-3" />
                        {entry.edited_by_name}
                      </span>
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
                      {changes.map((c, i) => (
                        <div key={i} className="flex items-center gap-2 text-xs">
                          <span className="text-muted-foreground font-medium">{c.field}:</span>
                          <span className="text-red-500 line-through">{c.from}</span>
                          <ArrowRight className="w-3 h-3 text-muted-foreground" />
                          <span className="text-green-600 font-medium">{c.to}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {entry.snapshot_before && entry.snapshot_after && (entry.snapshot_before as any).items && (entry.snapshot_after as any).items && (
                    <details className="mt-2">
                      <summary className="text-xs text-blue-600 cursor-pointer hover:underline">
                        View item-level changes
                      </summary>
                      <ItemDiff
                        beforeItems={(entry.snapshot_before as any).items}
                        afterItems={(entry.snapshot_after as any).items}
                      />
                    </details>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
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
