'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { getInitials } from '@/lib/format';
import { tokenizeSearch, applyIlikeTokens, rankRows } from '@/lib/search';
import HighlightLabel from '@/components/ui/HighlightLabel';
import { Search, ChevronDown, User, LogOut, Settings, CircleHelp as HelpCircle, X, Package, Users, Receipt, ShoppingBag, FileText, Truck, FolderKanban, ScanLine, ShoppingCart, AlertCircle, Zap } from 'lucide-react';
import type { Profile } from '@/lib/types';
import { useGlobalCart, type GlobalCartItem } from '@/hooks/use-global-cart';
import BarcodeScannerModal from '@/components/BarcodeScannerModal';
import { QuickSellModal } from '@/components/quick-sell-modal';
import OfflineStatusPill from '@/components/offline/OfflineStatusPill';
import NotificationBell from '@/components/notifications/NotificationBell';
import InstallButton from '@/components/pwa/InstallButton';
import { clearLocalData } from '@/lib/offline/db';
import { clearLastUser } from '@/lib/offline/session';
import { toast } from '@/hooks/use-toast';

interface HeaderProps {
  onMenuToggle?: () => void;
}

interface SearchResult {
  id: string;
  type: string;
  label: string;
  sub: string;
  href: string;
  icon: React.ElementType;
  color: string;
}

const searchSources: { table: string; labelCol: string; subCol?: string; searchCols: string[]; type: string; hrefFor: (row: any) => string; icon: React.ElementType; color: string }[] = [
  { table: 'customers', labelCol: 'name', subCol: 'code', searchCols: ['name', 'code', 'phone'], type: 'Customer', hrefFor: (row) => `/crm/${row.id}`, icon: Users, color: 'text-teal-600 bg-teal-50' },
  { table: 'products', labelCol: 'name', subCol: 'sku', searchCols: ['name', 'sku'], type: 'Product', hrefFor: (row) => `/inventory/${row.id}`, icon: Package, color: 'text-blue-600 bg-blue-50' },
  { table: 'invoices', labelCol: 'invoice_number', subCol: 'status', searchCols: ['invoice_number'], type: 'Invoice', hrefFor: (row) => `/sales?search=${encodeURIComponent(row.invoice_number)}`, icon: Receipt, color: 'text-green-600 bg-green-50' },
  { table: 'quotations', labelCol: 'quote_number', subCol: 'status', searchCols: ['quote_number'], type: 'Quotation', hrefFor: (row) => `/quotations?search=${encodeURIComponent(row.quote_number)}`, icon: FileText, color: 'text-orange-600 bg-orange-50' },
  { table: 'purchase_orders', labelCol: 'po_number', subCol: 'status', searchCols: ['po_number'], type: 'Purchase', hrefFor: (row) => `/purchases?search=${encodeURIComponent(row.po_number)}`, icon: ShoppingBag, color: 'text-purple-600 bg-purple-50' },
  { table: 'deliveries', labelCol: 'delivery_number', subCol: 'status', searchCols: ['delivery_number'], type: 'Delivery', hrefFor: (row) => `/delivery?search=${encodeURIComponent(row.delivery_number)}`, icon: Truck, color: 'text-pink-600 bg-pink-50' },
  { table: 'projects', labelCol: 'name', subCol: 'status', searchCols: ['name'], type: 'Project', hrefFor: (row) => `/projects?search=${encodeURIComponent(row.name)}`, icon: FolderKanban, color: 'text-indigo-600 bg-indigo-50' },
];

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const kbdHint = isMac ? '⌘K' : 'Ctrl+K';

