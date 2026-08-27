-- Pre-flight checks before applying the COGS fix migration.
-- Read-only: no mutations.

\echo '=== 1. Key account identity (confirm which account 1200 is) ==='
SELECT tenant_id, code, name, account_type, ROUND(balance,2) AS stored_balance
FROM accounts
WHERE code IN ('1200','1300','5000','4000','3000')
ORDER BY code;

\echo ''
\echo '=== 2. Blast radius: accounts whose stored balance differs from journal ==='
SELECT a.code, a.name,
       ROUND(a.balance,2) AS stored,
       ROUND(COALESCE(j.net,0),2) AS journal_derived,
       ROUND(COALESCE(j.net,0) - a.balance, 2) AS delta
FROM accounts a
LEFT JOIN (
  SELECT account_id, SUM(debit - credit) AS net
  FROM journal_lines GROUP BY account_id
) j ON j.account_id = a.id
WHERE ROUND(a.balance,2) <> ROUND(COALESCE(j.net,0),2)
ORDER BY ABS(COALESCE(j.net,0) - a.balance) DESC;

\echo ''
\echo '=== 3. Consumption rows with NULL batch_id (would be dropped by JOIN) ==='
SELECT COUNT(*) AS null_batch_rows,
       ROUND(COALESCE(SUM(cogs_amount),0),2) AS their_cogs
FROM invoice_item_batch_consumption
WHERE batch_id IS NULL;

\echo ''
\echo '=== 4. STEP 2 blast radius: consumption rows that will change ==='
SELECT COUNT(*) AS rows_to_change,
       ROUND(SUM(ibc.cogs_amount),2) AS cogs_before,
       ROUND(SUM(ROUND(ibc.quantity_consumed * b.unit_cost, 2)),2) AS cogs_after_at_current_batchcost
FROM invoice_item_batch_consumption ibc
JOIN inventory_batches b ON b.id = ibc.batch_id
WHERE ibc.unit_cost IS DISTINCT FROM b.unit_cost
   OR ibc.cogs_amount IS DISTINCT FROM ROUND(ibc.quantity_consumed * b.unit_cost, 2);

\echo ''
\echo '=== 5. Would the prevention trigger reject any EXISTING batch after fix? ==='
WITH su AS (
  SELECT product_id, MAX(conversion_factor) AS cf
  FROM product_units WHERE is_sale_unit AND conversion_factor > 1 GROUP BY product_id
),
fixed AS (
  SELECT b.id, b.batch_number, p.name AS product_name, p.cost_price, su.cf,
    CASE WHEN p.enable_multi_unit AND p.cost_price>0 AND b.unit_cost > p.cost_price*3
         THEN COALESCE(b.unit_cost/su.cf, p.cost_price) ELSE b.unit_cost END AS post_fix_cost
  FROM inventory_batches b
  JOIN products p ON p.id = b.product_id
  LEFT JOIN su ON su.product_id = b.product_id
)
SELECT batch_number, product_name, ROUND(post_fix_cost,2) AS post_fix_cost,
       ROUND(cost_price,2) AS base_cost, cf,
       ROUND(cost_price*cf/2.0,2) AS trigger_threshold
FROM fixed
WHERE cf > 1 AND cost_price > 0 AND post_fix_cost >= cost_price*cf/2.0
ORDER BY post_fix_cost DESC;
