'use client';

// Read-only view of a line's batch allocation. The cashier opens it from
// the Layers button in the cart line's inputs row and sees which batches
// the ledger will consume, what they cost, and any warnings. Editing is a
// separate step (the existing BatchAllocationEditor) so the common case
// stays a single click that cannot change anything by accident.

import { Layers, Pencil, X, TriangleAlert as AlertTriangle } from 'lucide-react';
import { fmtQty, type BatchAllocation, type AllocationStrategy } from '@/lib/batch-allocation';
import { formatCurrency } from '@/lib/format';

export interface BatchViewerLine {
  productName: string;
  sku?: string;
  unitLabel?: string;
  warehouseName?: string;
  // Base units the line needs vs. base units the ledger covers.
  lineQty: number;
  allocatedQty: number;
  shortfall: number;
  usedOverride: boolean;
  overrideInvalid: boolean;
  strategy: AllocationStrategy;
  allocations: BatchAllocation[];
  // Unit conversion used by the sale unit, if the product sells in one.
  conversionFactor?: number;
}

export function BatchAllocationViewer({
  line,
  onEdit,
  onClose,
}: {
  line: BatchViewerLine;
  onEdit: () => void;
  onClose: () => void;
}) {
  const total = line.allocations.reduce((s, a) => s + a.qty * a.batch.unit_cost, 0);
  const factor = line.conversionFactor ?? 1;
  const warnings: string[] = [];
  if (line.shortfall > 1e-9) {
    warnings.push(`Ledger covers ${fmtQty(line.allocatedQty)} of ${fmtQty(line.lineQty)} — short ${fmtQty(line.shortfall)} base units.`);
  }
  if (line.overrideInvalid) {
    warnings.push('The manual allocation no longer fits the batch availability, so it was ignored and automatic allocation was used.');
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[120] p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="min-w-0">
            <h3 className="font-bold text-sm flex items-center gap-2"><Layers className="w-4 h-4 text-blue-600" /> Batch Allocation</h3>
            <p className="text-xs text-muted-foreground break-words">{line.productName}{line.sku ? ` · ${line.sku}` : ''}</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground shrink-0"><X className="w-5 h-5" /></button>
        </div>

        <div className="px-5 py-3 bg-muted/30 text-xs text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>Warehouse: <span className="font-semibold text-foreground">{line.warehouseName || '—'}</span></span>
          <span>Strategy: <span className="font-semibold text-foreground uppercase">{line.usedOverride ? 'Manual' : line.strategy}</span></span>
          <span>Allocated: <span className="font-semibold text-foreground">{fmtQty(line.allocatedQty)} / {fmtQty(line.lineQty)}</span></span>
        </div>

        {warnings.length > 0 && (
          <div className="px-5 pt-3">
            {warnings.map(w => (
              <div key={w} className="flex items-start gap-1.5 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 mb-1">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-px" />
                <span>{w}</span>
              </div>
            ))}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-3">
          {line.allocations.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No batches allocated to this line.</p>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="text-left text-[11px] font-semibold text-muted-foreground border-b border-border">
                  <th className="py-1.5 pr-2">Batch</th>
                  <th className="py-1.5 pr-2 text-right">Qty</th>
                  <th className="py-1.5 pr-2 text-right">Unit cost</th>
                  <th className="py-1.5 text-right">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {line.allocations.map(a => (
                  <tr key={a.batch.id}>
                    <td className="py-1.5 pr-2">
                      <p className="text-xs font-medium text-foreground truncate max-w-[150px]">{a.batch.batch_number || a.batch.id.slice(0, 8)}</p>
                      {a.batch.expiry_date && <p className="text-[10px] text-muted-foreground">exp {a.batch.expiry_date}</p>}
                    </td>
                    <td className="py-1.5 pr-2 text-right text-xs text-muted-foreground whitespace-nowrap">
                      {fmtQty(a.qty)}
                      {factor !== 1 && line.unitLabel && (
                        <span className="block text-[10px]">({fmtQty(a.qty / factor)} {line.unitLabel})</span>
                      )}
                    </td>
                    <td className="py-1.5 pr-2 text-right text-xs text-muted-foreground whitespace-nowrap">{formatCurrency(a.batch.unit_cost)}</td>
                    <td className="py-1.5 text-right text-xs font-medium text-foreground whitespace-nowrap">{formatCurrency(a.qty * a.batch.unit_cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="px-5 py-3 border-t border-border shrink-0">
          <div className="flex items-center justify-between text-xs mb-3">
            <span className="text-muted-foreground">Batch COGS (est.)</span>
            <span className="font-semibold text-foreground">{formatCurrency(total)}</span>
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="flex-1 px-4 py-2.5 border border-border rounded-lg text-sm font-medium hover:bg-muted transition">
              Close
            </button>
            <button
              onClick={onEdit}
              className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition flex items-center justify-center gap-1.5"
            >
              <Pencil className="w-3.5 h-3.5" /> Edit Allocation
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
