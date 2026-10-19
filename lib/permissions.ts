// Role → module access matrix. Longest matching route prefix wins; routes
// not listed here stay open (fail-open) so unlisted pages never lock users
// out. A null/unknown role always has access — the ERP must still work when
// the profile can't be fetched (e.g. offline).
//
// Only routes are gated here. DB-level write enforcement lives in
// supabase/migrations/20261019000000_role_rls_tightening.sql.

export type Role =
  | 'super_admin'
  | 'manager'
  | 'sales_executive'
  | 'inventory_manager'
  | 'accountant'
  | 'delivery_staff';

export const ROLE_LIST: Role[] = [
  'super_admin',
  'manager',
  'sales_executive',
  'inventory_manager',
  'accountant',
  'delivery_staff',
];

const ALL_ROLES = ROLE_LIST;

const MANAGEMENT: Role[] = ['super_admin', 'manager'];

interface RouteRule {
  prefix: string;
  roles: Role[];
}

const ROUTE_RULES: RouteRule[] = [
  { prefix: '/accounting/aging', roles: [...MANAGEMENT, 'accountant', 'sales_executive'] },
  { prefix: '/accounting', roles: [...MANAGEMENT, 'accountant'] },
  { prefix: '/sales/pos', roles: [...MANAGEMENT, 'sales_executive'] },
  { prefix: '/sales/refunds', roles: [...MANAGEMENT, 'accountant'] },
  { prefix: '/sales', roles: [...MANAGEMENT, 'sales_executive', 'accountant'] },
  { prefix: '/inventory', roles: [...MANAGEMENT, 'inventory_manager'] },
  { prefix: '/purchases', roles: [...MANAGEMENT, 'inventory_manager'] },
  { prefix: '/suppliers', roles: [...MANAGEMENT, 'inventory_manager'] },
  { prefix: '/crm', roles: [...MANAGEMENT, 'sales_executive'] },
  { prefix: '/quotations', roles: [...MANAGEMENT, 'sales_executive'] },
  { prefix: '/expenses', roles: [...MANAGEMENT, 'accountant'] },
  { prefix: '/delivery', roles: [...ALL_ROLES] },
  { prefix: '/online-store', roles: MANAGEMENT },
  { prefix: '/employees', roles: MANAGEMENT },
  { prefix: '/hr', roles: MANAGEMENT },
  { prefix: '/reports/inventory', roles: [...MANAGEMENT, 'inventory_manager'] },
  { prefix: '/reports/sales', roles: [...MANAGEMENT, 'accountant', 'sales_executive'] },
  { prefix: '/reports', roles: [...MANAGEMENT, 'accountant'] },
  { prefix: '/dashboard', roles: ALL_ROLES },
  { prefix: '/settings', roles: ALL_ROLES },
  { prefix: '/sync', roles: ALL_ROLES },
  { prefix: '/guide', roles: ALL_ROLES },
];

function matches(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + '/');
}

/**
 * Per-user overrides from the user_module_access table, keyed by module
 * prefix. Overrides cascade: an entry for a module wins over the role
 * default for that module and everything under it (e.g. denying /sales
 * also denies /sales/pos), unless a more specific override exists.
 * Missing entries fall back to the role matrix.
 */
export type ModuleOverrides = Record<string, boolean>;

export function canAccessRoute(
  role: string | null | undefined,
  pathname: string,
  overrides?: ModuleOverrides | null,
): boolean {
  if (!role) return true;
  let best: RouteRule | null = null;
  const matching: string[] = [];
  for (const rule of ROUTE_RULES) {
    if (!matches(pathname, rule.prefix)) continue;
    matching.push(rule.prefix);
    if (!best || rule.prefix.length > best.prefix.length) best = rule;
  }
  if (!best) return true;
  if (overrides) {
    // Most specific override wins; a parent-module override cascades down.
    for (const prefix of matching.sort((a, b) => b.length - a.length)) {
      if (Object.prototype.hasOwnProperty.call(overrides, prefix)) {
        return overrides[prefix];
      }
    }
  }
  return (best.roles as string[]).includes(role);
}

const MODULE_LABELS: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/sales': 'Sales — Invoices, Returns, Collections',
  '/sales/pos': 'Sales — POS',
  '/sales/refunds': 'Sales — Refunds',
  '/inventory': 'Inventory',
  '/purchases': 'Purchases & Purchase Orders',
  '/suppliers': 'Suppliers & GRN',
  '/crm': 'CRM — Customers, Advances, Store Credit',
  '/quotations': 'Quotations',
  '/accounting': 'Accounting — Ledger, Reports',
  '/accounting/aging': 'Accounting — Aging & Dues',
  '/expenses': 'Expenses',
  '/delivery': 'Delivery',
  '/online-store': 'Online Store',
  '/employees': 'Employees',
  '/hr': 'HR Management — Attendance',
  '/reports': 'Reports',
  '/reports/inventory': 'Reports — Inventory',
  '/reports/sales': 'Reports — Sales',
  '/settings': 'Settings',
  '/sync': 'Sync',
  '/guide': 'Guide',
};

// Display order for the matrix; keys of MODULE_LABELS, broadest rule first.
const MODULE_ORDER = Object.keys(MODULE_LABELS);

// Human-readable view of the same rules the app enforces, used by the
// Users & Roles tab. Never hardcode access here — it mirrors ROUTE_RULES.
export function roleAccessMatrix(): { prefix: string; label: string; allRoles: boolean; access: Record<Role, boolean> }[] {
  return [...ROUTE_RULES]
    .sort((a, b) => {
      const ia = MODULE_ORDER.indexOf(a.prefix);
      const ib = MODULE_ORDER.indexOf(b.prefix);
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    })
    .map(rule => ({
    prefix: rule.prefix,
    label: MODULE_LABELS[rule.prefix] || rule.prefix,
    allRoles: rule.roles.length === ROLE_LIST.length,
    access: Object.fromEntries(
      ROLE_LIST.map(r => [r, (rule.roles as string[]).includes(r)]),
    ) as Record<Role, boolean>,
  }));
}
