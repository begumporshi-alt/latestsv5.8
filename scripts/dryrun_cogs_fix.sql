-- Dry-run harness: applies the COGS fix migration inside a transaction and
-- ROLLS BACK. Nothing is persisted. Used to inspect the resulting numbers.
\set ON_ERROR_STOP on
\timing off

BEGIN;

\echo '################ BEFORE ################'
SELECT code, name, ROUND(balance,2) AS balance
FROM accounts
WHERE code IN ('5000','1200','4000')
  AND tenant_id = '00000000-0000-0000-0000-000000000001'::uuid
ORDER BY code;

\echo ''
\echo '################ APPLYING MIGRATION ################'
\i supabase/migrations/20260827000100_20260827_fix_cogs_inflation_and_duplication.sql

\echo ''
\echo '################ AFTER ################'
SELECT code, name, ROUND(balance,2) AS balance
FROM accounts
WHERE code IN ('5000','1200','4000')
  AND tenant_id = '00000000-0000-0000-0000-000000000001'::uuid
ORDER BY code;

\echo ''
\echo '################ LEDGER BALANCED CHECK (must be 0) ################'
SELECT ROUND(SUM(debit) - SUM(credit), 2) AS total_debit_minus_credit
FROM journal_lines;

\echo ''
\echo '################ GUARD TRIGGER SMOKE TEST ################'
-- Attempting to insert a sale-unit cost must raise. Expect: caught exception.
DO $$
DECLARE
  v_pid uuid; v_wh uuid; v_cf numeric; v_base numeric;
BEGIN
  SELECT p.id, pu.conversion_factor, p.cost_price INTO v_pid, v_cf, v_base
  FROM products p
  JOIN product_units pu ON pu.product_id = p.id AND pu.is_sale_unit AND pu.conversion_factor > 1
  WHERE p.enable_multi_unit AND p.cost_price > 0
  LIMIT 1;

  SELECT id INTO v_wh FROM warehouses WHERE is_active = true LIMIT 1;

  BEGIN
    INSERT INTO inventory_batches (
      product_id, warehouse_id, batch_number,
      quantity_received, quantity_remaining, unit_cost, batch_type
    ) VALUES (
      v_pid, v_wh, 'GUARD-TEST', 1, 1, v_base * v_cf, 'opening'
    );
    RAISE WARNING 'GUARD FAILED: sale-unit cost % was accepted', v_base * v_cf;
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'GUARD OK: rejected sale-unit cost %. Message: %', v_base * v_cf, SQLERRM;
  END;

  -- A correct base-unit cost must be accepted
  BEGIN
    INSERT INTO inventory_batches (
      product_id, warehouse_id, batch_number,
      quantity_received, quantity_remaining, unit_cost, batch_type
    ) VALUES (
      v_pid, v_wh, 'GUARD-TEST-OK', 1, 1, v_base, 'opening'
    );
    RAISE NOTICE 'GUARD OK: accepted correct base-unit cost %', v_base;
  EXCEPTION WHEN others THEN
    RAISE WARNING 'GUARD TOO STRICT: rejected valid base cost %. Message: %', v_base, SQLERRM;
  END;
END $$;

ROLLBACK;

\echo ''
\echo '################ ROLLED BACK - confirming production untouched ################'
SELECT code, name, ROUND(balance,2) AS balance
FROM accounts
WHERE code IN ('5000','1200','4000')
  AND tenant_id = '00000000-0000-0000-0000-000000000001'::uuid
ORDER BY code;
