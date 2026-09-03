'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import JsBarcode from 'jsbarcode';
import QRCode from 'qrcode';
import { supabase } from '@/lib/supabase';
import { fetchAll } from '@/lib/fetch-all';
import { formatCurrency } from '@/lib/format';
import { toast } from '@/hooks/use-toast';
import { Barcode, QrCode, Printer, Search, Package, FileText, X, ChevronDown, CircleCheck as CheckCircle2, Settings, Layers, Boxes, ShoppingCart, Eye, Download } from 'lucide-react';
import type { Product, Category, Brand, Invoice } from '@/lib/types';

type CodeType = 'barcode' | 'qrcode';
type LabelSize = 'xs' | 'small' | 'medium' | 'large' | 'xl' | 'custom';
type Mode = 'products' | 'invoices';

interface LabelSizeConfig {
  label: string;
  width: string;
  height: string;
  fontSize: string;
  barcodeWidth: number;
  barcodeHeight: number;
  qrSize: number;
}

const LABEL_SIZES: Record<LabelSize, LabelSizeConfig> = {
  xs: { label: '1.2" × 0.6"', width: '1.2in', height: '0.6in', fontSize: '7px', barcodeWidth: 1, barcodeHeight: 22, qrSize: 40 },
  small: { label: '1.5" × 0.8"', width: '1.5in', height: '0.8in', fontSize: '8px', barcodeWidth: 1, barcodeHeight: 28, qrSize: 50 },
  medium: { label: '2" × 1.1"', width: '2in', height: '1.1in', fontSize: '9px', barcodeWidth: 1.5, barcodeHeight: 40, qrSize: 65 },
  large: { label: '2.5" × 1.4"', width: '2.5in', height: '1.4in', fontSize: '10px', barcodeWidth: 2, barcodeHeight: 50, qrSize: 80 },
  xl: { label: '3" × 1.6"', width: '3in', height: '1.6in', fontSize: '12px', barcodeWidth: 2.5, barcodeHeight: 60, qrSize: 100 },
  custom: { label: 'Custom', width: '2in', height: '1in', fontSize: '9px', barcodeWidth: 1.5, barcodeHeight: 40, qrSize: 65 },
};

interface SelectedProduct {
  id: string;
  name: string;
  sku: string;
  sale_price: number;
  barcode?: string;
  quantity: number;
}

interface SelectedInvoice {
  id: string;
  invoice_number: string;
  customer_name: string;
  total_amount: number;
  balance_due: number;
  invoice_date: string;
  quantity: number;
}

