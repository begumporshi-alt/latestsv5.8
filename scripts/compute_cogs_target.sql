-- Rebuild the COGS target correctly.
-- invoice_item_batch_consumption covers only the FIFO-path invoices; the rest
-- were posted by invoice_items_cogs_trigger as quantity * cost_price.
-- True COGS per item = consumption sum if it exists, else quantity * cost_price.

\echo '=== 0. Invoice status distribution (which count as sold?) ==='
SELECT status, COUNT(*) AS invoices, ROUND(SUM(total_amount),2) AS revenue
FROM invoices GROUP BY status ORDER BY 2 DESC;

\echo ''
\echo '=== 1. Per-item true cost, split by basis (corrected batch costs applied) ==='
WITH su AS (
  SELECT product_id, MAX(conversion_factor) AS cf
  FROM product_units WHERE is_sale_unit AND conversion_factor > 1 GROUP BY product_id
),
corrected_batch AS (
  SELECT b.id,
    CASE WHEN p.enable_multi_unit AND p.cost_price > 0 AND b.unit_cost > p.cost_price*3
         THEN COALESCE(b.unit_cost/su.cf, p.cost_price)
         ELSE b.unit_cost END AS cost
  FROM inventory_batches b
  JOIN products p ON p.id = b.product_id
  LEFT JOIN su ON su.product_id = b.product_id
),
item_fifo AS (
  SELECT ibc.invoice_item_id, SUM(ibc.quantity_consumed * cb.cost) AS fifo_cost
  FROM invoice_item_batch_consumption ibc
  JOIN corrected_batch cb ON cb.id = ibc.batch_id
  GROUP BY ibc.invoice_item_id
)
SELECT
  CASE WHEN f.invoice_item_id IS NOT NULL THEN 'fifo_based' ELSE 'cost_price_based' END AS basis,
  COUNT(*) AS items,
  COUNT(DISTINCT ii.invoice_id) AS invoices,
  ROUND(SUM(COALESCE(f.fifo_cost, ii.quantity * ii.cost_price)),2) AS true_cogs
FROM invoice_items ii
JOIN invoices i ON i.id = ii.invoice_id
LEFT JOIN item_fifo f ON f.invoice_item_id = ii.id
WHERE i.status IN ('sent','partially_paid','paid')
GROUP BY 1;

\echo ''
\echo '=== 2. TARGET COGS vs current journal vs revenue ==='
WITH su AS (
  SELECT product_id, MAX(conversion_factor) AS cf
  FROM product_units WHERE is_sale_unit AND conversion_factor > 1 GROUP BY product_id
),
corrected_batch AS (
  SELECT b.id,
    CASE WHEN p.enable_multi_unit AND p.cost_price > 0 AND b.unit_cost > p.cost_price*3
         THEN COALESCE(b.unit_cost/su.cf, p.cost_price)
         ELSE b.unit_cost END AS cost
  FROM inventory_batches b
  JOIN products p ON p.id = b.product_id
  LEFT JOIN su ON su.product_id = b.product_id
),
item_fifo AS (
  SELECT ibc.invoice_item_id, SUM(ibc.quantity_consumed * cb.cost) AS fifo_cost
  FROM invoice_item_batch_consumption ibc
  JOIN corrected_batch cb ON cb.id = ibc.batch_id
  GROUP BY ibc.invoice_item_id
),
target AS (
  SELECT SUM(COALESCE(f.fifo_cost, ii.quantity * ii.cost_price)) AS total
  FROM invoice_items ii
  JOIN invoices i ON i.id = ii.invoice_id
  LEFT JOIN item_fifo f ON f.invoice_item_id = ii.id
  WHERE i.status IN ('sent','partially_paid','paid')
)
SELECT 'target_cogs' AS metric, ROUND((SELECT total FROM target),2) AS value
UNION ALL SELECT 'current_journal_5000_net',
  ROUND((SELECT COALESCE(SUM(jl.debit-jl.credit),0) FROM journal_lines jl
         JOIN accounts a ON a.id=jl.account_id WHERE a.code='5000'),2)
UNION ALL SELECT 'revenue_4000_journal_natural',
  ROUND((SELECT COALESCE(SUM(jl.credit-jl.debit),0) FROM journal_lines jl
         JOIN accounts a ON a.id=jl.account_id WHERE a.code='4000'),2)
UNION ALL SELECT 'revenue_from_invoices',
  ROUND((SELECT COALESCE(SUM(total_amount),0) FROM invoices
         WHERE status IN ('sent','partially_paid','paid')),2)
UNION ALL SELECT 'target_as_pct_of_invoice_revenue',
  ROUND((SELECT total FROM target) /
        NULLIF((SELECT SUM(total_amount) FROM invoices WHERE status IN ('sent','partially_paid','paid')),0)*100,2);
