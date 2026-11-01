/**
 * What to do with a delivery's `delivery_items` when the delivery form saves.
 *
 * A challan's rows are a copy of its linked invoice's lines. Saving the form
 * used to insert that copy unconditionally — including on an edit — so every
 * re-save appended a second copy of every line (DLV-661189 ended up with 6
 * rows for 3 invoice lines). This decides instead:
 *
 *   create                      -> insert the copy
 *   edit, link changed          -> replace the copy (new invoice, new lines)
 *   edit, no rows yet           -> insert (backfills a challan created before
 *                                  the copy existed, e.g. offline)
 *   edit, same link, rows exist -> leave alone; edit_invoice owns this table
 *                                  and the print path reads the invoice anyway
 */
import { supabase } from './supabase';

export type DeliveryItemSyncAction = 'insert' | 'replace' | 'skip';

export function planDeliveryItemSync(opts: {
  isEdit: boolean;
  invoiceId?: string | null;
  previousInvoiceId?: string | null;
  existingRowCount: number;
}): DeliveryItemSyncAction {
  const invoiceId = opts.invoiceId || null;
  if (!invoiceId) return 'skip';
  if (!opts.isEdit) return 'insert';
  // Nothing on the challan yet: a copy is an insert, never a replace — this
  // also backfills a challan created before the copy existed (e.g. offline).
  if (opts.existingRowCount === 0) return 'insert';
  if ((opts.previousInvoiceId || null) !== invoiceId) return 'replace';
  return 'skip';
}

export interface DeliveryLineCopy {
  product_id: string;
  quantity: number;
  unit_name: string | null;
}

/**
 * The invoice lines to copy onto a challan, in the shape the outbox payload
 * carries them (`items`). Online this is a live read; offline the wrapped
 * client answers from the cached result or the local replica, so a delivery
 * queued with no connection still carries its lines — the pending overlay can
 * then render them and the server copy is not the only source.
 */
export async function fetchInvoiceLinesForDelivery(invoiceId: string): Promise<DeliveryLineCopy[]> {
  if (!invoiceId) return [];
  const { data } = await supabase
    .from('invoice_items')
    .select('product_id, quantity, unit_name')
    .eq('invoice_id', invoiceId);
  return ((data as any[] | null) ?? [])
    .filter((row) => row && row.product_id)
    .map((row) => ({
      product_id: String(row.product_id),
      quantity: Number(row.quantity) || 0,
      unit_name: row.unit_name ?? null,
    }));
}
