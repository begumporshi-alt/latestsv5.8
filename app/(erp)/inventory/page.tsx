'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/format';
import { fetchAll, fetchAllParallel } from '@/lib/fetch-all';
import { tokenizeSearch, matchesTokens, rankRows } from '@/lib/search';
import type { InventoryAggregates } from '@/lib/inventory-value';
import { loadQuickSellSettings } from '@/lib/quick-sell-settings';
import { toast } from '@/hooks/use-toast';
import { useRouter } from 'next/navigation';
import JsBarcode from 'jsbarcode';
import { Package, PackageMinus, Plus, Search, CreditCard as Edit, Trash2, RotateCcw, TriangleAlert as AlertTriangle, ChartBar as BarChart3, Boxes, TrendingDown, RefreshCw, X, ChevronDown, ChevronRight, Info, Settings, Barcode, Printer, Download, Upload, CircleCheck as CheckCircle2 } from 'lucide-react';
import type { Product, Category, Brand, Warehouse as WarehouseType } from '@/lib/types';
import { LABEL_SIZES, resolveLabelConfig, fitNameFontSize } from '@/lib/label-sizes';
import Pagination from '@/components/ui/AppPagination';
import { LoadingWave } from '@/components/ui/loading-wave';
import { ProductBatchesModal } from '@/components/product-batches-modal';
import { networkMonitor } from '@/lib/offline/network';
import { cachedQuery, cacheDelete } from '@/lib/offline/cache';
import { CACHE_KEYS } from '@/lib/offline/keys';
import { readData } from '@/lib/offline/read-result';
import { enqueueOp } from '@/lib/offline/outbox';
import ProductModal from '@/components/ProductModal';
import ProductBreakdown from '@/components/ProductBreakdown';
import { matchesProductGroup, STOCK_STATUS_LABELS, UNASSIGNED_GROUP, type BreakdownSelection } from '@/lib/product-breakdown';
import { StockAdjustmentModal } from '@/components/StockAdjustmentModal';
import SearchableSelect from '@/components/ui/SearchableSelect';
import {
  COLUMN_BY_KEY,
  COLUMNS,
  TEMPLATE_HEADERS,
  buildImportPlan,
  downloadTemplateWorkbook,
  fieldLabel,
  parseDelimitedText,
  parseWorkbook,
  planCounts,
  toSheetRows,
  type ImportMode,
  type ImportPlan,
  type PlannedProduct,
  type PriceScale,
  type RawTable,
} from '@/lib/import/product-import';

