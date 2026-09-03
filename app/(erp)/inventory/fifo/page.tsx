'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/format';
import { Package, Search } from 'lucide-react';

interface Batch {
  id: string;
  product_id: string;
  warehouse_id: string;
  batch_number: string | null;
  batch_type: string;
  quantity_received: number;
  quantity_remaining: number;
  unit_cost: number;
  created_at: string;
  reference_number: string | null;
  notes: string | null;
  product?: { name: string; sku: string } | null;
  warehouse?: { name: string } | null;
}

export default function FifoLedgerPage() {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedProduct, setSelectedProduct] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      let all: Batch[] = [];
      let pg = 0;
      while (true) {
        const { data: pageData } = await supabase
          .from('inventory_batches')
          .select('*, product:products(name, sku), warehouse:warehouses(name)')
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(pg * 1000, (pg + 1) * 1000 - 1);
        all = all.concat((pageData || []) as Batch[]);
        if (!pageData || pageData.length < 1000) break;
        pg++;
      }
      setBatches(all);
      setLoading(false);
    }
    load();
  }, []);

  // Group by product; only products with remaining qty appear.
  const products = useMemo(() => {
    const map = new Map<string, { product: Batch['product']; value: number; remaining: number }>();
    for (const b of batches) {
      const key = b.product_id as unknown as string;
      if (!key) continue;
      const cur = map.get(key) || { product: b.product, value: 0, remaining: 0 };
      cur.remaining += Number(b.quantity_remaining);
      cur.value += Number(b.quantity_remaining) * Number(b.unit_cost);
      map.set(key, cur);
    }
    return Array.from(map.entries())
      .filter(([, v]) => v.remaining > 0)
      .sort((a, b) => (a[1].product?.name || '').localeCompare(b[1].product?.name || ''));
  }, [batches]);

  const filteredProducts = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return products;
    return products.filter(([, v]) =>
      (v.product?.name || '').toLowerCase().includes(q) ||
      (v.product?.sku || '').toLowerCase().includes(q)
    );
  }, [products, search]);

  const selectedBatches = useMemo(() => {
    return batches
      .filter((b) => b.product_id === selectedProduct)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  }, [batches, selectedProduct]);

  // Grand totals across all batches (read-only ledger summary).
  const summary = useMemo(() => {
    let totalValue = 0;
    let totalRemaining = 0;
    const productIds = new Set<string>();
    const byWarehouse = new Map<string, { name: string; value: number; remaining: number }>();
    const byType = new Map<string, { value: number; remaining: number }>();
    for (const b of batches) {
      const remaining = Number(b.quantity_remaining);
      const value = remaining * Number(b.unit_cost);
      totalValue += value;
      totalRemaining += remaining;
      if (b.product_id) productIds.add(b.product_id as unknown as string);
      if (b.warehouse_id) {
        const whKey = b.warehouse_id as unknown as string;
        const cur = byWarehouse.get(whKey) || { name: b.warehouse?.name || '—', value: 0, remaining: 0 };
        cur.value += value;
        cur.remaining += remaining;
        byWarehouse.set(whKey, cur);
      }
      const tKey = b.batch_type || 'other';
      const tc = byType.get(tKey) || { value: 0, remaining: 0 };
      tc.value += value;
      tc.remaining += remaining;
      byType.set(tKey, tc);
    }
    return {
      totalValue,
      totalRemaining,
      productCount: productIds.size,
      byWarehouse: Array.from(byWarehouse.entries())
        .filter(([, v]) => v.remaining > 0)
        .sort((a, b) => b[1].value - a[1].value),
      byType: Array.from(byType.entries()).sort((a, b) => b[1].value - a[1].value),
    };
  }, [batches]);

  useEffect(() => {
    if (!selectedProduct && filteredProducts.length > 0) {
      setSelectedProduct(filteredProducts[0][0]);
    }
  }, [filteredProducts, selectedProduct]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="w-10 h-10 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-slate-400 text-sm">Loading FIFO ledger...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">FIFO Inventory Ledger</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Read-only view of stock batches ordered oldest-first (FIFO).
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="rounded-xl border border-border bg-white p-4 shadow-sm">
          <p className="text-xs text-muted-foreground font-medium">Total Inventory Value</p>
          <p className="text-xl font-bold text-foreground mt-1">{formatCurrency(summary.totalValue)}</p>
        </div>
        <div className="rounded-xl border border-border bg-white p-4 shadow-sm">
          <p className="text-xs text-muted-foreground font-medium">Remaining Quantity</p>
          <p className="text-xl font-bold text-foreground mt-1">{summary.totalRemaining.toLocaleString()}</p>
        </div>
        <div className="rounded-xl border border-border bg-white p-4 shadow-sm">
          <p className="text-xs text-muted-foreground font-medium">Products</p>
          <p className="text-xl font-bold text-foreground mt-1">{summary.productCount.toLocaleString()}</p>
        </div>
        <div className="rounded-xl border border-border bg-white p-4 shadow-sm">
          <p className="text-xs text-muted-foreground font-medium">Batches</p>
          <p className="text-xl font-bold text-foreground mt-1">{batches.length.toLocaleString()}</p>
        </div>
      </div>

      {/* Breakdown by warehouse and batch type */}
      {summary.byWarehouse.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <div className="rounded-xl border border-border bg-white p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-foreground mb-3">By Warehouse</h3>
            <div className="space-y-2">
              {summary.byWarehouse.map(([id, v]) => (
                <div key={id} className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground truncate">{v.name}</span>
                  <span className="font-semibold text-foreground">{formatCurrency(v.value)}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-xl border border-border bg-white p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-foreground mb-3">By Batch Type</h3>
            <div className="space-y-2">
              {summary.byType.map(([type, v]) => (
                <div key={type} className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground capitalize">{type}</span>
                  <span className="font-semibold text-foreground">{formatCurrency(v.value)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-[320px_1fr] gap-6">
        {/* Left: product list */}
        <div className="rounded-xl border border-border overflow-hidden">
          <div className="p-3 border-b border-border">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search products..."
                className="w-full pl-9 pr-3 py-2 text-sm border border-input rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
          <div className="divide-y divide-border max-h-[70vh] overflow-y-auto">
            {filteredProducts.map(([id, v]) => (
              <button
                key={id}
                onClick={() => setSelectedProduct(id)}
                className={`w-full flex items-center justify-between px-4 py-3 text-left transition hover:bg-muted/40 ${selectedProduct === id ? 'bg-blue-50' : ''}`}
              >
                <div>
                  <p className="text-sm font-semibold text-foreground">{v.product?.name || 'Unknown'}</p>
                  <p className="text-xs text-muted-foreground">{v.product?.sku}</p>
                </div>
                <p className="text-sm font-semibold text-foreground">{formatCurrency(v.value)}</p>
              </button>
            ))}
            {filteredProducts.length === 0 && (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                No products with remaining stock.
              </div>
            )}
          </div>
        </div>

        {/* Right: batch table for selected product */}
        <div className="rounded-xl border border-border overflow-hidden">
          <div className="px-5 py-4 border-b border-border flex items-center justify-between">
            <div>
              <h2 className="text-base font-bold">
                {selectedBatches[0]?.product?.name || 'Select a product'}
              </h2>
              <p className="text-xs text-muted-foreground">
                {(() => {
                  const warehouses = new Map<string, string>();
                  for (const b of selectedBatches) {
                    if (b.warehouse_id && b.warehouse?.name) {
                      warehouses.set(b.warehouse_id, b.warehouse.name);
                    }
                  }
                  const names = Array.from(warehouses.values());
                  return names.length === 0 ? '—' : names.length === 1 ? names[0] : `${names.length} warehouses`;
                })()}
                {' · '}
                {selectedBatches.length} batch{selectedBatches.length === 1 ? '' : 'es'}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs text-muted-foreground">Remaining</p>
              <p className="text-lg font-bold">
                {formatCurrency(selectedBatches.reduce((s, b) => s + Number(b.quantity_remaining) * Number(b.unit_cost), 0))}
              </p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-muted-foreground text-xs">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">#</th>
                  <th className="px-4 py-2 text-left font-medium">Batch</th>
                  <th className="px-4 py-2 text-left font-medium">Type</th>
                  <th className="px-4 py-2 text-left font-medium">Warehouse</th>
                  <th className="px-4 py-2 text-right font-medium">Received</th>
                  <th className="px-4 py-2 text-right font-medium">Remaining</th>
                  <th className="px-4 py-2 text-right font-medium">Unit Cost</th>
                  <th className="px-4 py-2 text-right font-medium">Value</th>
                  <th className="px-4 py-2 text-left font-medium">Date</th>
                  <th className="px-4 py-2 text-left font-medium">Reference</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {selectedBatches.map((b, i) => {
                  const exhausted = Number(b.quantity_remaining) === 0;
                  return (
                    <tr key={b.id} className={exhausted ? 'opacity-50' : ''}>
                      <td className="px-4 py-2 text-muted-foreground">{i + 1}</td>
                      <td className="px-4 py-2 font-mono text-xs">{b.batch_number || '—'}</td>
                      <td className="px-4 py-2 capitalize">{b.batch_type}</td>
                      <td className="px-4 py-2 text-sm">{b.warehouse?.name || '—'}</td>
                      <td className="px-4 py-2 text-right">{Number(b.quantity_received).toLocaleString()}</td>
                      <td className="px-4 py-2 text-right">{Number(b.quantity_remaining).toLocaleString()}</td>
                      <td className="px-4 py-2 text-right">{formatCurrency(Number(b.unit_cost))}</td>
                      <td className="px-4 py-2 text-right font-semibold">
                        {formatCurrency(Number(b.quantity_remaining) * Number(b.unit_cost))}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {new Date(b.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">{b.reference_number || b.notes || '—'}</td>
                    </tr>
                  );
                })}
                {selectedBatches.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-4 py-8 text-center text-muted-foreground">
                      No batches for this product.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
