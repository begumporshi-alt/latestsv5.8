'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDownWideNarrow, ArrowRight, Boxes, Search, X } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  buildProductBreakdown,
  type BreakdownDimension,
  type BreakdownProduct,
  type BreakdownSelection,
  type WarehouseStock,
} from '@/lib/product-breakdown';

interface Props {
  children: ReactNode;
  products: BreakdownProduct[];
  stock: WarehouseStock;
  warehouses: { id: string; name: string }[];
  categories: { id: string; name: string }[];
  brands: { id: string; name: string }[];
  stale: boolean;
  onSelect: (selection: BreakdownSelection) => void;
}

const dimensions: { key: BreakdownDimension; label: string }[] = [
  { key: 'category', label: 'Category' },
  { key: 'brand', label: 'Brand' },
  { key: 'status', label: 'Status' },
  { key: 'warehouse', label: 'Warehouse' },
];

export default function ProductBreakdown(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{props.children}</DialogTrigger>
      <DialogContent className="flex max-h-[90dvh] w-[calc(100%-1.5rem)] max-w-2xl flex-col gap-0 overflow-hidden rounded-xl p-0 motion-reduce:animate-none [@media(max-height:600px)]:block [@media(max-height:600px)]:overflow-y-auto [&>button]:h-8 [&>button]:w-8 [&>button]:flex [&>button]:items-center [&>button]:justify-center">
        {open && <BreakdownContent {...props} onSelect={selection => { props.onSelect(selection); setOpen(false); }} />}
      </DialogContent>
    </Dialog>
  );
}

function BreakdownContent({ products, stock, warehouses, categories, brands, stale, onSelect }: Props) {
  const [dimension, setDimension] = useState<BreakdownDimension>('category');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('count');
  const breakdown = useMemo(() => buildProductBreakdown(products, stock, warehouses, categories, brands),
    [products, stock, warehouses, categories, brands]);
  const groups = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return breakdown.groups[dimension]
      .filter(group => group.label.toLocaleLowerCase().includes(query))
      .slice().sort(sort === 'name'
        ? (a, b) => a.label.localeCompare(b.label)
        : (a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [breakdown, dimension, search, sort]);
  const label = dimensions.find(d => d.key === dimension)!.label;

  return (
    <>
      <div className="border-b border-border p-4 sm:p-6 [@media(max-height:600px)]:p-3">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium text-primary [@media(max-height:600px)]:hidden">
          <Boxes className="h-4 w-4" aria-hidden="true" /> Inventory overview
        </div>
        <DialogTitle className="pr-8 text-lg sm:text-xl">Total products breakdown</DialogTitle>
        <DialogDescription className="mt-2 [@media(max-height:600px)]:sr-only">
          All active products, before filters. Select a group to view its products.
        </DialogDescription>
        <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 sm:mt-5 [@media(max-height:600px)]:mt-1">
          <span className="text-3xl font-bold tabular-nums tracking-tight [@media(max-height:600px)]:text-xl">{breakdown.total.toLocaleString()}</span>
          <span className="text-sm text-muted-foreground">active products</span>
        </div>
        {stale && <p role="status" className="mt-3 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">Showing the last available inventory snapshot. Refresh the products page when online for current counts.</p>}
      </div>
      <Tabs value={dimension} onValueChange={value => { setDimension(value as BreakdownDimension); setSearch(''); }} className="flex min-h-0 flex-1 flex-col">
        <div className="px-4 pt-4 sm:px-6">
          <TabsList aria-label="Break down products by" className="grid h-11 w-full grid-cols-4">
            {dimensions.map(d => <TabsTrigger key={d.key} value={d.key} className="min-h-9 px-1 text-xs sm:text-sm">{d.label}</TabsTrigger>)}
          </TabsList>
        </div>
        <div className="flex gap-2 px-4 pt-4 sm:px-6">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <input aria-label={`Search ${label.toLowerCase()} groups`} placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} className="h-10 w-full rounded-lg border border-input bg-background pl-9 pr-10 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
            {search && <button type="button" aria-label="Clear group search" onClick={() => setSearch('')} className="absolute right-0 top-0 flex h-10 w-10 items-center justify-center rounded-lg text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><X className="h-4 w-4" /></button>}
          </div>
          <div className="relative shrink-0">
            <ArrowDownWideNarrow className="pointer-events-none absolute left-2.5 top-3 hidden h-4 w-4 text-muted-foreground sm:block" aria-hidden="true" />
            <select aria-label="Sort groups" value={sort} onChange={e => setSort(e.target.value)} className="h-10 rounded-lg border border-input bg-background pl-2 pr-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:pl-8">
              <option value="count">Most first</option>
              <option value="name">Name A–Z</option>
            </select>
          </div>
        </div>
        {dimensions.map(d => (
          <TabsContent key={d.key} value={d.key} className="mt-0 min-h-0 overflow-y-auto px-4 pb-4 sm:px-6 [@media(max-height:600px)]:max-h-[45dvh]">
            <div className="flex justify-between gap-2 py-3 text-xs text-muted-foreground">
              <span role="status">{groups.length.toLocaleString()} {groups.length === 1 ? 'group' : 'groups'}</span>
              <span>Products / share of total</span>
            </div>
            {groups.length ? (
              <ul className="space-y-1">
                {groups.map(group => {
                  const share = breakdown.total ? group.count / breakdown.total * 100 : 0;
                  return (
                    <li key={group.key}>
                      <button type="button" onClick={() => onSelect({ dimension, key: group.key, label: group.label })}
                        aria-label={`View ${group.count.toLocaleString()} products: ${group.label}`}
                        className="group w-full rounded-lg border border-transparent px-3 py-3 text-left transition-colors hover:border-border hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        <div className="flex items-center gap-3">
                          <span className="min-w-0 flex-1 break-words text-sm font-medium">{group.label}</span>
                          <span className="shrink-0 text-sm font-semibold tabular-nums">{group.count.toLocaleString()}</span>
                          <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{share > 0 && share < 0.1 ? '<0.1' : share.toLocaleString(undefined, { maximumFractionDigits: 1 })}%</span>
                          <ArrowRight aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-primary" />
                        </div>
                        <div aria-hidden="true" className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full bg-primary" style={{ width: `${share}%` }} />
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="py-10 text-center">
                <p className="text-sm font-medium">{search ? 'No matching groups' : 'No active products yet'}</p>
                <p className="mt-1 text-sm text-muted-foreground">{search ? 'Try another name or clear your search.' : 'Products will appear here after they are added.'}</p>
                {search && <button type="button" onClick={() => setSearch('')} className="mt-3 rounded-md px-3 py-2 text-sm font-medium text-primary underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Clear search</button>}
              </div>
            )}
          </TabsContent>
        ))}
      </Tabs>
      <div className="border-t border-border bg-muted/30 px-5 py-3 text-xs leading-relaxed text-muted-foreground sm:px-6">
        {dimension === 'warehouse'
          ? 'Counts products with positive stock in each warehouse. A product can appear in several warehouses, so shares may exceed 100% in total.'
          : dimension === 'status'
            ? 'Stock status uses total quantity across all warehouses and each product’s minimum stock level.'
            : 'Each product is counted once, under its assigned group.'}
      </div>
    </>
  );
}
