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
