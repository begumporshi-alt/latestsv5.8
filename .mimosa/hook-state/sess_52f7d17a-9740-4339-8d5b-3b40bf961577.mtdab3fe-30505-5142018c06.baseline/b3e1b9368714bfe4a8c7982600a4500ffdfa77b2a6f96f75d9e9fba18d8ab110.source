'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCurrency, formatDate } from '@/lib/format';
import { toast } from '@/hooks/use-toast';
import { Clock, TriangleAlert as AlertTriangle, DollarSign, User, Building2, ChevronDown, ChevronUp, Filter, Search, Printer } from 'lucide-react';

interface AgingBucket {
  current: number;
  days_30: number;
  days_60: number;
  days_90: number;
  over_90: number;
  total: number;
}

interface CustomerAging {
  customer_id: string;
  customer_name: string;
  customer_code: string;
  phone?: string;
  aging: AgingBucket;
  invoices: {
    id: string;
    invoice_number: string;
    invoice_date: string;
    due_date?: string;
    total_amount: number;
    amount_paid: number;
    balance: number;
    days_overdue: number;
  }[];
}

interface SupplierAging {
  supplier_id: string;
  supplier_name: string;
  supplier_code: string;
  aging: AgingBucket;
  purchase_orders: {
    id: string;
    po_number: string;
    order_date: string;
    total_amount: number;
    amount_paid: number;
    balance: number;
    days_overdue: number;
  }[];
}

