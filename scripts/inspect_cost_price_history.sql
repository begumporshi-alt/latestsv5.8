-- Investigate cost_price_history for the multi-unit sale-vs-base unit cost scale
-- defect already found and repaired in invoice_items / inventory_batches /
-- invoice_item_batch_consumption. Scope: last 7 days, per the user's report.

\echo '=== 1. Table structure ==='
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'cost_price_history' AND table_schema = 'public'
ORDER BY ordinal_position;

\echo ''
\echo '=== 2. Row counts and date span ==='
SELECT COUNT(*) AS total_rows,
       MIN(created_at)::date AS earliest,
       MAX(created_at)::date AS latest,
       COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - 7) AS last_7_days
FROM cost_price_history;

\echo ''
\echo '=== 3. Sample of the last 7 days (raw, no interpretation) ==='
SELECT * FROM cost_price_history
WHERE created_at >= CURRENT_DATE - 7
ORDER BY created_at DESC
LIMIT 20;
