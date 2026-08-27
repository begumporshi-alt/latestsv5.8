-- ============================================================================
-- DIAGNOSTIC: COGS Overstatement Analysis
-- ============================================================================
-- Two bugs cause COGS to exceed revenue:
--
-- BUG 1: Batch unit_cost stored in SALE units instead of BASE units
-- - Opening/adjustment batches for multi-unit products wrote products.cost_price
--   (which was per-coil) as the per-meter batch cost
-- - When FIFO consumed those batches, COGS was inflated by conversion_factor
-- - Impact: ~4.54M COGS overstatement
--
-- BUG 2: Duplicate COGS journal entries
-- - Journal account 5000 has 2.2M more debit than FIFO source-of-truth
-- - Edits/cancellations created extra journal lines without proper reversal
-- - Impact: ~2.2M additional COGS overstatement
--
-- Run in sections to size the damage and identify affected records.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- SECTION 1: SUMMARY NUMBERS
-- ----------------------------------------------------------------------------
SELECT
  'stored_balance_5000' AS metric, 9616898.78::numeric AS value
UNION ALL SELECT 'journal_net_debit', 8258083.59
UNION ALL SELECT 'fifo_total_cogs', 6058145.16
UNION ALL SELECT 'batch_inflation_overstatement', 4539735.38
UNION ALL SELECT 'corrected_fifo_cogs', 6058145.16 - 4539735.38
UNION ALL SELECT 'journal_duplication_gap', 8258083.59 - 6058145.16;


-- ----------------------------------------------------------------------------
-- SECTION 2: INFLATED BATCHES (Bug 1)
-- ----------------------------------------------------------------------------
-- Batches where unit_cost appears to be in sale units (way higher than base cost)
WITH conv AS (
  SELECT product_id, MAX(conversion_factor) AS cf
  FROM product_units WHERE is_sale_unit AND conversion_factor > 1
  GROUP BY product_id
)
SELECT
  b.id AS batch_id,
  b.batch_number,
  b.batch_type,
  p.name AS product_name,
  p.unit AS base_unit,
  b.unit_cost AS batch_unit_cost,
  p.cost_price AS correct_base_cost,
  ROUND(b.unit_cost / NULLIF(p.cost_price, 0), 2) AS cost_ratio,
  c.cf AS conversion_factor,
  b.quantity_remaining,
  b.created_at::date AS created
FROM inventory_batches b
JOIN products p ON p.id = b.product_id
JOIN conv c ON c.product_id = b.product_id
WHERE b.unit_cost > p.cost_price * 3  -- inflated by more than 3x
  AND p.cost_price > 0
ORDER BY b.unit_cost DESC;


-- ----------------------------------------------------------------------------
-- SECTION 3: COGS FROM INFLATED BATCHES (Bug 1 Impact)
-- ----------------------------------------------------------------------------
WITH conv AS (
  SELECT product_id, MAX(conversion_factor) AS cf
  FROM product_units WHERE is_sale_unit AND conversion_factor > 1
  GROUP BY product_id
),
flagged AS (
  SELECT b.id, b.unit_cost, p.cost_price AS correct_base_cost, c.cf
  FROM inventory_batches b
  JOIN products p ON p.id = b.product_id
  JOIN conv c ON c.product_id = b.product_id
  WHERE b.unit_cost > p.cost_price * 3 AND p.cost_price > 0
)
SELECT
  i.invoice_number,
  p.name AS product_name,
  ibc.quantity_consumed,
  ibc.unit_cost AS recorded_unit_cost,
  f.correct_base_cost,
  ROUND(ibc.cogs_amount, 2) AS cogs_recorded,
  ROUND(ibc.quantity_consumed * f.correct_base_cost, 2) AS cogs_should_be,
  ROUND(ibc.cogs_amount - ibc.quantity_consumed * f.correct_base_cost, 2) AS overstated_by
FROM invoice_item_batch_consumption ibc
JOIN flagged f ON f.id = ibc.batch_id
JOIN invoice_items ii ON ii.id = ibc.invoice_item_id
JOIN invoices i ON i.id = ii.invoice_id
JOIN products p ON p.id = ibc.product_id
ORDER BY ibc.cogs_amount DESC;


