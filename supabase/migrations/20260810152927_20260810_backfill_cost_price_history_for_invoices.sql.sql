-- Backfill cost_price_history for invoices that have invoice_items but no history records.
-- This happens when invoices were created via quotation conversion before the fix was applied.

INSERT INTO cost_price_history (
  product_id,
  product_name,
  product_sku,
  invoice_id,
  unit,
  quantity,
  unit_price,
  cost_price_per_qty,
  cost_price_for_added_qty,
  total_cost_price_single,
  total_cost_price_added,
  recorded_at
)
SELECT
  ii.product_id,
  COALESCE(p.name, ii.description, ''),
  COALESCE(p.sku, ''),
  ii.invoice_id,
  COALESCE(ii.unit_name, p.unit, 'pcs'),
  ii.quantity,
  ii.unit_price,
  COALESCE(ii.cost_price, 0),
  COALESCE(ii.cost_price, 0) * ii.quantity,
  COALESCE(ii.cost_price, 0),
  COALESCE(ii.cost_price, 0) * ii.quantity,
  COALESCE(i.invoice_date, i.created_at, now())
FROM invoice_items ii
JOIN invoices i ON i.id = ii.invoice_id
LEFT JOIN products p ON p.id = ii.product_id
WHERE i.status IN ('sent', 'partially_paid', 'paid', 'overdue', 'refunded', 'refundable')
  AND NOT EXISTS (
    SELECT 1 FROM cost_price_history cph WHERE cph.invoice_id = ii.invoice_id
  );
