'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { formatCurrency, formatDate } from '@/lib/format';
import { toast } from '@/hooks/use-toast';
import { ArrowLeft, Phone, Mail, MapPin, Building2, CreditCard, Calendar, ShoppingBag, DollarSign, Star, CreditCard as Edit, Eye, Package, FileText, Plus, Truck, Warehouse, RotateCcw, Receipt } from 'lucide-react';
import type { Supplier, PurchaseOrder } from '@/lib/types';

interface ManualPayable {
  id: string;
  entry_number: string;
  entry_date: string;
  description: string;
  total_credit: number;
  created_at: string;
  paid_amount: number;
  outstanding_balance: number;
}

interface SupplierStats {
  totalPOs: number;
  totalPaid: number;
  totalOutstanding: number;
  totalPurchases: number;
  pendingPOs: number;
  manualPayables: number;
  manualPayablesOutstanding: number;
}

export default function SupplierDetailPage() {
  const params = useParams();
  const router = useRouter();
  const supplierId = params.id as string;

  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<SupplierStats>({
    totalPOs: 0, totalPaid: 0, totalOutstanding: 0, totalPurchases: 0, pendingPOs: 0,
    manualPayables: 0, manualPayablesOutstanding: 0
  });
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
  const [manualPayables, setManualPayables] = useState<ManualPayable[]>([]);
  const [purchaseReturns, setPurchaseReturns] = useState<any[]>([]);
  const [grns, setGrns] = useState<any[]>([]);
  const [payments, setPayments] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<'purchase_orders' | 'payables' | 'returns' | 'grns' | 'payments'>('purchase_orders');

  useEffect(() => { loadSupplierData(); }, [supplierId]);

  async function loadSupplierData() {
    setLoading(true);

    const { data: supData } = await supabase
      .from('suppliers')
      .select('*')
      .eq('id', supplierId)
      .single();

    if (!supData) {
      toast({ title: 'Error', description: 'Supplier not found', variant: 'destructive' });
      router.push('/suppliers');
      return;
    }
    setSupplier(supData);

    const [poRes, payableRes, payablePaymentsRes, returnsRes, grnRes, paymentsRes] = await Promise.all([
      supabase.from('purchase_orders').select('*').eq('supplier_id', supplierId).order('created_at', { ascending: false }).limit(50),
      supabase.from('journal_entries').select('id, entry_number, entry_date, description, total_credit, created_at').eq('supplier_id', supplierId).eq('reference_type', 'payable').eq('is_posted', true).order('entry_date', { ascending: false }),
      supabase.from('payments').select('reference_id, amount').eq('reference_type', 'payable'),
      supabase.from('purchase_returns').select('*, purchase_order:purchase_orders(po_number), warehouse:warehouses(name)').eq('supplier_id', supplierId).order('created_at', { ascending: false }).limit(50),
      supabase.from('goods_receipt_notes').select('*, warehouse:warehouses(name), purchase_order:purchase_orders(po_number)').eq('supplier_id', supplierId).order('created_at', { ascending: false }).limit(50),
      supabase.from('payments').select('id, amount, payment_date, payment_method, reference_number, reference_type, created_at').eq('supplier_id', supplierId).order('created_at', { ascending: false }).limit(50),
    ]);

    setPurchaseOrders(poRes.data || []);

    // Calculate manual payables with payments
    const payablePaymentsMap = new Map<string, number>();
    (payablePaymentsRes.data || []).forEach((p: any) => {
      const current = payablePaymentsMap.get(p.reference_id) || 0;
      payablePaymentsMap.set(p.reference_id, current + Number(p.amount));
    });

    const payablesWithPayments: ManualPayable[] = (payableRes.data || []).map((p: any) => {
      const paidAmount = payablePaymentsMap.get(p.id) || 0;
      return {
        ...p,
        paid_amount: paidAmount,
        outstanding_balance: Number(p.total_credit) - paidAmount,
      };
    });

    setManualPayables(payablesWithPayments);

    setPurchaseReturns((returnsRes.data || []).map((r: any) => ({
      ...r,
      purchase_order: Array.isArray(r.purchase_order) ? r.purchase_order[0] : r.purchase_order,
      warehouse: Array.isArray(r.warehouse) ? r.warehouse[0] : r.warehouse,
    })));
    setGrns((grnRes.data || []).map((g: any) => ({
      ...g,
      purchase_order: Array.isArray(g.purchase_order) ? g.purchase_order[0] : g.purchase_order,
      warehouse: Array.isArray(g.warehouse) ? g.warehouse[0] : g.warehouse,
    })));
    setPayments(paymentsRes.data || []);

    const poList = poRes.data || [];
    const totalPaid = poList.reduce((s, po) => s + Number(po.amount_paid), 0);
    const totalOut = poList.reduce((s, po) => s + Number(po.total_amount) - Number(po.amount_paid), 0);
    const pendingPOs = poList.filter(po => po.status === 'pending_approval' || po.status === 'draft').length;
    const manualPayablesOutstanding = payablesWithPayments.reduce((s, p) => s + p.outstanding_balance, 0);

    setStats({
      totalPOs: poList.length,
      totalPaid,
      totalOutstanding: totalOut,
      totalPurchases: supData.total_purchases,
      pendingPOs,
      manualPayables: payablesWithPayments.length,
      manualPayablesOutstanding,
    });

    setLoading(false);
  }

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!supplier) return null;

  const statusConfig: Record<string, { label: string; color: string }> = {
    draft: { label: 'Draft', color: 'bg-gray-100 text-gray-700' },
    pending_approval: { label: 'Pending', color: 'bg-amber-100 text-amber-700' },
    approved: { label: 'Approved', color: 'bg-blue-100 text-blue-700' },
    partially_received: { label: 'Partial', color: 'bg-orange-100 text-orange-700' },
    received: { label: 'Received', color: 'bg-green-100 text-green-700' },
    cancelled: { label: 'Cancelled', color: 'bg-red-100 text-red-700' },
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center gap-4">
        <button onClick={() => router.back()} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-muted transition">
          <ArrowLeft className="w-5 h-5 text-muted-foreground" />
        </button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-foreground">{supplier.name}</h1>
          <p className="text-sm text-muted-foreground">{supplier.code} - {supplier.company_name || supplier.name}</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/purchases?new=1&supplier=${supplier.id}`} className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition">
            <Plus className="w-4 h-4" />New PO
          </Link>
          <Link href={`/purchases/grn?new=1&supplier=${supplier.id}`} className="flex items-center gap-2 px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">
            <Package className="w-4 h-4" />New GRN
          </Link>
          <Link href={`/suppliers?edit=${supplier.id}`} className="flex items-center gap-2 px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">
            <Edit className="w-4 h-4" />Edit
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 space-y-4">
          <div className="bg-white rounded-xl border border-border p-5 shadow-sm">
            <h3 className="text-sm font-semibold mb-4 text-foreground">Contact Information</h3>
            <div className="space-y-3">
              {supplier.phone && (
                <div className="flex items-center gap-3 text-sm">
                  <Phone className="w-4 h-4 text-muted-foreground" />
                  <span className="text-foreground">{supplier.phone}</span>
                </div>
              )}
              {supplier.mobile && (
                <div className="flex items-center gap-3 text-sm">
                  <Phone className="w-4 h-4 text-muted-foreground" />
                  <span className="text-foreground">{supplier.mobile}</span>
                </div>
              )}
              {supplier.email && (
                <div className="flex items-center gap-3 text-sm">
                  <Mail className="w-4 h-4 text-muted-foreground" />
                  <span className="text-foreground">{supplier.email}</span>
                </div>
              )}
              {(supplier.address || supplier.city) && (
                <div className="flex items-start gap-3 text-sm">
                  <MapPin className="w-4 h-4 text-muted-foreground mt-0.5" />
                  <div>
                    {supplier.address && <p className="text-foreground">{supplier.address}</p>}
                    {supplier.city && <p className="text-muted-foreground">{supplier.city}, {supplier.country}</p>}
                  </div>
                </div>
              )}
              {supplier.company_name && (
                <div className="flex items-center gap-3 text-sm">
                  <Building2 className="w-4 h-4 text-muted-foreground" />
                  <span className="text-foreground">{supplier.company_name}</span>
                </div>
              )}
            </div>
          </div>

          <div className="bg-white rounded-xl border border-border p-5 shadow-sm">
            <h3 className="text-sm font-semibold mb-4 text-foreground">Credit & Financial</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground flex items-center gap-2"><CreditCard className="w-4 h-4" />Credit Limit</span>
                <span className="font-semibold text-foreground">{formatCurrency(supplier.credit_limit)}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground flex items-center gap-2"><Calendar className="w-4 h-4" />Credit Days</span>
                <span className="font-semibold text-foreground">{supplier.credit_days} days</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground flex items-center gap-2"><DollarSign className="w-4 h-4" />Outstanding</span>
                <span className="font-semibold text-red-600">{formatCurrency(supplier.outstanding_balance)}</span>
              </div>
              {supplier.rating && supplier.rating > 0 && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground flex items-center gap-2"><Star className="w-4 h-4" />Rating</span>
                  <div className="flex gap-0.5">
                    {Array.from({ length: 5 }).map((_, i) => (
                      <Star key={i} className={`w-3.5 h-3.5 ${i < supplier.rating! ? 'text-amber-400 fill-amber-400' : 'text-gray-300'}`} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="bg-white rounded-xl border border-border p-5 shadow-sm">
            <h3 className="text-sm font-semibold mb-4 text-foreground">Quick Stats</h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-blue-50 rounded-lg p-3 text-center">
                <p className="text-xl font-bold text-blue-600">{stats.totalPOs}</p>
                <p className="text-xs text-blue-700">Purchase Orders</p>
              </div>
              <div className="bg-green-50 rounded-lg p-3 text-center">
                <p className="text-xl font-bold text-green-600">{formatCurrency(stats.totalPaid)}</p>
                <p className="text-xs text-green-700">Total Paid</p>
              </div>
              <div className="bg-red-50 rounded-lg p-3 text-center">
                <p className="text-xl font-bold text-red-600">{formatCurrency(stats.totalOutstanding)}</p>
                <p className="text-xs text-red-700">PO Payables</p>
              </div>
              <div className="bg-purple-50 rounded-lg p-3 text-center">
                <p className="text-xl font-bold text-purple-600">{formatCurrency(stats.manualPayablesOutstanding)}</p>
                <p className="text-xs text-purple-700">Manual Payables</p>
              </div>
              <div className="bg-amber-50 rounded-lg p-3 text-center col-span-2">
                <p className="text-xl font-bold text-amber-600">{stats.pendingPOs}</p>
                <p className="text-xs text-amber-700">Pending POs</p>
              </div>
            </div>
          </div>

          {supplier.notes && (
            <div className="bg-white rounded-xl border border-border p-5 shadow-sm">
              <h3 className="text-sm font-semibold mb-2 text-foreground">Notes</h3>
              <p className="text-sm text-muted-foreground">{supplier.notes}</p>
            </div>
          )}
        </div>

        <div className="lg:col-span-2">
          <div className="bg-white rounded-xl border border-border shadow-sm">
            <div className="flex border-b border-border">
              {[
                { key: 'purchase_orders', label: 'Purchase Orders', icon: Package },
                { key: 'payables', label: 'Manual Payables', icon: Building2 },
                { key: 'returns', label: 'Returns', icon: RotateCcw },
                { key: 'grns', label: 'GRNs', icon: Truck },
                { key: 'payments', label: 'Payments', icon: Receipt },
              ].map(tab => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key as typeof activeTab)}
                  className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition ${
                    activeTab === tab.key
                      ? 'border-blue-600 text-blue-600'
                      : 'border-transparent text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <tab.icon className="w-4 h-4" />
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="p-4">
              {activeTab === 'purchase_orders' && (
                <div className="overflow-x-auto">
                  {purchaseOrders.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground text-sm">
                      <ShoppingBag className="w-10 h-10 mx-auto mb-2 opacity-30" />
                      No purchase orders yet
                    </div>
                  ) : (
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-border">
                          <th className="text-left text-xs font-semibold text-muted-foreground px-3 py-2">PO #</th>
                          <th className="text-left text-xs font-semibold text-muted-foreground px-3 py-2">Date</th>
                          <th className="text-left text-xs font-semibold text-muted-foreground px-3 py-2">Expected</th>
                          <th className="text-right text-xs font-semibold text-muted-foreground px-3 py-2">Amount</th>
                          <th className="text-right text-xs font-semibold text-muted-foreground px-3 py-2">Paid</th>
                          <th className="text-right text-xs font-semibold text-muted-foreground px-3 py-2">Balance</th>
                          <th className="text-left text-xs font-semibold text-muted-foreground px-3 py-2">Status</th>
                          <th className="text-right text-xs font-semibold text-muted-foreground px-3 py-2"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {purchaseOrders.map(po => {
                          const cfg = statusConfig[po.status] || statusConfig.draft;
                          const balance = po.total_amount - po.amount_paid;
                          return (
                            <tr key={po.id} className="hover:bg-muted/30">
                              <td className="px-3 py-2 text-sm font-semibold text-blue-600">{po.po_number}</td>
                              <td className="px-3 py-2 text-sm text-muted-foreground">{formatDate(po.order_date)}</td>
                              <td className="px-3 py-2 text-sm text-muted-foreground">{po.expected_date ? formatDate(po.expected_date) : '-'}</td>
                              <td className="px-3 py-2 text-sm text-right font-semibold">{formatCurrency(po.total_amount)}</td>
                              <td className="px-3 py-2 text-sm text-right text-green-600">{formatCurrency(po.amount_paid)}</td>
                              <td className="px-3 py-2 text-sm text-right text-red-600 font-bold">{formatCurrency(balance)}</td>
                              <td className="px-3 py-2">
                                <span className={`badge-status ${cfg.color}`}>{cfg.label}</span>
                              </td>
                              <td className="px-3 py-2 text-right">
                                <Link href={`/purchases?view=${po.id}`} className="w-7 h-7 inline-flex items-center justify-center rounded-lg hover:bg-blue-50 text-muted-foreground hover:text-blue-600">
                                  <Eye className="w-3.5 h-3.5" />
                                </Link>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {activeTab === 'payables' && (
                <div className="overflow-x-auto">
                  {manualPayables.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground text-sm">
                      <Building2 className="w-10 h-10 mx-auto mb-2 opacity-30" />
                      No manual payables
                    </div>
                  ) : (
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-border">
                          <th className="text-left text-xs font-semibold text-muted-foreground px-3 py-2">Entry #</th>
                          <th className="text-left text-xs font-semibold text-muted-foreground px-3 py-2">Date</th>
                          <th className="text-left text-xs font-semibold text-muted-foreground px-3 py-2">Description</th>
                          <th className="text-right text-xs font-semibold text-muted-foreground px-3 py-2">Amount</th>
                          <th className="text-right text-xs font-semibold text-muted-foreground px-3 py-2">Paid</th>
                          <th className="text-right text-xs font-semibold text-muted-foreground px-3 py-2">Outstanding</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {manualPayables.map(pay => (
                          <tr key={pay.id} className="hover:bg-muted/30">
                            <td className="px-3 py-2 text-sm font-semibold text-blue-600">{pay.entry_number}</td>
                            <td className="px-3 py-2 text-sm text-muted-foreground">{formatDate(pay.entry_date)}</td>
                            <td className="px-3 py-2 text-sm text-foreground">{pay.description}</td>
                            <td className="px-3 py-2 text-sm text-right font-semibold">{formatCurrency(pay.total_credit)}</td>
                            <td className="px-3 py-2 text-sm text-right text-green-600">{formatCurrency(pay.paid_amount)}</td>
                            <td className="px-3 py-2 text-sm text-right text-red-600 font-bold">{formatCurrency(pay.outstanding_balance)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {activeTab === 'returns' && (
                <div className="overflow-x-auto">
                  {purchaseReturns.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground text-sm">
                      <RotateCcw className="w-10 h-10 mx-auto mb-2 opacity-30" />
                      No purchase returns
                    </div>
                  ) : (
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-border">
                          <th className="text-left text-xs font-semibold text-muted-foreground px-3 py-2">Return #</th>
                          <th className="text-left text-xs font-semibold text-muted-foreground px-3 py-2">PO #</th>
                          <th className="text-left text-xs font-semibold text-muted-foreground px-3 py-2">Warehouse</th>
                          <th className="text-left text-xs font-semibold text-muted-foreground px-3 py-2">Date</th>
                          <th className="text-right text-xs font-semibold text-muted-foreground px-3 py-2">Amount</th>
                          <th className="text-left text-xs font-semibold text-muted-foreground px-3 py-2">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {purchaseReturns.map((r: any) => (
                          <tr key={r.id} className="hover:bg-muted/30">
                            <td className="px-3 py-2 text-sm font-semibold text-orange-600">{r.return_number}</td>
                            <td className="px-3 py-2 text-sm text-muted-foreground">{r.purchase_order?.po_number || 'Direct'}</td>
                            <td className="px-3 py-2 text-sm text-foreground">{r.warehouse?.name || '—'}</td>
                            <td className="px-3 py-2 text-sm text-muted-foreground">{formatDate(r.return_date)}</td>
                            <td className="px-3 py-2 text-sm text-right font-semibold">{formatCurrency(r.total_amount)}</td>
                            <td className="px-3 py-2">
                              <span className={`badge-status ${r.status === 'completed' ? 'bg-green-100 text-green-700' : r.status === 'pending' ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>{r.status}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {activeTab === 'grns' && (
                <div className="overflow-x-auto">
                  {grns.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground text-sm">
                      <Truck className="w-10 h-10 mx-auto mb-2 opacity-30" />
                      No goods receipt notes
                    </div>
                  ) : (
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-border">
                          <th className="text-left text-xs font-semibold text-muted-foreground px-3 py-2">GRN #</th>
                          <th className="text-left text-xs font-semibold text-muted-foreground px-3 py-2">PO #</th>
                          <th className="text-left text-xs font-semibold text-muted-foreground px-3 py-2">Warehouse</th>
                          <th className="text-left text-xs font-semibold text-muted-foreground px-3 py-2">Date</th>
                          <th className="text-left text-xs font-semibold text-muted-foreground px-3 py-2">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {grns.map((g: any) => (
                          <tr key={g.id} className="hover:bg-muted/30">
                            <td className="px-3 py-2 text-sm font-semibold text-blue-600">{g.grn_number}</td>
                            <td className="px-3 py-2 text-sm text-muted-foreground">{g.purchase_order?.po_number || 'Direct'}</td>
                            <td className="px-3 py-2 text-sm text-foreground">{g.warehouse?.name || '—'}</td>
                            <td className="px-3 py-2 text-sm text-muted-foreground">{formatDate(g.received_date)}</td>
                            <td className="px-3 py-2">
                              <span className={`badge-status ${g.status === 'posted' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-700'}`}>{g.status}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {activeTab === 'payments' && (
                <div className="overflow-x-auto">
                  {payments.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground text-sm">
                      <Receipt className="w-10 h-10 mx-auto mb-2 opacity-30" />
                      No payments recorded
                    </div>
                  ) : (
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-border">
                          <th className="text-left text-xs font-semibold text-muted-foreground px-3 py-2">Date</th>
                          <th className="text-right text-xs font-semibold text-muted-foreground px-3 py-2">Amount</th>
                          <th className="text-left text-xs font-semibold text-muted-foreground px-3 py-2">Method</th>
                          <th className="text-left text-xs font-semibold text-muted-foreground px-3 py-2">Reference</th>
                          <th className="text-left text-xs font-semibold text-muted-foreground px-3 py-2">Type</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {payments.map((p: any) => (
                          <tr key={p.id} className="hover:bg-muted/30">
                            <td className="px-3 py-2 text-sm text-muted-foreground">{formatDate(p.payment_date || p.created_at)}</td>
                            <td className="px-3 py-2 text-sm text-right font-semibold text-green-600">{formatCurrency(p.amount)}</td>
                            <td className="px-3 py-2 text-sm text-foreground capitalize">{p.payment_method?.replace(/_/g, ' ') || '—'}</td>
                            <td className="px-3 py-2 text-sm text-muted-foreground">{p.reference_number || '—'}</td>
                            <td className="px-3 py-2 text-sm text-foreground capitalize">{p.reference_type?.replace(/_/g, ' ') || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
