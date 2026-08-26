-- ============================================================================
-- DIAGNOSTIC: Find sales returns affected by the multi-unit bug
-- ============================================================================
-- Run these READ-ONLY queries to size the damage before reconciling.
-- Context: FIFO_MULTI_UNIT_ANALYSIS.md Section 9
--
-- The bug: sales returns restored inventory/FIFO in SALE units instead of
-- BASE units. Only affects products where conversion_factor != 1.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- QUERY 1: Which returns are affected, and by how much?
-- ----------------------------------------------------------------------------
-- Any row returned here has under-restored stock and under-reversed COGS.
SELECT
  sr.return_number,
  sr.return_date,
  p.name                        AS product_name,
  p.sku,
  ii.unit_name                  AS sold_in_unit,
  sri.quantity_returned         AS qty_returned_sale_units,
  sri.base_quantity_returned    AS base_qty_recorded,
  -- What base qty SHOULD have been:
  ROUND(sri.quantity_returned * (ii.base_quantity / NULLIF(ii.quantity, 0)), 3)
                                AS base_qty_expected,
  -- The shortfall in base units (stock never returned to inventory):
  ROUND(
    sri.quantity_returned * (ii.base_quantity / NULLIF(ii.quantity, 0))
    - COALESCE(sri.base_quantity_returned, sri.quantity_returned), 3
  )                             AS base_qty_shortfall,
  ROUND(ii.base_quantity / NULLIF(ii.quantity, 0), 4) AS conversion_factor
FROM sales_return_items sri
JOIN sales_returns sr ON sr.id = sri.sales_return_id
JOIN invoice_items  ii ON ii.id = sri.invoice_item_id
JOIN products        p ON p.id = sri.product_id
WHERE ii.base_quantity IS NOT NULL
  AND ii.quantity > 0
  -- Only multi-unit lines are affected:
  AND ABS(ii.base_quantity / ii.quantity - 1) > 0.0001
  -- Affected = base qty was never recorded, or recorded wrong:
  AND (
    sri.base_quantity_returned IS NULL
    OR ABS(sri.base_quantity_returned
           - sri.quantity_returned * (ii.base_quantity / ii.quantity)) > 0.001
  )
ORDER BY sr.return_date DESC, p.name;


-- ----------------------------------------------------------------------------
-- QUERY 2: Blast-radius summary — how bad is it overall?
-- ----------------------------------------------------------------------------
SELECT
  COUNT(*)                                  AS affected_return_lines,
  COUNT(DISTINCT sr.id)                     AS affected_returns,
  COUNT(DISTINCT sri.product_id)            AS affected_products,
  ROUND(SUM(
    sri.quantity_returned * (ii.base_quantity / NULLIF(ii.quantity, 0))
    - COALESCE(sri.base_quantity_returned, sri.quantity_returned)
  ), 3)                                     AS total_base_units_missing,
  MIN(sr.return_date)                       AS earliest_affected,
  MAX(sr.return_date)                       AS latest_affected
FROM sales_return_items sri
JOIN sales_returns sr ON sr.id = sri.sales_return_id
JOIN invoice_items  ii ON ii.id = sri.invoice_item_id
WHERE ii.base_quantity IS NOT NULL
  AND ii.quantity > 0
  AND ABS(ii.base_quantity / ii.quantity - 1) > 0.0001
  AND (
    sri.base_quantity_returned IS NULL
    OR ABS(sri.base_quantity_returned
           - sri.quantity_returned * (ii.base_quantity / ii.quantity)) > 0.001
  );


-- ----------------------------------------------------------------------------
-- QUERY 3: Understated COGS reversal per affected return
-- ----------------------------------------------------------------------------
-- How much COGS was NOT reversed (profit currently understated by this).
WITH fifo_cost AS (
  SELECT
    iibc.invoice_item_id,
    SUM(iibc.cogs_amount) / NULLIF(SUM(iibc.quantity_consumed), 0) AS cost_per_base_unit
  FROM invoice_item_batch_consumption iibc
  GROUP BY iibc.invoice_item_id
)
SELECT
  sr.return_number,
  p.name AS product_name,
  ROUND(fc.cost_per_base_unit, 4) AS cost_per_base_unit,
  ROUND(
    sri.quantity_returned * (ii.base_quantity / NULLIF(ii.quantity, 0))
    * fc.cost_per_base_unit, 2
  )                                AS cogs_should_have_reversed,
  ROUND(sri.quantity_returned * fc.cost_per_base_unit, 2)
                                   AS cogs_actually_reversed,
  ROUND(
    (sri.quantity_returned * (ii.base_quantity / NULLIF(ii.quantity, 0))
     - sri.quantity_returned) * fc.cost_per_base_unit, 2
  )                                AS cogs_understated_by
FROM sales_return_items sri
JOIN sales_returns sr ON sr.id = sri.sales_return_id
JOIN invoice_items  ii ON ii.id = sri.invoice_item_id
JOIN products        p ON p.id = sri.product_id
JOIN fifo_cost      fc ON fc.invoice_item_id = sri.invoice_item_id
WHERE ii.base_quantity IS NOT NULL
  AND ii.quantity > 0
  AND ABS(ii.base_quantity / ii.quantity - 1) > 0.0001
  AND sri.base_quantity_returned IS NULL
ORDER BY ABS(
  (sri.quantity_returned * (ii.base_quantity / NULLIF(ii.quantity, 0))
   - sri.quantity_returned) * fc.cost_per_base_unit
) DESC;


-- ----------------------------------------------------------------------------
-- QUERY 4: Sanity check — did cancel_invoice over-restore anywhere?
-- ----------------------------------------------------------------------------
-- cancel_invoice nets returns via base_quantity_returned. Where that was NULL
-- it fell back to sale units, so cancelled invoices that had prior returns on
-- multi-unit products over-restored stock.
SELECT
  i.invoice_number,
  i.status,
  p.name AS product_name,
  ii.quantity        AS sold_sale_units,
  ii.base_quantity   AS sold_base_units,
  sri.quantity_returned,
  sri.base_quantity_returned,
  'cancel_invoice netted in SALE units -> over-restored stock' AS issue
FROM invoices i
JOIN invoice_items      ii  ON ii.invoice_id = i.id
JOIN products            p  ON p.id = ii.product_id
JOIN sales_return_items sri ON sri.invoice_item_id = ii.id
JOIN sales_returns       sr ON sr.id = sri.sales_return_id
WHERE i.status IN ('cancelled', 'refunded')
  AND sri.base_quantity_returned IS NULL
  AND ii.base_quantity IS NOT NULL
  AND ii.quantity > 0
  AND ABS(ii.base_quantity / ii.quantity - 1) > 0.0001;