function StockByWarehouse({ productId, warehouses, inventoryByWarehouse, unit }: { productId: string; warehouses: WarehouseType[]; inventoryByWarehouse: Record<string, Record<string, number>>; unit?: string }) {
  const stockByWh = inventoryByWarehouse[productId] || {};
  const displayUnit = unit || 'pcs';
  return (
    <div className="text-xs space-y-0.5">
      {warehouses.map(w => {
        const qty = stockByWh[w.id] || 0;
        return (
          <div key={w.id} className="flex justify-between gap-2">
            <span className="text-muted-foreground">{w.name}:</span>
            <span className={qty > 0 ? 'text-foreground font-medium' : 'text-muted-foreground'}>{qty} {displayUnit}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Table skeleton shaped like a real product row.
 *
 * Two things must match or the page jumps when data lands:
 *
 *  - **Height.** A real row measures 61.8px because the product cell carries a
 *    36px avatar beside a 20px name and a 16px unit line. The old placeholder
 *    was a bare 16px bar in that cell — 46px per row — so eight of them came to
 *    368px against 3,090px of real rows: a 2,722px collapse, paid twice (once
 *    when data lands, once on every refresh).
 *  - **Row count.** `rows` is the page size, not a hardcoded 8, so the footer
 *    does not move.
 *
 * Only the first `animated` rows carry the travelling-light sheen. A 50-row
 * page would otherwise mount 450 blurred layers for rows nobody has scrolled
 * to yet; the rest are static bars, which read identically off-screen.
 */
function ProductRowsSkeleton({ rows, animated = 10 }: { rows: number; animated?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => {
        const live = i < animated;
        const delay = (i % animated) * 70;
        const bar = (w: string, h = 'h-3.5') =>
          live ? (
            <LoadingWave width={w} delayMs={delay} className={h} />
          ) : (
            <span className={`block rounded-full bg-muted ${h}`} style={{ width: w }} />
          );
        return (
          <tr key={i} aria-hidden="true">
            <td className="px-4 py-3">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 bg-muted rounded-lg shrink-0" />
                <div className="flex flex-col justify-center gap-1">
                  {bar('110px')}
                  {bar('48px', 'h-2.5')}
                </div>
              </div>
            </td>
            <td className="px-4 py-3">{bar('64px')}</td>
            <td className="px-4 py-3">{bar('68px')}</td>
            <td className="px-4 py-3">{bar('56px')}</td>
            <td className="px-4 py-3"><div className="flex justify-end">{bar('28px')}</div></td>
            <td className="px-4 py-3"><div className="flex justify-end">{bar('72px')}</div></td>
            <td className="px-4 py-3"><div className="flex justify-end">{bar('72px')}</div></td>
            <td className="px-4 py-3">{bar('60px', 'h-5')}</td>
            <td className="px-4 py-3">
              <div className="flex items-center justify-end gap-1">
                <span className="w-7 h-7 rounded-lg bg-muted" />
                <span className="w-7 h-7 rounded-lg bg-muted" />
                <span className="w-7 h-7 rounded-lg bg-muted" />
              </div>
            </td>
          </tr>
        );
      })}
    </>
  );
}

interface ProductWithStock extends Omit<Product, 'category' | 'brand'> {
  total_stock?: number;
  total_sold?: number;
  category?: { name: string };
  brand?: { name: string };
  product_colors?: { id: string; name: string; hex_code: string }[];
  product_sizes?: { id: string; name: string }[];
  stock_by_warehouse?: { warehouse_id: string; quantity: number }[];
}

// The cached aggregate served offline — see loadData/fetchInventoryData.
interface InventoryPageData {
  prods: any[];
  categories: any[];
  brands: any[];
  warehouses: any[];
  byWarehouse: Record<string, Record<string, number>>;
  uniqueColors: { id: string; name: string; hex_code: string }[];
  uniqueSizes: { id: string; name: string }[];
  unitTypes: { id: string; unit_name: string; unit_short: string; allow_decimal?: boolean }[];
  fMap: Record<string, number>;
  stats: { total: number; lowStock: number; outOfStock: number; value: number };
}

export default function InventoryPage() {
  const router = useRouter();
  const [products, setProducts] = useState<ProductWithStock[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [warehouses, setWarehouses] = useState<WarehouseType[]>([]);
  const [inventoryByWarehouse, setInventoryByWarehouse] = useState<Record<string, Record<string, number>>>({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [filterBrand, setFilterBrand] = useState('');
  const [filterWarehouse, setFilterWarehouse] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [breakdownSelection, setBreakdownSelection] = useState<BreakdownSelection | null>(null);
  const [filterColor, setFilterColor] = useState('');
  const [filterSize, setFilterSize] = useState('');
  const [filterUnit, setFilterUnit] = useState('');
  const [filterNonStockOnly, setFilterNonStockOnly] = useState(false);
  const [allColors, setAllColors] = useState<{ id: string; name: string; hex_code: string }[]>([]);
  const [allSizes, setAllSizes] = useState<{ id: string; name: string }[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingProduct, setEditingProduct] = useState<ProductWithStock | null>(null);
  const [deletingProduct, setDeletingProduct] = useState<ProductWithStock | null>(null);
  // One product whose stock is being corrected or written off (typed reason,
  // per-warehouse partial quantities).
  const [adjustmentProduct, setAdjustmentProduct] = useState<ProductWithStock | null>(null);
  const [barcodeProduct, setBarcodeProduct] = useState<ProductWithStock | null>(null);
  const [batchesProduct, setBatchesProduct] = useState<ProductWithStock | null>(null);
  const [showManageModal, setShowManageModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [stats, setStats] = useState({ total: 0, lowStock: 0, outOfStock: 0, value: 0 });
  const [fifoValueMap, setFifoValueMap] = useState<Record<string, number>>({});
  const [unitTypes, setUnitTypes] = useState<{ id: string; unit_name: string; unit_short: string; allow_decimal?: boolean }[]>([]);
  const [dataStale, setDataStale] = useState(false);
  // A successful load has landed at least once. `loading` alone cannot tell
  // "nothing on screen yet" from "a refetch is in flight", and those two need
  // opposite treatment: the first needs a skeleton, the second must not blank
  // rows the user is already reading.
  const [hasData, setHasData] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => { loadData(); }, []);

  // The whole aggregate (products + stock + stats + FIFO values) is cached
  // under one key: offline, the page renders the last snapshot with a stale
  // banner instead of an error. `force` bypasses the TTL (post-save reloads,
  // the refresh button) so edits are never masked by a fresh cache copy.
  async function loadData(force = false) {
    setLoading(true);
    if (force) await cacheDelete(CACHE_KEYS.inventoryPage);
    try {
      const res = await cachedQuery<InventoryPageData>(CACHE_KEYS.inventoryPage, 60_000, fetchInventoryData);
      applyInventoryData(res.data, res.offline || !res.fresh);
      setHasData(true);
      setLoadFailed(false);
    } catch {
      // Clearing `products` unconditionally used to drop the table through to
      // the success-empty state — "No products found" — on a failed request.
      // A failed refresh must keep the rows already on screen; only a failed
      // *first* load has nothing to keep.
      if (!hasData) setProducts([]);
      setLoadFailed(true);
      toast({
        title: hasData ? 'Refresh failed — showing the previous load' : 'Offline — no cached inventory data',
        description: hasData
          ? 'The stock figures below are from the last successful load.'
          : 'Open this page once while online so this device builds its offline copy.',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  }

  /**
   * Drop the POS-facing snapshots after a catalog mutation that does NOT go
   * through ProductModal (deactivate, restore, CSV import). ProductModal drops
   * them itself, and the offline branches get the same drop from the outbox's
   * OP_CACHE_KEYS — but these direct online writes had nothing, so the till
   * kept serving its pre-change copy for the full 10-minute snapshot TTL: a
   * just-deactivated product stayed sellable and a restored one stayed
   * invisible until the TTL ran out. The replica pull that follows is what the
   * POS rebuilds the snapshot from.
   */
  function dropPosSnapshots() {
    void cacheDelete(CACHE_KEYS.products);
    void cacheDelete(CACHE_KEYS.gateStock);
  }

  async function fetchInventoryData(): Promise<InventoryPageData> {
    // Stock, sold totals and FIFO valuation used to be computed client-side
    // from every inventory_items / invoice_items / inventory_batches row —
    // 10+ sequential 1000-row round trips per load. The
    // get_inventory_page_aggregates RPC computes the same numbers set-based
    // and returns them as ONE jsonb row (immune to the 1000-row cap that
    // forced those pagination loops), so the page loads with three parallel
    // groups instead: products, the aggregate RPC, and reference tables.
    const [allProds, aggRes, refRes, qsSettings] = await Promise.all([
      // Products change slowly and the list spans 3+ pages — fetch the pages
      // in parallel (one round trip) instead of serially.
      fetchAllParallel(() => supabase
        .from('products')
        .select('*, category:categories(name), brand:brands(name), product_colors(id, name, hex_code), product_sizes(id, name)')
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })),
      supabase.rpc('get_inventory_page_aggregates'),
      Promise.all([
        supabase.from('categories').select('*').eq('is_active', true),
        supabase.from('brands').select('*').eq('is_active', true),
        supabase.from('warehouses').select('*').eq('is_active', true).order('is_default', { ascending: false }),
        // Unbounded reference tables — paginate past the 1000-row cap too.
        fetchAll(() => supabase.from('product_colors').select('id, name, hex_code').order('name').order('id')),
        fetchAll(() => supabase.from('product_sizes').select('id, name').order('name').order('id')),
        supabase.from('unit_types').select('id, unit_name, unit_short, allow_decimal').eq('is_active', true).order('unit_name'),
      ]),
      loadQuickSellSettings(supabase),
    ]);
    if (aggRes.error) throw aggRes.error;
    const [catRes, brandRes, whRes, colorRows, sizeRows, unitTypeRes] = refRes;

    const agg = (aggRes.data || {}) as InventoryAggregates;
    const stockMap: Record<string, number> = {};
    const byWarehouse: Record<string, Record<string, number>> = {};
    const soldMap: Record<string, number> = {};
    const fMap: Record<string, number> = {};
    for (const [pid, a] of Object.entries(agg.products || {})) {
      stockMap[pid] = Number(a.stock) || 0;
      soldMap[pid] = Number(a.sold) || 0;
      fMap[pid] = Number(a.fifo) || 0;
      byWarehouse[pid] = {};
      for (const [wid, w] of Object.entries(a.warehouses || {})) {
        byWarehouse[pid][wid] = Number(w.stock) || 0;
        // A null pair fifo must stay unset so pairFifoValue keeps falling
        // back to qty × cost_price for batch-less stock pairs.
        if (w.fifo !== null && w.fifo !== undefined) fMap[`${pid}|${wid}`] = Number(w.fifo);
      }
    }
    // Positive-batch pairs with no inventory_items row (ledger drift) — the
    // old client keyed fMap by every positive batch pair, counters or not.
    for (const [pid, ws] of Object.entries(agg.batch_only_pairs || {})) {
      for (const [wid, val] of Object.entries(ws)) fMap[`${pid}|${wid}`] = Number(val);
    }

    // Quick Sell catalog entries stay out of the inventory list (and its
    // stats) unless the admin setting allows them in. They keep working
    // everywhere else — Quick Sell reuse, reports, invoice history.
    const listedProds = qsSettings.show_in_inventory
      ? allProds
      : (allProds as any[]).filter((p: any) => !p.is_quick_sell);

    const prods = listedProds.map((p: any) => ({
      ...p,
      total_stock: stockMap[p.id] || 0,
      total_sold: soldMap[p.id] || 0,
      stock_by_warehouse: Object.entries(byWarehouse[p.id] || {}).map(([warehouse_id, quantity]) => ({
        warehouse_id,
        quantity,
      })),
    }));

    const seenColors = new Set<string>();
    const uniqueColors = (colorRows as any[]).filter((c: any) => {
      if (seenColors.has(c.name)) return false;
      seenColors.add(c.name);
      return true;
    });

    const seenSizes = new Set<string>();
    const uniqueSizes = (sizeRows as any[]).filter((s: any) => {
      if (seenSizes.has(s.name)) return false;
      seenSizes.add(s.name);
      return true;
    });

    const activeProds = prods.filter((p: any) => p.is_active);
    const lowStock = activeProds.filter((p: any) => (p.total_stock || 0) > 0 && (p.total_stock || 0) <= p.min_stock_level).length;
    const outOfStock = activeProds.filter((p: any) => (p.total_stock || 0) === 0).length;

    return {
      prods,
      categories: catRes.data || [],
      brands: brandRes.data || [],
      warehouses: whRes.data || [],
      byWarehouse,
      uniqueColors,
      uniqueSizes,
      unitTypes: unitTypeRes.data || [],
      fMap,
      stats: {
        total: activeProds.length,
        lowStock,
        outOfStock,
        value: Number(agg.total_value) || 0,
      },
    };
  }

  function applyInventoryData(d: InventoryPageData, stale: boolean) {
    setProducts(d.prods as ProductWithStock[]);
    setCategories(d.categories as Category[]);
    setBrands(d.brands as Brand[]);
    setWarehouses(d.warehouses as WarehouseType[]);
    setInventoryByWarehouse(d.byWarehouse);
    setAllColors(d.uniqueColors);
    setAllSizes(d.uniqueSizes);
    setUnitTypes(d.unitTypes);
    setFifoValueMap(d.fMap);
    setStats(d.stats);
    setDataStale(stale);
  }

  // Memoized: these run over all 2,700+ products on every keystroke otherwise.
  // Search semantics match the POS grid: sanitised order-independent tokens
  // across name, SKU and barcode, with word-boundary hits ranked first.
  const filtered = useMemo(() => {
    const tokens = tokenizeSearch(search);
    const searchCols = ['name', 'sku', 'barcode'];
    const list = products.filter(p => {
      const matchSearch = !search || matchesTokens(p, searchCols, tokens);
      // Soft-deleted rows (is_active = false) are hidden by default so the list
      // total matches the "Total Products" card, which counts active only. The
      // Status filter's "Inactive" option is the single way back to them.
      const matchActive = filterStatus === 'inactive' ? p.is_active === false : p.is_active !== false;
      const matchCat = matchesProductGroup(p, 'category', filterCategory, inventoryByWarehouse);
      const matchBrand = matchesProductGroup(p, 'brand', filterBrand, inventoryByWarehouse);
      const matchWarehouse = matchesProductGroup(p, 'warehouse', filterWarehouse, inventoryByWarehouse);
      const matchStockTracking = !filterNonStockOnly ? true : (p as any).track_inventory === false;
      const matchStatus = !filterStatus || (
        Object.hasOwn(STOCK_STATUS_LABELS, filterStatus) ? matchesProductGroup(p, 'status', filterStatus, inventoryByWarehouse) :
        filterStatus === 'sold_out' ? (p.total_stock || 0) === 0 && (p.total_sold || 0) > 0 :
        filterStatus === 'has_stock' ? (p.total_stock || 0) > 0 : true
      );
      const matchColor = !filterColor || p.product_colors?.some(c => c.name === filterColor);
      const matchSize = !filterSize || p.product_sizes?.some(s => s.name === filterSize);
      const matchUnit = !filterUnit || (p.unit && p.unit.toLowerCase() === filterUnit.toLowerCase());
      return matchSearch && matchActive && matchCat && matchBrand && matchWarehouse && matchStockTracking && matchStatus && matchColor && matchSize && matchUnit;
    });
    if (!search || tokens.length === 0) return list;
    return rankRows(list, p => [p.name, p.sku || '', p.barcode || ''], tokens);
  }, [products, search, filterCategory, filterBrand, filterWarehouse, filterStatus, filterColor, filterSize, filterUnit, filterNonStockOnly, inventoryByWarehouse]);
  const pagedFiltered = useMemo(() => filtered.slice((page - 1) * pageSize, page * pageSize), [filtered, page, pageSize]);

  // Stable identity for the importer's SKU lookup — a fresh array on every
  // render would re-plan the preview each time the parent re-renders.
  const importTargets = useMemo(
    () => products.map(p => ({
      id: p.id,
      sku: p.sku,
      name: p.name,
      unit: p.unit,
      base_unit: p.base_unit,
      enable_multi_unit: (p as any).enable_multi_unit,
      is_active: p.is_active,
      sale_price: p.sale_price,
      cost_price: p.cost_price,
    })),
    [products]
  );
  // Reset to page 1 when filters change
  useEffect(() => { setPage(1); }, [search, filterCategory, filterBrand, filterStatus, filterWarehouse, filterColor, filterSize, filterUnit, filterNonStockOnly]);

  // FIFO value of one product|warehouse pair; stock without batch layers falls
  // back to qty × cost_price, matching getInventoryValue's semantics.
  const pairFifoValue = (productId: string, warehouseId: string, costPrice: number): number => {
    const fifo = fifoValueMap[`${productId}|${warehouseId}`];
    if (fifo !== undefined) return fifo;
    const qty = inventoryByWarehouse[productId]?.[warehouseId] || 0;
    return qty > 0 ? qty * costPrice : 0;
  };
  // Warehouse-scoped readouts: with a warehouse filter active, count only that
  // warehouse's stock and FIFO value, not the product's all-warehouse totals.
  const scopedWarehouse = filterWarehouse === UNASSIGNED_GROUP ? '' : filterWarehouse;
  const filteredStock = useMemo(() => scopedWarehouse
    ? filtered.reduce((sum, p) => sum + (inventoryByWarehouse[p.id]?.[scopedWarehouse] || 0), 0)
    : filtered.reduce((sum, p) => sum + (p.total_stock || 0), 0), [filtered, scopedWarehouse, inventoryByWarehouse]);
  const filteredValue = useMemo(() => scopedWarehouse
    ? filtered.reduce((sum, p) => sum + pairFifoValue(p.id, scopedWarehouse, Number(p.cost_price || 0)), 0)
    : filtered.reduce((sum, p) => {
        let value = fifoValueMap[p.id] || 0;
        for (const wid of Object.keys(inventoryByWarehouse[p.id] || {})) {
          if (fifoValueMap[`${p.id}|${wid}`] === undefined) {
            value += pairFifoValue(p.id, wid, Number(p.cost_price || 0));
          }
        }
        return sum + value;
      }, 0), [filtered, scopedWarehouse, fifoValueMap, inventoryByWarehouse]);

  // Value carried by one product: product-level FIFO layers plus qty × cost_price
  // for pairs with no layer. Same formula as the "Filtered value" chip, so a
  // write-off quotes the number the page is already showing.
  const productValue = (p: ProductWithStock): number => {
    let value = fifoValueMap[p.id] || 0;
    for (const wid of Object.keys(inventoryByWarehouse[p.id] || {})) {
      if (fifoValueMap[`${p.id}|${wid}`] === undefined) {
        value += pairFifoValue(p.id, wid, Number(p.cost_price || 0));
      }
    }
    return value;
  };
  // Deleted products still carrying stock or layers — the write-off backlog.
  // Value can outlive the counter (one deleted product has 300 units in layers
  // with zero on hand), so both sides are checked.
  const orphanedInactive = useMemo(
    () => products.filter(p => p.is_active === false && ((p.total_stock || 0) !== 0 || (fifoValueMap[p.id] || 0) > 0)),
    [products, fifoValueMap]
  );

  function getStockBadge(qty: number, min: number) {
    if (qty < 0) return <span className="badge-status bg-red-100 text-red-700 border border-red-200">Oversold (IOU)</span>;
    if (qty === 0) return <span className="badge-status bg-red-50 text-red-600">Out of Stock</span>;
    if (qty <= min) return <span className="badge-status bg-amber-50 text-amber-600">Low Stock</span>;
    return <span className="badge-status bg-green-50 text-green-600">In Stock</span>;
  }

  function selectBreakdown(selection: BreakdownSelection) {
    clearFilters();
    setBreakdownSelection(selection);
    if (selection.dimension === 'category') setFilterCategory(selection.key);
    if (selection.dimension === 'brand') setFilterBrand(selection.key);
    if (selection.dimension === 'status') setFilterStatus(selection.key);
    if (selection.dimension === 'warehouse') setFilterWarehouse(selection.key);
    setPage(1);
  }

  function clearFilters() {
    setBreakdownSelection(null);
    setSearch('');
    setFilterCategory('');
    setFilterBrand('');
    setFilterWarehouse('');
    setFilterStatus('');
    setFilterColor('');
    setFilterSize('');
    setFilterUnit('');
    setFilterNonStockOnly(false);
  }

  // Export writes the same column contract the importer reads, so a file can
  // be exported, edited in Excel and imported straight back.
  function exportProducts() {
    const records = filtered.map(p => ({
      name: p.name,
      sku: p.sku,
      barcode: (p as any).barcode || '',
      category: (p as any).category?.name || '',
      brand: (p as any).brand?.name || '',
      unit: p.base_unit || p.unit || '',
      cost_price: p.cost_price,
      sale_price: p.sale_price,
      mrp: (p as any).mrp ?? '',
      tax_rate: p.tax_rate,
      min_stock_level: p.min_stock_level,
      current_stock: p.total_stock || 0,
      description: (p as any).description || '',
      color: (p.product_colors || []).map(c => c.name).join(' | '),
      size: (p.product_sizes || []).map(s => s.name).join(' | '),
      warranty_months: (p as any).warranty_months ?? '',
      track_inventory: (p as any).track_inventory === false ? 'no' : 'yes',
    }));
    const ws = XLSX.utils.json_to_sheet(toSheetRows(records), { header: TEMPLATE_HEADERS });
    ws['!cols'] = TEMPLATE_HEADERS.map(label => ({ wch: Math.max(14, label.length + 2) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Products');
    XLSX.writeFile(wb, `inventory-${new Date().toISOString().split('T')[0]}.xlsx`);
    const scope = filterStatus === 'inactive' ? 'inactive products' : 'the current filtered view';
    toast({ title: 'Exported', description: `${records.length} products from ${scope}. Re-import this file to update them.` });
  }

  async function handleDelete() {
    if (!deletingProduct) return;
    // Offline: queue a version-checked deactivation.
    if (!networkMonitor.getState().online) {
      try {
        await enqueueOp('product.status', {
          idempotency_key: crypto.randomUUID(),
          id: deletingProduct.id,
          is_active: false,
          expected_updated_at: (deletingProduct as any)?.updated_at || null,
        }, `Deactivate product — ${deletingProduct.name}`);
        toast({ title: 'Queued offline', description: 'The product will be deactivated when you reconnect.' });
        loadData(true);
      } catch (err: any) {
        toast({ title: 'Error', description: err?.message || 'Could not queue the deactivation', variant: 'destructive' });
      }
      setDeletingProduct(null);
      return;
    }
    const { error } = await supabase.from('products').update({ is_active: false }).eq('id', deletingProduct.id);
    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    } else {
      toast({ title: 'Success', description: 'Product deleted successfully' });
      dropPosSnapshots();
      loadData(true);
    }
    setDeletingProduct(null);
  }

  // Undo a soft delete: deletion only flips is_active to false, so restoring is
  // the same write in reverse. Available from Status → Inactive.
  async function handleRestore(product: ProductWithStock) {
    if (!networkMonitor.getState().online) {
      try {
        await enqueueOp('product.status', {
          idempotency_key: crypto.randomUUID(),
          id: product.id,
          is_active: true,
          expected_updated_at: (product as any)?.updated_at || null,
        }, `Restore product — ${product.name}`);
        toast({ title: 'Queued offline', description: 'The product will be restored when you reconnect.' });
        loadData(true);
      } catch (err: any) {
        toast({ title: 'Error', description: err?.message || 'Could not queue the restore', variant: 'destructive' });
      }
      return;
    }
    const { error } = await supabase.from('products').update({ is_active: true }).eq('id', product.id);
    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    } else {
      toast({ title: 'Restored', description: `${product.name} is active again` });
      dropPosSnapshots();
      loadData(true);
    }
  }

  const categoryOptions = [
    { value: '', label: 'All Categories' },
    { value: UNASSIGNED_GROUP, label: 'Uncategorized' },
    ...categories.filter(c => !c.parent_id).flatMap(c => [
      { value: c.id, label: c.name, group: c.name },
      ...categories.filter(sc => sc.parent_id === c.id).map(sc => ({ value: sc.id, label: `  ${sc.name}`, group: c.name })),
    ]),
  ];
  if (breakdownSelection?.dimension === 'category' && !categoryOptions.some(option => option.value === breakdownSelection.key)) {
    categoryOptions.push({ value: breakdownSelection.key, label: breakdownSelection.label });
  }
  const selectedBreakdownVisible = breakdownSelection && ({
    category: filterCategory, brand: filterBrand, status: filterStatus, warehouse: filterWarehouse,
  })[breakdownSelection.dimension] === breakdownSelection.key;
  const firstLoad = loading && !hasData;
  const pagedStart = filtered.length === 0 ? 0 : (page - 1) * pageSize + 1;
  const pagedEnd = Math.min(page * pageSize, filtered.length);

  return (
    <div className="space-y-5 animate-fade-in">
      {dataStale && (
        <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-4 py-2 text-xs font-medium">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          Showing cached data — stock levels and stats are from the last online session. Changes made here are queued and will sync automatically.
        </div>
      )}
      {/* A failed refresh keeps the previous rows on screen. The toast is
          transient, so without this the page would show stale figures with no
          indication that the reload did not land. */}
      {loadFailed && hasData && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-800 rounded-lg px-4 py-2 text-xs font-medium">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          Refresh failed — the figures below are from the last successful load.
        </div>
      )}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Inventory</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Manage products and stock levels</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setShowManageModal(true)}
            className="flex items-center gap-2 border border-border hover:bg-muted text-foreground px-3 py-2 rounded-lg text-sm font-semibold transition"
          >
            <Settings className="w-4 h-4" />
            Manage
          </button>
          <button
            onClick={exportProducts}
            className="flex items-center gap-2 border border-border hover:bg-muted text-foreground px-3 py-2 rounded-lg text-sm font-semibold transition"
          >
            <Download className="w-4 h-4" />
            Export
          </button>
          <button
            onClick={() => setShowImportModal(true)}
            className="flex items-center gap-2 border border-border hover:bg-muted text-foreground px-3 py-2 rounded-lg text-sm font-semibold transition"
          >
            <Upload className="w-4 h-4" />
            Import
          </button>
          <button
            onClick={() => setShowAddModal(true)}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition"
          >
            <Plus className="w-4 h-4" />
            Add Product
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Total Products', value: stats.total, waveWidth: '46px', icon: Boxes, color: 'text-blue-500 bg-blue-50' },
          { label: 'Low Stock', value: stats.lowStock, waveWidth: '26px', icon: AlertTriangle, color: 'text-amber-500 bg-amber-50' },
          { label: 'Out of Stock', value: stats.outOfStock, waveWidth: '26px', icon: TrendingDown, color: 'text-red-500 bg-red-50' },
          { label: 'Inventory Value', value: formatCurrency(stats.value), waveWidth: '118px', icon: BarChart3, color: 'text-green-500 bg-green-50' },
        ].map((s, i) => {
          const content = <>
            <div className={`w-10 h-10 shrink-0 rounded-full flex items-center justify-center ${s.color}`}>
              <s.icon className="w-5 h-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">{s.label}</p>
              <div className="flex h-7 items-center">
                {hasData ? (
                  <p className="text-lg font-bold text-foreground">{s.value}</p>
                ) : firstLoad ? (
                  <LoadingWave width={s.waveWidth} delayMs={i * 110} />
                ) : (
                  <p className="text-lg font-bold text-muted-foreground" title="This figure could not be loaded">—</p>
                )}
              </div>
            </div>
          </>;
          return i === 0 ? (
            <ProductBreakdown key={s.label} products={products} stock={inventoryByWarehouse} warehouses={warehouses} categories={categories} brands={brands} stale={dataStale || loadFailed} onSelect={selectBreakdown}>
              <button type="button" disabled={!hasData} aria-label={`Total Products: ${hasData ? stats.total : 'unavailable'}. View breakdown`} className="stat-card group flex items-center gap-3 text-left transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60">
                {content}
                <ChevronRight aria-hidden="true" className="ml-auto h-4 w-4 shrink-0 text-muted-foreground group-hover:text-primary" />
              </button>
            </ProductBreakdown>
          ) : <div key={s.label} className="stat-card flex items-center gap-3">{content}</div>;
        })}
      </div>

      <div className="bg-white rounded-xl border border-border p-4 shadow-sm flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name, SKU or barcode..."
            className="w-full pl-8 pr-4 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          />
        </div>
        <SearchableSelect
          value={filterCategory}
          onChange={setFilterCategory}
          placeholder="All Categories"
          className="min-w-[150px]"
          options={categoryOptions}
        />
        <SearchableSelect
          value={filterBrand}
          onChange={setFilterBrand}
          placeholder="All Brands"
          className="min-w-[130px]"
          options={[
            { value: '', label: 'All Brands' },
            { value: UNASSIGNED_GROUP, label: 'No brand' },
            ...brands.map(b => ({ value: b.id, label: b.name })),
            ...(breakdownSelection?.dimension === 'brand' && breakdownSelection.key !== UNASSIGNED_GROUP && !brands.some(b => b.id === breakdownSelection.key)
              ? [{ value: breakdownSelection.key, label: breakdownSelection.label }] : []),
          ]}
        />
        <select value={filterWarehouse} onChange={e => setFilterWarehouse(e.target.value)} className="border border-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20">
          <option value="">All Warehouses</option>
          <option value={UNASSIGNED_GROUP}>No positive warehouse stock</option>
          {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          {breakdownSelection?.dimension === 'warehouse' && breakdownSelection.key !== UNASSIGNED_GROUP && !warehouses.some(w => w.id === breakdownSelection.key) && (
            <option value={breakdownSelection.key}>{breakdownSelection.label}</option>
          )}
        </select>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="border border-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20">
          <option value="">All Status</option>
          <option value="ok">In Stock</option>
          <option value="low">Low Stock</option>
          <option value="has_stock">Has Stock</option>
          <option value="out">Out of Stock</option>
          <option value="sold_out">Sold Out (Zero after Sales)</option>
          <option value="negative">Negative (Oversold IOU)</option>
          <option value="inactive">Inactive (deleted)</option>
        </select>
        <button
          type="button"
          onClick={() => setFilterNonStockOnly(v => !v)}
          className={`flex items-center gap-1.5 border rounded-lg px-3 py-2 text-sm font-medium transition whitespace-nowrap ${
            filterNonStockOnly ? 'border-amber-500 bg-amber-50 text-amber-700' : 'border-border text-muted-foreground hover:bg-muted bg-white'
          }`}
          title="Show only quick-sell (non-stock) items — bought on demand, never stocked"
        >
          ⚡ Non-stock only
        </button>
        {allColors.length > 0 && (
          <SearchableSelect
            value={filterColor}
            onChange={setFilterColor}
            placeholder="All Colors"
            className="min-w-[120px]"
            options={[{ value: '', label: 'All Colors' }, ...allColors.map(c => ({ value: c.name, label: c.name }))]}
          />
        )}
        {allSizes.length > 0 && (
          <select value={filterSize} onChange={e => setFilterSize(e.target.value)} className="border border-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20">
            <option value="">All Sizes</option>
            {allSizes.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
          </select>
        )}
        {unitTypes.length > 0 && (
          <SearchableSelect
            value={filterUnit}
            onChange={setFilterUnit}
            placeholder="All Units"
            className="min-w-[110px]"
            options={[{ value: '', label: 'All Units' }, ...unitTypes.map(u => ({ value: u.unit_name, label: u.unit_name }))]}
          />
        )}
        <button
          onClick={() => loadData(true)}
          disabled={loading}
          className="flex items-center gap-2 border border-border rounded-lg px-3 py-2 text-sm hover:bg-muted transition disabled:opacity-60 disabled:cursor-not-allowed"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          {firstLoad ? 'Loading…' : loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {selectedBreakdownVisible && breakdownSelection && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm" role="status">
          <span className="capitalize text-muted-foreground">{breakdownSelection.dimension}:</span>
          <span className="font-medium">{breakdownSelection.label}</span>
          <button type="button" onClick={clearFilters} className="ml-auto inline-flex min-h-9 items-center gap-1 rounded-md px-2 text-primary hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><X className="h-3.5 w-3.5" aria-hidden="true" /> Clear filters</button>
        </div>
      )}
      <div className="flex items-center gap-4 flex-wrap text-sm">
        <span className="inline-flex items-center gap-2 px-3 py-1.5 bg-blue-50 text-blue-700 rounded-lg font-medium">
          <Boxes className="w-4 h-4" />
          {hasData ? `Showing ${pagedStart}–${pagedEnd} of ${filtered.length} products` : 'Showing — products'}
        </span>
        <span className="inline-flex items-center gap-2 px-3 py-1.5 bg-green-50 text-green-700 rounded-lg font-medium">
          <Package className="w-4 h-4" />
          Total stock: {hasData ? `${filteredStock.toLocaleString()} items` : '—'}
        </span>
        <span className="inline-flex items-center gap-2 px-3 py-1.5 bg-amber-50 text-amber-700 rounded-lg font-medium">
          <AlertTriangle className="w-4 h-4" />
          Low stock: {hasData ? filtered.filter(p => (p.total_stock || 0) > 0 && (p.total_stock || 0) <= p.min_stock_level).length : '—'}
        </span>
        <span className="inline-flex items-center gap-2 px-3 py-1.5 bg-red-50 text-red-700 rounded-lg font-medium">
          <TrendingDown className="w-4 h-4" />
          Out of stock: {hasData ? filtered.filter(p => (p.total_stock || 0) === 0).length : '—'}
        </span>
        <span className="inline-flex items-center gap-2 px-3 py-1.5 bg-muted text-muted-foreground rounded-lg font-medium">
          <BarChart3 className="w-4 h-4" />
          Filtered value: {hasData ? formatCurrency(filteredValue) : '—'}
        </span>
      </div>

      {filterStatus === 'inactive' && orphanedInactive.length > 0 && (
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-amber-900">
              {orphanedInactive.length} deleted product{orphanedInactive.length === 1 ? '' : 's'} still hold stock worth {formatCurrency(orphanedInactive.reduce((s, p) => s + productValue(p), 0))}
            </p>
            <p className="text-xs text-amber-800 mt-0.5">
              Their value is excluded from the inventory totals, but the stock and its journal entries are still on the books. Adjust each product&apos;s stock from its row (reason: Damaged, Stolen, Expired, Destroyed or Obsolete) to write it off, or restore the product if the deletion was a mistake.
            </p>
          </div>
        </div>
      )}

      <div className="table-wrapper">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-muted/40 border-b border-border">
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Product</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">SKU</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Category</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Brand</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Stock</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Cost</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Sale Price</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Status</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {firstLoad ? (
                <ProductRowsSkeleton rows={pageSize} />
              ) : !hasData ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center">
                    <p className="text-sm font-semibold text-foreground">{"Couldn't load products"}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      The inventory request did not come back. Nothing in the catalogue was changed.
                    </p>
                    <button
                      onClick={() => loadData(true)}
                      className="mt-3 inline-flex items-center gap-1.5 border border-border rounded-lg px-3 py-1.5 text-xs font-semibold hover:bg-muted transition"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      Try again
                    </button>
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center">
                    <p className="text-sm text-muted-foreground">
                      {products.length === 0 ? 'No products to show' : 'No products match these filters'}
                    </p>
                    {products.length > 0 && (
                      <button onClick={clearFilters} className="mt-2 text-xs text-blue-600 font-medium hover:underline">
                        Clear filters
                      </button>
                    )}
                  </td>
                </tr>
              ) : (
                pagedFiltered.map((p) => (
                  <tr key={p.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 bg-muted rounded-lg overflow-hidden shrink-0">
                          {p.image_url ? (
                            <img src={p.image_url} alt={p.name} className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center"><Package className="w-4 h-4 text-muted-foreground" /></div>
                          )}
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-foreground hover:text-blue-600 hover:underline cursor-pointer" onClick={() => router.push(`/inventory/${p.id}`)}>{p.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {(p as any).track_inventory === false
                              ? <span className="text-amber-600 font-medium">⚡ Non-stock (quick sell)</span>
                              : p.enable_multi_unit
                                ? <span className="text-blue-600" title="Stock is counted in the base unit">{p.base_unit || p.unit}<span className="text-[10px] text-muted-foreground font-medium"> · multi-unit</span></span>
                                : p.unit}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground font-mono">{p.sku}</td>
                    <td className="px-4 py-3 text-sm text-foreground">{p.category?.name || '—'}</td>
                    <td className="px-4 py-3 text-sm text-foreground">{p.brand?.name || '—'}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="group relative">
                        <button
                          type="button"
                          onClick={() => setBatchesProduct(p)}
                          title="View batches"
                          className={`text-sm font-bold rounded px-1 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 ${(p.total_stock || 0) <= 0 ? 'text-red-500' : (p.total_stock || 0) <= p.min_stock_level ? 'text-amber-500' : 'text-foreground'}`}
                        >
                          {p.total_stock || 0}
                        </button>
                        <div className="absolute right-0 top-full mt-1 bg-white border border-border rounded-lg shadow-lg p-3 z-10 hidden group-hover:block min-w-[180px]">
                          <p className="text-xs font-semibold mb-2 text-foreground">Stock by Location:</p>
                          <StockByWarehouse productId={p.id} warehouses={warehouses} inventoryByWarehouse={inventoryByWarehouse} unit={p.unit || 'pcs'} />
                          <p className="text-[10px] text-muted-foreground mt-2 pt-2 border-t border-border/60">Click the stock number to view batches</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-right text-foreground">{formatCurrency(p.cost_price)}</td>
                    <td className="px-4 py-3 text-sm text-right font-semibold text-foreground">{formatCurrency(p.sale_price)}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col items-start gap-1">
                        {!p.is_active && (
                          <span className="badge-status bg-gray-100 text-gray-600 border border-gray-200">Inactive</span>
                        )}
                        {getStockBadge(p.total_stock || 0, p.min_stock_level)}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => setBarcodeProduct(p)} title="View Barcode" className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-green-50 text-muted-foreground hover:text-green-600 transition">
                          <Barcode className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => setEditingProduct(p)} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-blue-50 text-muted-foreground hover:text-blue-600 transition">
                          <Edit className="w-3.5 h-3.5" />
                        </button>
                        {/* Stock adjustments (corrections and typed-reason
                            write-offs) apply to every stock-tracked product —
                            active or inactive. Non-stock quick-sell items are
                            excluded; the server rejects them too. */}
                        {(p as any).track_inventory !== false && (
                          <button onClick={() => setAdjustmentProduct(p)} title="Adjust stock" className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-amber-50 text-muted-foreground hover:text-amber-600 transition">
                            <PackageMinus className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {p.is_active ? (
                          <button onClick={() => setDeletingProduct(p)} title="Delete product" className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-red-50 text-muted-foreground hover:text-red-600 transition">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        ) : (
                          <button onClick={() => handleRestore(p)} title="Restore product" className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-green-50 text-muted-foreground hover:text-green-600 transition">
                            <RotateCcw className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <Pagination
          page={page}
          pageSize={pageSize}
          total={filtered.length}
          loading={firstLoad}
          onPageChange={setPage}
          onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
          pageSizeOptions={[25, 50, 100, 200]}
        />
      </div>

      {showAddModal && (
        <ProductModal categories={categories} brands={brands} warehouses={warehouses} unitTypes={unitTypes} onClose={() => setShowAddModal(false)} onSaved={() => loadData(true)} />
      )}
      {editingProduct && (
        <ProductModal categories={categories} brands={brands} warehouses={warehouses} unitTypes={unitTypes} product={editingProduct} onClose={() => setEditingProduct(null)} onSaved={() => loadData(true)} />
      )}
      {deletingProduct && (
        <DeleteConfirmModal product={deletingProduct} stockValue={productValue(deletingProduct)} onClose={() => setDeletingProduct(null)} onConfirm={handleDelete} />
      )}
      {adjustmentProduct && (
        <StockAdjustmentModal
          product={adjustmentProduct}
          warehouses={warehouses}
          inventoryByWarehouse={inventoryByWarehouse}
          pairValueFor={(wid) => pairFifoValue(adjustmentProduct.id, wid, Number(adjustmentProduct.cost_price || 0))}
          onClose={() => setAdjustmentProduct(null)}
          onDone={() => { setAdjustmentProduct(null); dropPosSnapshots(); loadData(true); }}
        />
      )}
      {barcodeProduct && (
        <BarcodeModal product={barcodeProduct} onClose={() => setBarcodeProduct(null)} />
      )}
      {batchesProduct && (
        <ProductBatchesModal product={batchesProduct} onClose={() => setBatchesProduct(null)} />
      )}
      {showManageModal && (
        <ManageCatalogModal categories={categories} brands={brands} unitTypes={unitTypes} onClose={() => setShowManageModal(false)} onSaved={() => loadData(true)} />
      )}
      {showImportModal && (
        <ImportModal
          categories={categories}
          brands={brands}
          warehouses={warehouses}
          unitTypes={unitTypes}
          existingProducts={importTargets}
          onClose={() => setShowImportModal(false)}
          onImported={() => { dropPosSnapshots(); loadData(true); }}
        />
      )}
    </div>
  );
}

function DeleteConfirmModal({ product, stockValue = 0, onClose, onConfirm }: { product: ProductWithStock; stockValue?: number; onClose: () => void; onConfirm: () => void }) {
  const qty = product.total_stock || 0;
  const holdsStock = qty !== 0 || stockValue > 0;
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl">
        <div className="p-6">
          <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <Trash2 className="w-6 h-6 text-red-600" />
          </div>
          <h2 className="text-lg font-bold text-center mb-2">Delete Product?</h2>
          <p className={`text-sm text-muted-foreground text-center ${holdsStock ? 'mb-4' : 'mb-6'}`}>
            Are you sure you want to delete <span className="font-semibold text-foreground">{product.name}</span>? It will be hidden from inventory and all product lists, but its stock and sales history are kept. You can restore it later from Status → Inactive.
          </p>
          {holdsStock && (
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-6 text-left">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-800">
                This product still holds <span className="font-semibold">{qty} unit{qty === 1 ? '' : 's'}</span>
                {stockValue > 0 && <> worth <span className="font-semibold">{formatCurrency(stockValue)}</span></>}
                {' '}across your warehouses. Deleting hides the product but keeps that stock on the books — use Adjust stock on the row if the goods are gone.
              </p>
            </div>
          )}
          <div className="flex gap-3">
            <button onClick={onClose} className="flex-1 px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Cancel</button>
            <button onClick={onConfirm} className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-semibold transition">Delete</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ImportModal({ categories, brands, warehouses, unitTypes, existingProducts, onClose, onImported }: {
  categories: Category[];
  brands: Brand[];
  warehouses: WarehouseType[];
  unitTypes: { id: string; unit_name: string; unit_short: string; allow_decimal?: boolean }[];
  existingProducts: { id: string; sku: string; name: string; unit?: string | null; base_unit?: string | null; enable_multi_unit?: boolean | null; is_active?: boolean | null; sale_price?: number | null; cost_price?: number | null }[];
  onClose: () => void;
  onImported: () => void;
}) {
  const TENANT = '00000000-0000-0000-0000-000000000001';
  const [activeTab, setActiveTab] = useState<'upload' | 'paste' | 'guide'>('upload');
  const [importMode, setImportMode] = useState<ImportMode>('simple');
  const [pasteText, setPasteText] = useState('');
  // The parsed source is kept so switching mode can re-plan without re-uploading.
  const [source, setSource] = useState<{ table: RawTable; label: string } | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0, stage: '' });
  const [result, setResult] = useState<{ created: number; updated: number; skipped: number; errors: string[] } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const defaultWarehouse = warehouses.find(w => w.is_default)?.id || warehouses[0]?.id;
  const money = (v: number | null | undefined) => `৳${(Number(v) || 0).toFixed(2)}`;
  const counts = plan ? planCounts(plan) : null;
  // Stock is written to the default warehouse; without one, opening quantities
  // would be dropped silently, so the import is blocked instead.
  const needsWarehouse = !!plan && !defaultWarehouse && plan.products.some(p => p.stockTarget !== undefined);
  const canImport = !!plan && plan.errors.length === 0 && plan.products.length > 0 && !importing && !needsWarehouse;

  // Multi-unit price scaling preview: POS charges a multi-unit product's
  // sale-unit row price, so a price import rescales those rows. Fetch the
  // unit rows of affected products so the review shows each old → new price.
  const [unitPricePreview, setUnitPricePreview] = useState<Record<string, { unit_name: string; is_base_unit: boolean; oldPrice: number | null; newPrice: number | null; oldCost: number | null; newCost: number | null }[]>>({});
  useEffect(() => {
    setUnitPricePreview({});
    if (!plan) return;
    const ids = plan.products.filter(p => p.priceScale && p.productId).map(p => p.productId!);
    if (ids.length === 0) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('product_units')
        .select('product_id, unit_name, is_base_unit, price, cost_price')
        .in('product_id', ids)
        .eq('is_active', true)
        .order('sort_order');
      if (cancelled || !data) return;
      const round2 = (n: number) => Math.round(n * 100) / 100;
      const info: typeof unitPricePreview = {};
      for (const item of plan.products) {
        if (!item.priceScale || !item.productId) continue;
        const rows = (data as any[]).filter(r => r.product_id === item.productId);
        if (rows.length === 0) continue;
        info[item.productId] = rows.map(r => {
          const oldPrice = r.price ?? null;
          const oldCost = r.cost_price ?? null;
          let newPrice = oldPrice;
          let newCost = oldCost;
          if (r.is_base_unit) {
            if (item.priceScale!.saleNew !== undefined) newPrice = item.priceScale!.saleNew!;
            if (item.priceScale!.costNew !== undefined) newCost = item.priceScale!.costNew!;
          } else {
            if (item.priceScale!.sale !== undefined && oldPrice != null) newPrice = round2(oldPrice * item.priceScale!.sale!);
            if (item.priceScale!.cost !== undefined && oldCost != null) newCost = round2(oldCost * item.priceScale!.cost!);
          }
          return { unit_name: r.unit_name, is_base_unit: !!r.is_base_unit, oldPrice, newPrice, oldCost, newCost };
        });
      }
      if (!cancelled) setUnitPricePreview(info);
    })();
    return () => { cancelled = true; };
  }, [plan]);

  function planFor(table: RawTable, mode: ImportMode) {
    return buildImportPlan({ table, mode, categories, brands, unitTypes, existing: existingProducts });
  }

  function review(table: RawTable, label: string) {
    setParseError(null);
    setResult(null);
    setSource({ table, label });
    setPlan(planFor(table, importMode));
  }

  function changeMode(next: ImportMode) {
    setImportMode(next);
    if (source) setPlan(planFor(source.table, next));
  }

  function reset() {
    setSource(null);
    setPlan(null);
    setResult(null);
    setParseError(null);
    setProgress({ current: 0, total: 0, stage: '' });
  }

  async function handleFileUpload(file: File) {
    setParseError(null);
    try {
      const data = await file.arrayBuffer();
      review(parseWorkbook(data), file.name);
    } catch (err: any) {
      setSource(null);
      setPlan(null);
      setParseError(err?.message || 'Could not read that file.');
    }
  }

  function handlePasteReview() {
    if (!pasteText.trim()) return;
    review(parseDelimitedText(pasteText), 'pasted data');
  }

  async function addVariants(table: 'product_colors' | 'product_sizes', productId: string, names: string[]) {
    const { data: existing } = await supabase.from(table).select('name').eq('product_id', productId);
    const have = new Set((existing || []).map((row: any) => String(row.name).toLowerCase()));
    const missing = names.filter(name => !have.has(name.toLowerCase()));
    if (missing.length === 0) return;
    let sort = (existing || []).length;
    const rows = missing.map(name => {
      const base: Record<string, any> = { product_id: productId, name, is_default: sort === 0, sort_order: sort };
      sort += 1;
      return table === 'product_colors' ? { ...base, hex_code: colorNameToHex(name) } : base;
    });
    const { error } = await supabase.from(table).insert(rows);
    if (error) throw new Error(`${table === 'product_colors' ? 'colours' : 'sizes'} — ${error.message}`);
  }

  async function applyStock(productId: string, warehouseId: string, target: number, item: PlannedProduct) {
    const { data: current } = await supabase
      .from('inventory_items')
      .select('id, quantity_on_hand')
      .eq('product_id', productId)
      .eq('warehouse_id', warehouseId)
      .maybeSingle();

    const onHand = Number(current?.quantity_on_hand || 0);
    if (target === onHand) return;

    // Never post a zero-cost movement: if the sheet did not carry a cost, read
    // the product's own cost instead of defaulting to 0.
    let unitCost = Number(item.fields.cost_price);
    if (!Number.isFinite(unitCost)) {
      const { data: row } = await supabase.from('products').select('cost_price').eq('id', productId).maybeSingle();
      unitCost = Number(row?.cost_price || 0);
    }

    if (target > onHand) {
      const delta = target - onHand;
      if (!current) {
        const { error } = await supabase.from('inventory_items').insert({
          tenant_id: TENANT, product_id: productId, warehouse_id: warehouseId, quantity_on_hand: target,
        });
        if (error) throw new Error(error.message);
      }
      const reference = item.action === 'create' ? 'import' : 'import_update';
      const note = item.action === 'create' ? 'Initial stock from import' : 'Stock increased from import';
      await supabase.from('stock_movements').insert({
        tenant_id: TENANT, product_id: productId, warehouse_id: warehouseId,
        movement_type: item.action === 'create' ? 'opening' : 'adjustment',
        quantity: delta, unit_cost: unitCost, reference_type: reference, notes: note,
      });
      const { error } = await supabase.rpc('create_opening_batch', {
        p_product_id: productId, p_warehouse_id: warehouseId, p_quantity: delta, p_unit_cost: unitCost,
        p_batch_type: item.action === 'create' ? 'opening' : 'adjustment',
        p_reference_type: reference, p_notes: note,
      });
      if (error) throw new Error(error.message);
      return;
    }

    const reduce = onHand - target;
    // Post the ledger and GL first. create_stock_reduction consumes FIFO layers
    // and never touches inventory_items, so writing the counter first used to
    // leave stock and the ledger disagreeing whenever the RPC failed.
    const { error } = await supabase.rpc('create_stock_reduction', {
      p_product_id: productId, p_warehouse_id: warehouseId, p_quantity: reduce, p_unit_cost: unitCost,
      p_reference_type: 'import_update', p_reference_id: productId, p_notes: 'Stock decreased from import',
    });
    if (error) throw new Error(error.message);

    await supabase.from('stock_movements').insert({
      tenant_id: TENANT, product_id: productId, warehouse_id: warehouseId,
      movement_type: 'adjustment', quantity: -reduce, unit_cost: unitCost,
      reference_type: 'import_update', notes: 'Stock decreased from import',
    });

    await supabase.from('inventory_items')
      .update({ quantity_on_hand: target })
      .eq('product_id', productId)
      .eq('warehouse_id', warehouseId);
  }

  /**
   * POS charges a multi-unit product's sale-unit row price (product_units),
   * so a price import that only updated products.sale_price would never reach
   * the counter. The base unit row is set to the imported prices exactly;
   * every larger unit scales by the same ratio so it derives from the new
   * base price.
   */
  async function scaleUnitPrices(productId: string, scale: PriceScale) {
    const { data: rows, error } = await supabase
      .from('product_units')
      .select('id, is_base_unit, price, cost_price')
      .eq('product_id', productId);
    if (error) throw new Error(`units — ${error.message}`);
    for (const row of rows || []) {
      const patch: Record<string, unknown> = {};
      if (row.is_base_unit) {
        if (scale.saleNew !== undefined) patch.price = scale.saleNew;
        if (scale.costNew !== undefined) patch.cost_price = scale.costNew;
      } else {
        if (scale.sale !== undefined && row.price != null) patch.price = Math.round(row.price * scale.sale * 100) / 100;
        if (scale.cost !== undefined && row.cost_price != null) patch.cost_price = Math.round(row.cost_price * scale.cost * 100) / 100;
      }
      if (Object.keys(patch).length === 0) continue;
      const { error: updateError } = await supabase.from('product_units').update(patch).eq('id', row.id);
      if (updateError) throw new Error(`units — ${updateError.message}`);
    }
  }

  async function importOne(item: PlannedProduct) {
    let productId = item.productId || '';

    if (item.action === 'create') {
      const { data, error } = await supabase
        .from('products')
        .insert({ tenant_id: TENANT, ...item.fields })
        .select('id')
        .single();
      if (error) throw new Error(error.message);
      productId = data.id;
    } else {
      const { error } = await supabase
        .from('products')
        .update({ ...item.fields, updated_at: new Date().toISOString() })
        .eq('id', productId);
      if (error) throw new Error(error.message);
    }

    if (item.priceScale) await scaleUnitPrices(productId, item.priceScale);

    if (item.units.length > 0) {
      const { error } = await supabase.from('product_units').insert(item.units.map((unit, index) => ({
        product_id: productId,
        unit_name: unit.unit_name,
        conversion_factor: unit.conversion_factor,
        is_base_unit: unit.is_base_unit,
        is_sale_unit: unit.is_sale_unit,
        price: unit.price,
        cost_price: unit.cost_price,
        sort_order: index,
        is_active: true,
      })));
      if (error) throw new Error(`units — ${error.message}`);
    }

    if (item.colors.length > 0) await addVariants('product_colors', productId, item.colors);
    if (item.sizes.length > 0) await addVariants('product_sizes', productId, item.sizes);

    if (defaultWarehouse && item.stockTarget !== undefined) {
      await applyStock(productId, defaultWarehouse, item.stockTarget, item);
    }
  }

  async function runImport() {
    if (!plan) return;
    setImporting(true);
    setResult(null);
    setProgress({ current: 0, total: plan.products.length, stage: 'Importing…' });

    let created = 0;
    let updated = 0;
    const errors: string[] = [];

    for (let i = 0; i < plan.products.length; i++) {
      const item = plan.products[i];
      setProgress({
        current: i,
        total: plan.products.length,
        stage: `${item.action === 'create' ? 'Creating' : 'Updating'} ${item.sku}…`,
      });
      try {
        await importOne(item);
        if (item.action === 'create') created += 1;
        else updated += 1;
      } catch (err: any) {
        errors.push(`Row ${item.rowNumbers.join(', ')} (${item.sku}) — ${err?.message || 'failed'}`);
      }
    }

    setProgress({ current: plan.products.length, total: plan.products.length, stage: 'Done' });
    setImporting(false);
    setResult({ created, updated, skipped: plan.skipped.length, errors });
    if (created + updated > 0) onImported();
  }

  function colorNameToHex(name: string): string {
    const colors: Record<string, string> = {
      red: '#ef4444', green: '#22c55e', blue: '#3b82f6', yellow: '#eab308',
      black: '#000000', white: '#ffffff', orange: '#f97316', purple: '#a855f7',
      pink: '#ec4899', brown: '#a16207', gray: '#6b7280', grey: '#6b7280',
      silver: '#9ca3af', gold: '#d97706', navy: '#1e3a8a', teal: '#14b8a6',
    };
    return colors[name.toLowerCase()] || '#6b7280';
  }

  const detectedColumns = plan
    ? Array.from(plan.mapping.present).map(key => COLUMN_BY_KEY[key]?.label || key)
    : [];

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-4xl shadow-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <div>
            <h2 className="text-lg font-bold text-foreground">Bulk Import Products</h2>
            <p className="text-xs text-muted-foreground">Nothing is written until you review the preview</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>

        <div className="flex border-b border-border shrink-0">
          {[
            { key: 'upload', label: 'Upload File', icon: Upload },
            { key: 'paste', label: 'Bulk Paste', icon: Plus },
            { key: 'guide', label: 'Import Guide', icon: Info },
          ].map(t => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key as any)}
              className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition ${activeTab === t.key ? 'border-blue-600 text-blue-600' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            >
              <t.icon className="w-4 h-4" /> {t.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {result && (
            <div className={`mb-4 p-4 rounded-lg border ${result.created + result.updated > 0 ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
              <div className="flex items-center gap-2 mb-2">
                {result.created + result.updated > 0 ? (
                  <><CheckCircle2 className="w-5 h-5 text-green-600" /><span className="font-semibold text-green-800">Import complete</span></>
                ) : (
                  <><AlertTriangle className="w-5 h-5 text-red-600" /><span className="font-semibold text-red-800">Nothing was imported</span></>
                )}
              </div>
              <p className="text-sm text-gray-700">
                <strong>{result.created}</strong> created, <strong>{result.updated}</strong> updated, <strong>{result.skipped}</strong> skipped
              </p>
              {result.errors.length > 0 && (
                <div className="mt-2 text-xs text-red-600 space-y-1">
                  {result.errors.slice(0, 20).map((message, i) => <p key={i}>{message}</p>)}
                  {result.errors.length > 20 && <p>…and {result.errors.length - 20} more</p>}
                </div>
              )}
            </div>
          )}

          {importing && (
            <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <div className="flex items-center gap-3">
                <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                <div>
                  <p className="text-sm font-medium text-blue-800">{progress.stage}</p>
                  <p className="text-xs text-blue-600">{progress.current} of {progress.total}</p>
                </div>
              </div>
              <div className="mt-2 h-2 bg-blue-200 rounded-full overflow-hidden">
                <div className="h-full bg-blue-600 transition-all" style={{ width: `${(progress.current / Math.max(progress.total, 1)) * 100}%` }} />
              </div>
            </div>
          )}

          {parseError && (
            <div className="mb-4 p-4 rounded-lg bg-red-50 border border-red-200">
              <div className="flex items-center gap-2 mb-1">
                <AlertTriangle className="w-5 h-5 text-red-600" />
                <span className="font-semibold text-red-800">Could not read the file</span>
              </div>
              <p className="text-xs text-red-700">{parseError}</p>
            </div>
          )}

          {/* ------------------------------------------------ preview step */}
          {plan && !importing && !result && activeTab !== 'guide' && (
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-foreground">Review before importing</p>
                  <p className="text-xs text-muted-foreground">
                    {source?.label} · {plan.totalRows} data row{plan.totalRows === 1 ? '' : 's'}
                  </p>
                </div>
                <button onClick={reset} className="text-xs font-medium text-blue-600 hover:text-blue-700 shrink-0">
                  Choose another file
                </button>
              </div>

              <div className="grid grid-cols-4 gap-2">
                <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2">
                  <p className="text-lg font-bold text-green-700">{counts?.creates ?? 0}</p>
                  <p className="text-[11px] font-medium text-green-700">New products</p>
                </div>
                <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2">
                  <p className="text-lg font-bold text-blue-700">{counts?.updates ?? 0}</p>
                  <p className="text-[11px] font-medium text-blue-700">Updates</p>
                </div>
                <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                  <p className="text-lg font-bold text-gray-700">{counts?.skips ?? 0}</p>
                  <p className="text-[11px] font-medium text-gray-600">Skipped</p>
                </div>
                <div className={`rounded-lg border px-3 py-2 ${(counts?.warnings ?? 0) > 0 ? 'border-amber-200 bg-amber-50' : 'border-gray-200 bg-gray-50'}`}>
                  <p className={`text-lg font-bold ${(counts?.warnings ?? 0) > 0 ? 'text-amber-700' : 'text-gray-700'}`}>{counts?.warnings ?? 0}</p>
                  <p className={`text-[11px] font-medium ${(counts?.warnings ?? 0) > 0 ? 'text-amber-700' : 'text-gray-600'}`}>Warnings</p>
                </div>
              </div>

              {plan.errors.length > 0 && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200 space-y-1">
                  {plan.errors.map((message, i) => (
                    <p key={i} className="text-xs text-red-700 flex items-start gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {message}
                    </p>
                  ))}
                </div>
              )}

              {needsWarehouse && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 flex items-start gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>
                    No warehouse is available, so the Current Stock column cannot be applied.
                    Create a warehouse first, or clear that column and import the products on their own.
                  </span>
                </div>
              )}

              <div className="text-xs text-muted-foreground bg-muted/50 rounded-lg px-3 py-2">
                <span className="font-medium text-foreground">Columns read:</span> {detectedColumns.join(', ') || 'none'}
                {plan.mapping.unmapped.length > 0 && (
                  <span className="block mt-1 text-amber-700">
                    Ignored unknown column{plan.mapping.unmapped.length === 1 ? '' : 's'}: {plan.mapping.unmapped.join(', ')}
                  </span>
                )}
              </div>

              {plan.products.length > 0 && (
                <div className="border border-border rounded-lg overflow-hidden">
                  <div className="max-h-72 overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-muted sticky top-0">
                        <tr className="text-left text-muted-foreground">
                          <th className="px-2 py-1.5 font-medium">Action</th>
                          <th className="px-2 py-1.5 font-medium">SKU</th>
                          <th className="px-2 py-1.5 font-medium">Name</th>
                          <th className="px-2 py-1.5 font-medium">Will write</th>
                          <th className="px-2 py-1.5 font-medium text-right">Stock</th>
                        </tr>
                      </thead>
                      <tbody>
                        {plan.products.slice(0, 60).map(item => {
                          const written = Array.from(new Set(
                            Object.keys(item.fields)
                              .filter(key => key !== 'name' && key !== 'sku')
                              .map(fieldLabel)
                          ));
                          return (
                            <tr key={`${item.sku}-${item.rowNumbers[0]}`} className="border-t border-border align-top">
                              <td className="px-2 py-1.5">
                                <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${item.action === 'create' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>
                                  {item.action === 'create' ? 'New' : 'Update'}
                                </span>
                              </td>
                              <td className="px-2 py-1.5 font-mono">{item.sku}</td>
                              <td className="px-2 py-1.5">
                                {item.name || <span className="text-muted-foreground">unchanged</span>}
                                {item.warnings.length > 0 && (
                                  <span className="block text-[10px] text-amber-700 mt-0.5">{item.warnings[0]}{item.warnings.length > 1 ? ` (+${item.warnings.length - 1})` : ''}</span>
                                )}
                              </td>
                              <td className="px-2 py-1.5 text-muted-foreground">
                                {written.join(', ') || '—'}
                                {item.priceScale && unitPricePreview[item.productId!]?.map(u => (
                                  <span key={u.unit_name} className="block text-[10px] text-blue-700 tabular-nums">
                                    {u.unit_name}{u.is_base_unit ? ' (base)' : ''}: {money(u.oldPrice)} → {money(u.newPrice)}
                                    {(u.oldCost ?? 0) !== (u.newCost ?? 0) && <> · cost {money(u.oldCost)} → {money(u.newCost)}</>}
                                  </span>
                                ))}
                              </td>
                              <td className="px-2 py-1.5 text-right tabular-nums">
                                {item.stockTarget === undefined ? <span className="text-muted-foreground">—</span> : item.stockTarget}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {plan.products.length > 60 && (
                    <p className="px-2 py-1.5 text-[11px] text-muted-foreground border-t border-border">
                      …and {plan.products.length - 60} more
                    </p>
                  )}
                </div>
              )}

              {plan.skipped.length > 0 && (
                <div className="border border-amber-200 bg-amber-50 rounded-lg p-3">
                  <p className="text-xs font-semibold text-amber-800 mb-1">
                    {plan.skipped.length} row{plan.skipped.length === 1 ? '' : 's'} will be skipped
                  </p>
                  <div className="space-y-1 max-h-32 overflow-y-auto">
                    {plan.skipped.slice(0, 20).map((row, i) => (
                      <p key={i} className="text-[11px] text-amber-800">
                        <span className="font-medium">Row {row.rowNumber}{row.sku ? ` · ${row.sku}` : ''}:</span> {row.reason}
                      </p>
                    ))}
                    {plan.skipped.length > 20 && <p className="text-[11px] text-amber-700">…and {plan.skipped.length - 20} more</p>}
                  </div>
                </div>
              )}

              {plan.errors.length === 0 && plan.products.length === 0 && (
                <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
                  There is nothing to import from this file.
                </div>
              )}
            </div>
          )}

          {/* ------------------------------------------------ input step */}
          {!plan && !importing && activeTab === 'upload' && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2">Import Mode</label>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { key: 'simple', label: 'Simple Products', desc: 'Each row is its own product' },
                    { key: 'variants', label: 'Product Variants', desc: 'Rows sharing a Name and SKU become one product with colours/sizes' },
                  ].map(m => (
                    <button
                      key={m.key}
                      onClick={() => changeMode(m.key as ImportMode)}
                      className={`p-3 rounded-lg border text-left transition ${importMode === m.key ? 'border-blue-600 bg-blue-50' : 'border-border hover:border-gray-400'}`}
                    >
                      <p className="text-sm font-medium">{m.label}</p>
                      <p className="text-xs text-muted-foreground">{m.desc}</p>
                    </button>
                  ))}
                </div>
              </div>

              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  const file = e.dataTransfer.files[0];
                  if (file && (file.name.endsWith('.csv') || file.name.endsWith('.xlsx') || file.name.endsWith('.xls'))) {
                    handleFileUpload(file);
                  }
                }}
                className={`border-2 border-dashed rounded-xl p-8 text-center transition ${dragOver ? 'border-blue-500 bg-blue-50' : 'border-gray-300 bg-gray-50'}`}
              >
                <Upload className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
                <p className="text-sm text-foreground font-medium">Drag &amp; drop CSV or Excel file here</p>
                <p className="text-xs text-muted-foreground mt-1">or click to browse</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.xlsx,.xls"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleFileUpload(file);
                    e.target.value = '';
                  }}
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="mt-3 px-4 py-2 bg-white border border-border rounded-lg text-sm font-medium hover:bg-gray-100 transition"
                >
                  Choose File
                </button>
              </div>

              <div className="flex items-center justify-between">
                <button
                  onClick={() => downloadTemplateWorkbook()}
                  className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700 font-medium"
                >
                  <Download className="w-4 h-4" /> Download template (XLSX)
                </button>
                <span className="text-xs text-muted-foreground">Supported: CSV, XLSX, XLS</span>
              </div>
            </div>
          )}

          {!plan && !importing && activeTab === 'paste' && (
            <div className="space-y-4">
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                <p className="text-xs text-blue-800">
                  <strong>Bulk Paste:</strong> copy the cells from Excel or Google Sheets — tabs and commas both work.
                  The first row must be the header row (Name, SKU, Cost Price, …). You will see a preview before anything is saved.
                </p>
              </div>
              <textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder={'Name\tSKU\tCost Price\tSale Price\tCurrent Stock\nProduct A\tSKU-001\t100\t150\t50\nProduct B\tSKU-002\t200\t300\t25'}
                className="w-full h-64 border border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500/20 resize-none"
              />
              <div className="flex items-center justify-between">
                <button
                  onClick={() => downloadTemplateWorkbook()}
                  className="flex items-center gap-2 text-xs text-blue-600 hover:text-blue-700 font-medium"
                >
                  <Download className="w-3.5 h-3.5" /> Download template
                </button>
                <button
                  onClick={handlePasteReview}
                  disabled={!pasteText.trim()}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition disabled:opacity-60"
                >
                  Preview
                </button>
              </div>
            </div>
          )}

          {!importing && activeTab === 'guide' && (
            <div className="space-y-5">
              <div className="grid grid-cols-3 gap-3">
                <div className="p-3 rounded-lg border border-green-200 bg-green-50">
                  <p className="text-xs font-semibold text-green-800 mb-1">Matched by SKU</p>
                  <p className="text-[11px] text-green-700">A SKU that already exists updates that product. A new SKU creates one. Case and stray spaces are ignored.</p>
                </div>
                <div className="p-3 rounded-lg border border-blue-200 bg-blue-50">
                  <p className="text-xs font-semibold text-blue-800 mb-1">Blank means “leave it”</p>
                  <p className="text-[11px] text-blue-700">Only columns you include and fill are written. An empty cell never resets a price, unit or category to zero.</p>
                </div>
                <div className="p-3 rounded-lg border border-amber-200 bg-amber-50">
                  <p className="text-xs font-semibold text-amber-800 mb-1">Preview first</p>
                  <p className="text-[11px] text-amber-700">Every import is planned before it runs. You see what will be created, updated and skipped, and why.</p>
                </div>
              </div>

              <div>
                <h4 className="text-sm font-semibold mb-2">Columns</h4>
                <div className="border border-border rounded-lg overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-muted">
                      <tr className="text-left text-muted-foreground">
                        <th className="px-2 py-1.5 font-medium">Column</th>
                        <th className="px-2 py-1.5 font-medium">Required</th>
                        <th className="px-2 py-1.5 font-medium">What it does</th>
                      </tr>
                    </thead>
                    <tbody>
                      {COLUMNS.map(column => (
                        <tr key={column.key} className="border-t border-border align-top">
                          <td className="px-2 py-1.5 font-medium whitespace-nowrap">{column.label}</td>
                          <td className="px-2 py-1.5 text-muted-foreground">{column.key === 'name' || column.key === 'sku' ? 'Yes' : '—'}</td>
                          <td className="px-2 py-1.5 text-muted-foreground">{column.help}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div>
                <h4 className="text-sm font-semibold mb-2">Examples</h4>
                <div className="space-y-3">
                  <div className="p-3 bg-gray-50 rounded-lg border">
                    <p className="text-xs font-semibold text-gray-800 mb-1">Simple product</p>
                    <p className="text-[11px] text-gray-600">One row, one product.</p>
                    <pre className="mt-2 text-[11px] bg-white p-2 rounded border overflow-x-auto">{'Name,SKU,Unit,Cost Price,Sale Price,Current Stock\nHammer,HAM-001,pcs,50,80,100'}</pre>
                  </div>
                  <div className="p-3 bg-green-50 rounded-lg border border-green-200">
                    <p className="text-xs font-semibold text-green-800 mb-1">Variants — one product, several colours and sizes</p>
                    <p className="text-[11px] text-green-700">
                      Keep the same Name <em>and</em> the same SKU, and list the colours/sizes in their own columns.
                      A product has one SKU, so different SKUs on the same name are rejected rather than silently dropped.
                    </p>
                    <pre className="mt-2 text-[11px] bg-white p-2 rounded border overflow-x-auto">{'Name,SKU,Color,Size,Current Stock\nT-Shirt,TS-001,Red | Blue | Green,S | M | L,15'}</pre>
                  </div>
                  <div className="p-3 bg-blue-50 rounded-lg border border-blue-200">
                    <p className="text-xs font-semibold text-blue-800 mb-1">Multi-unit product</p>
                    <p className="text-[11px] text-blue-700">
                      Set the base unit in <strong>Unit</strong> and the larger selling unit in the Multi-Unit columns.
                      These only apply when the product is created — changing a conversion factor later would
                      re-value every past FIFO layer, so edit it on the product instead.
                    </p>
                    <pre className="mt-2 text-[11px] bg-white p-2 rounded border overflow-x-auto">{'Name,SKU,Unit,Cost Price,Sale Price,Multi-Unit Name,Multi-Unit Conversion,Multi-Unit Sale Price\nCable,CAB-010,coil,500,750,box,12,8000'}</pre>
                  </div>
                  <div className="p-3 bg-gray-50 rounded-lg border">
                    <p className="text-xs font-semibold text-gray-800 mb-1">Update only a price</p>
                    <p className="text-[11px] text-gray-600">Two columns are enough — everything else stays as it is.</p>
                    <pre className="mt-2 text-[11px] bg-white p-2 rounded border overflow-x-auto">{'SKU,Sale Price\nHAM-001,95'}</pre>
                    <p className="text-[11px] text-blue-700 mt-2">
                      For a <strong>multi-unit</strong> product, a price change also moves the larger-unit price:
                      the base unit gets the imported price and box/carton prices scale by the same ratio
                      (sale ৳150 → ৳180 is ×1.2, so a ৳1,700 box becomes ৳2,040).                       The preview shows each old → new unit price before anything is written.
                    </p>
                  </div>
                </div>
              </div>

              <div className="text-[11px] text-muted-foreground border-t border-border pt-3 space-y-1">
                <p><strong className="text-foreground">Current Stock</strong> is an absolute quantity in the default warehouse, not a delta. Leave it blank to keep stock untouched.</p>
                <p><strong className="text-foreground">Export</strong> writes this same column set, so you can export, edit in Excel and import the file back.</p>
                <p><strong className="text-foreground">Category</strong> and <strong className="text-foreground">Brand</strong> must already exist — unknown names are reported and left unchanged.</p>
              </div>

              <button
                onClick={() => downloadTemplateWorkbook()}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition"
              >
                <Download className="w-4 h-4" /> Download template with examples
              </button>
            </div>
          )}
        </div>

        <div className="border-t border-border px-6 py-4 flex items-center justify-between gap-3 shrink-0">
          <div className="text-xs text-muted-foreground">
            {plan && !result && plan.errors.length === 0 && (
              <span>
                {counts?.creates ?? 0} new · {counts?.updates ?? 0} updates · {counts?.skips ?? 0} skipped
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {plan && !result && (
              <button
                onClick={reset}
                className="px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition"
              >
                Back
              </button>
            )}
            {plan && !result && (
              <button
                onClick={runImport}
                disabled={!canImport}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-60"
              >
                {importing
                  ? 'Importing…'
                  : `Import ${plan.products.length} product${plan.products.length === 1 ? '' : 's'}`}
              </button>
            )}
            {(!plan || result) && (
              <button
                onClick={onClose}
                className="px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition"
              >
                {result ? 'Close' : 'Cancel'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function BarcodeModal({ product, onClose }: { product: ProductWithStock; onClose: () => void }) {
  const svgRef = useRef<SVGSVGElement>(null);

  // This modal has no page-level settings, so the product's saved size (if
  // any) resolves against the medium default.
  const cfg = resolveLabelConfig({ size: 'medium', customWidth: 2, customHeight: 1 }, product);

  useEffect(() => {
    if (svgRef.current) {
      try {
        JsBarcode(svgRef.current, product.sku, {
          format: 'CODE128',
          width: cfg.barcodeWidth,
          height: cfg.barcodeHeight,
          displayValue: false,
          margin: 0,
          background: '#ffffff',
          lineColor: '#000000',
        });
      } catch (e) {
        console.error('Barcode generation error:', e);
      }
    }
  }, [product.sku, cfg.barcodeWidth, cfg.barcodeHeight]);

  function handlePrint() {
    const svgEl = svgRef.current;
    if (!svgEl) return;
    const svgHTML = new XMLSerializer().serializeToString(svgEl);
    const w = window.open('', '_blank', 'width=400,height=300');
    if (!w) return;
    const salePrice = formatCurrency(product.sale_price);
    w.document.write(`<!DOCTYPE html><html><head><title>Barcode - ${product.sku}</title><style>
      @page { margin: 0; }
      body { margin: 0; padding: 0; font-family: 'Helvetica Neue', Arial, sans-serif; }
      .label { width: ${cfg.width}; height: ${cfg.height}; display: flex; flex-direction: column; align-items: center; justify-content: space-between; padding: 6px 8px; box-sizing: border-box; border: 1px solid #e0e0e0; border-radius: 4px; }
      .name { font-size: ${fitNameFontSize(cfg.nameFontSize, product.name, cfg.width)}; font-weight: 600; text-align: center; line-height: 1.15; color: #1a1a1a; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; word-break: break-word; max-width: 100%; }
      .barcode-wrap { display: flex; justify-content: center; max-width: 100%; overflow: hidden; }
      .barcode-wrap svg { display: block; max-width: 100%; height: auto; }
      .code { font-size: ${cfg.skuFontSize}; font-family: 'Courier New', monospace; color: #1a1a1a; letter-spacing: 0.5px; }
      .mrp { font-size: ${cfg.priceFontSize}; font-weight: 700; color: #1a1a1a; }
      .mrp-label { font-size: ${cfg.mrpLabelFontSize}; font-weight: 600; color: #1a1a1a; text-transform: uppercase; letter-spacing: 1px; }
      .price-row { display: flex; align-items: baseline; gap: 4px; }
    </style></head><body>
      <div class="label">
        <div class="name">${product.name}</div>
        <div class="barcode-wrap">${svgHTML}</div>
        <div class="code">${product.sku}</div>
        <div class="price-row">
          <span class="mrp-label">MRP</span>
          <span class="mrp">${salePrice}</span>
        </div>
      </div>
      <script>window.onload=function(){window.print();setTimeout(function(){window.close();},500);}<\/script>
    </body></html>`);
    w.document.close();
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-sm shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-base font-bold">Product Barcode</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-6 flex flex-col items-center">
          {/* Professional label preview */}
          <div className="border border-gray-200 rounded-lg p-4 bg-white flex flex-col items-center gap-1.5 shadow-sm" style={{ width: cfg.width, minHeight: cfg.height, maxWidth: '100%' }}>
            <p className="font-semibold text-foreground text-center leading-tight line-clamp-2" style={{ fontSize: fitNameFontSize(cfg.nameFontSize, product.name, cfg.width) }}>{product.name}</p>
            <div className="flex justify-center w-full overflow-hidden">
              <svg ref={svgRef} className="max-w-full h-auto" />
            </div>
            <p className="font-mono text-foreground tracking-wide" style={{ fontSize: cfg.skuFontSize }}>{product.sku}</p>
            <div className="flex items-baseline gap-1.5 pt-0.5 border-t border-gray-100 w-full justify-center">
              <span className="font-semibold text-foreground uppercase tracking-wider" style={{ fontSize: cfg.mrpLabelFontSize }}>MRP</span>
              <span className="font-bold text-foreground" style={{ fontSize: cfg.priceFontSize }}>{formatCurrency(product.sale_price)}</span>
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            Label size: {cfg.sizeKey === 'custom' ? `${parseFloat(cfg.width)}" × ${parseFloat(cfg.height)}"` : LABEL_SIZES[cfg.sizeKey].label}
            {cfg.fromProductOverride ? ' (saved for this product)' : ' (default)'}
          </p>
          <button
            onClick={handlePrint}
            className="mt-3 flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition"
          >
            <Printer className="w-4 h-4" />Print Barcode
          </button>
        </div>
      </div>
    </div>
  );
}

function ManageCatalogModal({ categories, brands, unitTypes, onClose, onSaved }: {
  categories: Category[];
  brands: Brand[];
  unitTypes: { id: string; unit_name: string; unit_short: string; allow_decimal?: boolean }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [tab, setTab] = useState<'categories' | 'brands' | 'units'>('categories');
  const [newName, setNewName] = useState('');
  const [newShort, setNewShort] = useState('');
  const [newAllowDecimal, setNewAllowDecimal] = useState(false);
  const [parentCategory, setParentCategory] = useState('');
  const [saving, setSaving] = useState(false);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [editingShort, setEditingShort] = useState('');
  const [editingAllowDecimal, setEditingAllowDecimal] = useState(false);

  const parentCategories = categories.filter(c => !c.parent_id);
  const subCategories = categories.filter(c => c.parent_id);

  function getSubCategories(parentId: string) {
    return subCategories.filter(sc => sc.parent_id === parentId);
  }

  function toggleCategory(id: string) {
    const newExpanded = new Set(expandedCategories);
    if (newExpanded.has(id)) newExpanded.delete(id);
    else newExpanded.add(id);
    setExpandedCategories(newExpanded);
  }

  function startEdit(id: string, name: string, short?: string, allowDecimal?: boolean) {
    setEditingId(id);
    setEditingName(name);
    setEditingShort(short || '');
    setEditingAllowDecimal(!!allowDecimal);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditingName('');
    setEditingShort('');
  }

  async function handleAdd() {
    if (!newName.trim()) return;
    if (tab === 'units' && !newShort.trim()) {
      toast({ title: 'Short code required', description: 'Give the unit a short code, e.g. box or ctn.', variant: 'destructive' });
      return;
    }
    setSaving(true);

    if (tab === 'units') {
      // Case-insensitive match: the catalog must never grow a second row that
      // differs only by capitalisation ('Meter' next to 'meter'). The DB has a
      // unique index on lower(unit_name) as the backstop.
      const name = newName.trim();
      const short = newShort.trim();
      const { data: dup } = await supabase
        .from('unit_types')
        .select('id, is_active')
        .ilike('unit_name', name)
        .limit(1);
      const existing = dup?.[0];

      if (existing?.is_active) {
        toast({ title: 'Unit already exists', description: `“${name}” is already in the list.`, variant: 'destructive' });
        setSaving(false);
        return;
      }

      if (existing) {
        // A removed unit keeps its row — restore it instead of colliding.
        const { error } = await supabase.from('unit_types')
          .update({ unit_name: name, unit_short: short, allow_decimal: newAllowDecimal, is_active: true })
          .eq('id', existing.id);
        if (error) toast({ title: 'Error', description: error.message, variant: 'destructive' });
        else { toast({ title: 'Unit restored', description: `“${name}” is active again.` }); setNewName(''); setNewShort(''); setNewAllowDecimal(false); onSaved(); }
      } else {
        const { error } = await supabase.from('unit_types').insert({ unit_name: name, unit_short: short, is_active: true, allow_decimal: newAllowDecimal });
        if (error) toast({ title: 'Error', description: error.message, variant: 'destructive' });
        else { toast({ title: 'Unit added' }); setNewName(''); setNewShort(''); setNewAllowDecimal(false); onSaved(); }
      }
    } else {
      const table = tab === 'categories' ? 'categories' : 'brands';
      const insertData: any = { name: newName.trim(), is_active: true, slug: newName.trim().toLowerCase().replace(/\s+/g, '-') };
      if (tab === 'categories' && parentCategory) insertData.parent_id = parentCategory;
      const { error } = await supabase.from(table).insert(insertData);
      if (error) toast({ title: 'Error', description: error.message, variant: 'destructive' });
      else { toast({ title: 'Success', description: `${tab === 'categories' ? 'Category' : 'Brand'} added` }); setNewName(''); setParentCategory(''); onSaved(); }
    }
    setSaving(false);
  }

  async function handleSaveEdit(id: string, isUnit = false) {
    setSaving(true);
    if (isUnit) {
      const current = unitTypes.find(u => u.id === id);
      const oldName = current?.unit_name || '';
      const name = editingName.trim();
      const short = editingShort.trim();

      if (!name || !short) {
        toast({ title: 'Name and short code required', variant: 'destructive' });
        setSaving(false);
        return;
      }

      if (name.toLowerCase() !== oldName.toLowerCase()) {
        const { data: dup } = await supabase
          .from('unit_types')
          .select('id')
          .ilike('unit_name', name)
          .neq('id', id)
          .limit(1);
        if (dup && dup.length > 0) {
          toast({ title: 'Unit already exists', description: `“${name}” is already in the list.`, variant: 'destructive' });
          setSaving(false);
          return;
        }
      }

      const { error } = await supabase.from('unit_types')
        .update({ unit_name: name, unit_short: short, allow_decimal: editingAllowDecimal })
        .eq('id', id);
      if (error) { toast({ title: 'Error', description: error.message, variant: 'destructive' }); setSaving(false); return; }

      // Renaming a unit in the catalog renames it on the products that use it.
      // product_units goes first so trg_sync_product_unit carries the new base
      // unit up to products.unit / base_unit for multi-unit products.
      if (oldName && name !== oldName) {
        await supabase.from('product_units').update({ unit_name: name }).eq('unit_name', oldName);
        await supabase.from('products').update({ unit: name }).eq('unit', oldName);
        await supabase.from('products').update({ base_unit: name }).eq('base_unit', oldName);
        toast({ title: 'Unit renamed', description: `Products using “${oldName}” now use “${name}”.` });
      } else {
        toast({ title: 'Unit updated' });
      }
      cancelEdit();
      onSaved();
    } else {
      const table = tab === 'categories' ? 'categories' : 'brands';
      const { error } = await supabase.from(table).update({ name: editingName.trim(), slug: editingName.trim().toLowerCase().replace(/\s+/g, '-') }).eq('id', id);
      if (error) toast({ title: 'Error', description: error.message, variant: 'destructive' });
      else { toast({ title: 'Updated' }); cancelEdit(); onSaved(); }
    }
    setSaving(false);
  }

  async function handleDelete(id: string, isUnit = false) {
    if (isUnit) {
      const { error } = await supabase.from('unit_types').update({ is_active: false }).eq('id', id);
      if (error) toast({ title: 'Error', description: error.message, variant: 'destructive' });
      else { toast({ title: 'Unit removed' }); onSaved(); }
    } else {
      const table = tab === 'categories' ? 'categories' : 'brands';
      const { error } = await supabase.from(table).update({ is_active: false }).eq('id', id);
      if (error) toast({ title: 'Error', description: error.message, variant: 'destructive' });
      else { toast({ title: 'Deleted' }); onSaved(); }
    }
  }

  const items = tab === 'categories' ? parentCategories : brands;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-base font-bold">Manage Catalog</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>
        <div className="flex border-b border-border">
          {([
            { key: 'categories', label: `Categories (${categories.length})` },
            { key: 'brands', label: `Brands (${brands.length})` },
            { key: 'units', label: `Units (${unitTypes.length})` },
          ] as const).map(t => (
            <button
              key={t.key}
              onClick={() => { setTab(t.key); setNewName(''); setNewShort(''); setParentCategory(''); }}
              className={`flex-1 py-3 text-xs font-medium transition ${tab === t.key ? 'text-blue-600 border-b-2 border-blue-600' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="p-4">
          <div className="space-y-2 mb-4">
            {tab === 'units' ? (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <input
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleAdd()}
                    placeholder="Unit name (e.g. Carton)"
                    className="flex-1 border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                  />
                  <input
                    value={newShort}
                    onChange={e => setNewShort(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleAdd()}
                    placeholder="Short (e.g. ctn)"
                    className="w-24 border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                  />
                  <button
                    onClick={handleAdd}
                    disabled={saving || !newName.trim() || !newShort.trim()}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-50"
                  >
                    Add
                  </button>
                </div>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={newAllowDecimal}
                    onChange={e => setNewAllowDecimal(e.target.checked)}
                    className="accent-blue-600"
                  />
                  Allow decimal quantities (for continuous units like meter, kg, liter)
                </label>
                <p className="text-xs text-muted-foreground">Short name is the abbreviation shown on invoices (e.g. &quot;pcs&quot;, &quot;box&quot;, &quot;ctn&quot;).</p>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <input
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleAdd()}
                    placeholder={`New ${tab === 'categories' ? 'category' : 'brand'} name...`}
                    className="flex-1 border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                  />
                  <button
                    onClick={handleAdd}
                    disabled={saving || !newName.trim()}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-50"
                  >
                    Add
                  </button>
                </div>
                {tab === 'categories' && (
                  <select
                    value={parentCategory}
                    onChange={e => setParentCategory(e.target.value)}
                    className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none bg-white"
                  >
                    <option value="">Top-level category</option>
                    {parentCategories.map(c => (
                      <option key={c.id} value={c.id}>Sub-category of: {c.name}</option>
                    ))}
                  </select>
                )}
              </div>
            )}
          </div>

          <div className="space-y-1 max-h-64 overflow-y-auto">
            {tab === 'units' ? (
              unitTypes.length === 0 ? (
                <p className="text-center text-sm text-muted-foreground py-6">No units yet. Add one above.</p>
              ) : (
                <div className="grid grid-cols-5 gap-1 px-2 py-1 text-xs font-semibold text-muted-foreground border-b border-border mb-1">
                  <span className="col-span-1">Name</span><span className="col-span-1">Short</span><span className="col-span-1">Decimal</span><span className="col-span-2"></span>
                </div>
              ) && unitTypes.map(u => (
                <div key={u.id} className="grid grid-cols-5 gap-1 items-center px-2 py-1.5 rounded-lg hover:bg-muted/50 group">
                  {editingId === u.id ? (
                    <>
                      <input value={editingName} onChange={e => setEditingName(e.target.value)} className="col-span-1 border border-blue-300 rounded px-1 py-0.5 text-sm" autoFocus />
                      <input value={editingShort} onChange={e => setEditingShort(e.target.value)} className="col-span-1 border border-blue-300 rounded px-1 py-0.5 text-sm" />
                      <input
                        type="checkbox"
                        checked={editingAllowDecimal}
                        onChange={e => setEditingAllowDecimal(e.target.checked)}
                        title="Allow decimal quantities"
                        className="col-span-1 accent-blue-600 justify-self-center"
                      />
                      <div className="col-span-2 flex justify-end gap-1">
                        <button onClick={() => handleSaveEdit(u.id, true)} disabled={saving} className="px-2 py-0.5 bg-blue-600 text-white rounded text-xs">Save</button>
                        <button onClick={cancelEdit} className="px-2 py-0.5 border border-border rounded text-xs">Cancel</button>
                      </div>
                    </>
                  ) : (
                    <>
                      <span className="text-sm text-foreground font-medium">{u.unit_name}</span>
                      <span className="text-sm text-muted-foreground font-mono">{u.unit_short}</span>
                      <span className={`text-xs justify-self-center px-1.5 py-0.5 rounded-full ${u.allow_decimal ? 'bg-emerald-100 text-emerald-700' : 'bg-muted text-muted-foreground'}`}>
                        {u.allow_decimal ? 'yes' : 'no'}
                      </span>
                      <div className="col-span-2 flex justify-end gap-1">
                        <button
                          onClick={() => startEdit(u.id, u.unit_name, u.unit_short, u.allow_decimal)}
                          className="opacity-0 group-hover:opacity-100 w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:text-blue-600 hover:bg-blue-50 transition"
                          title="Edit unit"
                        >
                          <Edit className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleDelete(u.id, true)}
                          className="opacity-0 group-hover:opacity-100 w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:text-red-600 hover:bg-red-50 transition"
                          title="Remove unit"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))
            ) : items.length === 0 ? (
              <p className="text-center text-sm text-muted-foreground py-6">No {tab} added yet. Add one above.</p>
            ) : tab === 'categories' ? (
              parentCategories.map(cat => {
                const subs = getSubCategories(cat.id);
                const isExpanded = expandedCategories.has(cat.id);
                return (
                  <div key={cat.id}>
                    <div className="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-muted/50 group">
                      <div className="flex items-center gap-2">
                        {subs.length > 0 && (
                          <button onClick={() => toggleCategory(cat.id)} className="text-muted-foreground hover:text-foreground">
                            {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                          </button>
                        )}
                        {editingId === cat.id ? (
                          <div className="flex items-center gap-2 flex-1">
                            <input value={editingName} onChange={e => setEditingName(e.target.value)} className="border border-blue-300 rounded px-2 py-0.5 text-sm flex-1" autoFocus />
                            <button onClick={() => handleSaveEdit(cat.id)} disabled={saving} className="px-2 py-0.5 bg-blue-600 text-white rounded text-xs">Save</button>
                            <button onClick={cancelEdit} className="px-2 py-0.5 border border-border rounded text-xs">Cancel</button>
                          </div>
                        ) : (
                          <>
                            <span className="text-sm text-foreground font-medium">{cat.name}</span>
                            {subs.length > 0 && <span className="text-xs text-muted-foreground">({subs.length})</span>}
                          </>
                        )}
                      </div>
                      {editingId !== cat.id && (
                        <div className="flex items-center gap-1">
                          <button onClick={() => startEdit(cat.id, cat.name)} className="opacity-0 group-hover:opacity-100 w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:text-blue-600 hover:bg-blue-50 transition" title="Edit">
                            <Edit className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => handleDelete(cat.id)} className="opacity-0 group-hover:opacity-100 w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:text-red-600 hover:bg-red-50 transition" title="Delete">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                    {isExpanded && subs.length > 0 && (
                      <div className="ml-6 space-y-1 border-l border-border pl-2">
                        {subs.map(sub => (
                          <div key={sub.id} className="flex items-center justify-between px-3 py-1.5 rounded-lg hover:bg-muted/50 group">
                            {editingId === sub.id ? (
                              <div className="flex items-center gap-2 flex-1">
                                <input value={editingName} onChange={e => setEditingName(e.target.value)} className="border border-blue-300 rounded px-2 py-0.5 text-sm flex-1" autoFocus />
                                <button onClick={() => handleSaveEdit(sub.id)} disabled={saving} className="px-2 py-0.5 bg-blue-600 text-white rounded text-xs">Save</button>
                                <button onClick={cancelEdit} className="px-2 py-0.5 border border-border rounded text-xs">Cancel</button>
                              </div>
                            ) : (
                              <>
                                <span className="text-sm text-muted-foreground">{sub.name}</span>
                                <div className="flex items-center gap-1">
                                  <button onClick={() => startEdit(sub.id, sub.name)} className="opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center rounded text-muted-foreground hover:text-blue-600 hover:bg-blue-50 transition" title="Edit">
                                    <Edit className="w-3 h-3" />
                                  </button>
                                  <button onClick={() => handleDelete(sub.id)} className="opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center rounded text-muted-foreground hover:text-red-600 hover:bg-red-50 transition" title="Delete">
                                    <Trash2 className="w-3 h-3" />
                                  </button>
                                </div>
                              </>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            ) : (
              brands.map(item => (
                <div key={item.id} className="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-muted/50 group">
                  {editingId === item.id ? (
                    <div className="flex items-center gap-2 flex-1">
                      <input value={editingName} onChange={e => setEditingName(e.target.value)} className="border border-blue-300 rounded px-2 py-0.5 text-sm flex-1" autoFocus />
                      <button onClick={() => handleSaveEdit(item.id)} disabled={saving} className="px-2 py-0.5 bg-blue-600 text-white rounded text-xs">Save</button>
                      <button onClick={cancelEdit} className="px-2 py-0.5 border border-border rounded text-xs">Cancel</button>
                    </div>
                  ) : (
                    <>
                      <span className="text-sm text-foreground">{item.name}</span>
                      <div className="flex items-center gap-1">
                        <button onClick={() => startEdit(item.id, item.name)} className="opacity-0 group-hover:opacity-100 w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:text-blue-600 hover:bg-blue-50 transition" title="Edit">
                          <Edit className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => handleDelete(item.id)} className="opacity-0 group-hover:opacity-100 w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:text-red-600 hover:bg-red-50 transition" title="Delete">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
