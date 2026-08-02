'use client';

import { useEffect, useState, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCurrency, formatDate } from '@/lib/format';
import { DollarSign, TrendingUp, TrendingDown, Filter, Search, ChevronLeft, ChevronRight, CircleArrowDown as ArrowDownCircle, CircleArrowUp as ArrowUpCircle, Receipt, CreditCard, Wallet, CircleCheck as CheckCircle2, Download } from 'lucide-react';
import Pagination from '@/components/ui/AppPagination';

type PeriodKey = 'today' | 'last7' | 'last30' | 'all' | 'custom';

const periodConfig: Record<PeriodKey, { label: string }> = {
  today: { label: 'Today' },
  last7: { label: 'Last 7 Days' },
  last30: { label: 'Last 30 Days' },
  all: { label: 'All Time' },
  custom: { label: 'Custom' },
};

const methodLabels: Record<string, string> = {
  store_credit: 'Store Credit',
  cash: 'Cash',
  bank_transfer: 'Bank Transfer',
  bkash: 'bKash',
  nagad: 'Nagad',
  rocket: 'Rocket',
  sslcommerz: 'SSLCommerz',
  cheque: 'Cheque',
  card: 'Card',
  other: 'Other',
};

function methodLabel(method: string): string {
  return methodLabels[method] || method || 'Unknown';
}

const paymentForLabels: Record<string, string> = {
  outstanding_invoice_pay: 'Outstanding Invoice Payment',
  paid_invoice_pay: 'Paid Invoice Payment',
  invoice_payment: 'Invoice Payment',
  reversal_payment: 'Reversal Payment',
  advance: 'Customer Advance',
  manual_receivable: 'Manual Receivable',
  supplier_payment: 'Supplier Payment',
  bad_debt: 'Bad Debt',
  other: 'Other',
};

function paymentForLabel(value: string | null): string {
  if (!value) return 'Uncategorized';
  return paymentForLabels[value] || value;
}

interface PaymentRecord {
  id: string;
  payment_number: string | null;
  payment_type: string;
  reference_type: string;
  reference_id: string | null;
  customer_id: string | null;
  amount: number;
  payment_method: string;
  payment_date: string;
  reference_number: string | null;
  notes: string | null;
  is_reversed: boolean;
  bad_debt_amount: number | null;
  payment_for: string | null;
  customer: { name: string } | null;
  invoice: { invoice_number: string } | null;
}

interface ReturnRecord {
  id: string;
  return_number: string;
  invoice_id: string;
  customer_id: string | null;
  total_refund_amount: number;
  refund_method: string;
  return_date: string;
  customer: { name: string } | null;
  invoice: { invoice_number: string } | null;
}

interface TimelineEvent {
  date: string;
  type: 'collection' | 'refund';
  description: string;
  reference: string;
  method: string;
  paymentFor: string | null;
  amount: number;
  runningNet: number;
}

const PAGE_SIZE = 25;

