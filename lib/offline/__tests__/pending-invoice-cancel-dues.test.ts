/**
 * invoice.cancel overlay invariants for retained due collections.
 *
 * A POS sale can collect the customer's OLDER dues at the same time it creates
 * a new invoice; those payments link back through
 * payments.collected_with_invoice_id. Cancelling the sale may either refund
 * that collection (the default — the RPC's p_reverse_due_collections = true) or
 * keep it posted as a standalone debt payment on the older invoice
 * (reverse_due_collections = false in the queued payload).
 *
 * When the cashier chose to keep them, the local replica must drop the link as
 * well — otherwise the older invoice's collection keeps rendering as "collected
 * with" a cancelled sale until the post-sync replica refresh lands.
 */

import { deriveEffects, OP_TABLES, applyPatchChain } from '../pending';

const CREATED_AT = Date.parse('2026-09-27T09:00:00Z');

describe('invoice.cancel — retained due collections (lib/offline/pending)', () => {
  test('default cancellation only patches the invoice status', () => {
    const effects = deriveEffects(
      'invoice.cancel',
      { invoice_id: 'inv-1', reason: 'Duplicate' },
      'op-1',
      CREATED_AT,
    );

    expect(effects).toEqual([
      { kind: 'patch', table: 'invoices', id: 'inv-1', patch: { status: 'cancelled' } },
    ]);
  });

  test('reversing dues (explicit true) leaves the linked payments untouched', () => {
    const effects = deriveEffects(
      'invoice.cancel',
      { invoice_id: 'inv-1', reverse_due_collections: true, due_payment_ids: ['pay-1'] },
      'op-2',
      CREATED_AT,
    );

    expect(effects.filter((e) => e.table === 'payments')).toEqual([]);
  });

  test('retaining dues unlinks every linked payment locally', () => {
    const effects = deriveEffects(
      'invoice.cancel',
      { invoice_id: 'inv-1', reverse_due_collections: false, due_payment_ids: ['pay-1', 'pay-2'] },
      'op-3',
      CREATED_AT,
    );

    expect(effects).toEqual([
      { kind: 'patch', table: 'invoices', id: 'inv-1', patch: { status: 'cancelled' } },
      { kind: 'patch', table: 'payments', id: 'pay-1', patch: { collected_with_invoice_id: null } },
      { kind: 'patch', table: 'payments', id: 'pay-2', patch: { collected_with_invoice_id: null } },
    ]);

    // The patch composes over a replicated payment row the way the overlay
    // applies it, keeping every other field intact.
    const payment = {
      id: 'pay-1',
      amount: 500,
      reference_id: 'older-invoice',
      collected_with_invoice_id: 'inv-1',
      is_reversed: false,
    };
    const patched = applyPatchChain(payment, [
      { collected_with_invoice_id: null },
    ]);
    expect(patched).toEqual({ ...payment, collected_with_invoice_id: null });
  });

  test('retaining dues without resolved payment ids still cancels the invoice', () => {
    const effects = deriveEffects(
      'invoice.cancel',
      { invoice_id: 'inv-1', reverse_due_collections: false },
      'op-4',
      CREATED_AT,
    );

    expect(effects).toEqual([
      { kind: 'patch', table: 'invoices', id: 'inv-1', patch: { status: 'cancelled' } },
    ]);
  });

  test('the op derives effects for payments so the overlay can surface the unlink', () => {
    expect(OP_TABLES['invoice.cancel']).toEqual(
      expect.arrayContaining(['invoices', 'payments']),
    );
  });
});
