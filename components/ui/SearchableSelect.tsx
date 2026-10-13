'use client';

import { useEffect, useRef, useState } from 'react';
import { Search, ChevronDown } from 'lucide-react';

export interface SearchableSelectOption { value: string; label: string; group?: string }
interface SearchableSelectProps {
  value: string;
  onChange: (v: string) => void;
  options: SearchableSelectOption[];
  placeholder?: string;
  className?: string;
}
export default function SearchableSelect({ value, onChange, options, placeholder = 'Select…', className = '' }: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filtered = search.trim()
    ? options.filter(o => o.label.toLowerCase().includes(search.trim().toLowerCase()))
    : options;

  const selected = options.find(o => o.value === value);

  // Group options if any have a `group` field
  const hasGroups = options.some(o => o.group);
  const groups: string[] = hasGroups
    ? Array.from(new Set(options.map(o => o.group ?? ''))).filter(Boolean)
    : [];

  function renderList() {
    if (!hasGroups || search.trim()) {
      return filtered.map(o => (
        <button key={o.value} type="button" onMouseDown={() => { onChange(o.value); setSearch(''); setOpen(false); }}
          className={`w-full text-left px-3 py-2 text-sm hover:bg-blue-50 transition-colors ${value === o.value ? 'bg-blue-50 text-blue-600 font-medium' : 'text-foreground'}`}>
          {o.label}
        </button>
      ));
    }
    return (
      <>
        {/* Ungrouped first */}
        {filtered.filter(o => !o.group).map(o => (
          <button key={o.value} type="button" onMouseDown={() => { onChange(o.value); setSearch(''); setOpen(false); }}
            className={`w-full text-left px-3 py-2 text-sm hover:bg-blue-50 transition-colors ${value === o.value ? 'bg-blue-50 text-blue-600 font-medium' : 'text-foreground'}`}>
            {o.label}
          </button>
        ))}
        {groups.map(g => {
          const groupItems = filtered.filter(o => o.group === g);
          if (!groupItems.length) return null;
          return (
            <div key={g}>
              <div className="px-3 py-1 text-[10px] font-bold text-muted-foreground uppercase tracking-wide bg-muted/30 border-y border-border/50">{g}</div>
              {groupItems.map(o => (
                <button key={o.value} type="button" onMouseDown={() => { onChange(o.value); setSearch(''); setOpen(false); }}
                  className={`w-full text-left px-4 py-2 text-sm hover:bg-blue-50 transition-colors ${value === o.value ? 'bg-blue-50 text-blue-600 font-medium' : 'text-foreground'}`}>
                  {o.label}
                </button>
              ))}
            </div>
          );
        })}
      </>
    );
  }

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button type="button" onClick={() => { setOpen(o => !o); setSearch(''); }}
        className="w-full flex items-center justify-between border border-border rounded-lg px-3 py-2 text-sm bg-white hover:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition">
        <span className={selected ? 'text-foreground' : 'text-muted-foreground'}>{selected ? selected.label : placeholder}</span>
        <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute z-[200] top-full left-0 right-0 mt-1 bg-white border border-border rounded-xl shadow-xl overflow-hidden">
          <div className="p-2 border-b border-border bg-muted/20">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <input autoFocus type="text" value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search…"
                className="w-full pl-8 pr-3 py-1.5 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 bg-white" />
            </div>
          </div>
          <div className="max-h-52 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-sm text-center text-muted-foreground">No results</div>
            ) : renderList()}
          </div>
        </div>
      )}
    </div>
  );
}
