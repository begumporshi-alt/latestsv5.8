export function formatCurrency(amount: number | null | undefined, symbol = '৳'): string {
  if (amount === null || amount === undefined || isNaN(Number(amount))) {
    return `${symbol}0`;
  }
  const num = Number(amount);
  if (num >= 10000000) {
    return `${symbol}${(num / 10000000).toFixed(2)}Cr`;
  }
  if (num >= 100000) {
    return `${symbol}${(num / 100000).toFixed(2)}L`;
  }
  return `${symbol}${num.toLocaleString('en-IN')}`;
}

export function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
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
