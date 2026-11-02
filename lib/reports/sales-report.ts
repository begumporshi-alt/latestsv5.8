/**
 * Sales report data layer — types, period resolution and fetchers.
 *
 * One rule governs this module: a number must mean the same thing everywhere.
 * The server functions (supabase/migrations/20261103020000_sales_report_bundle.sql)
 * compute revenue as the invoice-line subtotal with the invoice's cart
 * discount allocated pro-rata, so summing ANY dimension reproduces the KPI
 * revenue exactly. Nothing here re-derives or re-rounds a total.
 *
 * Three sources, in order of preference:
 *   server  — the live RPC.
 *   cache   — the last successful result, served by lib/offline's read
 *             fallback (which is why 'sales_' is in READ_RPC_PREFIXES).
 *   replica — computed locally from the offline replica when this exact
 *             period was never loaded online. See sales-report-offline.ts.
 */

import { supabase } from '@/lib/supabase';
import { fetchAll } from '@/lib/fetch-all';

export type Dimension = 'product' | 'brand' | 'category' | 'customer';
export type View = 'summary' | Dimension;
export type DataSource = 'server' | 'cache' | 'replica';

export const DIMENSIONS: Dimension[] = ['product', 'brand', 'category', 'customer'];

export const DIMENSION_LABEL: Record<Dimension, string> = {
  product: 'Product',
  brand: 'Brand',
  category: 'Category',
  customer: 'Customer',
};

export interface BreakdownRow {
  id: string | null;
  name: string;
  unit: string | null;
  quantity: number;
  invoice_count: number;
  revenue: number;
  cost: number;
  profit: number;
}

export interface SalesKpis {
  revenue: number;
  orders: number;
  returns: number;
  /** COGS from the ledger (account 5000) — the same figure the P&L prints. */
  cogs: number;
  /** COGS from line cost_price — the basis the dimension tables use. */
  cogs_line: number;
  gross_profit: number;
  gross_profit_line: number;
  cart_discount: number;
  gross_subtotal: number;
  vat: number;
  shipping: number;
  avg_invoice: number;
}

export interface MonthlyRow {
  month: string;
  revenue: number;
  cost: number;
}

export interface DimensionPayload {
  /** How many members the dimension has in total (the list may be truncated). */
  total: number;
  rows: BreakdownRow[];
}

export interface SalesSummary {
  period: { start: string; end: string };
  kpis: SalesKpis;
  monthly: MonthlyRow[];
  dimensions: Record<Dimension, DimensionPayload>;
  source: DataSource;
  /** ms epoch the payload was produced/cached at, when known. */
  fetchedAt: number;
}

export interface SalesDetailRow {
  invoice_id: string;
  invoice_number: string;
  invoice_date: string;
  customer_name: string | null;
  quantity: number;
  revenue: number;
  cost: number;
}

/* ------------------------------------------------------------------ */
/* Periods                                                             */
/* ------------------------------------------------------------------ */

export type PeriodId =
  | 'today'
  | 'this_week'
  | 'this_month'
  | 'last_month'
  | 'this_quarter'
  | 'this_year'
  | 'custom';

export const PERIOD_OPTIONS: { id: PeriodId; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'this_week', label: 'This week' },
  { id: 'this_month', label: 'This month' },
  { id: 'last_month', label: 'Last month' },
  { id: 'this_quarter', label: 'This quarter' },
  { id: 'this_year', label: 'This year' },
  { id: 'custom', label: 'Custom range' },
];

const pad = (n: number) => String(n).padStart(2, '0');

/** Local calendar date. toISOString() would shift GMT+6 back a day. */
export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export interface ResolvedPeriod {
  start: string;
  end: string;
  label: string;
}

