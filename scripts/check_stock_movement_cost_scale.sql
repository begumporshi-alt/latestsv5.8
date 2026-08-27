-- Post-repair gap check:
--   1. Is the DEPLOYED period_net_debit body the correct pass-through, or stale?
--   2. Does stock_movements.unit_cost carry the same sale-vs-base scale defect?
--      All four pages read COGS from account 5000, but reports/page.tsx builds its
--      monthly profit trend from stock_movements instead, so a scale error there
--      would still render a broken chart on top of correctly repaired ledgers.

\echo '=== 1. Deployed period_net_debit / period_net_credit definitions ==='
SELECT p.proname, pg_get_functiondef(p.oid) AS definition
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.proname IN ('period_net_debit', 'period_net_credit') AND n.nspname = 'public';

\echo ''
\echo '=== 2. stock_movements columns ==='
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'stock_movements' AND table_schema = 'public'
ORDER BY ordinal_position;

\echo ''
\echo '=== 3. Sale movements: does unit_cost match the corrected base cost? ==='
-- Compare each sale movement's unit_cost against products.cost_price (now correct
-- per base unit). A ratio near the conversion factor means the movement stored a
-- SALE-unit cost in a base-unit column: the same defect class, different table.
WITH cf AS (
  SELECT p.id AS product_id, p.name, p.cost_price AS base_cost,
         COALESCE((SELECT MAX(pu.conversion_factor) FROM product_units pu
                   WHERE pu.product_id = p.id AND pu.is_sale_unit
                     AND pu.conversion_factor > 1), 1) AS cf_sale
  FROM products p
)
SELECT CASE
         WHEN c.base_cost = 0 OR sm.unit_cost IS NULL OR sm.unit_cost = 0 THEN 'zero_or_null'
         WHEN c.cf_sale = 1                                    THEN 'single_unit_product'
         WHEN sm.unit_cost / c.base_cost > c.cf_sale / 2.0     THEN 'SCALE_DEFECT_sale_unit_cost'
         ELSE 'consistent_base_cost'
       END AS bucket,
       COUNT(*) AS movements,
       ROUND(SUM(ABS(sm.quantity) * COALESCE(sm.unit_cost, 0)), 2) AS chart_cogs
FROM stock_movements sm
JOIN cf c ON c.product_id = sm.product_id
WHERE sm.movement_type = 'sale'
GROUP BY 1 ORDER BY 3 DESC NULLS LAST;

\echo ''
\echo '=== 4. What the chart currently computes per month vs the repaired ledger ==='
WITH chart AS (
  SELECT to_char(sm.created_at, 'YYYY-MM') AS month,
         SUM(ABS(sm.quantity) * COALESCE(sm.unit_cost, 0)) AS chart_cogs
  FROM stock_movements sm WHERE sm.movement_type = 'sale' GROUP BY 1
),
ledger AS (
  SELECT to_char(je.entry_date, 'YYYY-MM') AS month,
         SUM(jl.debit - jl.credit) AS ledger_cogs
  FROM journal_lines jl
  JOIN journal_entries je ON je.id = jl.journal_entry_id
  JOIN accounts a ON a.id = jl.account_id AND a.code = '5000'
                 AND a.tenant_id = '00000000-0000-0000-0000-000000000001'::uuid
  GROUP BY 1
)
SELECT COALESCE(c.month, l.month) AS month,
       ROUND(COALESCE(c.chart_cogs, 0), 2)  AS chart_cogs,
       ROUND(COALESCE(l.ledger_cogs, 0), 2) AS ledger_cogs_repaired,
       ROUND(COALESCE(c.chart_cogs, 0) - COALESCE(l.ledger_cogs, 0), 2) AS chart_overstatement
FROM chart c FULL OUTER JOIN ledger l ON l.month = c.month ORDER BY 1;

\echo ''
\echo '=== 5. Worst offending sale movements (top 15 by inflated value) ==='
WITH cf AS (
  SELECT p.id AS product_id, p.name, p.cost_price AS base_cost,
         COALESCE((SELECT MAX(pu.conversion_factor) FROM product_units pu
                   WHERE pu.product_id = p.id AND pu.is_sale_unit
                     AND pu.conversion_factor > 1), 1) AS cf_sale
  FROM products p
)
SELECT left(c.name, 28) AS product, sm.created_at::date AS moved,
       sm.quantity, ROUND(sm.unit_cost, 4) AS unit_cost,
       ROUND(c.base_cost, 4) AS correct_base_cost, c.cf_sale,
       ROUND(ABS(sm.quantity) * sm.unit_cost, 2) AS chart_value
FROM stock_movements sm
JOIN cf c ON c.product_id = sm.product_id
WHERE sm.movement_type = 'sale' AND c.cf_sale > 1 AND c.base_cost > 0
  AND sm.unit_cost / c.base_cost > c.cf_sale / 2.0
ORDER BY ABS(sm.quantity) * sm.unit_cost DESC LIMIT 15;
