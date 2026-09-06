'use client';

// Warn-and-confirm dialog for selling a customer past their credit limit.
// Extracted alongside the oversell gate so POS and the invoice modal show
// the exact same warning. Warn-only: confirming proceeds with the sale.

import { TriangleAlert as AlertTriangle } from 'lucide-react';
import { formatCurrency } from '@/lib/format';
import type { CreditCheck } from '@/lib/credit-gate';

export function CreditConfirmDialog({
  check,
  confirmLabel = 'Sell anyway',
  onConfirm,
  onGoBack,
}: {
  check: CreditCheck;
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
            <h3 className="text-base font-bold text-foreground">Credit limit exceeded</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              This sale pushes the customer past their credit limit. Continuing is allowed — collect soon or raise the limit.
            </p>
          </div>
        </div>
        <div className="px-5 py-4 space-y-1.5 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Credit limit</span><span className="font-semibold text-foreground">{formatCurrency(check.limit)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Outstanding before sale</span><span className="font-semibold text-foreground">{formatCurrency(check.outstanding)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">New credit from this sale</span><span className="font-semibold text-foreground">{formatCurrency(check.newReceivable)}</span></div>
          <div className="flex justify-between border-t border-border pt-1.5 mt-1.5"><span className="text-muted-foreground">Total after sale</span><span className="font-bold text-amber-700">{formatCurrency(check.afterSale)}</span></div>
          <div className="border border-amber-200 bg-amber-50/60 rounded-lg px-3 py-2 mt-2">
            <p className="text-xs text-amber-700">
              Over the limit by <b>{formatCurrency(check.shortfall)}</b>.
            </p>
          </div>
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
