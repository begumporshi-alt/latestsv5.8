-- 2026-09-01: Rebuild inventory_items.quantity_on_hand from batch truth (audit fix #2).
--
-- The POS availability counter had drifted from the FIFO batch ledger (668 of 1,401
-- pairs, 119,826 units total |drift|; 518 negative rows; 365 pairs with ৳3.26M of
-- batch value invisible to POS) because it was last rebuilt from stock_movements
-- (2026-08-30) and every batch-side write that skipped movements left it behind.
--
-- This sets quantity_on_hand = SUM(inventory_batches.quantity_remaining) per
-- (product, warehouse) — the same definition the GL 1200 account now ties to after
-- JE-964716. Negative batch sums produce negative counters (kept — they are the
-- ledger's oversell IOUs, now visible where they belong).
--
-- Edge case: pairs with a non-zero counter but NO batch rows at all are NOT zeroed
-- (that could hide physically-present pre-FIFO stock) — they are recorded in the
-- audit table for an owner decision.
--
-- Safety: audited per-pair (before/after), safe to re-run (only drifted pairs change;
-- re-running also repairs any NEW drift, which is desirable), post-condition verified.

BEGIN;

CREATE TABLE IF NOT EXISTS inventory_counter_rebuild_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  counter_before numeric(15,3) NOT NULL,
  batch_truth numeric(15,3) NOT NULL,
  counter_after numeric(15,3) NOT NULL,
  run_at timestamptz NOT NULL DEFAULT now(),
  run_by text NOT NULL DEFAULT 'migration_20260901130000'
);

-- 1. Flag (do not touch) pairs with a non-zero counter and no batch rows at all.
INSERT INTO inventory_counter_rebuild_audit
  (product_id, warehouse_id, counter_before, batch_truth, counter_after, run_by)
SELECT ii.product_id, ii.warehouse_id, ii.quantity_on_hand, 0, ii.quantity_on_hand,
       'migration_20260901130000/FLAGGED-no-batches'
FROM inventory_items ii
WHERE ii.quantity_on_hand <> 0
  AND NOT EXISTS (SELECT 1 FROM inventory_batches b
                  WHERE b.product_id = ii.product_id AND b.warehouse_id = ii.warehouse_id)
  AND NOT EXISTS (SELECT 1 FROM inventory_counter_rebuild_audit a
                  WHERE a.product_id = ii.product_id AND a.warehouse_id = ii.warehouse_id
                    AND a.run_by = 'migration_20260901130000/FLAGGED-no-batches');

-- 2a. Create counter rows for batch pairs that have NO inventory_items row at all
--     (stock invisible to POS because the counter row was never created).
INSERT INTO inventory_counter_rebuild_audit
  (product_id, warehouse_id, counter_before, batch_truth, counter_after, run_by)
SELECT b.product_id, b.warehouse_id, 0, SUM(b.quantity_remaining), SUM(b.quantity_remaining),
       'migration_20260901130000/CREATED-missing-row'
FROM inventory_batches b
WHERE NOT EXISTS (SELECT 1 FROM inventory_items ii
                  WHERE ii.product_id = b.product_id AND ii.warehouse_id = b.warehouse_id)
  AND NOT EXISTS (SELECT 1 FROM inventory_counter_rebuild_audit a
                  WHERE a.product_id = b.product_id AND a.warehouse_id = b.warehouse_id
                    AND a.run_by = 'migration_20260901130000/CREATED-missing-row')
GROUP BY b.product_id, b.warehouse_id;

INSERT INTO inventory_items (tenant_id, product_id, variant_id, warehouse_id, quantity_on_hand)
SELECT b.tenant_id, b.product_id, MIN(b.variant_id::text)::uuid, b.warehouse_id, SUM(b.quantity_remaining)
FROM inventory_batches b
WHERE NOT EXISTS (SELECT 1 FROM inventory_items ii
                  WHERE ii.product_id = b.product_id AND ii.warehouse_id = b.warehouse_id)
GROUP BY b.tenant_id, b.product_id, b.warehouse_id;

-- 2b. Rebuild: set counter = batch truth where they differ (pairs WITH batches only).
WITH batch_truth AS (
  SELECT product_id, warehouse_id, SUM(quantity_remaining) AS q
  FROM inventory_batches
  GROUP BY product_id, warehouse_id
),
changed AS (
  SELECT ii.id, ii.product_id, ii.warehouse_id, ii.quantity_on_hand AS before_q,
         bt.q AS truth_q
  FROM inventory_items ii
  JOIN batch_truth bt ON bt.product_id = ii.product_id AND bt.warehouse_id = ii.warehouse_id
  WHERE ABS(ii.quantity_on_hand - bt.q) > 0.001
)
INSERT INTO inventory_counter_rebuild_audit
  (product_id, warehouse_id, counter_before, batch_truth, counter_after)
SELECT product_id, warehouse_id, before_q, truth_q, truth_q FROM changed;

UPDATE inventory_items ii
SET quantity_on_hand = bt.q,
    updated_at = now()
FROM (
  SELECT product_id, warehouse_id, SUM(quantity_remaining) AS q
  FROM inventory_batches
  GROUP BY product_id, warehouse_id
) bt
WHERE bt.product_id = ii.product_id
  AND bt.warehouse_id = ii.warehouse_id
  AND ABS(ii.quantity_on_hand - bt.q) > 0.001;

-- 3. Post-condition: zero drift for every pair that has batches.
DO $$
DECLARE
  v_drifted int;
  v_flagged int;
BEGIN
  SELECT COUNT(*) INTO v_drifted
  FROM inventory_items ii
  JOIN (SELECT product_id, warehouse_id, SUM(quantity_remaining) q
        FROM inventory_batches GROUP BY product_id, warehouse_id) bt
    ON bt.product_id = ii.product_id AND bt.warehouse_id = ii.warehouse_id
  WHERE ABS(ii.quantity_on_hand - bt.q) > 0.001;

  IF v_drifted <> 0 THEN
    RAISE EXCEPTION 'Post-condition failed: % pairs still drift from batch truth.', v_drifted;
  END IF;

  SELECT COUNT(*) INTO v_flagged
  FROM inventory_counter_rebuild_audit
  WHERE run_by LIKE '%FLAGGED-no-batches'
    AND run_at::date = CURRENT_DATE;

  RAISE NOTICE 'Counter rebuild complete: drifted pairs with batches = 0; % no-batch pair(s) flagged for owner decision.', v_flagged;
END $$;

COMMIT;