export default function CollectionReportPage() {
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<PeriodKey>('last30');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [returns, setReturns] = useState<ReturnRecord[]>([]);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [methodFilter, setMethodFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState<'all' | 'collection' | 'refund'>('all');
  const [paymentForFilter, setPaymentForFilter] = useState('all');

  function getPeriodRange(): { from: string; to: string } {
    if (period === 'custom') return { from: customFrom, to: customTo };
    if (period === 'all') return { from: '', to: '' };
    const today = new Date().toISOString().split('T')[0];
    if (period === 'today') return { from: today, to: today };
    const days = period === 'last7' ? 6 : 29;
    const start = new Date();
    start.setDate(start.getDate() - days);
    return { from: start.toISOString().split('T')[0], to: today };
  }

  useEffect(() => {
    if (period !== 'custom') loadData();
  }, [period]);

  useEffect(() => {
    if (period === 'custom' && customFrom && customTo) loadData();
  }, [customFrom, customTo]);

  async function loadData() {
    setLoading(true);
    const { from, to } = getPeriodRange();

    let payQuery = supabase
      .from('payments')
      .select(`
        id, payment_number, payment_type, reference_type, reference_id,
        customer_id, amount, payment_method, payment_date, reference_number,
        notes, is_reversed, bad_debt_amount, payment_for
      `)
      .eq('payment_type', 'received')
      .in('reference_type', ['invoice', 'receivable'])
      .eq('is_reversed', false)
      .order('payment_date', { ascending: false })
      .order('created_at', { ascending: false });
    if (from) payQuery = payQuery.gte('payment_date', from);
    if (to) payQuery = payQuery.lte('payment_date', to);

    let retQuery = supabase
      .from('sales_returns')
      .select(`
        id, return_number, invoice_id, customer_id,
        total_refund_amount, refund_method, return_date
      `)
      .order('return_date', { ascending: false });
    if (from) retQuery = retQuery.gte('return_date', from);
    if (to) retQuery = retQuery.lte('return_date', to);

    const [payRes, retRes] = await Promise.all([payQuery, retQuery]);

    if (payRes.error) {
      console.error('Collection report payments error:', payRes.error);
      setPayments([]);
      setReturns([]);
      setLoading(false);
      return;
    }
    if (retRes.error) {
      console.error('Collection report returns error:', retRes.error);
    }

    const payData = (payRes.data || []) as any[];
    const retData = (retRes.data || []) as any[];

    // Resolve customer names and invoice numbers in JS (payments.reference_id is polymorphic,
    // so PostgREST can't join invoices directly).
    const customerIds = new Set<string>();
    const invoiceIds = new Set<string>();
    payData.forEach((p) => {
      if (p.customer_id) customerIds.add(p.customer_id);
      if (p.reference_type === 'invoice' && p.reference_id) invoiceIds.add(p.reference_id);
    });
    retData.forEach((r) => {
      if (r.customer_id) customerIds.add(r.customer_id);
      if (r.invoice_id) invoiceIds.add(r.invoice_id);
    });

    const [custRes, invRes] = await Promise.all([
      customerIds.size > 0
        ? supabase.from('customers').select('id, name').in('id', Array.from(customerIds))
        : Promise.resolve({ data: [], error: null }),
      invoiceIds.size > 0
        ? supabase.from('invoices').select('id, invoice_number').in('id', Array.from(invoiceIds))
        : Promise.resolve({ data: [], error: null }),
    ]);

    const customerMap = new Map<string, string>();
    (custRes.data || []).forEach((c: any) => customerMap.set(c.id, c.name));
    const invoiceMap = new Map<string, string>();
    (invRes.data || []).forEach((i: any) => invoiceMap.set(i.id, i.invoice_number));

    const enrichedPayments: PaymentRecord[] = payData.map((p) => ({
      ...p,
      customer: p.customer_id ? { name: customerMap.get(p.customer_id) || '' } : null,
      invoice:
        p.reference_type === 'invoice' && p.reference_id && invoiceMap.has(p.reference_id)
          ? { invoice_number: invoiceMap.get(p.reference_id)! }
          : null,
    }));

    const enrichedReturns: ReturnRecord[] = retData.map((r) => ({
      ...r,
      customer: r.customer_id ? { name: customerMap.get(r.customer_id) || '' } : null,
      invoice: r.invoice_id && invoiceMap.has(r.invoice_id)
        ? { invoice_number: invoiceMap.get(r.invoice_id)! }
        : null,
    }));

    setPayments(enrichedPayments);
    setReturns(enrichedReturns);
    setLoading(false);
  }

  const totalCollected = useMemo(
    () => payments.reduce((s, p) => s + Number(p.amount), 0),
    [payments],
  );

  const totalRefunded = useMemo(
    () => returns.reduce((s, r) => s + Number(r.total_refund_amount), 0),
    [returns],
  );

  const netCollected = totalCollected - totalRefunded;

  const collectedByMethod = useMemo(() => {
    const map = new Map<string, { amount: number; count: number }>();
    payments.forEach((p) => {
      const m = p.payment_method || 'unknown';
      const ex = map.get(m) || { amount: 0, count: 0 };
      ex.amount += Number(p.amount);
      ex.count += 1;
      map.set(m, ex);
    });
    return Array.from(map.entries())
      .map(([method, v]) => ({ method, ...v }))
      .sort((a, b) => b.amount - a.amount);
  }, [payments]);

  const collectedByPaymentFor = useMemo(() => {
    const map = new Map<string, { amount: number; count: number }>();
    payments.forEach((p) => {
      const f = p.payment_for || 'uncategorized';
      const ex = map.get(f) || { amount: 0, count: 0 };
      ex.amount += Number(p.amount);
      ex.count += 1;
      map.set(f, ex);
    });
    return Array.from(map.entries())
      .map(([paymentFor, v]) => ({ paymentFor, ...v }))
      .sort((a, b) => b.amount - a.amount);
  }, [payments]);

  const refundedByMethod = useMemo(() => {
    const map = new Map<string, { amount: number; count: number }>();
    returns.forEach((r) => {
      const m = r.refund_method || 'unknown';
      const ex = map.get(m) || { amount: 0, count: 0 };
      ex.amount += Number(r.total_refund_amount);
      ex.count += 1;
      map.set(m, ex);
    });
    return Array.from(map.entries())
      .map(([method, v]) => ({ method, ...v }))
      .sort((a, b) => b.amount - a.amount);
  }, [returns]);

  const timeline: TimelineEvent[] = useMemo(() => {
    const events: Omit<TimelineEvent, 'runningNet'>[] = [];
    payments.forEach((p) => {
      const invNum = (p.invoice as any)?.invoice_number;
      const custName = (p.customer as any)?.name;
      events.push({
        date: p.payment_date,
        type: 'collection',
        description: custName
          ? `Payment from ${custName}`
          : p.reference_type === 'receivable'
            ? 'Receivable payment'
            : 'Invoice payment',
        reference: invNum
          ? `Invoice ${invNum}`
          : p.payment_number
            ? `Payment ${p.payment_number}`
            : p.reference_number || '',
        method: p.payment_method || 'unknown',
        paymentFor: p.payment_for || null,
        amount: Number(p.amount),
      });
    });
    returns.forEach((r) => {
      const invNum = (r.invoice as any)?.invoice_number;
      const custName = (r.customer as any)?.name;
      events.push({
        date: r.return_date,
        type: 'refund',
        description: custName ? `Refund to ${custName}` : 'Sales return refund',
        reference: invNum
          ? `Return ${r.return_number} (Invoice ${invNum})`
          : `Return ${r.return_number}`,
        method: r.refund_method || 'unknown',
        paymentFor: null,
        amount: -Number(r.total_refund_amount),
      });
    });
    events.sort((a, b) => b.date.localeCompare(a.date));
    let running = 0;
    const reversed = [...events].reverse();
    const withRunning = reversed.map((e) => {
      running += e.amount;
      return { ...e, runningNet: running };
    });
    return withRunning.reverse();
  }, [payments, returns]);

  const filteredTimeline = useMemo(() => {
    let result = timeline;
    if (typeFilter !== 'all') {
      result = result.filter((e) =>
        typeFilter === 'collection' ? e.type === 'collection' : e.type === 'refund',
      );
    }
    if (methodFilter !== 'all') {
      result = result.filter((e) => e.method === methodFilter);
    }
    if (paymentForFilter !== 'all') {
      result = result.filter((e) =>
        paymentForFilter === 'uncategorized'
          ? !e.paymentFor
          : e.paymentFor === paymentForFilter,
      );
    }
    if (search) {
      const s = search.toLowerCase();
      result = result.filter(
        (e) =>
          e.description.toLowerCase().includes(s) ||
          e.reference.toLowerCase().includes(s) ||
          methodLabel(e.method).toLowerCase().includes(s),
      );
    }
    return result;
  }, [timeline, typeFilter, methodFilter, search]);

  const totalPages = Math.ceil(filteredTimeline.length / PAGE_SIZE);
  const pagedTimeline = filteredTimeline.slice(
    page * PAGE_SIZE,
    (page + 1) * PAGE_SIZE,
  );

  useEffect(() => {
    if (page !== 0) setPage(0);
  }, [period, typeFilter, methodFilter, paymentForFilter, search]);

  function exportCSV() {
    const rows = [
      ['Date', 'Type', 'Description', 'Reference', 'Method', 'Payment For', 'Amount', 'Running Net'],
      ...filteredTimeline.map((e) => [
        e.date,
        e.type === 'collection' ? 'Collection' : 'Refund',
        e.description,
        e.reference,
        methodLabel(e.method),
        paymentForLabel(e.paymentFor),
        e.amount.toFixed(2),
        e.runningNet.toFixed(2),
      ]),
    ];
    const csv = rows
      .map((r) => r.map((c) => `"${c}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `collection-report-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const allMethods = useMemo(() => {
    const set = new Set<string>();
    payments.forEach((p) => set.add(p.payment_method || 'unknown'));
    returns.forEach((r) => set.add(r.refund_method || 'unknown'));
    return Array.from(set).sort();
  }, [payments, returns]);

  const allPaymentFors = useMemo(() => {
    const set = new Set<string>();
    payments.forEach((p) => { if (p.payment_for) set.add(p.payment_for); });
    return Array.from(set).sort();
  }, [payments]);

  return (
    <div className="space-y-5 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Collection Report</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Collected amounts, refund deductions, and balance movement history
          </p>
        </div>
        <button
          onClick={exportCSV}
          className="flex items-center gap-1.5 px-3 py-2 bg-white border border-border rounded-lg text-sm font-medium hover:bg-muted transition"
        >
          <Download className="w-4 h-4" />
          Export CSV
        </button>
      </div>

      {/* Period filter */}
      <div className="bg-white rounded-xl border border-border p-3 shadow-sm flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5">
          <Filter className="w-3.5 h-3.5 text-muted-foreground mr-1" />
          {(Object.keys(periodConfig) as PeriodKey[]).map((key) => (
            <button
              key={key}
              onClick={() => setPeriod(key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                period === key
                  ? 'bg-blue-600 text-white'
                  : 'border border-border text-muted-foreground hover:bg-muted'
              }`}
            >
              {periodConfig[key].label}
            </button>
          ))}
        </div>
        {period === 'custom' && (
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="border border-border rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
            <span className="text-muted-foreground text-xs">to</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="border border-border rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
          </div>
        )}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border border-border p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-lg bg-green-50 flex items-center justify-center">
              <CheckCircle2 className="w-4 h-4 text-green-600" />
            </div>
            <span className="text-xs font-medium text-muted-foreground">Collected</span>
          </div>
          <p className="text-xl font-bold text-green-600">{formatCurrency(totalCollected)}</p>
          <p className="text-xs text-muted-foreground mt-1">{payments.length} transactions</p>
        </div>
        <div className="bg-white rounded-xl border border-border p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-lg bg-purple-50 flex items-center justify-center">
              <TrendingDown className="w-4 h-4 text-purple-600" />
            </div>
            <span className="text-xs font-medium text-muted-foreground">Refunded</span>
          </div>
          <p className="text-xl font-bold text-purple-600">-{formatCurrency(totalRefunded)}</p>
          <p className="text-xs text-muted-foreground mt-1">{returns.length} returns</p>
        </div>
        <div className="bg-white rounded-xl border border-border p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-lg bg-teal-50 flex items-center justify-center">
              <DollarSign className="w-4 h-4 text-teal-600" />
            </div>
            <span className="text-xs font-medium text-muted-foreground">Net Collected</span>
          </div>
          <p className="text-xl font-bold text-teal-600">{formatCurrency(netCollected)}</p>
          <p className="text-xs text-muted-foreground mt-1">Collected - Refunded</p>
        </div>
        <div className="bg-white rounded-xl border border-border p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center">
              <Receipt className="w-4 h-4 text-blue-600" />
            </div>
            <span className="text-xs font-medium text-muted-foreground">Total Transactions</span>
          </div>
          <p className="text-xl font-bold text-foreground">{payments.length + returns.length}</p>
          <p className="text-xs text-muted-foreground mt-1">
            {payments.length} collections + {returns.length} refunds
          </p>
        </div>
      </div>

      {/* Breakdown by method */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Collected by method */}
        <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <ArrowDownCircle className="w-4 h-4 text-green-500" />
            <h3 className="text-sm font-semibold text-foreground">Collected by Payment Method</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted/30 text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Method</th>
                  <th className="px-4 py-2 text-center font-medium">Count</th>
                  <th className="px-4 py-2 text-right font-medium">Amount</th>
                  <th className="px-4 py-2 text-right font-medium">Share</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {collectedByMethod.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-sm text-muted-foreground">
                      No collections in this period
                    </td>
                  </tr>
                ) : (
                  collectedByMethod.map((p) => (
                    <tr key={p.method} className="hover:bg-muted/20">
                      <td className="px-4 py-2.5 text-sm font-medium text-foreground">
                        <div className="flex items-center gap-2">
                          <CreditCard className="w-3.5 h-3.5 text-muted-foreground" />
                          {methodLabel(p.method)}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-sm text-center text-muted-foreground">{p.count}</td>
                      <td className="px-4 py-2.5 text-sm text-right font-medium text-green-600">
                        {formatCurrency(p.amount)}
                      </td>
                      <td className="px-4 py-2.5 text-sm text-right text-muted-foreground">
                        {totalCollected > 0 ? ((p.amount / totalCollected) * 100).toFixed(1) : 0}%
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              {collectedByMethod.length > 0 && (
                <tfoot className="bg-muted/30">
                  <tr>
                    <td colSpan={2} className="px-4 py-2.5 text-sm font-bold text-foreground">
                      Total Collected
                    </td>
                    <td className="px-4 py-2.5 text-sm text-right font-bold text-green-600">
                      {formatCurrency(totalCollected)}
                    </td>
                    <td className="px-4 py-2.5 text-sm text-right font-bold">100%</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>

        {/* Refunded by method */}
        <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <ArrowUpCircle className="w-4 h-4 text-purple-500" />
            <h3 className="text-sm font-semibold text-foreground">Refunded by Method</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted/30 text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Method</th>
                  <th className="px-4 py-2 text-center font-medium">Count</th>
                  <th className="px-4 py-2 text-right font-medium">Amount</th>
                  <th className="px-4 py-2 text-right font-medium">Share</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {refundedByMethod.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-sm text-muted-foreground">
                      No refunds in this period
                    </td>
                  </tr>
                ) : (
                  refundedByMethod.map((r) => (
                    <tr key={r.method} className="hover:bg-muted/20">
                      <td className="px-4 py-2.5 text-sm font-medium text-foreground">
                        <div className="flex items-center gap-2">
                          <Wallet className="w-3.5 h-3.5 text-muted-foreground" />
                          {methodLabel(r.method)}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-sm text-center text-muted-foreground">{r.count}</td>
                      <td className="px-4 py-2.5 text-sm text-right font-medium text-purple-600">
                        -{formatCurrency(r.amount)}
                      </td>
                      <td className="px-4 py-2.5 text-sm text-right text-muted-foreground">
                        {totalRefunded > 0 ? ((r.amount / totalRefunded) * 100).toFixed(1) : 0}%
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              {refundedByMethod.length > 0 && (
                <tfoot className="bg-muted/30">
                  <tr>
                    <td colSpan={2} className="px-4 py-2.5 text-sm font-bold text-foreground">
                      Total Refunded
                    </td>
                    <td className="px-4 py-2.5 text-sm text-right font-bold text-purple-600">
                      -{formatCurrency(totalRefunded)}
                    </td>
                    <td className="px-4 py-2.5 text-sm text-right font-bold">100%</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      </div>

      {/* Collected by Payment For */}
      <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
          <Receipt className="w-4 h-4 text-blue-500" />
          <h3 className="text-sm font-semibold text-foreground">Collected by Payment For</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-muted/30 text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Category</th>
                <th className="px-4 py-2 text-center font-medium">Count</th>
                <th className="px-4 py-2 text-right font-medium">Amount</th>
                <th className="px-4 py-2 text-right font-medium">Share</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {collectedByPaymentFor.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-sm text-muted-foreground">
                    No collections in this period
                  </td>
                </tr>
              ) : (
                collectedByPaymentFor.map((p) => (
                  <tr key={p.paymentFor} className="hover:bg-muted/20">
                    <td className="px-4 py-2.5 text-sm font-medium text-foreground">
                      <div className="flex items-center gap-2">
                        <CreditCard className="w-3.5 h-3.5 text-muted-foreground" />
                        {paymentForLabel(p.paymentFor)}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-sm text-center text-muted-foreground">{p.count}</td>
                    <td className="px-4 py-2.5 text-sm text-right font-medium text-green-600">
                      {formatCurrency(p.amount)}
                    </td>
                    <td className="px-4 py-2.5 text-sm text-right text-muted-foreground">
                      {totalCollected > 0 ? ((p.amount / totalCollected) * 100).toFixed(1) : 0}%
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            {collectedByPaymentFor.length > 0 && (
              <tfoot className="bg-muted/30">
                <tr>
                  <td colSpan={2} className="px-4 py-2.5 text-sm font-bold text-foreground">
                    Total Collected
                  </td>
                  <td className="px-4 py-2.5 text-sm text-right font-bold text-green-600">
                    {formatCurrency(totalCollected)}
                  </td>
                  <td className="px-4 py-2.5 text-sm text-right font-bold">100%</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* Balance movement history */}
      <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold text-foreground">Balance Movement History</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Chronological log of every collection and refund with running net balance
          </p>
        </div>

        {/* Filters bar */}
        <div className="px-4 py-3 border-b border-border flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5">
            {(['all', 'collection', 'refund'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTypeFilter(t)}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition ${
                  typeFilter === t
                    ? 'bg-blue-600 text-white'
                    : 'border border-border text-muted-foreground hover:bg-muted'
                }`}
              >
                {t === 'all' ? 'All Types' : t === 'collection' ? 'Collections' : 'Refunds'}
              </button>
            ))}
          </div>
          <select
            value={methodFilter}
            onChange={(e) => setMethodFilter(e.target.value)}
            className="border border-border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 bg-white"
          >
            <option value="all">All Methods</option>
            {allMethods.map((m) => (
              <option key={m} value={m}>
                {methodLabel(m)}
              </option>
            ))}
          </select>
          <select
            value={paymentForFilter}
            onChange={(e) => setPaymentForFilter(e.target.value)}
            className="border border-border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 bg-white"
          >
            <option value="all">All Categories</option>
            {allPaymentFors.map((f) => (
              <option key={f} value={f}>
                {paymentForLabel(f)}
              </option>
            ))}
          </select>
          <div className="relative flex-1 min-w-[160px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search transactions..."
              className="w-full pl-8 pr-4 py-1.5 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
          </div>
        </div>

        {/* Table */}
        {loading ? (
          <div className="p-8 space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 animate-pulse">
                <div className="w-9 h-9 rounded-full bg-muted" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3 bg-muted rounded w-1/3" />
                  <div className="h-2.5 bg-muted rounded w-1/4" />
                </div>
                <div className="h-3 bg-muted rounded w-20" />
              </div>
            ))}
          </div>
        ) : pagedTimeline.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16">
            <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-3">
              <Receipt className="w-6 h-6 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-muted-foreground">No transactions found</p>
            <p className="text-xs text-muted-foreground/70 mt-1">Try changing the filters or period.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted/30 text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 text-left font-medium">Date</th>
                  <th className="px-4 py-2.5 text-left font-medium">Type</th>
                  <th className="px-4 py-2.5 text-left font-medium">Description</th>
                  <th className="px-4 py-2.5 text-left font-medium">Reference</th>
                  <th className="px-4 py-2.5 text-left font-medium">Method</th>
                  <th className="px-4 py-2.5 text-left font-medium">Payment For</th>
                  <th className="px-4 py-2.5 text-right font-medium">Amount</th>
                  <th className="px-4 py-2.5 text-right font-medium">Running Net</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {pagedTimeline.map((e, i) => (
                  <tr key={i} className="hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-2.5 text-sm text-muted-foreground whitespace-nowrap">
                      {formatDate(e.date)}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${
                          e.type === 'collection'
                            ? 'bg-green-50 text-green-700'
                            : 'bg-purple-50 text-purple-700'
                        }`}
                      >
                        {e.type === 'collection' ? (
                          <ArrowDownCircle className="w-3 h-3" />
                        ) : (
                          <ArrowUpCircle className="w-3 h-3" />
                        )}
                        {e.type === 'collection' ? 'Collection' : 'Refund'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-sm text-foreground">{e.description}</td>
                    <td className="px-4 py-2.5 text-sm text-muted-foreground">{e.reference}</td>
                    <td className="px-4 py-2.5 text-sm text-muted-foreground">
                      {methodLabel(e.method)}
                    </td>
                    <td className="px-4 py-2.5 text-sm text-muted-foreground">
                      {e.type === 'collection' ? paymentForLabel(e.paymentFor) : '—'}
                    </td>
                    <td
                      className={`px-4 py-2.5 text-sm text-right font-medium ${
                        e.amount >= 0 ? 'text-green-600' : 'text-purple-600'
                      }`}
                    >
                      {e.amount >= 0 ? '+' : ''}
                      {formatCurrency(e.amount)}
                    </td>
                    <td className="px-4 py-2.5 text-sm text-right font-medium text-foreground">
                      {formatCurrency(e.runningNet)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {!loading && filteredTimeline.length > PAGE_SIZE && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-border">
            <p className="text-xs text-muted-foreground">
              Showing {page * PAGE_SIZE + 1}–
              {Math.min((page + 1) * PAGE_SIZE, filteredTimeline.length)} of{' '}
              {filteredTimeline.length}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="w-7 h-7 flex items-center justify-center rounded-lg border border-border hover:bg-muted transition disabled:opacity-40"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-xs text-muted-foreground font-medium">
                Page {page + 1} of {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className="w-7 h-7 flex items-center justify-center rounded-lg border border-border hover:bg-muted transition disabled:opacity-40"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
