-- Classify the 5 products flagged by scan_product_unit_mislabel.sql.
-- The structural predicate (products.unit != declared base unit) matches TWO
-- different situations and only the numbers can tell them apart:
--   (a) real Bug 4  - products.cost_price is genuinely in SALE units
--   (b) stale label - cost_price already per base unit, only products.unit is wrong
-- Note products has BOTH `unit` and `base_unit`; compare all three sources.
SELECT p.name,
       p.unit               AS products_unit,
       p.base_unit          AS products_base_unit,
       ROUND(p.cost_price, 4) AS cost_price,
       ROUND(p.sale_price, 2)  AS sale_price,
       pu.unit_name,
       pu.conversion_factor AS cf,
       pu.is_base_unit,
       pu.is_sale_unit
FROM products p
LEFT JOIN product_units pu ON pu.product_id = p.id
WHERE p.name IN (
  'ERICSON 20mm cable clip',
  'ERICSON 5mm cable clip',
  'ERICSON 23*76 TC',
  'nitlal white cement',
  'walton cable 1*6.0 RM Black'
)
ORDER BY p.name, pu.conversion_factor;
