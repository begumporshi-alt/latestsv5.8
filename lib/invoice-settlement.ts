import { formatCurrency } from './format';

/**
 * Settlement state of an invoice that was closed with a bad-debt write-off.
 *
 * `invoices.status` answers "is this invoice still open?" — a written-off
 * invoice is settled, so `paid` is correct on that axis. It does not answer
 * "was the money collected or forgiven?", which is what finance needs to see.
 * Rather than add a new status value (which every status filter and the offline
 * replica layer would have to learn), the settlement is derived from
 * `bad_debt_amount` and surfaced as a separate badge.
 *
 * Deliberately driven by `bad_debt_amount > 0`, never by `balance_due = 0`:
 * a rounding-tolerance invoice also has a zero balance and must not read as
 * written off.
 */
export interface SettlementSource {
  status?: string | null;
  total_amount?: number | string | null;
  amount_paid?: number | string | null;
  bad_debt_amount?: number | string | null;
}

export interface InvoiceSettlement {
  /** Amount forgiven, 0 when the invoice carries no write-off. */
  writtenOff: number;
  isWrittenOff: boolean;
  /** True when no cash was collected at all — the whole invoice was forgiven. */
  isFullyWrittenOff: boolean;
  /** Short badge text, empty when there is nothing to show. */
  label: string;
  /** Tooltip explaining the badge, empty when there is nothing to show. */
  title: string;
}

const NONE: InvoiceSettlement = {
  writtenOff: 0,
  isWrittenOff: false,
  isFullyWrittenOff: false,
  label: '',
  title: '',
};

const EPSILON = 0.005;

export function getInvoiceSettlement(inv: SettlementSource | null | undefined): InvoiceSettlement {
  if (!inv) return NONE;

  const status = String(inv.status ?? '').toLowerCase();
  // A cancelled invoice is void rather than settled, and cancelling zeroes any
  // write-off; a draft has not been billed yet. Neither should show the badge.
  if (status === 'cancelled' || status === 'draft') return NONE;

  const writtenOff = Number(inv.bad_debt_amount ?? 0);
  if (!Number.isFinite(writtenOff) || writtenOff <= EPSILON) return NONE;

  const total = Number(inv.total_amount ?? 0);
  const paid = Number(inv.amount_paid ?? 0);
  const isFullyWrittenOff =
    Number.isFinite(paid) && paid <= EPSILON && Number.isFinite(total) && total > 0;

  return {
    writtenOff,
    isWrittenOff: true,
    isFullyWrittenOff,
    label: 'Written off',
    title: isFullyWrittenOff
      ? `${formatCurrency(writtenOff)} written off as bad debt — nothing was collected on this invoice.`
      : `${formatCurrency(writtenOff)} written off as bad debt; the remainder was collected.`,
  };
}
