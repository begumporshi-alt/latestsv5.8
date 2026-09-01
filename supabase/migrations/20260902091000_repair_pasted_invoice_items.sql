-- Repair the two husk invoices created by the "Copy Products / Paste
-- Products" flow on 2026-09-01 (root cause fixed in 20260902090000):
--
--   INV-940647 (created 15:34:33 UTC) -- 12 walton cable items, per-item
--                                       discount 18%, subtotal/total 663,757.20
--   INV-940648 (created 15:35:04 UTC) -- 12 walton cable items, per-item
--                                       discount 15%, subtotal/total 688,041.00
--
-- Both were copied from cancelled POS-00590095. The invoice rows and their
-- AR journal entries exist, but invoice_items / cost_price_history / COGS
-- journal entries / FIFO consumption / stock deduction are all missing
-- because the multi-row item INSERT failed on the cost-scale guard.
--
-- The intended item lists are fully determined by the stored invoice
-- subtotals: 12 items at the source quantities and prices reproduce
-- 688,041.00 at 15% discount and 663,757.20 at 18% discount, exactly.
-- Item INSERT goes through the normal triggers, so stock deduction, FIFO
-- consumption (with shortfall IOU layers where batches are short) and the
-- COGS journal entry are produced by the same machinery as a live sale.
--
-- Idempotent: audited invoices are never repaired twice; invoices that
-- already have items abort the migration.

BEGIN;

CREATE TABLE IF NOT EXISTS pasted_invoice_repair_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL UNIQUE,
  invoice_number text NOT NULL,
  discount_percent numeric NOT NULL,
  expected_item_count int NOT NULL,
  expected_subtotal numeric NOT NULL,
  actual_subtotal_after numeric,
  cogs_je_id uuid,
  repaired_at timestamptz,
  repaired_by text NOT NULL DEFAULT 'migration_20260902091000',
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE
  v_inv record;
  v_src_invoice uuid := 'd93cb439-5540-4fcf-896b-13076d64db6f'; -- POS-00590095
  v_discount numeric;
  v_expected_count int;
  v_expected_subtotal numeric;
  v_actual_count int;
  v_actual_subtotal numeric;
  v_cogs_je uuid;
  v_missing_consumption int;
  v_history_rows int;
