'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/format';
import { Package, TriangleAlert as AlertTriangle, TrendingDown, ChartBar as BarChart3, Download, RefreshCw, Search } from 'lucide-react';
import Pagination from '@/components/ui/AppPagination';

export default function InventoryReportPage() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ total: 0, value: 0, lowStock: 0, outOfStock: 0 });
  const [search, setSearch] = useState('');
  const [filterWarehouse, setFilterWarehouse] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [warehouses, setWarehouses] = useState<{ id: string; name: string }[]>([]);
  const [fifoValueMap, setFifoValueMap] = useState<Record<string, number>>({});
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  useEffect(() => {
    async function load() {
      const [whRes, catRes] = await Promise.all([
        supabase.from('warehouses').select('id, name').eq('is_active', true).order('name'),
        supabase.from('categories').select('id, name').eq('is_active', true).order('name'),
      ]);

      // Supabase caps queries at 1000 rows by default. Paginate to fetch all inventory_items.
      let allItems: any[] = [];
      {
        let pg = 0;
        while (true) {
          const { data: pageData } = await supabase
            .from('inventory_items')
            .select('*, product:products(name, sku, unit, cost_price, sale_price, min_stock_level, category:categories(id, name)), warehouse:warehouses(id, name)')
            .range(pg * 1000, (pg + 1) * 1000 - 1);
          allItems = allItems.concat(pageData || []);
          if (!pageData || pageData.length < 1000) break;
          pg++;
        }
      }

      const { data: batchData } = await supabase
        .from('inventory_batches')
        .select('product_id, warehouse_id, quantity_remaining, unit_cost')
        .gt('quantity_remaining', 0);
      const fMap: Record<string, number> = {};
      (batchData || []).forEach((b: any) => {
        const key = `${b.product_id}|${b.warehouse_id}`;
        fMap[key] = (fMap[key] || 0) + Number(b.quantity_remaining) * Number(b.unit_cost);
      });
      setFifoValueMap(fMap);

      setItems(allItems);
      setWarehouses(whRes.data || []);
      setCategories(catRes.data || []);
      const value = allItems.reduce((s: number, i: any) => {
        const key = `${i.product_id}|${i.warehouse_id}`;
        return s + (fMap[key] !== undefined ? fMap[key] : Number(i.quantity_on_hand) * Number(i.product?.cost_price || 0));
      }, 0);
      const low = allItems.filter((i: any) => i.quantity_on_hand > 0 && i.quantity_on_hand <= (i.product?.min_stock_level || 0)).length;
      const out = allItems.filter((i: any) => i.quantity_on_hand === 0).length;
      setStats({ total: allItems.length, value, lowStock: low, outOfStock: out });
      setLoading(false);
    }
    load();
  }, []);

  const filtered = items.filter((item: any) => {
    const matchSearch = !search || item.product?.name?.toLowerCase().includes(search.toLowerCase()) || item.product?.sku?.toLowerCase().includes(search.toLowerCase());
    const matchWh = !filterWarehouse || item.warehouse_id === filterWarehouse;
    const matchCat = !filterCategory || item.product?.category?.id === filterCategory;
    return matchSearch && matchWh && matchCat;
  });

  const totalFiltered = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / pageSize));
  const safePage = Math.min(page, totalPages);
  const pagedItems = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  useEffect(() => { setPage(1); }, [search, filterWarehouse, filterCategory]);

  function exportToCSV() {
    const csv = 'Product,SKU,Category,Warehouse,On Hand,Unit,Value\n' + filtered.map(i => {
      const key = `${i.product_id}|${i.warehouse_id}`;
      const value = fifoValueMap[key] !== undefined ? fifoValueMap[key] : Number(i.quantity_on_hand) * Number(i.product?.cost_price || 0);
      return `"${i.product?.name || ''}","${i.product?.sku || ''}","${i.product?.category?.name || ''}","${i.warehouse?.name || ''}",${i.quantity_on_hand},"${i.product?.unit || 'pcs'}",${value}`;
    }).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'inventory_report.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div><h1 className="text-2xl font-bold text-foreground">Inventory Report</h1><p className="text-muted-foreground text-sm mt-0.5">Current stock levels and valuation</p></div>
        <button onClick={exportToCSV} className="flex items-center gap-2 border border-border px-4 py-2 rounded-lg text-sm hover:bg-muted transition">
          <Download className="w-4 h-4" />Export CSV
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Total Items', value: stats.total, icon: Package, color: 'text-blue-600 bg-blue-50' },
          { label: 'Stock Value', value: formatCurrency(stats.value), icon: BarChart3, color: 'text-green-600 bg-green-50' },
          { label: 'Low Stock', value: stats.lowStock, icon: AlertTriangle, color: 'text-amber-600 bg-amber-50' },
          { label: 'Out of Stock', value: stats.outOfStock, icon: TrendingDown, color: 'text-red-600 bg-red-50' },
        ].map(s => (
          <div key={s.label} className="stat-card flex items-center gap-3">
            <div className={`w-10 h-10 rounded-full flex items-center justify-center ${s.color}`}><s.icon className="w-5 h-5" /></div>
            <div><p className="text-xs text-muted-foreground">{s.label}</p><p className="text-xl font-bold text-foreground">{s.value}</p></div>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-border p-4 shadow-sm flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search products..." className="w-full pl-8 pr-4 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
        </div>
        <select value={filterWarehouse} onChange={e => setFilterWarehouse(e.target.value)} className="border border-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none">
          <option value="">All Warehouses</option>
          {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)} className="border border-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none">
          <option value="">All Categories</option>
          {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      <div className="table-wrapper">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead><tr className="bg-muted/40 border-b border-border">
              {['Product','SKU','Category','Warehouse','On Hand','Reserved','Available','Value'].map(h => <th key={h} className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">{h}</th>)}
            </tr></thead>
            <tbody className="divide-y divide-border">
              {loading ? Array.from({length: 8}).map((_, i) => <tr key={i}>{Array.from({length: 8}).map((_, j) => <td key={j} className="px-4 py-3"><div className="h-4 bg-muted rounded animate-pulse" /></td>)}</tr>) :
                totalFiltered === 0 ? (
                  <tr><td colSpan={8} className="px-4 py-12 text-center text-muted-foreground text-sm">No items found</td></tr>
                ) : pagedItems.map((item: any) => {
                  const avail = item.quantity_on_hand - (item.quantity_reserved || 0);
                  const key = `${item.product_id}|${item.warehouse_id}`;
                  const value = fifoValueMap[key] !== undefined ? fifoValueMap[key] : Number(item.quantity_on_hand) * Number(item.product?.cost_price || 0);
                  const isLow = item.quantity_on_hand <= (item.product?.min_stock_level || 0) && item.quantity_on_hand > 0;
                  const unit = item.product?.unit || 'pcs';
                  return (
                    <tr key={item.id} className="hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3 text-sm font-medium text-foreground">{item.product?.name || '—'}</td>
                      <td className="px-4 py-3 text-xs font-mono text-muted-foreground">{item.product?.sku || '—'}</td>
                      <td className="px-4 py-3 text-sm text-foreground">{item.product?.category?.name || '—'}</td>
                      <td className="px-4 py-3 text-sm text-foreground">{item.warehouse?.name || '—'}</td>
                      <td className="px-4 py-3 text-sm font-bold"><span className={isLow ? 'text-amber-600' : item.quantity_on_hand === 0 ? 'text-red-600' : 'text-foreground'}>{item.quantity_on_hand} <span className="font-normal text-muted-foreground text-xs">{unit}</span></span></td>
                      <td className="px-4 py-3 text-sm text-orange-600">{item.quantity_reserved || 0} <span className="text-xs text-muted-foreground">{unit}</span></td>
                      <td className="px-4 py-3 text-sm font-semibold text-green-600">{avail} <span className="font-normal text-muted-foreground text-xs">{unit}</span></td>
                      <td className="px-4 py-3 text-sm font-semibold text-foreground">{formatCurrency(value)}</td>
                    </tr>
                  );
                })
              }
            </tbody>
          </table>
        </div>
        <Pagination
          page={safePage}
          pageSize={pageSize}
          total={totalFiltered}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      </div>
    </div>
  );
}
