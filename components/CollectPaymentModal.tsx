'use client';

import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/format';
import { toast } from '@/hooks/use-toast';
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
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string>('');
  const [loadingInvoices, setLoadingInvoices] = useState(false);
  const [paymentMethods, setPaymentMethods] = useState<{ code: string; name: string }[]>([]);
  const [cashBankAccounts, setCashBankAccounts] = useState<{ id: string; code: string; name: string }[]>([]);

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
          if (invs.length > 0) {
            setSelectedInvoiceId(invs[0].id);
            setForm(f => ({ ...f, amount: Number(invs[0].balance_due) || 0 }));
          }
          setLoadingInvoices(false);
        });
    } else if (activeTab === 'manual') {
      setForm(f => ({ ...f, amount: manualOutstanding }));
    }
  }, [activeTab, customerId, invoiceOutstanding, manualOutstanding]);

  const selectedInvoice = invoices.find(i => i.id === selectedInvoiceId);
  const currentBalance = activeTab === 'invoice' ? (selectedInvoice?.balance_due || 0) : manualOutstanding;
  const remainingAfter = currentBalance - form.amount - form.bad_debt_amount;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (form.amount <= 0 && form.bad_debt_amount <= 0) {
      setError('Payment amount or bad debt amount must be greater than 0');
      return;
    }
    if (form.amount + form.bad_debt_amount > currentBalance + 0.01) {
      setError(`Amount + bad debt cannot exceed outstanding balance (${formatCurrency(currentBalance)})`);
      return;
    }
    if (form.amount > 0 && !form.account_id) {
      setError('Please select a cash/bank account to receive payment into');
      return;
    }

    setSaving(true);
    try {
      if (activeTab === 'invoice') {
        await processInvoicePayment();
      } else {
        await processManualPayment();
      }
    } catch (err: any) {
      setError(err.message || 'Failed to process payment');
    } finally {
      setSaving(false);
    }
  }

  async function processInvoicePayment() {
    if (!selectedInvoice) throw new Error('No invoice selected');

    const { data: payNum } = await supabase.rpc('generate_payment_number');
    const paymentNumber = payNum || `PAY-${Date.now().toString().slice(-6)}`;

    const { error: payError } = await supabase.from('payments').insert({
      payment_number: paymentNumber,
      payment_type: 'received',
      reference_type: 'invoice',
      reference_id: selectedInvoice.id,
      customer_id: customerId,
      amount: form.amount,
      bad_debt_amount: form.bad_debt_amount,
      payment_method: form.payment_method,
      payment_date: form.payment_date,
      reference_number: form.reference_number || null,
      notes: form.notes || null,
      payment_for: form.payment_for,
    });
    if (payError) throw payError;

    const newAmountPaid = Number(selectedInvoice.amount_paid) + form.amount;
    const newBadDebt = form.bad_debt_amount;
    const newBalance = Number(selectedInvoice.total_amount) - newAmountPaid - newBadDebt;
    const newStatus = newBalance <= 0.01 ? 'paid' : 'partially_paid';

    const { error: invError } = await supabase
      .from('invoices')
      .update({
        amount_paid: newAmountPaid,
        bad_debt_amount: newBadDebt,
        status: newStatus,
        updated_at: new Date().toISOString(),
      })
      .eq('id', selectedInvoice.id);
    if (invError) throw invError;

    // Database triggers handle: payment JE (Cash→AR), bad debt JE (5600→AR),
    // and customer outstanding balance recalculation automatically.

    const descParts = [`Payment of ${formatCurrency(form.amount)} recorded`];
    if (form.bad_debt_amount > 0) descParts.push(`bad debt write-off of ${formatCurrency(form.bad_debt_amount)}`);
    toast({ title: 'Success', description: descParts.join(', ') });
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

    // Update customer outstanding balance for manual receivables
    // (the DB trigger only recalculates for invoice payments, not receivable type)
    await updateCustomerOutstanding(customerId, form.amount + form.bad_debt_amount, form.amount);

    const descParts = [`Manual payment of ${formatCurrency(form.amount)} recorded`];
    if (form.bad_debt_amount > 0) descParts.push(`bad debt write-off of ${formatCurrency(form.bad_debt_amount)}`);
    toast({ title: 'Success', description: descParts.join(', ') });
    onSaved();
    onClose();
  }

  async function updateCustomerOutstanding(custId: string, reduction: number, purchasesIncrease: number) {
    const { data: customer } = await supabase.from('customers').select('outstanding_balance, total_purchases').eq('id', custId).single();
    if (customer) {
      await supabase.from('customers').update({
        outstanding_balance: Math.max(0, (customer.outstanding_balance || 0) - reduction),
        total_purchases: (customer.total_purchases || 0) + purchasesIncrease,
        updated_at: new Date().toISOString(),
      }).eq('id', custId);
    }
  }

  const noOutstanding = totalOutstanding <= 0;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl max-h-[90vh] overflow-y-auto">
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

            {/* Invoice selector */}
            {activeTab === 'invoice' && invoices.length > 1 && (
              <div>
                <label className="block text-xs font-medium mb-1">Select Invoice *</label>
                {loadingInvoices ? (
                  <div className="h-8 bg-muted rounded animate-pulse" />
                ) : (
                  <select
                    value={selectedInvoiceId}
                    onChange={e => {
                      setSelectedInvoiceId(e.target.value);
                      const inv = invoices.find(i => i.id === e.target.value);
                      if (inv) setForm(f => ({ ...f, amount: Number(inv.balance_due) || 0, bad_debt_amount: 0 }));
                    }}
                    className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none"
                  >
                    {invoices.map(i => (
                      <option key={i.id} value={i.id}>{i.invoice_number} - Due: {formatCurrency(Number(i.balance_due))}</option>
                    ))}
                  </select>
                )}
              </div>
            )}

            {/* Current balance */}
            <div className="bg-muted/30 rounded-lg p-2.5 flex justify-between items-center">
              <span className="text-xs text-muted-foreground">{activeTab === 'invoice' ? 'Invoice Balance' : 'Manual Outstanding'}</span>
              <span className="text-sm font-bold text-red-600">{formatCurrency(currentBalance)}</span>
            </div>

            {/* Amount + Bad Debt */}
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
                    {formatCurrency(form.bad_debt_amount)} will be written off as bad debt to the Bad Debt Expense account (5600). Outstanding will be reduced to {formatCurrency(Math.max(0, remainingAfter))}.
                  </p>
                </div>
              </div>
            )}

            {remainingAfter <= 0.01 && (form.amount > 0 || form.bad_debt_amount > 0) && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-2.5 flex justify-between items-center">
                <span className="text-xs text-green-700">{activeTab === 'invoice' ? 'Invoice' : 'Receivable'} will be fully settled</span>
                <CheckCircle2 className="w-4 h-4 text-green-600" />
              </div>
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
