-- 2026-10-30: Portfolio inventory figures must ignore soft-deleted products.
--
-- get_inventory_page_aggregates() used to price every positive FIFO layer and
-- every qty x cost_price fallback pair, regardless of products.is_active. The
-- /inventory "Total Products" card counts active rows only, so the value card
-- disagreed with the product count: 31 deleted products still carried
-- BDT 59,165 of layers (250 units of one deleted item alone).
--
-- This version prices only active products. Three consequences, all intended:
--   * total_value / fallback_value exclude deleted products everywhere the
--     RPC is read (inventory card, dashboard, reports, reports/inventory).
--   * stock_pair_count / stock_pair_product_count describe the same active
--     population, so getInventoryValue()'s "products without batches" stays
--     consistent with the total it accompanies.
--   * the `products` map and `batch_only_pairs` are deliberately NOT filtered:
--     the Inactive filter in the UI still needs real stock per deleted row,
--     otherwise restored products would appear empty.
--
-- get_fifo_inventory_value() is left untouched — it is the raw company-wide
-- layer total (all products) and is still warmed for offline use. Nothing in
-- the app calls it directly; every card goes through this RPC.

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
  -- Positive layers belonging to live products only.
  active_pair_fifo AS (
    SELECT pf.product_id, pf.warehouse_id, pf.val
    FROM pair_fifo pf
    JOIN products p ON p.id = pf.product_id
    WHERE p.is_active
  ),
  active_fifo_total AS (
    SELECT COALESCE(SUM(val), 0)::numeric AS val FROM active_pair_fifo
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
      AND p.is_active
      AND NOT EXISTS (
        SELECT 1 FROM pair_fifo pf
        WHERE pf.product_id = ps.product_id AND pf.warehouse_id = ps.warehouse_id
      )
  ),
  active_pair_stock AS (
    SELECT ps.product_id, ps.warehouse_id, ps.qty
    FROM pair_stock ps
    JOIN products p ON p.id = ps.product_id
    WHERE p.is_active
  ),
  scalars AS (
    SELECT
      (af.val + f.val) AS total_value,
      f.val AS fallback_value,
      (SELECT COUNT(*) FROM active_pair_stock WHERE qty > 0) AS stock_pair_count,
      (SELECT COUNT(DISTINCT product_id) FROM active_pair_stock WHERE qty > 0) AS stock_pair_product_count
    FROM fallback f
    CROSS JOIN active_fifo_total af
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

ALTER FUNCTION get_inventory_page_aggregates(boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION get_inventory_page_aggregates(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_inventory_page_aggregates(boolean) TO authenticated;

COMMIT;
