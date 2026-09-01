-- 2026-09-01: Batch-ledger stock lookup RPC (POS oversell gate, audit fix #6).
--
-- The POS warn-and-confirm oversell gate needs the FIFO batch ledger quantity
-- per product+warehouse (the counter alone is not the truth). Returns only
-- rows that exist in inventory_batches — ~1.9k rows, trivial cost.

BEGIN;

CREATE OR REPLACE FUNCTION get_batch_stock_by_product_warehouse()
RETURNS TABLE (product_id uuid, warehouse_id uuid, qty numeric)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT b.product_id, b.warehouse_id, SUM(b.quantity_remaining)
  FROM inventory_batches b
  GROUP BY b.product_id, b.warehouse_id;
$$;

GRANT EXECUTE ON FUNCTION get_batch_stock_by_product_warehouse() TO authenticated;

COMMIT;
