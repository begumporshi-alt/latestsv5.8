import { redirect } from 'next/navigation';

/**
 * The Reports & Analytics dashboard is gone.
 *
 * Its overview, inventory, customers and P&L tabs all recomputed figures that
 * already have a maintained home — Sales report, Inventory report and the
 * P&L Statement — and the two copies had drifted (different revenue bases,
 * different expense exclusions). Keeping one source per number is worth more
 * than the convenience of a single page.
 *
 * The route stays as a redirect rather than being deleted so existing bookmarks,
 * the quick-action drawer and the printed footers on already-issued documents
 * still resolve instead of hitting a 404.
 */
export default function ReportsRedirect() {
  redirect('/reports/sales');
}
