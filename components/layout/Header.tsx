'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { getInitials } from '@/lib/format';
import { Search, Bell, MessageSquare, ChevronDown, User, LogOut, Settings, CircleHelp as HelpCircle, X, Package, Users, Receipt, ShoppingBag, FileText, Truck, FolderKanban, ScanLine, ShoppingCart } from 'lucide-react';
import type { Profile } from '@/lib/types';
import { useGlobalCart, type GlobalCartItem } from '@/hooks/use-global-cart';
import BarcodeScannerModal from '@/components/BarcodeScannerModal';
import { toast } from '@/hooks/use-toast';

interface HeaderProps {
  onMenuToggle?: () => void;
}

interface SearchResult {
  type: string;
  label: string;
  sub: string;
  href: string;
  icon: React.ElementType;
  color: string;
}

const searchSources: { table: string; labelCol: string; subCol?: string; searchCols: string[]; type: string; href: string; icon: React.ElementType; color: string }[] = [
  { table: 'customers', labelCol: 'name', subCol: 'code', searchCols: ['name', 'code', 'phone'], type: 'Customer', href: '/crm', icon: Users, color: 'text-teal-600 bg-teal-50' },
  { table: 'products', labelCol: 'name', subCol: 'sku', searchCols: ['name', 'sku'], type: 'Product', href: '/inventory', icon: Package, color: 'text-blue-600 bg-blue-50' },
  { table: 'invoices', labelCol: 'invoice_number', subCol: 'status', searchCols: ['invoice_number'], type: 'Invoice', href: '/sales', icon: Receipt, color: 'text-green-600 bg-green-50' },
  { table: 'quotations', labelCol: 'quote_number', subCol: 'status', searchCols: ['quote_number'], type: 'Quotation', href: '/quotations', icon: FileText, color: 'text-orange-600 bg-orange-50' },
  { table: 'purchase_orders', labelCol: 'po_number', subCol: 'status', searchCols: ['po_number'], type: 'Purchase', href: '/purchases', icon: ShoppingBag, color: 'text-purple-600 bg-purple-50' },
  { table: 'deliveries', labelCol: 'delivery_number', subCol: 'status', searchCols: ['delivery_number'], type: 'Delivery', href: '/delivery', icon: Truck, color: 'text-pink-600 bg-pink-50' },
  { table: 'projects', labelCol: 'name', subCol: 'status', searchCols: ['name'], type: 'Project', href: '/projects', icon: FolderKanban, color: 'text-indigo-600 bg-indigo-50' },
];

export default function Header({ onMenuToggle }: HeaderProps) {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
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
        setShowResults(true);
      }
      if (e.key === 'Escape') {
        setShowResults(false);
        setSearchQuery('');
      }
    }
    document.addEventListener('keydown', handleKeydown);
    return () => document.removeEventListener('keydown', handleKeydown);
  }, []);

  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    if (!searchQuery.trim()) { setSearchResults([]); setSearching(false); return; }

    setSearching(true);
    searchTimeout.current = setTimeout(async () => {
      const q = searchQuery.trim().toLowerCase();
      const results: SearchResult[] = [];

      await Promise.all(searchSources.map(async (src) => {
        const orFilter = src.searchCols.map(col => `${col}.ilike.%${q}%`).join(',');
        const { data } = await supabase
          .from(src.table)
          .select(`${src.labelCol}${src.subCol ? ', ' + src.subCol : ''}, id`)
          .or(orFilter)
          .limit(3);

        (data || []).forEach((row: any) => {
          results.push({
            type: src.type,
            label: row[src.labelCol],
            sub: src.subCol ? String(row[src.subCol] || '') : '',
            href: src.href,
            icon: src.icon,
            color: src.color,
          });
        });
      }));

      setSearchResults(results.slice(0, 8));
      setSearching(false);
      setShowResults(true);
    }, 300);
  }, [searchQuery]);

  async function handleLogout() {
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
      </div>

      {/* Date range badge */}
      <div className="hidden lg:flex items-center gap-1.5 text-xs text-muted-foreground bg-muted/60 border border-border px-2.5 py-1.5 rounded-lg">
        <span>
          {new Date(new Date().getFullYear(), new Date().getMonth(), 1).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
        </span>
        <span>–</span>
        <span>
          {new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
        </span>
        <ChevronDown className="w-3 h-3" />
      </div>

      {/* Global Search */}
      <div className="flex-1 max-w-md relative" ref={searchRef}>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => { setSearchQuery(e.target.value); setShowResults(true); }}
            onFocus={() => searchQuery && setShowResults(true)}
            placeholder="Search customers, products, invoices..."
            className="w-full pl-8 pr-16 py-1.5 text-sm bg-muted/50 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 transition"
          />
          {searchQuery ? (
            <button onClick={() => { setSearchQuery(''); setSearchResults([]); setShowResults(false); }} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="w-3.5 h-3.5" />
            </button>
          ) : (
            <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground bg-white border border-border px-1.5 py-0.5 rounded font-mono">
              Ctrl+K
            </kbd>
          )}
        </div>

        {showResults && searchQuery && (
          <div className="absolute top-full left-0 right-0 mt-1.5 bg-white border border-border rounded-xl shadow-xl z-50 overflow-hidden">
            {searching ? (
              <div className="px-4 py-3 text-xs text-muted-foreground flex items-center gap-2">
                <div className="w-3 h-3 border border-blue-500 border-t-transparent rounded-full animate-spin" />
                Searching...
              </div>
            ) : searchResults.length === 0 ? (
              <div className="px-4 py-3 text-xs text-muted-foreground">No results for &ldquo;{searchQuery}&rdquo;</div>
            ) : (
              <div>
                {searchResults.map((result, i) => (
                  <Link
                    key={i}
                    href={result.href}
                    onClick={() => { setShowResults(false); setSearchQuery(''); }}
                    className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/50 transition-colors border-b border-border/50 last:border-0"
                  >
                    <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${result.color}`}>
                      <result.icon className="w-3.5 h-3.5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{result.label}</p>
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
        <button className="relative w-8 h-8 flex items-center justify-center rounded-lg hover:bg-muted transition-colors">
          <Bell className="w-4 h-4 text-muted-foreground" />
          <span className="absolute top-1 right-1 w-4 h-4 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center">8</span>
        </button>
        <button className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-muted transition-colors">
          <MessageSquare className="w-4 h-4 text-muted-foreground" />
        </button>

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
