-- 2026-09-01: Make stock-reduction GL batch-accurate.
--
-- create_stock_reduction posted its journal entry at p_quantity x p_unit_cost
-- (the ratcheted products.cost_price) while consuming FIFO layers at their
-- historical layer costs — every reduction on older/cheaper layers drifted GL
-- 1200 vs the batch ledger by (cost_price - layer_cost) x qty. Today's live
-- cleanup session surfaced it (e.g. a 1-unit layer @ 23.04-23.02 vs JE @ 25.04).
--
-- The journal now posts at the value ACTUALLY consumed: sum of (qty x layer
-- unit_cost) plus any uncovered shortfall at the passed cost.

BEGIN;

CREATE OR REPLACE FUNCTION public.create_stock_reduction(p_product_id uuid, p_warehouse_id uuid, p_quantity numeric, p_unit_cost numeric, p_reference_type text DEFAULT 'stock_adjustment'::text, p_reference_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT 'Stock decrease adjustment'::text, p_tenant_id uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_remaining_qty numeric := p_quantity;
  v_reduce_qty numeric;
  v_batch_cost numeric;
  v_consumed_value numeric := 0;
  v_batch_id uuid;
  v_audit_batch_id uuid;
  -- journal amount is finalized after consumption: the real layer value
  -- consumed plus any shortfall at the passed cost (batch-accurate GL).
  v_amount numeric := 0;
  v_account_1200 uuid;
  v_account_5900 uuid;
  v_product_name text;
  v_product_sku text;
  v_warehouse_name text;
  v_header text;
BEGIN
  IF p_quantity <= 0 THEN
    RETURN NULL;
  END IF;

  -- Lookup product + warehouse for human-readable journal descriptions
  SELECT name, sku INTO v_product_name, v_product_sku
    FROM products WHERE id = p_product_id;
  SELECT name INTO v_warehouse_name FROM warehouses WHERE id = p_warehouse_id;

  v_product_name := COALESCE(v_product_name, 'Unknown Product');
  v_product_sku := COALESCE(v_product_sku, 'N/A');
  v_warehouse_name := COALESCE(v_warehouse_name, 'Unknown Warehouse');

  -- 1. Reduce quantity_remaining from oldest batches first (FIFO)
  v_consumed_value := 0;
  FOR v_batch_id, v_batch_cost IN
    SELECT ib.id, ib.unit_cost
    FROM inventory_batches ib
    WHERE ib.product_id = p_product_id
      AND ib.warehouse_id = p_warehouse_id
      AND ib.quantity_remaining > 0
    ORDER BY ib.created_at ASC, ib.id ASC
    FOR UPDATE
  LOOP
    EXIT WHEN v_remaining_qty <= 0;

    -- Only consume what this batch actually holds (and never more than remaining)
    SELECT LEAST(quantity_remaining, v_remaining_qty)
      INTO v_reduce_qty
      FROM inventory_batches WHERE id = v_batch_id;

    UPDATE inventory_batches
    SET quantity_remaining = quantity_remaining - v_reduce_qty
    WHERE id = v_batch_id;

    v_consumed_value := v_consumed_value + (v_reduce_qty * v_batch_cost);
    v_remaining_qty := v_remaining_qty - v_reduce_qty;
  END LOOP;

  -- 2. Insert a reduction batch ONLY for the shortfall the real layers could
  --    not cover (an over-reduction IOU). A fully-covered reduction is already
  --    recorded by the layer consumption + stock movement + journal entry —
  --    adding a full-qty audit row here double-subtracted the batch ledger
  --    against the GL whenever real stock was consumed (bug fixed 2026-09-01).
  IF v_remaining_qty > 0 THEN
    INSERT INTO inventory_batches (
      tenant_id, product_id, warehouse_id, batch_number,
      quantity_received, quantity_remaining, unit_cost,
      batch_type, reference_type, reference_id, notes, created_at
    ) VALUES (
      p_tenant_id, p_product_id, p_warehouse_id,
      'REDUCE-' || to_char(CURRENT_DATE, 'YYYYMMDD') || '-' || substring(p_product_id::text, 1, 8),
      0, -v_remaining_qty, p_unit_cost,
      'adjustment', p_reference_type, p_reference_id, p_notes, CURRENT_DATE
    ) RETURNING id INTO v_audit_batch_id;
  END IF;

  -- 3. Post journal entry: Dr 5900 / Cr 1200 at the value actually consumed
  --    (layer costs), plus any uncovered shortfall at the passed cost.
  v_amount := ROUND(v_consumed_value + (v_remaining_qty * p_unit_cost), 2);
  IF v_amount > 0 THEN
    SELECT id INTO v_account_1200 FROM accounts
      WHERE code = '1200' AND tenant_id = p_tenant_id;
    SELECT id INTO v_account_5900 FROM accounts
      WHERE code = '5900' AND tenant_id = p_tenant_id;

    IF v_account_1200 IS NOT NULL AND v_account_5900 IS NOT NULL THEN
      v_header := 'Stock reduction - ' || v_product_name || ' (' || v_product_sku || '): '
        || p_quantity || ' @ ' || p_unit_cost || ' in ' || v_warehouse_name;

      PERFORM post_journal_entry(
        p_description := v_header,
        p_entry_date := CURRENT_DATE,
        p_reference_type := p_reference_type,
        p_reference_id := p_reference_id,
        p_lines := json_build_array(
          json_build_object(
            'account_id', v_account_5900,
            'debit', v_amount,
            'description', 'Inventory reduction: ' || v_product_name || ' (' || v_product_sku || ') in ' || v_warehouse_name
          ),
          json_build_object(
            'account_id', v_account_1200,
            'credit', v_amount,
            'description', 'Inventory released (FIFO layers depleted): ' || v_product_name
          )
        )
      );
    ELSE
      RAISE WARNING 'Accounts 1200 or 5900 missing for tenant %; batch % created without GL entry',
        p_tenant_id, v_audit_batch_id;
    END IF;
  END IF;

  RETURN v_audit_batch_id;
END;
$function$;



COMMIT;
