/**
 * POS payment application ("Collect From") — the money-flow chooser at
 * checkout, kept as a pure module so the checkout preview and the charge path
 * compute the split from ONE function (lib/__tests__/pos-settlement.test.ts
 * covers the arithmetic).
 *
 *   cash          today's behaviour: the tender pays THIS bill (a full payment
 *                 can still sweep the tendered excess into older dues)
 *   dues_first    the cash received clears the customer's OLDEST unpaid
 *                 invoices first; whatever is left pays this bill, the rest of
 *                 this bill stays due on the customer
 *   advance_first money the shop already holds for the customer (his advance /
 *                 unallocated overpayment wallets) pays this bill first; cash
 *                 covers only the remainder
 *
 * Walk-in customers always settle in `cash` mode — there is no account to
 * charge or clear, so the settlement reports the mode it actually used.
 *
 * Online the split is posted through collect_customer_payment (dues) and
 * collect_customer_advance (advance wallets); offline it is queued as
 * payment.create / advance.apply ops that replay through sync_apply. Both paths
 * therefore leave identical books.
 */

export type PosCollectMode = 'cash' | 'dues_first' | 'advance_first';

export type PosPaymentTerm = 'full' | 'partial' | 'credit';

export interface PosOutstandingRow { invoice_id: string; invoice_number: string; balance_due: number }
export interface PosAdvanceRow { advance_id: string; advance_number: string; balance: number }

