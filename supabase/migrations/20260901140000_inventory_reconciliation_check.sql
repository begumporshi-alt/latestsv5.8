-- 2026-09-01: Inventory reconciliation check (audit fix #3).
--
-- The 2026-09-01 repairs (JE-964716 baseline booking, counter rebuild 20260901130000)
-- brought the three inventory records into agreement — but nothing stops drift from
-- silently returning, because no recurring check compares them. This migration adds:
--
--   1. get_inventory_reconciliation() — a read-only RPC comparing:
--        counter vs batch ledger (per product+warehouse)
--        batch pairs missing an inventory_items row
--        GL 1200 (journal lines) vs batch ledger value
--        accounts.balance cache vs journal lines (all accounts)
--      plus informational rows (negative layers, no-batch counters).
--      Called live by the Dashboard, so status is always current.
--   2. inventory_reconciliation_log — nightly snapshot table, plus a pg_cron job
--      (best effort — the migration succeeds even if pg_cron is unavailable).
--
-- Output contract: rows of (sort_key, check_name, status, drift, details).
-- status: 'ok' | 'drift' | 'info'.

BEGIN;

CREATE TABLE IF NOT EXISTS inventory_reconciliation_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  checked_at timestamptz NOT NULL DEFAULT now(),
  all_ok boolean NOT NULL,
  checks jsonb NOT NULL
);
ALTER TABLE inventory_reconciliation_log ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'inventory_reconciliation_log' AND policyname = 'read_reconciliation_log') THEN
    CREATE POLICY read_reconciliation_log ON inventory_reconciliation_log
      FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION get_inventory_reconciliation()
RETURNS TABLE (sort_key int, check_name text, status text, drift numeric, details text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
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
    WHERE quantity_remaining < 0 AND batch_number NOT LIKE 'FIFO-FALLBACK%'
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
$$;

GRANT EXECUTE ON FUNCTION get_inventory_reconciliation() TO authenticated;

-- Seed the log with the current state so history starts today.
INSERT INTO inventory_reconciliation_log (all_ok, checks)
SELECT NOT EXISTS (SELECT 1 FROM get_inventory_reconciliation() r WHERE r.status = 'drift'),
       (SELECT to_jsonb(x) FROM (SELECT array_agg(row_to_json(r) ORDER BY r.sort_key) AS checks
                                 FROM get_inventory_reconciliation() r) x);

-- Nightly snapshot at 02:05, best effort.
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron unavailable (%); nightly logging skipped — dashboard still checks live.', SQLERRM;
    RETURN;
  END;
  BEGIN
    PERFORM cron.unschedule('inventory-reconciliation-nightly');
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- job not scheduled yet — expected on first run
  END;
  PERFORM cron.schedule(
    'inventory-reconciliation-nightly',
    '5 2 * * *',
    $job$
    INSERT INTO inventory_reconciliation_log (all_ok, checks)
    SELECT NOT EXISTS (SELECT 1 FROM get_inventory_reconciliation() r WHERE r.status = 'drift'),
           (SELECT to_jsonb(x) FROM (SELECT array_agg(row_to_json(r) ORDER BY r.sort_key) AS checks
                                     FROM get_inventory_reconciliation() r) x);
    $job$
  );
END $$;

COMMIT;
