-- 2026-09-03: Parameterize the batch-ledger stock lookup RPC.
--
-- The POS oversell gate calls this RPC once with no arguments, but Supabase
-- caps any single response at 1000 rows and the full result is now 1400
-- product|warehouse pairs — the tail was silently dropped, so ~400 products
-- read as "ledger 0" and triggered FALSE oversell warnings ("Ledger: 0 of
-- 1" for a product that actually had stock in Main Warehouse). supabase.rpc()
-- cannot paginate (.range is unsupported for function calls), so the fix is
-- an optional product filter: callers pass exactly the ids they are about
-- to sell — the result is bounded by cart size, immune to the row cap, and
-- always fresh.
--
-- p_product_ids NULL (or omitted) keeps the old full-catalog behavior for
-- any caller that really wants everything (still subject to the 1000-row
-- cap — pass ids unless you must have all rows).

BEGIN;

DROP FUNCTION IF EXISTS get_batch_stock_by_product_warehouse();

CREATE FUNCTION get_batch_stock_by_product_warehouse(p_product_ids uuid[] DEFAULT NULL)
RETURNS TABLE (product_id uuid, warehouse_id uuid, qty numeric)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT b.product_id, b.warehouse_id, SUM(b.quantity_remaining)
  FROM inventory_batches b
  WHERE p_product_ids IS NULL OR b.product_id = ANY(p_product_ids)
  GROUP BY b.product_id, b.warehouse_id;
$$;

GRANT EXECUTE ON FUNCTION get_batch_stock_by_product_warehouse(uuid[]) TO authenticated;

COMMIT;
