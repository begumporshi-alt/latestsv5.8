-- Fix cancelled POs: zero out amount_paid so balance shows 0 for cancelled orders
-- A cancelled PO should never show an outstanding balance
UPDATE purchase_orders SET amount_paid = total_amount WHERE status = 'cancelled';
