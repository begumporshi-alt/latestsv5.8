/**
 * Sales report computed from the offline replica.
 *
 * The report RPCs are not `.from()` queries, so the replica query engine
 * cannot answer them. This module replays the same aggregation in memory over
 * the replicated tables (invoices, invoice_items, products, brands,
 * categories, customers, accounts, journal entries/lines) and returns the
 * exact shape the server returns — so the UI has one code path and one set of
 * column meanings in both modes.
 *
 * Cost control:
 *   - the whole report is computed in ONE pass over the line items and then
 *     sliced per dimension, mirroring the server's single-scan design;
 *   - the result is memoised per period, so switching tabs offline does not
 *     re-decrypt the replica;
 *   - the dataset itself is memoised briefly, because the drill-down needs it
 *     again right after the table renders.
 *
 * This is a fallback, not a substitute: figures are as of the last replica
 * sync, which the page surfaces in its offline banner.
 */

import { REPLICA, replicaRows, subscribeReplica } from '@/lib/offline/replica';
import type {
  BreakdownRow,
  Dimension,
  DimensionPayload,
  MonthlyRow,
  SalesDetailRow,
  SalesSummary,
} from './sales-report';

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

const day = (v: unknown): string => String(v ?? '').slice(0, 10);

interface ReplicaInvoice {
  id: string;
  invoice_number: string;
  invoice_date: string;
  customer_id: string | null;
  status: string;
  subtotal: unknown;
  discount_amount: unknown;
  tax_amount: unknown;
  shipping_cost: unknown;
}

interface ReplicaItem {
  invoice_id: string;
  product_id: string | null;
  quantity: unknown;
  unit_name: string | null;
  description: string | null;
  subtotal: unknown;
  cost_price: unknown;
}

interface Dataset {
  invoices: ReplicaInvoice[];
  items: ReplicaItem[];
  products: { id: string; name: string | null; brand_id: string | null; category_id: string | null }[];
  brands: { id: string; name: string | null }[];
  categories: { id: string; name: string | null }[];
  customers: { id: string; name: string | null }[];
  accounts: { id: string; code: string | null }[];
  entries: { id: string; entry_date: string | null }[];
  lines: { journal_entry_id: string; account_id: string; debit: unknown; credit: unknown }[];
}

const DATASET_TTL_MS = 30_000;
let datasetCache: { at: number; data: Dataset } | null = null;

async function loadDataset(): Promise<Dataset> {
  if (datasetCache && Date.now() - datasetCache.at < DATASET_TTL_MS) {
    return datasetCache.data;
  }
  const [invoices, items, products, brands, categories, customers, accounts, entries, lines] =
    await Promise.all([
      replicaRows<ReplicaInvoice>(REPLICA.Invoices),
      replicaRows<ReplicaItem>(REPLICA['Invoice items']),
      replicaRows<Dataset['products'][number]>(REPLICA.Products),
      replicaRows<Dataset['brands'][number]>(REPLICA.Brands),
      replicaRows<Dataset['categories'][number]>(REPLICA.Categories),
      replicaRows<Dataset['customers'][number]>(REPLICA.Customers),
      replicaRows<Dataset['accounts'][number]>(REPLICA.Accounts),
      replicaRows<Dataset['entries'][number]>(REPLICA['Journal entries']),
      replicaRows<Dataset['lines'][number]>(REPLICA['Journal lines']),
    ]);

  const data: Dataset = { invoices, items, products, brands, categories, customers, accounts, entries, lines };
  datasetCache = { at: Date.now(), data };
  return data;
}

interface Line {
  invoiceId: string;
  invoiceDate: string;
  customerId: string | null;
  productId: string | null;
  quantity: number;
  unitName: string | null;
  description: string | null;
  revenue: number;
  cost: number;
}

/**
 * The one place the revenue basis is expressed offline. Must stay identical to
 * the SQL: cart discount allocated pro-rata across the invoice's lines.
 */
