-- Bug 4 scope scan: multi-unit products whose products.unit does NOT match the
-- product_units row flagged is_base_unit. When products.unit is the SALE unit,
-- products.cost_price is also per sale unit, which violates the base-unit
-- contract and inflates COGS by the conversion factor.

\echo '=== 1. Products where products.unit != declared base unit ==='
SELECT p.id,
       p.name,
       p.unit                AS products_unit,
       base.unit_name        AS declared_base_unit,
       sale.unit_name        AS declared_sale_unit,
       sale.conversion_factor AS cf,
       ROUND(p.cost_price, 4) AS cost_price_now,
       ROUND(p.cost_price / NULLIF(sale.conversion_factor, 0), 4) AS cost_price_fixed,
       ROUND(p.sale_price, 2) AS sale_price,
       p.base_unit            AS products_base_unit
FROM products p
JOIN product_units base ON base.product_id = p.id AND base.is_base_unit
LEFT JOIN product_units sale ON sale.product_id = p.id AND sale.is_sale_unit AND sale.conversion_factor > 1
WHERE p.enable_multi_unit
  AND p.unit IS DISTINCT FROM base.unit_name
ORDER BY p.name;

\echo ''
\echo '=== 2. Same set: batches carrying the sale-unit cost ==='
SELECT p.name,
       b.batch_number,
       b.batch_type,
       ROUND(b.unit_cost, 4) AS unit_cost_now,
       ROUND(b.unit_cost / NULLIF(sale.conversion_factor, 0), 4) AS unit_cost_fixed,
       b.quantity_received,
       b.quantity_remaining
FROM inventory_batches b
JOIN products p ON p.id = b.product_id
JOIN product_units base ON base.product_id = p.id AND base.is_base_unit
JOIN product_units sale ON sale.product_id = p.id AND sale.is_sale_unit AND sale.conversion_factor > 1
WHERE p.enable_multi_unit
  AND p.unit IS DISTINCT FROM base.unit_name
ORDER BY p.name, b.batch_number;

\echo ''
\echo '=== 3. COGS impact on sold invoices for the mislabeled products ==='
WITH mislabeled AS (
  SELECT p.id, sale.conversion_factor AS cf
  FROM products p
  JOIN product_units base ON base.product_id = p.id AND base.is_base_unit
  JOIN product_units sale ON sale.product_id = p.id AND sale.is_sale_unit AND sale.conversion_factor > 1
  WHERE p.enable_multi_unit AND p.unit IS DISTINCT FROM base.unit_name
)
SELECT i.invoice_number,
       i.invoice_date,
       i.status,
       p.name,
       ii.quantity,
       ii.unit_name,
       ii.unit_conversion_factor AS item_cf,
       ii.base_quantity,
       ROUND(ii.unit_price, 2) AS unit_price,
       ROUND(ii.cost_price, 4) AS cost_price,
       ROUND(COALESCE(
         (SELECT SUM(ibc.cogs_amount) FROM invoice_item_batch_consumption ibc
          WHERE ibc.invoice_item_id = ii.id),
         ii.quantity * ii.cost_price), 2) AS cogs_now,
       ROUND(COALESCE(
         (SELECT SUM(ibc.cogs_amount) FROM invoice_item_batch_consumption ibc
          WHERE ibc.invoice_item_id = ii.id),
         ii.quantity * ii.cost_price) / m.cf, 2) AS cogs_fixed
FROM invoice_items ii
JOIN mislabeled m ON m.id = ii.product_id
JOIN products p ON p.id = ii.product_id
JOIN invoices i ON i.id = ii.invoice_id
WHERE i.status IN ('sent', 'partially_paid', 'paid')
ORDER BY i.invoice_date, i.invoice_number;

\echo ''
\echo '=== 4. Total COGS overstatement from Bug 4 ==='
WITH mislabeled AS (
  SELECT p.id, sale.conversion_factor AS cf
  FROM products p
  JOIN product_units base ON base.product_id = p.id AND base.is_base_unit
  JOIN product_units sale ON sale.product_id = p.id AND sale.is_sale_unit AND sale.conversion_factor > 1
  WHERE p.enable_multi_unit AND p.unit IS DISTINCT FROM base.unit_name
), impact AS (
  SELECT COALESCE(
           (SELECT SUM(ibc.cogs_amount) FROM invoice_item_batch_consumption ibc
            WHERE ibc.invoice_item_id = ii.id),
           ii.quantity * ii.cost_price) AS cogs_now,
         m.cf
  FROM invoice_items ii
  JOIN mislabeled m ON m.id = ii.product_id
  JOIN invoices i ON i.id = ii.invoice_id
  WHERE i.status IN ('sent', 'partially_paid', 'paid')
)
SELECT ROUND(SUM(cogs_now), 2) AS cogs_now,
       ROUND(SUM(cogs_now / cf), 2) AS cogs_fixed,
       ROUND(SUM(cogs_now - cogs_now / cf), 2) AS overstatement
FROM impact;
