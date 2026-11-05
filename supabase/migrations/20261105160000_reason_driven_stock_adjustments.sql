-- ============================================================================
-- Reason-driven stock adjustments and write-offs.
--
-- WHY
--   The product modal used to mix catalogue edits with stock corrections, and
--   the only write-off path targeted inactive products and always removed ALL
--   remaining stock. This adds one atomic adjustment operation that records a
--   required reason and routes it to the right ledger treatment:
--
--     quantity_correction                -> Inventory 1200 <-> Opening Balance Equity 3900
--     damaged/stolen/expired/destroyed/
--     obsolete                           -> Dr Inventory Adjustment 5900 / Cr Inventory 1200
--
--   Real losses may only reduce stock and may never create a new negative IOU
--   layer. Quantity corrections keep the existing reduction/IOU semantics.
--   FIFO valuation and negative-layer healing stay inside the existing
--   create_opening_batch / create_stock_reduction helpers.
--
-- ATOMICITY / IDEMPOTENCY
--   One call handles every warehouse, both stock_movements rows and the GL, in
--   one implicit transaction. A conflict is decided BEFORE any write; any
--   helper error rolls the whole request back. The payload id is stored as the
--   reference_id on movements and journals, so a retry sees existing rows and
--   returns duplicate without writing again.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.sync_stock_adjustment(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_op_id        uuid;
  v_pid          uuid;
  v_reason       text;
  v_details      text;
  v_tenant       uuid;
  v_cost         numeric;
  v_product_name text;
  v_sku          text;
  v_tracks       boolean;
  v_is_loss      boolean;
  v_seen_warehouse uuid[] := ARRAY[]::uuid[];
  v_item         jsonb;
  v_items        jsonb := '[]'::jsonb;
  v_current      jsonb := '[]'::jsonb;
  v_wh           uuid;
  v_delta        numeric;
  v_expected     numeric;
  v_on_hand      numeric;
  v_ledger       numeric;
  v_ledger_after numeric;
  v_note         text;
  v_debit_code   text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'sync_stock_adjustment requires an authenticated session';
  END IF;

  v_op_id := nullif(p_payload->>'id', '')::uuid;
  v_pid := nullif(p_payload->>'product_id', '')::uuid;
  v_reason := nullif(p_payload->>'reason_code', '');
  v_details := nullif(p_payload->>'reason_details', '');

  IF v_op_id IS NULL OR v_pid IS NULL THEN
    RAISE EXCEPTION 'stock adjustment requires id and product_id';
  END IF;

  IF v_reason NOT IN ('quantity_correction', 'damaged', 'stolen', 'expired', 'destroyed', 'obsolete') THEN
    RAISE EXCEPTION 'unknown stock adjustment reason: %', v_reason;
  END IF;
  v_is_loss := v_reason <> 'quantity_correction';
  v_debit_code := CASE WHEN v_is_loss THEN '5900' ELSE '3900' END;

  IF jsonb_typeof(COALESCE(p_payload->'items', 'null'::jsonb)) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_payload->'items') = 0 THEN
    RAISE EXCEPTION 'stock adjustment requires at least one warehouse item';
  END IF;

  -- Lock the product first: no caller may choose the tenant or the valuation
  -- cost. An inactive product can still be adjusted; a non-stock product
  -- cannot.
  SELECT p.tenant_id, p.cost_price, p.name, p.sku, p.track_inventory
    INTO v_tenant, v_cost, v_product_name, v_sku, v_tracks
  FROM products p
  WHERE p.id = v_pid
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'product not found: %', v_pid;
  END IF;
  IF NOT v_tracks THEN
    RAISE EXCEPTION 'product % does not track inventory', v_product_name;
  END IF;

  -- A completed retry must be a no-op. reference_id is the operation UUID on
  -- both the movement rows and the journals the helpers post.
  IF EXISTS (
    SELECT 1 FROM stock_movements
    WHERE reference_type = 'stock_adjustment' AND reference_id = v_op_id
  ) THEN
    RETURN jsonb_build_object(
      'status', 'duplicate',
      'adjustment_id', v_op_id,
      'reason_code', v_reason,
      'debit_account_code', v_debit_code
    );
  END IF;

  -- The GL must exist before the first write; the helpers only warn when an
  -- account is missing, which would silently create an unjournalled batch.
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE tenant_id = v_tenant AND code = '1200')
     OR NOT EXISTS (SELECT 1 FROM accounts WHERE tenant_id = v_tenant AND code = '3900')
     OR NOT EXISTS (SELECT 1 FROM accounts WHERE tenant_id = v_tenant AND code = '5900') THEN
    RAISE EXCEPTION 'accounts 1200, 3900 and 5900 are required for stock adjustments';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_payload->'items') LOOP
    v_wh := nullif(v_item->>'warehouse_id', '')::uuid;
    v_delta := nullif(v_item->>'delta', '')::numeric;
    v_expected := nullif(v_item->>'expected_on_hand', '')::numeric;

    IF v_wh IS NULL THEN
      RAISE EXCEPTION 'warehouse_id is required for every stock adjustment item';
    END IF;
    IF v_wh = ANY(v_seen_warehouse) THEN
      RAISE EXCEPTION 'warehouse % appears more than once', v_wh;
    END IF;
    v_seen_warehouse := v_seen_warehouse || ARRAY[v_wh];

    IF v_delta IS NULL OR v_delta = 0 THEN
      RAISE EXCEPTION 'stock adjustment quantity must not be zero';
    END IF;
    IF v_is_loss AND v_delta > 0 THEN
      RAISE EXCEPTION 'a % write-off cannot increase stock', v_reason;
    END IF;

    -- Lock the warehouse and counter rows in payload order, then the FIFO
    -- layers, so concurrent sales/receipts cannot move the baseline under us.
    PERFORM 1 FROM warehouses WHERE id = v_wh AND tenant_id = v_tenant FOR UPDATE;
    SELECT quantity_on_hand INTO v_on_hand
    FROM inventory_items
    WHERE product_id = v_pid AND warehouse_id = v_wh
    ORDER BY created_at ASC, id ASC
    LIMIT 1
    FOR UPDATE;
    PERFORM 1 FROM inventory_batches
    WHERE product_id = v_pid AND warehouse_id = v_wh
    ORDER BY created_at ASC, id ASC
    FOR UPDATE;

    v_current := v_current || jsonb_build_object(
      'warehouse_id', v_wh,
      'on_hand', COALESCE(v_on_hand, 0)
    );

    IF v_expected IS NOT NULL AND COALESCE(v_on_hand, 0) IS DISTINCT FROM v_expected THEN
      RETURN jsonb_build_object(
        'status', 'conflict',
        'adjustment_id', v_op_id,
        'message', 'stock changed since this adjustment was prepared',
        'current_items', v_current
      );
    END IF;

    IF v_item ? 'expected_ledger_quantity' THEN
      v_expected := nullif(v_item->>'expected_ledger_quantity', '')::numeric;
      SELECT COALESCE(SUM(quantity_remaining), 0) INTO v_ledger
      FROM inventory_batches
      WHERE product_id = v_pid AND warehouse_id = v_wh;
      IF v_expected IS NOT NULL AND v_ledger IS DISTINCT FROM v_expected THEN
        RETURN jsonb_build_object(
          'status', 'conflict',
          'adjustment_id', v_op_id,
          'message', 'stock ledger changed since this adjustment was prepared',
          'current_items', v_current
        );
      END IF;
    END IF;

    SELECT COALESCE(SUM(quantity_remaining), 0) INTO v_ledger
    FROM inventory_batches
    WHERE product_id = v_pid AND warehouse_id = v_wh;

    -- A genuine loss consumes stock that exists. Corrections may still create
    -- an IOU through the legacy reduction semantics (oversell policy).
    IF v_is_loss AND (v_ledger < 0 OR v_ledger < -v_delta) THEN
      RAISE EXCEPTION 'cannot write off % units of %: only % on the ledger',
        -v_delta, v_product_name, v_ledger;
    END IF;

    v_note := CASE v_is_loss
      WHEN true THEN 'Stock write-off (' || v_reason || ')'
      ELSE 'Stock quantity correction'
    END || COALESCE(' — ' || v_details, '');

    IF v_delta > 0 THEN
      PERFORM create_opening_batch(
        p_product_id     => v_pid,
        p_warehouse_id   => v_wh,
        p_quantity       => v_delta,
        p_unit_cost      => COALESCE(v_cost, 0),
        p_batch_type     => 'adjustment',
        p_reference_type => 'stock_adjustment',
        p_reference_id   => v_op_id,
        p_notes          => v_note,
        p_tenant_id      => v_tenant
      );
    ELSE
      PERFORM create_stock_reduction(
        p_product_id     => v_pid,
        p_warehouse_id   => v_wh,
        p_quantity       => -v_delta,
        p_unit_cost      => COALESCE(v_cost, 0),
        p_reference_type => 'stock_adjustment',
        p_reference_id   => v_op_id,
        p_notes          => v_note,
        p_tenant_id      => v_tenant,
        p_debit_account_code => v_debit_code
      );
    END IF;

    INSERT INTO stock_movements (
      tenant_id, product_id, warehouse_id, movement_type, quantity, unit_cost,
      reference_type, reference_id, notes, created_at
    ) VALUES (
      v_tenant, v_pid, v_wh, 'adjustment', v_delta, COALESCE(v_cost, 0),
      'stock_adjustment', v_op_id, v_note, now()
    );

    -- Counters are ledger truth, never the caller's typed target. The helpers
    -- create/update the counter row themselves (and may create one where none
    -- existed), so this is an UPSERT on the (product_id, warehouse_id)
    -- constraint — an INSERT decided on the pre-helper existence check would
    -- collide with the row the helper just created.
    SELECT COALESCE(SUM(quantity_remaining), 0) INTO v_ledger_after
    FROM inventory_batches
    WHERE product_id = v_pid AND warehouse_id = v_wh;

    INSERT INTO inventory_items (tenant_id, product_id, warehouse_id, quantity_on_hand)
    VALUES (v_tenant, v_pid, v_wh, v_ledger_after)
    ON CONFLICT (product_id, warehouse_id)
    DO UPDATE SET quantity_on_hand = EXCLUDED.quantity_on_hand, updated_at = now();

    v_items := v_items || jsonb_build_object(
      'warehouse_id', v_wh,
      'quantity', v_delta,
      'ledger_after', v_ledger_after
    );
  END LOOP;

  RETURN jsonb_build_object(
    'status', 'synced',
    'adjustment_id', v_op_id,
    'reason_code', v_reason,
    'debit_account_code', v_debit_code,
    'items', v_items
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.sync_stock_adjustment(jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.sync_stock_adjustment(jsonb) FROM public, anon;

-- ---------------------------------------------------------------------------
-- Dispatcher: full re-create of the live (20260914150000) version + the
-- stock.adjust branch. Conflicts intentionally release their item so the
-- outbox can surface them; a forced overwrite is not supported for stock.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_apply(p_item_id uuid, p_op text, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimed boolean;
  v_result  jsonb;
  v_intent  text;
  v_intent_claimed boolean := false;
BEGIN
  if auth.uid() is null then
    raise exception 'sync_apply requires an authenticated session';
  end if;

  v_intent := nullif(p_payload->>'idempotency_key', '');
  if v_intent is not null then
    insert into sync_intent_keys (intent_key, user_id, op)
    values (v_intent, auth.uid(), p_op)
    on conflict (intent_key) do nothing
    returning true into v_intent_claimed;

    if not coalesce(v_intent_claimed, false) then
      select result into v_result
      from sync_intent_keys
      where intent_key = v_intent;
      return coalesce(v_result, '{}'::jsonb) || '{"status":"duplicate"}'::jsonb;
    end if;
  end if;

  insert into sync_applied_items (user_id, item_id, op)
  values (auth.uid(), p_item_id, p_op)
  on conflict (user_id, item_id) do nothing
  returning true into v_claimed;

  if not coalesce(v_claimed, false) then
    select result into v_result
    from sync_applied_items
    where user_id = auth.uid() and item_id = p_item_id;
    return coalesce(v_result, '{}'::jsonb) || '{"status":"duplicate"}'::jsonb;
  end if;

  if p_op = 'invoice.create' then
    v_result := public.sync_invoice_create(p_payload);
  elsif p_op = 'payment.create' then
    v_result := public.sync_payment_create(p_payload);
  elsif p_op = 'invoice.status' then
    v_result := public.sync_invoice_status(p_payload);
  elsif p_op = 'invoice.cancel' then
    v_result := public.sync_invoice_cancel(p_payload);
  elsif p_op = 'sales_return.create' then
    v_result := public.sync_sales_return_create(p_payload);
  elsif p_op = 'advance.receive' then
    v_result := public.sync_advance_receive(p_payload);
  elsif p_op = 'advance.apply' then
    v_result := public.sync_advance_apply(p_payload);
  elsif p_op = 'advance.refund' then
    v_result := public.sync_advance_refund(p_payload);
  elsif p_op = 'store_credit.issue' then
    v_result := public.sync_store_credit_issue(p_payload);
  elsif p_op = 'store_credit.cash_out' then
    v_result := public.sync_store_credit_cash_out(p_payload);
  elsif p_op = 'store_credit.expire' then
    v_result := public.sync_store_credit_expire(p_payload);
  elsif p_op = 'expense.create' then
    v_result := public.sync_expense_create(p_payload);
  elsif p_op = 'expense.update' then
    v_result := public.sync_expense_update(p_payload);
  elsif p_op = 'expense.delete' then
    v_result := public.sync_expense_delete(p_payload);
  elsif p_op = 'supplier.create' then
    v_result := public.sync_supplier_create(p_payload);
  elsif p_op = 'supplier.update' then
    v_result := public.sync_supplier_update(p_payload);
  elsif p_op = 'po.create' then
    v_result := public.sync_po_create(p_payload);
  elsif p_op = 'po.update' then
    v_result := public.sync_po_update(p_payload);
  elsif p_op = 'po.status' then
    v_result := public.sync_po_status(p_payload);
  elsif p_op = 'po.cancel' then
    v_result := public.sync_po_cancel(p_payload);
  elsif p_op = 'po.payment' then
    v_result := public.sync_po_payment(p_payload);
  elsif p_op = 'grn.receive' then
    v_result := public.sync_grn_receive(p_payload);
  elsif p_op = 'purchase_return.create' then
    v_result := public.sync_purchase_return_create(p_payload);
  elsif p_op = 'supplier.payable_payment' then
    v_result := public.sync_supplier_payable_payment(p_payload);
  elsif p_op = 'quotation.create' then
    v_result := public.sync_quotation_create(p_payload);
  elsif p_op = 'quotation.update' then
    v_result := public.sync_quotation_update(p_payload);
  elsif p_op = 'quotation.status' then
    v_result := public.sync_quotation_status(p_payload);
  elsif p_op = 'quotation.delete' then
    v_result := public.sync_quotation_delete(p_payload);
  elsif p_op = 'quotation.convert' then
    v_result := public.sync_quotation_convert(p_payload);
  elsif p_op = 'delivery.create' then
    v_result := public.sync_delivery_create(p_payload);
  elsif p_op = 'delivery.update' then
    v_result := public.sync_delivery_update(p_payload);
  elsif p_op = 'delivery.status' then
    v_result := public.sync_delivery_status(p_payload);
  elsif p_op = 'project.create' then
    v_result := public.sync_project_create(p_payload);
  elsif p_op = 'project.update' then
    v_result := public.sync_project_update(p_payload);
  elsif p_op = 'project.delete' then
    v_result := public.sync_project_delete(p_payload);
  elsif p_op = 'warehouse.create' then
    v_result := public.sync_warehouse_create(p_payload);
  elsif p_op = 'warehouse.update' then
    v_result := public.sync_warehouse_update(p_payload);
  elsif p_op = 'stock_transfer.create' then
    v_result := public.sync_stock_transfer_create(p_payload);
  elsif p_op = 'product.status' then
    v_result := public.sync_product_status(p_payload);
  elsif p_op = 'customer_note.create' then
    v_result := public.sync_customer_note_create(p_payload);
  elsif p_op = 'customer_note.delete' then
    v_result := public.sync_customer_note_delete(p_payload);
  elsif p_op = 'product.create' then
    v_result := public.sync_product_create(p_payload);
  elsif p_op = 'product.update' then
    v_result := public.sync_product_update(p_payload);
  elsif p_op = 'stock.adjust' then
    v_result := public.sync_stock_adjustment(p_payload);
  elsif p_op = 'customer.create' then
    v_result := public.sync_customer_create(p_payload);
  elsif p_op = 'customer.update' then
    v_result := public.sync_customer_update(p_payload);
  elsif p_op = 'employee.create' then
    v_result := public.sync_employee_create(p_payload);
  elsif p_op = 'employee.update' then
    v_result := public.sync_employee_update(p_payload);
  elsif p_op = 'attendance.mark' then
    v_result := public.sync_attendance_mark(p_payload);
  elsif p_op = 'attendance.details' then
    v_result := public.sync_attendance_details(p_payload);
  elsif p_op = 'quick_sell.create' then
    v_result := public.sync_quick_sell_create(p_payload);
  elsif p_op = 'transfer.create' then
    v_result := public.sync_transfer_create(p_payload);
  else
    raise exception 'Unknown sync op: %', p_op;
  end if;

  if v_result->>'status' = 'conflict' then
    delete from sync_applied_items
    where user_id = auth.uid() and item_id = p_item_id;
    if v_intent_claimed then
      delete from sync_intent_keys where intent_key = v_intent;
    end if;
    return v_result;
  end if;

  update sync_applied_items set result = v_result
  where user_id = auth.uid() and item_id = p_item_id;
  if v_intent_claimed then
    update sync_intent_keys set result = v_result
    where intent_key = v_intent;
  end if;

  return v_result;
end;
$$;

DO $$
BEGIN
  RAISE NOTICE 'reason_driven_stock_adjustments: sync_stock_adjustment + stock.adjust offline op applied';
END $$;
