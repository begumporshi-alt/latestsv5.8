'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { formatCurrency, formatDate } from '@/lib/format';
import { User, Building2, ChevronDown, ChevronUp, Search, Printer, Download, Calendar, RefreshCw } from 'lucide-react';

interface ArRow {
  customer_id: string;
  customer_name: string;
  total_due: number;
  bucket_current: number;
  bucket_1_30: number;
  bucket_31_60: number;
  bucket_61_90: number;
  bucket_90_plus: number;
  oldest_open_date: string | null;
}

interface ApRow {
  supplier_id: string;
  supplier_name: string;
  total_due: number;
  bucket_current: number;
  bucket_31_60: number;
  bucket_61_90: number;
  bucket_90_plus: number;
  oldest_open_date: string | null;
}

interface InvoiceDetail {
  id: string;
  invoice_number: string;
  invoice_date: string;
  due_date?: string;
  total_amount: number;
  amount_paid: number;
  balance: number;
  days_overdue: number;
}

interface PoDetail {
  id: string;
  po_number: string;
  order_date: string;
  total_amount: number;
  amount_paid: number;
  balance: number;
}

export default function AgingDuesPage() {
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'receivables' | 'payables'>('receivables');
  const [asOf, setAsOf] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  });
  const [arRows, setArRows] = useState<ArRow[]>([]);
  const [apRows, setApRows] = useState<ApRow[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detailInvoices, setDetailInvoices] = useState<Record<string, InvoiceDetail[]>>({});
  const [detailPos, setDetailPos] = useState<Record<string, PoDetail[]>>({});
  const [search, setSearch] = useState('');

  useEffect(() => { load(); }, [asOf]);

  async function load() {
    setLoading(true);
    const [arRes, apRes] = await Promise.all([
      supabase.rpc('get_receivables_aging', { p_as_of: asOf }),
      supabase.rpc('get_payables_aging', { p_as_of: asOf }),
    ]);
    setArRows((arRes.data || []) as ArRow[]);
    setApRows((apRes.data || []) as ApRow[]);
    setExpanded(null);
    setLoading(false);
  }

  async function toggleExpand(id: string) {
    const next = expanded === id ? null : id;
    setExpanded(next);
    if (!next) return;
    if (activeTab === 'receivables' && !detailInvoices[id]) {
      const { data } = await supabase
        .from('invoices')
        .select('id, invoice_number, invoice_date, due_date, total_amount, amount_paid')
        .eq('customer_id', id)
        .in('status', ['sent', 'partially_paid', 'overdue'])
        .order('invoice_date', { ascending: false });
      const today = new Date(asOf);
      const rows = (data || []).map((inv: any) => {
        const balance = Number(inv.total_amount) - Number(inv.amount_paid);
        const dueDate = inv.due_date ? new Date(inv.due_date) : new Date(inv.invoice_date);
        return {
          id: inv.id,
          invoice_number: inv.invoice_number,
          invoice_date: inv.invoice_date,
          due_date: inv.due_date,
          total_amount: Number(inv.total_amount),
          amount_paid: Number(inv.amount_paid),
          balance,
          days_overdue: Math.floor((today.getTime() - dueDate.getTime()) / 86400000),
        };
      }).filter(r => r.balance > 0.005);
      setDetailInvoices(prev => ({ ...prev, [id]: rows }));
    }
    if (activeTab === 'payables' && !detailPos[id]) {
      const { data } = await supabase
        .from('purchase_orders')
        .select('id, po_number, order_date, total_amount, amount_paid')
        .eq('supplier_id', id)
        .in('status', ['confirmed', 'partially_received', 'received'])
        .order('order_date', { ascending: false });
      const rows = (data || []).map((po: any) => ({
        id: po.id,
        po_number: po.po_number,
        order_date: po.order_date,
        total_amount: Number(po.total_amount),
        amount_paid: Number(po.amount_paid || 0),
        balance: Number(po.total_amount) - Number(po.amount_paid || 0),
      })).filter(r => r.balance > 0.005);
      setDetailPos(prev => ({ ...prev, [id]: rows }));
    }
  }

  const filteredAr = arRows.filter(r => r.customer_name.toLowerCase().includes(search.toLowerCase()));
  const filteredAp = apRows.filter(r => r.supplier_name.toLowerCase().includes(search.toLowerCase()));

  const totalReceivables = arRows.reduce((s, r) => s + Number(r.total_due), 0);
  const totalPayables = apRows.reduce((s, r) => s + Number(r.total_due), 0);

  function exportCsv() {
    const lines: string[] = [];
    if (activeTab === 'receivables') {
      lines.push(
        `ACCOUNTS RECEIVABLE AGING — as of ${asOf}`,
        'Customer,Current,1-30 Days,31-60 Days,61-90 Days,Over 90,Total,Oldest Open',
        ...filteredAr.map(r => `"${r.customer_name}",${Number(r.bucket_current).toFixed(2)},${Number(r.bucket_1_30).toFixed(2)},${Number(r.bucket_31_60).toFixed(2)},${Number(r.bucket_61_90).toFixed(2)},${Number(r.bucket_90_plus).toFixed(2)},${Number(r.total_due).toFixed(2)},${r.oldest_open_date || ''}`),
      );
    } else {
      lines.push(
        `ACCOUNTS PAYABLE AGING — as of ${asOf}`,
        'Supplier,Current (0-30),31-60 Days,61-90 Days,Over 90,Total,Oldest Open',
        ...filteredAp.map(r => `"${r.supplier_name}",${Number(r.bucket_current).toFixed(2)},${Number(r.bucket_31_60).toFixed(2)},${Number(r.bucket_61_90).toFixed(2)},${Number(r.bucket_90_plus).toFixed(2)},${Number(r.total_due).toFixed(2)},${r.oldest_open_date || ''}`),
      );
    }
    const csv = '\uFEFF' + lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeTab === 'receivables' ? 'ar' : 'ap'}_aging_${asOf}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const num = (v: any) => Number(v || 0);
  const cell = (v: number) => (v > 0.005 ? formatCurrency(v) : '-');

  const arSummary = [
    { label: 'Current', value: arRows.reduce((s, r) => s + num(r.bucket_current), 0), color: 'bg-green-50 text-green-700 border-green-200' },
    { label: '1-30 Days', value: arRows.reduce((s, r) => s + num(r.bucket_1_30), 0), color: 'bg-blue-50 text-blue-700 border-blue-200' },
    { label: '31-60 Days', value: arRows.reduce((s, r) => s + num(r.bucket_31_60), 0), color: 'bg-amber-50 text-amber-700 border-amber-200' },
    { label: '61-90 Days', value: arRows.reduce((s, r) => s + num(r.bucket_61_90), 0), color: 'bg-orange-50 text-orange-700 border-orange-200' },
    { label: 'Over 90', value: arRows.reduce((s, r) => s + num(r.bucket_90_plus), 0), color: 'bg-red-50 text-red-700 border-red-200' },
  ];
  const apSummary = [
    { label: 'Current (0-30)', value: apRows.reduce((s, r) => s + num(r.bucket_current), 0), color: 'bg-green-50 text-green-700 border-green-200' },
    { label: '31-60 Days', value: apRows.reduce((s, r) => s + num(r.bucket_31_60), 0), color: 'bg-amber-50 text-amber-700 border-amber-200' },
    { label: '61-90 Days', value: apRows.reduce((s, r) => s + num(r.bucket_61_90), 0), color: 'bg-orange-50 text-orange-700 border-orange-200' },
    { label: 'Over 90', value: apRows.reduce((s, r) => s + num(r.bucket_90_plus), 0), color: 'bg-red-50 text-red-700 border-red-200' },
  ];
  const summary = activeTab === 'receivables' ? arSummary : apSummary;

  return (
    <div className="space-y-5 animate-fade-in print-modal">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Aging & Dues</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Receivables and payables by aging period — straight from the ledger</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Calendar className="w-4 h-4 text-muted-foreground" />
          <input type="date" value={asOf} onChange={e => setAsOf(e.target.value)} className="border border-border rounded-lg px-3 py-2 text-sm bg-white" />
          <button onClick={load} className="flex items-center gap-1.5 border border-border px-3 py-2 rounded-lg text-sm hover:bg-muted transition">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button onClick={exportCsv} className="flex items-center gap-2 border border-border px-3 py-2 rounded-lg text-sm hover:bg-muted transition">
            <Download className="w-4 h-4" /> Export
          </button>
          <button onClick={() => window.print()} className="flex items-center gap-2 px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">
            <Printer className="w-4 h-4" /> Print
          </button>
        </div>
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-xs text-blue-800 print:hidden">
        Buckets come from the general ledger (AR accounts 1100 + 1300, AP account 2000): settlement credits are
        FIFO-allocated over the receivable/payable debits, and the remainder is bucketed by the original entry date
        relative to the as-of date. The expandable document lists are reference detail — the bucket totals are the ledger truth.
      </div>

      {/* Tab Switcher */}
      <div className="flex gap-2">
        <button
          onClick={() => { setActiveTab('receivables'); setExpanded(null); }}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
            activeTab === 'receivables' ? 'bg-blue-600 text-white' : 'bg-white border border-border text-muted-foreground hover:bg-muted'
          }`}
        >
          <User className="w-4 h-4" />
          Receivables ({formatCurrency(totalReceivables)})
        </button>
        <button
          onClick={() => { setActiveTab('payables'); setExpanded(null); }}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
            activeTab === 'payables' ? 'bg-red-600 text-white' : 'bg-white border border-border text-muted-foreground hover:bg-muted'
          }`}
        >
          <Building2 className="w-4 h-4" />
          Payables ({formatCurrency(totalPayables)})
        </button>
      </div>

      {/* Summary Cards */}
      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${summary.length}, minmax(0, 1fr))` }}>
        {summary.map(bucket => (
          <div key={bucket.label} className={`rounded-xl border p-4 ${bucket.color}`}>
            <p className="text-xs font-medium opacity-80">{bucket.label}</p>
            <p className="text-lg font-bold mt-1">{formatCurrency(bucket.value)}</p>
          </div>
        ))}
      </div>

      {/* Search */}
      <div className="bg-white rounded-xl border border-border p-4 shadow-sm">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={`Search ${activeTab === 'receivables' ? 'customers' : 'suppliers'}...`}
            className="w-full pl-10 pr-4 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          />
        </div>
      </div>

      {/* Aging Table */}
      <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          {activeTab === 'receivables' ? (
            <table className="w-full">
              <thead>
                <tr className="bg-muted/40 border-b border-border">
                  <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Customer</th>
                  <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Current</th>
                  <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">1-30 Days</th>
                  <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">31-60 Days</th>
                  <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">61-90 Days</th>
                  <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Over 90</th>
                  <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Total</th>
                  <th className="w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {loading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i}>{Array.from({ length: 8 }).map((_, j) => <td key={j} className="px-4 py-3"><div className="h-4 bg-muted rounded animate-pulse" /></td>)}</tr>
                  ))
                ) : filteredAr.length === 0 ? (
                  <tr><td colSpan={8} className="px-4 py-8 text-center text-muted-foreground text-sm">No outstanding receivables as of {asOf}</td></tr>
                ) : filteredAr.map(r => (
                  <>
                    <tr key={r.customer_id} className="hover:bg-muted/30 transition-colors cursor-pointer" onClick={() => toggleExpand(r.customer_id)}>
                      <td className="px-4 py-3">
                        <Link href={`/crm/${r.customer_id}`} onClick={e => e.stopPropagation()} className="text-sm font-semibold text-foreground hover:text-blue-600">
                          {r.customer_name}
                        </Link>
                        {r.oldest_open_date && <p className="text-xs text-muted-foreground">Oldest open: {formatDate(r.oldest_open_date)}</p>}
                      </td>
                      <td className="px-4 py-3 text-right text-sm font-medium text-green-600">{cell(num(r.bucket_current))}</td>
                      <td className="px-4 py-3 text-right text-sm font-medium text-blue-600">{cell(num(r.bucket_1_30))}</td>
                      <td className="px-4 py-3 text-right text-sm font-medium text-amber-600">{cell(num(r.bucket_31_60))}</td>
                      <td className="px-4 py-3 text-right text-sm font-medium text-orange-600">{cell(num(r.bucket_61_90))}</td>
                      <td className="px-4 py-3 text-right text-sm font-medium text-red-600">{cell(num(r.bucket_90_plus))}</td>
                      <td className="px-4 py-3 text-right text-sm font-bold text-foreground">{formatCurrency(num(r.total_due))}</td>
                      <td className="px-4 py-3">{expanded === r.customer_id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}</td>
                    </tr>
                    {expanded === r.customer_id && (
                      <tr className="bg-slate-50">
                        <td colSpan={8} className="px-4 py-3">
                          <p className="text-xs font-semibold text-muted-foreground mb-2">Open Invoices (reference detail)</p>
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b border-border">
                                <th className="text-left text-xs py-1">Invoice #</th>
                                <th className="text-left text-xs py-1">Date</th>
                                <th className="text-left text-xs py-1">Due Date</th>
                                <th className="text-right text-xs py-1">Amount</th>
                                <th className="text-right text-xs py-1">Paid</th>
                                <th className="text-right text-xs py-1">Balance</th>
                                <th className="text-right text-xs py-1">Days Overdue</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(detailInvoices[r.customer_id] || []).map(inv => (
                                <tr key={inv.id} className="border-b border-border/50">
                                  <td className="py-2">
                                    <Link href={`/sales?highlight=${inv.id}`} className="text-blue-600 font-medium hover:underline">{inv.invoice_number}</Link>
                                  </td>
                                  <td className="py-2 text-muted-foreground">{formatDate(inv.invoice_date)}</td>
                                  <td className="py-2 text-muted-foreground">{inv.due_date ? formatDate(inv.due_date) : 'On receipt'}</td>
                                  <td className="py-2 text-right">{formatCurrency(inv.total_amount)}</td>
                                  <td className="py-2 text-right text-green-600">{formatCurrency(inv.amount_paid)}</td>
                                  <td className="py-2 text-right font-semibold text-red-600">{formatCurrency(inv.balance)}</td>
                                  <td className="py-2 text-right">
                                    <span className={`badge-status ${inv.days_overdue > 60 ? 'bg-red-100 text-red-700' : inv.days_overdue > 30 ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-700'}`}>
                                      {inv.days_overdue > 0 ? `${inv.days_overdue} days` : 'Due'}
                                    </span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="bg-muted/40 border-b border-border">
                  <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Supplier</th>
                  <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Current (0-30)</th>
                  <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">31-60 Days</th>
                  <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">61-90 Days</th>
                  <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Over 90</th>
                  <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Total</th>
                  <th className="w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {loading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i}>{Array.from({ length: 7 }).map((_, j) => <td key={j} className="px-4 py-3"><div className="h-4 bg-muted rounded animate-pulse" /></td>)}</tr>
                  ))
                ) : filteredAp.length === 0 ? (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground text-sm">No outstanding payables as of {asOf}</td></tr>
                ) : filteredAp.map(r => (
                  <>
                    <tr key={r.supplier_id} className="hover:bg-muted/30 transition-colors cursor-pointer" onClick={() => toggleExpand(r.supplier_id)}>
                      <td className="px-4 py-3">
                        <Link href={`/suppliers/${r.supplier_id}`} onClick={e => e.stopPropagation()} className="text-sm font-semibold text-foreground hover:text-blue-600">
                          {r.supplier_name}
                        </Link>
                        {r.oldest_open_date && <p className="text-xs text-muted-foreground">Oldest open: {formatDate(r.oldest_open_date)}</p>}
                      </td>
                      <td className="px-4 py-3 text-right text-sm font-medium text-green-600">{cell(num(r.bucket_current))}</td>
                      <td className="px-4 py-3 text-right text-sm font-medium text-amber-600">{cell(num(r.bucket_31_60))}</td>
                      <td className="px-4 py-3 text-right text-sm font-medium text-orange-600">{cell(num(r.bucket_61_90))}</td>
                      <td className="px-4 py-3 text-right text-sm font-medium text-red-600">{cell(num(r.bucket_90_plus))}</td>
                      <td className="px-4 py-3 text-right text-sm font-bold text-foreground">{formatCurrency(num(r.total_due))}</td>
                      <td className="px-4 py-3">{expanded === r.supplier_id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}</td>
                    </tr>
                    {expanded === r.supplier_id && (
                      <tr className="bg-slate-50">
                        <td colSpan={7} className="px-4 py-3">
                          <p className="text-xs font-semibold text-muted-foreground mb-2">Open Purchase Orders (reference detail)</p>
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b border-border">
                                <th className="text-left text-xs py-1">PO #</th>
                                <th className="text-left text-xs py-1">Date</th>
                                <th className="text-right text-xs py-1">Amount</th>
                                <th className="text-right text-xs py-1">Paid</th>
                                <th className="text-right text-xs py-1">Balance</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(detailPos[r.supplier_id] || []).map(po => (
                                <tr key={po.id} className="border-b border-border/50">
                                  <td className="py-2">
                                    <Link href={`/purchases?highlight=${po.id}`} className="text-purple-600 font-medium hover:underline">{po.po_number}</Link>
                                  </td>
                                  <td className="py-2 text-muted-foreground">{formatDate(po.order_date)}</td>
                                  <td className="py-2 text-right">{formatCurrency(po.total_amount)}</td>
                                  <td className="py-2 text-right text-green-600">{formatCurrency(po.amount_paid)}</td>
                                  <td className="py-2 text-right font-semibold text-red-600">{formatCurrency(po.balance)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
