-- Surface the invoices behind each negative FIFO layer on the Inventory Audit
-- page, so the "was this really sold?" review is self-service. The layer rows
-- themselves carry no invoice reference (reference_id is NULL on oversell
-- layers), but invoice_item_batch_consumption links every batch to the invoice
-- items that consumed from it — aggregate those invoice numbers per layer.
--
-- Return type changes (new invoice_numbers column), so DROP first.

DROP FUNCTION IF EXISTS public.get_negative_inventory_layers();

CREATE FUNCTION public.get_negative_inventory_layers()
RETURNS TABLE(
  layer_id uuid, batch_number text, product_id uuid, product_name text,
  product_sku text, warehouse text, kind text, quantity_remaining numeric,
  unit_cost numeric, value numeric, created_at timestamp with time zone,
  pair_positive_qty numeric, pair_positive_value numeric, pair_net_qty numeric,
  counter_qty numeric, invoice_numbers text
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
           string_agg(DISTINCT i.invoice_number, ', ' ORDER BY i.invoice_number) AS invoice_numbers
    FROM invoice_item_batch_consumption cns
    JOIN invoice_items ii ON ii.id = cns.invoice_item_id
    JOIN invoices i ON i.id = ii.invoice_id
    GROUP BY cns.batch_id
  )
  SELECT n.id, n.batch_number, n.product_id, p.name, COALESCE(p.sku, ''), w.name,
         n.kind, n.quantity_remaining, n.unit_cost, n.val, n.created_at,
         pr.pos_qty, pr.pos_value, pr.net_qty, COALESCE(c.counter_qty, 0),
         iv.invoice_numbers
  FROM neg n
  JOIN products p ON p.id = n.product_id
  LEFT JOIN warehouses w ON w.id = n.warehouse_id
  JOIN pair pr ON pr.product_id = n.product_id AND pr.warehouse_id = n.warehouse_id
  LEFT JOIN ctr c ON c.product_id = n.product_id AND c.warehouse_id = n.warehouse_id
  LEFT JOIN inv iv ON iv.batch_id = n.id
  ORDER BY n.val ASC, n.created_at;
$function$
