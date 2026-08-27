-- Cardinality + composition check before designing the re-sync UPDATE.

\echo '=== A. Cardinality: invoice_items per (invoice_id, product_id) ==='
SELECT items_per_pair, COUNT(*) AS pairs FROM (
  SELECT invoice_id, product_id, COUNT(*) AS items_per_pair
  FROM invoice_items GROUP BY invoice_id, product_id
) x GROUP BY 1 ORDER BY 1;

\echo ''
\echo '=== B. Cardinality: cost_price_history rows per (invoice_id, product_id) ==='
SELECT hist_per_pair, COUNT(*) AS pairs FROM (
  SELECT invoice_id, product_id, COUNT(*) AS hist_per_pair
  FROM cost_price_history WHERE invoice_id IS NOT NULL
  GROUP BY invoice_id, product_id
) x GROUP BY 1 ORDER BY 1;

\echo ''
\echo '=== C. Do multi-item pairs have differing cost_price? (ambiguity risk) ==='
SELECT COUNT(*) AS pairs_with_multiple_distinct_costs FROM (
  SELECT invoice_id, product_id
  FROM invoice_items
  GROUP BY invoice_id, product_id
  HAVING COUNT(DISTINCT cost_price) > 1
) x;

\echo ''
\echo '=== D. The 17 minor_diff rows: are they scale errors or genuine small gaps? ==='
WITH ii AS (
  SELECT invoice_id, product_id, MAX(cost_price) AS ii_cost, COUNT(*) AS n_items
  FROM invoice_items GROUP BY invoice_id, product_id
)
SELECT left(cph.product_name, 24) AS product, cph.unit, cph.quantity,
       ROUND(cph.unit_price,2) AS price,
       ROUND(cph.cost_price_per_qty,2) AS snapshot_cost,
       ROUND(ii.ii_cost,2) AS invoice_cost, ii.n_items,
       cph.created_at::date AS recorded
FROM cost_price_history cph
JOIN ii ON ii.invoice_id = cph.invoice_id AND ii.product_id = cph.product_id
WHERE cph.invoice_id IS NOT NULL
  AND ABS(cph.cost_price_per_qty - ii.ii_cost) > 0.01
  AND NOT (cph.cost_price_per_qty / NULLIF(ii.ii_cost,0) > 3)
  AND NOT (cph.cost_price_per_qty / NULLIF(ii.ii_cost,0) < 0.34)
ORDER BY ABS(cph.cost_price_per_qty - ii.ii_cost) DESC;

\echo ''
\echo '=== E. The 11 no_matching_invoice_item rows (orphans) ==='
SELECT left(cph.product_name, 26) AS product, cph.unit, cph.quantity,
       ROUND(cph.unit_price,2) AS price, ROUND(cph.cost_price_per_qty,2) AS snapshot_cost,
       cph.created_at::date AS recorded,
       (SELECT i.status FROM invoices i WHERE i.id = cph.invoice_id) AS invoice_status
FROM cost_price_history cph
LEFT JOIN (SELECT DISTINCT invoice_id, product_id FROM invoice_items) ii
  ON ii.invoice_id = cph.invoice_id AND ii.product_id = cph.product_id
WHERE cph.invoice_id IS NOT NULL AND ii.invoice_id IS NULL
ORDER BY cph.created_at DESC;
