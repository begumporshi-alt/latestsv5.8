// One-off: estimate egress of a full offline-replica refresh (lib/offline/replica.ts).
// For each replicated table: exact row count + average JSON payload size
// measured from the first page, then full-table estimate = count x avg.
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://qdnbefqmcxjvddlabeww.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFkbmJlZnFtY3hqdmRkbGFiZXd3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwMDU1MjIsImV4cCI6MjA5ODU4MTUyMn0.IdBmZFin-5XtIhBgrfNwTDznvgOcDPE5ev5qR9Op6tU';
const supabase = createClient(supabaseUrl, supabaseKey);

const TABLES = [
  'products', 'inventory_items', 'product_units', 'customers', 'invoices',
  'invoice_items', 'payments', 'sales_returns', 'sales_return_items',
  'employees', 'attendance', 'warehouses', 'brands', 'categories',
  'payment_methods', 'suppliers', 'app_settings', 'customer_store_credits',
  'inventory_batches', 'accounts', 'journal_entries', 'journal_lines',
  'stock_movements', 'quotations', 'quotation_items', 'purchase_orders',
  'purchase_order_items', 'purchase_reminders', 'purchase_returns',
  'purchase_return_items', 'goods_receipt_notes', 'deliveries',
  'delivery_items', 'customer_advances', 'customer_advance_refunds',
  'customer_advance_applications', 'customer_notes',
  'store_credit_redemptions', 'cost_price_history', 'product_sizes',
  'product_colors', 'unit_types', 'projects', 'activity_logs', 'profiles',
  'online_orders', 'bank_reconciliation_items', 'inventory_reconciliation_log',
];

const mb = (b) => (b / 1024 / 1024).toFixed(1).padStart(9) + ' MB';

(async () => {
  let totalBytes = 0;
  const rowsOut = [];
  for (const t of TABLES) {
    const { count, error: cntErr } = await supabase
      .from(t).select('id', { count: 'exact', head: true });
    if (cntErr) { rowsOut.push([t, 'ERR', cntErr.message]); continue; }
    const { data, error } = await supabase
      .from(t).select('*').range(0, 999);
    if (error) { rowsOut.push([t, 'ERR', error.message]); continue; }
    const sample = data || [];
    const avg = sample.length
      ? sample.reduce((s, r) => s + JSON.stringify(r).length, 0) / sample.length
      : 0;
    const est = count * avg;
    totalBytes += est;
    rowsOut.push([t, count, mb(est)]);
  }
  for (const r of rowsOut) console.log(r.map(String).join(' | '));
  console.log('\nColumns: table | rows | est. full-table payload');
  console.log('Estimated TOTAL egress per full replica refresh: ' + mb(totalBytes));
})();
