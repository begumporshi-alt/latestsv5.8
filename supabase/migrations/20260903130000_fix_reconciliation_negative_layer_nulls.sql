-- Fix check #5 (Negative FIFO layers): layers with a NULL batch_number were
-- silently excluded because `NULL NOT LIKE 'FIFO-FALLBACK%'` evaluates to NULL
-- (not true), so those rows dropped out of the count. 2026-09-03 audit: the
-- check reported 65 layers / -425,401.82 while the true figures were
-- 67 / -425,903.81 — 2 UNNAMED layers worth -502.00 were invisible.
-- Align with get_negative_inventory_layers, which already uses the
-- NULL-safe pattern.

CREATE OR REPLACE FUNCTION public.get_inventory_reconciliation()
 RETURNS TABLE(sort_key integer, check_name text, status text, drift numeric, details text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH batch AS (
    SELECT product_id, warehouse_id,
           SUM(quantity_remaining) AS q,
           SUM(quantity_remaining * unit_cost) AS v
    FROM inventory_batches
    GROUP BY product_id, warehouse_id
  ),
  ctr AS (
    SELECT product_id, warehouse_id, SUM(quantity_on_hand) AS q
    FROM inventory_items
    GROUP BY product_id, warehouse_id
  ),
  counter_drift AS (
    SELECT COUNT(*) AS pairs, COALESCE(SUM(ABS(ii.quantity_on_hand - b.q)), 0) AS units
    FROM inventory_items ii
    JOIN batch b ON b.product_id = ii.product_id AND b.warehouse_id = ii.warehouse_id
    WHERE ABS(ii.quantity_on_hand - b.q) > 0.001
  ),
  missing_rows AS (
    SELECT COUNT(*) AS pairs, COALESCE(SUM(b.q), 0) AS units, COALESCE(SUM(b.v), 0) AS value
    FROM batch b
    WHERE NOT EXISTS (SELECT 1 FROM inventory_items ii
                      WHERE ii.product_id = b.product_id AND ii.warehouse_id = b.warehouse_id)
  ),
  gl_1200 AS (
    SELECT COALESCE(SUM(COALESCE(jl.debit, 0) - COALESCE(jl.credit, 0)), 0) AS net
    FROM journal_lines jl
    JOIN accounts a ON a.id = jl.account_id
    WHERE a.code = '1200'
  ),
  batch_value AS (
    SELECT COALESCE(SUM(quantity_remaining * unit_cost), 0) AS v
    FROM inventory_batches
  ),
  cache_drift AS (
    SELECT COUNT(*) AS accounts, COALESCE(SUM(ABS(a.balance - x.line_balance)), 0) AS amount
    FROM accounts a
    JOIN (
      SELECT jl.account_id,
             SUM(CASE WHEN a2.account_type IN ('liability', 'equity', 'revenue')
                      THEN COALESCE(jl.credit, 0) - COALESCE(jl.debit, 0)
                      ELSE COALESCE(jl.debit, 0) - COALESCE(jl.credit, 0) END) AS line_balance
      FROM journal_lines jl
      JOIN accounts a2 ON a2.id = jl.account_id
      GROUP BY jl.account_id
    ) x ON x.account_id = a.id
    WHERE ABS(a.balance - x.line_balance) > 0.01
  ),
  neg_layers AS (
    SELECT COUNT(*) AS layers, COALESCE(SUM(quantity_remaining * unit_cost), 0) AS value
    FROM inventory_batches
    WHERE quantity_remaining < 0
     AND (batch_number IS NULL OR batch_number NOT LIKE 'FIFO-FALLBACK%')
  ),
  no_batch AS (
    SELECT COUNT(*) AS pairs, COALESCE(SUM(ii.quantity_on_hand), 0) AS units
    FROM inventory_items ii
    WHERE ii.quantity_on_hand <> 0
      AND NOT EXISTS (SELECT 1 FROM inventory_batches b
                      WHERE b.product_id = ii.product_id AND ii.warehouse_id = ii.warehouse_id)
  )
  SELECT 1, 'Counter vs batch ledger',
         CASE WHEN cd.pairs > 0 THEN 'drift' ELSE 'ok' END,
         cd.pairs,
         cd.pairs || ' pair(s) drift, |Δ| ' || ROUND(cd.units, 3) || ' units'
  FROM counter_drift cd
  UNION ALL
  SELECT 2, 'Batch stock missing a counter row',
         CASE WHEN mr.pairs > 0 THEN 'drift' ELSE 'ok' END,
         mr.pairs,
         mr.pairs || ' pair(s), ' || mr.units || ' units (৳' || ROUND(mr.value, 2) || ') invisible to POS'
  FROM missing_rows mr
  UNION ALL
  SELECT 3, 'GL 1200 vs batch ledger value',
         CASE WHEN ABS(g.net - bv.v) > 0.01 THEN 'drift' ELSE 'ok' END,
         ROUND(ABS(g.net - bv.v), 2),
         'GL ৳' || ROUND(g.net, 2) || ' vs batches ৳' || ROUND(bv.v, 2)
  FROM gl_1200 g CROSS JOIN batch_value bv
  UNION ALL
  SELECT 4, 'Account balances vs journal lines',
         CASE WHEN cad.accounts > 0 THEN 'drift' ELSE 'ok' END,
         cad.accounts,
         cad.accounts || ' account(s) off by ৳' || ROUND(cad.amount, 2) || ' total'
  FROM cache_drift cad
  UNION ALL
  SELECT 5, 'Negative FIFO layers (oversell IOUs)',
         'info', nl.layers,
         nl.layers || ' layer(s) worth ৳' || ROUND(nl.value, 2) || ' — awaiting overselling-policy decision'
  FROM neg_layers nl
  UNION ALL
  SELECT 6, 'Stock with no batch history',
         'info', nb.pairs,
         nb.pairs || ' pair(s), ' || nb.units || ' units — flagged for owner decision'
  FROM no_batch nb
$function$