export default function BarcodePrintPage() {
  const [mode, setMode] = useState<Mode>('products');
  const [codeType, setCodeType] = useState<CodeType>('barcode');
  const [labelSize, setLabelSize] = useState<LabelSize>('medium');
  const [columnsPerPage, setColumnsPerPage] = useState(3);
  const [showProductName, setShowProductName] = useState(true);
  const [showPrice, setShowPrice] = useState(true);
  const [showSku, setShowSku] = useState(true);
  const [showInvoiceNumber, setShowInvoiceNumber] = useState(true);
  const [showCustomer, setShowCustomer] = useState(true);
  const [showAmount, setShowAmount] = useState(true);

  const [customWidth, setCustomWidth] = useState(2);
  const [customHeight, setCustomHeight] = useState(1);
  const [nameFontSize, setNameFontSize] = useState(0);
  const [skuFontSize, setSkuFontSize] = useState(0);
  const [priceFontSize, setPriceFontSize] = useState(0);
  const [mrpLabelFontSize, setMrpLabelFontSize] = useState(0);

  const effWidth = labelSize === 'custom' ? `${customWidth}in` : LABEL_SIZES[labelSize].width;
  const effHeight = labelSize === 'custom' ? `${customHeight}in` : LABEL_SIZES[labelSize].height;
  const effBaseFontSize = LABEL_SIZES[labelSize].fontSize;
  const effBarcodeWidth = LABEL_SIZES[labelSize].barcodeWidth;
  const effBarcodeHeight = LABEL_SIZES[labelSize].barcodeHeight;
  const effQrSize = LABEL_SIZES[labelSize].qrSize;
  const effNameFontSize = nameFontSize > 0 ? `${nameFontSize}px` : effBaseFontSize;
  const effSkuFontSize = skuFontSize > 0 ? `${skuFontSize}px` : '7px';
  const effPriceFontSize = priceFontSize > 0 ? `${priceFontSize}px` : '12px';
  const effMrpLabelFontSize = mrpLabelFontSize > 0 ? `${mrpLabelFontSize}px` : '6px';

  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [invoices, setInvoices] = useState<(Invoice & { customer?: { name: string } })[]>([]);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [filterBrand, setFilterBrand] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  const [selectedProducts, setSelectedProducts] = useState<Map<string, SelectedProduct>>(new Map());
  const [selectedInvoices, setSelectedInvoices] = useState<Map<string, SelectedInvoice>>(new Map());

  const previewSvgRef = useRef<SVGSVGElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);
    try {
      // 2541+ active products / 600+ invoices exceed Supabase's 1000-row
      // default cap — page through everything so search sees the whole
      // catalog. id tiebreaker keeps page boundaries stable (product names
      // are not unique).
      const [productsData, catRes, brandRes, invoicesData] = await Promise.all([
        fetchAll<Product>(() => supabase.from('products').select('*, category:categories(name), brand:brands(name)').eq('is_active', true).order('name').order('id')),
        supabase.from('categories').select('*').eq('is_active', true).order('name'),
        supabase.from('brands').select('*').eq('is_active', true).order('name'),
        fetchAll(() => supabase.from('invoices').select('*, customer:customers(name)').order('created_at', { ascending: false }).order('id')),
      ]);
      setProducts(productsData);
      setCategories(catRes.data || []);
      setBrands(brandRes.data || []);
      setInvoices(invoicesData as any);
    } catch (err) {
      console.error('Failed to load barcode print data', err);
      toast({ title: 'Failed to load data', description: 'Please refresh the page to try again.', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }

  const filteredProducts = products.filter(p => {
    const matchSearch = !search || p.name.toLowerCase().includes(search.toLowerCase()) || p.sku.toLowerCase().includes(search.toLowerCase());
    const matchCat = !filterCategory || p.category_id === filterCategory;
    const matchBrand = !filterBrand || p.brand_id === filterBrand;
    return matchSearch && matchCat && matchBrand;
  });

  const filteredInvoices = invoices.filter(inv => {
    const matchSearch = !search || inv.invoice_number.toLowerCase().includes(search.toLowerCase()) || (inv.customer?.name || '').toLowerCase().includes(search.toLowerCase());
    const matchStatus = !filterStatus || inv.status === filterStatus;
    return matchSearch && matchStatus;
  });

  function toggleProduct(product: Product) {
    const next = new Map(selectedProducts);
    if (next.has(product.id)) {
      next.delete(product.id);
    } else {
      next.set(product.id, {
        id: product.id,
        name: product.name,
        sku: product.sku,
        sale_price: product.sale_price,
        barcode: product.barcode,
        quantity: 1,
      });
    }
    setSelectedProducts(next);
  }

  function updateProductQty(id: string, qty: number) {
    const next = new Map(selectedProducts);
    const item = next.get(id);
    if (item) { item.quantity = Math.max(1, qty); next.set(id, item); }
    setSelectedProducts(next);
  }

  function toggleInvoice(inv: Invoice & { customer?: { name: string } }) {
    const next = new Map(selectedInvoices);
    if (next.has(inv.id)) {
      next.delete(inv.id);
    } else {
      next.set(inv.id, {
        id: inv.id,
        invoice_number: inv.invoice_number,
        customer_name: inv.customer?.name || 'Walk-in',
        total_amount: inv.total_amount,
        balance_due: inv.balance_due,
        invoice_date: inv.invoice_date,
        quantity: 1,
      });
    }
    setSelectedInvoices(next);
  }

  function updateInvoiceQty(id: string, qty: number) {
    const next = new Map(selectedInvoices);
    const item = next.get(id);
    if (item) { item.quantity = Math.max(1, qty); next.set(id, item); }
    setSelectedInvoices(next);
  }

  function selectAllProducts() {
    const next = new Map(selectedProducts);
    filteredProducts.forEach(p => {
      if (!next.has(p.id)) {
        next.set(p.id, { id: p.id, name: p.name, sku: p.sku, sale_price: p.sale_price, barcode: p.barcode, quantity: 1 });
      }
    });
    setSelectedProducts(next);
  }

  function clearAllProducts() { setSelectedProducts(new Map()); }
  function selectAllInvoices() {
    const next = new Map(selectedInvoices);
    filteredInvoices.forEach(inv => {
      if (!next.has(inv.id)) {
        next.set(inv.id, { id: inv.id, invoice_number: inv.invoice_number, customer_name: inv.customer?.name || 'Walk-in', total_amount: inv.total_amount, balance_due: inv.balance_due, invoice_date: inv.invoice_date, quantity: 1 });
      }
    });
    setSelectedInvoices(next);
  }
  function clearAllInvoices() { setSelectedInvoices(new Map()); }

  const totalLabels = mode === 'products'
    ? Array.from(selectedProducts.values()).reduce((s, p) => s + p.quantity, 0)
    : Array.from(selectedInvoices.values()).reduce((s, i) => s + i.quantity, 0);

  // Generate preview
  useEffect(() => {
    const sampleData = mode === 'products'
      ? (filteredProducts[0]?.sku || 'SAMPLE-001')
      : (filteredInvoices[0]?.invoice_number || 'INV-0001');

    if (codeType === 'barcode' && previewSvgRef.current) {
      try {
        JsBarcode(previewSvgRef.current, sampleData, {
          format: 'CODE128',
          width: effBarcodeWidth,
          height: effBarcodeHeight,
          displayValue: false,
          margin: 0,
          background: '#ffffff',
          lineColor: '#000000',
        });
      } catch (e) { /* ignore */ }
    } else if (codeType === 'qrcode' && previewCanvasRef.current) {
      QRCode.toCanvas(previewCanvasRef.current, sampleData, {
        width: effQrSize,
        margin: 1,
        color: { dark: '#000000', light: '#ffffff' },
      }, () => {});
    }
  }, [codeType, labelSize, mode, filteredProducts, filteredInvoices, customWidth, customHeight]);

  function generateBarcodeSVG(data: string): string {
    const canvas = document.createElement('canvas');
    try {
      JsBarcode(canvas, data, {
        format: 'CODE128',
        width: effBarcodeWidth,
        height: effBarcodeHeight,
        displayValue: false,
        margin: 0,
        background: '#ffffff',
        lineColor: '#000000',
      });
      return canvas.toDataURL('image/png');
    } catch {
      return '';
    }
  }

  function generateQRDataURL(data: string): string {
    const canvas = document.createElement('canvas');
    QRCode.toCanvas(canvas, data, {
      width: effQrSize,
      margin: 1,
      color: { dark: '#000000', light: '#ffffff' },
    }, () => {});
    return canvas.toDataURL('image/png');
  }

  function handlePrint() {
    const items: { data: string; name: string; sku: string; price: number; invoiceNumber: string; customer: string; amount: number; }[] = [];
    if (mode === 'products') {
      selectedProducts.forEach(p => {
        for (let i = 0; i < p.quantity; i++) {
          items.push({ data: p.barcode || p.sku, name: p.name, sku: p.sku, price: p.sale_price, invoiceNumber: '', customer: '', amount: 0 });
        }
      });
    } else {
      selectedInvoices.forEach(inv => {
        for (let i = 0; i < inv.quantity; i++) {
          items.push({ data: inv.invoice_number, name: '', sku: '', price: 0, invoiceNumber: inv.invoice_number, customer: inv.customer_name, amount: inv.total_amount });
        }
      });
    }

    if (items.length === 0) {
      toast({ title: 'No items selected', description: 'Select items to print labels for.', variant: 'destructive' });
      return;
    }

    const cols = columnsPerPage;
    const labelsHTML = items.map(item => {
      let codeHTML = '';
      if (codeType === 'barcode') {
        const imgSrc = generateBarcodeSVG(item.data);
        codeHTML = `<img src="${imgSrc}" style="max-width:100%;height:auto;" />`;
      } else {
        const imgSrc = generateQRDataURL(item.data);
        codeHTML = `<img src="${imgSrc}" style="max-width:100%;height:auto;" />`;
      }

      let infoHTML = '';
      if (mode === 'products') {
        const nameLine = showProductName ? `<div class="name">${escapeHtml(item.name)}</div>` : '';
        const skuLine = showSku ? `<div class="code">${escapeHtml(item.sku)}</div>` : '';
        const priceLine = showPrice ? `<div class="price-row"><span class="mrp-label">MRP</span><span class="mrp">${formatCurrency(item.price)}</span></div>` : '';
        infoHTML = nameLine + skuLine + priceLine;
      } else {
        const invLine = showInvoiceNumber ? `<div class="name">${escapeHtml(item.invoiceNumber)}</div>` : '';
        const custLine = showCustomer ? `<div class="code">${escapeHtml(item.customer)}</div>` : '';
        const amtLine = showAmount ? `<div class="price-row"><span class="mrp-label">Amount</span><span class="mrp">${formatCurrency(item.amount)}</span></div>` : '';
        infoHTML = invLine + custLine + amtLine;
      }

      return `<div class="label">${codeHTML}${infoHTML}</div>`;
    }).join('');

    const w = window.open('', '_blank', 'width=800,height=600');
    if (!w) {
      toast({ title: 'Popup blocked', description: 'Allow popups to print labels.', variant: 'destructive' });
      return;
    }

    w.document.write(`<!DOCTYPE html><html><head><title>Print Labels - ${items.length} labels</title><style>
      @page { margin: 0.3in; }
      body { margin: 0; padding: 0; font-family: 'Helvetica Neue', Arial, sans-serif; }
      .grid { display: grid; grid-template-columns: repeat(${cols}, 1fr); gap: 4px; }
      .label {
        width: ${effWidth}; height: ${effHeight};
        display: flex; flex-direction: column; align-items: center; justify-content: space-between;
        padding: 4px 6px; box-sizing: border-box;
        border: 1px solid #e0e0e0; border-radius: 4px; overflow: hidden;
      }
      .name { font-size: ${effNameFontSize}; font-weight: 600; text-align: center; line-height: 1.2; color: #1a1a1a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
      .code { font-size: ${effSkuFontSize}; font-family: 'Courier New', monospace; color: #666; letter-spacing: 0.5px; }
      .mrp { font-size: ${effPriceFontSize}; font-weight: 700; color: #1a1a1a; }
      .mrp-label { font-size: ${effMrpLabelFontSize}; font-weight: 600; color: #999; text-transform: uppercase; letter-spacing: 1px; }
      .price-row { display: flex; align-items: baseline; gap: 3px; }
      img { display: block; }
    </style></head><body>
      <div class="grid">${labelsHTML}</div>
      <script>window.onload=function(){window.print();setTimeout(function(){window.close();},500);}<\/script>
    </body></html>`);
    w.document.close();
  }

  const selectedCount = mode === 'products' ? selectedProducts.size : selectedInvoices.size;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
            <Barcode className="w-5 h-5 text-blue-600" />
            Barcode / QR Print
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">Generate and print barcode/QR labels in bulk for products and invoices</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="text-sm text-muted-foreground">
            <span className="font-semibold text-foreground">{selectedCount}</span> selected
            {totalLabels > 0 && <span className="ml-1">· {totalLabels} labels</span>}
          </div>
          <button
            onClick={handlePrint}
            disabled={totalLabels === 0}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition disabled:opacity-50"
          >
            <Printer className="w-4 h-4" />
            Print {totalLabels > 0 ? `(${totalLabels})` : ''}
          </button>
        </div>
      </div>

      {/* Mode + Code Type Tabs */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex bg-muted/50 rounded-lg p-1">
          {([
            { key: 'products' as Mode, label: 'Products', icon: Boxes },
            { key: 'invoices' as Mode, label: 'Invoices', icon: FileText },
          ]).map(m => (
            <button
              key={m.key}
              onClick={() => setMode(m.key)}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium transition ${mode === m.key ? 'bg-white text-blue-600 shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
            >
              <m.icon className="w-4 h-4" />
              {m.label}
            </button>
          ))}
        </div>

        <div className="flex bg-muted/50 rounded-lg p-1">
          {([
            { key: 'barcode' as CodeType, label: 'Barcode', icon: Barcode },
            { key: 'qrcode' as CodeType, label: 'QR Code', icon: QrCode },
          ]).map(c => (
            <button
              key={c.key}
              onClick={() => setCodeType(c.key)}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium transition ${codeType === c.key ? 'bg-white text-blue-600 shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
            >
              <c.icon className="w-4 h-4" />
              {c.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Left: Selection Table */}
        <div className="lg:col-span-2 space-y-3">
          {/* Filters */}
          <div className="bg-white rounded-xl border border-border p-4 shadow-sm space-y-3">
            <div className="flex flex-wrap gap-3">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder={mode === 'products' ? 'Search products...' : 'Search invoices...'}
                  className="w-full pl-8 pr-4 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
              </div>
              {mode === 'products' ? (
                <>
                  <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)} className="border border-border rounded-lg px-3 py-2 text-sm focus:outline-none bg-white">
                    <option value="">All Categories</option>
                    {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <select value={filterBrand} onChange={e => setFilterBrand(e.target.value)} className="border border-border rounded-lg px-3 py-2 text-sm focus:outline-none bg-white">
                    <option value="">All Brands</option>
                    {brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </>
              ) : (
                <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="border border-border rounded-lg px-3 py-2 text-sm focus:outline-none bg-white">
                  <option value="">All Status</option>
                  <option value="paid">Paid</option>
                  <option value="partially_paid">Partial</option>
                  <option value="sent">On Credit</option>
                  <option value="overdue">Overdue</option>
                  <option value="draft">Draft</option>
                </select>
              )}
              <div className="flex gap-2">
                <button
                  onClick={mode === 'products' ? selectAllProducts : selectAllInvoices}
                  className="flex items-center gap-1.5 px-3 py-2 text-sm border border-border rounded-lg hover:bg-blue-50 hover:text-blue-600 hover:border-blue-300 transition"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Select All
                </button>
                <button
                  onClick={mode === 'products' ? clearAllProducts : clearAllInvoices}
                  className="flex items-center gap-1.5 px-3 py-2 text-sm border border-border rounded-lg hover:bg-red-50 hover:text-red-600 hover:border-red-300 transition"
                >
                  <X className="w-3.5 h-3.5" />
                  Clear
                </button>
              </div>
            </div>
          </div>

          {/* Products Table */}
          {mode === 'products' && (
            <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
              <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                <table className="w-full">
                  <thead className="bg-muted/40 border-b border-border sticky top-0 z-10">
                    <tr>
                      <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3 w-10"></th>
                      <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Product</th>
                      <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">SKU</th>
                      <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Category</th>
                      <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Price</th>
                      <th className="text-center text-xs font-semibold text-muted-foreground px-4 py-3 w-28">Qty</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {loading ? Array.from({ length: 8 }).map((_, i) => (
                      <tr key={i}><td colSpan={6} className="px-4 py-3"><div className="h-4 bg-muted rounded animate-pulse" /></td></tr>
                    )) : filteredProducts.length === 0 ? (
                      <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">No products found</td></tr>
                    ) : filteredProducts.map(p => {
                      const sel = selectedProducts.get(p.id);
                      const isSel = !!sel;
                      return (
                        <tr key={p.id} className={`hover:bg-muted/30 transition-colors ${isSel ? 'bg-blue-50/40' : ''}`}>
                          <td className="px-4 py-3">
                            <input type="checkbox" checked={isSel} onChange={() => toggleProduct(p)} className="w-4 h-4 rounded border-border text-blue-600 focus:ring-blue-500" />
                          </td>
                          <td className="px-4 py-3 text-sm font-medium text-foreground">{p.name}</td>
                          <td className="px-4 py-3 text-sm text-muted-foreground font-mono">{p.sku}</td>
                          <td className="px-4 py-3 text-sm text-muted-foreground">{(p as any).category?.name || '—'}</td>
                          <td className="px-4 py-3 text-right text-sm font-semibold text-foreground">{formatCurrency(p.sale_price)}</td>
                          <td className="px-4 py-3 text-center">
                            {isSel ? (
                              <input
                                type="number"
                                min={1}
                                value={sel!.quantity}
                                onChange={e => updateProductQty(p.id, parseInt(e.target.value) || 1)}
                                className="w-16 border border-border rounded-lg px-2 py-1 text-sm text-center focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                              />
                            ) : (
                              <span className="text-muted-foreground text-xs">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Invoices Table */}
          {mode === 'invoices' && (
            <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
              <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                <table className="w-full">
                  <thead className="bg-muted/40 border-b border-border sticky top-0 z-10">
                    <tr>
                      <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3 w-10"></th>
                      <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Invoice #</th>
                      <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Customer</th>
                      <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Date</th>
                      <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Amount</th>
                      <th className="text-center text-xs font-semibold text-muted-foreground px-4 py-3 w-28">Qty</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {loading ? Array.from({ length: 8 }).map((_, i) => (
                      <tr key={i}><td colSpan={6} className="px-4 py-3"><div className="h-4 bg-muted rounded animate-pulse" /></td></tr>
                    )) : filteredInvoices.length === 0 ? (
                      <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">No invoices found</td></tr>
                    ) : filteredInvoices.map(inv => {
                      const sel = selectedInvoices.get(inv.id);
                      const isSel = !!sel;
                      return (
                        <tr key={inv.id} className={`hover:bg-muted/30 transition-colors ${isSel ? 'bg-blue-50/40' : ''}`}>
                          <td className="px-4 py-3">
                            <input type="checkbox" checked={isSel} onChange={() => toggleInvoice(inv)} className="w-4 h-4 rounded border-border text-blue-600 focus:ring-blue-500" />
                          </td>
                          <td className="px-4 py-3 text-sm font-semibold text-blue-600">{inv.invoice_number}</td>
                          <td className="px-4 py-3 text-sm text-foreground">{inv.customer?.name || 'Walk-in'}</td>
                          <td className="px-4 py-3 text-sm text-muted-foreground">{new Date(inv.invoice_date).toLocaleDateString()}</td>
                          <td className="px-4 py-3 text-right text-sm font-semibold text-foreground">{formatCurrency(inv.total_amount)}</td>
                          <td className="px-4 py-3 text-center">
                            {isSel ? (
                              <input
                                type="number"
                                min={1}
                                value={sel!.quantity}
                                onChange={e => updateInvoiceQty(inv.id, parseInt(e.target.value) || 1)}
                                className="w-16 border border-border rounded-lg px-2 py-1 text-sm text-center focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                              />
                            ) : (
                              <span className="text-muted-foreground text-xs">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Right: Settings + Preview */}
        <div className="space-y-4">
          {/* Label Settings */}
          <div className="bg-white rounded-xl border border-border p-4 shadow-sm space-y-4">
            <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
              <Settings className="w-4 h-4 text-muted-foreground" />
              Label Settings
            </h3>

            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">Label Size</label>
              <div className="grid grid-cols-3 gap-2">
                {(['xs', 'small', 'medium', 'large', 'xl', 'custom'] as LabelSize[]).map(s => (
                  <button
                    key={s}
                    onClick={() => setLabelSize(s)}
                    className={`px-2 py-2 rounded-lg text-xs font-medium border transition ${labelSize === s ? 'border-blue-500 text-blue-600 bg-blue-50' : 'border-border text-muted-foreground hover:border-blue-300'}`}
                  >
                    {LABEL_SIZES[s].label}
                  </button>
                ))}
              </div>
              {labelSize === 'custom' && (
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <div>
                    <label className="block text-[10px] font-medium text-muted-foreground mb-1">Width (in)</label>
                    <input type="number" min="0.5" max="5" step="0.1" value={customWidth} onChange={e => setCustomWidth(parseFloat(e.target.value) || 2)} className="w-full border border-border rounded-lg px-2 py-1.5 text-sm text-center focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
                  </div>
                  <div>
                    <label className="block text-[10px] font-medium text-muted-foreground mb-1">Height (in)</label>
                    <input type="number" min="0.3" max="3" step="0.1" value={customHeight} onChange={e => setCustomHeight(parseFloat(e.target.value) || 1)} className="w-full border border-border rounded-lg px-2 py-1.5 text-sm text-center focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
                  </div>
                </div>
              )}
            </div>

            {mode === 'products' && (
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Text Font Sizes (px) <span className="text-[10px] font-normal">· 0 = auto</span></label>
                <div className="grid grid-cols-2 gap-2">
                  <FontSizeInput label="Name" value={nameFontSize} onChange={setNameFontSize} />
                  <FontSizeInput label="SKU" value={skuFontSize} onChange={setSkuFontSize} />
                  <FontSizeInput label="MRP" value={priceFontSize} onChange={setPriceFontSize} />
                  <FontSizeInput label="MRP Label" value={mrpLabelFontSize} onChange={setMrpLabelFontSize} />
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">Columns Per Page</label>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={1}
                  max={5}
                  value={columnsPerPage}
                  onChange={e => setColumnsPerPage(parseInt(e.target.value))}
                  className="flex-1"
                />
                <span className="text-sm font-semibold text-foreground w-6 text-center">{columnsPerPage}</span>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">Show on Label</label>
              <div className="space-y-2">
                {mode === 'products' ? (
                  <>
                    <ToggleRow label="Product Name" checked={showProductName} onChange={setShowProductName} />
                    <ToggleRow label="SKU / Code" checked={showSku} onChange={setShowSku} />
                    <ToggleRow label="Price (MRP)" checked={showPrice} onChange={setShowPrice} />
                  </>
                ) : (
                  <>
                    <ToggleRow label="Invoice Number" checked={showInvoiceNumber} onChange={setShowInvoiceNumber} />
                    <ToggleRow label="Customer Name" checked={showCustomer} onChange={setShowCustomer} />
                    <ToggleRow label="Amount" checked={showAmount} onChange={setShowAmount} />
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Live Preview */}
          <div className="bg-white rounded-xl border border-border p-4 shadow-sm space-y-3">
            <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
              <Eye className="w-4 h-4 text-muted-foreground" />
              Live Preview
            </h3>
            <div className="flex justify-center">
              <div
                className="border border-gray-200 rounded-lg bg-white flex flex-col items-center justify-between gap-1 p-2"
                style={{ width: effWidth, minHeight: effHeight }}
              >
                {mode === 'products' && showProductName && (
                  <p className="text-center font-semibold text-foreground leading-tight line-clamp-2" style={{ fontSize: effNameFontSize }}>
                    {filteredProducts[0]?.name || 'Sample Product'}
                  </p>
                )}
                {mode === 'invoices' && showInvoiceNumber && (
                  <p className="text-center font-semibold text-foreground leading-tight" style={{ fontSize: effNameFontSize }}>
                    {filteredInvoices[0]?.invoice_number || 'INV-0001'}
                  </p>
                )}
                {codeType === 'barcode' ? (
                  <svg ref={previewSvgRef} className="max-w-full h-auto" />
                ) : (
                  <canvas ref={previewCanvasRef} className="max-w-full h-auto" />
                )}
                {mode === 'products' && showSku && (
                  <p className="font-mono text-muted-foreground tracking-wide" style={{ fontSize: effSkuFontSize }}>
                    {filteredProducts[0]?.sku || 'SAMPLE-001'}
                  </p>
                )}
                {mode === 'invoices' && showCustomer && (
                  <p className="font-mono text-muted-foreground" style={{ fontSize: effSkuFontSize }}>
                    {filteredInvoices[0]?.customer?.name || 'Walk-in Customer'}
                  </p>
                )}
                {mode === 'products' && showPrice && (
                  <div className="flex items-baseline gap-1 pt-0.5 border-t border-gray-100 w-full justify-center">
                    <span className="font-semibold text-gray-400 uppercase tracking-wider" style={{ fontSize: effMrpLabelFontSize }}>MRP</span>
                    <span className="font-bold text-foreground" style={{ fontSize: effPriceFontSize }}>{formatCurrency(filteredProducts[0]?.sale_price || 0)}</span>
                  </div>
                )}
                {mode === 'invoices' && showAmount && (
                  <div className="flex items-baseline gap-1 pt-0.5 border-t border-gray-100 w-full justify-center">
                    <span className="font-semibold text-gray-400 uppercase tracking-wider" style={{ fontSize: effMrpLabelFontSize }}>Amount</span>
                    <span className="font-bold text-foreground" style={{ fontSize: effPriceFontSize }}>{formatCurrency(filteredInvoices[0]?.total_amount || 0)}</span>
                  </div>
                )}
              </div>
            </div>
            <p className="text-xs text-center text-muted-foreground">
              {codeType === 'barcode' ? 'CODE128' : 'QR Code'} · {labelSize === 'custom' ? `${customWidth}"×${customHeight}"` : LABEL_SIZES[labelSize].label} · {columnsPerPage} cols
            </p>
          </div>

          {/* Selected Items Summary */}
          {(selectedCount > 0) && (
            <div className="bg-white rounded-xl border border-border p-4 shadow-sm space-y-2">
              <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
                <Layers className="w-4 h-4 text-muted-foreground" />
                Selected Items ({selectedCount})
              </h3>
              <div className="max-h-40 overflow-y-auto space-y-1">
                {mode === 'products' && Array.from(selectedProducts.values()).map(p => (
                  <div key={p.id} className="flex items-center justify-between text-xs">
                    <span className="text-foreground truncate flex-1">{p.name}</span>
                    <span className="text-muted-foreground ml-2">×{p.quantity}</span>
                  </div>
                ))}
                {mode === 'invoices' && Array.from(selectedInvoices.values()).map(inv => (
                  <div key={inv.id} className="flex items-center justify-between text-xs">
                    <span className="text-blue-600 font-medium truncate flex-1">{inv.invoice_number}</span>
                    <span className="text-muted-foreground ml-2">×{inv.quantity}</span>
                  </div>
                ))}
              </div>
              <div className="pt-2 border-t border-border flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Total labels</span>
                <span className="text-sm font-bold text-foreground">{totalLabels}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FontSizeInput({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div>
      <label className="block text-[10px] font-medium text-muted-foreground mb-1">{label}</label>
      <div className="flex items-center gap-1">
        <input
          type="number"
          min="0"
          max="30"
          step="0.5"
          value={value}
          onChange={e => onChange(parseFloat(e.target.value) || 0)}
          className="w-full border border-border rounded-lg px-2 py-1.5 text-sm text-center focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          placeholder="0"
        />
        <span className="text-[10px] text-muted-foreground shrink-0 whitespace-nowrap">{value > 0 ? 'px' : 'auto'}</span>
      </div>
    </div>
  );
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between cursor-pointer">
      <span className="text-xs text-foreground">{label}</span>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`relative w-9 h-5 rounded-full transition ${checked ? 'bg-blue-600' : 'bg-muted'}`}
      >
        <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${checked ? 'translate-x-4' : ''}`} />
      </button>
    </label>
  );
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
