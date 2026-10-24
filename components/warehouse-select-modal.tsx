'use client';

// Warehouse picker for a POS cart line. The line itself shows a compact
// icon button; the choice happens here, so a line never spends a row on a
// warehouse control. Each row shows what that warehouse actually holds
// against the quantity the line needs, so picking the wrong one is
// visible before checkout rather than after.
//
// Multi mode: checkbox rows with a combined-coverage footer. Selecting
// several warehouses lets one line draw from all of them (largest-stock
// first); any shortfall the combined stock cannot cover is confirmed at
// checkout by the oversell gate.

import { useMemo, useState } from 'react';
import { Warehouse, X, Check, TriangleAlert as AlertTriangle } from 'lucide-react';
import { fmtQty } from '@/lib/batch-allocation';

export interface WarehouseOption {
  warehouse_id: string;
  warehouse_name: string;
  stock: number;
}

export function WarehouseSelectModal({
  productName,
  unitLabel,
  needBaseQty,
  conversionFactor,
  options,
  selectedId,
  selectedIds,
  multi,
  onSelect,
  onDone,
  onClose,
}: {
  productName: string;
  unitLabel?: string;
  // Base units the line needs (the unit the ledger counts in).
  needBaseQty: number;
  conversionFactor?: number;
  options: WarehouseOption[];
  selectedId?: string | null;
  // Multi mode: the current selection (order = allocation priority).
  selectedIds?: string[];
  multi?: boolean;
  onSelect: (warehouseId: string) => void;
  onDone?: (warehouseIds: string[]) => void;
  onClose: () => void;
}) {
  const factor = conversionFactor ?? 1;
  const [draft, setDraft] = useState<string[]>(() => {
    const base = (selectedIds || []).filter(id => options.some(w => w.warehouse_id === id));
    // Every stocked warehouse starts selected unless the line already
    // narrowed it down — the default sale draws from all of them.
    return base.length > 0 ? base : options.map(w => w.warehouse_id);
  });

  const combinedStock = useMemo(
    () => draft.reduce((s, id) => s + (options.find(w => w.warehouse_id === id)?.stock || 0), 0),
    [draft, options]
  );
  const combinedShort = Math.max(0, needBaseQty - combinedStock);

  function toggle(id: string) {
    setDraft(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[120] p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-sm shadow-2xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="min-w-0">
            <h3 className="font-bold text-sm flex items-center gap-2">
              <Warehouse className="w-4 h-4 text-emerald-600" /> {multi ? 'Select Warehouses' : 'Select Warehouse'}
            </h3>
            <p className="text-xs text-muted-foreground break-words">{productName}</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground shrink-0"><X className="w-5 h-5" /></button>
        </div>

        <div className="px-5 py-3 bg-muted/30 text-xs text-muted-foreground">
          This line needs{' '}
          <span className="font-semibold text-foreground">{fmtQty(needBaseQty)}</span> base units
          {factor !== 1 && unitLabel && (
            <span> · {fmtQty(needBaseQty / factor)} {unitLabel}</span>
          )}
          {multi && <span> — tick every warehouse it may draw from; largest stock serves first.</span>}
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
          {options.map(w => {
            const selected = multi ? draft.includes(w.warehouse_id) : w.warehouse_id === selectedId;
            const short = Math.max(0, needBaseQty - w.stock);
            return (
              <button
                key={w.warehouse_id}
                onClick={() => multi ? toggle(w.warehouse_id) : onSelect(w.warehouse_id)}
                className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg border text-left transition ${
                  selected ? 'border-emerald-300 bg-emerald-50/60' : 'border-border hover:border-emerald-300 hover:bg-muted/40'
                }`}
              >
                <span className={`flex items-center justify-center w-4 h-4 rounded-full border shrink-0 ${selected ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-border'}`}>
                  {selected && <Check className="w-3 h-3" />}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-xs font-medium text-foreground truncate">{w.warehouse_name}</span>
                  {!multi && short > 1e-9 && (
                    <span className="flex items-center gap-1 text-[10px] text-amber-700">
                      <AlertTriangle className="w-3 h-3 shrink-0" /> short {fmtQty(short)} — holds {fmtQty(w.stock)}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{fmtQty(w.stock)}</span>
              </button>
            );
          })}
        </div>

        <div className="px-5 py-3 border-t border-border shrink-0">
          {multi ? (
            <>
              <div className={`flex items-center gap-1.5 text-xs mb-2.5 ${combinedShort > 1e-9 ? 'text-amber-700' : 'text-muted-foreground'}`}>
                {combinedShort > 1e-9 && <AlertTriangle className="w-3.5 h-3.5 shrink-0" />}
                <span>
                  Selected {draft.length} warehouse{draft.length === 1 ? '' : 's'} hold{draft.length === 1 ? 's' : ''}{' '}
                  <span className="font-semibold text-foreground">{fmtQty(combinedStock)}</span>
                  {combinedShort > 1e-9
                    ? ` — short ${fmtQty(combinedShort)} (confirm at checkout)`
                    : ' — covers this line'}
                </span>
              </div>
              <div className="flex gap-2">
                <button onClick={onClose} className="flex-1 px-4 py-2.5 border border-border rounded-lg text-sm font-medium hover:bg-muted transition">
                  Cancel
                </button>
                <button
                  onClick={() => draft.length > 0 && onDone?.(draft)}
                  disabled={draft.length === 0}
                  className="flex-1 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 disabled:hover:bg-emerald-600 text-white rounded-lg text-sm font-semibold transition"
                >
                  Done
                </button>
              </div>
            </>
          ) : (
            <button onClick={onClose} className="w-full px-4 py-2.5 border border-border rounded-lg text-sm font-medium hover:bg-muted transition">
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
