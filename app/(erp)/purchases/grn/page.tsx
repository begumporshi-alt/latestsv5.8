'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { formatCurrency, formatDate } from '@/lib/format';
import { toast } from '@/hooks/use-toast';
import { Plus, Search, RefreshCw, X, Package, CircleCheck as CheckCircle, Eye, Printer, TrendingUp } from 'lucide-react';
import type { Supplier, Warehouse } from '@/lib/types';

interface PurchaseOrder {
  id: string;
  po_number: string;
  supplier_id: string;
  supplier?: { name: string };
  status: string;
  total_amount: number;
}

interface PurchaseOrderItem {
  id: string;
  product_id: string;
  product: { name: string; sku: string; unit: string };
  quantity: number;
  received_quantity: number;
  unit_cost: number;
}

interface GRN {
  id: string;
  grn_number: string;
  supplier_id: string;
  purchase_order_id: string;
  warehouse_id: string;
  received_date: string;
  status: string;
  notes: string;
  supplier?: { name: string };
  purchase_order?: { po_number: string };
  warehouse?: { name: string };
}

interface GRNItem {
  id: string;
  product_id: string;
  quantity: number;
  unit_cost: number;
  product?: { name: string; sku: string; unit: string };
}

export default function GRNPage() {
  const searchParams = useSearchParams();
  const [grns, setGrns] = useState<GRN[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [viewingGRN, setViewingGRN] = useState<GRN | null>(null);
  const [grnItems, setGrnItems] = useState<GRNItem[]>([]);
  const [stats, setStats] = useState({ total: 0, posted: 0, verified: 0, totalValue: 0 });

  useEffect(() => {
    loadGRNs();
    // Auto-open the create modal if redirected with ?poId= (from PO page
    // "Mark as Received") or ?new=1 (from the supplier profile's New GRN
    // button, which also passes ?supplier= for direct-mode prefill)
    if (searchParams.get('poId') || searchParams.get('new')) {
      setShowModal(true);
    }
  }, []);

  async function loadGRNs() {
    setLoading(true);
    const { data } = await supabase
      .from('goods_receipt_notes')
      .select('*, supplier:suppliers(name), purchase_order:purchase_orders(po_number), warehouse:warehouses(name)')
      .order('created_at', { ascending: false });
    setGrns(data || []);

    const all = data || [];
    // Fetch stock movements linked to GRNs to compute total value
    const grnIds = all.map((g: any) => g.id);
    let totalValue = 0;
    if (grnIds.length > 0) {
      const { data: movements } = await supabase
        .from('stock_movements')
        .select('quantity, unit_cost')
        .in('reference_id', grnIds)
        .eq('movement_type', 'purchase');
      totalValue = (movements || []).reduce((s: number, m: any) => s + Math.abs(Number(m.quantity)) * Number(m.unit_cost || 0), 0);
    }

    setStats({
      total: all.length,
      posted: all.filter((g: any) => g.status === 'posted').length,
      verified: all.filter((g: any) => g.status === 'verified').length,
      totalValue,
    });
    setLoading(false);
  }

  async function viewGRNDetails(grn: GRN) {
    const { data } = await supabase
      .from('stock_movements')
      .select('quantity, unit_cost, product:products(name, sku, unit)')
      .eq('reference_id', grn.id)
      .eq('movement_type', 'purchase');
    setGrnItems((data || []).map((m: any) => ({
      id: m.id || crypto.randomUUID(),
      product_id: '',
      quantity: Math.abs(Number(m.quantity)),
      unit_cost: Number(m.unit_cost),
      product: m.product,
    })));
    setViewingGRN(grn);
  }

  const filtered = grns.filter(g =>
    !search || g.grn_number.toLowerCase().includes(search.toLowerCase()) || g.supplier?.name?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Goods Receipt Notes</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Record and verify incoming stock</p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition"
        >
          <Plus className="w-4 h-4" />
          New GRN
        </button>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Total GRNs', value: stats.total, icon: Package, color: 'text-blue-500 bg-blue-50' },
          { label: 'Posted', value: stats.posted, icon: CheckCircle, color: 'text-green-500 bg-green-50' },
          { label: 'Verified', value: stats.verified, icon: CheckCircle, color: 'text-teal-500 bg-teal-50' },
          { label: 'Total Value', value: formatCurrency(stats.totalValue), icon: TrendingUp, color: 'text-purple-500 bg-purple-50' },
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
            placeholder="Search GRNs..."
            className="w-full pl-8 pr-4 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          />
        </div>
        <button onClick={loadGRNs} className="flex items-center gap-2 border border-border rounded-lg px-3 py-2 text-sm hover:bg-muted transition">
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </button>
      </div>

      <div className="table-wrapper">
        <table className="w-full">
          <thead>
            <tr className="bg-muted/40 border-b border-border">
              <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">GRN #</th>
              <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Supplier</th>
              <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">PO #</th>
              <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Warehouse</th>
              <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Date</th>
              <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Status</th>
              <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: 7 }).map((_, j) => (
                    <td key={j} className="px-4 py-3"><div className="h-4 bg-muted rounded animate-pulse" /></td>
                  ))}
                </tr>
              ))
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground text-sm">No GRNs recorded yet</td>
              </tr>
            ) : (
              filtered.map(g => (
                <tr key={g.id} className="hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-3 text-sm font-semibold text-blue-600">{g.grn_number}</td>
                  <td className="px-4 py-3 text-sm text-foreground">{g.supplier?.name || '—'}</td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{g.purchase_order?.po_number || 'Direct'}</td>
                  <td className="px-4 py-3 text-sm text-foreground">{g.warehouse?.name || '—'}</td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{formatDate(g.received_date)}</td>
                  <td className="px-4 py-3">
                    <span className={`badge-status ${g.status === 'posted' ? 'bg-green-50 text-green-600' : g.status === 'verified' ? 'bg-blue-50 text-blue-600' : 'bg-gray-100 text-gray-600'}`}>
                      {g.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => viewGRNDetails(g)} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-blue-50 text-muted-foreground hover:text-blue-600 transition" title="View Details">
                        <Eye className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => viewGRNDetails(g)} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition" title="Print" onClickCapture={() => setTimeout(() => window.print(), 100)}>
                        <Printer className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {showModal && (
        <GRNModal onClose={() => setShowModal(false)} onSaved={loadGRNs} />
      )}

      {viewingGRN && (
        <ViewGRNModal
          grn={viewingGRN}
          items={grnItems}
          onClose={() => setViewingGRN(null)}
        />
      )}
    </div>
  );
}

