-- 2026-09-07 (stock corrections out of the P&L — part 2 of 2)
--
-- Reroute FUTURE stock adjustments and reductions away from P&L account
-- 5900 (Inventory Adjustment) into Opening Balance Equity (3900), so
-- quantity corrections never distort monthly P&Ls again.
--
-- OWNER DECISION 2026-09-07
--   Stock adjustments in this business are quantity corrections (mistaken
--   increases/decreases), not income or expenses. Part 1
--   (20260907150000) moved the Aug 28 - Sep 6 cleanup batch to 3900
--   per-date; this migration makes the routing permanent:
--     create_opening_batch(p_batch_type => 'adjustment'): Dr 1200 / Cr 5900  ->  Dr 1200 / Cr 3900
--     create_stock_reduction:                             Dr 5900 / Cr 1200  ->  Dr 3900 / Cr 1200
--   Account 5900 remains in the chart (system-locked) but has no writers
--   after this point. Genuine damage/theft should be booked as a manual
--   journal entry to an expense account from the Journal page.
--
--   Definitions below are the live versions (verified 2026-09-07 via
--   pg_get_functiondef) with only the routing changed. Signatures are
--   unchanged, so CREATE OR REPLACE applies cleanly with no overloads.

CREATE OR REPLACE FUNCTION public.create_opening_batch(p_product_id uuid, p_warehouse_id uuid, p_quantity numeric, p_unit_cost numeric, p_batch_type text DEFAULT 'opening'::text, p_reference_type text DEFAULT 'product_creation'::text, p_reference_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text, p_tenant_id uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_batch_id uuid;
  v_amount numeric := ROUND(p_quantity * p_unit_cost, 2);
  v_account_1200 uuid;
  v_account_3900 uuid;
  v_batch_number text;
  v_credit_account_id uuid;
  v_credit_desc text;
  v_product_name text;
  v_product_sku text;
  v_warehouse_name text;
  v_header text;
BEGIN
  -- Lookup product + warehouse for human-readable journal descriptions
  SELECT name, sku INTO v_product_name, v_product_sku
    FROM products WHERE id = p_product_id;
  SELECT name INTO v_warehouse_name FROM warehouses WHERE id = p_warehouse_id;

  v_product_name := COALESCE(v_product_name, 'Unknown Product');
  v_product_sku := COALESCE(v_product_sku, 'N/A');
  v_warehouse_name := COALESCE(v_warehouse_name, 'Unknown Warehouse');

  -- 1. Generate a batch number for traceability
  v_batch_number := UPPER(COALESCE(p_batch_type, 'OPENING')) || '-' ||
                    to_char(CURRENT_DATE, 'YYYYMMDD') || '-' ||
                    substring(p_product_id::text, 1, 8);

  -- 2. Insert the inventory batch (what frontend expects)
  INSERT INTO inventory_batches (
    tenant_id, product_id, warehouse_id, batch_number,
    quantity_received, quantity_remaining, unit_cost,
    batch_type, reference_type, reference_id, notes, created_at
  ) VALUES (
    p_tenant_id, p_product_id, p_warehouse_id, v_batch_number,
    p_quantity, p_quantity, p_unit_cost,
    p_batch_type, p_reference_type, p_reference_id, p_notes, CURRENT_DATE
  ) RETURNING id INTO v_batch_id;

  -- 3. Post journal entry: Dr 1200 / Cr 3900 for BOTH opening and
  --    adjustment batches. Quantity corrections are equity, not P&L
  --    variance (owner decision 2026-09-07); account 5900 is legacy with
  --    no writers since this migration.
  IF v_amount > 0 THEN
    SELECT id INTO v_account_1200 FROM accounts
      WHERE code = '1200' AND tenant_id = p_tenant_id;

    IF v_account_1200 IS NULL THEN
      RAISE WARNING 'Account 1200 missing for tenant %; batch % created without GL entry',
        p_tenant_id, v_batch_id;
      RETURN v_batch_id;
    END IF;

    SELECT id INTO v_account_3900 FROM accounts
      WHERE code = '3900' AND tenant_id = p_tenant_id;
    IF v_account_3900 IS NULL THEN
      RAISE WARNING 'Account 3900 missing for tenant %; batch % created without GL entry',
        p_tenant_id, v_batch_id;
      RETURN v_batch_id;
    END IF;
    v_credit_account_id := v_account_3900;

    IF p_batch_type = 'opening' THEN
      v_credit_desc := 'Opening balance equity offset';
      v_header := 'Opening stock';
    ELSE
      v_credit_desc := 'Opening Balance Equity (quantity correction)';
      v_header := 'Stock adjustment';
    END IF;

    -- Human-readable description: "Stock adjustment - test20 (test-0020): 5 @ 2.00 in Main Warehouse"
    v_header := v_header || ' - ' || v_product_name || ' (' || v_product_sku || '): '
      || p_quantity || ' @ ' || p_unit_cost || ' in ' || v_warehouse_name;

    PERFORM post_journal_entry(
      p_description := v_header,
      p_entry_date := CURRENT_DATE,
      p_reference_type := p_reference_type,
      p_reference_id := p_reference_id,
      p_lines := json_build_array(
        json_build_object(
          'account_id', v_account_1200,
          'debit', v_amount,
          'description', 'Inventory received: ' || v_product_name || ' (' || v_product_sku || ') in ' || v_warehouse_name
        ),
        json_build_object(
          'account_id', v_credit_account_id,
          'credit', v_amount,
          'description', v_credit_desc
        )
      )
    );
  END IF;

  RETURN v_batch_id;
END;
$function$;

COMMENT ON FUNCTION create_opening_batch IS
  'Creates an inventory_batches row and posts a journal entry. Both opening and adjustment batches post Dr 1200 / Cr 3900 (Opening Balance Equity) — quantity corrections are equity, not P&L variance (owner decision 2026-09-07). Journal descriptions include product name + SKU + qty + warehouse.';

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
  v_account_3900 uuid;
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

  -- 3. Post journal entry: Dr 3900 / Cr 1200 at the value actually consumed
  --    (layer costs), plus any uncovered shortfall at the passed cost.
  --    Quantity corrections are equity, not P&L expense (owner decision
  --    2026-09-07); account 5900 is legacy with no writers since this
  --    migration.
  v_amount := ROUND(v_consumed_value + (v_remaining_qty * p_unit_cost), 2);
  IF v_amount > 0 THEN
    SELECT id INTO v_account_1200 FROM accounts
      WHERE code = '1200' AND tenant_id = p_tenant_id;
    SELECT id INTO v_account_3900 FROM accounts
      WHERE code = '3900' AND tenant_id = p_tenant_id;

    IF v_account_1200 IS NOT NULL AND v_account_3900 IS NOT NULL THEN
      v_header := 'Stock reduction - ' || v_product_name || ' (' || v_product_sku || '): '
        || p_quantity || ' @ ' || p_unit_cost || ' in ' || v_warehouse_name;

      PERFORM post_journal_entry(
        p_description := v_header,
        p_entry_date := CURRENT_DATE,
        p_reference_type := p_reference_type,
        p_reference_id := p_reference_id,
        p_lines := json_build_array(
          json_build_object(
            'account_id', v_account_3900,
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
      RAISE WARNING 'Accounts 1200 or 3900 missing for tenant %; batch % created without GL entry',
        p_tenant_id, v_audit_batch_id;
    END IF;
  END IF;

  RETURN v_audit_batch_id;
END;
$function$;

COMMENT ON FUNCTION create_stock_reduction IS
  'Reduces inventory from oldest batches (FIFO) and posts a Dr 3900 / Cr 1200 journal entry for stock decreases — quantity corrections are equity, not P&L expense (owner decision 2026-09-07). Journal descriptions include product name + SKU + qty + warehouse.';

GRANT EXECUTE ON FUNCTION create_opening_batch(uuid, uuid, numeric, numeric, text, text, uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION create_stock_reduction(uuid, uuid, numeric, numeric, text, uuid, text, uuid) TO authenticated;
