'use client';

import { useEffect, useRef, useState } from 'react';
import { Search, X, Building2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/format';

export interface SupplierResult {
  id: string;
  name: string;
  code?: string;
  phone?: string;
  email?: string;
  city?: string;
  outstanding_balance?: number;
}

interface Props {
  onSelect: (supplier: SupplierResult) => void;
  selectedName?: string;
  placeholder?: string;
  className?: string;
}

export default function SupplierSearchInput({ onSelect, selectedName, placeholder = 'Search supplier by name or code...', className = '' }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SupplierResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
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
      const { data } = await supabase
        .from('suppliers')
        .select('id, name, code, phone, email, city, outstanding_balance')
        .or(`name.ilike.%${query.trim()}%,code.ilike.%${query.trim()}%,phone.ilike.%${query.trim()}%`)
        .order('name')
        .limit(20);

      setResults((data as SupplierResult[]) || []);
      setOpen(true);
      setLoading(false);
    }, 250);

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  function handleSelect(supplier: SupplierResult) {
    onSelect(supplier);
    setQuery('');
    setResults([]);
    setOpen(false);
  }

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onFocus={() => { if (results.length > 0) setOpen(true); }}
          placeholder={selectedName && !query ? selectedName : placeholder}
          className="w-full pl-8 pr-8 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 bg-white"
        />
        {query && (
          <button
            type="button"
            onClick={() => { setQuery(''); setResults([]); setOpen(false); inputRef.current?.focus(); }}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {open && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-border rounded-xl shadow-lg z-50 max-h-64 overflow-y-auto">
          {loading ? (
            <div className="px-4 py-3 text-sm text-muted-foreground">Searching...</div>
          ) : results.length === 0 ? (
            <div className="px-4 py-3 text-sm text-muted-foreground">No suppliers found for &quot;{query}&quot;</div>
          ) : results.map(s => (
            <button
              key={s.id}
              type="button"
              onClick={() => handleSelect(s)}
              className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-blue-50 transition text-left border-b border-border/50 last:border-0"
            >
              <div className="w-8 h-8 rounded-lg bg-orange-50 flex items-center justify-center shrink-0">
                <Building2 className="w-4 h-4 text-orange-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{s.name}</p>
                <p className="text-xs text-muted-foreground">
                  {s.code || ''}{s.code && s.phone ? ' · ' : ''}{s.phone || ''}
                </p>
              </div>
              {s.outstanding_balance !== undefined && Number(s.outstanding_balance) > 0 && (
                <span className="text-[10px] font-medium text-amber-600 shrink-0">
                  Payable: {formatCurrency(Number(s.outstanding_balance))}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
