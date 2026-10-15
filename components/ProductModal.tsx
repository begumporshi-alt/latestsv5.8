'use client';

import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { toast } from '@/hooks/use-toast';
import { Package, Plus, Trash2, X, Warehouse, Palette, Ruler, ChevronDown, ChevronUp, Info, Barcode } from 'lucide-react';
import type { Product, Category, Brand, Warehouse as WarehouseType, ProductColor, ProductSize, ProductUnit } from '@/lib/types';
import { LABEL_SIZES, type LabelSize } from '@/lib/label-sizes';
import SearchableSelect from '@/components/ui/SearchableSelect';
import { networkMonitor } from '@/lib/offline/network';
import { enqueueOp } from '@/lib/offline/outbox';
import { patchInventoryAggregateAfterProductOp, patchPosSnapshotAfterProductOp } from '@/lib/offline/optimistic';

// Callers pass either a raw Product or an inventory-list row whose
// category/brand are narrowed to { name } — only these fields are read.
export type ProductModalProduct = Omit<Product, 'category' | 'brand'> & {
  category?: { name: string };
  brand?: { name: string };
};

export default function ProductModal({ categories, brands, warehouses, unitTypes, product, onClose, onSaved, onCreated }: {
  categories: Category[];
  brands: Brand[];
  warehouses: WarehouseType[];
  unitTypes: { id: string; unit_name: string; unit_short: string }[];
  product?: ProductModalProduct | null;
  onClose: () => void;
  onSaved: () => void;
  onCreated?: (product: Record<string, any>) => void;
}) {
  const isEdit = !!product;
  const [form, setForm] = useState({
    name: product?.name || '',
    sku: product?.sku || '',
    unit: product?.unit || 'pcs',
    cost_price: product?.cost_price?.toString() || '',
    sale_price: product?.sale_price?.toString() || '',
    category_id: product?.category_id || '',
    brand_id: product?.brand_id || '',
    min_stock_level: product?.min_stock_level?.toString() || '0',
    warranty_months: product?.warranty_months?.toString() || '0',
    description: product?.description || '',
    is_active: product?.is_active ?? true,
    track_inventory: (product as any)?.track_inventory ?? true,
    enable_multi_unit: product?.enable_multi_unit ?? false,
    enable_colors: product?.enable_colors ?? false,
    enable_sizes: product?.enable_sizes ?? false,
    barcode_label_size: product?.barcode_label_size || '',
    barcode_label_width: product?.barcode_label_width != null ? String(product.barcode_label_width) : '2',
    barcode_label_height: product?.barcode_label_height != null ? String(product.barcode_label_height) : '1',
  });
  const [stockByWarehouse, setStockByWarehouse] = useState<Record<string, string>>(
    warehouses.reduce((acc, w) => ({ ...acc, [w.id]: '0' }), {})
  );
  // Tracks the original DB stock to compute diffs accurately (not the stale prop)
  const originalStockRef = useRef<Record<string, number>>({});
  const [colors, setColors] = useState<ProductColor[]>([]);
  const [sizes, setSizes] = useState<ProductSize[]>([]);
  const [units, setUnits] = useState<ProductUnit[]>([]);
  const [showUnits, setShowUnits] = useState(true);
  const [showColors, setShowColors] = useState(true);
  const [showSizes, setShowSizes] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (product?.id) {
      loadProductVariants(product.id);
    }
  }, [product?.id]);

  async function loadProductVariants(productId: string) {
    const [colorRes, sizeRes, unitRes, invRes] = await Promise.all([
      supabase.from('product_colors').select('*').eq('product_id', productId).order('sort_order'),
      supabase.from('product_sizes').select('*').eq('product_id', productId).order('sort_order'),
      supabase.from('product_units').select('*').eq('product_id', productId).order('sort_order'),
      supabase.from('inventory_items').select('warehouse_id, quantity_on_hand').eq('product_id', productId),
    ]);
    setColors((colorRes.data || []) as ProductColor[]);
    setSizes((sizeRes.data || []) as ProductSize[]);
    setUnits((unitRes.data || []) as ProductUnit[]);

    // Load current stock by warehouse
    const stockMap: Record<string, string> = {};
    const origMap: Record<string, number> = {};
    warehouses.forEach(w => { stockMap[w.id] = '0'; origMap[w.id] = 0; });
    (invRes.data || []).forEach(inv => {
      stockMap[inv.warehouse_id] = String(inv.quantity_on_hand);
      origMap[inv.warehouse_id] = Number(inv.quantity_on_hand);
    });
    setStockByWarehouse(stockMap);
    originalStockRef.current = origMap;
  }

  function addColor() {
    setColors([...colors, {
      id: `temp-${Date.now()}`,
      product_id: product?.id || '',
      name: '',
      hex_code: '#000000',
      is_default: colors.length === 0,
      sort_order: colors.length,
      created_at: new Date().toISOString(),
    }]);
  }

  function addSize() {
    setSizes([...sizes, {
      id: `temp-${Date.now()}`,
      product_id: product?.id || '',
      name: '',
      dimensions: '',
      is_default: sizes.length === 0,
      sort_order: sizes.length,
      created_at: new Date().toISOString(),
    }]);
  }

  function addUnit() {
    const hasBaseUnit = units.some(u => u.is_base_unit);
    setUnits([...units, {
      id: `temp-${Date.now()}`,
      product_id: product?.id || '',
      unit_name: '',
      unit_short: '',
      conversion_factor: 1,
      is_base_unit: !hasBaseUnit,
      is_sale_unit: units.length === 0,
      price: 0,
      cost_price: 0,
      sort_order: units.length,
      is_active: true,
      created_at: new Date().toISOString(),
    }]);
  }

  function updateColor(index: number, field: keyof ProductColor, value: any) {
    const updated = [...colors];
    (updated[index] as any)[field] = value;
    if (field === 'is_default' && value === true) {
      updated.forEach((c, i) => { if (i !== index) c.is_default = false; });
    }
    setColors(updated);
  }

  function updateSize(index: number, field: keyof ProductSize, value: any) {
    const updated = [...sizes];
    (updated[index] as any)[field] = value;
    if (field === 'is_default' && value === true) {
      updated.forEach((s, i) => { if (i !== index) s.is_default = false; });
    }
    setSizes(updated);
  }

  function updateUnit(index: number, field: keyof ProductUnit, value: any) {
    const updated = [...units];
    (updated[index] as any)[field] = value;
    if (field === 'is_base_unit' && value === true) {
      updated.forEach((u, i) => { if (i !== index) u.is_base_unit = false; });
    }
    if (field === 'is_sale_unit' && value === true) {
      updated.forEach((u, i) => { if (i !== index) u.is_sale_unit = false; });
    }
    setUnits(updated);
  }

  function removeColor(index: number) {
    setColors(colors.filter((_, i) => i !== index));
  }

  function removeSize(index: number) {
    setSizes(sizes.filter((_, i) => i !== index));
  }

  function removeUnit(index: number) {
    setUnits(units.filter((_, i) => i !== index));
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();

    if (form.enable_multi_unit) {
      if (units.length === 0) {
        setError('Please add at least one unit when multi-unit is enabled');
        return;
      }
      if (!units.some(u => u.is_base_unit)) {
        setError('Please mark one unit as the base unit');
        return;
      }
    }

    setSaving(true);
    setError('');

    const baseUnit = form.enable_multi_unit ? units.find(u => u.is_base_unit)?.unit_name || form.unit : form.unit;

    const data: any = {
      name: form.name,
      sku: form.sku,
      unit: form.unit,
      base_unit: baseUnit,
      enable_multi_unit: form.enable_multi_unit,
      enable_colors: form.enable_colors,
      enable_sizes: form.enable_sizes,
      cost_price: Number(form.cost_price),
      sale_price: Number(form.sale_price),
      category_id: form.category_id || null,
      brand_id: form.brand_id || null,
      min_stock_level: Number(form.min_stock_level),
      warranty_months: Number(form.warranty_months),
      description: form.description || null,
      is_active: form.is_active,
      track_inventory: form.track_inventory,
      barcode_label_size: form.barcode_label_size || null,
      barcode_label_width: form.barcode_label_size === 'custom' ? (Number(form.barcode_label_width) || null) : null,
      barcode_label_height: form.barcode_label_size === 'custom' ? (Number(form.barcode_label_height) || null) : null,
    };

    let productId = product?.id;

    // Offline: queue the same payload the online path writes. The server-side
    // sync handler applies it atomically and recomputes stock diffs against
    // live data, so a stale offline baseline can never corrupt an adjustment.
    if (!networkMonitor.getState().online) {
      const validColors = colors.filter(c => c.name.trim());
      const validSizes = sizes.filter(s => s.name.trim());
      const validUnits = units.filter(u => u.unit_name.trim());
      const stock = Object.entries(stockByWarehouse)
        .map(([warehouseId, qty]) => ({
          warehouse_id: warehouseId,
          quantity: Number(qty) || 0,
          unit_cost: Number(form.cost_price) || 0,
        }))
        .filter(s => (isEdit ? true : s.quantity > 0));

      const newProductId = isEdit ? product!.id : crypto.randomUUID();
      const payload: any = { data, colors: validColors, sizes: validSizes, units: validUnits, stock };
      if (isEdit) {
        payload.id = product!.id;
        // A row created offline by this device has no competing server
        // version — omit the version stamp so the update applies cleanly
        // behind its own queued create instead of always conflicting.
        if (!(product as any).__pending) {
          payload.expected_updated_at = (product as any).updated_at ?? null;
        }
      } else {
        payload.id = newProductId;
      }

      try {
        const op = isEdit ? 'product.update' : 'product.create';
        await enqueueOp(op, payload, `${isEdit ? 'Product edit' : 'New product'} — ${form.name}`);
        await patchInventoryAggregateAfterProductOp(op, payload, newProductId);
        await patchPosSnapshotAfterProductOp(op, payload, newProductId);
      } catch (err: any) {
        setError(err?.message || 'Offline storage error');
        setSaving(false);
        return;
      }

      toast({
        title: isEdit ? 'Product edit queued offline' : 'Product queued offline',
        description: `${form.name} will sync automatically when you're back online.`,
      });
      onSaved();
      onClose();
      return;
    }

    try {
      if (isEdit) {
        const { error } = await supabase.from('products').update({ ...data, updated_at: new Date().toISOString() }).eq('id', product!.id);
        if (error) throw error;
      } else {
        const { data: newProduct, error } = await supabase.from('products').insert(data).select('id').single();
        if (error) throw error;
        productId = newProduct.id;
      }

      if (productId) {
        if (form.enable_colors && colors.length > 0) {
          await supabase.from('product_colors').delete().eq('product_id', productId);
          const validColors = colors.filter(c => c.name.trim());
          for (const color of validColors) {
            await supabase.from('product_colors').insert({
              product_id: productId,
              name: color.name,
              hex_code: color.hex_code,
              image_url: color.image_url || null,
              is_default: color.is_default,
              sort_order: color.sort_order,
            });
          }
        }

        if (form.enable_sizes && sizes.length > 0) {
          await supabase.from('product_sizes').delete().eq('product_id', productId);
          const validSizes = sizes.filter(s => s.name.trim());
          for (const size of validSizes) {
            await supabase.from('product_sizes').insert({
              product_id: productId,
              name: size.name,
              dimensions: size.dimensions || null,
              is_default: size.is_default,
              sort_order: size.sort_order,
            });
          }
        }

        if (form.enable_multi_unit && units.length > 0) {
          await supabase.from('product_units').delete().eq('product_id', productId);
          const validUnits = units.filter(u => u.unit_name.trim());
          for (const unit of validUnits) {
            await supabase.from('product_units').insert({
              product_id: productId,
              unit_name: unit.unit_name,
              unit_short: unit.unit_short || null,
              conversion_factor: unit.conversion_factor,
              is_base_unit: unit.is_base_unit,
              is_sale_unit: unit.is_sale_unit,
              price: unit.price,
              cost_price: unit.cost_price,
              barcode: unit.barcode || null,
              sort_order: unit.sort_order,
              is_active: unit.is_active,
            });
          }
        }

        if (!isEdit) {
          for (const [warehouseId, qty] of Object.entries(stockByWarehouse)) {
            const quantity = Number(qty);
            if (quantity > 0) {
              await supabase.from('inventory_items').insert({
                tenant_id: '00000000-0000-0000-0000-000000000001',
                product_id: productId,
                warehouse_id: warehouseId,
                quantity_on_hand: quantity,
              });

              await supabase.from('stock_movements').insert({
                tenant_id: '00000000-0000-0000-0000-000000000001',
                product_id: productId,
                warehouse_id: warehouseId,
                movement_type: 'opening',
                quantity: quantity,
                unit_cost: Number(form.cost_price),
                reference_type: 'product_creation',
                reference_id: productId,
                notes: 'Initial stock on product creation',
              });

              await supabase.rpc('create_opening_batch', {
                p_product_id: productId,
                p_warehouse_id: warehouseId,
                p_quantity: quantity,
                p_unit_cost: Number(form.cost_price),
                p_batch_type: 'opening',
                p_reference_type: 'product_creation',
                p_reference_id: productId,
                p_notes: 'Initial stock on product creation',
              });
            }
          }
        } else {
          // Handle stock adjustments for existing products
          for (const [warehouseId, newQtyStr] of Object.entries(stockByWarehouse)) {
            const newQty = Number(newQtyStr);
            // Use freshly-loaded DB values (originalStockRef), not the stale product prop
            const currentQty = originalStockRef.current[warehouseId] ?? 0;
            const diff = newQty - currentQty;

            if (diff !== 0) {
              // Try update first; if no row exists, insert
              const { data: existingInv } = await supabase
                .from('inventory_items')
                .select('id')
                .eq('product_id', productId!)
                .eq('warehouse_id', warehouseId)
                .maybeSingle();

              if (existingInv) {
                await supabase.from('inventory_items')
                  .update({ quantity_on_hand: newQty, updated_at: new Date().toISOString() })
                  .eq('id', existingInv.id);
              } else {
                await supabase.from('inventory_items').insert({
                  tenant_id: '00000000-0000-0000-0000-000000000001',
                  product_id: productId,
                  warehouse_id: warehouseId,
                  quantity_on_hand: newQty,
                });
              }

              // Record movement — store signed diff so increases are + and decreases are -
              await supabase.from('stock_movements').insert({
                tenant_id: '00000000-0000-0000-0000-000000000001',
                product_id: productId,
                warehouse_id: warehouseId,
                movement_type: 'adjustment',
                quantity: diff,
                unit_cost: Number(form.cost_price) || 0,
                reference_type: 'stock_adjustment',
                reference_id: productId,
                notes: diff > 0 ? 'Stock increase adjustment' : 'Stock decrease adjustment',
              });

              if (diff > 0) {
                await supabase.rpc('create_opening_batch', {
                  p_product_id: productId,
                  p_warehouse_id: warehouseId,
                  p_quantity: diff,
                  p_unit_cost: Number(form.cost_price) || 0,
                  p_batch_type: 'adjustment',
                  p_reference_type: 'stock_adjustment',
                  p_reference_id: productId,
                  p_notes: 'Stock increase adjustment',
                });
              } else if (diff < 0) {
                // Stock decrease: post Dr 3900 / Cr 1200 (equity — quantity corrections are not P&L)
                await supabase.rpc('create_stock_reduction', {
                  p_product_id: productId,
                  p_warehouse_id: warehouseId,
                  p_quantity: Math.abs(diff),
                  p_unit_cost: Number(form.cost_price) || 0,
                  p_reference_type: 'stock_adjustment',
                  p_reference_id: productId,
                  p_notes: 'Stock decrease adjustment',
                });
              }
            }
          }
        }
      }

      // Let embedders (e.g. the PO form) add the fresh row as a line item.
      // Offline-queued creates skip this — the row doesn't exist server-side
      // yet, so referencing it in a PO would break the FK on sync.
      if (!isEdit && onCreated) {
        onCreated({
          id: productId,
          ...data,
          units: form.enable_multi_unit ? units.filter(u => u.unit_name.trim()) : [],
        });
      }

      toast({ title: 'Success', description: isEdit ? 'Product updated successfully' : 'Product created successfully' });
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
      <div className="bg-white rounded-2xl w-full max-w-3xl shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-white z-10">
          <h2 className="text-base font-bold">{isEdit ? 'Edit Product' : 'Add New Product'}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={handleSave} className="p-6 space-y-4">
          {error && <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">Product Name *</label>
              <input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">SKU *</label>
              <input required value={form.sku} onChange={e => setForm({ ...form, sku: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">Category</label>
              <SearchableSelect
                value={form.category_id}
                onChange={v => setForm({ ...form, category_id: v })}
                placeholder="Select category"
                options={categories.filter(c => !c.parent_id).flatMap(c => [
                  { value: c.id, label: c.name, group: c.name },
                  ...categories.filter(sc => sc.parent_id === c.id).map(sc => ({ value: sc.id, label: `\u00a0\u00a0${sc.name}`, group: c.name })),
                ])}
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Brand</label>
              <SearchableSelect
                value={form.brand_id}
                onChange={v => setForm({ ...form, brand_id: v })}
                placeholder="Select brand"
                options={brands.map(b => ({ value: b.id, label: b.name }))}
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-4 p-3 bg-muted/30 rounded-lg">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.enable_multi_unit} onChange={e => setForm({ ...form, enable_multi_unit: e.target.checked })} className="rounded" />
              <span className="text-sm flex items-center gap-1"><Package className="w-3.5 h-3.5" /> Multi-Unit Pricing</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.enable_colors} onChange={e => setForm({ ...form, enable_colors: e.target.checked })} className="rounded" />
              <span className="text-sm flex items-center gap-1"><Palette className="w-3.5 h-3.5" /> Color Variants</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.enable_sizes} onChange={e => setForm({ ...form, enable_sizes: e.target.checked })} className="rounded" />
              <span className="text-sm flex items-center gap-1"><Ruler className="w-3.5 h-3.5" /> Size Variants</span>
            </label>
          </div>

          {!form.enable_multi_unit && (
            <div className="grid grid-cols-4 gap-4">
              <div>
                <label className="block text-xs font-medium mb-1">Unit</label>
                <SearchableSelect
                  value={form.unit}
                  onChange={v => setForm({ ...form, unit: v })}
                  placeholder="Select unit"
                  options={unitTypes.length > 0
                    ? unitTypes.map(u => ({ value: u.unit_name, label: u.unit_name + (u.unit_short && u.unit_short !== u.unit_name ? ` (${u.unit_short})` : '') }))
                    : ['pcs','sqft','bag','tin','set','box','kg','ltr','meter','coil','roll','carton'].map(u => ({ value: u, label: u }))
                  }
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Cost Price *</label>
                <input type="number" required min="0" step="0.01" value={form.cost_price} onChange={e => setForm({ ...form, cost_price: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
                <p className="text-[10px] text-muted-foreground mt-1 leading-tight">Auto-updates only when a purchase price is higher than this; cheaper purchases keep the current cost.</p>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Sale Price *</label>
                <input type="number" required min="0" step="0.01" value={form.sale_price} onChange={e => setForm({ ...form, sale_price: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Warranty (months)</label>
                <input type="number" min="0" value={form.warranty_months} onChange={e => setForm({ ...form, warranty_months: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
                <p className="text-[10px] text-muted-foreground mt-1">Optional warranty period for this product</p>
              </div>
            </div>
          )}

          {form.enable_multi_unit && (
            <div className="border border-border rounded-lg overflow-hidden">
              <button type="button" onClick={() => setShowUnits(!showUnits)} className="w-full flex items-center justify-between px-4 py-3 bg-blue-50 text-blue-700 hover:bg-blue-100 transition">
                <span className="font-medium text-sm flex items-center gap-2"><Package className="w-4 h-4" /> Units & Pricing ({units.length})</span>
                {showUnits ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>
              {showUnits && (
                <div className="p-4 space-y-3 bg-white">
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-3">
                    <p className="text-xs text-blue-800 flex items-start gap-2">
                      <Info className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>
                        <strong>How Multi-Unit Works:</strong> The <strong>Base Unit</strong> is your smallest tracked unit (conversion = 1). Each other unit&apos;s <strong>Conv.</strong> value says how many base units it contains.
                        <br /><strong>Example for tiles:</strong>
                      </span>
                    </p>
                    <div className="mt-2 grid grid-cols-6 gap-1 text-[11px] font-medium text-blue-700 px-6">
                      <span>Unit</span><span>Short</span><span>Conv.</span><span>Sale ৳</span><span>Cost ৳</span><span>Flag</span>
                    </div>
                    <div className="mt-0.5 grid grid-cols-6 gap-1 text-[11px] text-blue-800 bg-blue-100 rounded px-6 py-1">
                      <span>Piece</span><span>pcs</span><span>1</span><span>45.00</span><span>32.00</span><span className="text-green-700 font-bold">Base</span>
                    </div>
                    <div className="mt-0.5 grid grid-cols-6 gap-1 text-[11px] text-blue-800 bg-blue-100 rounded px-6 py-1">
                      <span>Box</span><span>box</span><span>50</span><span>2000.00</span><span>1500.00</span><span className="text-blue-700 font-bold">Sale</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-12 gap-1.5 px-2 py-1.5 bg-muted/50 rounded text-xs font-semibold text-muted-foreground">
                    <div className="col-span-3">Unit Name</div>
                    <div className="col-span-2">Short</div>
                    <div className="col-span-1 text-right">Conv.</div>
                    <div className="col-span-2 text-right">Sale ৳</div>
                    <div className="col-span-2 text-right">Cost ৳</div>
                    <div className="col-span-1 text-center">Base</div>
                    <div className="col-span-1 text-center">Sale</div>
                  </div>
                  <div className="mt-3">
                    <label className="block text-xs font-medium mb-1">Warranty (months)</label>
                    <input type="number" min="0" value={form.warranty_months} onChange={e => setForm({ ...form, warranty_months: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
                    <p className="text-[10px] text-muted-foreground mt-1">Optional warranty period for this product</p>
                  </div>

                  {units.map((unit, index) => (
                    <div key={unit.id} className="grid grid-cols-12 gap-1.5 p-2 bg-muted/30 rounded-lg items-center">
                      <div className="col-span-3">
                        <input
                          list={`unit-list-${index}`}
                          placeholder="Type or pick unit..."
                          value={unit.unit_name}
                          onChange={e => {
                            const val = e.target.value;
                            const match = unitTypes.find(u => u.unit_name.toLowerCase() === val.toLowerCase());
                            updateUnit(index, 'unit_name', val);
                            if (match && !unit.unit_short) updateUnit(index, 'unit_short', match.unit_short);
                          }}
                          className="w-full border border-border rounded px-2 py-1 text-sm"
                        />
                        <datalist id={`unit-list-${index}`}>
                          {unitTypes.map(u => <option key={u.id} value={u.unit_name}>{u.unit_short}</option>)}
                        </datalist>
                      </div>
                      <div className="col-span-2">
                        <input
                          placeholder="e.g. box"
                          value={unit.unit_short || ''}
                          onChange={e => updateUnit(index, 'unit_short', e.target.value)}
                          className="w-full border border-border rounded px-2 py-1 text-sm"
                        />
                      </div>
                      <div className="col-span-1">
                        <input type="number" min="1" placeholder="1" value={unit.conversion_factor} onChange={e => updateUnit(index, 'conversion_factor', parseFloat(e.target.value) || 1)} className="w-full border border-border rounded px-2 py-1 text-sm text-right" />
                      </div>
                      <div className="col-span-2">
                        <input type="number" min="0" step="0.01" placeholder="0.00" value={unit.price} onChange={e => updateUnit(index, 'price', parseFloat(e.target.value) || 0)} className="w-full border border-border rounded px-2 py-1 text-sm text-right" />
                      </div>
                      <div className="col-span-2">
                        <input type="number" min="0" step="0.01" placeholder="0.00" value={unit.cost_price} onChange={e => updateUnit(index, 'cost_price', parseFloat(e.target.value) || 0)} className="w-full border border-border rounded px-2 py-1 text-sm text-right" />
                      </div>
                      <div className="col-span-1 flex justify-center">
                        <button type="button" onClick={() => updateUnit(index, 'is_base_unit', !unit.is_base_unit)} className={`w-full px-1 py-1 rounded text-[10px] font-medium transition ${unit.is_base_unit ? 'bg-green-500 text-white' : 'bg-muted text-muted-foreground hover:bg-green-100 hover:text-green-700'}`} title="Base unit — stock tracked in this unit">B</button>
                      </div>
                      <div className="col-span-1 flex justify-center items-center gap-1">
                        <button type="button" onClick={() => updateUnit(index, 'is_sale_unit', !unit.is_sale_unit)} className={`w-6 px-1 py-1 rounded text-[10px] font-medium transition ${unit.is_sale_unit ? 'bg-blue-500 text-white' : 'bg-muted text-muted-foreground hover:bg-blue-100 hover:text-blue-700'}`} title="Default unit in sales/POS">S</button>
                        <button type="button" onClick={() => removeUnit(index)} className="text-red-400 hover:text-red-600"><Trash2 className="w-3.5 h-3.5" /></button>
                      </div>
                    </div>
                  ))}
                  <button type="button" onClick={addUnit} className="w-full py-2 border-2 border-dashed border-blue-300 rounded-lg text-blue-600 hover:bg-blue-50 transition text-sm font-medium">
                    <Plus className="w-4 h-4 inline mr-1" /> Add Unit
                  </button>
                </div>
              )}
            </div>
          )}

          {form.enable_colors && (
            <div className="border border-border rounded-lg overflow-hidden">
              <button type="button" onClick={() => setShowColors(!showColors)} className="w-full flex items-center justify-between px-4 py-3 bg-pink-50 text-pink-700 hover:bg-pink-100 transition">
                <span className="font-medium text-sm flex items-center gap-2"><Palette className="w-4 h-4" /> Color Variants ({colors.length})</span>
                {showColors ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>
              {showColors && (
                <div className="p-4 space-y-3 bg-white">
                  <div className="bg-pink-50 border border-pink-200 rounded-lg p-3 mb-3">
                    <p className="text-xs text-pink-800 flex items-start gap-2">
                      <Info className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>
                        <strong>Color Variants:</strong> Use this when the product comes in different colors (e.g., a faucet in Chrome, Matte Black, Gold). Each color can have its own image. Set one as <strong>Default</strong> to show it first in catalogs.
                      </span>
                    </p>
                  </div>
                  <div className="grid grid-cols-5 gap-2 px-2 py-1.5 bg-muted/50 rounded text-xs font-semibold text-muted-foreground">
                    <div className="col-span-1">Color</div>
                    <div className="col-span-2">Color Name</div>
                    <div className="col-span-1 text-center">Default</div>
                    <div className="col-span-1"></div>
                  </div>
                  {colors.map((color, index) => (
                    <div key={color.id} className="grid grid-cols-5 gap-2 p-2 bg-muted/30 rounded-lg items-center">
                      <div className="col-span-1">
                        <input type="color" value={color.hex_code || '#000000'} onChange={e => updateColor(index, 'hex_code', e.target.value)} className="w-8 h-8 rounded cursor-pointer border border-border" title="Pick color" />
                      </div>
                      <div className="col-span-2">
                        <input placeholder="e.g. Matte Black" value={color.name} onChange={e => updateColor(index, 'name', e.target.value)} className="w-full border border-border rounded px-2 py-1 text-sm" />
                      </div>
                      <div className="col-span-1 flex justify-center">
                        <button type="button" onClick={() => updateColor(index, 'is_default', !color.is_default)} className={`px-2 py-1 rounded text-[10px] font-medium transition ${color.is_default ? 'bg-pink-500 text-white' : 'bg-muted text-muted-foreground hover:bg-pink-100 hover:text-pink-700'}`} title="Set as default color">Default</button>
                      </div>
                      <div className="col-span-1 flex justify-end">
                        <button type="button" onClick={() => removeColor(index)} className="text-red-500 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>
                      </div>
                    </div>
                  ))}
                  <button type="button" onClick={addColor} className="w-full py-2 border-2 border-dashed border-pink-300 rounded-lg text-pink-600 hover:bg-pink-50 transition text-sm font-medium">
                    <Plus className="w-4 h-4 inline mr-1" /> Add Color Variant
                  </button>
                </div>
              )}
            </div>
          )}

          {form.enable_sizes && (
            <div className="border border-border rounded-lg overflow-hidden">
              <button type="button" onClick={() => setShowSizes(!showSizes)} className="w-full flex items-center justify-between px-4 py-3 bg-purple-50 text-purple-700 hover:bg-purple-100 transition">
                <span className="font-medium text-sm flex items-center gap-2"><Ruler className="w-4 h-4" /> Size Variants ({sizes.length})</span>
                {showSizes ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>
              {showSizes && (
                <div className="p-4 space-y-3 bg-white">
                  <div className="bg-purple-50 border border-purple-200 rounded-lg p-3 mb-3">
                    <p className="text-xs text-purple-800 flex items-start gap-2">
                      <Info className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>
                        <strong>Size Variants:</strong> Use for products sold in different sizes (e.g., towels in S/M/L, tiles in 12x12 or 24x24). The <strong>Dimensions</strong> field can store measurements like &quot;60x60 cm&quot;.
                      </span>
                    </p>
                  </div>
                  <div className="grid grid-cols-5 gap-2 px-2 py-1.5 bg-muted/50 rounded text-xs font-semibold text-muted-foreground">
                    <div className="col-span-2">Size Name</div>
                    <div className="col-span-1">Dimensions</div>
                    <div className="col-span-1 text-center">Default</div>
                    <div className="col-span-1"></div>
                  </div>
                  {sizes.map((size, index) => (
                    <div key={size.id} className="grid grid-cols-5 gap-2 p-2 bg-muted/30 rounded-lg items-center">
                      <div className="col-span-2">
                        <input placeholder="e.g. Small, 12x12" value={size.name} onChange={e => updateSize(index, 'name', e.target.value)} className="w-full border border-border rounded px-2 py-1 text-sm" />
                      </div>
                      <div className="col-span-1">
                        <input placeholder="e.g. 60x60" value={size.dimensions || ''} onChange={e => updateSize(index, 'dimensions', e.target.value)} className="w-full border border-border rounded px-2 py-1 text-sm" />
                      </div>
                      <div className="col-span-1 flex justify-center">
                        <button type="button" onClick={() => updateSize(index, 'is_default', !size.is_default)} className={`px-2 py-1 rounded text-[10px] font-medium transition ${size.is_default ? 'bg-purple-500 text-white' : 'bg-muted text-muted-foreground hover:bg-purple-100 hover:text-purple-700'}`} title="Set as default size">Default</button>
                      </div>
                      <div className="col-span-1 flex justify-end">
                        <button type="button" onClick={() => removeSize(index)} className="text-red-500 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>
                      </div>
                    </div>
                  ))}
                  <button type="button" onClick={addSize} className="w-full py-2 border-2 border-dashed border-purple-300 rounded-lg text-purple-600 hover:bg-purple-50 transition text-sm font-medium">
                    <Plus className="w-4 h-4 inline mr-1" /> Add Size Variant
                  </button>
                </div>
              )}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium mb-1">Min Stock Level</label>
            <input type="number" min="0" value={form.min_stock_level} onChange={e => setForm({ ...form, min_stock_level: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
          </div>

          <div className="border-t border-border pt-4 mt-4">
            <div className="flex items-center gap-2 mb-3">
              <Barcode className="w-4 h-4 text-muted-foreground" />
              <label className="text-xs font-medium">Barcode / QR Label Size</label>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => setForm({ ...form, barcode_label_size: '' })}
                className={`px-2 py-2 rounded-lg text-xs font-medium border transition ${form.barcode_label_size === '' ? 'border-blue-500 text-blue-600 bg-blue-50' : 'border-border text-muted-foreground hover:border-blue-300'}`}
              >
                Default
              </button>
              {(['xs', 'small', 'medium', 'large', 'xl', 'custom'] as LabelSize[]).map(s => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setForm({ ...form, barcode_label_size: s })}
                  className={`px-2 py-2 rounded-lg text-xs font-medium border transition ${form.barcode_label_size === s ? 'border-blue-500 text-blue-600 bg-blue-50' : 'border-border text-muted-foreground hover:border-blue-300'}`}
                >
                  {LABEL_SIZES[s].label}
                </button>
              ))}
            </div>
            {form.barcode_label_size === 'custom' && (
              <div className="grid grid-cols-2 gap-2 mt-2">
                <div>
                  <label className="block text-[10px] font-medium text-muted-foreground mb-1">Width (in)</label>
                  <input type="number" min="0.5" max="5" step="0.1" value={form.barcode_label_width} onChange={e => setForm({ ...form, barcode_label_width: e.target.value })} className="w-full border border-border rounded-lg px-2 py-1.5 text-sm text-center focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
                </div>
                <div>
                  <label className="block text-[10px] font-medium text-muted-foreground mb-1">Height (in)</label>
                  <input type="number" min="0.3" max="3" step="0.1" value={form.barcode_label_height} onChange={e => setForm({ ...form, barcode_label_height: e.target.value })} className="w-full border border-border rounded-lg px-2 py-1.5 text-sm text-center focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
                </div>
              </div>
            )}
            <p className="text-xs text-muted-foreground mt-2">Saved for this product — its barcode/QR label prints at this size instead of the print page&apos;s default.</p>
          </div>

          {!isEdit && form.track_inventory && (
            <div className="border-t border-border pt-4 mt-4">
              <div className="flex items-center gap-2 mb-3">
                <Warehouse className="w-4 h-4 text-muted-foreground" />
                <label className="text-xs font-medium">Initial Stock by Warehouse</label>
              </div>
              <div className="space-y-2">
                {warehouses.map(wh => (
                  <div key={wh.id} className="flex items-center justify-between p-2 bg-muted/30 rounded-lg">
                    <span className="text-sm">{wh.name} {wh.is_default && <span className="text-xs text-blue-600">(Default)</span>}</span>
                    <input
                      type="number"
                      min="0"
                      value={stockByWarehouse[wh.id] || '0'}
                      onChange={e => setStockByWarehouse({ ...stockByWarehouse, [wh.id]: e.target.value })}
                      className="w-24 border border-border rounded px-2 py-1 text-sm text-right focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                      placeholder="0"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {isEdit && form.track_inventory && (
            <div className="border-t border-border pt-4 mt-4">
              <div className="flex items-center gap-2 mb-3">
                <Warehouse className="w-4 h-4 text-muted-foreground" />
                <label className="text-xs font-medium">Stock Adjustment by Warehouse</label>
              </div>
              <div className="space-y-2">
                {warehouses.map(wh => {
                  // Use originalStockRef (fresh from DB) for current qty, not stale product prop
                  const currentQty = originalStockRef.current[wh.id] ?? 0;
                  const newQty = Number(stockByWarehouse[wh.id] || 0);
                  const diff = newQty - currentQty;
                  return (
                    <div key={wh.id} className="flex items-center justify-between p-2 bg-muted/30 rounded-lg">
                      <div className="flex-1">
                        <span className="text-sm">{wh.name}</span>
                        <span className="text-xs text-muted-foreground ml-2">(Current: {currentQty})</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min="0"
                          value={stockByWarehouse[wh.id] || '0'}
                          onChange={e => setStockByWarehouse({ ...stockByWarehouse, [wh.id]: e.target.value })}
                          className="w-24 border border-border rounded px-2 py-1 text-sm text-right focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                          placeholder="0"
                        />
                        {diff !== 0 && (
                          <span className={`text-xs font-medium px-2 py-0.5 rounded ${diff > 0 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                            {diff > 0 ? `+${diff}` : diff}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground mt-2">Changes will be recorded as stock adjustments.</p>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium mb-1">Description</label>
            <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} rows={2} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
          </div>
          <label className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50/50 px-3 py-2.5">
            <input type="checkbox" checked={form.track_inventory} onChange={e => setForm({ ...form, track_inventory: e.target.checked })} className="rounded" />
            <span className="text-sm">
              Track inventory
              <span className="block text-xs text-muted-foreground font-normal">
                Unchecked = quick-sell item: bought on demand, sold immediately, no stock records or FIFO batches. Cost is entered on each sale.
              </span>
            </span>
          </label>
          {isEdit && (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={form.is_active} onChange={e => setForm({ ...form, is_active: e.target.checked })} className="rounded" />
              <span className="text-sm">Active</span>
            </label>
          )}
          <div className="flex items-center justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Cancel</button>
            <button type="submit" disabled={saving} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-60">
              {saving ? 'Saving...' : isEdit ? 'Update Product' : 'Save Product'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