export interface PosSettlement {
  /** the mode actually used (walk-ins fall back to `cash`) */
  mode: PosCollectMode;
  /** store credit redeemed against this bill */
  storeCredit: number;
  /** what this bill still needs after store credit */
  billNeeds: number;
  /** cash handed over by the customer */
  tendered: number;
  /** cash swept into the customer's older invoices (oldest first) */
  duesCleared: number;
  duesAlloc: { invoice_id: string; invoice_number: string; amount: number }[];
  /** money taken out of the customer's advance wallets for this bill */
  advanceApplied: number;
  advanceAlloc: { advance_id: string; advance_number: string; amount: number }[];
  /** cash recorded against THIS invoice */
  cashToBill: number;
  /** amount_paid written on the invoice (the advance is added by the server) */
  invoiceAmountPaid: number;
  /** everything credited to this invoice: cash + store credit + advance */
  invoicePaidTotal: number;
  invoiceStatus: string;
  /**
   * Status once every source of money has landed. The advance is applied AFTER
   * the invoice write (so a wallet that comes up short can never leave an
   * invoice paid with cash we did not receive), which is why the insert uses
   * `invoiceStatus` and the receipt uses `finalStatus`.
   */
  finalStatus: string;
  /** cash handed back — nothing left to pay anywhere */
  change: number;
  previousDueBefore: number;
  previousDueAfter: number;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

export function buildPosSettlement(args: {
  mode: PosCollectMode;
  /** registered (non walk-in) customer selected */
  registered: boolean;
  grandTotal: number;
  /** store credit the cashier toggled on and can actually cover */
  storeCredit: number;
  /** for `cash` mode: the tendered amount typed in the Amount Paid box */
  tendered: number;
  /** for `cash` mode: the partial-payment amount typed in */
  partialAmount: number;
  paymentTerm: PosPaymentTerm;
  /** for `cash` mode: how much previous due the cashier asked to collect */
  dueCollectInput: number;
  /** older unpaid invoices, oldest first */
  outstanding: PosOutstandingRow[];
  /** the customer's active advance wallets, oldest first */
  advances: PosAdvanceRow[];
  /** sum of the advance wallets */
  advanceBalance: number;
}): PosSettlement {
  const {
    mode, registered, grandTotal, storeCredit, tendered, partialAmount,
    paymentTerm, dueCollectInput, outstanding, advances, advanceBalance,
  } = args;

  const billNeeds = Math.max(0, round2(grandTotal - storeCredit));
  const previousDueBefore = round2(outstanding.reduce((s, r) => s + (Number(r.balance_due) || 0), 0));
  const effectiveMode: PosCollectMode = registered ? mode : 'cash';

  /** Oldest-first split of an amount across the customer's open invoices. */
  function splitAcrossDues(amount: number) {
    const alloc: { invoice_id: string; invoice_number: string; amount: number }[] = [];
    let remaining = amount;
    let cleared = 0;
    for (const row of outstanding) {
      if (remaining <= 0) break;
      const amt = round2(Math.min(Number(row.balance_due) || 0, remaining));
      if (amt <= 0) continue;
      alloc.push({ invoice_id: row.invoice_id, invoice_number: row.invoice_number, amount: amt });
      remaining = round2(remaining - amt);
      cleared = round2(cleared + amt);
    }
    return { alloc, cleared };
  }

  const base: PosSettlement = {
    mode: effectiveMode,
    storeCredit,
    billNeeds,
    tendered,
    duesCleared: 0,
    duesAlloc: [],
    advanceApplied: 0,
    advanceAlloc: [],
    cashToBill: 0,
    invoiceAmountPaid: 0,
    invoicePaidTotal: 0,
    invoiceStatus: 'sent',
    finalStatus: 'sent',
    change: 0,
    previousDueBefore,
    previousDueAfter: previousDueBefore,
  };

  // ── Previous dues first ────────────────────────────────────────────────
  // 1. the cash clears the oldest unpaid invoices, 2. what is left pays this
  // bill, 3. whatever this bill still needs stays due — the point of the mode
  // is that the OLD money is settled and the new purchase rides the account.
  if (effectiveMode === 'dues_first') {
    const { alloc, cleared } = splitAcrossDues(tendered);
    base.duesAlloc = alloc;
    base.duesCleared = cleared;
    const left = round2(tendered - cleared);
    base.cashToBill = round2(Math.min(left, billNeeds));
    base.change = round2(Math.max(0, left - base.cashToBill));
    base.invoiceAmountPaid = round2(base.cashToBill + storeCredit);
    base.invoicePaidTotal = base.invoiceAmountPaid;
    base.invoiceStatus = base.invoicePaidTotal >= grandTotal - 0.001
      ? 'paid'
      : base.invoicePaidTotal > 0 ? 'partially_paid' : 'sent';
    base.finalStatus = base.invoiceStatus;
    base.previousDueAfter = round2(previousDueBefore - cleared);
    return base;
  }

  // ── Advance balance first ──────────────────────────────────────────────
  // The wallets (oldest first) pay this bill, then cash covers what is left.
  // The invoice is written WITHOUT the advance and the application lands right
  // after it, so an application that finds less money than expected can never
  // leave an invoice marked paid with cash we did not receive.
  if (effectiveMode === 'advance_first') {
    const wanted = round2(Math.min(Math.max(0, advanceBalance), billNeeds));
    let remaining = wanted;
    for (const a of advances) {
      if (remaining <= 0) break;
      const amt = round2(Math.min(Number(a.balance) || 0, remaining));
      if (amt <= 0) continue;
      base.advanceAlloc.push({ advance_id: a.advance_id, advance_number: a.advance_number, amount: amt });
      remaining = round2(remaining - amt);
    }
    base.advanceApplied = round2(wanted - remaining);
    const stillNeeded = Math.max(0, round2(billNeeds - base.advanceApplied));
    base.cashToBill = round2(Math.min(tendered, stillNeeded));
    base.change = round2(Math.max(0, tendered - base.cashToBill));
    base.invoiceAmountPaid = round2(base.cashToBill + storeCredit);
    base.invoicePaidTotal = round2(base.invoiceAmountPaid + base.advanceApplied);
    base.invoiceStatus = base.invoiceAmountPaid >= grandTotal - 0.001
      ? 'paid'
      : base.invoiceAmountPaid > 0 ? 'partially_paid' : 'sent';
    base.finalStatus = base.invoicePaidTotal >= grandTotal - 0.001
      ? 'paid'
      : base.invoicePaidTotal > 0 ? 'partially_paid' : 'sent';
    return base;
  }

  // ── Cash (default, and the only mode for walk-ins) ─────────────────────
  // The pre-existing behaviour, kept intact so an ordinary sale and its receipt
  // are unchanged.
  base.cashToBill = round2(
    paymentTerm === 'full' ? billNeeds
      : paymentTerm === 'partial' ? Math.min(partialAmount, billNeeds)
      : 0
  );
  base.change = paymentTerm === 'full' ? round2(Math.max(0, tendered - billNeeds)) : 0;
  base.invoiceAmountPaid = paymentTerm === 'full'
    ? grandTotal
    : paymentTerm === 'partial' ? round2(partialAmount) : 0;
  base.invoicePaidTotal = base.invoiceAmountPaid;
  base.invoiceStatus = paymentTerm === 'full'
    ? (storeCredit > 0 && billNeeds > 0 ? 'partially_paid' : 'paid')
    : paymentTerm === 'partial' ? 'partially_paid' : 'sent';
  base.finalStatus = base.invoiceStatus;

  // The optional previous-due sweep: only the tendered EXCESS over this bill
  // (a full payment's overpayment) may clear older invoices.
  if (paymentTerm === 'full' && registered && previousDueBefore > 0) {
    const excess = Math.max(0, round2(Math.max(tendered, billNeeds) - billNeeds));
    const wanted = round2(Math.min(dueCollectInput, previousDueBefore, excess));
    const { alloc, cleared } = splitAcrossDues(wanted);
    base.duesAlloc = alloc;
    base.duesCleared = cleared;
    base.previousDueAfter = round2(previousDueBefore - cleared);
  }
  return base;
}