function buildLines(ds: Dataset, start: string, end: string): {
  lines: Line[];
  invoiceCount: number;
  cartDiscount: number;
  grossSubtotal: number;
  vat: number;
  shipping: number;
} {
  const inRange = ds.invoices.filter(
    (inv) =>
      inv.status !== 'cancelled' &&
      inv.status !== 'draft' &&
      day(inv.invoice_date) >= start &&
      day(inv.invoice_date) <= end,
  );
  const byId = new Map(inRange.map((inv) => [inv.id, inv]));

  const lines: Line[] = [];
  let cartDiscount = 0;
  let grossSubtotal = 0;
  let vat = 0;
  let shipping = 0;

  for (const inv of inRange) {
    grossSubtotal += n(inv.subtotal);
    cartDiscount += n(inv.discount_amount);
    vat += n(inv.tax_amount);
    shipping += n(inv.shipping_cost);
  }

  for (const item of ds.items) {
    const inv = byId.get(item.invoice_id);
    if (!inv) continue;
    const invoiceSubtotal = n(inv.subtotal);
    const discount = Math.min(Math.max(n(inv.discount_amount), 0), invoiceSubtotal);
    const factor = invoiceSubtotal > 0 ? 1 - discount / invoiceSubtotal : 1;
    const revenue = n(item.subtotal) * factor;
    lines.push({
      invoiceId: item.invoice_id,
      invoiceDate: day(inv.invoice_date),
      customerId: inv.customer_id ?? null,
      productId: item.product_id ?? null,
      quantity: n(item.quantity),
      unitName: item.unit_name ?? null,
      description: item.description ?? null,
      revenue,
      cost: n(item.quantity) * n(item.cost_price),
    });
  }

  return { lines, invoiceCount: inRange.length, cartDiscount, grossSubtotal, vat, shipping };
}

interface Group {
  id: string | null;
  name: string;
  quantity: number;
  invoiceIds: Set<string>;
  revenue: number;
  cost: number;
  unitCounts: Map<string, number> | null;
}

