/**
 * Delivery-challan line items — the single source both print surfaces use.
 *
 * A challan is a satellite of its invoice (owner decision 2026-10-26), so the
 * lines it prints are the invoice's CURRENT lines, not the snapshot taken when
 * the challan was created. `delivery_items` is a delivery-progress record: it
 * is only trusted for the "delivered qty" column once the delivery has
 * actually happened (status = 'delivered'). For a challan that is still
 * pending / assigned / in transit, the quantity on the paper is what the
 * invoice says goes out.
 *
 * Before this module the two screens disagreed: the delivery screen printed
 * invoice_items (fresh), while the sales screen preferred delivery_items and
 * printed the pre-edit quantities — 0 for lines the edit added, the old
 * quantity for lines the edit raised.
 */
import { supabase } from './supabase';

export interface ChallanItem {
  product_name: string;
  product_sku?: string;
  quantity: number;
  delivered_quantity?: number;
  unit_name?: string;
}

interface ProductRef {
  name?: string | null;
  sku?: string | null;
  unit?: string | null;
}

export interface ChallanSourceLine {
  product_id?: string | null;
  quantity: number | string | null;
  delivered_quantity?: number | string | null;
  unit_name?: string | null;
  product?: ProductRef | null;
}

/**
 * Pure merge of an invoice's lines with the delivery's progress rows.
 *
 * `invoiceLines` wins for the document (product, sku, unit, quantity). The
 * delivered column is taken from `deliveryLines` only when the challan has
 * been marked delivered; otherwise it mirrors the invoice quantity so the
 * printed total is the invoice's total.
 */
export function buildChallanItems(
  invoiceLines: ChallanSourceLine[] | null | undefined,
  deliveryLines: ChallanSourceLine[] | null | undefined,
  deliveryStatus?: string | null,
): ChallanItem[] {
  const deliveredNow = deliveryStatus === 'delivered';

  const progress = new Map<string, number>();
  for (const line of deliveryLines ?? []) {
    if (line.product_id) progress.set(line.product_id, Number(line.delivered_quantity ?? 0));
  }

  const source =
    invoiceLines && invoiceLines.length > 0 ? invoiceLines : deliveryLines ?? [];

  return source.map((line) => {
    const quantity = Number(line.quantity ?? 0);
    const recorded = line.product_id ? progress.get(line.product_id) : undefined;
    const delivered = deliveredNow && recorded !== undefined && recorded > 0 ? recorded : quantity;

    return {
      product_name: line.product?.name || '—',
      product_sku: line.product?.sku || undefined,
      quantity,
      delivered_quantity: delivered,
      unit_name: line.unit_name || line.product?.unit || undefined,
    };
  });
}

export interface ChallanSourceDelivery {
  id: string;
  invoice_id?: string | null;
  status?: string | null;
}

/**
 * Read a challan's printable lines. A challan linked to an invoice reads the
 * invoice's live lines (so an invoice edit is visible on the next print) and
 * falls back to the delivery's own rows when the invoice has none.
 */
export async function loadChallanItems(delivery: ChallanSourceDelivery): Promise<ChallanItem[]> {
  const invoiceQuery = delivery.invoice_id
    ? supabase
        .from('invoice_items')
        .select('product_id, quantity, unit_name, product:products(name, sku, unit)')
        .eq('invoice_id', delivery.invoice_id)
    : Promise.resolve({ data: null });

  const [invoiceRes, deliveryRes] = await Promise.all([
    invoiceQuery,
    supabase
      .from('delivery_items')
      .select('product_id, quantity, delivered_quantity, unit_name, product:products(name, sku, unit)')
      .eq('delivery_id', delivery.id),
  ]);

  return buildChallanItems(
    (invoiceRes as any)?.data,
    (deliveryRes as any)?.data,
    delivery.status,
  );
}
