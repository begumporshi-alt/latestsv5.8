/**
 * Sales & invoices data layer.
 *
 * Three queries, split by what the screen actually needs and when:
 *
 *   page       invoices + payments + returns + deliveries for one period
 *              window, plus the KPI figures. This is the list.
 *   listRefs   payment methods, customers, warehouses, company settings —
 *              small, and the list's own filters read them.
 *   products   the ~2.5k-row catalogue with units and stock. Eight paginated
 *              round trips and the single most expensive thing on the page.
 *              Nothing on the list needs it: the Customer column comes from
 *              the invoice join, and the catalogue is only read by the
 *              create/edit forms and the product filter chip. It is fetched
 *              on intent instead of on mount.
 *
 * Before this split the page awaited `Promise.all([page, refs])` and applied
 * both together, so the invoice list sat behind the catalogue download.
 *
 * Freshness belongs to TanStack Query here; `cachedQuery` is used with a zero
 * TTL, which makes it a pure write-through snapshot for offline reads. That is
 * deliberate: with the TTL at zero the online path always refetches, so the
 * "serve the pre-save snapshot for 60 s" problem the old `force` flag existed
 * to work around cannot occur — invalidation alone is enough.
 */

import { supabase } from '@/lib/supabase';
import { fetchAll } from '@/lib/fetch-all';
import { isInvoiceOverdue } from '@/lib/format';
import { cachedQuery, type CachedResult } from '@/lib/offline/cache';
import type { Invoice, Customer, Product } from '@/lib/types';

export interface InvoiceWithCustomer extends Omit<Invoice, 'customer'> {
  is_quick_sell?: boolean;
  customer?: { name: string; code: string; phone?: string; address?: string };
  sales_returns?: { id: string; return_number: string; total_refund_amount: number; items: { quantity_returned: number }[] }[];
  payments?: { id: string; payment_method: string; amount: number; payment_date: string }[];
  deliveries?: { id: string; delivery_number: string; status: string; was_edited?: boolean; edit_note?: string }[];
}

export interface SalesStats {
  total: number;
  paid: number;
  refunded: number;
  netCollected: number;
  outstanding: number;
  overdue: number;
  storeCreditBalance: number;
  badDebt: number;
  cogs: number;
  paymentCollectedAtSale: number;
  invoiceCount: number;
  costHistoryTotal: number;
}

export const EMPTY_STATS: SalesStats = {
  total: 0, paid: 0, refunded: 0, netCollected: 0, outstanding: 0, overdue: 0,
  storeCreditBalance: 0, badDebt: 0, cogs: 0, paymentCollectedAtSale: 0,
  invoiceCount: 0, costHistoryTotal: 0,
};

export interface SalesPageData {
  invoicesWithReturns: InvoiceWithCustomer[];
  cogsGap: any;
  stats: SalesStats;
}

export interface SalesListRefs {
  paymentMethods: { code: string; name: string }[];
  customers: Customer[];
  warehouses: any[];
  companySettings: any;
}

export type SalesPeriod = 'today' | 'last7' | 'last30' | 'all' | 'custom';

export const salesKeys = {
  all: ['sales'] as const,
  page: (period: SalesPeriod, from: string, to: string) => ['sales', 'page', period, from, to] as const,
  listRefs: () => ['sales', 'list-refs'] as const,
  products: () => ['sales', 'products'] as const,
};

export function getPeriodRange(period: SalesPeriod, from: string, to: string): { from: string; to: string } {
  const today = new Date().toISOString().split('T')[0];
  if (period === 'today') return { from: today, to: today };
  if (period === 'last7') {
    const d = new Date(); d.setDate(d.getDate() - 6);
    return { from: d.toISOString().split('T')[0], to: today };
  }
  if (period === 'last30') {
    const d = new Date(); d.setDate(d.getDate() - 29);
    return { from: d.toISOString().split('T')[0], to: today };
  }
  if (period === 'custom') return { from, to };
  return { from: '', to: '' };
}

/* ------------------------------------------------------------------ */

