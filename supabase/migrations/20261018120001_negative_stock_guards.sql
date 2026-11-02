-- 2026-10-18: Negative stock guards.
--
-- Stock goes negative through three paths:
--   1. consume_fifo writes a negative "IOU" batch (FIFO-SHORTFALL-...) whenever
--      a sale exceeds the FIFO ledger. That is deliberate (offline POS must be
--      able to sell), so it becomes a SETTING: app_settings 'inventory'
--      allow_oversell (default true). When false, a short sale RAISEs instead
--      of writing an IOU layer — the whole invoice insert rolls back.
--   2. deduct_stock_on_invoice_item (the on-hand counter trigger) decrements
--      with no floor and INSERTs a negative row when no counter exists yet.
--      The pre-FIFO version floored at 0 (GREATEST); that floor is restored.
--   3. sync_stock_transfer_create (offline replay of stock transfers)
--      decrements the source counter with no floor. Floored to match.
--
-- The setting key is merged into the existing 'inventory' settings row (if
-- present) so the toggle shows up in Settings > Inventory. Absent key or row
-- means "allowed" — current behavior, nothing breaks on deploy.

-- ---------------------------------------------------------------------------
-- 1) consume_fifo — full re-create of the live 20260914100000 version with
--    the allow_oversell guard. Only the IOU fallback block changes: when the
--    setting is off, a shortfall raises instead of writing negative stock.
-- ---------------------------------------------------------------------------
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
  v_allow_oversell boolean;
BEGIN
  -- Quick-sell (non-stock) products never consume batches: there is nothing
  -- to consume, and booking the shortfall as an IOU layer would fabricate
  -- negative phantom stock. The line's manually entered cost is final.
  IF NOT COALESCE((SELECT p.track_inventory FROM products p WHERE p.id = p_product_id), true) THEN
    RETURN;
  END IF;

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
  SELECT COALESCE(setting_value->>'batch_allocation_method', 'fifo'),
         COALESCE(setting_value->>'allow_oversell', 'true') = 'true'
    INTO v_strategy, v_allow_oversell
   FROM app_settings
  WHERE setting_key = 'inventory';
  v_strategy := COALESCE(v_strategy, 'fifo');
  v_allow_oversell := COALESCE(v_allow_oversell, true);

  -- Effective conversion factor of THIS item (sale units -> base units).
  SELECT CASE
           WHEN COALESCE(ii.quantity, 0) > 0 AND COALESCE(ii.base_quantity, 0) > 0
           THEN ii.base_quantity / ii.quantity
           ELSE 1
         END
    INTO v_cf
   FROM invoice_items ii
  WHERE ii.id = p_invoice_item_id;
  v_cf := COALESCE(NULLIF(v_cf, 0), 1);

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

    UPDATE inventory_batches
       SET quantity_remaining = quantity_remaining - v_consume
     WHERE id = v_batch.id;

    INSERT INTO invoice_item_batch_consumption (
      invoice_item_id, batch_id, product_id, warehouse_id,
      quantity_consumed, unit_cost, cogs_amount
    ) VALUES (
      p_invoice_item_id, v_batch.id, p_product_id, v_wh,
      v_consume, v_batch.unit_cost, v_cogs
    );

    v_remaining := v_remaining - v_consume;
  END LOOP;

  IF v_remaining > 0 THEN
    -- Oversell guard: when disabled, a sale beyond the ledger aborts the
    -- whole invoice insert (the trigger runs inside its transaction) instead
    -- of writing a negative IOU layer.
    IF NOT v_allow_oversell THEN
      RAISE EXCEPTION 'Insufficient stock: sale is short by % base unit(s) for product % in warehouse % (only % in the FIFO ledger). Enable "Allow selling beyond stock" in Settings > Inventory to permit overselling.',
        v_remaining,
        COALESCE((SELECT p.name FROM products p WHERE p.id = p_product_id), p_product_id::text),
        COALESCE((SELECT w.name FROM warehouses w WHERE w.id = v_wh), v_wh::text),
        GREATEST((SELECT COALESCE(SUM(quantity_remaining), 0) FROM inventory_batches
                   WHERE product_id = p_product_id AND warehouse_id = v_wh), 0);
    END IF;

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

  SELECT SUM(cogs_amount) / NULLIF(SUM(quantity_consumed), 0)
    INTO v_avg_base_cost
    FROM invoice_item_batch_consumption
   WHERE invoice_item_id = p_invoice_item_id;

  UPDATE invoice_items
     SET cost_price = COALESCE(v_avg_base_cost * v_cf, p_unit_cost)
   WHERE id = p_invoice_item_id;
END
$function$;

-- ---------------------------------------------------------------------------
-- 2) deduct_stock_on_invoice_item — full re-create of the live 20260914100000
--    version with the on-hand counter floored at 0. The pre-FIFO trigger
--    floored at 0 (GREATEST); the current one can drive the counter negative
--    and even INSERT a fresh row at a negative quantity. The FIFO ledger (and
--    its shortfall handling) remains the source of truth; the counter simply
--    refuses to display negative stock.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION deduct_stock_on_invoice_item()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_invoice_record RECORD;
  v_target_wh uuid;
  v_qty_to_deduct numeric;
  v_inv_id uuid;
  v_current_qty numeric;
  v_product_cost numeric;
