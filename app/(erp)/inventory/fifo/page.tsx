'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
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

interface ProductRow {
  id: string;
  name: string;
  sku: string | null;
  value: number;
  remaining: number;
  received: number;
  hasIou: boolean;
}

interface Overview {
  summary: {
    totalValue: number;
    positiveValue: number;
    iouValue: number;
    iouLayers: number;
    totalRemaining: number;
    productCount: number;
    batchCount: number;
  };
  byWarehouse: Array<{ id: string; name: string; value: number; remaining: number }>;
  byType: Array<{ type: string; value: number; remaining: number }>;
  products: ProductRow[];
}

export default function FifoLedgerPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedProduct, setSelectedProduct] = useState<string | null>(null);

  // The whole-ledger aggregation runs server-side (get_fifo_ledger_overview):
  // the browser pulls one small aggregate instead of every batch row. Only the
  // SELECTED product's batches are fetched, when a product is clicked. Offline
  // the wrapped client serves the last cached overview.
  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data, error } = await supabase.rpc('get_fifo_ledger_overview');
      if (error) {
        console.error('FIFO overview failed:', error);
        setOverview(null);
      } else {
        setOverview(data as unknown as Overview);
      }
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    if (!selectedProduct) { setBatches([]); return; }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('inventory_batches')
        .select('*, product:products(name, sku), warehouse:warehouses(name)')
        .eq('product_id', selectedProduct)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true });
      if (!cancelled) setBatches((data || []) as Batch[]);
    })();
    return () => { cancelled = true; };
  }, [selectedProduct]);

  const products = useMemo<ProductRow[]>(() => overview?.products || [], [overview]);

  const filteredProducts = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return products;
    return products.filter((v) =>
      (v.name || '').toLowerCase().includes(q) ||
      (v.sku || '').toLowerCase().includes(q)
    );
  }, [products, search]);

  const selectedProductRow = useMemo(
    () => products.find((p) => p.id === selectedProduct) || null,
    [products, selectedProduct],
  );

  const summary = overview?.summary || {
    totalValue: 0, positiveValue: 0, iouValue: 0, iouLayers: 0,
    totalRemaining: 0, productCount: 0, batchCount: 0,
  };
  const byWarehouse = overview?.byWarehouse || [];
  const byType = overview?.byType || [];

  useEffect(() => {
    if (!selectedProduct && filteredProducts.length > 0) {
      setSelectedProduct(filteredProducts[0].id);
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
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 mb-6">
        <div className="rounded-xl border border-border bg-white p-4 shadow-sm">
          <p className="text-xs text-muted-foreground font-medium">Stock Value (physical layers)</p>
          <p className="text-xl font-bold text-foreground mt-1">{formatCurrency(summary.positiveValue)}</p>
        </div>
        <div className="rounded-xl border border-border bg-white p-4 shadow-sm">
          <p className="text-xs text-muted-foreground font-medium">Net Book Value (GL 1200)</p>
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
          <p className="text-xl font-bold text-foreground mt-1">{summary.batchCount.toLocaleString()}</p>
        </div>
      </div>

      {summary.iouLayers > 0 && (
        <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <span className="font-semibold">Why two values? </span>
          Stock Value counts physical stock (positive FIFO layers) — the same basis as the
          Inventory page&rsquo;s &ldquo;Inventory Value&rdquo; card. Net Book Value additionally
          includes {summary.iouLayers} negative oversell IOU layer{summary.iouLayers === 1 ? '' : 's'} worth{' '}
          {formatCurrency(Math.abs(summary.iouValue))} and matches GL account 1200 — the Dashboard
          reconciliation check verifies this live. The IOUs await the physical-count decision on
          the{' '}
          <Link href="/inventory/audit" className="font-semibold underline underline-offset-2">
            Inventory Audit
          </Link>{' '}
          page.
        </div>
      )}

      {/* Breakdown by warehouse and batch type */}
      {byWarehouse.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <div className="rounded-xl border border-border bg-white p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-foreground mb-3">By Warehouse</h3>
            <div className="space-y-2">
              {byWarehouse.map((v) => (
                <div key={v.id} className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground truncate">{v.name}</span>
                  <span className="font-semibold text-foreground">{formatCurrency(v.value)}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-xl border border-border bg-white p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-foreground mb-3">By Batch Type</h3>
            <div className="space-y-2">
              {byType.map((v) => (
                <div key={v.type} className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground capitalize">{v.type}</span>
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
            {filteredProducts.map((v) => (
              <button
                key={v.id}
                onClick={() => setSelectedProduct(v.id)}
                className={`w-full flex items-center justify-between px-4 py-3 text-left transition hover:bg-muted/40 ${selectedProduct === v.id ? 'bg-blue-50' : ''}`}
              >
                <div>
                  <p className="text-sm font-semibold text-foreground flex items-center gap-1.5">
                    {v.name || 'Unknown'}
                    {v.hasIou && (
                      <span className="rounded bg-amber-100 px-1 py-0.5 text-[10px] font-semibold uppercase text-amber-800">
                        IOU
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">{v.sku}</p>
                </div>
                <div className="text-right shrink-0 ml-3">
                  <p className={`text-sm font-semibold ${v.value < 0 ? 'text-red-600' : 'text-foreground'}`}>{formatCurrency(v.value)}</p>
                  <p className="text-xs text-muted-foreground whitespace-nowrap">
                    Recv {v.received.toLocaleString()} · Rem {v.remaining.toLocaleString()}
                  </p>
                </div>
              </button>
            ))}
            {filteredProducts.length === 0 && (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                No products with remaining or outstanding IOU stock.
              </div>
            )}
          </div>
        </div>

        {/* Right: batch table for selected product */}
        <div className="rounded-xl border border-border overflow-hidden">
          <div className="px-5 py-4 border-b border-border flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-base font-bold truncate">
                {selectedProductRow?.name || 'Select a product'}
              </h2>
              <p className="text-xs text-muted-foreground">
                {(() => {
                  const warehouses = new Map<string, string>();
                  for (const b of batches) {
                    if (b.warehouse_id && b.warehouse?.name) {
                      warehouses.set(b.warehouse_id, b.warehouse.name);
                    }
                  }
                  const names = Array.from(warehouses.values());
                  return names.length === 0 ? '—' : names.length === 1 ? names[0] : `${names.length} warehouses`;
                })()}
                {' · '}
                {batches.length} batch{batches.length === 1 ? '' : 'es'}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 sm:shrink-0">
              <div className="text-right">
                <p className="text-xs text-muted-foreground">Total Received</p>
                <p className="text-lg font-bold">
                  {batches.reduce((s, b) => s + Number(b.quantity_received), 0).toLocaleString()}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs text-muted-foreground">Total Remaining</p>
                <p className="text-lg font-bold">
                  {batches.reduce((s, b) => s + Number(b.quantity_remaining), 0).toLocaleString()}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs text-muted-foreground">Remaining Value</p>
                <p className="text-lg font-bold">
                  {formatCurrency(batches.reduce((s, b) => s + Number(b.quantity_remaining) * Number(b.unit_cost), 0))}
                </p>
              </div>
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
                {batches.map((b, i) => {
                  const exhausted = Number(b.quantity_remaining) === 0;
                  return (
                    <tr key={b.id} className={exhausted ? 'opacity-50' : ''}>
                      <td className="px-4 py-2 text-muted-foreground">{i + 1}</td>
                      <td className="px-4 py-2 font-mono text-xs">{b.batch_number || '—'}</td>
                      <td className="px-4 py-2 capitalize">{b.batch_type}</td>
                      <td className="px-4 py-2 text-sm">{b.warehouse?.name || '—'}</td>
                      <td className="px-4 py-2 text-right">{Number(b.quantity_received).toLocaleString()}</td>
                      <td className={`px-4 py-2 text-right font-mono ${Number(b.quantity_remaining) < 0 ? 'text-red-600 font-semibold' : ''}`}>{Number(b.quantity_remaining).toLocaleString()}</td>
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
                {batches.length === 0 && (
                  <tr>
                    <td colSpan={10} className="px-4 py-8 text-center text-muted-foreground">
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