export async function fetchSalesPage(from: string, to: string): Promise<SalesPageData> {
  // All completeness-dependent queries go through fetchAll so stats and
  // pickers are never silently truncated by Supabase's row caps (the invoices
  // query previously had .limit(500), which hid the oldest 80 invoices and
  // understated Total Sales by ~6.3L).
  const [invoicesData, returnsData, paymentsData, deliveriesData, receivablePaymentsData, returnsForStatsData, accountsRes, cphData, creditRes, gapRes] = await Promise.all([
    fetchAll(() => {
      let q = supabase.from('invoices').select('*, customer:customers(name, code, phone, email, address)').order('created_at', { ascending: false });
      if (from) q = q.gte('invoice_date', from);
      if (to) q = q.lte('invoice_date', to);
      return q;
    }),
    fetchAll(() => supabase.from('sales_returns').select('id, invoice_id, return_number, total_refund_amount, items:sales_return_items(quantity_returned)')),
    fetchAll(() => supabase.from('payments').select('id, reference_id, payment_method, amount, payment_date').eq('reference_type', 'invoice')),
    fetchAll(() => supabase.from('deliveries').select('id, invoice_id, delivery_number, status, was_edited, edit_note')),
    fetchAll(() => {
      let q = supabase.from('payments')
        .select('id, reference_id, reference_type, payment_method, amount, payment_date, payment_type, bad_debt_amount')
        .eq('payment_type', 'received')
        .in('reference_type', ['invoice', 'receivable'])
        .eq('is_reversed', false)
        .neq('payment_for', 'reversal_payment');
      if (from) q = q.gte('payment_date', from);
      if (to) q = q.lte('payment_date', to);
      return q;
    }),
    // Refunds for the stats cards — filtered by return_date to match the payment period window.
    fetchAll(() => {
      let q = supabase.from('sales_returns')
        .select('id, invoice_id, return_number, total_refund_amount, refund_method, return_date, items:sales_return_items(quantity_returned)');
      if (from) q = q.gte('return_date', from);
      if (to) q = q.lte('return_date', to);
      return q;
    }),
    supabase.from('accounts').select('id, code, name, account_type'),
    fetchAll(() => supabase.from('cost_price_history').select('invoice_id, cost_price_for_added_qty')),
    // Formerly sequential after the batch — fetched in parallel to cut two
    // serial round trips from the first load.
    supabase.from('customer_store_credits').select('balance').eq('status', 'active'),
    supabase.rpc('get_cogs_history_gap_breakdown', {
      p_start_date: from || null,
      p_end_date: to || null,
    }),
  ]);

  const periodRefunded = (returnsForStatsData || []).reduce((s: number, r: any) => s + Number(r.total_refund_amount), 0);

  // Attach deliveries to their corresponding invoices
  const deliveriesMap = new Map<string, any[]>();
  (deliveriesData || []).forEach((del: any) => {
    if (del.invoice_id) {
      const existing = deliveriesMap.get(del.invoice_id) || [];
      existing.push(del);
      deliveriesMap.set(del.invoice_id, existing);
    }
  });

  // Attach sales returns to their corresponding invoices
  const returnsMap = new Map<string, any[]>();
  (returnsData || []).forEach((ret: any) => {
    const existing = returnsMap.get(ret.invoice_id) || [];
    existing.push(ret);
    returnsMap.set(ret.invoice_id, existing);
  });

  // Attach payments to their corresponding invoices
  const paymentsMap = new Map<string, any[]>();
  (paymentsData || []).forEach((pay: any) => {
    const existing = paymentsMap.get(pay.reference_id) || [];
    existing.push(pay);
    paymentsMap.set(pay.reference_id, existing);
  });

  // Attach per-invoice cost totals from cost price history (per-invoice basis
  // for matching the COGS journal entry against recorded cost)
  const costMap = new Map<string, number>();
  (cphData || []).forEach((r: any) => {
    costMap.set(r.invoice_id, (costMap.get(r.invoice_id) || 0) + Number(r.cost_price_for_added_qty || 0));
  });

  const invoicesWithReturns = (invoicesData || []).map((inv: any) => ({
    ...inv,
    sales_returns: returnsMap.get(inv.id) || [],
    payments: paymentsMap.get(inv.id) || [],
    deliveries: deliveriesMap.get(inv.id) || [],
    cph_total: costMap.get(inv.id) || 0,
  }));

  const activeInv = invoicesWithReturns.filter((i: any) => i.status !== 'cancelled' && i.status !== 'draft');

  // Calculate collected amount from payments table filtered by payment_date,
  // so payments on old invoices collected today still show in today's stats.
  // Reversed payments (from invoice edits/cancels) are excluded so they don't
  // inflate the total.
  const allReceivedPayments = receivablePaymentsData || [];
  const invoiceCollected = allReceivedPayments
    .filter((p: any) => p.reference_type === 'invoice')
    .reduce((s: number, p: any) => s + Number(p.amount), 0);
  const receivableCollected = allReceivedPayments
    .filter((p: any) => p.reference_type === 'receivable')
    .reduce((s: number, p: any) => s + Number(p.amount), 0);
  const totalCollected = invoiceCollected + receivableCollected;

  // Fetch store credit balance (not period-dependent) — fetched in the
  // parallel batch above.
  const storeCreditBalance = (creditRes.data || []).reduce((s: number, c: any) => s + Number(c.balance), 0);

  // COGS: net debit balance on account code 5000 within the period
  const cogsAccount = (accountsRes.data || []).find((a: any) => a.code === '5000');
  let cogsAmount = 0;
  if (cogsAccount) {
    const { data: cogsData } = await supabase.rpc('period_net_debit', {
      p_account_id: cogsAccount.id,
      p_start_date: from || '1900-01-01',
      p_end_date: to || '2100-12-31',
    });
    cogsAmount = Math.max(0, Number(cogsData || 0));
  }

  // Why Total COGS (journal) differs from Total Cost (History): per-cause
  // decomposition on the same period basis as the two cards.
  const gapRows = gapRes.data;

  // Payment collected at sale: total amount paid on invoices that were fully
  // or partially paid at time of sale
  const paymentCollectedAtSale = activeInv
    .filter((i: any) => Number(i.amount_paid || 0) > 0)
    .reduce((s: number, i: any) => s + Number(i.amount_paid || 0), 0);

  return {
    invoicesWithReturns,
    cogsGap: (gapRows && gapRows.length > 0) ? gapRows[0] : null,
    stats: {
      total: activeInv.reduce((s: number, i: any) => s + Number(i.total_amount), 0),
      paid: totalCollected,
      refunded: periodRefunded,
      netCollected: totalCollected - periodRefunded,
      outstanding: activeInv.reduce((s: number, i: any) => s + Number(i.balance_due || 0), 0),
      overdue: activeInv.filter((i: any) => isInvoiceOverdue(i)).length,
      storeCreditBalance,
      badDebt: activeInv.reduce((s: number, i: any) => s + Number(i.bad_debt_amount || 0), 0),
      cogs: cogsAmount,
      paymentCollectedAtSale,
      invoiceCount: activeInv.length,
      costHistoryTotal: activeInv.reduce((s: number, i: any) => s + Number(i.cph_total || 0), 0),
    },
  };
}

