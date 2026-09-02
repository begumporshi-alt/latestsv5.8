-- Repair the batch-ledger damage from cancelling INV-940647 (2026-09-02
-- ~08:58 UTC) under the pre-fix restore_fifo, which DELETED every
-- adjustment-typed batch the invoice had consumed from instead of restoring
-- just the consumed quantity (root cause fixed in 20260902140000).
--
-- Damage: 12 walton-cable (product, Main Warehouse) pairs lost their
-- adjustment layers wholesale -- 52,687.082 m of quantity and ৳2,816,747.21
-- of value (GL 1200 kept the correct +605,854.41 restoration; only the batch
-- ledger was wrong). The batch DELETEs also cascade-deleted consumption rows
-- of INV-940648 (the sibling pasted invoice, still active) on those batches.
--
-- Reconstruction (validated to the paisa against three independent sources):
--   * per-pair missing qty = counter − batch remaining (counters are correct)
--   * per-pair value anchored by the Sept-1 inventory audit report
--     (docs/inventory-audit-report.html) for 5 products: repair = R − V48 −
--     current, where V48 = INV-940648's actual FIFO consumption from its
--     cost_price_history (CPH was written post-consume_fifo, i.e. true FIFO
--     averages; Σ V48 = 616,356.00 = its COGS JE exactly)
--   * 6 more products follow the exact pattern received − one invoice's item
--     qty = missing qty, tying their value to the creating adjustment's cost
--   * the remaining 2 products (1*1.5 RM-YEL @ 37.62, 1*3.0 RM-RED @ 72.20 =
--     their product cost_price / original opening-layer costs) close the
--     residual to exactly ৳3,144.00
--   Σ over all 12 pairs = 2,816,747.21 = GL − batches, to the paisa.
--
-- INV-940648's destroyed consumption rows are recreated per item (aggregated
-- per product, pointing at the restored layers) so that a future cancellation
-- of 940648 restores its stock correctly: Σ rows = 541,735.59 + surviving
-- 74,620.41 = 616,356.00 exactly.

BEGIN;

CREATE TABLE IF NOT EXISTS cancel_batch_damage_repair_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku text NOT NULL,
  restored_qty numeric NOT NULL,
  unit_cost numeric NOT NULL,
  restored_value numeric NOT NULL,
  derivation text,
  repaired_at timestamptz NOT NULL DEFAULT now(),
  repaired_by text NOT NULL DEFAULT 'migration_20260902150000'
);

DO $$
DECLARE
  v_main uuid := '11000000-0000-0000-0000-000000000001';
  v_before numeric;
  v_after numeric;
  v_delta numeric;
  v_layer_id uuid;
  v_drift numeric;
  v_rec record;
  v_cons_total numeric;
