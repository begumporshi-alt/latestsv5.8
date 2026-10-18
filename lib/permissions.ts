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

const ALL_ROLES: Role[] = [
  'super_admin',
  'manager',
  'sales_executive',
  'inventory_manager',
  'accountant',
  'delivery_staff',
];

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

export function canAccessRoute(role: string | null | undefined, pathname: string): boolean {
  if (!role) return true;
  let best: RouteRule | null = null;
  for (const rule of ROUTE_RULES) {
    if (matches(pathname, rule.prefix) && (!best || rule.prefix.length > best.prefix.length)) {
      best = rule;
    }
  }
  if (!best) return true;
  return (best.roles as string[]).includes(role);
}
