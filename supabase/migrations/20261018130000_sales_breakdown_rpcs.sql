/*
## Sales breakdown RPCs for the dedicated Sales Report page (2026-10-18)

Aggregates non-cancelled, non-draft invoice lines DB-side so the report page
never pulls raw invoice_items to the browser (egress + row-cap safety).

- sales_breakdown(p_dimension, p_start_date, p_end_date)
    One row per dimension member: product | brand | category | customer.
    revenue  = SUM(invoice_items.subtotal)          — same basis the old top-products table used
    cost     = SUM(quantity * cost_price)           — same basis the old top-products table used
    profit   = revenue - cost
    unit     = most frequent unit_name (product dimension only, else NULL)
- sales_monthly(p_start_date, p_end_date)
    Month-by-month revenue/cost series bounded by the requested range
    (the old page always rendered Jan→today regardless of the filter).
- sales_breakdown_detail(p_dimension, p_dimension_id, p_start_date, p_end_date)
    Invoice-level drill-down rows for one dimension member.

All SECURITY DEFINER read-only (same pattern as period_net_debit).
*/

CREATE OR REPLACE FUNCTION public.sales_breakdown(
  p_dimension text,
  p_start_date date,
  p_end_date date DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  name text,
  unit text,
  quantity numeric,
  invoice_count bigint,
  revenue numeric,
  cost numeric,
  profit numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    CASE p_dimension
      WHEN 'product'  THEN ii.product_id
      WHEN 'brand'    THEN p.brand_id
      WHEN 'category' THEN p.category_id
      WHEN 'customer' THEN i.customer_id
    END AS id,
    CASE p_dimension
      WHEN 'product'  THEN COALESCE(p.name, ii.description, 'Unknown product')
      WHEN 'brand'    THEN COALESCE(b.name, 'Unbranded')
      WHEN 'category' THEN COALESCE(c.name, 'Uncategorized')
      WHEN 'customer' THEN COALESCE(cu.name, 'Walk-in')
    END AS name,
    CASE p_dimension
      WHEN 'product' THEN mode() WITHIN GROUP (ORDER BY ii.unit_name)
    END AS unit,
    SUM(ii.quantity) AS quantity,
    COUNT(DISTINCT ii.invoice_id) AS invoice_count,
    SUM(ii.subtotal) AS revenue,
    SUM(ii.quantity * ii.cost_price) AS cost,
    SUM(ii.subtotal - ii.quantity * ii.cost_price) AS profit
  FROM invoice_items ii
  JOIN invoices i  ON i.id  = ii.invoice_id
  LEFT JOIN products p   ON p.id  = ii.product_id
  LEFT JOIN brands b     ON b.id  = p.brand_id
  LEFT JOIN categories c ON c.id  = p.category_id
  LEFT JOIN customers cu ON cu.id = i.customer_id
  WHERE i.status NOT IN ('cancelled', 'draft')
    AND i.invoice_date >= p_start_date
    AND (p_end_date IS NULL OR i.invoice_date <= p_end_date)
  GROUP BY 1, 2
  ORDER BY revenue DESC;
$$;

CREATE OR REPLACE FUNCTION public.sales_monthly(
  p_start_date date,
  p_end_date date
)
RETURNS TABLE (
  month text,
  revenue numeric,
  cost numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    to_char(date_trunc('month', i.invoice_date), 'YYYY-MM') AS month,
    SUM(ii.subtotal) AS revenue,
    SUM(ii.quantity * ii.cost_price) AS cost
  FROM invoice_items ii
  JOIN invoices i ON i.id = ii.invoice_id
  WHERE i.status NOT IN ('cancelled', 'draft')
    AND i.invoice_date >= p_start_date
    AND i.invoice_date <= p_end_date
  GROUP BY 1
  ORDER BY 1;
$$;

CREATE OR REPLACE FUNCTION public.sales_breakdown_detail(
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
  SELECT
    i.id AS invoice_id,
    i.invoice_number,
    i.invoice_date,
    cu.name AS customer_name,
    SUM(ii.quantity) AS quantity,
    SUM(ii.subtotal) AS revenue,
    SUM(ii.quantity * ii.cost_price) AS cost
  FROM invoice_items ii
  JOIN invoices i  ON i.id  = ii.invoice_id
  LEFT JOIN products p   ON p.id  = ii.product_id
  LEFT JOIN customers cu ON cu.id = i.customer_id
  WHERE i.status NOT IN ('cancelled', 'draft')
    AND i.invoice_date >= p_start_date
    AND i.invoice_date <= p_end_date
    AND CASE p_dimension
          WHEN 'product'  THEN ii.product_id
          WHEN 'brand'    THEN p.brand_id
          WHEN 'category' THEN p.category_id
          WHEN 'customer' THEN i.customer_id
        END = p_dimension_id
  GROUP BY i.id, i.invoice_number, i.invoice_date, cu.name
  ORDER BY i.invoice_date DESC, i.invoice_number DESC;
$$;

GRANT EXECUTE ON FUNCTION public.sales_breakdown(text, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sales_monthly(date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sales_breakdown_detail(text, uuid, date, date) TO authenticated;
