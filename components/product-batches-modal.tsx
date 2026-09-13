'use client';

// Per-product batch drill-down for the inventory page. Opened by clicking a
// product's stock number; fetches that product's inventory_batches lazily
// (one small, index-served query per open) and shows every layer: warehouse,
// received/remaining qty, unit cost, value, expiry and reference. Quantities
// are in BASE units — the batch ledger is kept in base units — and for
// multi-unit products the sale-unit equivalent is shown next to them,
// matching the POS batch-preview convention.

import { useEffect, useMemo, useState } from 'react';
import { Layers, Loader2, X } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/format';
import { fmtQty } from '@/lib/batch-allocation';

export interface ProductBatchesModalProduct {
  id: string;
  name: string;
  sku: string;
  unit?: string | null;
  base_unit?: string | null;
}

interface BatchRow {
  id: string;
  batch_number: string | null;
  batch_type: string | null;
  quantity_received: number | string;
  quantity_remaining: number | string;
  unit_cost: number | string;
  expiry_date: string | null;
  created_at: string;
  reference_number: string | null;
  notes: string | null;
  warehouse?: { name: string } | null;
  product?: {
    unit?: string | null;
    base_unit?: string | null;
    product_units?: {
      unit_name: string;
      unit_short: string;
      conversion_factor: number | string;
      is_base_unit: boolean;
      is_sale_unit: boolean;
      is_active: boolean;
    }[] | null;
  } | null;
}

const TYPE_BADGES: Record<string, string> = {
  purchase: 'bg-blue-50 text-blue-600',
  opening: 'bg-slate-100 text-slate-600',
  adjustment: 'bg-amber-50 text-amber-600',
  return: 'bg-purple-50 text-purple-600',
};

function isExpired(expiryDate: string | null): boolean {
  if (!expiryDate) return false;
  return new Date(expiryDate) < new Date(new Date().toDateString());
}

