BEGIN;
\i supabase/migrations/20260827002000_20260827_repair_cost_price_history_snapshots.sql

\echo ''
\echo '=== DRYRUN EXTRA: guard negative controls (must all behave as noted) ==='

-- A. A legitimate deep-discount ratio on a multi-unit product must be ACCEPTED.
SAVEPOINT sp_a;
DO $$
DECLARE v_pid uuid; v_inv uuid;
BEGIN
  SELECT product_id INTO v_pid FROM cost_price_history
  WHERE invoice_id IS NOT NULL AND product_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM product_units pu WHERE pu.product_id = cost_price_history.product_id
                  AND pu.is_sale_unit AND pu.conversion_factor > 1)
  LIMIT 1;
  SELECT invoice_id INTO v_inv FROM cost_price_history WHERE invoice_id IS NOT NULL LIMIT 1;
  INSERT INTO cost_price_history (product_id, product_name, product_sku, invoice_id,
    unit, quantity, unit_price, cost_price_per_qty, cost_price_for_added_qty,
    total_cost_price_single, total_cost_price_added)
  VALUES (v_pid, 'DRYRUN deep discount', 'X', v_inv, 'coil', 1, 1000, 950, 950, 950, 950);
  RAISE NOTICE 'A PASS: 0.95 cost/price ratio accepted (no false alarm).';
END $$;
ROLLBACK TO SAVEPOINT sp_a;

-- B. A 100x-too-high snapshot on a multi-unit product must be REJECTED.
SAVEPOINT sp_b;
DO $$
DECLARE v_pid uuid; v_inv uuid; v_cf numeric;
BEGIN
  SELECT pu.product_id, MAX(pu.conversion_factor) INTO v_pid, v_cf
  FROM product_units pu WHERE pu.is_sale_unit AND pu.conversion_factor > 1
  GROUP BY pu.product_id LIMIT 1;
  SELECT invoice_id INTO v_inv FROM cost_price_history WHERE invoice_id IS NOT NULL LIMIT 1;
  BEGIN
    INSERT INTO cost_price_history (product_id, product_name, product_sku, invoice_id,
      unit, quantity, unit_price, cost_price_per_qty, cost_price_for_added_qty,
      total_cost_price_single, total_cost_price_added)
    VALUES (v_pid, 'DRYRUN scale too high', 'X', v_inv, 'Meter', 1, 30, 30 * v_cf, 30 * v_cf, 30 * v_cf, 30 * v_cf);
    RAISE EXCEPTION 'B FAIL: scale-too-high snapshot was NOT rejected';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'B FAIL%' THEN RAISE; END IF;
    RAISE NOTICE 'B PASS: rejected -> %', left(SQLERRM, 90);
  END;
END $$;
ROLLBACK TO SAVEPOINT sp_b;

-- C. A 100x-too-low snapshot on a multi-unit product must be REJECTED.
SAVEPOINT sp_c;
DO $$
DECLARE v_pid uuid; v_inv uuid; v_cf numeric;
BEGIN
  SELECT pu.product_id, MAX(pu.conversion_factor) INTO v_pid, v_cf
  FROM product_units pu WHERE pu.is_sale_unit AND pu.conversion_factor > 1
  GROUP BY pu.product_id LIMIT 1;
  SELECT invoice_id INTO v_inv FROM cost_price_history WHERE invoice_id IS NOT NULL LIMIT 1;
  BEGIN
    INSERT INTO cost_price_history (product_id, product_name, product_sku, invoice_id,
      unit, quantity, unit_price, cost_price_per_qty, cost_price_for_added_qty,
      total_cost_price_single, total_cost_price_added)
    VALUES (v_pid, 'DRYRUN scale too low', 'X', v_inv, 'coil', 1, 5000, 5000 / v_cf, 5000 / v_cf, 5000 / v_cf, 5000 / v_cf);
    RAISE EXCEPTION 'C FAIL: scale-too-low snapshot was NOT rejected';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'C FAIL%' THEN RAISE; END IF;
    RAISE NOTICE 'C PASS: rejected -> %', left(SQLERRM, 90);
  END;
END $$;
ROLLBACK TO SAVEPOINT sp_c;

-- D. A single-unit product must be skipped entirely (no false alarm even at 50x).
SAVEPOINT sp_d;
DO $$
DECLARE v_pid uuid; v_inv uuid;
BEGIN
  SELECT p.id INTO v_pid FROM products p
  WHERE NOT EXISTS (SELECT 1 FROM product_units pu WHERE pu.product_id = p.id
                      AND pu.is_sale_unit AND pu.conversion_factor > 1)
  LIMIT 1;
  SELECT invoice_id INTO v_inv FROM cost_price_history WHERE invoice_id IS NOT NULL LIMIT 1;
  INSERT INTO cost_price_history (product_id, product_name, product_sku, invoice_id,
    unit, quantity, unit_price, cost_price_per_qty, cost_price_for_added_qty,
    total_cost_price_single, total_cost_price_added)
  VALUES (v_pid, 'DRYRUN single unit', 'X', v_inv, 'pcs', 1, 10, 500, 500, 500, 500);
  RAISE NOTICE 'D PASS: single-unit product skipped by the guard (no false alarm).';
END $$;
ROLLBACK TO SAVEPOINT sp_d;

-- E. Idempotency: running STEP 1 again must change 0 rows.
\echo ''
\echo '=== DRYRUN EXTRA: idempotency of the re-sync ==='
WITH again AS (
  UPDATE cost_price_history cph
  SET cost_price_per_qty = ii.cost_price
  FROM invoice_items ii
  WHERE ii.invoice_id = cph.invoice_id
    AND ii.product_id = cph.product_id
    AND cph.invoice_id IS NOT NULL
    AND ABS(cph.cost_price_per_qty - ii.cost_price) > 0.01
  RETURNING 1
)
SELECT COUNT(*) AS rows_changed_on_second_run FROM again;

ROLLBACK;
\echo ''
\echo '=== DRYRUN ROLLED BACK - no production change ==='
