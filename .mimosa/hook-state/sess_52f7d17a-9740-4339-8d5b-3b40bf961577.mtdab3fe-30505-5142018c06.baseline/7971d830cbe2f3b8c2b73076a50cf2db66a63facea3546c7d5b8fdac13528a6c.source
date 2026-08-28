'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { Rocket, Search, ChevronDown, ChevronRight, BookOpen, Lightbulb, LayoutDashboard, Package, ShoppingCart, ShoppingBag, Users, FolderKanban, Truck, Calculator, Store, UserRound, ChartBar as BarChart3, Settings, Receipt, ArrowRight, Building2, Boxes, ArrowRightLeft, FileText, CreditCard, ClipboardList, TrendingUp, CircleCheck, CircleAlert, Info, Play } from 'lucide-react';

interface GuideSection {
  id: string;
  title: string;
  category: string;
  icon: React.ElementType;
  iconColor: string;
  summary: string;
  steps: { title: string; detail: string; tip?: string; link?: string }[];
  tips?: string[];
  warnings?: string[];
}

const sections: GuideSection[] = [
  {
    id: 'getting-started',
    title: 'Getting Started & First Login',
    category: 'Onboarding',
    icon: Rocket,
    iconColor: 'bg-blue-50 text-blue-600',
    summary: 'How to sign in, access the demo account, and understand the ERP layout.',
    steps: [
      {
        title: 'Sign in to the ERP',
        detail: 'Navigate to the login page and enter your email and password. If this is your first time, use the demo account button to explore the system instantly.',
        tip: 'Demo credentials: admin@sibuilding.com / Admin@123456',
        link: '/login',
      },
      {
        title: 'Understand the layout',
        detail: 'The ERP has a dark sidebar on the left for navigation, a top header with global search (Ctrl+K), notifications, and your profile menu, and a main content area where each module lives.',
        tip: 'Press Ctrl+K anywhere to search customers, products, invoices, and more.',
      },
      {
        title: 'Set up company information',
        detail: 'Go to Settings → General to configure your company name, trade license, phone, email, address, currency, and date format. This information appears across invoices and reports.',
        link: '/settings',
      },
      {
        title: 'Configure your profile',
        detail: 'In Settings → Profile, update your full name and phone number. In Settings → Security, you can change your password at any time.',
        link: '/settings',
      },
    ],
    tips: [
      'The sidebar groups related modules (Inventory, Sales, Purchases, CRM) with expandable sub-menus.',
      'The header date badge shows the current reporting period.',
    ],
  },
  {
    id: 'dashboard',
    title: 'Dashboard — Your Command Center',
    category: 'Onboarding',
    icon: LayoutDashboard,
    iconColor: 'bg-indigo-50 text-indigo-600',
    summary: 'Get a bird\u2019s-eye view of today\u2019s sales, inventory, deliveries, and more.',
    steps: [
      {
        title: 'Read the KPI cards',
        detail: 'The top row shows Today\u2019s Sales, Monthly Revenue, Inventory Value, Pending Deliveries, Receivables, Payables, Quotations, and Active Projects. Each card updates live as transactions are recorded.',
        link: '/dashboard',
      },
      {
        title: 'Use Quick Actions',
        detail: 'The Quick Actions strip lets you jump straight to creating a new sale, purchase, quotation, customer, delivery, expense, POS sale, or project without hunting through menus.',
      },
      {
        title: 'Review charts',
        detail: 'The Sales Overview area chart shows 6-month sales and profit trends. The Inventory by Category donut shows how your stock value is distributed.',
      },
      {
        title: 'Monitor alerts',
        detail: 'Low Stock Alert highlights products below their minimum level. Outstanding Dues lists customers with unpaid balances. Recent Activities shows the latest system actions.',
        tip: 'Click "View all" on any dashboard card to jump to the full module.',
      },
    ],
  },
  {
    id: 'inventory-products',
    title: 'Inventory — Products & Stock',
    category: 'Operations',
    icon: Package,
    iconColor: 'bg-teal-50 text-teal-600',
    summary: 'Add products, set prices, manage multi-unit configurations, and track stock levels.',
    steps: [
      {
        title: 'Add a new product',
        detail: 'Go to Inventory → Products and click "Add Product". Fill in SKU, name, category, brand, unit, cost price, sale price, and minimum stock level. You can also enable multi-unit, colors, and sizes.',
        link: '/inventory',
      },
      {
        title: 'Set up multi-unit pricing',
        detail: 'If a product sells in multiple units (e.g., bag and ton), enable multi-unit and define each unit with a conversion factor and its own price. The POS and invoicing screens will let you pick the unit at sale time.',
        tip: 'The base unit is what stock is tracked in. Sale units convert from the base.',
      },
      {
        title: 'Track stock levels',
        detail: 'Each product shows current on-hand quantity, reserved quantity, and available quantity. Low-stock items are flagged automatically based on the minimum stock level you set.',
      },
      {
        title: 'Import products in bulk',
        detail: 'The inventory page supports importing products from CSV files. This is useful when onboarding a large catalog from a spreadsheet.',
        tip: 'Make sure categories and brands exist before importing products that reference them.',
      },
    ],
    warnings: [
      'Deleting a product that has existing invoices or purchase orders may cause reporting inconsistencies. Deactivate instead.',
    ],
  },
  {
    id: 'stock-movements',
    title: 'Stock Movements & Transfers',
    category: 'Operations',
    icon: Boxes,
    iconColor: 'bg-amber-50 text-amber-600',
    summary: 'Audit every stock change and move inventory between warehouses.',
    steps: [
      {
        title: 'Review stock movements',
        detail: 'The Stock Movements page is a complete audit trail — purchases, sales, adjustments, transfers, and damages. Every entry shows the product, warehouse, type, quantity, and reference.',
        link: '/inventory/movements',
      },
      {
        title: 'Transfer stock between warehouses',
        detail: 'Go to Stock Transfers, click "New Transfer", select a product, the source warehouse, the destination warehouse, and the quantity. The system validates that enough stock exists at the source.',
        link: '/inventory/transfers',
        tip: 'Transfers create two movement records (out from source, in to destination) for a clean audit trail.',
      },
      {
        title: 'Manage warehouses',
        detail: 'Under Warehouses you can add storage locations, mark one as default, and set addresses. New stock receipts default to the default warehouse.',
        link: '/inventory/warehouses',
      },
    ],
  },
  {
    id: 'crm-customers',
    title: 'CRM — Customers',
    category: 'Operations',
    icon: Users,
    iconColor: 'bg-pink-50 text-pink-600',
    summary: 'Create customer records, set credit limits, and track outstanding balances.',
    steps: [
      {
        title: 'Add a customer',
        detail: 'Go to CRM → Customers and click "Add Customer". Enter name, code, type (retail, contractor, builder, etc.), contact details, and credit terms.',
        link: '/crm',
      },
      {
        title: 'Set credit limits and days',
        detail: 'Each customer has a credit limit and credit days. These help you control how much credit you extend and how long they have to pay.',
        tip: 'The customer\u2019s outstanding balance updates automatically as invoices and payments are recorded.',
      },
      {
        title: 'View customer details',
        detail: 'Click the eye icon on any customer to see their full profile — contact info, credit summary, invoices, manual receivables, quotations, and deliveries in one place.',
        link: '/crm',
      },
    ],
  },
  {
    id: 'quotations',
    title: 'Quotations',
    category: 'Sales',
    icon: FileText,
    iconColor: 'bg-orange-50 text-orange-600',
    summary: 'Create price quotes, send them to customers, and convert accepted quotes into invoices.',
    steps: [
      {
        title: 'Create a quotation',
        detail: 'Go to Quotations → New Quotation. Select a customer (or add a new one inline), set issue and expiry dates, then search and add products as line items with quantities, prices, and per-line discounts.',
        link: '/quotations',
      },
      {
        title: 'Send the quotation',
        detail: 'Quotations start in "Draft" status. Click the send icon to mark it as "Sent". The status then progresses through Viewed → Accepted/Rejected.',
        tip: 'You can add a new customer without leaving the quotation form using the + button.',
      },
      {
        title: 'Convert to invoice',
        detail: 'When a customer accepts, click the convert arrow icon. A modal lets you choose payment type (full credit, partial, or full payment), record an initial payment, and instantly generate a linked invoice.',
        link: '/quotations',
      },
    ],
  },
  {
    id: 'sales-invoices',
    title: 'Sales — Invoices',
    category: 'Sales',
    icon: ShoppingCart,
    iconColor: 'bg-blue-50 text-blue-600',
    summary: 'Create invoices, record payments, and track outstanding balances.',
    steps: [
      {
        title: 'Create an invoice',
        detail: 'Go to Sales → Invoices and create a new invoice. Select a customer, add products as line items, apply discounts, and choose a payment type (credit, partial, or full). The invoice status and customer balance update automatically.',
        link: '/sales',
        tip: 'When an invoice is created, stock is deducted and COGS is recorded automatically via database triggers.',
      },
      {
        title: 'Record a payment',
        detail: 'For invoices with outstanding balances, click the payment (dollar) icon. Enter the amount, payment method, date, and reference number. The invoice status updates to "Paid" or "Partially Paid".',
      },
      {
        title: 'View invoice details',
        detail: 'Click the eye icon to open the full invoice view — line items, totals, payments, and status. You can print the invoice from this view.',
        tip: 'Accounting journal entries are posted automatically when invoices and payments are created.',
      },
    ],
  },
  {
    id: 'pos',
    title: 'POS — Point of Sale',
    category: 'Sales',
    icon: Receipt,
    iconColor: 'bg-purple-50 text-purple-600',
    summary: 'Fast counter sales with barcode scanning, multi-unit selection, and instant checkout.',
    steps: [
      {
        title: 'Add products to the cart',
        detail: 'Search products by name or SKU. Click a product tile to add it to the cart. For multi-unit products, a unit selector appears so you can choose the selling unit.',
        link: '/sales/pos',
      },
      {
        title: 'Scan barcodes',
        detail: 'Click the camera/scan button to open the barcode scanner. If the browser supports it, the camera detects barcodes automatically. Otherwise, type the SKU manually.',
        tip: 'The scanner works best in Chrome and Edge on devices with a camera.',
      },
      {
        title: 'Apply discounts and checkout',
        detail: 'Set a cart-wide discount percentage, choose a payment method (cash, card, mobile banking, etc.), select a customer (or walk-in), then click "Charge". A paid POS invoice is created instantly.',
        link: '/sales/pos',
      },
    ],
    tips: [
      'You can add a new customer on the fly during a POS sale using the + button next to the customer selector.',
      'Stock is deducted in real-time as POS sales complete.',
    ],
  },
  {
    id: 'sales-returns',
    title: 'Sales Returns & Refunds',
    category: 'Sales',
    icon: ArrowRightLeft,
    iconColor: 'bg-red-50 text-red-600',
    summary: 'Process customer returns with automatic accounting, stock restoration, and refunds.',
    steps: [
      {
        title: 'Select an invoice',
        detail: 'Go to Sales → Returns and click "New Return". Pick the invoice the customer is returning from. Only invoices with paid or partially-paid status are eligible.',
        link: '/sales/returns',
      },
      {
        title: 'Choose items and quantities',
        detail: 'For each line item, enter how many units are being returned (up to the remaining returnable quantity) and select a reason (defective, wrong item, changed mind, etc.).',
      },
      {
        title: 'Select a refund method',
        detail: 'Choose how to refund — cash, bank transfer, mobile banking, or store credit. The system creates the correct journal entries, restores stock, and updates the invoice and customer balance automatically.',
        tip: 'Store credit increases what the customer is owed for future purchases.',
      },
    ],
    tips: [
      'Every return creates a full double-entry journal posting (Sales Returns, AR/Cash, Inventory, COGS).',
      'View any past return to see the journal entry that was generated.',
    ],
  },
  {
    id: 'purchases',
    title: 'Purchases — Purchase Orders',
    category: 'Purchases',
    icon: ShoppingBag,
    iconColor: 'bg-emerald-50 text-emerald-600',
    summary: 'Create POs for suppliers, record payments, and manage procurement.',
    steps: [
      {
        title: 'Create a purchase order',
        detail: 'Go to Purchases → Purchase Orders and click "New Purchase Order". Select a supplier (or add a new one inline), add products with quantities and costs, and choose a payment type.',
        link: '/purchases',
      },
      {
        title: 'Approve and receive',
        detail: 'Open the PO and click "Approve Order" to move it from Draft to Approved. Once goods arrive, click "Mark as Received" — stock is added to inventory and stock movements are recorded.',
        tip: 'You can also receive goods via GRN for partial deliveries.',
      },
      {
        title: 'Record supplier payments',
        detail: 'For POs with outstanding balances, click the payment icon to record a payment to the supplier. The supplier\u2019s outstanding payable balance updates automatically.',
      },
    ],
  },
  {
    id: 'grn',
    title: 'Goods Receipt Notes (GRN)',
    category: 'Purchases',
    icon: ClipboardList,
    iconColor: 'bg-cyan-50 text-cyan-600',
    summary: 'Verify and record incoming stock against purchase orders or as direct receipts.',
    steps: [
      {
        title: 'Receive against a PO',
        detail: 'Go to Purchases → GRN → New GRN, select an approved or partially-received PO, and enter the received quantity for each line item. The PO status and received quantities update automatically.',
        link: '/purchases/grn',
      },
      {
        title: 'Direct receipt (no PO)',
        detail: 'If goods arrive without a purchase order, switch to "Direct Receipt" mode, select a supplier and warehouse, and record the items received.',
        tip: 'GRN entries create stock-in movements and update inventory on hand.',
      },
    ],
  },
  {
    id: 'purchase-returns',
    title: 'Purchase Returns',
    category: 'Purchases',
    icon: ArrowRightLeft,
    iconColor: 'bg-amber-50 text-amber-600',
    summary: 'Return defective or unwanted items to suppliers with credit notes.',
    steps: [
      {
        title: 'Select a received PO',
        detail: 'Go to Purchases → Returns → New Return and pick a received or partially-received purchase order.',
        link: '/purchases/returns',
      },
      {
        title: 'Choose items and reasons',
        detail: 'Enter return quantities (up to what was received) and select a reason. The system reduces stock, creates a return-out movement, and issues a credit note against the supplier.',
        tip: 'The credit note reduces the amount you owe that supplier.',
      },
    ],
  },
  {
    id: 'suppliers',
    title: 'Suppliers',
    category: 'Purchases',
    icon: Building2,
    iconColor: 'bg-orange-50 text-orange-600',
    summary: 'Manage vendor accounts, credit terms, and ratings.',
    steps: [
      {
        title: 'Add a supplier',
        detail: 'Go to Suppliers and click "Add Supplier". Enter name, code, company, contact details, credit limit, credit days, and a quality rating (1-5 stars).',
        link: '/suppliers',
      },
      {
        title: 'View supplier details',
        detail: 'Click the eye icon to see the supplier\u2019s full profile — purchase orders, payments, outstanding payables, and manual payables.',
      },
    ],
  },
  {
    id: 'delivery',
    title: 'Delivery Management',
    category: 'Operations',
    icon: Truck,
    iconColor: 'bg-rose-50 text-rose-600',
    summary: 'Create deliveries, assign vehicles, and track status from pending to delivered.',
    steps: [
      {
        title: 'Create a delivery',
        detail: 'Go to Delivery → Create Delivery. Select a customer (address auto-fills), set the delivery date, vehicle number, and delivery address.',
        link: '/delivery',
      },
      {
        title: 'Update delivery status',
        detail: 'Use the status dropdown on each delivery row to move it through Pending → Assigned → In Transit → Delivered (or Failed/Returned). Marking as delivered stamps the delivery time.',
        tip: 'Dashboard delivery counters update live as statuses change.',
      },
    ],
  },
  {
    id: 'projects',
    title: 'Projects',
    category: 'Operations',
    icon: FolderKanban,
    iconColor: 'bg-violet-50 text-violet-600',
    summary: 'Track construction or supply projects with budgets, progress, and timelines.',
    steps: [
      {
        title: 'Create a project',
        detail: 'Go to Projects → New Project. Enter the project name, link a customer, set status, priority, start/end dates, estimated budget, and location.',
        link: '/projects',
      },
      {
        title: 'Track progress',
        detail: 'Update the progress percentage as work advances. The grid and list views show visual progress bars. Active projects appear on the dashboard.',
        tip: 'Switch between grid and list views using the toggle in the filter bar.',
      },
    ],
  },
  {
    id: 'accounting-overview',
    title: 'Accounting — Overview & Automation',
    category: 'Accounting',
    icon: Calculator,
    iconColor: 'bg-green-50 text-green-600',
    summary: 'Understand how the ERP automates double-entry bookkeeping.',
    steps: [
      {
        title: 'Understand automatic postings',
        detail: 'Every invoice, payment, purchase, goods receipt, sales return, and purchase return automatically creates balanced journal entries. You rarely need to post entries manually.',
        link: '/accounting',
        tip: 'The Accounting Overview page summarizes cash flow, receivables, payables, and recent entries.',
      },
      {
        title: 'Review the chart of accounts',
        detail: 'Under Chart of Accounts you can see all ledger accounts (assets, liabilities, equity, revenue, expenses) with their current balances. Add or edit accounts as needed.',
        link: '/accounting/accounts',
      },
    ],
    tips: [
      'Account balances are maintained automatically as journal entries are posted.',
      'The P&L Statement pulls real figures from your journal entries and stock movements.',
    ],
  },
  {
    id: 'journal',
    title: 'Journal Entries & Expenses',
    category: 'Accounting',
    icon: BookOpen,
    iconColor: 'bg-blue-50 text-blue-600',
    summary: 'Record manual expenses like rent, salaries, and utilities using plain-English templates.',
    steps: [
      {
        title: 'Use quick templates',
        detail: 'Go to Journal Entries → Record Expense and pick from templates like Rent Payment, Salary Payment, Utility Bill, Bank Deposit, Bank Withdrawal, Transport, Marketing, or Owner Withdrawal. Just enter an amount and date.',
        link: '/accounting/journal',
        tip: 'Templates handle the debit/credit mapping for you — no accounting knowledge needed.',
      },
      {
        title: 'Custom entries (advanced)',
        detail: 'Switch to the Custom Entry tab to post multi-line journal entries with specific accounts, debits, and credits. The system enforces that debits equal credits before posting.',
      },
      {
        title: 'Record everyday expenses',
        detail: 'The Expenses page is a simplified view focused on expense transactions. Add an expense, pick a category (or create a new one), select the payment source, and save.',
        link: '/expenses',
      },
    ],
  },
  {
    id: 'aging',
    title: 'Aging & Dues',
    category: 'Accounting',
    icon: TrendingUp,
    iconColor: 'bg-amber-50 text-amber-600',
    summary: 'See who owes you and who you owe, broken down by aging buckets.',
    steps: [
      {
        title: 'Switch between receivables and payables',
        detail: 'The Aging page has two tabs: Receivables (customers) and Payables (suppliers). Each shows outstanding amounts bucketed into Current, 1-30, 31-60, 61-90, and Over 90 days.',
        link: '/accounting/aging',
      },
      {
        title: 'Drill into details',
        detail: 'Click any customer or supplier row to expand and see the individual invoices or purchase orders that make up the outstanding balance, with days overdue.',
        tip: 'Use the print button to generate a hard copy of the aging report.',
      },
    ],
  },
  {
    id: 'payment-methods',
    title: 'Payment Methods',
    category: 'Accounting',
    icon: CreditCard,
    iconColor: 'bg-teal-50 text-teal-600',
    summary: 'Configure the payment options available during sales and purchases.',
    steps: [
      {
        title: 'Add a payment method',
        detail: 'Go to Accounting → Payment Methods → Add Method. Enter a name (e.g., bKash, Cash, City Bank), a code, an icon, and link it to a cash or bank account from your chart of accounts.',
        link: '/accounting/payment-methods',
      },
      {
        title: 'Reorder and activate',
        detail: 'Use the up/down arrows to reorder methods — the order controls how they appear in POS and invoice payment screens. Toggle methods active or inactive as needed.',
        tip: 'Payments recorded with a linked account update that account\u2019s balance automatically.',
      },
    ],
  },
  {
    id: 'online-store',
    title: 'Online Store',
    category: 'Operations',
    icon: Store,
    iconColor: 'bg-indigo-50 text-indigo-600',
    summary: 'Monitor e-commerce orders and revenue.',
    steps: [
      {
        title: 'Review online orders',
        detail: 'The Online Store page lists all e-commerce orders with customer info, payment method, amount, and status. Filter by status to find pending or delivered orders.',
        link: '/online-store',
      },
      {
        title: 'Track store metrics',
        detail: 'Stat cards show visitors, total orders, online revenue, and pending orders. The banner summarizes your live store with product count and conversion rate.',
      },
    ],
  },
  {
    id: 'employees',
    title: 'Employees & Payroll',
    category: 'Operations',
    icon: UserRound,
    iconColor: 'bg-pink-50 text-pink-600',
    summary: 'Manage staff records, departments, and monthly payroll.',
    steps: [
      {
        title: 'Add an employee',
        detail: 'Go to Employees → Add Employee. Enter full name, employee ID, designation, department, email, phone, salary, and join date.',
        link: '/employees',
      },
      {
        title: 'Track status',
        detail: 'Each employee can be Active, On Leave, Resigned, or Terminated. The dashboard cards show total staff, active count, departments, and total monthly payroll.',
        tip: 'Use the Salary Payment template in Journal Entries to record payroll.',
      },
    ],
  },
  {
    id: 'reports',
    title: 'Reports & Analytics',
    category: 'Reports',
    icon: BarChart3,
    iconColor: 'bg-blue-50 text-blue-600',
    summary: 'Generate sales, inventory, customer, and profit & loss reports.',
    steps: [
      {
        title: 'Choose a report tab',
        detail: 'The Reports page has tabs for Overview, Sales, Inventory, Customers, and P&L. Each tab shows relevant charts and tables for the selected period.',
        link: '/reports',
      },
      {
        title: 'Filter by period',
        detail: 'Use the period selector (Today, This Week, This Month, This Year) to scope the data. Charts and KPIs recalculate instantly.',
      },
      {
        title: 'Export to CSV',
        detail: 'Click "Export CSV" to download the current report data as a spreadsheet for offline analysis or sharing.',
        tip: 'The P&L Statement page has its own dedicated view with revenue, COGS, gross profit, and operating expense breakdowns.',
        link: '/reports/pl',
      },
      {
        title: 'Inventory valuation report',
        detail: 'The Inventory Report shows every product with on-hand, reserved, available, and stock value — useful for stock audits and insurance valuation.',
        link: '/reports/inventory',
      },
    ],
  },
  {
    id: 'settings',
    title: 'Settings & Data Management',
    category: 'Administration',
    icon: Settings,
    iconColor: 'bg-slate-100 text-slate-600',
    summary: 'Configure company info, notifications, appearance, and manage data.',
    steps: [
      {
        title: 'General settings',
        detail: 'Set company name, trade license, contact details, currency, and date format. These appear on printed invoices and reports.',
        link: '/settings',
      },
      {
        title: 'Notifications',
        detail: 'Toggle alerts for low stock, new orders, payment received, overdue invoices, delivery updates, and PO approvals.',
      },
      {
        title: 'Appearance',
        detail: 'Switch between light and dark mode, choose a color theme, and select desktop or mobile interface mode.',
        tip: 'Dark mode is a toggle — it does not change data, only the visual theme.',
      },
      {
        title: 'Data management',
        detail: 'Under Settings → Data you can clear all seed/demo data, reset categories and brands, or re-seed sample data. Use with caution — these actions are irreversible.',
        link: '/settings',
      },
    ],
    warnings: [
      'Clearing all data removes products, customers, and transactions permanently. Always export reports first.',
    ],
  },
];

