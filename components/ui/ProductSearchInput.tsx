'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Search, X, Filter, AlertCircle } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/format';
import { tokenizeSearch, applyIlikeTokens, rankRows } from '@/lib/search';
import HighlightLabel from '@/components/ui/HighlightLabel';
import type { ProductUnit } from '@/lib/types';

/** Columns the product search matches: name, SKU and barcode. */
const PRODUCT_SEARCH_COLUMNS = ['name', 'sku', 'barcode'];

interface ProductResult {
  id: string;
  name: string;
  sku: string;
  barcode?: string;
  sale_price: number;
  cost_price: number;
  unit?: string;
  base_unit?: string;
  enable_multi_unit?: boolean;
  image_url?: string;
  inventory_items?: { quantity_on_hand: number; warehouse?: { name: string } | null }[];
  units?: ProductUnit[];
  warranty_months: number;
  has_expiring_batches?: boolean;
  days_to_expiry?: number;
}

interface FilterOption {
  id: string;
  name: string;
}

interface Props {
  onSelect: (product: ProductResult) => void;
  placeholder?: string;
  showStock?: boolean;
  className?: string;
}

export default function ProductSearchInput({ onSelect, placeholder = 'Search product by name or SKU...', showStock = false, className = '' }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ProductResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const [brands, setBrands] = useState<FilterOption[]>([]);
  const [selectedBrand, setSelectedBrand] = useState('');
  const [brandDropdownOpen, setBrandDropdownOpen] = useState(false);
  const [brandSearch, setBrandSearch] = useState('');

  const [categories, setCategories] = useState<FilterOption[]>([]);
  const [selectedCategory, setSelectedCategory] = useState('');
  const [categoryDropdownOpen, setCategoryDropdownOpen] = useState(false);
  const [categorySearch, setCategorySearch] = useState('');

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic sequence — drops out-of-order responses (see the
  // search-feature-robustness skill).
  const searchSeqRef = useRef(0);
  const uid = useId();
  const listboxId = `${uid}-listbox`;

  useEffect(() => {
    supabase.from('brands').select('id, name').eq('is_active', true).order('name')
      .then(({ data }) => setBrands(data || []));
    supabase.from('categories').select('id, name').eq('is_active', true).order('name')
      .then(({ data }) => setCategories(data || []));
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setBrandDropdownOpen(false);
        setCategoryDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const tokens = tokenizeSearch(query);
    // No usable tokens (empty query, or a term made only of filter grammar)
    // → show nothing rather than an unfiltered 20-row dump.
    if (tokens.length === 0) { setResults([]); setOpen(false); setLoading(false); setSearchError(false); setActiveIndex(-1); return; }

    debounceRef.current = setTimeout(async () => {
      const seq = ++searchSeqRef.current;
      setLoading(true);
      const dbQuery = applyIlikeTokens(
        supabase
          .from('products')
          .select(`id, name, sku, barcode, sale_price, cost_price, unit, base_unit, enable_multi_unit, image_url, warranty_months,
          inventory_items(quantity_on_hand, warehouse:warehouses(name)),
          units:product_units(id, product_id, unit_name, unit_short, conversion_factor, is_base_unit, is_sale_unit, price, cost_price, is_active, sort_order)`)
          .eq('is_active', true)
          .order('name'),
        PRODUCT_SEARCH_COLUMNS,
        tokens,
      );
      let q = dbQuery;
      if (selectedBrand) q = q.eq('brand_id', selectedBrand);
      if (selectedCategory) q = q.eq('category_id', selectedCategory);

      const { data, error } = await q.limit(100);
      if (seq !== searchSeqRef.current) return;   // superseded by a newer keystroke
      if (error) {
        setResults([]); setSearchError(true); setActiveIndex(-1);
      } else {
        // Rank the full match set first — the DB limit only bounds transport,
        // otherwise alphabetically-earlier rows would crowd out the best match.
        const ranked = rankRows((data as unknown as ProductResult[]) || [], p => [p.name, p.sku || '', p.barcode || ''], tokens).slice(0, 20);
        setResults(ranked);
        setSearchError(false);
        setActiveIndex(ranked.length > 0 ? 0 : -1);
      }
      setOpen(true);
      setLoading(false);
    }, 250);

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, selectedBrand, selectedCategory]);

  useEffect(() => {
    if (activeIndex < 0) return;
    document.getElementById(`${listboxId}-option-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, listboxId]);

  function handleSelect(product: ProductResult) {
    onSelect(product);
    setQuery('');
    setResults([]);
    setOpen(false);
    setSearchError(false);
    setActiveIndex(-1);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      // Prevent the enclosing form from submitting while picking a result.
      e.preventDefault();
      handleSelect(results[activeIndex] || results[0]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  }

  const stock = (p: ProductResult) =>
    p.inventory_items?.reduce((s, i) => s + Number(i.quantity_on_hand), 0) ?? null;

  // Warehouses carrying an IOU (negative counter) even when the product's
  // all-warehouse total is fine — receiving into that warehouse heals the IOU.
  const oversoldWarehouses = (p: ProductResult) =>
    (p.inventory_items || [])
      .filter(i => Number(i.quantity_on_hand) < 0)
      .map(i => ({ name: i.warehouse?.name || 'Unknown', qty: Number(i.quantity_on_hand) }));

  const selectedBrandName = brands.find(b => b.id === selectedBrand)?.name;
  const filteredBrands = brandSearch.trim()
    ? brands.filter(b => b.name.toLowerCase().includes(brandSearch.trim().toLowerCase()))
    : brands;

  const selectedCategoryName = categories.find(c => c.id === selectedCategory)?.name;
  const filteredCategories = categorySearch.trim()
    ? categories.filter(c => c.name.toLowerCase().includes(categorySearch.trim().toLowerCase()))
    : categories;

  function FilterDropdown({ label, selected, selectedName, dropdownOpen, setDropdownOpen, search, setSearch, options, onSelect: onSelectFilter, onClear }: {
    label: string;
    selected: string;
    selectedName?: string;
    dropdownOpen: boolean;
    setDropdownOpen: (v: boolean) => void;
    search: string;
    setSearch: (v: string) => void;
    options: FilterOption[];
    onSelect: (id: string) => void;
    onClear: () => void;
  }) {
    return (
      <div className="relative shrink-0">
        <button
          type="button"
          onClick={() => setDropdownOpen(!dropdownOpen)}
          className={`flex items-center gap-1.5 border rounded-lg px-3 py-2 text-sm bg-white hover:border-blue-300 focus:outline-none focus:border-blue-500 transition whitespace-nowrap ${
            selected ? 'border-blue-500 text-blue-600' : 'border-border text-muted-foreground'
          }`}
          title={`Filter by ${label}`}
        >
          <Filter className="w-3.5 h-3.5" />
          <span className="max-w-[160px] break-words line-clamp-2 whitespace-normal text-left">{selected ? selectedName : `All ${label}s`}</span>
          {selected && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); onClear(); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onClear(); } }}
              className="ml-0.5 hover:text-red-500"
            >
              <X className="w-3 h-3" />
            </span>
          )}
        </button>

        {dropdownOpen && (
          <div className="absolute top-full left-0 mt-1 bg-white border border-border rounded-lg shadow-lg z-50 w-52 overflow-hidden">
            <div className="p-2 border-b border-border">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <input
                  type="text"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder={`Search ${label.toLowerCase()}s...`}
                  className="w-full pl-8 pr-3 py-1.5 text-sm border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
                  autoFocus
                />
              </div>
            </div>
            <div className="max-h-48 overflow-y-auto">
              <button
                type="button"
                onClick={() => { onClear(); setDropdownOpen(false); }}
                className={`w-full flex items-center px-3 py-2 text-sm hover:bg-blue-50 transition text-left ${!selected ? 'bg-blue-50 text-blue-600' : 'text-muted-foreground'}`}
              >
                All {label}s
              </button>
              {options.map(opt => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => { onSelectFilter(opt.id); setDropdownOpen(false); setSearch(''); }}
                  className={`w-full flex items-center px-3 py-2 text-sm hover:bg-blue-50 transition text-left ${selected === opt.id ? 'bg-blue-50 text-blue-600' : 'text-foreground'}`}
                >
                  {opt.name}
                </button>
              ))}
              {options.length === 0 && (
                <div className="px-3 py-3 text-center text-xs text-muted-foreground">No {label.toLowerCase()}s found</div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div ref={containerRef} className={`relative flex gap-2 flex-wrap ${className}`}>
      <FilterDropdown
        label="Category"
        selected={selectedCategory}
        selectedName={selectedCategoryName}
        dropdownOpen={categoryDropdownOpen}
        setDropdownOpen={setCategoryDropdownOpen}
        search={categorySearch}
        setSearch={setCategorySearch}
        options={filteredCategories}
        onSelect={setSelectedCategory}
        onClear={() => { setSelectedCategory(''); setCategorySearch(''); }}
      />
      <FilterDropdown
        label="Brand"
        selected={selectedBrand}
        selectedName={selectedBrandName}
        dropdownOpen={brandDropdownOpen}
        setDropdownOpen={setBrandDropdownOpen}
        search={brandSearch}
        setSearch={setBrandSearch}
        options={filteredBrands}
        onSelect={setSelectedBrand}
        onClear={() => { setSelectedBrand(''); setBrandSearch(''); }}
      />

      {/* Search input */}
      <div className="relative flex-1 min-w-[200px]">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-activedescendant={open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
            aria-autocomplete="list"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => { if (results.length > 0) setOpen(true); }}
            placeholder={placeholder}
            className="w-full pl-8 pr-8 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 bg-white"
          />
          {query && (
            <button
              type="button"
              onClick={() => { setQuery(''); setResults([]); setOpen(false); setSearchError(false); setActiveIndex(-1); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {open && (
          <div role="listbox" id={listboxId} className="absolute top-full left-0 right-0 mt-1 bg-white border border-border rounded-xl shadow-lg z-50 max-h-72 overflow-y-auto">
            {loading ? (
              <div className="px-4 py-3 text-sm text-muted-foreground">Searching...</div>
            ) : searchError ? (
              <div className="px-4 py-3 text-sm text-red-600 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                Search failed — check your connection and try again
              </div>
            ) : results.length === 0 ? (
              <div className="px-4 py-3 text-sm text-muted-foreground">No products found for &quot;{query}&quot;</div>
            ) : results.map((p, i) => {
              const s = showStock ? stock(p) : null;
              const oversoldWhs = showStock ? oversoldWarehouses(p) : [];
              return (
                <button
                  key={p.id}
                  type="button"
                  role="option"
                  id={`${listboxId}-option-${i}`}
                  aria-selected={i === activeIndex}
                  onClick={() => handleSelect(p)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 transition text-left border-b border-border/50 last:border-0 ${i === activeIndex ? 'bg-blue-50' : 'hover:bg-blue-50'}`}
                >
                  <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center overflow-hidden shrink-0">
                    {p.image_url
                      ? <img src={p.image_url} alt="" className="w-full h-full object-cover" />
                      : <span className="text-xs text-muted-foreground">?</span>
                    }
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground leading-snug break-words"><HighlightLabel text={p.name} query={query} /></p>
                    <p className="text-xs text-muted-foreground"><HighlightLabel text={p.sku} query={query} /></p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-semibold text-blue-600">{formatCurrency(p.sale_price)}</p>
                    {showStock && s !== null && (
                      s < 0 ? (
                        <>
                          <p className="text-[10px] font-medium text-red-500">Oversold — IOU of {Math.abs(s)}</p>
                          <span className="inline-flex items-center whitespace-nowrap px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-100 text-red-700 border border-red-200">Oversold (IOU)</span>
                        </>
                      ) : (
                        <>
                          <p className={`text-[10px] font-medium ${s > 0 ? 'text-green-600' : 'text-red-500'}`}>
                            {s > 0 ? `${s} in stock` : 'Out of stock'}
                          </p>
                          {oversoldWhs.length > 0 && (
                            <div className="flex flex-wrap justify-end gap-1 mt-0.5">
                              {oversoldWhs.map(w => (
                                <span key={w.name} className="inline-flex items-center whitespace-nowrap px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-100 text-red-700 border border-red-200" title="Oversold (IOU) in this warehouse">
                                  {w.name} {w.qty}
                                </span>
                              ))}
                            </div>
                          )}
                        </>
                      )
                    )}
                    {(p.warranty_months ?? 0) > 0 && (
                      <p className="text-[10px] font-medium text-purple-600">{p.warranty_months}mo warranty</p>
                    )}
                    {p.days_to_expiry !== undefined && (
                      <p className={`text-[10px] font-medium ${p.days_to_expiry < 0 ? 'text-red-600' : p.days_to_expiry <= 30 ? 'text-orange-600' : 'text-blue-600'}`}>
                        {p.days_to_expiry < 0 ? 'EXPIRED' : p.days_to_expiry <= 30 ? `${p.days_to_expiry} days left` : ''}
                      </p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
