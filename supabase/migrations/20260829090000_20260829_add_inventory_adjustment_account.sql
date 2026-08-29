INSERT INTO accounts (code, name, account_type, is_active, balance)
SELECT '5900', 'Inventory Adjustment', 'expense', true, 0
WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE code = '5900');