export default function AgingDuesPage() {
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'receivables' | 'payables'>('receivables');
  const [customerAging, setCustomerAging] = useState<CustomerAging[]>([]);
  const [supplierAging, setSupplierAging] = useState<SupplierAging[]>([]);
  const [expandedCustomer, setExpandedCustomer] = useState<string | null>(null);
  const [expandedSupplier, setExpandedSupplier] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);
    await Promise.all([loadReceivablesAging(), loadPayablesAging()]);
    setLoading(false);
  }

  async function loadReceivablesAging() {
    const { data: invoices } = await supabase
      .from('invoices')
      .select(`
        id, invoice_number, invoice_date, due_date, total_amount, amount_paid,
        customer:customers(id, name, code, phone)
      `)
      .in('status', ['sent', 'partially_paid', 'overdue'])
      .order('invoice_date', { ascending: false });

    if (!invoices) return;

    const today = new Date();
    const customerMap = new Map<string, CustomerAging>();

    invoices.forEach((inv: any) => {
      const balance = Number(inv.total_amount) - Number(inv.amount_paid);
      if (balance <= 0) return;

      const dueDate = inv.due_date ? new Date(inv.due_date) : new Date(inv.invoice_date);
      const daysOverdue = Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
      const customerId = inv.customer?.id || 'unknown';

      if (!customerMap.has(customerId)) {
        customerMap.set(customerId, {
          customer_id: customerId,
          customer_name: inv.customer?.name || 'Unknown',
          customer_code: inv.customer?.code || '-',
          phone: inv.customer?.phone,
          aging: { current: 0, days_30: 0, days_60: 0, days_90: 0, over_90: 0, total: 0 },
          invoices: [],
        });
      }

      const customer = customerMap.get(customerId)!;
      customer.invoices.push({
        id: inv.id,
        invoice_number: inv.invoice_number,
        invoice_date: inv.invoice_date,
        due_date: inv.due_date,
        total_amount: Number(inv.total_amount),
        amount_paid: Number(inv.amount_paid),
        balance,
        days_overdue: daysOverdue,
      });

      if (daysOverdue <= 0) customer.aging.current += balance;
      else if (daysOverdue <= 30) customer.aging.days_30 += balance;
      else if (daysOverdue <= 60) customer.aging.days_60 += balance;
      else if (daysOverdue <= 90) customer.aging.days_90 += balance;
      else customer.aging.over_90 += balance;
      customer.aging.total += balance;
    });

    setCustomerAging(Array.from(customerMap.values()).sort((a, b) => b.aging.total - a.aging.total));
  }

  async function loadPayablesAging() {
    const { data: purchaseOrders } = await supabase
      .from('purchase_orders')
      .select(`
        id, po_number, order_date, total_amount, amount_paid,
        supplier:suppliers(id, name, code)
      `)
      .in('status', ['confirmed', 'partially_received', 'received'])
      .order('order_date', { ascending: false });

    if (!purchaseOrders) return;

    const today = new Date();
    const supplierMap = new Map<string, SupplierAging>();

    purchaseOrders.forEach((po: any) => {
      const balance = Number(po.total_amount) - Number(po.amount_paid || 0);
      if (balance <= 0) return;

      const orderDate = new Date(po.order_date);
      const daysOverdue = Math.floor((today.getTime() - orderDate.getTime()) / (1000 * 60 * 60 * 24)) - 30;
      const supplierId = po.supplier?.id || 'unknown';

      if (!supplierMap.has(supplierId)) {
        supplierMap.set(supplierId, {
          supplier_id: supplierId,
          supplier_name: po.supplier?.name || 'Unknown',
          supplier_code: po.supplier?.code || '-',
          aging: { current: 0, days_30: 0, days_60: 0, days_90: 0, over_90: 0, total: 0 },
          purchase_orders: [],
        });
      }

      const supplier = supplierMap.get(supplierId)!;
      supplier.purchase_orders.push({
        id: po.id,
        po_number: po.po_number,
        order_date: po.order_date,
        total_amount: Number(po.total_amount),
        amount_paid: Number(po.amount_paid || 0),
        balance,
        days_overdue: Math.max(0, daysOverdue),
      });

      if (daysOverdue <= 0) supplier.aging.current += balance;
      else if (daysOverdue <= 30) supplier.aging.days_30 += balance;
      else if (daysOverdue <= 60) supplier.aging.days_60 += balance;
      else if (daysOverdue <= 90) supplier.aging.days_90 += balance;
      else supplier.aging.over_90 += balance;
      supplier.aging.total += balance;
    });

    setSupplierAging(Array.from(supplierMap.values()).sort((a, b) => b.aging.total - a.aging.total));
  }

  const totalReceivables = customerAging.reduce((s, c) => s + c.aging.total, 0);
  const totalPayables = supplierAging.reduce((s, s2) => s2.aging.total + s, 0);

  const filteredCustomers = customerAging.filter(c =>
    c.customer_name.toLowerCase().includes(search.toLowerCase()) ||
    c.customer_code.toLowerCase().includes(search.toLowerCase())
  );

  const filteredSuppliers = supplierAging.filter(s =>
    s.supplier_name.toLowerCase().includes(search.toLowerCase()) ||
    s.supplier_code.toLowerCase().includes(search.toLowerCase())
  );

  const agingSummary = activeTab === 'receivables' ? {
    current: customerAging.reduce((s, c) => s + c.aging.current, 0),
    days_30: customerAging.reduce((s, c) => s + c.aging.days_30, 0),
    days_60: customerAging.reduce((s, c) => s + c.aging.days_60, 0),
    days_90: customerAging.reduce((s, c) => s + c.aging.days_90, 0),
    over_90: customerAging.reduce((s, c) => s + c.aging.over_90, 0),
  } : {
    current: supplierAging.reduce((s, s2) => s + s2.aging.current, 0),
    days_30: supplierAging.reduce((s, s2) => s + s2.aging.days_30, 0),
    days_60: supplierAging.reduce((s, s2) => s + s2.aging.days_60, 0),
    days_90: supplierAging.reduce((s, s2) => s + s2.aging.days_90, 0),
    over_90: supplierAging.reduce((s, s2) => s + s2.aging.over_90, 0),
  };

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Aging & Dues</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Track receivables and payables by aging period</p>
        </div>
        <button
          onClick={() => window.print()}
          className="flex items-center gap-2 px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition"
        >
          <Printer className="w-4 h-4" /> Print Report
        </button>
      </div>

      {/* Tab Switcher */}
      <div className="flex gap-2">
        <button
          onClick={() => setActiveTab('receivables')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
            activeTab === 'receivables'
              ? 'bg-blue-600 text-white'
              : 'bg-white border border-border text-muted-foreground hover:bg-muted'
          }`}
        >
          <User className="w-4 h-4" />
          Receivables ({formatCurrency(totalReceivables)})
        </button>
        <button
          onClick={() => setActiveTab('payables')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
            activeTab === 'payables'
              ? 'bg-red-600 text-white'
              : 'bg-white border border-border text-muted-foreground hover:bg-muted'
          }`}
        >
          <Building2 className="w-4 h-4" />
          Payables ({formatCurrency(totalPayables)})
        </button>
      </div>

      {/* Aging Summary Cards */}
      <div className="grid grid-cols-5 gap-3">
        {[
          { label: 'Current', value: agingSummary.current, color: 'bg-green-50 text-green-700 border-green-200' },
          { label: '1-30 Days', value: agingSummary.days_30, color: 'bg-blue-50 text-blue-700 border-blue-200' },
          { label: '31-60 Days', value: agingSummary.days_60, color: 'bg-amber-50 text-amber-700 border-amber-200' },
          { label: '61-90 Days', value: agingSummary.days_90, color: 'bg-orange-50 text-orange-700 border-orange-200' },
          { label: 'Over 90', value: agingSummary.over_90, color: 'bg-red-50 text-red-700 border-red-200' },
        ].map(bucket => (
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
          <table className="w-full">
            <thead>
              <tr className="bg-muted/40 border-b border-border">
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">
                  {activeTab === 'receivables' ? 'Customer' : 'Supplier'}
                </th>
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
                  <tr key={i}>
                    {Array.from({ length: 8 }).map((_, j) => (
                      <td key={j} className="px-4 py-3"><div className="h-4 bg-muted rounded animate-pulse" /></td>
                    ))}
                  </tr>
                ))
              ) : activeTab === 'receivables' ? (
                filteredCustomers.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground text-sm">
                      No outstanding receivables
                    </td>
                  </tr>
                ) : (
                  filteredCustomers.map(customer => (
                    <>
                      <tr
                        key={customer.customer_id}
                        className="hover:bg-muted/30 transition-colors cursor-pointer"
                        onClick={() => setExpandedCustomer(expandedCustomer === customer.customer_id ? null : customer.customer_id)}
                      >
                        <td className="px-4 py-3">
                          <div>
                            <p className="text-sm font-semibold text-foreground">{customer.customer_name}</p>
                            <p className="text-xs text-muted-foreground">{customer.customer_code} {customer.phone && `- ${customer.phone}`}</p>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right text-sm font-medium text-green-600">
                          {customer.aging.current > 0 ? formatCurrency(customer.aging.current) : '-'}
                        </td>
                        <td className="px-4 py-3 text-right text-sm font-medium text-blue-600">
                          {customer.aging.days_30 > 0 ? formatCurrency(customer.aging.days_30) : '-'}
                        </td>
                        <td className="px-4 py-3 text-right text-sm font-medium text-amber-600">
                          {customer.aging.days_60 > 0 ? formatCurrency(customer.aging.days_60) : '-'}
                        </td>
                        <td className="px-4 py-3 text-right text-sm font-medium text-orange-600">
                          {customer.aging.days_90 > 0 ? formatCurrency(customer.aging.days_90) : '-'}
                        </td>
                        <td className="px-4 py-3 text-right text-sm font-medium text-red-600">
                          {customer.aging.over_90 > 0 ? formatCurrency(customer.aging.over_90) : '-'}
                        </td>
                        <td className="px-4 py-3 text-right text-sm font-bold text-foreground">
                          {formatCurrency(customer.aging.total)}
                        </td>
                        <td className="px-4 py-3">
                          {expandedCustomer === customer.customer_id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </td>
                      </tr>
                      {expandedCustomer === customer.customer_id && (
                        <tr key={`${customer.customer_id}-detail`} className="bg-slate-50">
                          <td colSpan={8} className="px-4 py-3">
                            <div className="space-y-2">
                              <p className="text-xs font-semibold text-muted-foreground">Outstanding Invoices</p>
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
                                  {customer.invoices.map(inv => (
                                    <tr key={inv.id} className="border-b border-border/50">
                                      <td className="py-2 text-blue-600 font-medium">{inv.invoice_number}</td>
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
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  ))
                )
              ) : (
                filteredSuppliers.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground text-sm">
                      No outstanding payables
                    </td>
                  </tr>
                ) : (
                  filteredSuppliers.map(supplier => (
                    <>
                      <tr
                        key={supplier.supplier_id}
                        className="hover:bg-muted/30 transition-colors cursor-pointer"
                        onClick={() => setExpandedSupplier(expandedSupplier === supplier.supplier_id ? null : supplier.supplier_id)}
                      >
                        <td className="px-4 py-3">
                          <div>
                            <p className="text-sm font-semibold text-foreground">{supplier.supplier_name}</p>
                            <p className="text-xs text-muted-foreground">{supplier.supplier_code}</p>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right text-sm font-medium text-green-600">
                          {supplier.aging.current > 0 ? formatCurrency(supplier.aging.current) : '-'}
                        </td>
                        <td className="px-4 py-3 text-right text-sm font-medium text-blue-600">
                          {supplier.aging.days_30 > 0 ? formatCurrency(supplier.aging.days_30) : '-'}
                        </td>
                        <td className="px-4 py-3 text-right text-sm font-medium text-amber-600">
                          {supplier.aging.days_60 > 0 ? formatCurrency(supplier.aging.days_60) : '-'}
                        </td>
                        <td className="px-4 py-3 text-right text-sm font-medium text-orange-600">
                          {supplier.aging.days_90 > 0 ? formatCurrency(supplier.aging.days_90) : '-'}
                        </td>
                        <td className="px-4 py-3 text-right text-sm font-medium text-red-600">
                          {supplier.aging.over_90 > 0 ? formatCurrency(supplier.aging.over_90) : '-'}
                        </td>
                        <td className="px-4 py-3 text-right text-sm font-bold text-foreground">
                          {formatCurrency(supplier.aging.total)}
                        </td>
                        <td className="px-4 py-3">
                          {expandedSupplier === supplier.supplier_id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </td>
                      </tr>
                      {expandedSupplier === supplier.supplier_id && (
                        <tr key={`${supplier.supplier_id}-detail`} className="bg-slate-50">
                          <td colSpan={8} className="px-4 py-3">
                            <div className="space-y-2">
                              <p className="text-xs font-semibold text-muted-foreground">Outstanding Purchase Orders</p>
                              <table className="w-full text-sm">
                                <thead>
                                  <tr className="border-b border-border">
                                    <th className="text-left text-xs py-1">PO #</th>
                                    <th className="text-left text-xs py-1">Date</th>
                                    <th className="text-right text-xs py-1">Amount</th>
                                    <th className="text-right text-xs py-1">Paid</th>
                                    <th className="text-right text-xs py-1">Balance</th>
                                    <th className="text-right text-xs py-1">Overdue</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {supplier.purchase_orders.map(po => (
                                    <tr key={po.id} className="border-b border-border/50">
                                      <td className="py-2 text-purple-600 font-medium">{po.po_number}</td>
                                      <td className="py-2 text-muted-foreground">{formatDate(po.order_date)}</td>
                                      <td className="py-2 text-right">{formatCurrency(po.total_amount)}</td>
                                      <td className="py-2 text-right text-green-600">{formatCurrency(po.amount_paid)}</td>
                                      <td className="py-2 text-right font-semibold text-red-600">{formatCurrency(po.balance)}</td>
                                      <td className="py-2 text-right">
                                        <span className={`badge-status ${po.days_overdue > 60 ? 'bg-red-100 text-red-700' : po.days_overdue > 30 ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-700'}`}>
                                          {po.days_overdue > 0 ? `${po.days_overdue} days` : 'Current'}
                                        </span>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  ))
                )
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