export function resolvePeriod(
  id: PeriodId,
  custom: { from: string; to: string } = { from: '', to: '' },
  now: Date = new Date(),
): ResolvedPeriod {
  const today = toISODate(now);
  const monthName = (d: Date) => d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  switch (id) {
    case 'today':
      return { start: today, end: today, label: now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) };
    case 'this_week': {
      const ws = new Date(now);
      ws.setDate(ws.getDate() - ws.getDay());
      return { start: toISODate(ws), end: today, label: 'This week' };
    }
    case 'this_month': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return { start: toISODate(start), end: today, label: monthName(start) };
    }
    case 'last_month': {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 0);
      return { start: toISODate(start), end: toISODate(end), label: monthName(start) };
    }
    case 'this_quarter': {
      const q = Math.floor(now.getMonth() / 3) * 3;
      const start = new Date(now.getFullYear(), q, 1);
      return { start: toISODate(start), end: today, label: `Q${q / 3 + 1} ${now.getFullYear()}` };
    }
    case 'this_year': {
      return { start: `${now.getFullYear()}-01-01`, end: today, label: String(now.getFullYear()) };
    }
    case 'custom':
    default: {
      const start = custom.from || today;
      const end = custom.to || today;
      return {
        start,
        end,
        label: start === end ? start : `${start} – ${end}`,
      };
    }
  }
}

/* ------------------------------------------------------------------ */
/* Normalisation                                                       */
/* ------------------------------------------------------------------ */

/**
 * PostgREST returns `numeric` as a JSON string; a jsonb payload returns real
 * numbers. Normalise both so callers never do arithmetic on a string.
 */
const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

function normaliseRow(row: Record<string, unknown>): BreakdownRow {
  const revenue = n(row.revenue);
  const cost = n(row.cost);
  return {
    id: (row.id as string | null) ?? null,
    name: String(row.name ?? '—'),
    unit: (row.unit as string | null) ?? null,
    quantity: n(row.quantity),
    invoice_count: n(row.invoice_count),
    revenue,
    cost,
    // Trust the server's profit when present; recomputing it here would let a
    // rounding difference creep between the row and the footer.
    profit: row.profit === undefined || row.profit === null ? revenue - cost : n(row.profit),
  };
}

/* ------------------------------------------------------------------ */
/* Fetchers                                                            */
/* ------------------------------------------------------------------ */

export const salesKeys = {
  all: ['sales-report'] as const,
  summary: (start: string, end: string) => ['sales-report', 'summary', start, end] as const,
  breakdown: (dim: Dimension, start: string, end: string) => ['sales-report', 'breakdown', dim, start, end] as const,
  detail: (dim: Dimension, id: string | null, start: string, end: string) =>
    ['sales-report', 'detail', dim, id, start, end] as const,
};

/** True when a Supabase result is the offline "no cached copy" sentinel. */
function isOfflineMiss(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null;
  if (!e) return false;
  return e.code === 'OFFLINE_NO_CACHE' || /offline and no cached copy/i.test(String(e.message || ''));
}

/** The browser reports no connection. Safe outside the browser. */
const isBrowserOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

export async function fetchSalesSummary(start: string, end: string): Promise<SalesSummary> {
  const { data, error, offline } = (await supabase.rpc('sales_report_summary', {
    p_start_date: start,
    p_end_date: end,
  })) as unknown as {
    data: any;
    error: { code?: string; message?: string } | null;
    offline?: boolean;
  };

  if (!error && data) {
    const dims = data.dimensions || {};
    const pick = (key: Dimension): DimensionPayload => ({
      total: n(dims[key]?.total),
      rows: Array.isArray(dims[key]?.rows) ? dims[key].rows.map(normaliseRow) : [],
    });
    return {
      period: data.period ?? { start, end },
      kpis: {
        revenue: n(data.kpis?.revenue),
        orders: n(data.kpis?.orders),
        returns: n(data.kpis?.returns),
        cogs: n(data.kpis?.cogs),
        cogs_line: n(data.kpis?.cogs_line),
        gross_profit: n(data.kpis?.gross_profit),
        gross_profit_line: n(data.kpis?.gross_profit_line),
        cart_discount: n(data.kpis?.cart_discount),
        gross_subtotal: n(data.kpis?.gross_subtotal),
        vat: n(data.kpis?.vat),
        shipping: n(data.kpis?.shipping),
        avg_invoice: n(data.kpis?.avg_invoice),
      },
      monthly: Array.isArray(data.monthly)
        ? data.monthly.map((m: Record<string, unknown>) => ({
            month: String(m.month ?? ''),
            revenue: n(m.revenue),
            cost: n(m.cost),
          }))
        : [],
      dimensions: {
        product: pick('product'),
        brand: pick('brand'),
        category: pick('category'),
        customer: pick('customer'),
      },
      source: offline ? 'cache' : 'server',
      fetchedAt: Date.now(),
    };
  }

  // No live result and no cached copy: compute from the offline replica.
  if (isOfflineMiss(error) || isBrowserOffline()) {
    const { offlineSalesSummary } = await import('./sales-report-offline');
    const computed = await offlineSalesSummary(start, end);
    if (computed) return computed;
  }

  throw new Error(error?.message || 'Could not load the sales report');
}