function aggregate(lines: Line[], keyOf: (l: Line) => { id: string | null; name: string }, trackUnits: boolean): Group[] {
  const groups = new Map<string, Group>();
  for (const l of lines) {
    const { id, name } = keyOf(l);
    const key = id ?? `name:${name}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        id,
        name,
        quantity: 0,
        invoiceIds: new Set(),
        revenue: 0,
        cost: 0,
        unitCounts: trackUnits ? new Map() : null,
      };
      groups.set(key, g);
    }
    g.quantity += l.quantity;
    g.invoiceIds.add(l.invoiceId);
    g.revenue += l.revenue;
    g.cost += l.cost;
    if (g.unitCounts && l.unitName) {
      g.unitCounts.set(l.unitName, (g.unitCounts.get(l.unitName) || 0) + 1);
    }
  }

  return [...groups.values()].map((g) => ({
    ...g,
    // mode(): most frequent unit for the product dimension, as the SQL does.
    unitCounts: g.unitCounts,
  }));
}

function toRows(groups: Group[]): BreakdownRow[] {
  return groups
    .map((g) => {
      let unit: string | null = null;
      if (g.unitCounts && g.unitCounts.size > 0) {
        unit = [...g.unitCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      }
      return {
        id: g.id,
        name: g.name,
        unit,
        quantity: g.quantity,
        invoice_count: g.invoiceIds.size,
        revenue: g.revenue,
        cost: g.cost,
        profit: g.revenue - g.cost,
      };
    })
    .sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name));
}

const summaryCache = new Map<string, SalesSummary>();
const SUMMARY_CACHE_MAX = 4;

// A replication pass replaces the local rows these figures were derived from.
// Dropping both caches here is what stops a report printed after a sync from
// quoting the previous sync's numbers.
let unsubscribeReplica: (() => void) | null = null;
function ensureReplicaSubscription() {
  if (unsubscribeReplica) return;
  unsubscribeReplica = subscribeReplica(() => {
    datasetCache = null;
    summaryCache.clear();
  });
}

export async function offlineSalesSummary(start: string, end: string): Promise<SalesSummary | null> {
  const key = `${start}:${end}`;
  const hit = summaryCache.get(key);
  if (hit) return hit;

  try {
    ensureReplicaSubscription();
    const ds = await loadDataset();
    const { lines, invoiceCount, cartDiscount, grossSubtotal, vat, shipping } = buildLines(ds, start, end);
    // An empty period is a legitimate answer (no sales), not a failure: only a
    // throw below returns null, which is what tells the caller to surface the
    // original network error.

    const productById = new Map(ds.products.map((p) => [p.id, p]));
    const brandName = new Map(ds.brands.map((b) => [b.id, b.name]));
    const categoryName = new Map(ds.categories.map((c) => [c.id, c.name]));
    const customerName = new Map(ds.customers.map((c) => [c.id, c.name]));

    const productRows = toRows(
      aggregate(
        lines,
        (l) => {
          const p = l.productId ? productById.get(l.productId) : null;
          return { id: l.productId, name: p?.name || l.description || 'Unknown product' };
        },
        true,
      ),
    );

    const brandRows = toRows(
      aggregate(
        lines,
        (l) => {
          const p = l.productId ? productById.get(l.productId) : null;
          const id = p?.brand_id ?? null;
          return { id, name: (id && brandName.get(id)) || 'Unbranded' };
        },
        false,
      ),
    );

    const categoryRows = toRows(
      aggregate(
        lines,
        (l) => {
          const p = l.productId ? productById.get(l.productId) : null;
          const id = p?.category_id ?? null;
          return { id, name: (id && categoryName.get(id)) || 'Uncategorized' };
        },
        false,
      ),
    );

    const customerRows = toRows(
      aggregate(
        lines,
        (l) => ({
          id: l.customerId,
          name: (l.customerId && customerName.get(l.customerId)) || 'Walk-in',
        }),
        false,
      ),
    );

    const revenue = lines.reduce((s, l) => s + l.revenue, 0);
    const costLine = lines.reduce((s, l) => s + l.cost, 0);

    // Ledger COGS / returns, same definition as period_net_debit.
    const accountCode = new Map(ds.accounts.map((a) => [a.id, a.code]));
    const entryDate = new Map(ds.entries.map((e) => [e.id, day(e.entry_date)]));
    let cogs = 0;
    let returns = 0;
    for (const jl of ds.lines) {
      const code = accountCode.get(jl.account_id);
      if (code !== '5000' && code !== '4050') continue;
      const date = entryDate.get(jl.journal_entry_id);
      if (!date || date < start || date > end) continue;
      const net = n(jl.debit) - n(jl.credit);
      if (code === '5000') cogs += net;
      else returns += net;
    }

    const monthMap = new Map<string, { revenue: number; cost: number }>();
    for (const l of lines) {
      const month = l.invoiceDate.slice(0, 7);
      if (!month) continue;
      const m = monthMap.get(month) || { revenue: 0, cost: 0 };
      m.revenue += l.revenue;
      m.cost += l.cost;
      monthMap.set(month, m);
    }
    const monthly: MonthlyRow[] = [...monthMap.entries()]
      .map(([month, v]) => ({ month, ...v }))
      .sort((a, b) => a.month.localeCompare(b.month));

    const payload = (rows: BreakdownRow[]): DimensionPayload => ({
      total: rows.length,
      rows: rows.slice(0, 12),
    });

    const summary: SalesSummary = {
      period: { start, end },
      kpis: {
        revenue,
        orders: invoiceCount,
        returns,
        cogs,
        cogs_line: costLine,
        gross_profit: revenue - returns - cogs,
        gross_profit_line: revenue - costLine,
        cart_discount: cartDiscount,
        gross_subtotal: grossSubtotal,
        vat,
        shipping,
        avg_invoice: invoiceCount > 0 ? revenue / invoiceCount : 0,
      },
      monthly,
      dimensions: {
        product: payload(productRows),
        brand: payload(brandRows),
        category: payload(categoryRows),
        customer: payload(customerRows),
      },
      source: 'replica',
      fetchedAt: Date.now(),
    };

    if (summaryCache.size >= SUMMARY_CACHE_MAX) {
      const oldest = summaryCache.keys().next().value;
      if (oldest) summaryCache.delete(oldest);
    }
    summaryCache.set(key, summary);
    return summary;
  } catch {
    return null;
  }
}

/** Full (untruncated) list for one dimension, from the same cached computation. */
export async function offlineSalesBreakdown(
  dimension: Dimension,
  start: string,
  end: string,
): Promise<BreakdownRow[] | null> {
  try {
    const ds = await loadDataset();
    const { lines } = buildLines(ds, start, end);
    if (lines.length === 0) return [];

    const productById = new Map(ds.products.map((p) => [p.id, p]));
    const brandName = new Map(ds.brands.map((b) => [b.id, b.name]));
    const categoryName = new Map(ds.categories.map((c) => [c.id, c.name]));
    const customerName = new Map(ds.customers.map((c) => [c.id, c.name]));

    switch (dimension) {
      case 'product':
        return toRows(
          aggregate(
            lines,
            (l) => {
              const p = l.productId ? productById.get(l.productId) : null;
              return { id: l.productId, name: p?.name || l.description || 'Unknown product' };
            },
            true,
          ),
        );
      case 'brand':
        return toRows(
          aggregate(
            lines,
            (l) => {
              const p = l.productId ? productById.get(l.productId) : null;
              const id = p?.brand_id ?? null;
              return { id, name: (id && brandName.get(id)) || 'Unbranded' };
            },
            false,
          ),
        );
      case 'category':
        return toRows(
          aggregate(
            lines,
            (l) => {
              const p = l.productId ? productById.get(l.productId) : null;
              const id = p?.category_id ?? null;
              return { id, name: (id && categoryName.get(id)) || 'Uncategorized' };
            },
            false,
          ),
        );
      case 'customer':
        return toRows(
          aggregate(
            lines,
            (l) => ({ id: l.customerId, name: (l.customerId && customerName.get(l.customerId)) || 'Walk-in' }),
            false,
          ),
        );
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Invoice-level drill-down for one dimension member, computed locally. */
export async function offlineSalesDetail(
  dimension: Dimension,
  dimensionId: string | null,
  start: string,
  end: string,
): Promise<SalesDetailRow[] | null> {
  try {
    const ds = await loadDataset();
    const { lines } = buildLines(ds, start, end);
    const productById = new Map(ds.products.map((p) => [p.id, p]));
    const customerName = new Map(ds.customers.map((c) => [c.id, c.name]));
    const invoiceById = new Map(ds.invoices.map((i) => [i.id, i]));

    const matches = (l: Line): boolean => {
      const p = l.productId ? productById.get(l.productId) : null;
      switch (dimension) {
        case 'product':
          return l.productId === dimensionId;
        case 'brand':
          return (p?.brand_id ?? null) === dimensionId;
        case 'category':
          return (p?.category_id ?? null) === dimensionId;
        case 'customer':
          return (l.customerId ?? null) === dimensionId;
        default:
          return false;
      }
    };

    const grouped = new Map<string, SalesDetailRow>();
    for (const l of lines) {
      if (!matches(l)) continue;
      const inv = invoiceById.get(l.invoiceId);
      if (!inv) continue;
      let row = grouped.get(l.invoiceId);
      if (!row) {
        row = {
          invoice_id: l.invoiceId,
          invoice_number: inv.invoice_number,
          invoice_date: day(inv.invoice_date),
          customer_name: (inv.customer_id && customerName.get(inv.customer_id)) || null,
          quantity: 0,
          revenue: 0,
          cost: 0,
        };
        grouped.set(l.invoiceId, row);
      }
      row.quantity += l.quantity;
      row.revenue += l.revenue;
      row.cost += l.cost;
    }

    return [...grouped.values()].sort(
      (a, b) => b.invoice_date.localeCompare(a.invoice_date) || b.invoice_number.localeCompare(a.invoice_number),
    );
  } catch {
    return null;
  }
}
