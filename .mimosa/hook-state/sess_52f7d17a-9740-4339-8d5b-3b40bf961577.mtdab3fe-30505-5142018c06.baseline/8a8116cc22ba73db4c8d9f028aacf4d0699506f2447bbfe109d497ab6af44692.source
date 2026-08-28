'use client';

import { useEffect, useRef, useState } from 'react';
import { Search, X, Filter } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/format';
import type { ProductUnit } from '@/lib/types';

interface ProductResult {
  id: string;
  name: string;
  sku: string;
  sale_price: number;
  cost_price: number;
  unit?: string;
  base_unit?: string;
  enable_multi_unit?: boolean;
  image_url?: string;
  inventory_items?: { quantity_on_hand: number }[];
  units?: ProductUnit[];
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
    if (!query.trim()) { setResults([]); setOpen(false); return; }

    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      let dbQuery = supabase
        .from('products')
        .select(`id, name, sku, sale_price, cost_price, unit, base_unit, enable_multi_unit, image_url,
          inventory_items(quantity_on_hand),
          units:product_units(id, product_id, unit_name, unit_short, conversion_factor, is_base_unit, is_sale_unit, price, cost_price, is_active, sort_order)`)
        .eq('is_active', true)
        .or(`name.ilike.%${query.trim()}%,sku.ilike.%${query.trim()}%`)
        .order('name')
        .limit(20);

      if (selectedBrand) dbQuery = dbQuery.eq('brand_id', selectedBrand);
      if (selectedCategory) dbQuery = dbQuery.eq('category_id', selectedCategory);

      const { data } = await dbQuery;
      setResults((data as ProductResult[]) || []);
      setOpen(true);
      setLoading(false);
    }, 250);

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, selectedBrand, selectedCategory]);

  function handleSelect(product: ProductResult) {
    onSelect(product);
    setQuery('');
    setResults([]);
    setOpen(false);
  }

  const stock = (p: ProductResult) =>
    p.inventory_items?.reduce((s, i) => s + Number(i.quantity_on_hand), 0) ?? null;

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
          <span className="max-w-[100px] truncate">{selected ? selectedName : `All ${label}s`}</span>
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
            value={query}
            onChange={e => setQuery(e.target.value)}
            onFocus={() => { if (results.length > 0) setOpen(true); }}
            placeholder={placeholder}
            className="w-full pl-8 pr-8 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 bg-white"
          />
          {query && (
            <button
              type="button"
              onClick={() => { setQuery(''); setResults([]); setOpen(false); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {open && (
          <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-border rounded-xl shadow-lg z-50 max-h-72 overflow-y-auto">
            {loading ? (
              <div className="px-4 py-3 text-sm text-muted-foreground">Searching...</div>
            ) : results.length === 0 ? (
              <div className="px-4 py-3 text-sm text-muted-foreground">No products found for &quot;{query}&quot;</div>
            ) : results.map(p => {
              const s = showStock ? stock(p) : null;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => handleSelect(p)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-blue-50 transition text-left border-b border-border/50 last:border-0"
                >
                  <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center overflow-hidden shrink-0">
                    {p.image_url
                      ? <img src={p.image_url} alt="" className="w-full h-full object-cover" />
                      : <span className="text-xs text-muted-foreground">?</span>
                    }
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{p.name}</p>
                    <p className="text-xs text-muted-foreground">{p.sku}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-semibold text-blue-600">{formatCurrency(p.sale_price)}</p>
                    {showStock && s !== null && (
                      <p className={`text-[10px] font-medium ${s > 0 ? 'text-green-600' : 'text-red-500'}`}>
                        {s > 0 ? `${s} in stock` : 'Out of stock'}
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
