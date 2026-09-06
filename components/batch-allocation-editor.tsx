'use client';

// Manual batch-allocation override editor (spec §9). The cashier normally
// never sees this — automatic allocation covers the flow — but authorized
// users can pin a specific spread across batches. Validation matches the
// spec exactly: every per-batch qty must fit that batch's availability
// (after the rest of the cart takes its share) and the allocations must sum
// to the line's quantity. Nothing is saved unless both hold.

import { useMemo, useState } from 'react';
import { Layers, RotateCcw, X } from 'lucide-react';
import { fmtQty, type AllocatableBatch, type AllocationStrategy } from '@/lib/batch-allocation';

export interface EditorBatch {
  batch: AllocatableBatch;
  // Available to THIS line: physical remaining minus other cart lines' use
  available: number;
}

const EPSILON = 1e-9;

export function BatchAllocationEditor({
  productName,
  lineQty,
  unitLabel,
  batches,
  autoAllocations,
  initialOverride,
  strategy,
  onSave,
  onUseAuto,
  onClose,
}: {
  productName: string;
  lineQty: number;
  unitLabel?: string;
  batches: EditorBatch[];
  // The line's current automatic allocation (used to prefill / reset)
  autoAllocations: Record<string, number>;
  initialOverride: Record<string, number> | null;
  strategy: AllocationStrategy;
  onSave: (override: Record<string, number>) => void;
  onUseAuto: () => void;
  onClose: () => void;
}) {
  const initial = useMemo<Record<string, string>>(() => {
    const src = initialOverride && Object.keys(initialOverride).length > 0 ? initialOverride : autoAllocations;
    const out: Record<string, string> = {};
    for (const { batch } of batches) {
      const q = src[batch.id];
      if (q && q > EPSILON) out[batch.id] = fmtQty(q);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [values, setValues] = useState<Record<string, string>>(initial);

  const parsed = useMemo(() => {
    const out: Record<string, number> = {};
    for (const { batch } of batches) {
      const raw = (values[batch.id] ?? '').trim();
      const n = raw === '' ? 0 : parseFloat(raw);
      out[batch.id] = isFinite(n) && n > 0 ? n : 0;
    }
    return out;
  }, [values, batches]);

  const total = useMemo(() => Object.values(parsed).reduce((s, q) => s + q, 0), [parsed]);
  const over = batches.some(({ batch, available }) => parsed[batch.id] > available + EPSILON);
  const balanced = Math.abs(total - lineQty) < EPSILON && !over;
  const dirty = useMemo(
    () => batches.some(({ batch }) => Math.abs((parsed[batch.id] || 0) - (autoAllocations[batch.id] || 0)) > EPSILON),
    [parsed, autoAllocations, batches]
  );

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[120] p-4">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="min-w-0">
            <h3 className="font-bold text-sm flex items-center gap-2"><Layers className="w-4 h-4 text-blue-600" /> Edit Batch Allocation</h3>
            <p className="text-xs text-muted-foreground truncate">{productName}</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground shrink-0"><X className="w-5 h-5" /></button>
        </div>

        <div className="px-5 py-3 bg-muted/30 text-xs text-muted-foreground flex items-center justify-between">
          <span>Quantity to allocate: <span className="font-semibold text-foreground">{fmtQty(lineQty)}{unitLabel ? ` ${unitLabel}` : ''}</span></span>
          <span>Strategy: <span className="font-semibold text-foreground uppercase">{strategy}</span></span>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3">
          {batches.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No eligible batches in this warehouse.</p>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="text-left text-[11px] font-semibold text-muted-foreground border-b border-border">
                  <th className="py-1.5 pr-2">Batch</th>
                  <th className="py-1.5 pr-2 text-right">Available</th>
                  <th className="py-1.5 text-right">Allocate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {batches.map(({ batch, available }) => {
                  const v = parsed[batch.id] || 0;
                  const overBatch = v > available + EPSILON;
                  return (
                    <tr key={batch.id}>
                      <td className="py-1.5 pr-2">
                        <p className="text-xs font-medium text-foreground truncate max-w-[140px]">{batch.batch_number || batch.id.slice(0, 8)}</p>
                        <p className="text-[10px] text-muted-foreground">
                          @ ৳{fmtQty(batch.unit_cost)}{batch.expiry_date ? ` · exp ${batch.expiry_date}` : ''}
                        </p>
                      </td>
                      <td className="py-1.5 pr-2 text-right text-xs text-muted-foreground">{fmtQty(available)}</td>
                      <td className="py-1.5 text-right">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={values[batch.id] ?? ''}
                          onChange={e => setValues(prev => ({ ...prev, [batch.id]: e.target.value }))}
                          className={`w-20 text-xs border rounded px-1.5 py-1 text-right focus:outline-none bg-white ${overBatch ? 'border-red-400 focus:border-red-500' : 'border-border focus:border-blue-400'}`}
                          placeholder="0"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="px-5 py-3 border-t border-border shrink-0">
          <div className="flex items-center justify-between text-xs mb-3">
            <span className="text-muted-foreground">
              Allocated <span className={`font-bold ${balanced ? 'text-green-600' : 'text-amber-600'}`}>{fmtQty(total)}</span> of {fmtQty(lineQty)}
            </span>
            {over && <span className="text-red-500 font-medium">A batch allocation exceeds its availability</span>}
            {!over && !balanced && <span className="text-amber-600 font-medium">Allocations must sum to the line quantity</span>}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onUseAuto}
              disabled={!dirty}
              className="px-3 py-2.5 border border-border rounded-lg text-xs font-medium hover:bg-muted transition disabled:opacity-40 flex items-center gap-1.5"
              title="Discard manual changes and use automatic allocation"
            >
              <RotateCcw className="w-3.5 h-3.5" /> Auto
            </button>
            <button onClick={onClose} className="flex-1 px-4 py-2.5 border border-border rounded-lg text-sm font-medium hover:bg-muted transition">
              Cancel
            </button>
            <button
              onClick={() => onSave(parsed)}
              disabled={!balanced}
              className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-50"
            >
              Save Allocation
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
