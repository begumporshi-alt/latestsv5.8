'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCurrency, formatDate } from '@/lib/format';
import { toast } from '@/hooks/use-toast';
import { ArrowLeft, Search, RefreshCw, Plus, X, Package, FileText, Truck, CircleCheck as CheckCircle, Eye, Printer, ArrowRightLeft, TrendingUp } from 'lucide-react';
import Link from 'next/link';
import type { Supplier } from '@/lib/types';

interface PurchaseOrder {
  id: string;
  po_number: string;
  supplier_id: string;
  status: string;
  order_date: string;
  total_amount: number;
  amount_paid: number;
  supplier?: { name: string; code: string };
}

interface PurchaseOrderItem {
  id: string;
  purchase_order_id: string;
  product_id: string;
  product: { name: string; sku: string; unit: string };
  quantity: number;
  received_quantity: number;
  unit_cost: number;
  subtotal: number;
}

interface PurchaseReturn {
  id: string;
  return_number: string;
  purchase_order_id: string | null;
  supplier_id: string;
  warehouse_id: string | null;
  return_date: string;
  total_amount: number;
  status: string;
  notes: string;
  created_at: string;
  purchase_order?: { po_number: string };
  supplier?: { name: string };
  warehouse?: { name: string };
}

interface PurchaseReturnItem {
  id: string;
  product_id: string;
  quantity: number;
  unit_cost: number;
  subtotal: number;
  reason: string;
  product?: { name: string; sku: string; unit: string };
}

