-- Full-table scope (all dates, not just 7 days) so we can decide whether to fix
-- everything or only the recent window.
--
-- Invoice-linked rows are compared to the corrected invoice_items.cost_price,
-- which is authoritative (it drove COGS and is what the invoice displays).
--
-- Quotation-linked rows have NO authoritative source to compare against:
-- quotation_items has no cost_price column, so cost_price_history IS the only
-- place a quotation's cost snapshot is stored. For those rows the best available
-- test is the self-consistency cost/price ratio in section B.

\echo '=== A. Invoice-linked: divergence from corrected invoice_items (ALL dates) ==='
WITH ii AS (
  SELECT invoice_id, product_id,
         SUM(cost_price * quantity) / NULLIF(SUM(quantity), 0) AS ii_cost
  FROM invoice_items GROUP BY invoice_id, product_id
)
SELECT CASE
         WHEN ii.invoice_id IS NULL                                THEN 'no_matching_invoice_item'
         WHEN ABS(cph.cost_price_per_qty - ii.ii_cost) <= 0.01     THEN 'matches_corrected_invoice'
         WHEN ii.ii_cost = 0                                       THEN 'invoice_cost_zero'
         WHEN cph.cost_price_per_qty / NULLIF(ii.ii_cost,0) > 3    THEN 'STALE_too_high'
         WHEN cph.cost_price_per_qty / NULLIF(ii.ii_cost,0) < 0.34 THEN 'STALE_too_low'
         ELSE 'minor_diff'
       END AS bucket,
       COUNT(*) AS rows
FROM cost_price_history cph
LEFT JOIN ii ON ii.invoice_id = cph.invoice_id AND ii.product_id = cph.product_id
WHERE cph.invoice_id IS NOT NULL
GROUP BY 1 ORDER BY 2 DESC;

\echo ''
\echo '=== B. Quotation-linked: self-consistency ratio (ALL dates) ==='
-- Quotations are proposals, not ledger; there is no "corrected" source, so use
-- the cost/price ratio to spot scale defects.
SELECT CASE
         WHEN unit_price = 0 OR cost_price_per_qty = 0 THEN 'zero_price_or_cost'
         WHEN cost_price_per_qty / unit_price > 3      THEN 'cost_too_high'
         WHEN cost_price_per_qty / unit_price < 0.05   THEN 'cost_too_low'
         ELSE 'consistent'
       END AS bucket,
       COUNT(*) AS rows
FROM cost_price_history
WHERE quotation_id IS NOT NULL
GROUP BY 1 ORDER BY 2 DESC;

-- NOTE: Sections C and D removed — quotation_items has no cost_price column,
-- so those queries cannot run. Section B (self-consistency ratio) is the only
-- available test for quotation-linked rows and found 0 scale defects.
