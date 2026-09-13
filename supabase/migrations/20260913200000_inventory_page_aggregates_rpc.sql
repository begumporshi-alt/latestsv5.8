-- 2026-09-13: One-RPC aggregates for the /inventory page and the
-- inventory-value readouts (dashboard / reports / valuation report).
--
-- The page used to download every product row, every inventory_items row,
-- the entire invoice_items history and every positive batch layer to the
-- client and sum them in JavaScript — 10+ sequential 1000-row round trips
-- per load (~3-8s). The database computes the same numbers in 2-3ms, so
-- this function returns them set-based as ONE jsonb row, which also
-- sidesteps the 1000-row PostgREST cap (supabase.rpc() cannot .range()).
--
-- Semantics mirror the old client code exactly (app/(erp)/inventory/
-- page.tsx fetchInventoryData + lib/inventory-value.ts getInventoryValue):
--   stock       inventory_items.quantity_on_hand summed per product and per
--               product×warehouse — the Stock column and its per-warehouse
--               popover.
--   sold        SUM(invoice_items.quantity) per product, full history —
--               the "Sold Out" filter.
--   fifo        SUM(quantity_remaining × unit_cost) over positive batch
--               layers, per product and per pair — the fMap behind the
--               Filtered value readout. Pair entries exist only when the
--               pair HAS a positive layer, so the client's qty × cost_price
--               fallback for batch-less stock pairs keeps working.
--   batch_only_pairs  positive-batch pairs with no inventory_items row —
--               the old client keyed fMap by every positive batch pair,
--               including pairs the counter table lacks.
--   total_value get_fifo_inventory_value() (positive layers, company-wide)
--               + qty × products.cost_price for stock pairs with qty > 0
--               and no positive layer — the getInventoryValue() formula.
--
-- p_include_products = false returns just the scalar fields — the cheap
-- mode for dashboard/reports, which only need the value figure.

BEGIN;

DROP FUNCTION IF EXISTS get_inventory_page_aggregates(boolean);

CREATE FUNCTION get_inventory_page_aggregates(p_include_products boolean DEFAULT true)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH pair_stock AS (
    SELECT product_id, warehouse_id, SUM(quantity_on_hand)::numeric AS qty
    FROM inventory_items
    GROUP BY product_id, warehouse_id
  ),
  pair_fifo AS (
    SELECT product_id, warehouse_id, SUM(quantity_remaining * unit_cost)::numeric AS val
    FROM inventory_batches
    WHERE quantity_remaining > 0
    GROUP BY product_id, warehouse_id
  ),
  prod_stock AS (
    SELECT product_id, SUM(qty)::numeric AS qty FROM pair_stock GROUP BY product_id
  ),
  prod_sold AS (
    SELECT product_id, SUM(quantity)::numeric AS qty FROM invoice_items GROUP BY product_id
  ),
  prod_fifo AS (
    SELECT product_id, SUM(val)::numeric AS val FROM pair_fifo GROUP BY product_id
  ),
  fallback AS (
    SELECT COALESCE(SUM(ps.qty * p.cost_price), 0)::numeric AS val
    FROM pair_stock ps
    JOIN products p ON p.id = ps.product_id
    WHERE ps.qty > 0
      AND NOT EXISTS (
        SELECT 1 FROM pair_fifo pf
        WHERE pf.product_id = ps.product_id AND pf.warehouse_id = ps.warehouse_id
      )
  ),
  scalars AS (
    SELECT
      (get_fifo_inventory_value() + f.val) AS total_value,
      f.val AS fallback_value,
      (SELECT COUNT(*) FROM pair_stock WHERE qty > 0) AS stock_pair_count,
      (SELECT COUNT(DISTINCT product_id) FROM pair_stock WHERE qty > 0) AS stock_pair_product_count
    FROM fallback f
  )
  SELECT jsonb_build_object(
    'total_value', s.total_value,
    'fallback_value', s.fallback_value,
    'stock_pair_count', s.stock_pair_count,
    'stock_pair_product_count', s.stock_pair_product_count,
    'products', CASE WHEN p_include_products THEN COALESCE((
      SELECT jsonb_object_agg(y.product_id, jsonb_build_object(
        'stock', y.stock,
        'sold', y.sold,
        'fifo', y.fifo,
        'warehouses', y.warehouses
      ))
      FROM (
        SELECT p.id AS product_id,
          COALESCE(ps.qty, 0) AS stock,
          COALESCE(so.qty, 0) AS sold,
          COALESCE(pf.val, 0) AS fifo,
          COALESCE(w.map, '{}'::jsonb) AS warehouses
        FROM products p
        LEFT JOIN prod_stock ps ON ps.product_id = p.id
        LEFT JOIN prod_sold so ON so.product_id = p.id
        LEFT JOIN prod_fifo pf ON pf.product_id = p.id
        LEFT JOIN (
          SELECT x.product_id, jsonb_object_agg(x.warehouse_id, jsonb_build_object('stock', x.qty, 'fifo', x.fifo_val)) AS map
          FROM (
            SELECT ps2.product_id, ps2.warehouse_id, ps2.qty, pf2.val AS fifo_val
            FROM pair_stock ps2
            LEFT JOIN pair_fifo pf2
              ON pf2.product_id = ps2.product_id AND pf2.warehouse_id = ps2.warehouse_id
          ) x
          GROUP BY x.product_id
        ) w ON w.product_id = p.id
      ) y
    ), '{}'::jsonb) ELSE '{}'::jsonb END,
    'batch_only_pairs', CASE WHEN p_include_products THEN COALESCE((
      SELECT jsonb_object_agg(z.product_id, z.map)
      FROM (
        SELECT pf.product_id, jsonb_object_agg(pf.warehouse_id, pf.val) AS map
        FROM pair_fifo pf
        WHERE NOT EXISTS (
          SELECT 1 FROM pair_stock ps
          WHERE ps.product_id = pf.product_id AND ps.warehouse_id = pf.warehouse_id
        )
        GROUP BY pf.product_id
      ) z
    ), '{}'::jsonb) ELSE '{}'::jsonb END
  )
  FROM scalars s;
$$;

GRANT EXECUTE ON FUNCTION get_inventory_page_aggregates(boolean) TO authenticated;

COMMIT;
