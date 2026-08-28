'use client';

import { useState, useEffect, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { Search, Package, X, Check } from 'lucide-react';

interface ProductFilterDropdownProps {
  value: string;
  onChange: (productId: string) => void;
  placeholder?: string;
}

export default function ProductFilterDropdown({ value, onChange, placeholder = 'All Products' }: ProductFilterDropdownProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [products, setProducts] = useState<{ id: string; name: string; sku: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const selectedProduct = products.find(p => p.id === value);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    supabase
      .from('products')
      .select('id, name, sku')
      .eq('is_active', true)
      .or(`name.ilike.%${search}%,sku.ilike.%${search}%`)
      .order('name')
      .limit(50)
      .then(({ data }) => {
        setProducts(data || []);
        setLoading(false);
      });
  }, [search, open]);

  function handleSelect(productId: string) {
    onChange(productId);
    setOpen(false);
    setSearch('');
  }

  function handleClear(e: React.MouseEvent) {
    e.stopPropagation();
    onChange('');
  }

  return (
    <div ref={dropdownRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 border border-border rounded-lg px-3 py-2 text-sm bg-white hover:border-blue-300 focus:outline-none focus:border-blue-500 transition"
      >
        <Package className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <span className={`flex-1 truncate text-left ${selectedProduct ? 'text-foreground' : 'text-muted-foreground'}`}>
          {selectedProduct ? selectedProduct.name : placeholder}
        </span>
        {selectedProduct ? (
          <button type="button" onClick={handleClear} className="text-muted-foreground hover:text-red-500">
            <X className="w-3.5 h-3.5" />
          </button>
        ) : null}
      </button>

      {open && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-border rounded-lg shadow-lg z-50 overflow-hidden">
          <div className="p-2 border-b border-border">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search products..."
                className="w-full pl-8 pr-3 py-1.5 text-sm border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
                autoFocus
              />
            </div>
          </div>
          <div className="max-h-48 overflow-y-auto">
            <button
              onClick={() => handleSelect('')}
              className={`w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-blue-50 transition ${!value ? 'bg-blue-50 text-blue-600' : 'text-muted-foreground'}`}
            >
              <Package className="w-3.5 h-3.5" />
              <span>{placeholder}</span>
              {!value && <Check className="w-3.5 h-3.5 ml-auto" />}
            </button>
            {loading ? (
              <div className="px-3 py-4 text-center text-sm text-muted-foreground">Loading...</div>
            ) : products.length === 0 ? (
              <div className="px-3 py-4 text-center text-sm text-muted-foreground">No products found</div>
            ) : (
              products.map(p => (
                <button
                  key={p.id}
                  onClick={() => handleSelect(p.id)}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-blue-50 transition ${value === p.id ? 'bg-blue-50 text-blue-600' : 'text-foreground'}`}
                >
                  <Package className="w-3.5 h-3.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="truncate">{p.name}</p>
                    {p.sku && <p className="text-[10px] text-muted-foreground truncate">{p.sku}</p>}
                  </div>
                  {value === p.id && <Check className="w-3.5 h-3.5 ml-auto" />}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
