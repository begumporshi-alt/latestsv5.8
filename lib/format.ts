export interface CurrencyFormat {
  symbol: string;
  symbol_position: 'before' | 'after';
  grouping: 'in' | 'en';
  large_display: 'current' | 'full' | 'compact';
  decimals: 0 | 1 | 2 | 3;
}

export const DEFAULT_CURRENCY_FORMAT: CurrencyFormat = {
  symbol: '৳',
  symbol_position: 'before',
  grouping: 'in',
  large_display: 'current',
  decimals: 0,
};

let currencyFormat: CurrencyFormat = { ...DEFAULT_CURRENCY_FORMAT };

export function getCurrencyFormat(): CurrencyFormat {
  return currencyFormat;
}

export function setCurrencyFormat(value: Partial<CurrencyFormat>): void {
  currencyFormat = {
    ...currencyFormat,
    ...value,
    symbol: typeof value.symbol === 'string' && value.symbol.trim() ? value.symbol : currencyFormat.symbol,
    decimals: ([0, 1, 2, 3] as const).includes(value.decimals as 0 | 1 | 2 | 3) ? (value.decimals as 0 | 1 | 2 | 3) : currencyFormat.decimals,
  };
}

function grouped(value: number, fmt: CurrencyFormat): string {
  const locale = fmt.grouping === 'en' ? 'en-US' : 'en-IN';
  return value.toLocaleString(locale, {
    minimumFractionDigits: fmt.decimals,
    maximumFractionDigits: fmt.decimals,
  });
}

export function formatCurrencyWith(amount: number | null | undefined, fmt: CurrencyFormat): string {
  const symbol = fmt.symbol;
  if (amount === null || amount === undefined || isNaN(Number(amount))) {
    return fmt.symbol_position === 'after' ? `0${symbol}` : `${symbol}0`;
  }
  const num = Number(amount);
  const abs = Math.abs(num);
  let body: string;
  if (fmt.large_display === 'compact') {
    if (abs >= 10000000) body = `${(num / 10000000).toFixed(2)}Cr`;
    else if (abs >= 100000) body = `${(num / 100000).toFixed(2)}L`;
    else body = grouped(num, fmt);
  } else if (fmt.large_display === 'full') {
    body = grouped(num, fmt);
  } else {
    if (abs >= 10000000) body = `${(num / 10000000).toFixed(2)}Cr`;
    else body = grouped(num, fmt);
  }
  return fmt.symbol_position === 'after' ? `${body}${symbol}` : `${symbol}${body}`;
}

export function formatCurrency(amount: number | null | undefined): string {
  return formatCurrencyWith(amount, currencyFormat);
}

/** Chart-axis ticks: same large-value rule as formatCurrency but without the symbol. */
export function formatAxisCurrency(value: number): string {
  return formatCurrencyWith(value, { ...currencyFormat, symbol: '' });
}

/** Amounts inside documents and tables: grouped, never compacted ("1.14Cr"
 *  would be wrong on a line item), decimals follow the company setting. */
export function formatAmount(n: number | null | undefined): string {
  return formatCurrencyWith(n, { ...currencyFormat, symbol: '', large_display: 'full' });
}

export function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

/** Today as YYYY-MM-DD in the browser's local timezone.
 *
 *  Do not use `new Date().toISOString().split('T')[0]` for a business date:
 *  toISOString() is UTC, so anywhere east of Greenwich it returns yesterday
 *  for the first hours of the day (in Dhaka, 00:00–05:59). That is how the
 *  Phase 3 transfer was stamped 30 Oct when it was posted on 31 Oct. */
export function localDateISO(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins} mins ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
  return formatDate(dateStr);
}

export function getInitials(name: string): string {
  return name
    .split(' ')
    .slice(0, 2)
    .map((n) => n[0])
    .join('')
    .toUpperCase();
}

// Overdue is COMPUTED, never stored: nothing in the app writes the
// invoices.status 'overdue' value (verified in GAP-AUDIT-2026-09-06), so any
// UI that keys on the status never fires. An unpaid invoice is overdue when
// its due date has passed. Fully-paid and cancelled invoices are never
// overdue regardless of the due date.
export function isInvoiceOverdue(inv: { status: string; due_date?: string | null }): boolean {
  if (!inv.due_date) return false;
  if (inv.status !== 'sent' && inv.status !== 'partially_paid' && inv.status !== 'overdue') return false;
  const today = new Date().toISOString().slice(0, 10);
  return inv.due_date.slice(0, 10) < today;
}
