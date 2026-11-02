/**
 * Manual-receivable outstanding, per customer.
 *
 * The CRM list used to infer this by subtraction:
 *
 *     manual_outstanding = max(0, customers.outstanding_balance - invoice_due)
 *
 * That is only correct while `customers.outstanding_balance` happens to equal
 * invoice dues plus open manual receivables. It is a derived guess, not a
 * measurement, and it fails in both directions: if the stored balance drifts
 * low the manual tab disappears from Collect Payment, and if it drifts high
 * the modal offers to collect a receivable that does not exist.
 *
 * This module computes the figure from the same source the collection itself
 * uses (`components/CollectPaymentModal.processManualPayment`): posted journal
 * entries with `reference_type = 'receivable'`, less the payments booked
 * against them — counting `bad_debt_amount` as settlement, because a written-
 * off receivable is no longer collectable.
 *
 * Per-entry filtering matters: an overpaid receivable does not offset an
 * underpaid one, and `processManualPayment` only walks entries with a positive
 * remainder. Summing entry-level remainders keeps the list consistent with
 * what the modal will actually collect.
 */

const EPSILON = 0.01;

export interface ReceivableEntry {
  id: string;
  customer_id: string | null;
  total_debit: number | string | null;
}

export interface ReceivablePayment {
  reference_id: string | null;
  amount: number | string | null;
  bad_debt_amount: number | string | null;
}

function toAmount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Returns `{ customer_id: open manual receivable }` for every customer with
 * something left to collect. Customers with nothing open are omitted.
 */
export function buildManualOutstandingMap(
  entries: ReceivableEntry[],
  payments: ReceivablePayment[],
): Record<string, number> {
  const settled = new Map<string, number>();
  for (const payment of payments) {
    if (!payment.reference_id) continue;
    const amount = toAmount(payment.amount) + toAmount(payment.bad_debt_amount);
    settled.set(payment.reference_id, (settled.get(payment.reference_id) || 0) + amount);
  }

  const byCustomer: Record<string, number> = {};
  for (const entry of entries) {
    if (!entry.customer_id) continue;
    const outstanding = toAmount(entry.total_debit) - (settled.get(entry.id) || 0);
    if (outstanding <= EPSILON) continue;
    byCustomer[entry.customer_id] = (byCustomer[entry.customer_id] || 0) + outstanding;
  }

  // Round once per customer so repeated floating-point additions cannot leak
  // a sub-paisa residue into the UI.
  for (const id of Object.keys(byCustomer)) {
    byCustomer[id] = Math.round(byCustomer[id] * 100) / 100;
  }

  return byCustomer;
}
