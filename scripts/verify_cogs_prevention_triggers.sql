-- Post-apply verification: prove the prevention triggers actually fire in both
-- directions and do not false-alarm on healthy data. Everything runs inside
-- savepoints and is rolled back, so production is untouched.
\set ON_ERROR_STOP off
BEGIN;

\echo '=== A. invoice_items guard: reject a BASE-unit cost on a SALE-unit line ==='
-- INV-940633 ERICSON 20mm: 230/box cost vs 300/box price, conversion factor 100.
-- Pushing cost to 23000 mimics writing a per-box cost where per-piece was meant.
SAVEPOINT a;
UPDATE invoice_items ii SET cost_price = 23000
FROM invoices i WHERE i.id = ii.invoice_id AND i.invoice_number = 'INV-940633'
  AND ii.product_id = '9f885740-715a-4820-9751-4527f01d91d7';
ROLLBACK TO a;

\echo ''
\echo '=== B. invoice_items guard: reject a per-METRE cost on a per-COIL line ==='
SAVEPOINT b;
UPDATE invoice_items ii SET cost_price = 2.30
FROM invoices i WHERE i.id = ii.invoice_id AND i.invoice_number = 'INV-940633'
  AND ii.product_id = '9f885740-715a-4820-9751-4527f01d91d7';
ROLLBACK TO b;

\echo ''
\echo '=== C. invoice_items guard: ACCEPT a plausible sale-unit cost (must succeed) ==='
SAVEPOINT c;
UPDATE invoice_items ii SET cost_price = 240
FROM invoices i WHERE i.id = ii.invoice_id AND i.invoice_number = 'INV-940633'
  AND ii.product_id = '9f885740-715a-4820-9751-4527f01d91d7';
ROLLBACK TO c;

\echo ''
\echo '=== D. invoice_items guard: ACCEPT a deep-discount sale (ratio 0.95, must succeed) ==='
SAVEPOINT d;
UPDATE invoice_items ii SET cost_price = ii.unit_price * 0.95
FROM invoices i WHERE i.id = ii.invoice_id AND i.invoice_number = 'INV-940633'
  AND ii.product_id = '9f885740-715a-4820-9751-4527f01d91d7';
ROLLBACK TO d;

\echo ''
\echo '=== E. products normalizer: unit set to the SALE unit is pulled back to base ==='
SAVEPOINT e;
UPDATE products SET unit = 'box' WHERE id = '9f885740-715a-4820-9751-4527f01d91d7';
SELECT name, unit AS unit_after_setting_box, base_unit
FROM products WHERE id = '9f885740-715a-4820-9751-4527f01d91d7';
ROLLBACK TO e;

\echo ''
\echo '=== F. products normalizer: synonym must be left alone, not rewritten ==='
SAVEPOINT f;
UPDATE products SET unit = 'pcs' WHERE id = '9f885740-715a-4820-9751-4527f01d91d7';
SELECT name, unit AS unit_after_setting_pcs, base_unit
FROM products WHERE id = '9f885740-715a-4820-9751-4527f01d91d7';
ROLLBACK TO f;

\echo ''
\echo '=== G. inventory_batches guard: reject a sale-unit batch cost ==='
SAVEPOINT g;
UPDATE inventory_batches SET unit_cost = 230
WHERE product_id = '9f885740-715a-4820-9751-4527f01d91d7' AND batch_number = 'OPN-000917';
ROLLBACK TO g;

\echo ''
\echo '=== H. inventory_batches guard: ACCEPT a correct base-unit cost ==='
SAVEPOINT h;
UPDATE inventory_batches SET unit_cost = 2.45
WHERE product_id = '9f885740-715a-4820-9751-4527f01d91d7' AND batch_number = 'OPN-000917';
ROLLBACK TO h;

ROLLBACK;
\echo ''
\echo '######## TRIGGER TESTS COMPLETE - ALL ROLLED BACK ########'
