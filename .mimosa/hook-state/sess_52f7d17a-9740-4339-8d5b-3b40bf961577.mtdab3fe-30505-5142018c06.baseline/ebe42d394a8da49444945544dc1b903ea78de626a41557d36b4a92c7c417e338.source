'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ShoppingCart,
  ShoppingBag,
  FileText,
  Users,
  Truck,
  CreditCard,
  Receipt,
  FolderKanban,
  Package,
  UserPlus,
  Building2,
  FileBarChart,
  Wallet,
  Settings,
  X,
  Zap,
  ChevronLeft,
  ArrowRightLeft,
  ClipboardList,
  Warehouse,
  ReceiptIcon,
  type LucideIcon,
} from 'lucide-react';

interface QuickAction {
  label: string;
  href: string;
  icon: LucideIcon;
  bg: string;
  ring: string;
  description?: string;
  category?: string;
}

const quickActions: QuickAction[] = [
  // Sales
  { label: 'New Sale', href: '/sales', icon: ShoppingCart, bg: 'bg-blue-500', ring: 'ring-blue-200', description: 'Create invoice', category: 'Sales' },
  { label: 'POS Sale', href: '/sales/pos', icon: Receipt, bg: 'bg-indigo-500', ring: 'ring-indigo-200', description: 'Point of sale', category: 'Sales' },
  { label: 'New Quotation', href: '/quotations', icon: FileText, bg: 'bg-orange-500', ring: 'ring-orange-200', description: 'Create quote', category: 'Sales' },
  { label: 'New Return', href: '/sales/returns', icon: ArrowRightLeft, bg: 'bg-rose-500', ring: 'ring-rose-200', description: 'Process return', category: 'Sales' },

  // Purchases
  { label: 'New Purchase', href: '/purchases', icon: ShoppingBag, bg: 'bg-emerald-500', ring: 'ring-emerald-200', description: 'Create PO', category: 'Purchases' },
  { label: 'New GRN', href: '/purchases/grn', icon: ClipboardList, bg: 'bg-teal-500', ring: 'ring-teal-200', description: 'Goods receipt', category: 'Purchases' },
  { label: 'New Supplier', href: '/suppliers', icon: Building2, bg: 'bg-slate-500', ring: 'ring-slate-200', description: 'Add supplier', category: 'Purchases' },

  // Inventory
  { label: 'New Product', href: '/inventory', icon: Package, bg: 'bg-purple-500', ring: 'ring-purple-200', description: 'Add product', category: 'Inventory' },
  { label: 'Stock Adjust', href: '/inventory', icon: Warehouse, bg: 'bg-violet-500', ring: 'ring-violet-200', description: 'Adjust stock', category: 'Inventory' },

  // CRM
  { label: 'New Customer', href: '/crm', icon: Users, bg: 'bg-cyan-500', ring: 'ring-cyan-200', description: 'Add customer', category: 'CRM' },
  { label: 'Add Contact', href: '/crm', icon: UserPlus, bg: 'bg-sky-500', ring: 'ring-sky-200', description: 'Add contact', category: 'CRM' },

  // Logistics
  { label: 'New Delivery', href: '/delivery', icon: Truck, bg: 'bg-amber-500', ring: 'ring-amber-200', description: 'Create delivery', category: 'Logistics' },

  // Finance
  { label: 'New Expense', href: '/accounting', icon: CreditCard, bg: 'bg-red-500', ring: 'ring-red-200', description: 'Record expense', category: 'Finance' },
  { label: 'New Income', href: '/accounting', icon: Wallet, bg: 'bg-green-500', ring: 'ring-green-200', description: 'Record income', category: 'Finance' },
  { label: 'Journal Entry', href: '/accounting', icon: ReceiptIcon, bg: 'bg-lime-500', ring: 'ring-lime-200', description: 'Manual entry', category: 'Finance' },

  // Projects
  { label: 'New Project', href: '/projects', icon: FolderKanban, bg: 'bg-pink-500', ring: 'ring-pink-200', description: 'Start project', category: 'Projects' },

  // Reports
  { label: 'Reports', href: '/reports', icon: FileBarChart, bg: 'bg-gray-600', ring: 'ring-gray-200', description: 'View reports', category: 'Reports' },

  // Settings
  { label: 'Settings', href: '/settings', icon: Settings, bg: 'bg-neutral-500', ring: 'ring-neutral-200', description: 'System settings', category: 'Settings' },
];

const groupedActions = quickActions.reduce((acc, action) => {
  const category = action.category || 'Other';
  if (!acc[category]) acc[category] = [];
  acc[category].push(action);
  return acc;
}, {} as Record<string, QuickAction[]>);

const categoryOrder = ['Sales', 'Purchases', 'Inventory', 'CRM', 'Logistics', 'Finance', 'Projects', 'Reports', 'Settings'];

