-- 2026-08-26: Document unit semantics for sales returns (multi-unit fix)
--
-- The sales return flow restored inventory and FIFO batches in SALE units
-- instead of BASE units, under-restoring stock and under-reversing COGS by the
-- product's conversion_factor. Root cause: the returns page never loaded
-- base_quantity, and never populated sales_return_items.base_quantity_returned
-- (which cancel_invoice relies on to net prior returns).
--
-- Fixed in app/(erp)/sales/returns/page.tsx. No schema change is needed --
-- base_quantity_returned already exists (added 20260712084302). This migration
-- records the unit contract in the schema so it is not violated again.
--
-- Existing multi-unit returns carry incorrect stock and COGS. Size the impact
-- with scripts/diagnose_sales_return_unit_bug.sql before reconciling.

COMMENT ON COLUMN sales_return_items.base_quantity_returned IS
'BASE units returned (= quantity_returned x unit_conversion_factor). Use for all stock, FIFO, and COGS operations. quantity_returned is in the SALE unit.';

COMMENT ON COLUMN sales_return_items.quantity_returned IS
'SALE units returned (matches invoice_items.quantity unit). For stock/FIFO use base_quantity_returned instead.';

COMMENT ON COLUMN sales_return_items.cost_price IS
'Cost per SALE unit at time of return, consistent with invoice_items.cost_price. Per-BASE-unit cost is on the paired return_in stock_movements.unit_cost.';
