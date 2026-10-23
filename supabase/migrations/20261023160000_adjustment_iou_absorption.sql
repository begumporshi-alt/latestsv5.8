-- create_opening_batch (the product-edit stock-increase adjustment, CSV
-- import increase, and product-creation path) blind-inserted a positive
-- batch, so an oversell IOU layer (FIFO-SHORTFALL, batch_type 'adjustment')
-- survived beside it. The next GRN would then absorb the same IOU out of the
-- new receipt — a double-heal that permanently understated the ledger.
-- Heal the same way receive_grn does (migration 20261023140000): absorb the
-- new quantity into negative layers oldest-first, post the batch at net
-- quantity, and resync the on-hand counter from the ledger sum.
-- The journal stays on the paper quantity: the absorbed portion is itself a
-- value correction (the negative layer's value disappears), so
-- net-batch value + absorbed value = the original paper amount.

CREATE OR REPLACE FUNCTION public.create_opening_batch(
  p_product_id uuid,
  p_warehouse_id uuid,
  p_quantity numeric,
  p_unit_cost numeric,
  p_batch_type text DEFAULT 'opening'::text,
  p_reference_type text DEFAULT 'product_creation'::text,
  p_reference_id uuid DEFAULT NULL::uuid,
  p_notes text DEFAULT NULL::text,
  p_tenant_id uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid
) RETURNS uuid
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
  v_owed numeric;
  v_absorbed numeric;
  v_absorb_left numeric;
  v_take numeric;
  v_iou record;
  v_net_qty numeric;
  v_ledger_sum numeric;
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

  -- 2. Absorb oversell IOU layers (negative batches) before posting. The
  --    oldest IOU is covered first, exactly like receive_grn, so a receipt
  --    can never pay the same debt twice.
  v_net_qty := p_quantity;
  IF p_quantity > 0 THEN
    SELECT COALESCE(-SUM(quantity_remaining), 0) INTO v_owed
      FROM inventory_batches
     WHERE product_id = p_product_id AND warehouse_id = p_warehouse_id
       AND quantity_remaining < 0;
    v_absorbed := LEAST(v_owed, p_quantity);
    v_net_qty := p_quantity - v_absorbed;
    IF v_absorbed > 0 THEN
      v_absorb_left := v_absorbed;
      FOR v_iou IN
        SELECT id, quantity_remaining
          FROM inventory_batches
         WHERE product_id = p_product_id AND warehouse_id = p_warehouse_id
           AND quantity_remaining < 0
         ORDER BY created_at ASC, id ASC
         FOR UPDATE
      LOOP
        EXIT WHEN v_absorb_left <= 0;
        v_take := LEAST(-v_iou.quantity_remaining, v_absorb_left);
        UPDATE inventory_batches
           SET quantity_remaining = quantity_remaining + v_take
         WHERE id = v_iou.id;
        v_absorb_left := v_absorb_left - v_take;
      END LOOP;
    END IF;
  END IF;

  -- 3. Insert the inventory batch at the NET quantity (what the frontend
  --    expects back as the batch id).
  INSERT INTO inventory_batches (
    tenant_id, product_id, warehouse_id, batch_number,
    quantity_received, quantity_remaining, unit_cost,
    batch_type, reference_type, reference_id, notes, created_at
  ) VALUES (
    p_tenant_id, p_product_id, p_warehouse_id, v_batch_number,
    v_net_qty, v_net_qty, p_unit_cost,
    p_batch_type, p_reference_type, p_reference_id, p_notes, CURRENT_DATE
  ) RETURNING id INTO v_batch_id;

  -- 4. On-hand counter: resync from the batch ledger (source of truth),
  --    same as receive_grn. The caller's blind counter write (user-typed
  --    target) is replaced by ledger truth — with healing, the first units
  --    of an adjustment cover the hidden IOU debt the floored counter
  --    never showed.
  SELECT COALESCE(SUM(quantity_remaining), 0) INTO v_ledger_sum
    FROM inventory_batches
   WHERE product_id = p_product_id AND warehouse_id = p_warehouse_id;

  UPDATE inventory_items
     SET quantity_on_hand = v_ledger_sum, updated_at = now()
   WHERE product_id = p_product_id AND warehouse_id = p_warehouse_id;
  IF NOT FOUND THEN
    INSERT INTO inventory_items (tenant_id, product_id, warehouse_id, quantity_on_hand)
    VALUES (p_tenant_id, p_product_id, p_warehouse_id, v_ledger_sum);
  END IF;

  -- 5. Post journal entry: Dr 1200 / Cr 3900 for BOTH opening and
  --    adjustment batches. Quantity corrections are equity, not P&L
  --    variance (owner decision 2026-09-07); account 5900 is legacy with
  --    no writers since this migration. Amount stays on the paper
  --    quantity — the absorbed IOU value is part of that correction.
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