export default function QuickActionDrawer() {
  const [isOpen, setIsOpen] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 1024);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  useEffect(() => {
    setIsOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!isMobile && !isOpen) return;

    function handleClickOutside(e: MouseEvent) {
      if (
        drawerRef.current &&
        !drawerRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, isMobile]);

  // Desktop hover behavior
  useEffect(() => {
    if (isMobile) return;

    let timeout: NodeJS.Timeout;
    if (isHovered && !isOpen) {
      timeout = setTimeout(() => setIsOpen(true), 150);
    } else if (!isHovered && isOpen) {
      timeout = setTimeout(() => setIsOpen(false), 300);
    }
    return () => clearTimeout(timeout);
  }, [isHovered, isOpen, isMobile]);

  return (
    <>
      {/* Mobile Overlay */}
      {isMobile && isOpen && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[60] animate-fade-in"
          onClick={() => setIsOpen(false)}
        />
      )}

      {/* Side Tab Trigger */}
      <button
        ref={triggerRef}
        onClick={() => setIsOpen(!isOpen)}
        onMouseEnter={() => !isMobile && setIsHovered(true)}
        onMouseLeave={() => !isMobile && setIsHovered(false)}
        className={`
          fixed z-[70] transition-all duration-300
          ${isMobile
            ? 'bottom-20 right-0'
            : 'right-0 top-1/2 -translate-y-1/2'
          }
          ${isOpen
            ? 'w-12 h-12 rounded-full bg-slate-800 mr-3'
            : isMobile
              ? 'w-6 h-14 rounded-l-lg'
              : 'w-6 hover:w-10 h-28 rounded-l-xl'
          }
          bg-gradient-to-l from-slate-700 to-slate-800
          hover:from-slate-600 hover:to-slate-700
          shadow-lg shadow-slate-900/30
          flex items-center justify-center
          group
        `}
        aria-label="Quick Actions"
      >
        {isOpen ? (
          <X className="w-5 h-5 text-white" />
        ) : (
          <div className="flex items-center justify-center h-full">
            {/* Arrow indicator pointing left */}
            <svg
              className={`w-4 h-4 text-white transition-opacity ${isMobile ? '' : 'opacity-90 group-hover:opacity-100'}`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </div>
        )}

        {/* Subtle glow */}
        {!isOpen && !isMobile && (
          <span className="absolute inset-0 rounded-l-xl bg-slate-400/20 animate-pulse" />
        )}
      </button>

      {/* Drawer */}
      <div
        ref={drawerRef}
        onMouseEnter={() => !isMobile && setIsHovered(true)}
        onMouseLeave={() => !isMobile && setIsHovered(false)}
        className={`
          fixed z-[65]
          ${isMobile ? (
            `bottom-0 left-0 right-0 rounded-t-3xl max-h-[85vh] overflow-hidden
            ${isOpen ? 'translate-y-0' : 'translate-y-full'}`
          ) : (
            `right-0 top-0 bottom-0 w-80 max-w-[calc(100vw-2rem)]
            ${isOpen ? 'translate-x-0' : 'translate-x-full'}`
          )}
          bg-white shadow-2xl
          transition-transform duration-300 ease-out
        `}
      >
        {/* Handle bar for mobile */}
        {isMobile && (
          <div className="flex justify-center pt-3 pb-2">
            <div className="w-10 h-1 bg-slate-200 rounded-full" />
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-500 flex items-center justify-center">
              <Zap className="w-4 h-4 text-white" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">Quick Actions</h3>
              <p className="text-[10px] text-slate-500">Fast access to all features</p>
            </div>
          </div>
          <button
            onClick={() => setIsOpen(false)}
            className="w-8 h-8 rounded-lg bg-slate-100 hover:bg-slate-200 flex items-center justify-center transition-colors"
          >
            <X className="w-4 h-4 text-slate-500" />
          </button>
        </div>

        {/* Actions Grid */}
        <div className="overflow-y-auto p-4 space-y-5" style={{ maxHeight: isMobile ? 'calc(85vh - 80px)' : 'calc(100vh - 100px)' }}>
          {categoryOrder.map((category) => {
            const actions = groupedActions[category];
            if (!actions || actions.length === 0) return null;

            return (
              <div key={category}>
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2.5 px-1">
                  {category}
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {actions.map((action) => (
                    <Link
                      key={action.label}
                      href={action.href}
                      className="group/action flex flex-col items-center gap-1.5 p-2.5 rounded-xl bg-slate-50 hover:bg-slate-100 border border-slate-100 hover:border-slate-200 hover:shadow-sm transition-all duration-200"
                    >
                      <div className={`
                        w-10 h-10 rounded-xl ${action.bg} ring-2 ${action.ring}
                        flex items-center justify-center
                        group-hover/action:scale-110 group-hover/action:shadow-md
                        transition-all duration-200
                      `}>
                        <action.icon className="w-4.5 h-4.5 text-white" />
                      </div>
                      <span className="text-[10px] font-semibold text-slate-700 group-hover/action:text-slate-900 text-center leading-tight transition-colors">
                        {action.label.replace('New ', '')}
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer hint */}
        <div className="px-5 py-3 border-t border-slate-100 bg-slate-50/50">
          <p className="text-[10px] text-slate-400 text-center">
            {isMobile ? 'Tap outside to close' : 'Hover to keep open • Click to pin'}
          </p>
        </div>
      </div>
    </>
  );
}