/* ------------------------------------------------------------------ */

/** Small reference data the list itself reads. */
export async function fetchSalesListRefs(): Promise<SalesListRefs> {
  const [custRes, paymentMethodsRes, warehousesRes, settingsRes] = await Promise.all([
    fetchAll(() => supabase.from('customers').select('*').eq('is_active', true).order('name').order('id')),
    supabase.from('payment_methods').select('code, name').eq('is_active', true).order('sort_order'),
    supabase.from('warehouses').select('id, name, code').eq('is_active', true).order('is_default', { ascending: false }).order('name'),
    supabase.from('app_settings').select('setting_value').eq('setting_key', 'company').maybeSingle(),
  ]);
  return {
    customers: custRes || [],
    paymentMethods: paymentMethodsRes.data || [],
    warehouses: warehousesRes.data || [],
    companySettings: settingsRes.data?.setting_value || null,
  };
}

/**
 * The catalogue: ~2.5k products with units and per-warehouse stock, eight
 * paginated round trips. Only the create/edit forms and the product filter
 * chip read it, so it is fetched on intent.
 */
export async function fetchSalesProducts(): Promise<Product[]> {
  const rows = await fetchAll(() => supabase
    .from('products')
    .select(`*, units:product_units(id, product_id, unit_name, unit_short, conversion_factor, is_base_unit, is_sale_unit, price, cost_price, is_active, sort_order), inventory_items(id, warehouse_id, quantity_on_hand)`)
    .eq('is_active', true)
    .order('name')
    .order('id'));
  return rows || [];
}

/* ------------------------------------------------------------------ */

/**
 * Offline tier. `cachedQuery` with a zero TTL always refetches while online
 * (so the snapshot is rewritten with fresh data on every query run) and
 * answers from IndexedDB when the network is gone. Freshness is Query's job,
 * signalled by `staleTime`, not by this cache.
 */
export async function readSalesPage(key: string, from: string, to: string): Promise<CachedResult<SalesPageData>> {
  return cachedQuery<SalesPageData>(key, 0, () => fetchSalesPage(from, to));
}

export async function readSalesListRefs(): Promise<CachedResult<SalesListRefs>> {
  return cachedQuery<SalesListRefs>('sales:list-refs', 0, fetchSalesListRefs);
}

export async function readSalesProducts(): Promise<CachedResult<Product[]>> {
  return cachedQuery<Product[]>('sales:products', 0, fetchSalesProducts);
}
