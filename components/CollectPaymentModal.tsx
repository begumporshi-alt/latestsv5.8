'use client';

import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/format';
import { toast } from '@/hooks/use-toast';
import { networkMonitor } from '@/lib/offline/network';
import { enqueueOp } from '@/lib/offline/outbox';
import { X, HandCoins, CircleCheck as CheckCircle2, TriangleAlert as AlertTriangle } from 'lucide-react';
import type { PaymentMethod } from '@/lib/types';

interface InvoiceOutstanding {
  id: string;
  invoice_number: string;
  balance_due: number;
  total_amount: number;
  amount_paid: number;
}

interface CollectPaymentModalProps {
  customerId: string;
  customerName: string;
  totalOutstanding: number;
  invoiceOutstanding: number;
  manualOutstanding: number;
  onClose: () => void;
  onSaved: () => void;
}

export default function CollectPaymentModal({
  customerId,
  customerName,
  totalOutstanding,
  invoiceOutstanding,
  manualOutstanding,
  onClose,
  onSaved,
}: CollectPaymentModalProps) {
  const [activeTab, setActiveTab] = useState<'invoice' | 'manual'>(invoiceOutstanding > 0 ? 'invoice' : 'manual');
  const [invoices, setInvoices] = useState<InvoiceOutstanding[]>([]);
  const [loadingInvoices, setLoadingInvoices] = useState(false);
  const [paymentMethods, setPaymentMethods] = useState<{ code: string; name: string }[]>([]);
  const [cashBankAccounts, setCashBankAccounts] = useState<{ id: string; code: string; name: string }[]>([]);

  // ── Multi-invoice allocation (invoice tab) ──────────────────────────────
  // One "Amount Received" is split across all due invoices, oldest first by
  // default; each row stays editable. Overpayment is either blocked or routed
  // to the customer's advance balance — the collector's choice.
  const [totalReceived, setTotalReceived] = useState(0);
  const [allocations, setAllocations] = useState<Record<string, number>>({});
  const [overpaymentMode, setOverpaymentMode] = useState<'block' | 'advance'>('block');

  const [form, setForm] = useState({
    amount: 0,
    bad_debt_amount: 0,
    payment_method: 'cash' as PaymentMethod,
    payment_date: new Date().toISOString().split('T')[0],
    reference_number: '',
    notes: '',
    account_id: '',
    payment_for: 'outstanding_invoice_pay' as string,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    supabase.from('payment_methods').select('code, name').eq('is_active', true).order('sort_order')
      .then(({ data }) => { if (data && data.length > 0) setPaymentMethods(data); });
    supabase.from('accounts').select('id, code, name').eq('is_active', true).or('is_cash.eq.true,is_bank.eq.true')
      .then(({ data }) => { if (data) setCashBankAccounts(data); });
  }, []);

  useEffect(() => {
    if (activeTab === 'invoice' && invoiceOutstanding > 0) {
      setLoadingInvoices(true);
      supabase.from('invoices')
        .select('id, invoice_number, balance_due, total_amount, amount_paid')
        .eq('customer_id', customerId)
        .in('status', ['sent', 'partially_paid'])
        .order('invoice_date', { ascending: true })
        .then(({ data }) => {
          const invs = (data || []) as InvoiceOutstanding[];
          setInvoices(invs);
          setAllocations({});
          setTotalReceived(0);
          setLoadingInvoices(false);
        });
    } else if (activeTab === 'manual') {
      setForm(f => ({ ...f, amount: manualOutstanding }));
    }
  }, [activeTab, customerId, invoiceOutstanding, manualOutstanding]);

  // FIFO auto-allocation: oldest due invoice is cleared first.
  function autoAllocate(total: number) {
    const next: Record<string, number> = {};
    let remaining = total;
    for (const inv of invoices) {
      if (remaining <= 0.005) break;
      const due = Number(inv.balance_due) || 0;
      const take = Math.min(due, remaining);
      if (take > 0.005) next[inv.id] = Math.round(take * 100) / 100;
      remaining -= take;
    }
    setAllocations(next);
  }

  const sumAllocated = invoices.reduce((s, i) => s + (allocations[i.id] || 0), 0);
  const overpayment = Math.max(0, Math.round((totalReceived - sumAllocated) * 100) / 100);
  const allocatedTooMuch = totalReceived - sumAllocated < -0.005;

  // Manual-tab balance (single receivable pool).
  const currentBalance = manualOutstanding;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (activeTab === 'invoice') {
      if (totalReceived <= 0 && sumAllocated <= 0 && (form.bad_debt_amount || 0) <= 0) {
        setError('Enter the amount received (or allocate per invoice)');
        return;
      }
      if (allocatedTooMuch) {
        setError('Allocations exceed the amount received — reduce an allocation or the total');
        return;
      }
      const overAlloc = invoices.find(i => (allocations[i.id] || 0) > (Number(i.balance_due) || 0) + 0.01);
      if (overAlloc) {
        setError(`Allocation on ${overAlloc.invoice_number} exceeds its balance due`);
        return;
      }
      if (overpayment > 0 && overpaymentMode === 'block') {
        setError(`${formatCurrency(overpayment)} is not allocated — allocate it to an invoice or choose "Add to customer advance"`);
        return;
      }
    } else {
      if (form.amount <= 0 && form.bad_debt_amount <= 0) {
        setError('Payment amount or bad debt amount must be greater than 0');
        return;
      }
      if (form.amount + form.bad_debt_amount > currentBalance + 0.01) {
        setError(`Amount + bad debt cannot exceed outstanding balance (${formatCurrency(currentBalance)})`);
        return;
      }
    }
    if ((activeTab === 'invoice' ? totalReceived : form.amount) > 0 && !form.account_id) {
      setError('Please select a cash/bank account to receive payment into');
      return;
    }

    setSaving(true);
    try {
      if (activeTab === 'invoice') {
        await processMultiInvoicePayment();
      } else {
        await processManualPayment();
      }
    } catch (err: any) {
      setError(err.message || 'Failed to process payment');
    } finally {
      setSaving(false);
    }
  }

  async function processMultiInvoicePayment() {
    // Build the allocation payload. The global bad-debt figure is distributed
    // FIFO across the invoices, capped at each invoice's remaining balance.
    const allocRows: { invoice_id: string; amount: number; bad_debt_amount: number }[] = [];
    let badRemaining = form.bad_debt_amount || 0;
    for (const inv of invoices) {
      const amount = Math.round((allocations[inv.id] || 0) * 100) / 100;
      const freeBalance = (Number(inv.balance_due) || 0) - amount;
      const bad = Math.max(0, Math.min(badRemaining, freeBalance));
      if (amount <= 0 && bad <= 0) continue;
      allocRows.push({ invoice_id: inv.id, amount, bad_debt_amount: Math.round(bad * 100) / 100 });
      badRemaining -= bad;
    }
    if (allocRows.length === 0) throw new Error('Nothing to collect — allocate at least one invoice');

    if (!networkMonitor.getState().online) {
      // Offline: one payment.create op per allocated invoice (the existing
      // sync_payment_create re-validates against the live balance at replay
      // time), plus an advance.receive op when the overpayment is routed.
      for (const row of allocRows) {
        const inv = invoices.find(i => i.id === row.invoice_id)!;
        await enqueueOp('payment.create', {
          idempotency_key: crypto.randomUUID(),
          invoice_id: row.invoice_id,
          customer_id: customerId,
          amount: row.amount,
          bad_debt_amount: row.bad_debt_amount,
          payment_method: form.payment_method,
          payment_date: form.payment_date,
          reference_number: form.reference_number || null,
          notes: form.notes || null,
        }, `Payment ${formatCurrency(row.amount)} — ${inv.invoice_number}`);
      }
      if (overpayment > 0 && overpaymentMode === 'advance') {
        await enqueueOp('advance.receive', {
          idempotency_key: crypto.randomUUID(),
          customer_id: customerId,
          amount: overpayment,
          payment_method: form.payment_method,
          payment_date: form.payment_date,
          reference_number: form.reference_number || null,
          notes: `Overpayment from multi-invoice collection. ${form.notes || ''}`.trim(),
        }, `Advance ${formatCurrency(overpayment)} — ${customerName}`);
      }
      toast({
        title: 'Collection queued offline',
        description: `${allocRows.length} invoice payment${allocRows.length === 1 ? '' : 's'}${overpayment > 0 && overpaymentMode === 'advance' ? ' + advance' : ''} will post when you reconnect.`,
      });
      onSaved();
      onClose();
      return;
    }

    const { data, error: rpcError } = await supabase.rpc('collect_customer_payment', {
      p_customer_id: customerId,
      p_payment_date: form.payment_date,
      p_payment_method: form.payment_method,
      p_reference_number: form.reference_number || null,
      p_notes: form.notes || null,
      p_allocations: allocRows,
      p_overpayment: overpayment,
      p_route_overpayment: overpaymentMode === 'advance',
    });
    if (rpcError) throw rpcError;

    const parts = [`${allocRows.length} invoice${allocRows.length === 1 ? '' : 's'} collected`];
    if (overpayment > 0 && overpaymentMode === 'advance') parts.push(`${formatCurrency(overpayment)} added to advance`);
    if ((form.bad_debt_amount || 0) > 0) parts.push(`bad debt ${formatCurrency(form.bad_debt_amount)}`);
    toast({ title: 'Success', description: parts.join(' · ') });
    onSaved();
    onClose();
  }

  async function processManualPayment() {
    // Find the manual receivable journal entry for this customer with outstanding
    const { data: receivableEntries } = await supabase.from('journal_entries')
      .select('id, entry_number, entry_date, description, total_debit')
      .eq('is_posted', true)
      .eq('reference_type', 'receivable')
      .eq('customer_id', customerId)
      .order('entry_date', { ascending: true });

    if (!receivableEntries || receivableEntries.length === 0) {
      throw new Error('No manual receivables found for this customer');
    }

    // Find outstanding receivables and apply payment to them
    const { data: receivablePayments } = await supabase.from('payments')
      .select('reference_id, amount, bad_debt_amount')
      .eq('reference_type', 'receivable')
      .in('reference_id', receivableEntries.map(e => e.id));

    const paymentsMap = new Map<string, number>();
    (receivablePayments || []).forEach((p: any) => {
      const total = Number(p.amount) + Number(p.bad_debt_amount || 0);
      paymentsMap.set(p.reference_id, (paymentsMap.get(p.reference_id) || 0) + total);
    });

    const outstandingEntries = receivableEntries
      .map(e => ({ ...e, outstanding: Number(e.total_debit) - (paymentsMap.get(e.id) || 0) }))
      .filter(e => e.outstanding > 0.01);

    if (outstandingEntries.length === 0) {
      throw new Error('No outstanding manual receivables found for this customer');
    }

    let amountRemaining = form.amount;
    let badDebtRemaining = form.bad_debt_amount;

    for (const entry of outstandingEntries) {
      if (amountRemaining <= 0.01 && badDebtRemaining <= 0.01) break;

      const payForThis = Math.min(amountRemaining, entry.outstanding);
      const badDebtForThis = Math.min(badDebtRemaining, entry.outstanding - payForThis);

      if (payForThis > 0 || badDebtForThis > 0) {
        const { data: payNum } = await supabase.rpc('generate_payment_number');
        const { data: payRow, error: payError } = await supabase.from('payments').insert({
          payment_number: payNum || `PAY-${Date.now().toString().slice(-6)}`,
          payment_type: 'received',
          reference_type: 'receivable',
          reference_id: entry.id,
          customer_id: customerId,
          amount: payForThis,
          bad_debt_amount: badDebtForThis,
          payment_method: form.payment_method,
          payment_date: form.payment_date,
          reference_number: form.reference_number || null,
          notes: form.notes || null,
          payment_for: form.payment_for,
        }).select().single();
        if (payError) throw payError;

        const { data: manualReceivableAccount } = await supabase.from('accounts').select('id').eq('code', '1300').maybeSingle();
        if (!manualReceivableAccount) {
          await supabase.from('payments').delete().eq('id', payRow.id);
          throw new Error('Manual Receivable account (1300) not found');
        }

        try {
          // Journal entries go through the post_journal_entry RPC: entry
          // number, lines and account balances are handled atomically
          // server-side, and the JE references the payment row. (On
          // 2026-09-02 a client-side posting failed silently after the
          // payment insert and left 1300 overstated by the unjournaled
          // collection.)
          if (payForThis > 0) {
            const { error: jeError } = await supabase.rpc('post_journal_entry', {
              p_description: `Payment received for ${entry.entry_number}`,
              p_entry_date: form.payment_date,
              p_reference_type: 'payment',
              p_reference_id: payRow.id,
              p_lines: [
                { account_id: form.account_id, debit: payForThis, credit: 0, description: `Payment from ${customerName}` },
                { account_id: manualReceivableAccount.id, debit: 0, credit: payForThis, description: `Manual Receivable reduction - ${customerName}` },
              ],
              p_customer_id: customerId,
            });
            if (jeError) throw jeError;
          }

          if (badDebtForThis > 0) {
            const { data: badDebtAccount } = await supabase.from('accounts').select('id').eq('code', '5600').maybeSingle();
            const { error: bdError } = await supabase.rpc('post_journal_entry', {
              p_description: `Bad debt write-off for ${entry.entry_number}`,
              p_entry_date: form.payment_date,
              p_reference_type: 'payment',
              p_reference_id: payRow.id,
              p_lines: [
                { account_id: badDebtAccount?.id, debit: badDebtForThis, credit: 0, description: `Bad debt write-off - ${customerName}` },
                { account_id: manualReceivableAccount.id, debit: 0, credit: badDebtForThis, description: `Manual Receivable reduction (bad debt) - ${customerName}` },
              ],
              p_customer_id: customerId,
            });
            if (bdError) {
              // Keep the (consistent) payment leg; drop the unposted bad-debt
              // amount from the row so the subledger doesn't count it.
              await supabase.from('payments').update({ bad_debt_amount: 0 }).eq('id', payRow.id);
              throw bdError;
            }
          }
        } catch (e) {
          // No payment row without its journal entry — remove the row so a
          // retry starts clean.
          await supabase.from('payments').delete().eq('id', payRow.id);
          throw e;
        }
      }

      amountRemaining -= payForThis;
      badDebtRemaining -= badDebtForThis;
    }

    const descParts = [`Manual payment of ${formatCurrency(form.amount)} recorded`];
    if (form.bad_debt_amount > 0) descParts.push(`bad debt write-off of ${formatCurrency(form.bad_debt_amount)}`);
    toast({ title: 'Success', description: descParts.join(', ') });
    onSaved();
    onClose();
  }

  const noOutstanding = totalOutstanding <= 0;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-2xl shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-white rounded-t-2xl z-10">
          <h2 className="text-base font-bold flex items-center gap-2">
            <HandCoins className="w-4 h-4 text-green-600" />
            Collect Payment
          </h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>

        {noOutstanding ? (
          <div className="p-8 text-center">
            <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <CheckCircle2 className="w-6 h-6 text-green-600" />
            </div>
            <p className="text-sm font-semibold mb-1">No Outstanding Balance</p>
            <p className="text-xs text-muted-foreground">{customerName} has no outstanding balance to collect.</p>
            <button onClick={onClose} className="mt-6 px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Close</button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            {error && <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>}

            {/* Customer info */}
            <div className="bg-muted/30 rounded-lg p-3 space-y-1">
              <div className="flex justify-between text-xs"><span className="text-muted-foreground">Customer:</span><span className="font-medium">{customerName}</span></div>
              <div className="flex justify-between text-xs"><span className="text-muted-foreground">Total Outstanding:</span><span className="font-bold text-red-600">{formatCurrency(totalOutstanding)}</span></div>
            </div>

            {/* Tab selector */}
            {invoiceOutstanding > 0 && manualOutstanding > 0 && (
              <div className="flex gap-2 bg-muted/20 p-1 rounded-lg">
                <button
                  type="button"
                  onClick={() => setActiveTab('invoice')}
                  className={`flex-1 px-3 py-2 rounded-md text-xs font-medium transition ${activeTab === 'invoice' ? 'bg-white shadow-sm text-blue-600' : 'text-muted-foreground'}`}
                >
                  Invoice Due ({formatCurrency(invoiceOutstanding)})
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('manual')}
                  className={`flex-1 px-3 py-2 rounded-md text-xs font-medium transition ${activeTab === 'manual' ? 'bg-white shadow-sm text-purple-600' : 'text-muted-foreground'}`}
                >
                  Manual Due ({formatCurrency(manualOutstanding)})
                </button>
              </div>
            )}

            {/* Multi-invoice allocation */}
            {activeTab === 'invoice' && (
              <div>
                <label className="block text-xs font-medium mb-1">Amount Received *</label>
                <input
                  type="number" min="0" step="0.01"
                  value={totalReceived || ''}
                  onChange={e => {
                    const total = parseFloat(e.target.value) || 0;
                    setTotalReceived(total);
                    autoAllocate(total);
                  }}
                  className="w-full border border-border rounded-lg px-3 py-2.5 text-base font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
                {invoices.length > 1 && (
                  <p className="text-[10px] text-muted-foreground mt-1">Auto-allocated oldest due first — edit any row below to change the split.</p>
                )}
                <div className="border border-border rounded-lg overflow-hidden mt-2">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/40">
                      <tr>
                        <th className="text-left text-xs font-semibold text-muted-foreground px-3 py-2">Invoice</th>
                        <th className="text-right text-xs font-semibold text-muted-foreground px-3 py-2 w-24">Due</th>
                        <th className="text-right text-xs font-semibold text-muted-foreground px-3 py-2 w-28">Allocate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {loadingInvoices ? (
                        <tr><td colSpan={3} className="px-3 py-4 text-center text-xs text-muted-foreground animate-pulse">Loading invoices...</td></tr>
                      ) : invoices.map(inv => (
                        <tr key={inv.id} className="border-t border-border">
                          <td className="px-3 py-2 font-medium">{inv.invoice_number}</td>
                          <td className="text-right px-3 py-2 text-red-600">{formatCurrency(Number(inv.balance_due))}</td>
                          <td className="px-3 py-2">
                            <input
                              type="number" min="0" max={Number(inv.balance_due)} step="0.01"
                              value={allocations[inv.id] ?? ''}
                              onChange={e => {
                                const v = Math.min(parseFloat(e.target.value) || 0, Number(inv.balance_due));
                                setAllocations(a => ({ ...a, [inv.id]: v }));
                              }}
                              placeholder="0"
                              className="w-full border border-border rounded-md px-2 py-1 text-right text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Bad debt (shared across tabs) */}
            <div>
              <label className="block text-xs font-medium mb-1 flex items-center gap-1">
                Bad Debt
                <span className="text-[10px] text-muted-foreground font-normal">(won&apos;t pay — written off, applied oldest first)</span>
              </label>
              <input
                type="number" min="0" step="0.01"
                value={form.bad_debt_amount || ''}
                onChange={e => setForm({ ...form, bad_debt_amount: parseFloat(e.target.value) || 0 })}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500/20"
              />
            </div>

            {/* Totals + overpayment (invoice tab) */}
            {activeTab === 'invoice' && (
              <>
                <div className="bg-muted/30 rounded-lg p-3 space-y-1.5 text-xs">
                  <div className="flex justify-between"><span className="text-muted-foreground">Amount received:</span><span className="font-semibold">{formatCurrency(totalReceived)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Allocated to invoices:</span><span className="font-semibold">{formatCurrency(sumAllocated)}</span></div>
                  {(form.bad_debt_amount || 0) > 0 && (
                    <div className="flex justify-between"><span className="text-muted-foreground">Bad debt write-off:</span><span className="font-semibold text-orange-600">{formatCurrency(form.bad_debt_amount)}</span></div>
                  )}
                  <div className="flex justify-between border-t border-border pt-1.5">
                    <span className="text-muted-foreground">{overpayment > 0 ? 'Overpayment:' : 'Unallocated:'}</span>
                    <span className={`font-bold ${overpayment > 0 ? 'text-green-600' : allocatedTooMuch ? 'text-red-600' : ''}`}>{formatCurrency(overpayment)}</span>
                  </div>
                </div>

                {allocatedTooMuch && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-2.5 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
                    <p className="text-[11px] text-red-700">Allocations exceed the amount received. Reduce an allocation or the total.</p>
                  </div>
                )}

                {overpayment > 0 && (
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 space-y-2">
                    <p className="text-xs font-medium text-blue-700 flex items-center gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      {formatCurrency(overpayment)} is more than the allocated dues — what should happen to it?
                    </p>
                    <div className="grid grid-cols-1 gap-1.5">
                      <label className="flex items-start gap-2 text-xs cursor-pointer">
                        <input type="radio" name="overpayment" checked={overpaymentMode === 'advance'} onChange={() => setOverpaymentMode('advance')} className="mt-0.5 accent-blue-600" />
                        <span><span className="font-medium">Add to customer advance</span> — credit kept on the customer&apos;s account for future invoices.</span>
                      </label>
                      <label className="flex items-start gap-2 text-xs cursor-pointer">
                        <input type="radio" name="overpayment" checked={overpaymentMode === 'block'} onChange={() => setOverpaymentMode('block')} className="mt-0.5 accent-blue-600" />
                        <span><span className="font-medium">Block</span> — I&apos;ll allocate the full amount to invoices myself.</span>
                      </label>
                    </div>
                  </div>
                )}
              </>
            )}

            {/* Manual tab: single pool */}
            {activeTab === 'manual' && (
              <>
                <div className="bg-muted/30 rounded-lg p-2.5 flex justify-between items-center">
                  <span className="text-xs text-muted-foreground">Manual Outstanding</span>
                  <span className="text-sm font-bold text-red-600">{formatCurrency(currentBalance)}</span>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium mb-1">Payment Amount *</label>
                    <input
                      type="number" min="0" max={currentBalance} step="0.01"
                      value={form.amount}
                      onChange={e => setForm({ ...form, amount: parseFloat(e.target.value) || 0 })}
                      className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1 flex items-center gap-1">
                      Bad Debt
                      <span className="text-[10px] text-muted-foreground font-normal">(won&apos;t pay)</span>
                    </label>
                    <input
                      type="number" min="0" max={currentBalance} step="0.01"
                      value={form.bad_debt_amount}
                      onChange={e => setForm({ ...form, bad_debt_amount: parseFloat(e.target.value) || 0 })}
                      className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500/20"
                    />
                  </div>
                </div>

                {form.bad_debt_amount > 0 && (
                  <div className="bg-orange-50 border border-orange-200 rounded-lg p-2.5">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-orange-500 mt-0.5 shrink-0" />
                      <p className="text-[11px] text-orange-700">
                        {formatCurrency(form.bad_debt_amount)} will be written off as bad debt to the Bad Debt Expense account (5600). Outstanding will be reduced to {formatCurrency(Math.max(0, currentBalance - form.amount - form.bad_debt_amount))}.
                      </p>
                    </div>
                  </div>
                )}

                {currentBalance - form.amount - form.bad_debt_amount <= 0.01 && (form.amount > 0 || form.bad_debt_amount > 0) && (
                  <div className="bg-green-50 border border-green-200 rounded-lg p-2.5 flex justify-between items-center">
                    <span className="text-xs text-green-700">Receivable will be fully settled</span>
                    <CheckCircle2 className="w-4 h-4 text-green-600" />
                  </div>
                )}
              </>
            )}

            {/* Payment method + account */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium mb-1">Method *</label>
                <select
                  value={form.payment_method}
                  onChange={e => setForm({ ...form, payment_method: e.target.value as PaymentMethod })}
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none"
                >
                  {paymentMethods.length > 0 ? (
                    paymentMethods.map(pm => <option key={pm.code} value={pm.code}>{pm.name}</option>)
                  ) : (
                    <>
                      <option value="cash">Cash</option>
                      <option value="bank_transfer">Bank Transfer</option>
                      <option value="card">Card</option>
                      <option value="cheque">Cheque</option>
                    </>
                  )}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Receive Into *</label>
                <select
                  required
                  value={form.account_id}
                  onChange={e => setForm({ ...form, account_id: e.target.value })}
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none"
                >
                  <option value="">Select account</option>
                  {cashBankAccounts.map(a => <option key={a.id} value={a.id}>{a.code} - {a.name}</option>)}
                </select>
              </div>
            </div>

            {/* Payment For */}
            <div>
              <label className="block text-xs font-medium mb-1">Payment For</label>
              <select
                value={form.payment_for}
                onChange={e => setForm({ ...form, payment_for: e.target.value })}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              >
                <option value="outstanding_invoice_pay">Outstanding Invoice Payment</option>
                <option value="paid_invoice_pay">Paid Invoice Payment</option>
                <option value="advance">Customer Advance</option>
                <option value="manual_receivable">Manual Receivable</option>
                <option value="other">Other</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">Date</label>
              <input
                type="date"
                value={form.payment_date}
                onChange={e => setForm({ ...form, payment_date: e.target.value })}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">Reference / Notes</label>
              <input
                value={form.reference_number}
                onChange={e => setForm({ ...form, reference_number: e.target.value })}
                placeholder="Cheque no., Transaction ID..."
                className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
            </div>

            <div className="flex gap-3 pt-2">
              <button type="button" onClick={onClose} className="flex-1 px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Cancel</button>
              <button
                type="submit"
                disabled={saving}
                className="flex-1 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-60"
              >
                {saving ? 'Processing...' : 'Record Payment'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