export default function PurchaseReturnsPage() {
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
  const [returns, setReturns] = useState<PurchaseReturn[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [showViewModal, setShowViewModal] = useState(false);
  const [viewingReturn, setViewingReturn] = useState<PurchaseReturn | null>(null);
  const [viewItems, setViewItems] = useState<PurchaseReturnItem[]>([]);
  const [stats, setStats] = useState({ total: 0, completed: 0, totalValue: 0 });

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);
    const [poRes, retRes] = await Promise.all([
      supabase.from('purchase_orders').select('*, supplier:suppliers(name, code)').in('status', ['received', 'partially_received']).order('order_date', { ascending: false }),
      supabase.from('purchase_returns')
        .select('*, purchase_order:purchase_orders(po_number), supplier:suppliers(name), warehouse:warehouses(name)')
        .order('created_at', { ascending: false }),
    ]);

    setPurchaseOrders(poRes.data || []);
    const retData = (retRes.data || []).map((r: any) => ({
      ...r,
      purchase_order: Array.isArray(r.purchase_order) ? r.purchase_order[0] : r.purchase_order,
      supplier: Array.isArray(r.supplier) ? r.supplier[0] : r.supplier,
      warehouse: Array.isArray(r.warehouse) ? r.warehouse[0] : r.warehouse,
    }));
    setReturns(retData);
    setStats({
      total: retData.length,
      completed: retData.filter((r: any) => r.status === 'completed').length,
      totalValue: retData.reduce((s: number, r: any) => s + Number(r.total_amount), 0),
    });
    setLoading(false);
  }

  const filteredReturns = returns.filter(r =>
    !search ||
    r.return_number.toLowerCase().includes(search.toLowerCase()) ||
    r.supplier?.name?.toLowerCase().includes(search.toLowerCase()) ||
    r.purchase_order?.po_number?.toLowerCase().includes(search.toLowerCase())
  );

  async function handleViewReturn(ret: PurchaseReturn) {
    const { data: items } = await supabase
      .from('purchase_return_items')
      .select('*, product:products(name, sku, unit)')
      .eq('purchase_return_id', ret.id);
    setViewItems((items || []).map((it: any) => ({
      ...it,
      product: Array.isArray(it.product) ? it.product[0] : it.product,
    })));
    setViewingReturn(ret);
    setShowViewModal(true);
  }

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/purchases" className="w-8 h-8 flex items-center justify-center rounded-lg border border-border hover:bg-muted transition">
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-foreground">Purchase Returns</h1>
            <p className="text-muted-foreground text-sm mt-0.5">Return items to suppliers</p>
          </div>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition"
        >
          <Plus className="w-4 h-4" />
          New Return
        </button>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[
          { label: 'Total Returns', value: stats.total, icon: Truck, color: 'text-orange-500 bg-orange-50' },
          { label: 'Completed', value: stats.completed, icon: CheckCircle, color: 'text-green-500 bg-green-50' },
          { label: 'Return Value', value: formatCurrency(stats.totalValue), icon: TrendingUp, color: 'text-red-500 bg-red-50' },
        ].map(s => (
          <div key={s.label} className="stat-card flex items-center gap-3">
            <div className={`w-10 h-10 rounded-full flex items-center justify-center ${s.color} shrink-0`}><s.icon className="w-5 h-5" /></div>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground whitespace-nowrap">{s.label}</p>
              <p className="text-lg font-bold text-foreground whitespace-nowrap">{s.value}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-border p-4 shadow-sm flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by return #, supplier, or PO #..."
            className="w-full pl-8 pr-4 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          />
        </div>
        <button onClick={loadData} className="flex items-center gap-2 border border-border rounded-lg px-3 py-2 text-sm hover:bg-muted transition">
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </button>
      </div>

      {/* Returns Table */}
      <div className="table-wrapper">
        <table className="w-full">
          <thead>
            <tr className="bg-muted/40 border-b border-border">
              <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Return #</th>
              <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Supplier</th>
              <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">PO #</th>
              <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Warehouse</th>
              <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Date</th>
              <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Amount</th>
              <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Status</th>
              <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: 8 }).map((_, j) => <td key={j} className="px-4 py-3"><div className="h-4 bg-muted rounded animate-pulse" /></td>)}
                </tr>
              ))
            ) : filteredReturns.length === 0 ? (
              <tr><td colSpan={8} className="px-4 py-12 text-center text-muted-foreground text-sm">No purchase returns recorded yet</td></tr>
            ) : filteredReturns.map(r => (
              <tr key={r.id} className="hover:bg-muted/30 transition-colors">
                <td className="px-4 py-3 text-sm font-semibold text-orange-600">{r.return_number}</td>
                <td className="px-4 py-3 text-sm text-foreground">{r.supplier?.name || '—'}</td>
                <td className="px-4 py-3 text-sm text-muted-foreground">{r.purchase_order?.po_number || 'Direct'}</td>
                <td className="px-4 py-3 text-sm text-foreground">{r.warehouse?.name || '—'}</td>
                <td className="px-4 py-3 text-sm text-muted-foreground">{formatDate(r.return_date)}</td>
                <td className="px-4 py-3 text-right text-sm font-bold text-foreground">{formatCurrency(r.total_amount)}</td>
                <td className="px-4 py-3">
                  <span className={`badge-status ${r.status === 'completed' ? 'bg-green-50 text-green-600' : r.status === 'pending' ? 'bg-amber-50 text-amber-600' : 'bg-red-50 text-red-600'}`}>
                    {r.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-1">
                    <button onClick={() => handleViewReturn(r)} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-blue-50 text-muted-foreground hover:text-blue-600 transition" title="View Details">
                      <Eye className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => handleViewReturn(r)} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition" title="Print" onClickCapture={() => setTimeout(() => window.print(), 200)}>
                      <Printer className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <ReturnModal
          purchaseOrders={purchaseOrders}
          onClose={() => setShowModal(false)}
          onSaved={loadData}
        />
      )}

      {showViewModal && viewingReturn && (
        <ViewReturnModal
          returnData={viewingReturn}
          items={viewItems}
          onClose={() => setShowViewModal(false)}
        />
      )}
    </div>
  );
}

