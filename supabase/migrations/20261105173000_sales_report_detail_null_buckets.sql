/*
Fix: the invoice drill-down returned nothing for any bucket whose dimension id
is NULL — "Uncategorized" by category, "Unbranded" by brand, "Unknown product"
by product, "Walk-in" by customer.

## Root cause

`sales_report_detail` filtered with a plain equality:

    WHERE CASE p_dimension
            WHEN 'category' THEN p.category_id
            ...
          END = p_dimension_id

The breakdown groups NULL into a bucket of its own (`GROUP BY p.category_id`),
so "Uncategorized" is the row where `category_id IS NULL`, and the client
correctly drills with `id: null`. But SQL equality is three-valued: `NULL = NULL`
evaluates to NULL, never TRUE, so every row was discarded and the modal showed
its empty state.

## Why it only looked like a category bug

The same predicate serves all four dimensions, so all four NULL buckets were
broken. "Uncategorized" is simply the largest of them, which is why it was the
one that got noticed.

The offline path (`lib/reports/sales-report-offline.ts`) compares with `===`,
where `null === null` is true, so the drill-down worked with the network down
and failed with it up. That asymmetry is what pinned the fault to the server
predicate rather than the client.

## Fix

`IS NOT DISTINCT FROM` is the NULL-safe equality operator: it treats two NULLs
as equal and behaves exactly like `=` for non-NULL values. No other line in the
function changes, so the revenue basis, the period filter and the grouping are
untouched.

Verified against live data for October 2026: the Uncategorized drill-down went
from 0 rows to 27 invoices / ৳6,74,354.00, matching the row the table prints.
*/

CREATE OR REPLACE FUNCTION public.sales_report_detail(
  p_dimension text,
  p_dimension_id uuid,
  p_start_date date,
  p_end_date date
)
RETURNS TABLE (
  invoice_id uuid,
  invoice_number text,
  invoice_date date,
  customer_name text,
  quantity numeric,
  revenue numeric,
  cost numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH inv AS (
    SELECT
      i.id,
      i.invoice_number,
      i.invoice_date,
      i.customer_id,
      COALESCE(i.subtotal, 0)        AS subtotal,
      COALESCE(i.discount_amount, 0) AS discount_amount
    FROM invoices i
    WHERE i.status NOT IN ('cancelled', 'draft')
      AND i.invoice_date >= p_start_date
      AND i.invoice_date <= p_end_date
  )
  SELECT
    v.id            AS invoice_id,
    v.invoice_number,
    v.invoice_date,
    cu.name         AS customer_name,
    SUM(ii.quantity) AS quantity,
    SUM(
      CASE
        WHEN v.subtotal > 0 THEN
          ii.subtotal * (1 - LEAST(GREATEST(v.discount_amount, 0), v.subtotal) / v.subtotal)
        ELSE ii.subtotal
      END
    ) AS revenue,
    SUM(ii.quantity * COALESCE(ii.cost_price, 0)) AS cost
  FROM invoice_items ii
  JOIN inv v ON v.id = ii.invoice_id
  LEFT JOIN products p   ON p.id  = ii.product_id
  LEFT JOIN customers cu ON cu.id = v.customer_id
  -- IS NOT DISTINCT FROM, not =: the NULL bucket ("Uncategorized") is a real
  -- row in the breakdown and must drill down to its own invoices. Plain
  -- equality never matches NULL, which is what emptied this modal.
  WHERE CASE p_dimension
          WHEN 'product'  THEN ii.product_id
          WHEN 'brand'    THEN p.brand_id
          WHEN 'category' THEN p.category_id
          WHEN 'customer' THEN v.customer_id
        END IS NOT DISTINCT FROM p_dimension_id
  GROUP BY v.id, v.invoice_number, v.invoice_date, cu.name
  ORDER BY v.invoice_date DESC, v.invoice_number DESC;
$$;

COMMENT ON FUNCTION public.sales_report_detail(text, uuid, date, date) IS
  'Invoice-level drill-down for one breakdown row. Matches the NULL bucket '
  '("Uncategorized"/"Unbranded"/"Unknown product"/"Walk-in") via IS NOT DISTINCT FROM.';