export async function fetchSalesBreakdown(
  dimension: Dimension,
  start: string,
  end: string,
): Promise<BreakdownRow[]> {
  try {
    const rows = await fetchAll<Record<string, unknown>>(() =>
      supabase.rpc('sales_report_breakdown', {
        p_dimension: dimension,
        p_start_date: start,
        p_end_date: end,
      }),
    );
    return rows.map(normaliseRow);
  } catch (err) {
    if (isOfflineMiss(err) || isBrowserOffline()) {
      const { offlineSalesBreakdown } = await import('./sales-report-offline');
      const rows = await offlineSalesBreakdown(dimension, start, end);
      if (rows) return rows;
    }
    throw err;
  }
}

export async function fetchSalesDetail(
  dimension: Dimension,
  dimensionId: string | null,
  start: string,
  end: string,
): Promise<SalesDetailRow[]> {
  const { data, error } = (await supabase.rpc('sales_report_detail', {
    p_dimension: dimension,
    p_dimension_id: dimensionId,
    p_start_date: start,
    p_end_date: end,
  })) as unknown as { data: any[] | null; error: { code?: string; message?: string } | null };

  if (error) {
    if (isOfflineMiss(error) || isBrowserOffline()) {
      const { offlineSalesDetail } = await import('./sales-report-offline');
      const rows = await offlineSalesDetail(dimension, dimensionId, start, end);
      if (rows) return rows;
    }
    throw new Error(error.message || 'Could not load the invoice list');
  }

  return (data || []).map((r) => ({
    invoice_id: String(r.invoice_id),
    invoice_number: String(r.invoice_number ?? ''),
    invoice_date: String(r.invoice_date ?? '').slice(0, 10),
    customer_name: r.customer_name ?? null,
    quantity: n(r.quantity),
    revenue: n(r.revenue),
    cost: n(r.cost),
  }));
}

/* ------------------------------------------------------------------ */
/* Derived helpers (pure)                                              */
/* ------------------------------------------------------------------ */

export const marginPct = (profit: number, revenue: number) =>
  revenue > 0 ? (profit / revenue) * 100 : 0;

export interface CompositionSlice {
  name: string;
  revenue: number;
  share: number;
  /** true for the rolled-up remainder */
  others?: boolean;
}

/**
 * Turn a (possibly truncated) ranked list into donut slices that add up to the
 * reported total.
 *
 * The summary payload carries only the top 12 members per dimension, so the
 * remainder must be derived from the headline total — NOT from summing the
 * rows we happen to hold. Summing the held rows is what makes a "Revenue by
 * product" donut claim 18% of revenue when it is showing 12 of 248 products.
 */
export function compositionSlices(
  rows: { name: string; revenue: number }[],
  limit: number,
  total: number,
  totalMembers?: number,
): CompositionSlice[] {
  const head = rows.slice(0, limit);
  const headSum = head.reduce((s, r) => s + r.revenue, 0);
  const remainder = Math.max(total - headSum, 0);
  const share = (v: number) => (total > 0 ? (v / total) * 100 : 0);

  const slices: CompositionSlice[] = head.map((r) => ({
    name: r.name,
    revenue: r.revenue,
    share: share(r.revenue),
  }));

  if (remainder > 0.5) {
    const remainingMembers =
      typeof totalMembers === 'number' && totalMembers > head.length
        ? totalMembers - head.length
        : null;
    slices.push({
      name: remainingMembers ? `Others (${remainingMembers})` : 'Others',
      revenue: remainder,
      share: share(remainder),
      others: true,
    });
  }

  return slices;
}
