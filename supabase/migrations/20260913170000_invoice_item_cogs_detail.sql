-- Per-product COGS drift detail for a single invoice, feeding the COGS Audit
-- page's item-wise drill-down modal ("Items" cell on any invoice row).
--
-- The audit list (get_cogs_audit) already compares four COGS sources per
-- INVOICE; this RPC splits three of them per PRODUCT so the modal can show
-- WHICH line item drifted:
--   A  items      — invoice_items.quantity × cost_price (current item state;
--                   quantity > 0, same filter as get_cogs_audit's src_a)
--   B  history    — cost_price_history.cost_price_for_added_qty (snapshot
--                   recorded at save time; all rows, same as src_b)
--   D  fifo       — invoice_item_batch_consumption.cogs_amount summed per
--                   product, with the individual batch draws in `batches`
--   C  journal    — stays invoice-level (lump ^COGS JEs have no product
--                   linkage on journal_lines), shown in the modal header from
--                   the already-loaded audit row.
--
-- Rows are grouped per product (not per invoice_item) because history rows
-- are keyed by (invoice_id, product_id); an invoice with the same product on
-- two lines reconciles either way since every source aggregates by product.
--
-- cogs_amount is sale-unit-scale money (base-unit consumption × base-unit
-- cost, rescaled 2026-09-02), so A vs D is a valid money comparison even for
-- multi-unit products. cost_per_unit inside `batches` is BASE-unit cost —
-- displayed only, never compared to the sale-unit item cost.

CREATE OR REPLACE FUNCTION get_invoice_item_cogs_detail(p_invoice_id uuid)
RETURNS TABLE (
  product_id        uuid,
  product_name      text,
  sku               text,
  unit              text,
  item_qty          numeric,
  item_unit_cost    numeric,
  line_cost_a       numeric,
  history_qty       numeric,
  history_unit_cost numeric,
  history_cost_b    numeric,
  history_rows      integer,
  fifo_cost_d       numeric,
  batch_count       integer,
  batches           jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH items AS (  -- Source A per product
  SELECT ii.product_id,
         SUM(ii.quantity) AS qty,
         SUM(ii.quantity * ii.cost_price) AS cost_a,
         MIN(ii.unit_name) AS unit_name
  FROM invoice_items ii
  WHERE ii.invoice_id = p_invoice_id
    AND ii.quantity > 0
  GROUP BY ii.product_id
),
hist AS (  -- Source B per product
  SELECT c.product_id,
         SUM(c.quantity) AS qty,
         SUM(c.cost_price_for_added_qty) AS cost_b,
         COUNT(*)::integer AS row_cnt,
         MIN(c.unit) AS unit
  FROM cost_price_history c
  WHERE c.invoice_id = p_invoice_id
    AND c.product_id IS NOT NULL
  GROUP BY c.product_id
),
draws AS (  -- Source D batch draws (base-unit qty/cost, sale-unit money)
  SELECT ii.product_id,
         ib.batch_number,
         iic.quantity_consumed AS consume_qty,
         iic.unit_cost AS cost_per_unit,
         iic.cogs_amount AS total_cost,
         ib.created_at AS batch_created
  FROM invoice_item_batch_consumption iic
  JOIN invoice_items ii ON ii.id = iic.invoice_item_id
  JOIN inventory_batches ib ON ib.id = iic.batch_id
  WHERE ii.invoice_id = p_invoice_id
),
fifo AS (
  SELECT d.product_id,
         SUM(d.total_cost) AS cost_d,
         COUNT(*)::integer AS draw_cnt,
         COALESCE(jsonb_agg(jsonb_build_object(
                    'batch_number', d.batch_number,
                    'consume_qty', d.consume_qty,
                    'cost_per_unit', d.cost_per_unit,
                    'total_cost', d.total_cost
                  ) ORDER BY d.batch_created ASC, d.batch_number ASC), '[]'::jsonb) AS batches_json
  FROM draws d
  GROUP BY d.product_id
)
SELECT
  p.id                                                    AS product_id,
  p.name                                                  AS product_name,
  COALESCE(p.sku, '')                                     AS sku,
  COALESCE(it.unit_name, h.unit, p.unit, 'pcs')           AS unit,
  COALESCE(it.qty, 0)                                     AS item_qty,
  ROUND(COALESCE(it.cost_a, 0) / NULLIF(COALESCE(it.qty, 0), 0), 2) AS item_unit_cost,
  ROUND(COALESCE(it.cost_a, 0), 2)                        AS line_cost_a,
  COALESCE(h.qty, 0)                                      AS history_qty,
  ROUND(COALESCE(h.cost_b, 0) / NULLIF(COALESCE(h.qty, 0), 0), 2) AS history_unit_cost,
  ROUND(COALESCE(h.cost_b, 0), 2)                         AS history_cost_b,
  COALESCE(h.row_cnt, 0)                                  AS history_rows,
  ROUND(COALESCE(f.cost_d, 0), 2)                         AS fifo_cost_d,
  COALESCE(f.draw_cnt, 0)                                 AS batch_count,
  COALESCE(f.batches_json, '[]'::jsonb)                   AS batches
FROM products p
LEFT JOIN items it ON it.product_id = p.id
LEFT JOIN hist  h  ON h.product_id  = p.id
LEFT JOIN fifo  f  ON f.product_id  = p.id
WHERE it.product_id IS NOT NULL
   OR h.product_id  IS NOT NULL
   OR f.product_id  IS NOT NULL
ORDER BY COALESCE(it.cost_a, 0) DESC, p.name ASC;
$$;

COMMENT ON FUNCTION get_invoice_item_cogs_detail(uuid) IS
'Per-product COGS drift for one invoice: items×cost (A), cost_price_history (B)
and FIFO consumption (D) side by side, plus the individual batch draws. Feeds
the COGS Audit item-wise drill-down modal; journal (C) stays invoice-level.';
