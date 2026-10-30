-- 2026-10-30: Route stock WRITE-OFFS to P&L (5900), keep corrections on 3900.
--
-- The 2026-09-07 owner decision sent all stock reductions to 3900 Opening
-- Balance Equity because they were quantity corrections (mistakes), not
-- losses. A write-off is a different event: the goods are gone, so the value
-- is an expense, not a correction of opening equity. Rather than change the
-- policy for everyone, create_stock_reduction() now takes the debit account
-- as a parameter (default '3900', so sync_product_update and any other caller
-- behave exactly as before) and write_off_product_stock() passes '5900'.
--
-- Signature change note: adding a parameter with a default creates a NEW
-- overload in Postgres rather than replacing the old one, so the 8-argument
-- version is dropped first. Callers passing fewer positional arguments still
-- resolve — sync_product_update passes 7 — because the trailing parameters
-- are defaulted.

BEGIN;

DROP FUNCTION IF EXISTS public.create_stock_reduction(uuid, uuid, numeric, numeric, text, uuid, text, uuid);

CREATE OR REPLACE FUNCTION public.create_stock_reduction(
  p_product_id uuid,
  p_warehouse_id uuid,
  p_quantity numeric,
  p_unit_cost numeric,
  p_reference_type text DEFAULT 'stock_adjustment'::text,
  p_reference_id uuid DEFAULT NULL::uuid,
  p_notes text DEFAULT 'Stock decrease adjustment'::text,
  p_tenant_id uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
  p_debit_account_code text DEFAULT '3900'::text
)
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
  v_debit_account uuid;
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

  -- 3. Post journal entry at the value actually consumed (layer costs), plus
  --    any uncovered shortfall at the passed cost. The debit account is the
  --    caller's choice: 3900 for quantity corrections (owner decision
  --    2026-09-07), 5900 Inventory Adjustment for genuine losses such as a
  --    write-off.
  v_amount := ROUND(v_consumed_value + (v_remaining_qty * p_unit_cost), 2);
  IF v_amount > 0 THEN
    SELECT id INTO v_account_1200 FROM accounts
      WHERE code = '1200' AND tenant_id = p_tenant_id;
    SELECT id INTO v_debit_account FROM accounts
      WHERE code = p_debit_account_code AND tenant_id = p_tenant_id;

    IF v_account_1200 IS NOT NULL AND v_debit_account IS NOT NULL THEN
      v_header := 'Stock reduction - ' || v_product_name || ' (' || v_product_sku || '): '
        || p_quantity || ' @ ' || p_unit_cost || ' in ' || v_warehouse_name;

      PERFORM post_journal_entry(
        p_description := v_header,
        p_entry_date := CURRENT_DATE,
        p_reference_type := p_reference_type,
        p_reference_id := p_reference_id,
        p_lines := json_build_array(
          json_build_object(
            'account_id', v_debit_account,
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
      RAISE WARNING 'Accounts 1200 or % missing for tenant %; batch % created without GL entry',
        p_debit_account_code, p_tenant_id, v_audit_batch_id;
    END IF;
  END IF;

  PERFORM heal_negative_batches_and_resync(p_product_id, p_warehouse_id);

  RETURN v_audit_batch_id;
END;
$function$;

ALTER FUNCTION public.create_stock_reduction(uuid, uuid, numeric, numeric, text, uuid, text, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.create_stock_reduction(uuid, uuid, numeric, numeric, text, uuid, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_stock_reduction(uuid, uuid, numeric, numeric, text, uuid, text, uuid, text) TO authenticated;

COMMENT ON FUNCTION public.create_stock_reduction IS
  'Consumes FIFO layers oldest-first and posts the layer-accurate journal entry. p_debit_account_code defaults to 3900 (Opening Balance Equity, quantity corrections); pass 5900 for genuine losses such as stock write-offs.';

-- ---------------------------------------------------------------------------
-- write_off_product_stock now books to 5900 instead of 3900.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION write_off_product_stock(
  p_product_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_tenant_id uuid;
  v_product_name text;
  v_product_sku text;
  v_cost_price numeric;
  v_notes text;
  v_ref_number text;
  v_pair RECORD;
  v_pair_count integer := 0;
  v_total_qty numeric := 0;
  v_total_layers numeric := 0;
  v_pairs jsonb := '[]'::jsonb;
BEGIN
  SELECT tenant_id, name, sku, COALESCE(cost_price, 0)
    INTO v_tenant_id, v_product_name, v_product_sku, v_cost_price
  FROM products
  WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product % not found', p_product_id;
  END IF;

  v_notes := 'Stock write-off'
    || CASE WHEN p_reason IS NULL OR btrim(p_reason) = '' THEN '' ELSE ' — ' || btrim(p_reason) END;
  v_ref_number := 'WO-' || to_char(CURRENT_DATE, 'YYYYMMDD') || '-' || COALESCE(v_product_sku, substring(p_product_id::text, 1, 8));

  FOR v_pair IN
    WITH onhand AS (
      SELECT warehouse_id, SUM(quantity_on_hand)::numeric AS q
      FROM inventory_items
      WHERE product_id = p_product_id
      GROUP BY warehouse_id
    ), layers AS (
      SELECT warehouse_id, SUM(quantity_remaining)::numeric AS q
      FROM inventory_batches
      WHERE product_id = p_product_id
        AND quantity_remaining > 0
      GROUP BY warehouse_id
    ), pairs AS (
      SELECT warehouse_id FROM onhand WHERE q <> 0
      UNION
      SELECT warehouse_id FROM layers WHERE q > 0
    )
    SELECT pr.warehouse_id,
           GREATEST(COALESCE(o.q, 0), 0) AS on_hand,
           COALESCE(l.q, 0) AS layer_qty
    FROM pairs pr
    LEFT JOIN onhand o ON o.warehouse_id = pr.warehouse_id
    LEFT JOIN layers l ON l.warehouse_id = pr.warehouse_id
    WHERE GREATEST(COALESCE(o.q, 0), 0) > 0 OR COALESCE(l.q, 0) > 0
    ORDER BY pr.warehouse_id
  LOOP
    -- Consume the positive layers exactly; no shortfall => no IOU batch.
    -- 5900 = Inventory Adjustment: a write-off is a loss, not a correction.
    IF v_pair.layer_qty > 0 THEN
      PERFORM create_stock_reduction(
        p_product_id         => p_product_id,
        p_warehouse_id       => v_pair.warehouse_id,
        p_quantity           => v_pair.layer_qty,
        p_unit_cost          => v_cost_price,
        p_reference_type     => 'stock_writeoff',
        p_reference_id       => p_product_id,
        p_notes              => v_notes,
        p_tenant_id          => v_tenant_id,
        p_debit_account_code => '5900'
      );
    END IF;

    UPDATE inventory_items
    SET quantity_on_hand = 0,
        updated_at = now()
    WHERE product_id = p_product_id
      AND warehouse_id = v_pair.warehouse_id
      AND quantity_on_hand <> 0;

    INSERT INTO stock_movements (
      tenant_id, product_id, warehouse_id, movement_type, quantity,
      unit_cost, reference_type, reference_id, reference_number, notes, created_at
    ) VALUES (
      v_tenant_id, p_product_id, v_pair.warehouse_id, 'adjustment',
      -GREATEST(v_pair.on_hand, v_pair.layer_qty),
      v_cost_price, 'stock_writeoff', p_product_id, v_ref_number, v_notes, now()
    );

    v_pair_count := v_pair_count + 1;
    v_total_qty := v_total_qty + GREATEST(v_pair.on_hand, v_pair.layer_qty);
    v_total_layers := v_total_layers + v_pair.layer_qty;
    v_pairs := v_pairs || jsonb_build_object(
      'warehouse_id', v_pair.warehouse_id,
      'on_hand', v_pair.on_hand,
      'layer_quantity', v_pair.layer_qty
    );
  END LOOP;

  RETURN jsonb_build_object(
    'product_id', p_product_id,
    'product_name', v_product_name,
    'warehouse_count', v_pair_count,
    'quantity', v_total_qty,
    'layer_quantity', v_total_layers,
    'warehouses', v_pairs
  );
END;
$function$;

ALTER FUNCTION write_off_product_stock(uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION write_off_product_stock(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION write_off_product_stock(uuid, text) TO authenticated;

COMMIT;
