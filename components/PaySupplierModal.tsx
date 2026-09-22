'use client';

import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/format';
import { toast } from '@/hooks/use-toast';
import { networkMonitor } from '@/lib/offline/network';
import { enqueueOp } from '@/lib/offline/outbox';
import { X, HandCoins, CircleCheck as CheckCircle2, TriangleAlert as AlertTriangle } from 'lucide-react';

interface DuePO {
  id: string;
  po_number: string;
  total_amount: number;
  amount_paid: number;
}

interface PaySupplierModalProps {
  supplierId: string;
  supplierName: string;
  totalOutstanding: number;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Multi-PO payment collector — the supplier mirror of CollectPaymentModal.
 * One "Amount Paid" is auto-allocated FIFO (oldest received PO first); rows
 * stay editable and are capped at each PO's live balance. A global
 * withholding figure is distributed FIFO and capped per row (WHT < amount).
 *
 * Overpayment is intentionally blocked: supplier advances have no dedicated
 * ledger (they display as a negative outstanding balance), so the caller must
 * allocate the full paid amount.
 *
 * Online  → pay_supplier_outstanding RPC (one atomic transaction; the
 *           existing triggers post the AP/WHT journals and bump PO amount_paid).
 * Offline → one existing po.payment op per allocated PO (sync_po_payment
 *           re-validates against the live balance at replay).
 */
export default function PaySupplierModal({
  supplierId,
  supplierName,
  totalOutstanding,
  onClose,
  onSaved,
}: PaySupplierModalProps) {
  const [pos, setPos] = useState<DuePO[]>([]);
  const [loadingPos, setLoadingPos] = useState(false);
  const [totalPaid, setTotalPaid] = useState(0);
  const [allocations, setAllocations] = useState<Record<string, number>>({});
  const [wht, setWht] = useState(0);
  const [paymentMethods, setPaymentMethods] = useState<{ code: string; name: string }[]>([]);
  const [paymentMethod, setPaymentMethod] = useState('bank_transfer');
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split('T')[0]);
  const [referenceNumber, setReferenceNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    supabase.from('payment_methods').select('code, name').eq('is_active', true).order('sort_order')
      .then(({ data }) => { if (data && data.length > 0) setPaymentMethods(data); });
    setLoadingPos(true);
    // Due POs: received (fully or partially) with a remaining balance, oldest first.
    supabase.from('purchase_orders')
      .select('id, po_number, total_amount, amount_paid, status')
      .eq('supplier_id', supplierId)
      .in('status', ['received', 'partially_received'])
      .order('order_date', { ascending: true })
      .then(({ data }) => {
        const due = ((data || []) as DuePO[])
          .filter(po => Number(po.total_amount) - Number(po.amount_paid) > 0.005);
        setPos(due);
        setLoadingPos(false);
      });
  }, [supplierId]);

  // FIFO auto-allocation: oldest received PO is cleared first.
  function autoAllocate(total: number) {
    const next: Record<string, number> = {};
    let remaining = total;
    for (const po of pos) {
      if (remaining <= 0.005) break;
      const due = (Number(po.total_amount) || 0) - (Number(po.amount_paid) || 0);
      const take = Math.min(due, remaining);
      if (take > 0.005) next[po.id] = Math.round(take * 100) / 100;
      remaining -= take;
    }
    setAllocations(next);
  }

  const sumAllocated = pos.reduce((s, po) => s + (allocations[po.id] || 0), 0);
  const cashOut = Math.max(0, Math.round((totalPaid - wht) * 100) / 100);
  const unallocated = Math.max(0, Math.round((totalPaid - sumAllocated) * 100) / 100);
  const allocatedTooMuch = totalPaid - sumAllocated < -0.005;
  const allocatedCount = Object.values(allocations).filter(v => v > 0).length;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (totalPaid <= 0 && sumAllocated <= 0) {
      setError('Enter the amount paid (or allocate per PO)');
      return;
    }
    if (allocatedTooMuch) {
      setError('Allocations exceed the amount paid — reduce an allocation or the total');
      return;
    }
    const overAlloc = pos.find(po => (allocations[po.id] || 0) > ((Number(po.total_amount) || 0) - (Number(po.amount_paid) || 0)) + 0.01);
    if (overAlloc) {
      setError(`Allocation on ${overAlloc.po_number} exceeds its balance due`);
      return;
    }
    if (wht < 0) { setError('Withholding cannot be negative'); return; }
    if (wht >= totalPaid && totalPaid > 0) {
      setError('Withholding must be less than the payment amount');
      return;
    }
    if (unallocated > 0.005) {
      setError(`${formatCurrency(unallocated)} is not allocated — allocate the full amount (supplier overpayments are not supported)`);
      return;
    }

    setSaving(true);
    try {
      // Build the payload; the global WHT is distributed FIFO across the POs,
      // capped at each row's allocation (wht < amount enforced).
      const allocRows: { po_id: string; amount: number; wht_amount: number }[] = [];
      let whtRemaining = wht || 0;
      for (const po of pos) {
        const amount = Math.round((allocations[po.id] || 0) * 100) / 100;
        if (amount <= 0) continue;
        const rowWht = Math.max(0, Math.min(whtRemaining, amount - 0.01));
        allocRows.push({ po_id: po.id, amount, wht_amount: Math.round(rowWht * 100) / 100 });
        whtRemaining -= rowWht;
      }
      if (allocRows.length === 0) throw new Error('Nothing to pay — allocate at least one purchase order');

      if (!networkMonitor.getState().online) {
        // Offline: one po.payment op per allocated PO — sync_po_payment
        // re-validates against the live balance at replay time.
        for (const row of allocRows) {
          const po = pos.find(x => x.id === row.po_id)!;
          await enqueueOp('po.payment', {
            idempotency_key: crypto.randomUUID(),
            po_id: row.po_id,
            supplier_id: supplierId,
            amount: row.amount,
            wht_amount: row.wht_amount,
            payment_method: paymentMethod,
            payment_date: paymentDate,
            reference_number: referenceNumber || null,
            notes: notes || null,
          }, `PO payment ${formatCurrency(row.amount)} — ${po.po_number}`);
        }
        toast({
          title: 'Payment queued offline',
          description: `${allocRows.length} PO payment${allocRows.length === 1 ? '' : 's'} will post when you reconnect.`,
        });
        onSaved();
        onClose();
        return;
      }

      const { data, error: rpcError } = await supabase.rpc('pay_supplier_outstanding', {
        p_supplier_id: supplierId,
        p_payment_date: paymentDate,
        p_payment_method: paymentMethod,
        p_reference_number: referenceNumber || null,
        p_notes: notes || null,
        p_allocations: allocRows,
      });
      if (rpcError) throw rpcError;

      const parts = [`${allocRows.length} PO${allocRows.length === 1 ? '' : 's'} paid`];
      if ((wht || 0) > 0) parts.push(`withheld ${formatCurrency(wht)} (WHT 2110)`);
      toast({ title: 'Success', description: parts.join(' · ') });
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to record payment');
    } finally {
      setSaving(false);
    }
  }

  const noOutstanding = totalOutstanding <= 0;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-2xl shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-white rounded-t-2xl z-10">
          <h2 className="text-base font-bold flex items-center gap-2">
            <HandCoins className="w-4 h-4 text-green-600" />
            Pay Supplier — {supplierName}
          </h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>

        {loadingPos && (
          <div className="p-8 text-center text-sm text-muted-foreground animate-pulse">Loading outstanding purchase orders…</div>
        )}

        {!loadingPos && pos.length === 0 && (
          <div className="p-8 text-center">
            <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <CheckCircle2 className="w-6 h-6 text-green-600" />
            </div>
            <p className="text-sm font-semibold mb-1">Nothing to pay</p>
            <p className="text-xs text-muted-foreground">All received purchase orders are fully paid, or no received POs exist for this supplier.</p>
            <button onClick={onClose} className="mt-6 px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Close</button>
          </div>
        )}

        {!loadingPos && pos.length > 0 && (
          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            {error && <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>}

            <div className="bg-muted/30 rounded-lg p-3 space-y-1">
              <div className="flex justify-between text-xs"><span className="text-muted-foreground">Supplier:</span><span className="font-medium">{supplierName}</span></div>
              <div className="flex justify-between text-xs"><span className="text-muted-foreground">Total Outstanding:</span><span className="font-bold text-red-600">{formatCurrency(totalOutstanding)}</span></div>
              <div className="flex justify-between text-xs"><span className="text-muted-foreground">Due POs:</span><span className="font-medium">{pos.length}</span></div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium mb-1">Amount Paid *</label>
                <input
                  type="number" min="0" step="0.01"
                  value={totalPaid || ''}
                  onChange={e => {
                    const total = parseFloat(e.target.value) || 0;
                    setTotalPaid(total);
                    autoAllocate(total);
                  }}
                  className="w-full border border-border rounded-lg px-3 py-2.5 text-base font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
                {pos.length > 1 && (
                  <p className="text-[10px] text-muted-foreground mt-1">Auto-allocated to the oldest received PO first — edit any row below to change the split.</p>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium mb-1 flex items-center gap-1" title="Tax deducted at source — posted to WHT Payable (2110), applied oldest PO first">
                  Withholding deducted
                  <span className="text-[10px] text-muted-foreground font-normal">(applied FIFO, capped per PO)</span>
                </label>
                <input
                  type="number" min="0" step="0.01"
                  value={wht || ''}
                  onChange={e => setWht(parseFloat(e.target.value) || 0)}
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500/20"
                />
                <p className="text-[10px] text-muted-foreground mt-1">Cash out: {formatCurrency(cashOut)}</p>
              </div>
            </div>

            {/* PO allocation table */}
            <div className="border border-border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/40">
                  <tr>
                    <th className="text-left text-xs font-semibold text-muted-foreground px-3 py-2">Purchase Order</th>
                    <th className="text-right text-xs font-semibold text-muted-foreground px-3 py-2 w-24">Due</th>
                    <th className="text-right text-xs font-semibold text-muted-foreground px-3 py-2 w-28">Allocate</th>
                  </tr>
                </thead>
                <tbody>
                  {pos.map(po => {
                    const due = (Number(po.total_amount) || 0) - (Number(po.amount_paid) || 0);
                    return (
                      <tr key={po.id} className="border-t border-border">
                        <td className="px-3 py-2 font-medium">{po.po_number}</td>
                        <td className="text-right px-3 py-2 text-red-600">{formatCurrency(due)}</td>
                        <td className="px-3 py-2">
                          <input
                            type="number" min="0" max={due} step="0.01"
                            value={allocations[po.id] ?? ''}
                            onChange={e => {
                              const v = Math.min(parseFloat(e.target.value) || 0, due);
                              setAllocations(a => ({ ...a, [po.id]: v }));
                            }}
                            placeholder="0"
                            className="w-full border border-border rounded-md px-2 py-1 text-right text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="bg-muted/30 rounded-lg p-3 space-y-1.5 text-xs">
              <div className="flex justify-between"><span className="text-muted-foreground">Allocated to POs:</span><span className="font-semibold">{formatCurrency(sumAllocated)}</span></div>
              {(wht || 0) > 0 && (
                <div className="flex justify-between"><span className="text-muted-foreground">Withholding (WHT 2110):</span><span className="font-semibold text-orange-600">{formatCurrency(wht)}</span></div>
              )}
              <div className="flex justify-between border-t border-border pt-1.5">
                <span className="text-muted-foreground">{unallocated > 0.005 ? 'Unallocated:' : 'Fully allocated'}</span>
                <span className={`font-bold ${unallocated > 0.005 ? 'text-orange-600' : 'text-green-600'}`}>{formatCurrency(unallocated)}</span>
              </div>
              {unallocated > 0.005 && (
                <p className="text-[10px] text-orange-700">Supplier overpayments are not supported — allocate the full amount to POs.</p>
              )}
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium mb-1">Method *</label>
                <select
                  value={paymentMethod}
                  onChange={e => setPaymentMethod(e.target.value)}
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none"
                >
                  {paymentMethods.length > 0 ? (
                    paymentMethods.map(pm => <option key={pm.code} value={pm.code}>{pm.name}</option>)
                  ) : (
                    <>
                      <option value="bank_transfer">Bank Transfer</option>
                      <option value="cash">Cash</option>
                      <option value="cheque">Cheque</option>
                      <option value="bkash">bKash</option>
                    </>
                  )}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Date</label>
                <input
                  type="date"
                  value={paymentDate}
                  onChange={e => setPaymentDate(e.target.value)}
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Reference Number</label>
                <input
                  value={referenceNumber}
                  onChange={e => setReferenceNumber(e.target.value)}
                  placeholder="Cheque / txn #"
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">Notes</label>
              <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 resize-y" />
            </div>

            <div className="flex gap-3 pt-2">
              <button type="button" onClick={onClose} className="flex-1 px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Cancel</button>
              <button
                type="submit"
                disabled={saving || allocatedCount === 0}
                className="flex-1 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-60"
              >
                {saving ? 'Processing...' : `Pay ${allocatedCount} PO${allocatedCount === 1 ? '' : 's'} — ${formatCurrency(cashOut)} cash`}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
