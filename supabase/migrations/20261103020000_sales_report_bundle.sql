/*
# Sales report bundle: one round trip, one scan, reconciling totals (2026-11-03)

## Why

The Sales Report page used to build itself from five separate aggregates:

    invoices (fetchAll — every row shipped to the browser to sum 3 columns)
    sales_monthly
    sales_breakdown('product')
    sales_breakdown('category')
    period_net_debit('5000') + period_net_debit('4050')

That is seven requests in two sequential rounds, and it produced two numbers
that never reconciled:

  * the revenue KPI was invoice-level (total_amount - tax - shipping), while
    every breakdown used SUM(invoice_items.subtotal). The gap is the
    invoice-level (cart) discount: total_amount = subtotal - discount_amount
    + tax + shipping. So the Summary revenue was always LOWER than the sum of
    the By Product rows whenever a cart discount existed.
  * COGS was read from the ledger (account 5000) while each row's cost was
    the line cost_price, so "COGS" and the sum of dimension costs differed.

## What this migration adds

1. Indexes the report actually needs (invoice_items.invoice_id had none —
   Postgres does not index foreign keys automatically, so every breakdown was
   a sequential scan of the whole line-item table).

2. `sales_report_breakdown(p_dimension, p_start, p_end)`
   Same shape as sales_breakdown, but revenue is the line subtotal with the
   invoice's cart discount allocated pro-rata to each line. Summing any
   dimension therefore reproduces the invoice-level net revenue exactly.

3. `sales_report_detail(...)`
   Invoice-level drill-down on the same allocated basis.

4. `sales_report_summary(p_start, p_end)` → jsonb
   KPIs + monthly series + top-12 rows for all four dimensions in ONE call.
   The dimension groupings all read a single materialised `lines` CTE, so the
   invoice_items scan happens once, not four times.

## Revenue basis (documented for the report footer)

    revenue(line) = ii.subtotal * (1 - discount_amount / invoice.subtotal)

clamped so a discount larger than the invoice subtotal cannot drive a line
negative. VAT and shipping are billed at invoice level and are excluded from
revenue; both are returned as memo figures.

## COGS basis

kpis.cogs is the ledger figure (account 5000) — the same number the P&L
prints. kpis.cogs_line is the sum of line cost_price, which is the basis the
dimension tables use. Both are returned so the report can show the variance
instead of hiding it.

Read-only, SECURITY DEFINER (same pattern as period_net_debit).
*/

/* ------------------------------------------------------------------ */
/* Indexes                                                             */
/* ------------------------------------------------------------------ */

-- Every breakdown joins invoice_items to a date-filtered invoice set, and the
-- drill-down filters by invoice_id. Without this index each of those is a
-- sequential scan of the entire line-item table.
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice_id
  ON invoice_items (invoice_id)
  INCLUDE (product_id, quantity, subtotal, cost_price);

-- Product dimension grouping + product drill-down.
CREATE INDEX IF NOT EXISTS idx_invoice_items_product_id
  ON invoice_items (product_id);

-- The period filter always excludes cancelled/draft. A partial index keeps
-- the scan on exactly the rows the report can use.
CREATE INDEX IF NOT EXISTS idx_invoices_date_active
  ON invoices (invoice_date)
  WHERE status NOT IN ('cancelled', 'draft');

/* ------------------------------------------------------------------ */
/* Shared line view                                                     */
/* ------------------------------------------------------------------ */

/*
Both report functions below need the same allocated line revenue. The
expression is duplicated rather than extracted into a view so the functions
stay self-contained (and so a later change to the basis is visible in one
file). Keep the two copies identical.
*/

/* ------------------------------------------------------------------ */
/* Breakdown — one dimension, full list                                 */
/* ------------------------------------------------------------------ */