export function ProductBatchesModal({ product, onClose }: {
  product: ProductBatchesModalProduct;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<BatchRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [availableOnly, setAvailableOnly] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data, error: fetchError } = await supabase
          .from('inventory_batches')
          .select(`id, batch_number, batch_type, quantity_received, quantity_remaining, unit_cost,
                   expiry_date, created_at, reference_number, notes,
                   warehouse:warehouses(name),
                   product:products(id, unit, base_unit, product_units(id, unit_name, unit_short, conversion_factor, is_base_unit, is_sale_unit, is_active))`)
          .eq('product_id', product.id)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true });
        if (cancelled) return;
        if (fetchError) throw fetchError;
        setRows((data || []) as unknown as BatchRow[]);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Failed to load batches');
      }
    })();
    return () => { cancelled = true; };
  }, [product.id]);

  const units = useMemo(() => {
    const base = rows?.[0]?.product?.base_unit || rows?.[0]?.product?.unit || product.unit || 'pcs';
    // Sale-unit equivalent shown next to base qty (POS convention): the
    // product's active sale unit when its conversion factor differs from 1.
    const sale = (rows?.[0]?.product?.product_units || []).find(
      (u) => u.is_active && u.is_sale_unit && Number(u.conversion_factor) !== 1
    );
    return { base, sale };
  }, [rows, product.unit]);

  const displayed = useMemo(
    () => (rows || []).filter((b) => !availableOnly || Number(b.quantity_remaining) > 0),
    [rows, availableOnly]
  );

  const totals = useMemo(() => {
    const available = (rows || []).filter((b) => Number(b.quantity_remaining) > 0);
    const remaining = available.reduce((s, b) => s + Number(b.quantity_remaining), 0);
    const value = available.reduce((s, b) => s + Number(b.quantity_remaining) * Number(b.unit_cost), 0);
    const hasIou = (rows || []).some((b) => Number(b.quantity_remaining) < 0);
    return { remaining, value, hasIou, availableCount: available.length };
  }, [rows]);

  const saleEquivalent = (qty: number) =>
    units.sale ? fmtQty(qty / Number(units.sale.conversion_factor)) : null;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[120] p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-5xl shadow-2xl max-h-[88vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="min-w-0">
            <h3 className="font-bold text-sm flex items-center gap-2"><Layers className="w-4 h-4 text-blue-600" /> Batches</h3>
            <p className="text-xs text-muted-foreground truncate">{product.name} · {product.sku}</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground shrink-0"><X className="w-5 h-5" /></button>
        </div>

        {rows === null && !error ? (
          <div className="flex-1 flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
          </div>
        ) : error ? (
          <div className="flex-1 flex items-center justify-center py-12 px-6 text-center">
            <p className="text-sm text-red-600">{error}</p>
          </div>
        ) : (
          <>
            <div className="px-5 py-3 bg-muted/30 border-b border-border shrink-0 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
              <span className="text-muted-foreground">Remaining:
                <span className="font-bold text-foreground ml-1">
                  {fmtQty(totals.remaining)} {units.base}
                  {units.sale && <span className="font-medium text-muted-foreground"> ({saleEquivalent(totals.remaining)} {units.sale.unit_short})</span>}
                </span>
              </span>
              <span className="text-muted-foreground">Available value: <span className="font-bold text-foreground">{formatCurrency(totals.value)}</span></span>
              <span className="text-muted-foreground">Layers: <span className="font-bold text-foreground">{totals.availableCount}</span></span>
              <label className="ml-auto flex items-center gap-1.5 cursor-pointer select-none">
                <input type="checkbox" checked={availableOnly} onChange={(e) => setAvailableOnly(e.target.checked)} className="accent-blue-600" />
                <span className="text-muted-foreground">Available only</span>
              </label>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-3">
              {displayed.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">
                  {(rows || []).length === 0
                    ? 'No batches recorded for this product.'
                    : 'No available batches — every layer is exhausted.'}
                </p>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="text-left text-[11px] font-semibold text-muted-foreground border-b border-border">
                      <th className="py-2 pr-2">#</th>
                      <th className="py-2 pr-2">Batch</th>
                      <th className="py-2 pr-2">Type</th>
                      <th className="py-2 pr-2">Warehouse</th>
                      <th className="py-2 pr-2 text-right">Received</th>
                      <th className="py-2 pr-2 text-right">Remaining</th>
                      <th className="py-2 pr-2 text-right">Unit Cost</th>
                      <th className="py-2 pr-2 text-right">Value</th>
                      <th className="py-2 pr-2">Expiry</th>
                      <th className="py-2">Date</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {displayed.map((b, i) => {
                      const remaining = Number(b.quantity_remaining);
                      const exhausted = remaining === 0;
                      const iou = remaining < 0;
                      const value = remaining * Number(b.unit_cost);
                      const saleQty = saleEquivalent(remaining);
                      return (
                        <tr key={b.id} className={exhausted ? 'opacity-50' : ''}>
                          <td className="py-2 pr-2 text-xs text-muted-foreground">{i + 1}</td>
                          <td className="py-2 pr-2">
                            <p className="text-xs font-medium text-foreground">{b.batch_number || b.id.slice(0, 8)}</p>
                            {(b.reference_number || b.notes) && (
                              <p className="text-[10px] text-muted-foreground truncate max-w-[160px]" title={[b.reference_number, b.notes].filter(Boolean).join(' · ')}>
                                {[b.reference_number, b.notes].filter(Boolean).join(' · ')}
                              </p>
                            )}
                          </td>
                          <td className="py-2 pr-2">
                            <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${TYPE_BADGES[b.batch_type || ''] || 'bg-slate-100 text-slate-600'}`}>
                              {b.batch_type || '—'}
                            </span>
                          </td>
                          <td className="py-2 pr-2 text-xs text-foreground">{b.warehouse?.name || '—'}</td>
                          <td className="py-2 pr-2 text-right text-xs text-muted-foreground">{fmtQty(Number(b.quantity_received))}</td>
                          <td className="py-2 pr-2 text-right text-xs">
                            <span className={`font-semibold ${iou ? 'text-red-600' : 'text-foreground'}`}>{fmtQty(remaining)}</span>
                            {saleQty && <span className="text-muted-foreground"> ({saleQty} {units.sale!.unit_short})</span>}
                            {iou && <span className="ml-1.5 inline-block px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 text-[10px] font-semibold align-middle">IOU</span>}
                          </td>
                          <td className="py-2 pr-2 text-right text-xs text-muted-foreground">{formatCurrency(Number(b.unit_cost))}</td>
                          <td className={`py-2 pr-2 text-right text-xs font-medium ${value < 0 ? 'text-red-600' : 'text-foreground'}`}>{formatCurrency(value)}</td>
                          <td className={`py-2 pr-2 text-xs ${isExpired(b.expiry_date) ? 'text-red-600 font-medium' : 'text-muted-foreground'}`}>
                            {b.expiry_date || '—'}
                          </td>
                          <td className="py-2 text-xs text-muted-foreground whitespace-nowrap">{new Date(b.created_at).toLocaleDateString()}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              {totals.hasIou && (
                <p className="mt-3 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  Negative layers (IOU) are oversell debts — stock was sold before it was received. They are excluded
                  from the remaining/value totals above.
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
