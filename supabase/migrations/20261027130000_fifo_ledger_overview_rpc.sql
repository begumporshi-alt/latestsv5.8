-- FIFO ledger overview: aggregate the whole batch ledger server-side so the
-- /inventory/fifo page stops downloading every inventory_batches row to sum
-- them in the browser. One RPC returns the summary cards, the warehouse and
-- batch-type breakdowns, and the slim per-product list (~2.9k rows × 8 short
-- fields) — the page then fetches only the selected product's batches.
--
-- Numbers match the page's previous client-side math exactly: value =
-- quantity_remaining × unit_cost summed over ALL layers (negative IOU layers
-- included in total/net), products with net-zero remaining are excluded, IOU
-- = any negative layer.

CREATE OR REPLACE FUNCTION get_fifo_ledger_overview()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH batch AS (
  SELECT product_id, warehouse_id, batch_type, quantity_received, quantity_remaining, unit_cost
  FROM inventory_batches
), agg AS (
  SELECT
    COALESCE(SUM(quantity_remaining * unit_cost), 0) AS "totalValue",
    COALESCE(SUM(CASE WHEN quantity_remaining > 0 THEN quantity_remaining * unit_cost END), 0) AS "positiveValue",
    COALESCE(SUM(CASE WHEN quantity_remaining < 0 THEN quantity_remaining * unit_cost END), 0) AS "iouValue",
    COUNT(*) FILTER (WHERE quantity_remaining < 0) AS "iouLayers",
    COALESCE(SUM(quantity_remaining), 0) AS "totalRemaining",
    COUNT(DISTINCT product_id) AS "productCount",
    COUNT(*) AS "batchCount"
  FROM batch
), wh AS (
  SELECT b.warehouse_id AS id, w.name,
         SUM(b.quantity_remaining * b.unit_cost) AS value,
         SUM(b.quantity_remaining) AS remaining
  FROM batch b LEFT JOIN warehouses w ON w.id = b.warehouse_id
  WHERE b.warehouse_id IS NOT NULL
  GROUP BY b.warehouse_id, w.name
  HAVING SUM(b.quantity_remaining) <> 0
), typ AS (
  SELECT COALESCE(batch_type, 'other') AS batch_type,
         SUM(quantity_remaining * unit_cost) AS value,
         SUM(quantity_remaining) AS remaining
  FROM batch
  GROUP BY COALESCE(batch_type, 'other')
), prod AS (
  SELECT b.product_id AS id,
         SUM(b.quantity_remaining * b.unit_cost) AS value,
         SUM(b.quantity_remaining) AS remaining,
         SUM(b.quantity_received) AS received,
         BOOL_OR(b.quantity_remaining < 0) AS has_iou
  FROM batch b
  GROUP BY b.product_id
  HAVING SUM(b.quantity_remaining) <> 0
)
SELECT jsonb_build_object(
  'summary', to_jsonb(agg),
  'byWarehouse', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id', id, 'name', COALESCE(name, '—'), 'value', value, 'remaining', remaining) ORDER BY value DESC)
    FROM wh
  ), '[]'::jsonb),
  'byType', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('type', batch_type, 'value', value, 'remaining', remaining) ORDER BY value DESC)
    FROM typ
  ), '[]'::jsonb),
  'products', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'sku', p.sku, 'value', x.value, 'remaining', x.remaining, 'received', x.received, 'hasIou', x.has_iou) ORDER BY p.name, p.id)
    FROM prod x JOIN products p ON p.id = x.id
  ), '[]'::jsonb)
) FROM agg;
$$;

GRANT EXECUTE ON FUNCTION get_fifo_ledger_overview() TO authenticated;
REVOKE EXECUTE ON FUNCTION get_fifo_ledger_overview() FROM anon;