export default function Header({ onMenuToggle }: HeaderProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [showScanner, setShowScanner] = useState(false);
  const [showQuickSell, setShowQuickSell] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeq = useRef(0);
  const { count: cartCount, addToCart } = useGlobalCart();

  useEffect(() => {
    async function loadProfile() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle();
      if (data) setProfile(data);
      else {
        setProfile({
          id: user.id,
          tenant_id: '00000000-0000-0000-0000-000000000001',
          full_name: user.email?.split('@')[0] || 'Admin',
          email: user.email || '',
          role: 'super_admin',
          is_active: true,
          created_at: '',
          updated_at: '',
        });
      }
    }
    loadProfile();
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowResults(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    function handleKeydown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        const input = searchRef.current?.querySelector('input');
        input?.focus();
        input?.select();
        setShowResults(true);
      }
      if (e.key === 'Escape' && document.activeElement === searchRef.current?.querySelector('input')) {
        e.preventDefault();
        setShowResults(false);
        setSearchQuery('');
        (document.activeElement as HTMLElement).blur();
      }
    }
    document.addEventListener('keydown', handleKeydown);
    return () => document.removeEventListener('keydown', handleKeydown);
  }, []);

  useEffect(() => {
    if (activeIndex < 0) return;
    document.getElementById(`global-search-option-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  function closeSearch() {
    setShowResults(false);
    setSearchQuery('');
    setSearchResults([]);
    setSearchError(false);
    setActiveIndex(-1);
  }

  function selectResult(result: SearchResult) {
    closeSearch();
    router.push(result.href);
  }

  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    if (!searchQuery.trim()) { setSearchResults([]); setSearching(false); setSearchError(false); return; }
    const tokens = tokenizeSearch(searchQuery);
    // A term made only of filter grammar (e.g. ",,,") sanitises to nothing —
    // show nothing rather than an unfiltered dump of every source.
    if (tokens.length === 0) { setSearchResults([]); setSearching(false); setShowResults(false); return; }

    setSearching(true);
    searchTimeout.current = setTimeout(async () => {
      const requestId = ++requestSeq.current;
      const results: SearchResult[] = [];
      let failed = false;

      // One sanitised OR filter per token per source — PostgREST ANDs the
      // tokens together, so word order no longer matters and commas/parens
      // in the term can't break the filter.
      await Promise.all(searchSources.map(async (src) => {
        const { data, error } = await applyIlikeTokens(
          supabase
            .from(src.table)
            .select(`${src.labelCol}${src.subCol ? ', ' + src.subCol : ''}, id`),
          src.searchCols,
          tokens,
        ).limit(20);

        if (error) { failed = true; return; }
        // Rank before cutting to 3 — the DB limit only bounds transport, so a
        // name starting with the query outranks alphabetically-earlier rows.
        const ranked = rankRows((data || []) as any[], (row: any) => [row[src.labelCol], src.subCol ? String(row[src.subCol] || '') : ''], tokens).slice(0, 3);
        ranked.forEach((row: any) => {
          results.push({
            id: row.id,
            type: src.type,
            label: row[src.labelCol],
            sub: src.subCol ? String(row[src.subCol] || '') : '',
            href: src.hrefFor(row),
            icon: src.icon,
            color: src.color,
          });
        });
      }));

      // A newer keystroke already started its own fetch — drop this stale batch.
      if (requestId !== requestSeq.current) return;

      setSearchResults(results.slice(0, 8));
      setSearchError(failed);
      setSearching(false);
      setShowResults(true);
      setActiveIndex(results.length > 0 ? 0 : -1);
    }, 300);
  }, [searchQuery]);

  async function handleLogout() {
    // Wipe the offline cache, queued changes and the local encryption key —
    // signing out must not leave sealed business data on a shared device.
    await clearLocalData();
    // Also forget the remembered user, so the app can't reopen offline as
    // the signed-out account on this device.
    await clearLastUser();
    await supabase.auth.signOut();
    router.push('/login');
  }

  const roleLabel: Record<string, string> = {
    super_admin: 'Super Admin',
    manager: 'Manager',
    sales_executive: 'Sales Executive',
    inventory_manager: 'Inventory Manager',
    accountant: 'Accountant',
    delivery_staff: 'Delivery Staff',
  };

  return (
    <header className="h-14 bg-white border-b border-border flex items-center px-4 gap-4 sticky top-0 z-30">
      {/* Quick Actions */}
      <div className="hidden md:flex items-center gap-1 ml-auto">
        {[
          { href: '/inventory', icon: Package, label: 'Products', color: 'hover:bg-blue-50 hover:text-blue-600' },
          { href: '/crm', icon: Users, label: 'Customers', color: 'hover:bg-teal-50 hover:text-teal-600' },
          { href: '/sales', icon: Receipt, label: 'Invoices', color: 'hover:bg-green-50 hover:text-green-600' },
          { href: '/sales/pos', icon: ShoppingCart, label: 'POS', color: 'hover:bg-amber-50 hover:text-amber-600' },
          { href: '/quotations', icon: FileText, label: 'Quotations', color: 'hover:bg-orange-50 hover:text-orange-600' },
          { href: '/purchases', icon: ShoppingBag, label: 'Purchases', color: 'hover:bg-purple-50 hover:text-purple-600' },
        ].map((action) => (
          <Link
            key={action.href}
            href={action.href}
            title={action.label}
            className={`w-8 h-8 flex items-center justify-center rounded-lg text-muted-foreground transition-colors ${action.color}`}
          >
            <action.icon className="w-4 h-4" />
          </Link>
        ))}
        {/* Quick Sell — non-stock items bought on demand, sold immediately */}
        <button
          type="button"
          onClick={() => setShowQuickSell(true)}
          title="Quick Sell"
          className="w-8 h-8 flex items-center justify-center rounded-lg text-muted-foreground hover:bg-amber-50 hover:text-amber-600 transition-colors"
        >
          <Zap className="w-4 h-4" />
        </button>
      </div>

      {/* Global Search */}
      <div className="flex-1 max-w-md relative" ref={searchRef}>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            role="combobox"
            aria-label="Global search"
            aria-expanded={showResults && !!searchQuery}
            aria-controls="global-search-results"
            aria-activedescendant={activeIndex >= 0 ? `global-search-option-${activeIndex}` : undefined}
            aria-autocomplete="list"
            value={searchQuery}
            onChange={e => { setSearchQuery(e.target.value); setShowResults(true); }}
            onFocus={() => searchQuery && setShowResults(true)}
            onKeyDown={e => {
              if (e.key === 'ArrowDown' && searchResults.length > 0) {
                e.preventDefault();
                setActiveIndex(i => (i + 1) % searchResults.length);
              } else if (e.key === 'ArrowUp' && searchResults.length > 0) {
                e.preventDefault();
                setActiveIndex(i => (i - 1 + searchResults.length) % searchResults.length);
              } else if (e.key === 'Enter' && !searching) {
                const result = searchResults[activeIndex] || searchResults[0];
                if (result) {
                  e.preventDefault();
                  selectResult(result);
                }
              }
            }}
            placeholder="Search customers, products, invoices..."
            className="w-full pl-8 pr-16 py-1.5 text-sm bg-muted/50 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 transition"
          />
          {searchQuery ? (
            <button onClick={closeSearch} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="w-3.5 h-3.5" />
            </button>
          ) : (
            <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground bg-white border border-border px-1.5 py-0.5 rounded font-mono">
              {kbdHint}
            </kbd>
          )}
        </div>

        {showResults && searchQuery && (
          <div
            id="global-search-results"
            role="listbox"
            aria-label="Search results"
            className="absolute top-full left-0 right-0 mt-1.5 bg-white border border-border rounded-xl shadow-xl z-50 overflow-hidden"
          >
            {searching ? (
              <div className="px-4 py-3 text-xs text-muted-foreground flex items-center gap-2">
                <div className="w-3 h-3 border border-blue-500 border-t-transparent rounded-full animate-spin" />
                Searching...
              </div>
            ) : searchError && searchResults.length === 0 ? (
              <div className="px-4 py-3 text-xs text-red-600 flex items-center gap-2">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                Search failed — check your connection and try again
              </div>
            ) : searchResults.length === 0 ? (
              <div className="px-4 py-3 text-xs text-muted-foreground">No results for &ldquo;{searchQuery}&rdquo;</div>
            ) : (
              <div>
                {searchResults.map((result, i) => (
                  <Link
                    key={`${result.type}-${result.id}`}
                    id={`global-search-option-${i}`}
                    role="option"
                    aria-selected={i === activeIndex}
                    href={result.href}
                    onClick={closeSearch}
                    onMouseEnter={() => setActiveIndex(i)}
                    className={`flex items-center gap-3 px-3 py-2.5 transition-colors border-b border-border/50 last:border-0 ${i === activeIndex ? 'bg-muted' : ''}`}
                  >
                    <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${result.color}`}>
                      <result.icon className="w-3.5 h-3.5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground leading-snug break-words">
                        <HighlightLabel text={result.label} query={searchQuery} />
                      </p>
                      <p className="text-[10px] text-muted-foreground">{result.type}{result.sub ? ` · ${result.sub}` : ''}</p>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Right actions */}
      <div className="flex items-center gap-1 ml-auto">
        <InstallButton />
        <OfflineStatusPill />
        <NotificationBell />
        {/* Quick-actions row is desktop-only — mobile still needs a Quick Sell entry point */}
        <button
          type="button"
          onClick={() => setShowQuickSell(true)}
          title="Quick Sell"
          className="md:hidden w-8 h-8 flex items-center justify-center rounded-lg text-muted-foreground hover:bg-amber-50 hover:text-amber-600 transition-colors"
        >
          <Zap className="w-4 h-4" />
        </button>
        <button
          onClick={() => setShowScanner(true)}
          title="Scan Barcode"
          className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-blue-50 text-muted-foreground hover:text-blue-600 transition-colors"
        >
          <ScanLine className="w-4 h-4" />
        </button>
        <Link
          href="/sales/pos"
          title="POS Cart"
          className="relative w-8 h-8 flex items-center justify-center rounded-lg hover:bg-blue-50 text-muted-foreground hover:text-blue-600 transition-colors"
        >
          <ShoppingCart className="w-4 h-4" />
          {cartCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 bg-blue-600 text-white text-[9px] font-bold rounded-full flex items-center justify-center">{cartCount > 99 ? '99+' : cartCount}</span>
          )}
        </Link>
        <div className="relative ml-1">
          <button
            onClick={() => setShowUserMenu(!showUserMenu)}
            className="flex items-center gap-2 pl-1 pr-2 py-1 rounded-lg hover:bg-muted transition-colors"
          >
            <div className="w-7 h-7 bg-blue-600 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0">
              {profile ? getInitials(profile.full_name || profile.email) : 'A'}
            </div>
            <div className="hidden sm:block text-left min-w-0">
              <div className="text-xs font-semibold text-foreground truncate max-w-[100px]">{profile?.full_name || 'Admin User'}</div>
              <div className="text-[10px] text-muted-foreground">{roleLabel[profile?.role || ''] || 'Super Admin'}</div>
            </div>
            <ChevronDown className="w-3 h-3 text-muted-foreground hidden sm:block" />
          </button>

          {showUserMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowUserMenu(false)} />
              <div className="absolute right-0 top-full mt-1 w-52 bg-white border border-border rounded-xl shadow-lg z-50 py-1 animate-fade-in">
                <div className="px-3 py-2 border-b border-border">
                  <div className="text-sm font-semibold">{profile?.full_name}</div>
                  <div className="text-xs text-muted-foreground truncate">{profile?.email}</div>
                </div>
                <Link href="/settings" className="flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-muted transition-colors" onClick={() => setShowUserMenu(false)}>
                  <Settings className="w-3.5 h-3.5 text-muted-foreground" />Settings
                </Link>
                <Link href="/settings" className="flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-muted transition-colors" onClick={() => setShowUserMenu(false)}>
                  <User className="w-3.5 h-3.5 text-muted-foreground" />My Profile
                </Link>
                <Link href="/settings" className="flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-muted transition-colors" onClick={() => setShowUserMenu(false)}>
                  <HelpCircle className="w-3.5 h-3.5 text-muted-foreground" />Help & Support
                </Link>
                <div className="border-t border-border mt-1">
                  <button onClick={handleLogout} className="flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-red-50 text-red-600 transition-colors w-full">
                    <LogOut className="w-3.5 h-3.5" />Sign out
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {showQuickSell &&
        createPortal(
          <QuickSellModal
            open={showQuickSell}
            onClose={() => setShowQuickSell(false)}
            isPos={pathname === '/sales/pos'}
            onCreated={() => window.dispatchEvent(new Event('quick-sell:created'))}
          />,
          document.body,
        )}
      {showScanner && (
        <BarcodeScannerModal
          onDetected={async (code) => {
            setShowScanner(false);
            const { data } = await supabase
              .from('products')
              .select('id, name, sku, sale_price, image_url')
              .eq('sku', code)
              .maybeSingle();
            if (data) {
              addToCart({
                id: data.id,
                name: data.name,
                sku: data.sku,
                unit_price: data.sale_price,
                quantity: 1,
                image_url: data.image_url,
                selected_unit: null,
              });
              toast({ title: 'Added to POS cart', description: data.name });
            } else {
              toast({ title: 'Not found', description: `No product with SKU ${code}`, variant: 'destructive' });
            }
          }}
          onClose={() => setShowScanner(false)}
          title="Scan to POS Cart"
        />
      )}
    </header>
  );
}
