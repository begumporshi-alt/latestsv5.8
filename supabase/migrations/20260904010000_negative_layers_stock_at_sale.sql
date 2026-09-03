-- Classify each negative layer by whether the FIFO ledger held stock for that
-- product+warehouse at the time of the sale, so the owner can purge the
-- pre-FIFO artifacts group by group instead of layer by layer:
--   'none'       — the pair never had any non-negative batch: the stock was
--                  never recorded in FIFO (pre-FIFO baseline gap)
--   'after_sale' — the pair's first real batch was recorded AFTER the sale:
--                  the sale ran before the ledger knew the stock
--   'existed'    — a non-negative batch predates the sale: genuine oversell
--                  or an under-recorded baseline (physical count decides)
--   NULL         — no invoice link (reductions, unnamed rows): not applicable
--
-- The sale date comes from the surviving consumption link (invoice_date);
-- 'first real batch' ignores negative layers themselves (the artifacts under
-- review) but counts exhausted ones — a fully-consumed batch still proves the
-- pair's stock was recorded. Same-day batch-vs-sale resolves conservatively
-- to 'existed'.
--
-- Return type changes (new stock_at_sale column), so DROP first.

DROP FUNCTION IF EXISTS public.get_negative_inventory_layers();

CREATE FUNCTION public.get_negative_inventory_layers()
RETURNS TABLE(
  layer_id uuid, batch_number text, product_id uuid, product_name text,
  product_sku text, warehouse text, kind text, quantity_remaining numeric,
  unit_cost numeric, value numeric, created_at timestamp with time zone,
  pair_positive_qty numeric, pair_positive_value numeric, pair_net_qty numeric,
  counter_qty numeric, invoice_numbers text, stock_at_sale text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH neg AS (
    SELECT b.id, b.batch_number, b.product_id, b.warehouse_id,
           b.quantity_remaining, b.unit_cost,
           b.quantity_remaining * b.unit_cost AS val,
           b.created_at,
           CASE
             WHEN b.batch_number IS NULL THEN 'UNNAMED'
             WHEN b.batch_number ILIKE 'FIFO-SHORTFALL%' THEN 'IOU'
             WHEN b.batch_number ILIKE 'ADJ%' THEN 'ADJ'
             WHEN b.batch_number ILIKE 'REDUCE%' THEN 'REDUCE'
             ELSE 'OTHER'
           END AS kind
    FROM inventory_batches b
    WHERE b.quantity_remaining < 0
      AND (b.batch_number IS NULL OR b.batch_number NOT LIKE 'FIFO-FALLBACK%')
  ),
  pair AS (
    SELECT b.product_id, b.warehouse_id,
           SUM(b.quantity_remaining) AS net_qty,
           SUM(CASE WHEN b.quantity_remaining > 0 THEN b.quantity_remaining ELSE 0 END) AS pos_qty,
           SUM(CASE WHEN b.quantity_remaining > 0 THEN b.quantity_remaining * b.unit_cost ELSE 0 END) AS pos_value
    FROM inventory_batches b
    GROUP BY b.product_id, b.warehouse_id
  ),
  ctr AS (
    SELECT ii.product_id, ii.warehouse_id, SUM(ii.quantity_on_hand) AS counter_qty
    FROM inventory_items ii
    GROUP BY ii.product_id, ii.warehouse_id
  ),
  inv AS (
    SELECT cns.batch_id,
           string_agg(DISTINCT i.invoice_number, ', ' ORDER BY i.invoice_number) AS invoice_numbers,
           MIN(i.invoice_date)::date AS sale_date
    FROM invoice_item_batch_consumption cns
    JOIN invoice_items ii ON ii.id = cns.invoice_item_id
    JOIN invoices i ON i.id = ii.invoice_id
    GROUP BY cns.batch_id
  ),
  first_real AS (
    SELECT product_id, warehouse_id, MIN(created_at)::date AS first_batch_date
    FROM inventory_batches
    WHERE quantity_remaining >= 0
    GROUP BY product_id, warehouse_id
  )
  SELECT n.id, n.batch_number, n.product_id, p.name, COALESCE(p.sku, ''), w.name,
         n.kind, n.quantity_remaining, n.unit_cost, n.val, n.created_at,
         pr.pos_qty, pr.pos_value, pr.net_qty, COALESCE(c.counter_qty, 0),
         iv.invoice_numbers,
         CASE
           WHEN iv.batch_id IS NULL THEN NULL
           WHEN fr.first_batch_date IS NULL THEN 'none'
           WHEN COALESCE(iv.sale_date, n.created_at::date) < fr.first_batch_date THEN 'after_sale'
           ELSE 'existed'
         END
  FROM neg n
  JOIN products p ON p.id = n.product_id
  LEFT JOIN warehouses w ON w.id = n.warehouse_id
  JOIN pair pr ON pr.product_id = n.product_id AND pr.warehouse_id = n.warehouse_id
  LEFT JOIN ctr c ON c.product_id = n.product_id AND c.warehouse_id = n.warehouse_id
  LEFT JOIN inv iv ON iv.batch_id = n.id
  LEFT JOIN first_real fr ON fr.product_id = n.product_id AND fr.warehouse_id = n.warehouse_id
  ORDER BY n.val ASC, n.created_at;
$function$