function ViewGRNModal({ grn, items, onClose }: { grn: GRN; items: GRNItem[]; onClose: () => void }) {
  const totalValue = items.reduce((sum, item) => sum + item.quantity * item.unit_cost, 0);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="print-modal bg-white rounded-2xl w-full max-w-2xl shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-white no-print">
          <h2 className="text-base font-bold">GRN {grn.grn_number}</h2>
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
              <div className="flex justify-between"><span className="text-muted-foreground">Supplier</span><span className="font-medium text-foreground">{grn.supplier?.name || '—'}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">PO Number</span><span className="font-medium text-foreground">{grn.purchase_order?.po_number || 'Direct'}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Warehouse</span><span className="font-medium text-foreground">{grn.warehouse?.name || '—'}</span></div>
            </div>
            <div className="space-y-2">
              <div className="flex justify-between"><span className="text-muted-foreground">Received Date</span><span className="font-medium text-foreground">{formatDate(grn.received_date)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Status</span>
                <span className={`badge-status ${grn.status === 'posted' ? 'bg-green-50 text-green-600' : grn.status === 'verified' ? 'bg-blue-50 text-blue-600' : 'bg-gray-100 text-gray-600'}`}>{grn.status}</span>
              </div>
              {grn.notes && <div className="flex justify-between"><span className="text-muted-foreground">Notes</span><span className="font-medium text-foreground text-right">{grn.notes}</span></div>}
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
                  <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-2">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {items.length === 0 ? (
                  <tr><td colSpan={5} className="px-4 py-6 text-center text-sm text-muted-foreground">No items found</td></tr>
                ) : items.map((item, i) => (
                  <tr key={i}>
                    <td className="px-4 py-2 text-sm text-foreground">{item.product?.name || '—'}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground font-mono">{item.product?.sku || '—'}</td>
                    <td className="px-4 py-2 text-sm text-right text-foreground">{item.quantity}</td>
                    <td className="px-4 py-2 text-sm text-right text-foreground">{formatCurrency(item.unit_cost)}</td>
                    <td className="px-4 py-2 text-sm text-right font-semibold text-foreground">{formatCurrency(item.quantity * item.unit_cost)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-muted/30">
                <tr>
                  <td colSpan={4} className="px-4 py-2 text-sm font-semibold text-right text-foreground">Total Value</td>
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

function GRNModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const searchParams = useSearchParams();
  const [step, setStep] = useState(1);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
  const [selectedPO, setSelectedPO] = useState<PurchaseOrder | null>(null);
  const [items, setItems] = useState<PurchaseOrderItem[]>([]);
  const [receiveItems, setReceiveItems] = useState<Record<string, number>>({});
  const [directMode, setDirectMode] = useState(false);
  const [directSupplier, setDirectSupplier] = useState('');
  const [directWarehouse, setDirectWarehouse] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  async function selectPO(po: PurchaseOrder) {
    setSelectedPO(po);
    const { data } = await supabase
      .from('purchase_order_items')
      .select('*, product:products(name, sku, unit)')
      .eq('purchase_order_id', po.id);
    setItems(data || []);
    const initReceive: Record<string, number> = {};
    (data || []).forEach((item: any) => {
      initReceive[item.id] = Math.max(0, Number(item.quantity) - Number(item.received_quantity));
    });
    setReceiveItems(initReceive);
    setStep(2);
  }

  useEffect(() => {
    async function load() {
      const [supRes, whRes, poRes] = await Promise.all([
        supabase.from('suppliers').select('*').eq('is_active', true).order('name'),
        supabase.from('warehouses').select('*').eq('is_active', true).order('is_default', { ascending: false }),
        supabase.from('purchase_orders').select('id, po_number, supplier_id, status, total_amount, supplier:suppliers(name)').in('status', ['approved', 'partially_received']).order('order_date', { ascending: false }),
      ]);
      setSuppliers(supRes.data || []);
      setWarehouses(whRes.data || []);
      setPurchaseOrders((poRes.data || []).map((po: any) => ({
        ...po,
        supplier: Array.isArray(po.supplier) ? po.supplier[0] : po.supplier,
      })));

      // Pre-fill from ?poId= query param (redirected from PO page "Mark as Received")
      const prefillPOId = searchParams.get('poId');
      if (prefillPOId) {
        // First check if it's already in the loaded list
        const inList = (poRes.data || []).find((po: any) => po.id === prefillPOId);
        if (inList) {
          await selectPO({
            ...inList,
            supplier: Array.isArray(inList.supplier) ? inList.supplier[0] : inList.supplier,
          } as PurchaseOrder);
          return;
        }
        // Otherwise fetch it directly (it may already be 'received')
        const { data: poData } = await supabase
          .from('purchase_orders')
          .select('id, po_number, supplier_id, status, total_amount, supplier:suppliers(name)')
          .eq('id', prefillPOId)
          .single();
        if (poData) {
          const po = {
            ...poData,
            supplier: Array.isArray(poData.supplier) ? poData.supplier[0] : poData.supplier,
          };
          await selectPO(po as PurchaseOrder);
        }
        return;
      }

      // Pre-fill from ?supplier= (redirected from supplier profile's New GRN
      // button with ?new=1) — start in direct-receive mode for that supplier
      const prefillSupplierId = searchParams.get('supplier');
      if (prefillSupplierId) {
        setDirectMode(true);
        setDirectSupplier(prefillSupplierId);
      }
    }
    load();
  }, []);

  async function handleSave() {
    setError('');

    if (!directMode && !selectedPO) {
      setError('Please select a purchase order');
      return;
    }

    if (directMode && (!directSupplier || !directWarehouse)) {
      setError('Please select supplier and warehouse');
      return;
    }

    const itemsToReceive = Object.entries(receiveItems).filter(([_, qty]) => qty > 0);
    if (itemsToReceive.length === 0) {
      setError('Please enter quantities to receive');
      return;
    }

    setSaving(true);

    try {
      // One atomic server-side RPC: GRN header, stock movements, counters, PO
      // received quantities, FIFO batches (with cost ratchet), journal entry,
      // PO status, and reminder fulfillment commit together or not at all.
      const payload = itemsToReceive
        .map(([itemId, qty]) => {
          const item = items.find(i => i.id === itemId);
          if (!item) return null;
          return {
            po_item_id: directMode ? null : itemId,
            product_id: item.product_id,
            quantity: Number(qty),
            unit_cost: Number(item.unit_cost),
          };
        })
        .filter(Boolean);

      const warehouseId = directMode ? directWarehouse : warehouses.find(w => w.is_default)?.id || warehouses[0]?.id;

      const { data, error: rpcError } = await supabase.rpc('receive_grn', {
        p_supplier_id: directMode ? directSupplier : selectedPO!.supplier_id,
        p_purchase_order_id: directMode ? null : selectedPO!.id,
        p_warehouse_id: warehouseId,
        p_items: payload,
      });
      if (rpcError) throw new Error(rpcError.message);

      const result = (data || {}) as {
        grn_number?: string;
        cost_updates?: { name: string; before: number; after: number }[];
      };

      // Cost prices can only rise here: the DB trigger sets products.cost_price
      // to the received unit cost only when it is higher than the current cost.
      let costUpdateSummary = '';
      const changed = result.cost_updates || [];
      if (changed.length > 0) {
        const lines = changed
          .map(c => `${c.name}: ৳${Number(c.before).toFixed(2)} → ৳${Number(c.after).toFixed(2)}`)
          .slice(0, 3);
        const more = changed.length > 3 ? ` (+${changed.length - 3} more)` : '';
        costUpdateSummary = ` • Cost updated — ${lines.join(', ')}${more}`;
      }

      toast({
        title: 'Success',
        description: `GRN ${result.grn_number} created successfully${costUpdateSummary}`,
      });
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const filteredPOs = purchaseOrders.filter(po =>
    !search || po.po_number.toLowerCase().includes(search.toLowerCase()) || po.supplier?.name?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-2xl shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-white">
          <h2 className="text-base font-bold">New Goods Receipt Note</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-6">
          {error && <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm mb-4">{error}</div>}

          {step === 1 && (
            <div className="space-y-4">
              <div className="flex gap-2 mb-4">
                <button
                  onClick={() => setDirectMode(false)}
                  className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium transition ${!directMode ? 'bg-blue-600 text-white' : 'bg-muted text-muted-foreground'}`}
                >
                  From Purchase Order
                </button>
                <button
                  onClick={() => setDirectMode(true)}
                  className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium transition ${directMode ? 'bg-blue-600 text-white' : 'bg-muted text-muted-foreground'}`}
                >
                  Direct Receipt (No PO)
                </button>
              </div>

              {!directMode ? (
                <>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                    <input
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                      placeholder="Search purchase orders..."
                      className="w-full pl-8 pr-4 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                    />
                  </div>
                  <div className="max-h-[350px] overflow-y-auto space-y-2">
                    {filteredPOs.map(po => (
                      <div
                        key={po.id}
                        onClick={() => selectPO(po)}
                        className="p-4 border border-border rounded-lg cursor-pointer hover:border-blue-300 hover:bg-blue-50/50 transition"
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="font-semibold text-foreground">{po.po_number}</p>
                            <p className="text-sm text-muted-foreground">{po.supplier?.name || 'Unknown'}</p>
                          </div>
                          <div className="text-right">
                            <p className="font-bold text-foreground">{formatCurrency(po.total_amount)}</p>
                            <p className="text-xs text-muted-foreground capitalize">{po.status.replace('_', ' ')}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                    {filteredPOs.length === 0 && (
                      <div className="p-8 text-center text-muted-foreground text-sm">No pending purchase orders found</div>
                    )}
                  </div>
                </>
              ) : (
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium mb-1">Supplier *</label>
                    <select
                      value={directSupplier}
                      onChange={e => setDirectSupplier(e.target.value)}
                      className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                    >
                      <option value="">Select supplier</option>
                      {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">Warehouse *</label>
                    <select
                      value={directWarehouse}
                      onChange={e => setDirectWarehouse(e.target.value)}
                      className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                    >
                      <option value="">Select warehouse</option>
                      {warehouses.map(w => <option key={w.id} value={w.id}>{w.name} {w.is_default && '(Default)'}</option>)}
                    </select>
                  </div>

                  {directSupplier && directWarehouse && (
                    <div className="mt-4 p-4 border border-border rounded-lg">
                      <p className="text-sm text-muted-foreground mb-2">Enter items to receive:</p>
                      <p className="text-xs text-muted-foreground">Use the Inventory page to add products, then use Stock Movements to record direct receipts.</p>
                      <button
                        onClick={() => {
                          setError('Please add products to inventory first, then use Stock Movements for direct receipts');
                        }}
                        className="mt-4 flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition"
                      >
                        <Package className="w-4 h-4" />
                        Go to Inventory
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {step === 2 && selectedPO && !directMode && (
            <div className="space-y-4">
              <div className="p-3 bg-muted/50 rounded-lg">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold text-foreground">{selectedPO.po_number}</p>
                    <p className="text-sm text-muted-foreground">{selectedPO.supplier?.name}</p>
                  </div>
                  <p className="font-bold">{formatCurrency(selectedPO.total_amount)}</p>
                </div>
              </div>

              <div className="border-t border-border pt-4">
                <h4 className="text-sm font-medium mb-3">Enter received quantities:</h4>
                <div className="space-y-2">
                  {items.map(item => {
                    const remaining = Number(item.quantity) - Number(item.received_quantity);
                    return (
                      <div key={item.id} className="p-3 border border-border rounded-lg">
                        <div className="flex items-center justify-between mb-2">
                          <div>
                            <p className="font-medium text-foreground text-sm">{item.product?.name}</p>
                            <p className="text-xs text-muted-foreground">SKU: {item.product?.sku}</p>
                          </div>
                          <p className="font-semibold">{formatCurrency(item.unit_cost)}/unit</p>
                        </div>
                        <div className="flex items-center gap-4">
                          <div className="flex-1">
                            <div className="flex justify-between text-xs text-muted-foreground mb-1">
                              <span>Ordered: {item.quantity}</span>
                              <span>Already Received: {item.received_quantity}</span>
                              <span className="font-medium text-blue-600">Remaining: {remaining}</span>
                            </div>
                            <input
                              type="number"
                              min="0"
                              max={remaining}
                              value={receiveItems[item.id] || 0}
                              onChange={e => setReceiveItems({ ...receiveItems, [item.id]: Number(e.target.value) })}
                              className="w-full border border-border rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="flex items-center justify-between pt-4 border-t border-border">
                <button onClick={() => setStep(1)} className="px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">
                  Back
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-60"
                >
                  {saving ? 'Processing...' : <>
                    <CheckCircle className="w-4 h-4" />
                    Create GRN
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