function ReturnModal({ purchaseOrders, onClose, onSaved }: {
  purchaseOrders: PurchaseOrder[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [step, setStep] = useState(1);
  const [selectedPO, setSelectedPO] = useState<PurchaseOrder | null>(null);
  const [items, setItems] = useState<PurchaseOrderItem[]>([]);
  const [returnItems, setReturnItems] = useState<Record<string, { qty: number; reason: string }>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  async function selectPO(po: PurchaseOrder) {
    setSelectedPO(po);
    const { data } = await supabase
      .from('purchase_order_items')
      .select('*, product:products(name, sku, unit)')
      .eq('purchase_order_id', po.id);
    setItems((data || []).map((it: any) => ({
      ...it,
      product: Array.isArray(it.product) ? it.product[0] : it.product,
    })));
    setStep(2);
  }
  const filteredPOs = purchaseOrders.filter(po =>
    !search ||
    po.po_number.toLowerCase().includes(search.toLowerCase()) ||
    po.supplier?.name?.toLowerCase().includes(search.toLowerCase())
  );

  async function handleReturn() {
    if (!selectedPO) return;

    const itemsToReturn = Object.entries(returnItems).filter(([_, v]) => v.qty > 0);
    if (itemsToReturn.length === 0) {
      setError('Please select at least one item to return');
      return;
    }

    setSaving(true);
    setError('');

    try {
      const returnId = crypto.randomUUID();
      const returnNumber = `PRET-${Date.now().toString().slice(-6)}`;
      let totalRefund = 0;

      // Get default warehouse as fallback
      const { data: defWarehouse } = await supabase
        .from('warehouses')
        .select('id')
        .eq('is_default', true)
        .maybeSingle();
      const defaultWarehouseId = defWarehouse?.id || '11000000-0000-0000-0000-000000000001';

      // Fetch the PO to get subtotal and total_amount for net-cost calculation
      const { data: poRecord } = await supabase
        .from('purchase_orders')
        .select('subtotal, total_amount, discount_amount')
        .eq('id', selectedPO.id)
        .maybeSingle();

      const poSubtotal = Number(poRecord?.subtotal || 0);
      const poTotal = Number(poRecord?.total_amount || 0);
      // Net cost ratio: if subtotal is 0 or no discount, ratio is 1 (use gross unit_cost)
      const netCostRatio = poSubtotal > 0 ? (poTotal / poSubtotal) : 1;

      // Build return items for insertion
      const returnItemRows: any[] = [];
      for (const [itemId, { qty, reason }] of itemsToReturn) {
        const item = items.find(i => i.id === itemId);
        if (!item) continue;

        // Calculate net refund: qty * unit_cost * (poTotal / poSubtotal)
        // This proportionally accounts for all discounts (line + cart + extra)
        const grossAmount = qty * item.unit_cost;
        const refundAmount = grossAmount * netCostRatio;
        totalRefund += refundAmount;

        // Use the PO item's warehouse, fall back to default
        const itemWarehouseId = (item as any).warehouse_id || defaultWarehouseId;

        returnItemRows.push({
          purchase_return_id: returnId,
          product_id: item.product_id,
          quantity: qty,
          unit_cost: item.unit_cost,
          subtotal: refundAmount,
          reason: reason || 'other',
        });

        // Create stock movement for return out
        await supabase.from('stock_movements').insert({
          tenant_id: '00000000-0000-0000-0000-000000000001',
          product_id: item.product_id,
          warehouse_id: itemWarehouseId,
          movement_type: 'return_out',
          quantity: -qty,
          unit_cost: item.unit_cost,
          reference_type: 'purchase_return',
          reference_id: returnId,
          reference_number: returnNumber,
          notes: reason || `Return to supplier from PO ${selectedPO.po_number}`,
        });

        // Reverse FIFO batches (reduce youngest batches first)
        await supabase.rpc('reverse_fifo_on_purchase_return', {
          p_product_id: item.product_id,
          p_warehouse_id: itemWarehouseId,
          p_quantity: qty,
          p_unit_cost: item.unit_cost,
          p_reference_id: returnId,
          p_reference_number: returnNumber,
        });

        // Update inventory - reduce stock from the correct warehouse
        const { data: invItem } = await supabase
          .from('inventory_items')
          .select('id, quantity_on_hand')
          .eq('product_id', item.product_id)
          .eq('warehouse_id', itemWarehouseId)
          .maybeSingle();

        if (invItem) {
          await supabase.from('inventory_items').update({
            quantity_on_hand: Math.max(0, invItem.quantity_on_hand - qty),
            updated_at: new Date().toISOString(),
          }).eq('id', invItem.id);
        }

        // Update received quantity on PO item (fall back to quantity if received_quantity was 0)
        const currentReceived = Number(item.received_quantity) || Number(item.quantity);
        await supabase.from('purchase_order_items').update({
          received_quantity: Math.max(0, currentReceived - qty),
        }).eq('id', item.id);
      }

      // Create the purchase_returns record
      // The database trigger (trg_purchase_return_accounting) will post the journal entry automatically
      const { error: returnError } = await supabase.from('purchase_returns').insert({
        id: returnId,
        return_number: returnNumber,
        purchase_order_id: selectedPO.id,
        supplier_id: selectedPO.supplier_id,
        warehouse_id: defaultWarehouseId,
        return_date: new Date().toISOString().split('T')[0],
        total_amount: totalRefund,
        status: 'completed',
      });

      if (returnError) throw new Error(returnError.message);

      // Insert return items
      await supabase.from('purchase_return_items').insert(returnItemRows);

      // Adjust supplier outstanding balance (return creates a credit with supplier)
      // Do NOT reduce amount_paid — that was actual cash paid. The return reduces what we OWE.
      const { data: supplier } = await supabase
        .from('suppliers')
        .select('outstanding_balance')
        .eq('id', selectedPO.supplier_id)
        .maybeSingle();
      if (supplier) {
        await supabase.from('suppliers').update({
          outstanding_balance: Math.max(0, (supplier.outstanding_balance || 0) - totalRefund),
          updated_at: new Date().toISOString(),
        }).eq('id', selectedPO.supplier_id);
      }

      toast({ title: 'Success', description: `Return processed. Credit Note: ${formatCurrency(totalRefund)}` });
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-2xl shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-white">
          <h2 className="text-base font-bold">Process Purchase Return</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-6">
          {error && <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm mb-4">{error}</div>}

          {step === 1 && (
            <div className="space-y-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search purchase orders..."
                  className="w-full pl-8 pr-4 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
              </div>
              <div className="max-h-[400px] overflow-y-auto space-y-2">
                {filteredPOs.map(po => (
                  <div
                    key={po.id}
                    onClick={() => selectPO(po)}
                    className="p-4 border border-border rounded-lg cursor-pointer hover:border-blue-300 hover:bg-blue-50/50 transition"
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-semibold text-foreground">{po.po_number}</p>
                        <p className="text-sm text-muted-foreground">{po.supplier?.name || 'Unknown Supplier'}</p>
                      </div>
                      <div className="text-right">
                        <p className="font-bold text-foreground">{formatCurrency(po.total_amount)}</p>
                        <p className="text-xs text-muted-foreground">{formatDate(po.order_date)}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {step === 2 && selectedPO && (
            <div className="space-y-4">
              <div className="p-3 bg-muted/50 rounded-lg">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold text-foreground">{selectedPO.po_number}</p>
                    <p className="text-sm text-muted-foreground">{selectedPO.supplier?.name || 'Unknown Supplier'}</p>
                  </div>
                  <p className="font-bold">{formatCurrency(selectedPO.total_amount)}</p>
                </div>
              </div>

              <div className="border-t border-border pt-4">
                <h4 className="text-sm font-medium mb-3">Select items to return:</h4>
                <div className="space-y-2">
                  {items.map(item => (
                    <div key={item.id} className="p-3 border border-border rounded-lg">
                      <div className="flex items-center justify-between mb-2">
                        <div>
                          <p className="font-medium text-foreground text-sm">{item.product?.name}</p>
                          <p className="text-xs text-muted-foreground">SKU: {item.product?.sku} | Received: {item.received_quantity || item.quantity}</p>
                        </div>
                        <p className="font-semibold">{formatCurrency(item.unit_cost)}/unit</p>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="flex-1">
                          <label className="text-xs text-muted-foreground">Return Qty (max: {item.received_quantity || item.quantity})</label>
                          <input
                            type="number"
                            min="0"
                            max={item.received_quantity || item.quantity}
                            value={returnItems[item.id]?.qty || 0}
                            onChange={e => setReturnItems({
                              ...returnItems,
                              [item.id]: { qty: Number(e.target.value), reason: returnItems[item.id]?.reason || '' }
                            })}
                            className="w-full border border-border rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                          />
                        </div>
                        <div className="flex-[2]">
                          <label className="text-xs text-muted-foreground">Reason</label>
                          <select
                            value={returnItems[item.id]?.reason || ''}
                            onChange={e => setReturnItems({
                              ...returnItems,
                              [item.id]: { qty: returnItems[item.id]?.qty || 0, reason: e.target.value }
                            })}
                            className="w-full border border-border rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                          >
                            <option value="">Select reason</option>
                            <option value="defective">Defective</option>
                            <option value="wrong_item">Wrong Item</option>
                            <option value="quality_issue">Quality Issue</option>
                            <option value="overstock">Overstock</option>
                            <option value="other">Other</option>
                          </select>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between pt-4 border-t border-border">
                <button onClick={() => setStep(1)} className="px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">
                  Back
                </button>
                <button
                  onClick={handleReturn}
                  disabled={saving}
                  className="flex items-center gap-2 px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-60"
                >
                  {saving ? 'Processing...' : <>
                    <Truck className="w-4 h-4" />
                    Process Return
                  </>}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ViewReturnModal({ returnData, items, onClose }: {
  returnData: PurchaseReturn;
  items: PurchaseReturnItem[];
  onClose: () => void;
}) {
  const totalValue = items.reduce((sum, item) => sum + item.subtotal, 0);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="print-modal bg-white rounded-2xl w-full max-w-2xl shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-white no-print">
          <h2 className="text-base font-bold">Return Details — {returnData.return_number}</h2>
          <div className="flex items-center gap-2">
            <button onClick={() => window.print()} className="flex items-center gap-1 px-3 py-1.5 border border-border rounded-lg text-sm hover:bg-muted transition">
              <Printer className="w-4 h-4" />Print
            </button>
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {/* Info grid */}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div className="space-y-2">
              <div className="flex justify-between"><span className="text-muted-foreground">Supplier</span><span className="font-medium text-foreground">{returnData.supplier?.name || '—'}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">PO Number</span><span className="font-medium text-foreground">{returnData.purchase_order?.po_number || 'Direct'}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Warehouse</span><span className="font-medium text-foreground">{returnData.warehouse?.name || '—'}</span></div>
            </div>
            <div className="space-y-2">
              <div className="flex justify-between"><span className="text-muted-foreground">Return Date</span><span className="font-medium text-foreground">{formatDate(returnData.return_date)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Status</span>
                <span className={`badge-status ${returnData.status === 'completed' ? 'bg-green-50 text-green-600' : returnData.status === 'pending' ? 'bg-amber-50 text-amber-600' : 'bg-red-50 text-red-600'}`}>{returnData.status}</span>
              </div>
              {returnData.notes && <div className="flex justify-between"><span className="text-muted-foreground">Notes</span><span className="font-medium text-foreground text-right">{returnData.notes}</span></div>}
            </div>
          </div>

          {/* Items table */}
          <div className="border border-border rounded-lg overflow-hidden">
            <table className="w-full">
              <thead className="bg-muted/40">
                <tr>
                  <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-2">Product</th>
                  <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-2">SKU</th>
                  <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-2">Qty</th>
                  <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-2">Unit Cost</th>
                  <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-2">Reason</th>
                  <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-2">Subtotal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {items.length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-6 text-center text-sm text-muted-foreground">No items found</td></tr>
                ) : items.map((item) => (
                  <tr key={item.id}>
                    <td className="px-4 py-2 text-sm text-foreground">{item.product?.name || '—'}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground font-mono">{item.product?.sku || '—'}</td>
                    <td className="px-4 py-2 text-sm text-right text-foreground">{item.quantity}</td>
                    <td className="px-4 py-2 text-sm text-right text-foreground">{formatCurrency(item.unit_cost)}</td>
                    <td className="px-4 py-2 text-sm text-foreground capitalize">{item.reason.replace(/_/g, ' ')}</td>
                    <td className="px-4 py-2 text-sm text-right font-semibold text-foreground">{formatCurrency(item.subtotal)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-muted/30">
                <tr>
                  <td colSpan={5} className="px-4 py-2 text-sm font-semibold text-right text-foreground">Total Credit</td>
                  <td className="px-4 py-2 text-sm text-right font-bold text-foreground">{formatCurrency(totalValue)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
