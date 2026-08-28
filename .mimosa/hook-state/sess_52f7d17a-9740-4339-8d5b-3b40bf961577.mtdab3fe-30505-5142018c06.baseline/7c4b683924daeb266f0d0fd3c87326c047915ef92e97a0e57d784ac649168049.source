'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/format';
import { toast } from '@/hooks/use-toast';
import { ArrowRightLeft, Plus, Search, RefreshCw, X, Package, Warehouse as WarehouseIcon, ArrowRight, CircleCheck as CheckCircle, Clock } from 'lucide-react';
import type { Product, Warehouse } from '@/lib/types';

interface InventoryItem {
  id: string;
  product_id: string;
  warehouse_id: string;
  quantity_on_hand: number;
  product?: { name: string; sku: string; unit: string };
  warehouse?: { name: string; code: string };
}

interface Transfer {
  id: string;
  transfer_number: string;
  product_id: string;
  from_warehouse_id: string;
  to_warehouse_id: string;
  quantity: number;
  status: string;
  notes: string;
  created_at: string;
  product?: { name: string; sku: string };
  from_warehouse?: { name: string };
  to_warehouse?: { name: string };
}

export default function StockTransfersPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);

    // Supabase caps queries at 1000 rows by default. Paginate to fetch all products and inventory.
    let allProds: any[] = [];
    let page = 0;
    const PAGE = 500;
    while (true) {
      const { data, error } = await supabase
        .from('products')
        .select('*')
        .eq('is_active', true)
        .order('name')
        .range(page * PAGE, (page + 1) * PAGE - 1);
      if (error) break;
      allProds = allProds.concat(data || []);
      if (!data || data.length < PAGE) break;
      page++;
    }

    let allInv: any[] = [];
    page = 0;
    while (true) {
      const { data, error } = await supabase
        .from('inventory_items')
        .select('*, product:products(name, sku, unit), warehouse:warehouses(name, code)')
        .range(page * PAGE, (page + 1) * PAGE - 1);
      if (error) break;
      allInv = allInv.concat(data || []);
      if (!data || data.length < PAGE) break;
      page++;
    }

    const whRes = await supabase.from('warehouses').select('*').eq('is_active', true).order('name');

    setProducts(allProds || []);
    setWarehouses(whRes.data || []);
    setInventory(allInv || []);

    // Get recent transfers from stock_movements
    const { data: movements } = await supabase
      .from('stock_movements')
      .select('*, product:products(name, sku)')
      .in('movement_type', ['transfer_in', 'transfer_out'])
      .order('created_at', { ascending: false })
      .limit(20);

    // Group movements by reference_id
    const transferMap = new Map<string, Transfer>();
    (movements || []).forEach((m: any) => {
      if (m.reference_id && !transferMap.has(m.reference_id)) {
        transferMap.set(m.reference_id, {
          id: m.id,
          transfer_number: m.reference_number || `TRF-${m.reference_id.slice(0, 8)}`,
          product_id: m.product_id,
          from_warehouse_id: m.movement_type === 'transfer_out' ? m.warehouse_id : '',
          to_warehouse_id: m.movement_type === 'transfer_in' ? m.warehouse_id : '',
          quantity: Math.abs(Number(m.quantity)),
          status: 'completed',
          notes: m.notes || '',
          created_at: m.created_at,
          product: m.product,
        });
      }
    });

    setTransfers(Array.from(transferMap.values()));
    setLoading(false);
  }

  const getAvailableStock = (productId: string, warehouseId: string) => {
    const item = inventory.find(i => i.product_id === productId && i.warehouse_id === warehouseId);
    return item?.quantity_on_hand || 0;
  };

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Stock Transfers</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Transfer products between warehouses and showrooms</p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition"
        >
          <Plus className="w-4 h-4" />
          New Transfer
        </button>
      </div>

      <div className="bg-white rounded-xl border border-border p-4 shadow-sm flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search transfers..."
            className="w-full pl-8 pr-4 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          />
        </div>
        <button onClick={loadData} className="flex items-center gap-2 border border-border rounded-lg px-3 py-2 text-sm hover:bg-muted transition">
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {warehouses.map(wh => (
          <div key={wh.id} className="bg-white rounded-xl border border-border p-4 shadow-sm">
            <div className="flex items-center gap-3 mb-3">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center ${wh.is_default ? 'bg-blue-50 text-blue-600' : 'bg-muted text-muted-foreground'}`}>
                <WarehouseIcon className="w-5 h-5" />
              </div>
              <div>
                <p className="font-semibold text-foreground">{wh.name}</p>
                <p className="text-xs text-muted-foreground">{wh.code} {wh.is_default && '(Default)'}</p>
              </div>
            </div>
            <div className="text-sm">
              <span className="text-muted-foreground">Items: </span>
              <span className="font-semibold">{inventory.filter(i => i.warehouse_id === wh.id && i.quantity_on_hand > 0).length}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-border shadow-sm">
        <div className="px-4 py-3 border-b border-border">
          <h3 className="font-semibold text-foreground">Recent Transfers</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-muted/40 border-b border-border">
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Transfer #</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Product</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">From</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">To</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Qty</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Status</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Date</th>
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
              ) : transfers.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground text-sm">
                    No transfers recorded yet
                  </td>
                </tr>
              ) : (
                transfers.filter(t => !search || t.transfer_number.toLowerCase().includes(search.toLowerCase()) || t.product?.name?.toLowerCase().includes(search.toLowerCase())).map(t => (
                  <tr key={t.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3 text-sm font-mono text-foreground">{t.transfer_number}</td>
                    <td className="px-4 py-3 text-sm text-foreground">{t.product?.name || '—'}</td>
                    <td className="px-4 py-3 text-sm text-foreground">{t.from_warehouse_id || '—'}</td>
                    <td className="px-4 py-3 text-sm text-foreground">{t.to_warehouse_id || '—'}</td>
                    <td className="px-4 py-3 text-right text-sm font-semibold text-foreground">{t.quantity}</td>
                    <td className="px-4 py-3">
                      <span className={`badge-status ${t.status === 'completed' ? 'bg-green-50 text-green-600' : 'bg-amber-50 text-amber-600'}`}>
                        {t.status === 'completed' ? <CheckCircle className="w-3 h-3 mr-1" /> : <Clock className="w-3 h-3 mr-1" />}
                        {t.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{new Date(t.created_at).toLocaleDateString()}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showModal && (
        <TransferModal
          products={products}
          warehouses={warehouses}
          inventory={inventory}
          getAvailableStock={getAvailableStock}
          onClose={() => setShowModal(false)}
          onSaved={loadData}
        />
      )}
    </div>
  );
}

function TransferModal({ products, warehouses, inventory, getAvailableStock, onClose, onSaved }: {
  products: Product[];
  warehouses: Warehouse[];
  inventory: InventoryItem[];
  getAvailableStock: (productId: string, warehouseId: string) => number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    product_id: '',
    from_warehouse_id: '',
    to_warehouse_id: '',
    quantity: '',
    notes: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [availableQty, setAvailableQty] = useState(0);
  const [productSearch, setProductSearch] = useState('');

  useEffect(() => {
    if (form.product_id && form.from_warehouse_id) {
      setAvailableQty(getAvailableStock(form.product_id, form.from_warehouse_id));
    }
  }, [form.product_id, form.from_warehouse_id, getAvailableStock]);

  const selectedProduct = products.find(p => p.id === form.product_id);

  const visibleProducts = (() => {
    const q = productSearch.toLowerCase();
    const fromWarehouseId = form.from_warehouse_id;
    const base = fromWarehouseId
      ? products.filter(p => (inventory.find(i => i.product_id === p.id && i.warehouse_id === fromWarehouseId)?.quantity_on_hand || 0) > 0)
      : products;
    const result = base.filter(p =>
      !q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q)
    );
    return result.length > 0 ? result : products.filter(p =>
      !q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q)
    );
  })();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (form.from_warehouse_id === form.to_warehouse_id) { setError('Source and destination warehouses cannot be the same'); return; }
    const qty = Number(form.quantity);
    if (qty <= 0) { setError('Quantity must be greater than 0'); return; }
    if (qty > availableQty) { setError(`Insufficient stock. Available: ${availableQty}`); return; }

    setSaving(true);
    try {
      const transferId = crypto.randomUUID();
      const transferNumber = `TRF-${Date.now().toString().slice(-6)}`;
      const product = products.find(p => p.id === form.product_id);

      const { error: outError } = await supabase.from('stock_movements').insert({
        tenant_id: '00000000-0000-0000-0000-000000000001',
        product_id: form.product_id, warehouse_id: form.from_warehouse_id,
        movement_type: 'transfer_out', quantity: -qty, unit_cost: product?.cost_price || 0,
        reference_type: 'transfer', reference_id: transferId, reference_number: transferNumber,
        notes: form.notes || `Transfer to ${warehouses.find(w => w.id === form.to_warehouse_id)?.name}`,
      });
      if (outError) throw outError;

      const { error: inError } = await supabase.from('stock_movements').insert({
        tenant_id: '00000000-0000-0000-0000-000000000001',
        product_id: form.product_id, warehouse_id: form.to_warehouse_id,
        movement_type: 'transfer_in', quantity: qty, unit_cost: product?.cost_price || 0,
        reference_type: 'transfer', reference_id: transferId, reference_number: transferNumber,
        notes: form.notes || `Transfer from ${warehouses.find(w => w.id === form.from_warehouse_id)?.name}`,
      });
      if (inError) throw inError;

      // Move FIFO batches between warehouses
      await supabase.rpc('transfer_fifo_batches', {
        p_product_id: form.product_id,
        p_from_warehouse_id: form.from_warehouse_id,
        p_to_warehouse_id: form.to_warehouse_id,
        p_quantity: qty,
        p_reference_id: transferId,
        p_reference_number: transferNumber,
      });

      const sourceItem = inventory.find(i => i.product_id === form.product_id && i.warehouse_id === form.from_warehouse_id);
      if (sourceItem) {
        await supabase.from('inventory_items').update({ quantity_on_hand: sourceItem.quantity_on_hand - qty, updated_at: new Date().toISOString() }).eq('id', sourceItem.id);
      }
      const destItem = inventory.find(i => i.product_id === form.product_id && i.warehouse_id === form.to_warehouse_id);
      if (destItem) {
        await supabase.from('inventory_items').update({ quantity_on_hand: destItem.quantity_on_hand + qty, updated_at: new Date().toISOString() }).eq('id', destItem.id);
      } else {
        await supabase.from('inventory_items').insert({ tenant_id: '00000000-0000-0000-0000-000000000001', product_id: form.product_id, warehouse_id: form.to_warehouse_id, quantity_on_hand: qty });
      }

      toast({ title: 'Success', description: 'Stock transfer completed successfully' });
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Transfer failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-lg shadow-2xl max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <h2 className="text-base font-bold">New Stock Transfer</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>

        <div className="overflow-y-auto flex-1">
          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            {error && <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>}

            {/* Warehouses first */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium mb-1">From Warehouse *</label>
                <select required value={form.from_warehouse_id}
                  onChange={e => setForm({ ...form, from_warehouse_id: e.target.value, product_id: '' })}
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                >
                  <option value="">Select source</option>
                  {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">To Warehouse *</label>
                <select required value={form.to_warehouse_id}
                  onChange={e => setForm({ ...form, to_warehouse_id: e.target.value })}
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                >
                  <option value="">Select destination</option>
                  {warehouses.filter(w => w.id !== form.from_warehouse_id).map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </div>
            </div>

            {/* Product selection - always visible list */}
            <div>
              <label className="block text-xs font-medium mb-1">
                Product *{form.from_warehouse_id ? <span className="text-muted-foreground font-normal ml-1">(showing products in selected warehouse)</span> : ''}
              </label>

              {selectedProduct ? (
                <div className="flex items-center gap-3 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                  <Package className="w-4 h-4 text-blue-600 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-foreground truncate">{selectedProduct.name}</p>
                    <p className="text-xs text-muted-foreground">{selectedProduct.sku}</p>
                  </div>
                  {form.from_warehouse_id && (
                    <span className="text-xs font-bold text-green-600 shrink-0">{availableQty} available</span>
                  )}
                  <button type="button" onClick={() => setForm({ ...form, product_id: '', quantity: '' })} className="text-muted-foreground hover:text-foreground ml-1">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <div className="border border-border rounded-xl overflow-hidden">
                  <div className="relative border-b border-border">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                    <input
                      type="text"
                      placeholder="Search by product name or SKU..."
                      value={productSearch}
                      onChange={e => setProductSearch(e.target.value)}
                      className="w-full pl-9 pr-4 py-2.5 text-sm focus:outline-none focus:bg-blue-50/50"
                    />
                  </div>
                  <div className="max-h-52 overflow-y-auto divide-y divide-border/50">
                    {visibleProducts.length === 0 ? (
                      <div className="px-4 py-6 text-center text-sm text-muted-foreground">No products found</div>
                    ) : visibleProducts.map(p => {
                      const stock = form.from_warehouse_id
                        ? (inventory.find(i => i.product_id === p.id && i.warehouse_id === form.from_warehouse_id)?.quantity_on_hand || 0)
                        : null;
                      return (
                        <button key={p.id} type="button"
                          onClick={() => setForm({ ...form, product_id: p.id, quantity: '' })}
                          className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-blue-50 text-left transition"
                        >
                          <div className="w-7 h-7 bg-muted rounded-lg flex items-center justify-center shrink-0">
                            <Package className="w-3.5 h-3.5 text-muted-foreground" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-foreground truncate">{p.name}</p>
                            <p className="text-xs text-muted-foreground">{p.sku}</p>
                          </div>
                          {stock !== null && (
                            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full shrink-0 ${stock > 0 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'}`}>
                              {stock > 0 ? `${stock} in stock` : 'No stock'}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              <input type="text" required value={form.product_id} onChange={() => {}} className="sr-only" />
            </div>

            {/* Quantity + Notes (shown after product selected) */}
            {form.product_id && (
              <>
                <div>
                  <label className="block text-xs font-medium mb-1">Quantity to Transfer *</label>
                  <input type="number" required min="1" max={availableQty || undefined}
                    value={form.quantity} onChange={e => setForm({ ...form, quantity: e.target.value })}
                    placeholder={`Max: ${availableQty}`}
                    className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Notes</label>
                  <textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })}
                    rows={2} placeholder="Optional notes..."
                    className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                  />
                </div>
              </>
            )}

            <div className="flex items-center justify-end gap-3 pt-2">
              <button type="button" onClick={onClose} className="px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Cancel</button>
              <button type="submit" disabled={saving || !form.product_id} className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-60">
                {saving ? 'Processing...' : <><ArrowRight className="w-4 h-4" />Transfer Stock</>}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
