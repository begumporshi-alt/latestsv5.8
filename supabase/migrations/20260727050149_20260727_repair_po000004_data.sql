-- Repair PO-000004 data corruption
-- Receipt posted gross 4.95 (should be net 3.95) AND was double-counted
-- Actual balance impact: Inventory +9.90, AP -9.90 (from receipt) + payments AP +3.95
-- Net: Inventory +9.90, AP -5.95
-- Should be: Inventory +3.95, AP 0
-- Correction: Inventory -5.95, AP +5.95

UPDATE accounts SET balance = balance - 5.95 WHERE code = '1200'; -- Inventory
UPDATE accounts SET balance = balance + 5.95 WHERE code = '2000'; -- AP

-- Fix PO-000004 amount_paid (3.95 total paid but never recorded on PO)
UPDATE purchase_orders SET amount_paid = 3.95 WHERE po_number = 'PO-000004';