BEGIN
  SELECT SUM(quantity_remaining * unit_cost) INTO v_before FROM inventory_batches;

  -- ── 1) Restore the 12 deleted adjustment layers ──
  CREATE TEMP TABLE restore_plan (sku text, qty numeric, cost numeric, derivation text) ON COMMIT DROP;
  INSERT INTO restore_plan VALUES
    ('1*1.5 RM-RED', 11645.000, 37.38, 'audit report 534,056.50 − V48 67,284 − current 31,482.40'),
    ('1*1.5 RM-BLK', 10431.040, 34.22, 'audit report 418,546.19 − V48 61,596 − current 0'),
    ('1*2.5 RM-BLK',  8922.306, 60.00, 'audit report 607,338.36 − V48 72,000 − current 0'),
    ('1*2.5 RM-RED',  6999.666, 60.00, 'Sep-1 adjustment 8,199.666 @ 60 − 1,200 consumed'),
    ('1*4.0 RM-RED',  3792.000, 92.51, 'audit report 443,283.27 − V48 55,506 − current 36,979.35'),
    ('1*4.0 RM-BLK',  3400.000, 93.35, 'audit report 874,387.13 − V48 56,010 − current 500,987.13'),
    ('1*1.5 Re-GRN', 3660.100, 36.38, 'Aug-31 adjustment 4,260.1 @ 36.38 − 600 consumed'),
    ('1*1.5 RM-YEL', 1400.000, 37.62, 'older-era layer at product cost 37.62 (residual closure)'),
    ('1*3.0 RM-BLK', 1120.720, 72.20, 'Aug-30 adjustment 1,720.72 @ 72.20 − 600 consumed'),
    ('1*3.0 RM-RED',  600.000, 72.20, 'older-era layer at product cost 72.20 (residual closure)'),
    ('1*6.0 RM-BLK',  496.250, 126.97, 'Aug-29/31 adjustments @ 126.97, remaining at delete'),
    ('1*6.0 RM-RED',  220.000, 126.97, 'Aug-29/31 adjustments @ 126.97, remaining at delete');

  FOR v_rec IN SELECT * FROM restore_plan ORDER BY sku LOOP
    INSERT INTO inventory_batches (
      product_id, warehouse_id, batch_number, quantity_received,
      quantity_remaining, unit_cost, batch_type, notes, created_at
    ) VALUES (
      (SELECT id FROM products WHERE sku = v_rec.sku),
      v_main,
      'RESTORE-20260902-' || replace(v_rec.sku, ' ', ''),
      v_rec.qty, v_rec.qty, v_rec.cost, 'adjustment',
      'Reconstructed layer: INV-940647 cancellation (2026-09-02) ran the pre-fix restore_fifo which deleted the adjustment layers it had consumed from. Qty = counter − surviving batches; value anchored to the Sept-1 audit report / creating adjustments. ' || v_rec.derivation,
      CURRENT_DATE
    ) RETURNING id INTO v_layer_id;

    INSERT INTO cancel_batch_damage_repair_audit (sku, restored_qty, unit_cost, restored_value, derivation)
    VALUES (v_rec.sku, v_rec.qty, v_rec.cost, v_rec.qty * v_rec.cost, v_rec.derivation);

    -- ── 2) Recreate INV-940648's destroyed consumption rows (same product) ──
    INSERT INTO invoice_item_batch_consumption (
      invoice_item_id, batch_id, product_id, warehouse_id,
      quantity_consumed, unit_cost, cogs_amount
    )
    SELECT
      ii.id, v_layer_id, ii.product_id, v_main,
      GREATEST(ii.base_quantity - COALESCE(s.surviving_qty, 0), 0),
      v_rec.cost,
      (SELECT SUM(cph.cost_price_for_added_qty) FROM cost_price_history cph
        WHERE cph.invoice_id = ii.invoice_id AND cph.product_id = ii.product_id)
      - COALESCE(s.surviving_cogs, 0)
    FROM invoice_items ii
    LEFT JOIN LATERAL (
      SELECT SUM(c.quantity_consumed) AS surviving_qty, SUM(c.cogs_amount) AS surviving_cogs
      FROM invoice_item_batch_consumption c
      WHERE c.invoice_item_id = ii.id
    ) s ON true
    WHERE ii.invoice_id = (SELECT id FROM invoices WHERE invoice_number = 'INV-940648')
      AND ii.product_id = (SELECT id FROM products WHERE sku = v_rec.sku);
  END LOOP;

  -- ── Post-conditions ──
  -- a) the 12 pairs now match their counters
  SELECT COALESCE(SUM(ABS(c.q - b.q)), 0) INTO v_drift
  FROM (
    SELECT product_id, SUM(quantity_on_hand) AS q FROM inventory_items
    WHERE warehouse_id = v_main AND product_id IN (SELECT id FROM products WHERE sku IN (SELECT sku FROM restore_plan))
    GROUP BY product_id
  ) c
  JOIN (
    SELECT product_id, SUM(quantity_remaining) AS q FROM inventory_batches
    WHERE warehouse_id = v_main AND product_id IN (SELECT id FROM products WHERE sku IN (SELECT sku FROM restore_plan))
    GROUP BY product_id
  ) b ON b.product_id = c.product_id;
  IF v_drift > 0.001 THEN
    RAISE EXCEPTION 'cancel batch damage repair: 12 pairs still drift by % units', v_drift;
  END IF;

  -- b) this migration added exactly the destroyed value
  SELECT SUM(quantity_remaining * unit_cost) INTO v_after FROM inventory_batches;
  v_delta := v_after - v_before;
  IF ABS(v_delta - 2816747.2133) > 0.01 THEN
    RAISE EXCEPTION 'cancel batch damage repair: value delta % <> expected 2816747.21', v_delta;
  END IF;

  -- c) INV-940648's consumption now sums to its COGS JE
  SELECT COALESCE(SUM(cogs_amount), 0) INTO v_cons_total
  FROM invoice_item_batch_consumption c
  JOIN invoice_items ii ON ii.id = c.invoice_item_id
  WHERE ii.invoice_id = (SELECT id FROM invoices WHERE invoice_number = 'INV-940648');
  IF ABS(v_cons_total - 616356.00) > 0.01 THEN
    RAISE EXCEPTION 'cancel batch damage repair: INV-940648 consumption % <> 616,356.00', v_cons_total;
  END IF;

  RAISE NOTICE 'cancel batch damage repair: 12 layers restored (+%), 940648 consumption rebuilt, pairs tie to counters', ROUND(v_delta, 2);
END $$;

COMMIT;
