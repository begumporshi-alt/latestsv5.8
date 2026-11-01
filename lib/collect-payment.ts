/**
 * Collect Payment allocation planning.
 *
 * The Collect Payment modal takes one cash figure and one bad-debt figure for
 * a whole collection, then has to spread both across the invoices the customer
 * owes. That spread used to live inline in the submit handler, which made it
 * impossible to show the operator what would actually be posted and impossible
 * to test.
 *
 * The rules, unchanged from the previous implementation:
 *   - invoices arrive already ordered oldest first (the query sorts by
 *     invoice_date), and cash is allocated per invoice by the caller;
 *   - the global bad-debt figure is distributed in that same order, capped at
 *     each invoice's remaining balance *after* the cash allocated to it;
 *   - an invoice with neither cash nor write-off produces no payment row.
 *
 * What is new is the reporting: `badDebtUnapplied` exposes the part of the
 * write-off that did not fit. It used to disappear silently, so a user could
 * type ৳500 against ৳200 of open balance and be told ৳500 had been written off.
 */

const EPSILON = 0.005;

export interface CollectInvoice {
  id: string;
  invoice_number: string;
  balance_due: number;
  total_amount: number;
  amount_paid: number;
}

export interface CollectionAllocation {
  invoice_id: string;
  amount: number;
  bad_debt_amount: number;
}

export interface AllocationPlan {
  /** One row per invoice that receives cash or a write-off. */
  rows: CollectionAllocation[];
  /** Cash applied to invoices. */
  cashAllocated: number;
  /** Write-off applied to invoices. */
  badDebtAllocated: number;
  /** Write-off that had no balance left to absorb it. */
  badDebtUnapplied: number;
}

export interface CollectRequestInput {
  customerId: string;
  paymentDate: string;
  paymentMethod: string;
  referenceNumber?: string | null;
  notes?: string | null;
  allocations: CollectionAllocation[];
  overpayment: number;
  routeOverpayment: boolean;
  accountId?: string | null;
}

export interface CollectRequest {
  p_customer_id: string;
  p_payment_date: string;
  p_payment_method: string;
  p_reference_number: string | null;
  p_notes: string | null;
  p_allocations: CollectionAllocation[];
  p_overpayment: number;
  p_route_overpayment: boolean;
  p_account_id: string | null;
}

function round2(value: number): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function toAmount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Splits a collection across invoices.
 *
 * `allocations` is the cash the operator assigned to each invoice id (the
 * modal auto-fills it oldest-first but every row stays editable).
 */
export function buildAllocationPlan(
  invoices: CollectInvoice[],
  allocations: Record<string, number>,
  badDebtAmount: number,
): AllocationPlan {
  const rows: CollectionAllocation[] = [];
  let cashAllocated = 0;
  let badDebtAllocated = 0;
  let badRemaining = Math.max(0, toAmount(badDebtAmount));

  for (const invoice of invoices) {
    const cash = round2(Math.max(0, toAmount(allocations[invoice.id])));
    const due = toAmount(invoice.balance_due);

    // Cash first, then the write-off absorbs whatever balance is left on this
    // invoice. A negative remainder (over-allocation) simply yields no
    // write-off here; the modal blocks over-allocation before submit.
    const freeBalance = round2(due - cash);
    const bad = freeBalance > 0 ? round2(Math.min(badRemaining, freeBalance)) : 0;

    if (cash > EPSILON || bad > EPSILON) {
      rows.push({
        invoice_id: invoice.id,
        amount: cash > EPSILON ? cash : 0,
        bad_debt_amount: bad > EPSILON ? bad : 0,
      });
      cashAllocated += cash > EPSILON ? cash : 0;
      badDebtAllocated += bad > EPSILON ? bad : 0;
      badRemaining -= bad > EPSILON ? bad : 0;
    }
  }

  return {
    rows,
    cashAllocated: round2(cashAllocated),
    badDebtAllocated: round2(badDebtAllocated),
    badDebtUnapplied: round2(Math.max(0, badRemaining)),
  };
}

/**
 * Builds the `collect_customer_payment` argument object.
 *
 * Kept separate from the modal so the two contract details that regressed once
 * already stay visible and tested: the account is carried through to
 * `payments.account_id`, and an empty selection becomes NULL (falling back to
 * the payment-method routing) rather than an empty string.
 */
export function buildCollectRequest(input: CollectRequestInput): CollectRequest {
  return {
    p_customer_id: input.customerId,
    p_payment_date: input.paymentDate,
    p_payment_method: input.paymentMethod,
    p_reference_number: input.referenceNumber || null,
    p_notes: input.notes || null,
    p_allocations: input.allocations,
    p_overpayment: round2(input.overpayment),
    p_route_overpayment: input.routeOverpayment,
    p_account_id: input.accountId || null,
  };
}

/** True when the collection moves no money, so no cash/bank account is needed. */
export function isWriteOffOnly(cashReceived: number): boolean {
  return toAmount(cashReceived) <= EPSILON;
}