CREATE OR REPLACE FUNCTION public.sales_report_breakdown(
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
  WITH inv AS (
    SELECT
      i.id,
      i.invoice_date,
      i.customer_id,
      COALESCE(i.subtotal, 0)        AS subtotal,
      COALESCE(i.discount_amount, 0) AS discount_amount
    FROM invoices i
    WHERE i.status NOT IN ('cancelled', 'draft')
      AND i.invoice_date >= p_start_date
      AND (p_end_date IS NULL OR i.invoice_date <= p_end_date)
  ),
  lines AS (
    SELECT
      ii.invoice_id,
      v.customer_id,
      ii.product_id,
      ii.quantity,
      ii.unit_name,
      ii.description,
      CASE
        WHEN v.subtotal > 0 THEN
          ii.subtotal * (1 - LEAST(GREATEST(v.discount_amount, 0), v.subtotal) / v.subtotal)
        ELSE ii.subtotal
      END AS revenue,
      ii.quantity * COALESCE(ii.cost_price, 0) AS cost
    FROM invoice_items ii
    JOIN inv v ON v.id = ii.invoice_id
  )
  SELECT
    CASE p_dimension
      WHEN 'product'  THEN l.product_id
      WHEN 'brand'    THEN p.brand_id
      WHEN 'category' THEN p.category_id
      WHEN 'customer' THEN l.customer_id
    END AS id,
    CASE p_dimension
      WHEN 'product'  THEN COALESCE(p.name, l.description, 'Unknown product')
      WHEN 'brand'    THEN COALESCE(b.name, 'Unbranded')
      WHEN 'category' THEN COALESCE(c.name, 'Uncategorized')
      WHEN 'customer' THEN COALESCE(cu.name, 'Walk-in')
    END AS name,
    CASE p_dimension
      WHEN 'product' THEN mode() WITHIN GROUP (ORDER BY l.unit_name)
    END AS unit,
    SUM(l.quantity)                    AS quantity,
    COUNT(DISTINCT l.invoice_id)       AS invoice_count,
    SUM(l.revenue)                     AS revenue,
    SUM(l.cost)                        AS cost,
    SUM(l.revenue - l.cost)            AS profit
  FROM lines l
  LEFT JOIN products p   ON p.id  = l.product_id
  LEFT JOIN brands b     ON b.id  = p.brand_id
  LEFT JOIN categories c ON c.id  = p.category_id
  LEFT JOIN customers cu ON cu.id = l.customer_id
  WHERE p_dimension IN ('product', 'brand', 'category', 'customer')
  GROUP BY 1, 2
  ORDER BY 6 DESC, 2 ASC;
$$;

/* ------------------------------------------------------------------ */
/* Drill-down — invoice rows behind one dimension member                */
/* ------------------------------------------------------------------ */

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
  WHERE CASE p_dimension
          WHEN 'product'  THEN ii.product_id
          WHEN 'brand'    THEN p.brand_id
          WHEN 'category' THEN p.category_id
          WHEN 'customer' THEN v.customer_id
        END = p_dimension_id
  GROUP BY v.id, v.invoice_number, v.invoice_date, cu.name
  ORDER BY v.invoice_date DESC, v.invoice_number DESC;
$$;

/* ------------------------------------------------------------------ */
/* Summary bundle                                                      */
/* ------------------------------------------------------------------ */

CREATE OR REPLACE FUNCTION public.sales_report_summary(
  p_start_date date,
  p_end_date date
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH inv AS (
    SELECT
      i.id,
      i.invoice_date,
      i.customer_id,
      COALESCE(i.subtotal, 0)        AS subtotal,
      COALESCE(i.discount_amount, 0) AS discount_amount,
      COALESCE(i.tax_amount, 0)      AS tax_amount,
      COALESCE(i.shipping_cost, 0)   AS shipping_cost
    FROM invoices i
    WHERE i.status NOT IN ('cancelled', 'draft')
      AND i.invoice_date >= p_start_date
      AND i.invoice_date <= p_end_date
  ),
  -- Referenced by every dimension grouping below, so Postgres materialises it
  -- once: the invoice_items scan happens a single time per report load.
  lines AS (
    SELECT
      ii.invoice_id,
      v.invoice_date,
      v.customer_id,
      ii.product_id,
      ii.quantity,
      ii.unit_name,
      ii.description,
      CASE
        WHEN v.subtotal > 0 THEN
          ii.subtotal * (1 - LEAST(GREATEST(v.discount_amount, 0), v.subtotal) / v.subtotal)
        ELSE ii.subtotal
      END AS revenue,
      ii.quantity * COALESCE(ii.cost_price, 0) AS cost
    FROM invoice_items ii
    JOIN inv v ON v.id = ii.invoice_id
  ),
  dim_product AS (
    SELECT
      l.product_id AS id,
      COALESCE(p.name, l.description, 'Unknown product') AS name,
      mode() WITHIN GROUP (ORDER BY l.unit_name) AS unit,
      SUM(l.quantity)              AS quantity,
      COUNT(DISTINCT l.invoice_id) AS invoice_count,
      SUM(l.revenue)               AS revenue,
      SUM(l.cost)                  AS cost
    FROM lines l
    LEFT JOIN products p ON p.id = l.product_id
    GROUP BY 1, 2
  ),
  dim_brand AS (
    SELECT
      p.brand_id AS id,
      COALESCE(b.name, 'Unbranded') AS name,
      NULL::text AS unit,
      SUM(l.quantity)              AS quantity,
      COUNT(DISTINCT l.invoice_id) AS invoice_count,
      SUM(l.revenue)               AS revenue,
      SUM(l.cost)                  AS cost
    FROM lines l
    LEFT JOIN products p ON p.id = l.product_id
    LEFT JOIN brands b   ON b.id = p.brand_id
    GROUP BY 1, 2
  ),
  dim_category AS (
    SELECT
      p.category_id AS id,
      COALESCE(c.name, 'Uncategorized') AS name,
      NULL::text AS unit,
      SUM(l.quantity)              AS quantity,
      COUNT(DISTINCT l.invoice_id) AS invoice_count,
      SUM(l.revenue)               AS revenue,
      SUM(l.cost)                  AS cost
    FROM lines l
    LEFT JOIN products p   ON p.id = l.product_id
    LEFT JOIN categories c ON c.id = p.category_id
    GROUP BY 1, 2
  ),
  dim_customer AS (
    SELECT
      l.customer_id AS id,
      COALESCE(cu.name, 'Walk-in') AS name,
      NULL::text AS unit,
      SUM(l.quantity)              AS quantity,
      COUNT(DISTINCT l.invoice_id) AS invoice_count,
      SUM(l.revenue)               AS revenue,
      SUM(l.cost)                  AS cost
    FROM lines l
    LEFT JOIN customers cu ON cu.id = l.customer_id
    GROUP BY 1, 2
  ),
  totals AS (
    SELECT COALESCE(SUM(revenue), 0) AS revenue,
           COALESCE(SUM(cost), 0)    AS cost
    FROM lines
  ),
  inv_totals AS (
    SELECT
      COUNT(*)::bigint                AS orders,
      COALESCE(SUM(subtotal), 0)      AS gross_subtotal,
      COALESCE(SUM(discount_amount), 0) AS cart_discount,
      COALESCE(SUM(tax_amount), 0)    AS vat,
      COALESCE(SUM(shipping_cost), 0) AS shipping
    FROM inv
  ),
  ledger AS (
    SELECT
      COALESCE((
        SELECT SUM(jl.debit - jl.credit)
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.journal_entry_id
        JOIN accounts a         ON a.id  = jl.account_id
        WHERE a.code = '5000'
          AND je.entry_date >= p_start_date
          AND je.entry_date <= p_end_date
      ), 0) AS cogs,
      COALESCE((
        SELECT SUM(jl.debit - jl.credit)
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.journal_entry_id
        JOIN accounts a         ON a.id  = jl.account_id
        WHERE a.code = '4050'
          AND je.entry_date >= p_start_date
          AND je.entry_date <= p_end_date
      ), 0) AS returns
  ),
  monthly AS (
    SELECT
      to_char(date_trunc('month', l.invoice_date), 'YYYY-MM') AS month,
      SUM(l.revenue) AS revenue,
      SUM(l.cost)    AS cost
    FROM lines l
    GROUP BY 1
    ORDER BY 1
  )
  SELECT jsonb_build_object(
    'period', jsonb_build_object('start', p_start_date, 'end', p_end_date),
    'kpis', jsonb_build_object(
      'revenue',          t.revenue,
      'orders',           it.orders,
      'returns',          lg.returns,
      'cogs',             lg.cogs,
      'cogs_line',        t.cost,
      'gross_profit',     t.revenue - lg.returns - lg.cogs,
      'gross_profit_line', t.revenue - t.cost,
      'cart_discount',    it.cart_discount,
      'gross_subtotal',   it.gross_subtotal,
      'vat',              it.vat,
      'shipping',         it.shipping,
      'avg_invoice',      CASE WHEN it.orders > 0 THEN t.revenue / it.orders ELSE 0 END
    ),
    'monthly', COALESCE((SELECT jsonb_agg(to_jsonb(m)) FROM monthly m), '[]'::jsonb),
    'dimensions', jsonb_build_object(
      'product', jsonb_build_object(
        'total', (SELECT COUNT(*) FROM dim_product),
        'rows', COALESCE((
          SELECT jsonb_agg(to_jsonb(x)) FROM (
            SELECT id, name, unit, quantity, invoice_count, revenue, cost, revenue - cost AS profit
            FROM dim_product
            ORDER BY revenue DESC, name ASC
            LIMIT 12
          ) x
        ), '[]'::jsonb)
      ),
      'brand', jsonb_build_object(
        'total', (SELECT COUNT(*) FROM dim_brand),
        'rows', COALESCE((
          SELECT jsonb_agg(to_jsonb(x)) FROM (
            SELECT id, name, unit, quantity, invoice_count, revenue, cost, revenue - cost AS profit
            FROM dim_brand
            ORDER BY revenue DESC, name ASC
            LIMIT 12
          ) x
        ), '[]'::jsonb)
      ),
      'category', jsonb_build_object(
        'total', (SELECT COUNT(*) FROM dim_category),
        'rows', COALESCE((
          SELECT jsonb_agg(to_jsonb(x)) FROM (
            SELECT id, name, unit, quantity, invoice_count, revenue, cost, revenue - cost AS profit
            FROM dim_category
            ORDER BY revenue DESC, name ASC
            LIMIT 12
          ) x
        ), '[]'::jsonb)
      ),
      'customer', jsonb_build_object(
        'total', (SELECT COUNT(*) FROM dim_customer),
        'rows', COALESCE((
          SELECT jsonb_agg(to_jsonb(x)) FROM (
            SELECT id, name, unit, quantity, invoice_count, revenue, cost, revenue - cost AS profit
            FROM dim_customer
            ORDER BY revenue DESC, name ASC
            LIMIT 12
          ) x
        ), '[]'::jsonb)
      )
    )
  )
  FROM totals t, inv_totals it, ledger lg;
$$;

GRANT EXECUTE ON FUNCTION public.sales_report_breakdown(text, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sales_report_detail(text, uuid, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sales_report_summary(date, date) TO authenticated;
