'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Search, X, User, AlertCircle } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { tokenizeSearch, applyIlikeTokens, rankRows } from '@/lib/search';
import HighlightLabel from '@/components/ui/HighlightLabel';

/** Columns the customer search matches: name, code and phone. */
const CUSTOMER_SEARCH_COLUMNS = ['name', 'code', 'phone'];

export interface CustomerResult {
  id: string;
  name: string;
  code?: string;
  phone?: string;
  address?: string;
  outstanding_balance?: number;
}

interface Props {
  onSelect: (customer: CustomerResult) => void;
  selectedName?: string;
  placeholder?: string;
  className?: string;
}

export default function CustomerSearchInput({ onSelect, selectedName, placeholder = 'Search customer by name or code...', className = '' }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CustomerResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic sequence — drops out-of-order responses (see the
  // search-feature-robustness skill).
  const searchSeqRef = useRef(0);
  const uid = useId();
  const listboxId = `${uid}-listbox`;

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
    const tokens = tokenizeSearch(query);
    if (!query.trim() || tokens.length === 0) {
      // A term made only of filter grammar (e.g. ",,,") would sanitise to zero
      // tokens — show nothing rather than an unfiltered 20-row dump.
      setResults([]); setOpen(false); setLoading(false); setSearchError(false); setActiveIndex(-1); return;
    }

    debounceRef.current = setTimeout(async () => {
      const seq = ++searchSeqRef.current;
      setLoading(true);
      const { data, error } = await applyIlikeTokens(
        supabase
          .from('customers')
          .select('id, name, code, phone, address, outstanding_balance')
          .order('name'),
        CUSTOMER_SEARCH_COLUMNS,
        tokens,
      ).limit(200);

      if (seq !== searchSeqRef.current) return;   // superseded by a newer keystroke
      if (error) {
        setResults([]); setSearchError(true); setActiveIndex(-1);
      } else {
        // Rank the full match set first — the DB limit only bounds transport,
        // otherwise alphabetically-earlier rows would crowd out the best match.
        const ranked = rankRows((data as CustomerResult[]) || [], c => [c.name, c.code || '', c.phone || ''], tokens).slice(0, 20);
        setResults(ranked);
        setSearchError(false);
        setActiveIndex(ranked.length > 0 ? 0 : -1);
      }
      setOpen(true);
      setLoading(false);
    }, 250);

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  useEffect(() => {
    if (activeIndex < 0) return;
    document.getElementById(`${listboxId}-option-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, listboxId]);

  function handleSelect(customer: CustomerResult) {
    onSelect(customer);
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

  return (
    <div ref={containerRef} className={`relative ${className}`}>
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
          placeholder={selectedName && !query ? selectedName : placeholder}
          className="w-full pl-8 pr-8 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 bg-white"
        />
        {query && (
          <button
            type="button"
            onClick={() => { setQuery(''); setResults([]); setOpen(false); setSearchError(false); setActiveIndex(-1); inputRef.current?.focus(); }}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {open && (
        <div role="listbox" id={listboxId} className="absolute top-full left-0 right-0 mt-1 bg-white border border-border rounded-xl shadow-lg z-50 max-h-64 overflow-y-auto">
          {loading ? (
            <div className="px-4 py-3 text-sm text-muted-foreground">Searching...</div>
          ) : searchError ? (
            <div className="px-4 py-3 text-sm text-red-600 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              Search failed — check your connection and try again
            </div>
          ) : results.length === 0 ? (
            <div className="px-4 py-3 text-sm text-muted-foreground">No customers found for &quot;{query}&quot;</div>
          ) : results.map((c, i) => (
            <button
              key={c.id}
              type="button"
              role="option"
              id={`${listboxId}-option-${i}`}
              aria-selected={i === activeIndex}
              onClick={() => handleSelect(c)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 transition text-left border-b border-border/50 last:border-0 ${i === activeIndex ? 'bg-blue-50' : 'hover:bg-blue-50'}`}
            >
              <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
                <User className="w-4 h-4 text-blue-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate"><HighlightLabel text={c.name} query={query} /></p>
                <p className="text-xs text-muted-foreground">
                  {c.code || ''}{c.code && c.phone ? ' · ' : ''}{c.phone || ''}
                </p>
              </div>
              {c.outstanding_balance !== undefined && Number(c.outstanding_balance) > 0 && (
                <span className="text-[10px] font-medium text-amber-600 shrink-0">
                  Due: {Number(c.outstanding_balance).toLocaleString('en-BD', { minimumFractionDigits: 0 })}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