-- ----------------------------------------------------------------------------
-- SECTION 4: JOURNAL COGS vs FIFO PER INVOICE (Bug 2)
-- ----------------------------------------------------------------------------
-- Invoices where journal COGS differs from FIFO source-of-truth
WITH journal_cogs AS (
  SELECT je.reference_id AS invoice_id, SUM(jl.debit - jl.credit) AS jcogs
  FROM journal_entries je
  JOIN journal_lines jl ON jl.journal_entry_id = je.id
  JOIN accounts a ON a.id = jl.account_id
  WHERE a.code = '5000' AND je.reference_type = 'invoice'
  GROUP BY je.reference_id
),
fifo_cogs AS (
  SELECT ii.invoice_id, SUM(ibc.cogs_amount) AS fcogs
  FROM invoice_item_batch_consumption ibc
  JOIN invoice_items ii ON ii.id = ibc.invoice_item_id
  GROUP BY ii.invoice_id
)
SELECT
  i.invoice_number,
  i.status,
  i.invoice_date,
  ROUND(f.fcogs, 2) AS fifo_cogs,
  ROUND(j.jcogs, 2) AS journal_cogs,
  ROUND(j.jcogs - f.fcogs, 2) AS difference,
  CASE WHEN j.jcogs > f.fcogs * 1.01 THEN 'OVERSTATED' ELSE 'OK' END AS status_flag
FROM journal_cogs j
JOIN fifo_cogs f ON f.invoice_id = j.invoice_id
JOIN invoices i ON i.id = j.invoice_id
WHERE ABS(j.jcogs - f.fcogs) > 1
ORDER BY ABS(j.jcogs - f.fcogs) DESC
LIMIT 50;


-- ----------------------------------------------------------------------------
-- SECTION 5: DUPLICATE COGS JOURNAL ENTRIES PER INVOICE
-- ----------------------------------------------------------------------------
-- Shows how many COGS journal entries each invoice has (should be 1 for simple invoices)
WITH cogs_entries AS (
  SELECT
    je.reference_id AS invoice_id,
    je.id AS journal_entry_id,
    je.entry_number,
    je.created_at,
    SUM(jl.debit - jl.credit) AS cogs_amount
  FROM journal_entries je
  JOIN journal_lines jl ON jl.journal_entry_id = je.id
  JOIN accounts a ON a.id = jl.account_id
  WHERE a.code = '5000' AND je.reference_type = 'invoice'
  GROUP BY je.reference_id, je.id, je.entry_number, je.created_at
)
SELECT
  i.invoice_number,
  COUNT(*) AS cogs_entries,
  ROUND(SUM(ce.cogs_amount), 2) AS total_cogs,
  array_agg(ce.entry_number ORDER BY ce.created_at) AS entry_numbers
FROM cogs_entries ce
JOIN invoices i ON i.id = ce.invoice_id
GROUP BY i.invoice_number
HAVING COUNT(*) > 1
ORDER BY COUNT(*) DESC;


-- ----------------------------------------------------------------------------
-- SECTION 6: REVENUE vs COGS SANITY CHECK
-- ----------------------------------------------------------------------------
SELECT
  'Revenue (4000)' AS account,
  ROUND(a.balance, 2) AS balance
FROM accounts a WHERE a.code = '4000'
UNION ALL
SELECT
  'COGS (5000)' AS account,
  ROUND(a.balance, 2) AS balance
FROM accounts a WHERE a.code = '5000'
UNION ALL
SELECT
  'FIFO COGS (corrected)' AS account,
  ROUND(6058145.16 - 4539735.38, 2) AS balance
UNION ALL
SELECT
  'COGS as % of Revenue (current)' AS account,
  ROUND(9616898.78 / 4040396.51 * 100, 2) AS balance
UNION ALL
SELECT
  'COGS as % of Revenue (corrected)' AS account,
  ROUND((6058145.16 - 4539735.38) / 4040396.51 * 100, 2) AS balance;
