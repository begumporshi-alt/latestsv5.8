-- cost_price_history is a display snapshot of invoice_items.cost_price (see the
-- backfill migration 20260810: cost_price_per_qty := ii.cost_price). The COGS
-- repair corrected invoice_items.cost_price but did NOT touch this table, so any
-- invoice-linked row whose snapshot no longer equals the corrected invoice line
-- is now STALE and the "cost price history" tab shows the wrong (old) cost.
-- Two independent tests over the last 7 days.

\echo '=== A. Self-consistency: cost_price_per_qty vs unit_price (last 7 days) ==='
-- Same ratio discriminator used for invoice_items: >3 cost too high, <0.05 too low.
SELECT CASE
         WHEN unit_price = 0 OR cost_price_per_qty = 0 THEN 'zero_price_or_cost'
         WHEN cost_price_per_qty / unit_price > 3      THEN 'cost_too_high'
         WHEN cost_price_per_qty / unit_price < 0.05   THEN 'cost_too_low'
         ELSE 'consistent'
       END AS bucket,
       COUNT(*) AS rows,
       ROUND(MIN(cost_price_per_qty / NULLIF(unit_price,0)), 3) AS min_ratio,
       ROUND(MAX(cost_price_per_qty / NULLIF(unit_price,0)), 3) AS max_ratio
FROM cost_price_history
WHERE created_at >= CURRENT_DATE - 7
GROUP BY 1 ORDER BY 2 DESC;

\echo ''
\echo '=== B. Divergence from the CORRECTED invoice_items.cost_price (last 7 days) ==='
-- The authoritative value. cph should equal ii.cost_price for the same
-- (invoice_id, product_id). After the repair, mismatches are stale snapshots.
WITH ii AS (
  SELECT invoice_id, product_id,
         SUM(cost_price * quantity) / NULLIF(SUM(quantity), 0) AS ii_cost,
         SUM(quantity) AS ii_qty
  FROM invoice_items
  GROUP BY invoice_id, product_id
)
SELECT CASE
         WHEN ii.invoice_id IS NULL                                THEN 'no_matching_invoice_item'
         WHEN ABS(cph.cost_price_per_qty - ii.ii_cost) <= 0.01     THEN 'matches_corrected_invoice'
         WHEN ii.ii_cost = 0                                       THEN 'invoice_cost_zero'
         WHEN cph.cost_price_per_qty / NULLIF(ii.ii_cost,0) > 3    THEN 'STALE_snapshot_too_high'
         WHEN cph.cost_price_per_qty / NULLIF(ii.ii_cost,0) < 0.34 THEN 'STALE_snapshot_too_low'
         ELSE 'minor_diff'
       END AS bucket,
       COUNT(*) AS rows,
       ROUND(SUM(cph.cost_price_for_added_qty), 2) AS snapshot_total,
       ROUND(SUM(ii.ii_cost * cph.quantity), 2)    AS corrected_total
FROM cost_price_history cph
LEFT JOIN ii ON ii.invoice_id = cph.invoice_id AND ii.product_id = cph.product_id
WHERE cph.created_at >= CURRENT_DATE - 7
  AND cph.invoice_id IS NOT NULL
GROUP BY 1 ORDER BY 2 DESC;

\echo ''
\echo '=== C. The stale rows in detail (worst 25 by absolute gap) ==='
WITH ii AS (
  SELECT invoice_id, product_id,
         SUM(cost_price * quantity) / NULLIF(SUM(quantity), 0) AS ii_cost
  FROM invoice_items GROUP BY invoice_id, product_id
)
SELECT left(cph.product_name, 26) AS product, cph.unit, cph.quantity,
       ROUND(cph.unit_price, 2) AS price,
       ROUND(cph.cost_price_per_qty, 2) AS snapshot_cost,
       ROUND(ii.ii_cost, 2) AS corrected_cost,
       ROUND((cph.cost_price_per_qty - ii.ii_cost) * cph.quantity, 2) AS gap_on_line,
       cph.created_at::date AS recorded
FROM cost_price_history cph
JOIN ii ON ii.invoice_id = cph.invoice_id AND ii.product_id = cph.product_id
WHERE cph.created_at >= CURRENT_DATE - 7
  AND ABS(cph.cost_price_per_qty - ii.ii_cost) > 0.01
ORDER BY ABS((cph.cost_price_per_qty - ii.ii_cost) * cph.quantity) DESC
LIMIT 25;

\echo ''
\echo '=== D. Quotation-linked rows in last 7 days (no invoice_items to compare) ==='
SELECT COUNT(*) AS quotation_rows,
       COUNT(*) FILTER (WHERE unit_price > 0 AND cost_price_per_qty / unit_price > 3) AS cost_too_high,
       COUNT(*) FILTER (WHERE unit_price > 0 AND cost_price_per_qty / unit_price < 0.05) AS cost_too_low
FROM cost_price_history
WHERE created_at >= CURRENT_DATE - 7 AND quotation_id IS NOT NULL;
