-- Normalize unit labels for product 'walton cable 1*1.5 RM Black'
-- (SKU 1*1.5 RM-BLK, id 73f992fe-8254-4e1d-a5f9-449a5f9691ed).
--
-- Reported: INV-940629 (2026-08-23) shows this product's cost price in
-- "pcs" on the invoice's Cost Price History tab, although the product is
-- meter-based (products.unit = 'Meter', cost 34.22/m, stock in meters).
--
-- Root cause: the sale was a whole COIL (1 roll @ 4,800 sell / 3,422 cost
-- = 100m x 48 / 100m x 34.22), but the product master's unit had been set
-- to 'pcs' at that moment, and cost_price_history.unit records the
-- sale-time unit selection. The same product's history contains four
-- different labels for the same thing: 'coil', 'Coil', 'pcs' (all
-- coil-priced rows) alongside genuine 'Meter' rows (43-48/m).
--
-- Fix: relabel the coil-priced rows consistently as 'coil' — in
-- cost_price_history (the Cost Price History tab) and invoice_items
-- .unit_name (used by the product page's Sales History tab, which
-- otherwise falls back to the product unit and shows "1 Meter @ 4,800").
-- Amounts and quantities are NOT changed; only the unit label.

-- 1. Cost price history: pcs/Coil -> coil (coil-priced rows only)
UPDATE cost_price_history
SET unit = 'coil'
WHERE product_id = '73f992fe-8254-4e1d-a5f9-449a5f9691ed'
  AND unit IN ('pcs', 'Coil');

-- 2. Invoice items: blank/'Coil' unit_name -> 'coil' for the coil-priced
--    lines of this product (coil lines are priced ~4,800; meter lines
--    43-48 and already say 'Meter')
UPDATE invoice_items
SET unit_name = 'coil'
WHERE product_id = '73f992fe-8254-4e1d-a5f9-449a5f9691ed'
  AND (unit_name IS NULL OR unit_name = '' OR unit_name = 'Coil')
  AND unit_price > 1000;