const categoryColors: Record<string, string> = {
  Onboarding: 'bg-blue-100 text-blue-700',
  Operations: 'bg-teal-100 text-teal-700',
  Sales: 'bg-indigo-100 text-indigo-700',
  Purchases: 'bg-emerald-100 text-emerald-700',
  Accounting: 'bg-green-100 text-green-700',
  Reports: 'bg-purple-100 text-purple-700',
  Administration: 'bg-slate-200 text-slate-700',
};

export default function GuidePage() {
  const [search, setSearch] = useState('');
  const [activeId, setActiveId] = useState<string>(sections[0].id);
  const [expanded, setExpanded] = useState<Set<string>>(new Set([sections[0].id]));
  const [filterCategory, setFilterCategory] = useState('');

  const categories = useMemo(
    () => Array.from(new Set(sections.map(s => s.category))),
    []
  );

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return sections.filter(s => {
      const matchesSearch = !q ||
        s.title.toLowerCase().includes(q) ||
        s.summary.toLowerCase().includes(q) ||
        s.steps.some(st => st.title.toLowerCase().includes(q) || st.detail.toLowerCase().includes(q));
      const matchesCategory = !filterCategory || s.category === filterCategory;
      return matchesSearch && matchesCategory;
    });
  }, [search, filterCategory]);

  function toggleSection(id: string) {
    setActiveId(id);
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const activeSection = sections.find(s => s.id === activeId);

  return (
    <div className="flex gap-6 animate-fade-in max-w-[1200px]">
      {/* Left: Navigation */}
      <div className="w-72 shrink-0 hidden lg:block">
        <div className="sticky top-20 space-y-4">
          <div className="bg-white rounded-xl border border-border shadow-sm p-4">
            <div className="flex items-center gap-2 mb-3">
              <BookOpen className="w-4 h-4 text-blue-600" />
              <h2 className="text-sm font-bold text-foreground">User Guide</h2>
            </div>
            <div className="relative mb-3">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search guide..."
                className="w-full pl-8 pr-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
            </div>
            <select
              value={filterCategory}
              onChange={e => setFilterCategory(e.target.value)}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none"
            >
              <option value="">All Categories</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <nav className="space-y-0.5 max-h-[60vh] overflow-y-auto scrollbar-thin pr-1">
              {filtered.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-4">No sections found</p>
              ) : filtered.map(s => (
                <button
                  key={s.id}
                  onClick={() => toggleSection(s.id)}
                  className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-sm transition ${activeId === s.id ? 'bg-blue-50 text-blue-700 font-semibold' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
                >
                  <s.icon className="w-4 h-4 shrink-0" />
                  <span className="flex-1 text-xs leading-tight">{s.title}</span>
                </button>
              ))}
            </nav>
          </div>

          <div className="bg-gradient-to-br from-blue-600 to-blue-700 rounded-xl p-4 text-white">
            <Lightbulb className="w-5 h-5 mb-2" />
            <p className="text-sm font-semibold mb-1">Need a quick start?</p>
            <p className="text-blue-100 text-xs leading-relaxed mb-3">
              Follow the Getting Started section first — it covers login, setup, and the dashboard.
            </p>
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-1.5 bg-white/20 hover:bg-white/30 rounded-lg px-3 py-1.5 text-xs font-semibold transition"
            >
              Go to Dashboard <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
        </div>
      </div>

      {/* Right: Content */}
      <div className="flex-1 min-w-0 space-y-4">
        {/* Mobile search */}
        <div className="lg:hidden bg-white rounded-xl border border-border shadow-sm p-4 space-y-3">
          <div className="flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-blue-600" />
            <h1 className="text-lg font-bold text-foreground">User Guide</h1>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search guide..."
              className="w-full pl-8 pr-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
          </div>
        </div>

        {/* Mobile category filter */}
        <div className="lg:hidden flex gap-2 overflow-x-auto pb-1">
          <button
            onClick={() => setFilterCategory('')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition ${!filterCategory ? 'bg-blue-600 text-white' : 'bg-white border border-border text-muted-foreground'}`}
          >
            All
          </button>
          {categories.map(c => (
            <button
              key={c}
              onClick={() => setFilterCategory(c)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition ${filterCategory === c ? 'bg-blue-600 text-white' : 'bg-white border border-border text-muted-foreground'}`}
            >
              {c}
            </button>
          ))}
        </div>

        {/* Intro card */}
        <div className="bg-white rounded-xl border border-border shadow-sm p-6">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 bg-gradient-to-br from-blue-500 to-blue-700 rounded-xl flex items-center justify-center shrink-0">
              <BookOpen className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">SI Building Solutions ERP — Complete Guide</h1>
              <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
                This guide walks you through every module of the ERP, from your first login to advanced workflows like returns, accounting automation, and reporting. Use the navigation panel to jump to any section, or search to find exactly what you need.
              </p>
              <div className="flex flex-wrap gap-2 mt-3">
                <span className={`badge-status ${categoryColors['Onboarding']}`}>{sections.length} Sections</span>
                <span className="badge-status bg-green-50 text-green-600">Interactive</span>
                <span className="badge-status bg-orange-50 text-orange-600">Searchable</span>
              </div>
            </div>
          </div>
        </div>

        {/* Section cards */}
        {filtered.map((section, idx) => {
          const isOpen = expanded.has(section.id) || activeId === section.id;
          return (
            <div
              key={section.id}
              className={`bg-white rounded-xl border shadow-sm overflow-hidden transition-all ${activeId === section.id ? 'border-blue-300 ring-1 ring-blue-200' : 'border-border'}`}
            >
              <button
                onClick={() => toggleSection(section.id)}
                className="w-full flex items-center gap-3 p-4 text-left hover:bg-muted/30 transition"
              >
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${section.iconColor}`}>
                  <section.icon className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-sm font-bold text-foreground">{section.title}</h3>
                    <span className={`badge-status text-[10px] ${categoryColors[section.category] || 'bg-gray-100 text-gray-600'}`}>{section.category}</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{section.summary}</p>
                </div>
                {isOpen ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
              </button>

              {isOpen && (
                <div className="px-4 pb-4 animate-fade-in">
                  <div className="border-t border-border pt-4 space-y-4">
                    {/* Steps */}
                    <div className="space-y-3">
                      {section.steps.map((step, i) => (
                        <div key={i} className="flex gap-3">
                          <div className="flex flex-col items-center shrink-0">
                            <div className="w-7 h-7 rounded-full bg-blue-600 text-white text-xs font-bold flex items-center justify-center">
                              {i + 1}
                            </div>
                            {i < section.steps.length - 1 && <div className="w-0.5 flex-1 bg-border mt-1" />}
                          </div>
                          <div className="flex-1 pb-3">
                            <p className="text-sm font-semibold text-foreground">{step.title}</p>
                            <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{step.detail}</p>
                            {step.tip && (
                              <div className="mt-2 flex items-start gap-1.5 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-1.5">
                                <Lightbulb className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
                                <p className="text-xs text-amber-700">{step.tip}</p>
                              </div>
                            )}
                            {step.link && (
                              <Link
                                href={step.link}
                                className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-blue-600 hover:text-blue-700 transition"
                              >
                                <Play className="w-3 h-3" /> Open this module <ArrowRight className="w-3 h-3" />
                              </Link>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Tips */}
                    {section.tips && section.tips.length > 0 && (
                      <div className="bg-green-50 border border-green-100 rounded-lg p-3">
                        <p className="text-xs font-semibold text-green-700 mb-1.5 flex items-center gap-1.5">
                          <CircleCheck className="w-3.5 h-3.5" /> Pro Tips
                        </p>
                        <ul className="space-y-1">
                          {section.tips.map((t, i) => (
                            <li key={i} className="text-xs text-green-700 flex items-start gap-1.5">
                              <span className="text-green-400 mt-0.5">•</span> {t}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Warnings */}
                    {section.warnings && section.warnings.length > 0 && (
                      <div className="bg-red-50 border border-red-100 rounded-lg p-3">
                        <p className="text-xs font-semibold text-red-700 mb-1.5 flex items-center gap-1.5">
                          <CircleAlert className="w-3.5 h-3.5" /> Important
                        </p>
                        <ul className="space-y-1">
                          {section.warnings.map((w, i) => (
                            <li key={i} className="text-xs text-red-700 flex items-start gap-1.5">
                              <span className="text-red-400 mt-0.5">•</span> {w}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {filtered.length === 0 && (
          <div className="bg-white rounded-xl border border-border shadow-sm p-12 text-center">
            <Search className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm font-semibold text-foreground">No guide sections found</p>
            <p className="text-xs text-muted-foreground mt-1">Try a different search term or category filter.</p>
          </div>
        )}

        {/* Footer */}
        <div className="bg-white rounded-xl border border-border shadow-sm p-5 flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Info className="w-4 h-4" />
            <span>This guide reflects the current ERP modules. As new features are added, this guide is updated.</span>
          </div>
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg px-4 py-2 text-xs font-semibold transition"
          >
            Back to Dashboard <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>
    </div>
  );
}