BEGIN
  FOR v_inv IN
    SELECT id, invoice_number, subtotal, total_amount, status
      FROM invoices
     WHERE invoice_number IN ('INV-940647', 'INV-940648')
     ORDER BY created_at
  LOOP
    -- Idempotency: never repair the same invoice twice
    CONTINUE WHEN EXISTS (SELECT 1 FROM pasted_invoice_repair_audit WHERE invoice_id = v_inv.id);

    -- Safety: must currently be an item-less husk
    IF EXISTS (SELECT 1 FROM invoice_items WHERE invoice_id = v_inv.id) THEN
      RAISE EXCEPTION 'pasted invoice repair: % already has items; refusing', v_inv.invoice_number;
    END IF;

    -- Safety: COGS posting on item insert only happens for non-draft invoices
    IF v_inv.status NOT IN ('sent', 'partially_paid', 'paid') THEN
      RAISE EXCEPTION 'pasted invoice repair: % has status %; expected non-draft', v_inv.invoice_number, v_inv.status;
    END IF;

    v_discount := CASE v_inv.invoice_number WHEN 'INV-940647' THEN 18 ELSE 15 END;

    -- Expected values derived from the copied source invoice items
    SELECT COUNT(*), COALESCE(SUM(quantity * unit_price * (1 - v_discount / 100.0)), 0)
      INTO v_expected_count, v_expected_subtotal
      FROM invoice_items
     WHERE invoice_id = v_src_invoice;

    IF v_expected_count <> 12 THEN
      RAISE EXCEPTION 'pasted invoice repair: source invoice item count changed (%)', v_expected_count;
    END IF;

    IF ABS(v_expected_subtotal - v_inv.subtotal) > 0.01 OR ABS(v_expected_subtotal - v_inv.total_amount) > 0.01 THEN
      RAISE EXCEPTION 'pasted invoice repair: % expected subtotal % does not match stored subtotal % / total % -- item list is not what this repair assumes', v_inv.invoice_number, v_expected_subtotal, v_inv.subtotal, v_inv.total_amount;
    END IF;

    -- Audit first
    INSERT INTO pasted_invoice_repair_audit (invoice_id, invoice_number, discount_percent, expected_item_count, expected_subtotal)
    VALUES (v_inv.id, v_inv.invoice_number, v_discount, v_expected_count, v_expected_subtotal);

    -- Rebuild the items exactly as the paste flow would have sent them
    -- (per-SALE-unit cost from the product's sale unit). All stock
    -- deduction, FIFO consumption and COGS journal posting happens through
    -- the regular invoice_items triggers.
    INSERT INTO invoice_items (
      invoice_id, product_id, quantity, unit_price, cost_price, discount_percent,
      tax_rate, subtotal, unit_name, unit_conversion_factor, base_quantity,
      warehouse_id, sort_order
    )
    SELECT
      a.invoice_id,
      s.product_id,
      s.quantity,
      s.unit_price,
      COALESCE(pu.cost_price, p.cost_price * COALESCE(pu.conversion_factor, 1), p.cost_price, 0),
      v_discount,
      0,
      s.quantity * s.unit_price * (1 - v_discount / 100.0),
      s.unit_name,
      s.unit_conversion_factor,
      s.base_quantity,
      s.warehouse_id,
      s.sort_order
    FROM pasted_invoice_repair_audit a
    JOIN invoice_items s ON s.invoice_id = v_src_invoice
    JOIN products p ON p.id = s.product_id
    LEFT JOIN product_units pu ON pu.product_id = s.product_id AND pu.unit_name = s.unit_name AND pu.is_active
    WHERE a.invoice_id = v_inv.id
      AND a.repaired_by = 'migration_20260902091000'
      AND NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id = v_inv.id);

    -- Cost price history snapshot, as the invoice page records at sale time
    INSERT INTO cost_price_history (
      product_id, product_name, product_sku, invoice_id, unit, quantity,
      unit_price, cost_price_per_qty, cost_price_for_added_qty,
      total_cost_price_single, total_cost_price_added
    )
    SELECT ii.product_id, p.name, COALESCE(p.sku, ''), ii.invoice_id,
           COALESCE(ii.unit_name, 'pcs'), ii.quantity, ii.unit_price,
           ii.cost_price, ii.cost_price * ii.quantity,
           ii.cost_price, ii.cost_price * ii.quantity
      FROM invoice_items ii
      JOIN products p ON p.id = ii.product_id
     WHERE ii.invoice_id = v_inv.id
       AND NOT EXISTS (SELECT 1 FROM cost_price_history cph WHERE cph.invoice_id = v_inv.id);

    -- Post-conditions -------------------------------------------------------
    SELECT COUNT(*), COALESCE(SUM(subtotal), 0) INTO v_actual_count, v_actual_subtotal
      FROM invoice_items WHERE invoice_id = v_inv.id;

    IF v_actual_count <> v_expected_count THEN
      RAISE EXCEPTION 'pasted invoice repair: % has % items (expected %)', v_inv.invoice_number, v_actual_count, v_expected_count;
    END IF;
    IF ABS(v_actual_subtotal - v_expected_subtotal) > 0.01 THEN
      RAISE EXCEPTION 'pasted invoice repair: % rebuilt subtotal % <> expected %', v_inv.invoice_number, v_actual_subtotal, v_expected_subtotal;
    END IF;

    SELECT id INTO v_cogs_je FROM journal_entries
     WHERE reference_type = 'invoice' AND reference_id = v_inv.id AND description LIKE 'COGS%';
    IF v_cogs_je IS NULL THEN
      RAISE EXCEPTION 'pasted invoice repair: no COGS journal entry created for %', v_inv.invoice_number;
    END IF;

    SELECT COUNT(*) INTO v_missing_consumption
      FROM invoice_items ii
     WHERE ii.invoice_id = v_inv.id
       AND NOT EXISTS (SELECT 1 FROM invoice_item_batch_consumption c WHERE c.invoice_item_id = ii.id);
    IF v_missing_consumption > 0 THEN
      RAISE EXCEPTION 'pasted invoice repair: % items without FIFO consumption: %', v_inv.invoice_number, v_missing_consumption;
    END IF;

    SELECT COUNT(*) INTO v_history_rows
      FROM cost_price_history WHERE invoice_id = v_inv.id;
    IF v_history_rows <> v_expected_count THEN
      RAISE EXCEPTION 'pasted invoice repair: % cost history rows % (expected %)', v_inv.invoice_number, v_history_rows, v_expected_count;
    END IF;

    UPDATE pasted_invoice_repair_audit
       SET actual_subtotal_after = v_actual_subtotal, cogs_je_id = v_cogs_je, repaired_at = now()
     WHERE invoice_id = v_inv.id;

    RAISE NOTICE 'pasted invoice repair: % rebuilt (%, % items, subtotal %, COGS JE %)', v_inv.invoice_number, v_inv.status, v_actual_count, v_actual_subtotal, v_cogs_je;
  END LOOP;
END $$;

COMMIT;
