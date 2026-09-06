-- POS automatic batch allocation: strategy-aware FIFO/FEFO consumption.
--
-- The POS now previews a batch allocation (lib/batch-allocation.ts) computed
-- from inventory_batches directly; this migration makes the backend
-- consume_fifo consume in the SAME order the preview shows, so what the
-- cashier sees is what the database deducts:
--
--   1. inventory_batches.expiry_date (nullable) — expiry tracking without
--      touching any existing row; NULL expiry sorts last under FEFO.
--   2. app_settings 'inventory' key — batch_allocation_method ('fifo' |
--      'fefo') and allow_partial_add (POS insufficient-stock dialog).
--   3. consume_fifo reads the strategy itself (no signature change, so the
--      item-insert and status-change triggers stay untouched):
--        fifo → created_at ASC
--        fefo → expiry_date ASC NULLS LAST, then created_at ASC
--      with id as the deterministic tiebreaker — batches inserted in one
--      transaction share the same now() timestamp, so created_at alone is
--      ambiguous. Expired batches (expiry_date < today) are never consumed.
--
-- Everything else (idempotency guard, scale-aware IOU fallback, per-sale-unit
-- cost_price rewrite) is preserved verbatim from
-- 20260902090000_fix_multi_unit_fifo_cost_scale.sql.

BEGIN;

-- 1) Expiry tracking on batches (nullable; FEFO sorts NULLs last)
ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS expiry_date date;

-- 2) Inventory settings (POS + consume_fifo both read this key)
INSERT INTO app_settings (setting_key, setting_value)
VALUES ('inventory', jsonb_build_object(
  'batch_allocation_method', 'fifo',
  'allow_partial_add', true
))
ON CONFLICT (setting_key) DO NOTHING;

-- 3) Strategy-aware consume_fifo
CREATE OR REPLACE FUNCTION public.consume_fifo(p_invoice_item_id uuid, p_product_id uuid, p_warehouse_id uuid, p_quantity numeric, p_unit_cost numeric)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_remaining numeric := p_quantity;
  v_batch record;
  v_consume numeric;
  v_wh uuid;
  v_cogs numeric;
  v_cf numeric;
  v_fallback_base_cost numeric;
  v_avg_base_cost numeric;
  v_strategy text;
BEGIN
  -- If warehouse_id is NULL, find default warehouse
  v_wh := COALESCE(p_warehouse_id, (
    SELECT id FROM warehouses WHERE is_default = true AND is_active = true LIMIT 1
  ));

  IF v_wh IS NULL THEN
    RAISE WARNING 'consume_fifo: No warehouse found for product %', p_product_id;
    RETURN;
  END IF;

  -- Check if already consumed (idempotency guard)
  IF EXISTS (SELECT 1 FROM invoice_item_batch_consumption WHERE invoice_item_id = p_invoice_item_id) THEN
    RETURN;
  END IF;

  -- Allocation strategy: 'fefo' consumes earliest-expiry batches first,
  -- 'fifo' (default) consumes oldest stock first. Read from the shared
  -- inventory settings key so POS preview and backend deduction agree.
  SELECT COALESCE(setting_value->>'batch_allocation_method', 'fifo')
    INTO v_strategy
    FROM app_settings
   WHERE setting_key = 'inventory';
  v_strategy := COALESCE(v_strategy, 'fifo');

  -- Effective conversion factor of THIS item (sale units -> base units).
  -- invoice_items.cost_price / unit_price are per SALE unit (guarded by
  -- check_invoice_item_cost_scale); inventory_batches and
  -- invoice_item_batch_consumption are per BASE unit. Every scale
  -- conversion below goes through v_cf.
  SELECT CASE
           WHEN COALESCE(ii.quantity, 0) > 0 AND COALESCE(ii.base_quantity, 0) > 0
           THEN ii.base_quantity / ii.quantity
           ELSE 1
         END
    INTO v_cf
    FROM invoice_items ii
   WHERE ii.id = p_invoice_item_id;
  v_cf := COALESCE(NULLIF(v_cf, 0), 1);

  -- Consume in strategy order. Expired batches are never consumed; batches
  -- without an expiry are always eligible. Under fifo the expiry CASE
  -- collapses to a constant (all NULL) and created_at alone decides; under
  -- fefo expiry_date ASC NULLS LAST leads. id breaks created_at ties.
  FOR v_batch IN
    SELECT id, quantity_remaining, unit_cost
      FROM inventory_batches
     WHERE product_id = p_product_id
       AND warehouse_id = v_wh
       AND quantity_remaining > 0
       AND (expiry_date IS NULL OR expiry_date >= CURRENT_DATE)
     ORDER BY
       CASE WHEN v_strategy = 'fefo' THEN expiry_date END ASC NULLS LAST,
       created_at ASC,
       id ASC
  LOOP
    EXIT WHEN v_remaining <= 0;

    v_consume := LEAST(v_remaining, v_batch.quantity_remaining);
    v_cogs := v_consume * v_batch.unit_cost;

    -- Update batch remaining
    UPDATE inventory_batches
       SET quantity_remaining = quantity_remaining - v_consume
     WHERE id = v_batch.id;

    -- Record consumption
    INSERT INTO invoice_item_batch_consumption (
      invoice_item_id, batch_id, product_id, warehouse_id,
      quantity_consumed, unit_cost, cogs_amount
    ) VALUES (
      p_invoice_item_id, v_batch.id, p_product_id, v_wh,
      v_consume, v_batch.unit_cost, v_cogs
    );

    v_remaining := v_remaining - v_consume;
  END LOOP;

  -- If still remaining (sold beyond available batches): book the shortfall
  -- as a negative IOU layer at BASE-unit cost (same convention as
  -- create_stock_reduction), so the batch ledger, the inventory counter and
  -- GL 1200 stay mutually reconciled.
  IF v_remaining > 0 THEN
    DECLARE
      v_fallback_id uuid;
    BEGIN
      v_fallback_base_cost := p_unit_cost / v_cf;

      INSERT INTO inventory_batches (
        product_id, warehouse_id, batch_number, quantity_received,
        quantity_remaining, unit_cost, batch_type, notes
      ) VALUES (
        p_product_id, v_wh, 'FIFO-SHORTFALL-' || substr(p_product_id::text, 1, 8),
        0, -v_remaining, v_fallback_base_cost, 'adjustment',
        'consume_fifo shortfall IOU: sold beyond available batches (invoice_item ' || p_invoice_item_id::text || ')'
      ) RETURNING id INTO v_fallback_id;

      INSERT INTO invoice_item_batch_consumption (
        invoice_item_id, batch_id, product_id, warehouse_id,
        quantity_consumed, unit_cost, cogs_amount
      ) VALUES (
        p_invoice_item_id, v_fallback_id, p_product_id, v_wh,
        v_remaining, v_fallback_base_cost, v_remaining * v_fallback_base_cost
      );
    END;
  END IF;

  -- Update invoice_items.cost_price to the FIFO average, expressed per SALE
  -- unit (base-unit average x conversion factor) so the scale guard passes
  -- and COGS-per-sale-unit reads correctly.
  SELECT SUM(cogs_amount) / NULLIF(SUM(quantity_consumed), 0)
    INTO v_avg_base_cost
    FROM invoice_item_batch_consumption
   WHERE invoice_item_id = p_invoice_item_id;

  UPDATE invoice_items
     SET cost_price = COALESCE(v_avg_base_cost * v_cf, p_unit_cost)
   WHERE id = p_invoice_item_id;
END
$function$;

COMMIT;
