-- V2 in the migration flags 7 invoice-linked rows as still carrying a scale
-- defect AFTER the re-sync. The re-sync only touches rows that have a matching
-- invoice_item. So these 7 must be orphans (invoice_id set, no matching
-- invoice_item) whose stored cost/price ratio trips the >3 or <0.05 test.
-- Enumerate them precisely and show whether an invoice_item exists.

\echo '=== The exact rows V2 counts (invoice-linked, ratio >3 or <0.05) ==='
SELECT left(cph.product_name, 26) AS product, cph.unit, cph.quantity,
       ROUND(cph.unit_price, 2) AS price,
       ROUND(cph.cost_price_per_qty, 2) AS snapshot_cost,
       ROUND(cph.cost_price_per_qty / NULLIF(cph.unit_price,0), 4) AS ratio,
       cph.created_at::date AS recorded,
       (SELECT COUNT(*) FROM invoice_items ii
          WHERE ii.invoice_id = cph.invoice_id
            AND ii.product_id = cph.product_id) AS matching_invoice_items,
       (SELECT ROUND(MAX(ii.cost_price),2) FROM invoice_items ii
          WHERE ii.invoice_id = cph.invoice_id
            AND ii.product_id = cph.product_id) AS invoice_item_cost
FROM cost_price_history cph
WHERE cph.invoice_id IS NOT NULL AND cph.unit_price > 0 AND cph.cost_price_per_qty > 0
  AND (cph.cost_price_per_qty / cph.unit_price > 3
       OR cph.cost_price_per_qty / cph.unit_price < 0.05)
ORDER BY cph.created_at DESC;

\echo ''
\echo '=== Are these the same as the 11 known orphans? (invoice_id set, no invoice_item) ==='
SELECT COUNT(*) AS orphan_rows_total,
       COUNT(*) FILTER (WHERE cph.unit_price > 0 AND cph.cost_price_per_qty > 0
                          AND (cph.cost_price_per_qty / cph.unit_price > 3
                               OR cph.cost_price_per_qty / cph.unit_price < 0.05))
         AS orphans_that_trip_v2
FROM cost_price_history cph
LEFT JOIN (SELECT DISTINCT invoice_id, product_id FROM invoice_items) ii
  ON ii.invoice_id = cph.invoice_id AND ii.product_id = cph.product_id
WHERE cph.invoice_id IS NOT NULL AND ii.invoice_id IS NULL;
