-- Backfill received_quantity for PO items on received/partially_received POs
-- where received_quantity is still 0 but the order was marked received
UPDATE purchase_order_items poi
SET received_quantity = COALESCE(poi.base_quantity, poi.quantity)
FROM purchase_orders po
WHERE poi.purchase_order_id = po.id
  AND po.status IN ('received', 'partially_received')
  AND COALESCE(poi.received_quantity, 0) = 0;
