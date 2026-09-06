'use client';

// Insufficient-stock dialog for the POS (spec §6): when a requested quantity
// exceeds what the batch ledger can cover, offer to add only what exists.
// Whether the partial option appears at all is configurable
// (app_settings.inventory.allow_partial_add).

import { Package, TriangleAlert as AlertTriangle } from 'lucide-react';

export interface InsufficientStockInfo {
  productName: string;
  requested: number;
  available: number;
  unitName?: string;
}

export function InsufficientStockDialog({
  info,
  allowPartial,
  onAddPartial,
  onCancel,
}: {
  info: InsufficientStockInfo;
  allowPartial: boolean;
  onAddPartial: (qty: number) => void;
  onCancel: () => void;
}) {
  const partial = Math.max(0, info.available);
  const unit = info.unitName ? ` ${info.unitName}` : ' units';
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[120] p-4">
      <div className="bg-white rounded-2xl w-full max-w-sm shadow-2xl">
        <div className="flex items-start gap-3 px-5 py-4 border-b border-border">
          <div className="w-9 h-9 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-5 h-5 text-amber-600" />
          </div>
          <div className="min-w-0">
            <h3 className="font-bold text-sm text-foreground">Insufficient stock</h3>
            <p className="text-xs text-muted-foreground truncate">{info.productName}</p>
          </div>
        </div>
        <div className="px-5 py-4 space-y-3">
          <p className="text-sm text-foreground">
            Only <span className="font-bold">{partial}{unit}</span> are available across all batches.
          </p>
          <div className="bg-muted/40 rounded-xl p-3 text-sm space-y-1">
            <div className="flex justify-between"><span className="text-muted-foreground">Requested</span><span className="font-medium">{info.requested}{unit}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Available to sell</span><span className="font-medium text-amber-600">{partial}{unit}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Short by</span><span className="font-medium text-red-500">{Math.max(0, info.requested - partial)}{unit}</span></div>
          </div>
          {!allowPartial && (
            <p className="text-xs text-muted-foreground flex items-start gap-1.5">
              <Package className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              Partial adds are disabled in Settings → Inventory, so the full quantity is required.
            </p>
          )}
        </div>
        <div className="px-5 py-4 border-t border-border flex gap-2">
          <button onClick={onCancel} className="flex-1 px-4 py-2.5 border border-border rounded-lg text-sm font-medium hover:bg-muted transition">
            Cancel
          </button>
          {allowPartial && partial > 0 && (
            <button
              onClick={() => onAddPartial(partial)}
              className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition"
            >
              Add Available {partial}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
