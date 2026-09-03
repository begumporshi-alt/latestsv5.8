'use client';

// Warn-and-confirm dialog for selling beyond the FIFO batch ledger.
// Extracted from the POS page so the invoice-creation modal and the
// quote→invoice conversion show the exact same warning.

import { TriangleAlert as AlertTriangle } from 'lucide-react';
import { formatCurrency } from '@/lib/format';

export interface ShortfallRow {
  name: string;
  sku: string;
  baseQty: number;
  ledgerQty: number;
  shortfall: number;
  costValue: number;
  bothEmpty: boolean;
}

export function OversellConfirmDialog({
  shortfalls,
  confirmLabel = 'Sell anyway',
  onConfirm,
  onGoBack,
}: {
  shortfalls: ShortfallRow[];
  confirmLabel?: string;
  onConfirm: () => void;
  onGoBack: () => void;
}) {
  // z-[120]: the POS checkout panels (z-100/z-110) stay open when the gate
  // fires from their Charge button — the dialog must layer above them.
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[120] p-4">
      <div className="bg-white rounded-xl w-full max-w-md shadow-2xl">
        <div className="flex items-start gap-3 px-5 py-4 border-b border-border">
          <div className="w-10 h-10 rounded-full bg-amber-50 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-5 h-5 text-amber-500" />
          </div>
          <div>
            <h3 className="text-base font-bold text-foreground">Sell beyond ledger stock?</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              The FIFO batch ledger holds less than this sale. Continuing creates a negative inventory layer (an IOU) that must be covered by receiving stock later.
            </p>
          </div>
        </div>
        <div className="px-5 py-4 max-h-[45vh] overflow-y-auto space-y-2">
          {shortfalls.map((s, i) => (
            <div key={i} className="flex items-center justify-between text-sm border border-amber-200 bg-amber-50/50 rounded-lg px-3 py-2">
              <div className="min-w-0">
                <p className="font-medium text-foreground truncate">{s.name}</p>
                <p className="text-xs text-muted-foreground">
                  Ledger: {s.ledgerQty} of {s.baseQty} — short <b className="text-amber-700">{s.shortfall}</b> units
                </p>
              </div>
              <span className="text-xs text-amber-700 font-semibold whitespace-nowrap ml-3">~{formatCurrency(s.costValue)}</span>
            </div>
          ))}
        </div>
        <div className="flex gap-2 px-5 py-4 border-t border-border">
          <button
            onClick={onGoBack}
            className="flex-1 py-2.5 px-4 rounded-lg border border-border text-sm font-medium text-foreground hover:bg-muted transition"
          >
            Go back
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 py-2.5 px-4 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold transition"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
