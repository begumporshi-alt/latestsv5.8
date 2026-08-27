-- Confirm the 7 post-resync residual rows are test products whose INVOICE cost
-- (now faithfully mirrored) genuinely produces an extreme ratio, and check
-- whether those products are multi-unit (guard applies) or single-unit (skipped).

\echo '=== The 7 residual products: unit configuration ==='
WITH residual AS (
  SELECT DISTINCT cph.product_id, cph.product_name
  FROM cost_price_history cph
  JOIN invoice_items ii
    ON ii.invoice_id = cph.invoice_id AND ii.product_id = cph.product_id
  WHERE cph.invoice_id IS NOT NULL AND cph.unit_price > 0
    AND ABS(cph.cost_price_per_qty - ii.cost_price) <= 0.01          -- already matches invoice
    AND (ii.cost_price / cph.unit_price > 3 OR ii.cost_price / cph.unit_price < 0.05)
)
SELECT left(r.product_name, 26) AS product,
       COALESCE((SELECT MAX(pu.conversion_factor) FROM product_units pu
                 WHERE pu.product_id = r.product_id AND pu.is_sale_unit
                   AND pu.conversion_factor > 1), 1) AS max_sale_cf,
       CASE WHEN COALESCE((SELECT MAX(pu.conversion_factor) FROM product_units pu
                 WHERE pu.product_id = r.product_id AND pu.is_sale_unit
                   AND pu.conversion_factor > 1), 1) > 1
            THEN 'MULTI-UNIT (guard would check)'
            ELSE 'single-unit (guard skips)' END AS guard_behavior
FROM residual r
ORDER BY 1;

\echo ''
\echo '=== TRUE post-repair check: invoice-linked rows that still DIVERGE from invoice ==='
-- This is what the re-sync actually guarantees. Should be 0.
SELECT COUNT(*) AS rows_still_diverging_from_invoice
FROM cost_price_history cph
JOIN invoice_items ii
  ON ii.invoice_id = cph.invoice_id AND ii.product_id = cph.product_id
WHERE cph.invoice_id IS NOT NULL
  AND ABS(cph.cost_price_per_qty - ii.cost_price) > 0.01;
