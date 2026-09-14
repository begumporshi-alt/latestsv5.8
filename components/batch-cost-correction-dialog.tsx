'use client';

// Shared dialog for correcting a batch's unit cost (per BASE unit). Used by
// the products-page Batches modal and the /inventory/audit Cost Outliers tab.
// Posts through the correct_batch_cost RPC, which updates the batch, posts a
// value-delta journal entry (Dr/Cr 1200 vs 3900) and writes an audit row —
// the frontend never writes inventory_batches or journal tables directly.

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2, Pencil } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/format';
import { fmtQty } from '@/lib/batch-allocation';
import { toast } from '@/hooks/use-toast';

export interface BatchCostCorrectionTarget {
  batchId: string;
  batchNumber: string | null;
  productName: string;
  unitCost: number;            // current cost per base unit
  quantityRemaining: number;   // base units
  baseUnit: string;
  productCost?: number | null; // product's cost per base unit — used as the suggested cost
}

export function BatchCostCorrectionDialog({ target, onClose, onCorrected }: {
  target: BatchCostCorrectionTarget;
  onClose: () => void;
  onCorrected: () => void;
}) {
  const [newCost, setNewCost] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Pre-fill with the suggested cost whenever a new batch is opened.
  useEffect(() => {
    setNewCost(target.productCost && target.productCost > 0 ? String(target.productCost) : '');
    setReason('');
  }, [target.batchId, target.productCost]);

  const parsedCost = parseFloat(newCost);
  const validCost = !isNaN(parsedCost) && parsedCost > 0;
  const validReason = reason.trim().length >= 3;

  const delta = useMemo(
    () => (validCost ? target.quantityRemaining * (parsedCost - target.unitCost) : 0),
    [validCost, parsedCost, target.quantityRemaining, target.unitCost]
  );

  // Same outlier rule the audit check uses — warn before swapping one wrong
  // scale for another.
  const newRatio = target.productCost && target.productCost > 0 && validCost
    ? parsedCost / target.productCost : null;
  const outlierWarning = newRatio !== null && (newRatio > 20 || newRatio < 1 / 20);

  const submit = async () => {
    if (!validCost || !validReason || submitting) return;
    setSubmitting(true);
    try {
      const { data, error } = await supabase.rpc('correct_batch_cost', {
        p_batch_id: target.batchId,
        p_new_unit_cost: parsedCost,
        p_reason: reason.trim(),
        p_username: 'inventory-ui',
      });
      if (error) throw error;
      const result = data as { success?: boolean; error?: string; je_number?: string | null; value_delta?: number };
      if (!result?.success) throw new Error(result?.error || 'Correction failed');
      onCorrected();
      toast({
        title: `Corrected ${target.batchNumber || 'batch'} cost`,
        description: `${formatCurrency(target.unitCost)} → ${formatCurrency(parsedCost)} per ${target.baseUnit}`
          + `${result.je_number ? ` · journal entry ${result.je_number}` : ''}`
          + `${result.value_delta ? ` · value ${formatCurrency(result.value_delta)}` : ''}`,
      });
    } catch (e) {
      toast({
        title: 'Correction failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[130] p-4" onClick={submitting ? undefined : onClose}>
      <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="min-w-0">
            <h3 className="font-bold text-sm flex items-center gap-2"><Pencil className="w-4 h-4 text-blue-600" /> Correct Batch Cost</h3>
            <p className="text-xs text-muted-foreground truncate">{target.productName} · {target.batchNumber || target.batchId.slice(0, 8)}</p>
          </div>
          <button onClick={onClose} disabled={submitting} className="text-muted-foreground hover:text-foreground shrink-0 disabled:opacity-40">✕</button>
        </div>

        <div className="p-5 space-y-4">
          <div className="rounded-xl border border-border bg-muted/30 p-3 text-xs space-y-1">
            <div className="flex justify-between"><span className="text-muted-foreground">Current cost</span><span className="font-semibold">{formatCurrency(target.unitCost)} <span className="text-muted-foreground font-normal">per {target.baseUnit}</span></span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Remaining</span><span className="font-semibold">{fmtQty(target.quantityRemaining)} {target.baseUnit}</span></div>
            {validCost && Math.abs(delta) >= 1 && (
              <div className="flex justify-between pt-1 border-t border-border/60">
                <span className="text-muted-foreground">Value change</span>
                <span className={`font-semibold ${delta < 0 ? 'text-red-600' : 'text-emerald-600'}`}>{delta < 0 ? '' : '+'}{formatCurrency(delta)}</span>
              </div>
            )}
            {validCost && Math.abs(delta) >= 1 && (
              <p className="text-[10px] text-muted-foreground pt-1">
                A value-delta journal entry (Inventory vs Opening Balance Equity) keeps the GL and batch ledger in sync.
              </p>
            )}
          </div>

          <div>
            <label className="block text-xs font-semibold text-muted-foreground mb-1">NEW UNIT COST (per {target.baseUnit})</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={newCost}
              onChange={(e) => setNewCost(e.target.value)}
              className="w-full text-sm border border-border rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400 bg-white"
            />
            {target.productCost && target.productCost > 0 && (
              <p className="text-[11px] text-muted-foreground mt-1">
                Product cost: {formatCurrency(target.productCost)} per {target.baseUnit}
                {Math.abs((validCost ? parsedCost : 0) - target.productCost) > 0.005 && (
                  <button type="button" onClick={() => setNewCost(String(target.productCost))} className="ml-2 text-blue-600 hover:underline font-medium">Use this</button>
                )}
              </p>
            )}
          </div>

          {outlierWarning && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-800">
                This new cost is still {newRatio! >= 1 ? `${Math.round(newRatio!)}×` : `1/${Math.round(1 / newRatio!)}×`} the product cost — make sure it is really per {target.baseUnit}, not per sale unit.
              </p>
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-muted-foreground mb-1">REASON (required, audit-logged)</label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. coil price was entered per meter — 100× too high"
              className="w-full text-sm border border-border rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400 bg-white"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-border">
          <button onClick={onClose} disabled={submitting} className="px-4 py-2 text-sm border border-border rounded-lg hover:bg-muted transition disabled:opacity-50">Cancel</button>
          <button
            onClick={submit}
            disabled={!validCost || !validReason || submitting}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:opacity-50 inline-flex items-center gap-2"
          >
            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
            Correct Cost
          </button>
        </div>
      </div>
    </div>
  );
}
