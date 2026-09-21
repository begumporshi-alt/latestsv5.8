'use client';

import { useEffect, useRef, useState } from 'react';
import { Search, Check, ChevronDown, Package } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/format';
import { getDefaultSaleUnit } from '@/lib/unit-utils';
import type { Product } from '@/lib/types';

/** Compact POS-style searchable filter dropdown (brand / category). */
function GalleryFilter({ allLabel, searchLabel, options, value, onChange }: {
  allLabel: string;
  searchLabel: string;
  options: { id: string; name: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const selected = options.find(o => o.id === value);
  const list = q.trim() ? options.filter(o => o.name.toLowerCase().includes(q.trim().toLowerCase())) : options;

  function pick(id: string) {
    onChange(id);
    setOpen(false);
    setQ('');
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between gap-1 border border-border rounded-lg px-2.5 py-1.5 text-xs hover:border-slate-300 transition"
      >
        <span className={`truncate ${selected ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>{selected ? selected.name : allLabel}</span>
        <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      </button>
      {open && (
        <div className="absolute left-0 right-0 mt-1 bg-white border border-border rounded-lg shadow-lg z-20 p-1.5">
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder={searchLabel}
            className="w-full border border-border rounded-md px-2 py-1 text-xs mb-1 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          />
          <button
            type="button"
            onClick={() => pick('')}
            className="w-full flex items-center justify-between px-2 py-1.5 rounded-md text-xs hover:bg-muted transition"
          >
            <span className="text-muted-foreground">{allLabel}</span>
            {!value && <Check className="w-3.5 h-3.5 text-blue-600" />}
          </button>
          {list.map(o => (
            <button
              key={o.id}
              type="button"
              onClick={() => pick(o.id)}
              className="w-full flex items-center justify-between px-2 py-1.5 rounded-md text-xs hover:bg-muted transition"
            >
              <span className="truncate">{o.name}</span>
              {value === o.id && <Check className="w-3.5 h-3.5 text-blue-600 shrink-0" />}
            </button>
          ))}
          {list.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">No matches.</p>}
        </div>
      )}
    </div>
  );
}

/**
 * Shared product gallery body used by:
 *  - the quotation Create/Edit forms (inline right column, side-by-side
 *    with the line items so additions are visible while browsing)
 *  - the QuickActionDrawer "Product Catalog" slide-over
 *
 * Clicking a product calls onPick. The quotation forms add the product to
 * their line items; the drawer dispatches a global 'quotation:add-product'
 * event that any open quotation form listens for.
 */
export function ProductGalleryBody({ products, onPick }: {
  products: Product[];
  onPick: (product: Product) => void;
}) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [brand, setBrand] = useState('');
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [brands, setBrands] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    supabase.from('categories').select('id, name').eq('is_active', true).order('name')
      .then(({ data }) => setCategories((data || []) as { id: string; name: string }[]));
    supabase.from('brands').select('id, name').eq('is_active', true).order('name')
      .then(({ data }) => setBrands((data || []) as { id: string; name: string }[]));
  }, []);

  // Same price rule as the quotation forms' addProductToItems so the card
  // shows what will land on the quotation line.
  function displayPrice(p: Product) {
    const units = (p.units || []).filter((u: any) => u.is_active);
    if (p.enable_multi_unit && units.length > 0) {
      const def = getDefaultSaleUnit(p);
      return def ? def.price : p.sale_price;
    }
    return p.sale_price;
  }

  function totalStock(p: Product) {
    return (p.inventory_items || []).reduce((s, i) => s + Number(i.quantity_on_hand || 0), 0);
  }

  const filtered = products.filter(p => {
    if (category && p.category_id !== category) return false;
    if (brand && (p as any).brand_id !== brand) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!p.name.toLowerCase().includes(q) && !(p.sku || '').toLowerCase().includes(q) && !(p.barcode || '').toLowerCase().includes(q)) return false;
    }
    return true;
  });

  return (
    <div className="flex flex-col max-h-full">
      <div className="px-4 py-3 border-b border-border">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold">Product Gallery</h3>
          <span className="text-[10px] text-muted-foreground">{filtered.length} product{filtered.length !== 1 ? 's' : ''}</span>
        </div>
        <p className="text-[10px] text-muted-foreground mt-0.5">Click a product to add it to the quotation</p>
        <div className="mt-2.5 space-y-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search name, SKU or barcode..."
              className="w-full border border-border rounded-lg pl-8 pr-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <GalleryFilter
              allLabel="All Brands"
              searchLabel="Search brands..."
              options={brands}
              value={brand}
              onChange={setBrand}
            />
            <GalleryFilter
              allLabel="All Categories"
              searchLabel="Search categories..."
              options={categories}
              value={category}
              onChange={setCategory}
            />
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {filtered.length === 0 ? (
          <p className="text-center text-xs text-muted-foreground py-8">No products match your search.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {filtered.map((p) => {
              const stock = totalStock(p);
              const low = Number(p.min_stock_level) > 0 && stock <= Number(p.min_stock_level);
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onPick(p)}
                  className="text-left border border-border rounded-xl p-2.5 hover:border-blue-300 hover:shadow-md transition"
                >
                  <div className="flex items-start gap-2">
                    <Package className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium truncate" title={p.name}>{p.name}</p>
                      <p className="text-[10px] text-muted-foreground truncate">{p.sku || ''}</p>
                    </div>
                  </div>
                  <div className="flex items-center justify-between mt-1.5 gap-1">
                    <span className="text-xs font-semibold text-blue-600">{formatCurrency(displayPrice(p))}</span>
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full whitespace-nowrap ${stock === 0 ? 'bg-red-100 text-red-700' : low ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}`}>
                      {stock === 0 ? 'Out of stock' : low ? `Low: ${stock}` : `Stock: ${stock}`}
                    </span>
                  </div>
                  {p.warranty_months > 0 && <p className="text-[10px] text-muted-foreground mt-1">Warranty: {p.warranty_months} mo</p>}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