BEGIN
  -- Quick-sell (non-stock) products carry no inventory counter and no stock
  -- movement; nothing to deduct.
  IF NOT COALESCE((SELECT p.track_inventory FROM products p WHERE p.id = NEW.product_id), true) THEN
    RETURN NEW;
  END IF;

  -- Get the invoice record
  SELECT * INTO v_invoice_record FROM invoices WHERE id = NEW.invoice_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- Skip if invoice is cancelled
  IF v_invoice_record.status = 'cancelled' THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM stock_movements
    WHERE reference_id = NEW.invoice_id
      AND reference_type = 'invoice'
      AND product_id = NEW.product_id
      AND movement_type = 'sale'
      AND notes LIKE '%invoice_item:' || NEW.id::text || '%'
  ) THEN
    RETURN NEW;
  END IF;

  v_qty_to_deduct := COALESCE(NEW.base_quantity, NEW.quantity);

  v_target_wh := NEW.warehouse_id;

  IF v_target_wh IS NULL THEN
    SELECT id INTO v_target_wh FROM warehouses WHERE is_default = true AND is_active = true LIMIT 1;
    IF v_target_wh IS NULL THEN
      SELECT id INTO v_target_wh FROM warehouses WHERE is_active = true LIMIT 1;
    END IF;
  END IF;

  IF v_target_wh IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT id, quantity_on_hand INTO v_inv_id, v_current_qty
  FROM inventory_items
  WHERE product_id = NEW.product_id AND warehouse_id = v_target_wh
  FOR UPDATE;

  IF v_inv_id IS NOT NULL THEN
    UPDATE inventory_items
    SET quantity_on_hand = GREATEST(0, quantity_on_hand - v_qty_to_deduct),
        updated_at = now()
    WHERE id = v_inv_id;
  ELSE
    -- No counter row yet: create it at zero rather than at a negative
    -- quantity — the shortfall is already tracked by the FIFO ledger.
    INSERT INTO inventory_items (product_id, warehouse_id, quantity_on_hand, quantity_reserved, quantity_incoming)
    VALUES (NEW.product_id, v_target_wh, 0, 0, 0);
  END IF;

  SELECT cost_price INTO v_product_cost FROM products WHERE id = NEW.product_id;

  INSERT INTO stock_movements (
    product_id, warehouse_id, movement_type, quantity,
    unit_cost, reference_type, reference_id, reference_number, notes
  ) VALUES (
    NEW.product_id, v_target_wh, 'sale', -v_qty_to_deduct,
    COALESCE(v_product_cost, 0), 'invoice', NEW.invoice_id,
    v_invoice_record.invoice_number,
    'Stock deduction for sale - invoice_item:' || NEW.id::text
  );

  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3) sync_stock_transfer_create — floor the source counter at 0. Offline
--    transfers replay without a prompt, so a transfer queued against stale
--    stock could previously drive the counter negative.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_stock_transfer_create(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id      uuid := (p_payload->>'id')::uuid;
  v_number  text := p_payload->>'transfer_number';
  v_product uuid := (p_payload->>'product_id')::uuid;
  v_from    uuid := (p_payload->>'from_warehouse_id')::uuid;
  v_to      uuid := (p_payload->>'to_warehouse_id')::uuid;
  v_qty     numeric := (p_payload->>'quantity')::numeric;
  v_cost    numeric := coalesce((p_payload->>'unit_cost')::numeric, 0);
  v_notes   text;
  v_inv_id  uuid;
BEGIN
  IF v_qty IS NULL OR v_qty <= 0 THEN
    RAISE EXCEPTION 'stock_transfer.create: quantity must be greater than 0';
  END IF;
  IF v_from = v_to THEN
    RAISE EXCEPTION 'stock_transfer.create: source and destination warehouse are the same';
  END IF;

  INSERT INTO stock_movements (tenant_id, product_id, warehouse_id, movement_type,
    quantity, unit_cost, reference_type, reference_id, reference_number, notes)
  VALUES ('00000000-0000-0000-0000-000000000001', v_product, v_from, 'transfer_out',
    -v_qty, v_cost, 'transfer', v_id, v_number,
    coalesce(nullif(p_payload->>'notes', ''), 'Transfer out'));

  INSERT INTO stock_movements (tenant_id, product_id, warehouse_id, movement_type,
    quantity, unit_cost, reference_type, reference_id, reference_number, notes)
  VALUES ('00000000-0000-0000-0000-000000000001', v_product, v_to, 'transfer_in',
    v_qty, v_cost, 'transfer', v_id, v_number,
    coalesce(nullif(p_payload->>'notes', ''), 'Transfer in'));

  PERFORM public.transfer_fifo_batches(v_product, v_from, v_to, v_qty, v_id, v_number);

  UPDATE inventory_items SET
    quantity_on_hand = GREATEST(0, quantity_on_hand - v_qty),
    updated_at = now()
  WHERE product_id = v_product AND warehouse_id = v_from;

  SELECT id INTO v_inv_id FROM inventory_items
  WHERE product_id = v_product AND warehouse_id = v_to LIMIT 1;
  IF v_inv_id IS NOT NULL THEN
    UPDATE inventory_items SET
      quantity_on_hand = quantity_on_hand + v_qty,
      updated_at = now()
    WHERE id = v_inv_id;
  ELSE
    INSERT INTO inventory_items (tenant_id, product_id, warehouse_id, quantity_on_hand)
    VALUES ('00000000-0000-0000-0000-000000000001', v_product, v_to, v_qty);
  END IF;

  RETURN jsonb_build_object('status', 'synced', 'transfer_id', v_id,
    'transfer_number', v_number);
END;
$$;

-- ---------------------------------------------------------------------------
-- 4) Surface the toggle: merge allow_oversell=true into the existing
--    'inventory' settings row so it appears in Settings > Inventory. Absent
--    row or key keeps the default (allowed) via the COALESCE in consume_fifo.
-- ---------------------------------------------------------------------------
UPDATE app_settings
   SET setting_value = setting_value || '{"allow_oversell": true}'::jsonb
 WHERE setting_key = 'inventory'
   AND NOT (setting_value ? 'allow_oversell');
