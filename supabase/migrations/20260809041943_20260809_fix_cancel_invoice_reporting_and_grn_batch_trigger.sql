/*
# Fix Cancel Invoice Reporting, Stock Movements, and GRN Batch Trigger

## Problem Summary
Three bugs were identified after the FIFO inventory batch system was implemented:

1. **Cancel invoice confirmation modal shows "No" for Stock Restored and Journal Entries Reversed**
   The `cancel_invoice` function returns only `{success, message}` but the frontend
   expects `stock_restored`, `journal_reversed`, `payments_reversed`, `invoice_number`,
   and `total_payments_reversed` fields. Without these fields, the modal defaults to "No"
   even though the operations actually succeeded.

2. **No stock_movements record after cancelling an invoice**
   The `cancel_invoice` function restores `inventory_items.quantity_on_hand` but never
   inserts a `stock_movements` record, so the stock movements page doesn't show the
   return-in entry. The `edit_invoice` function does this correctly; `cancel_invoice` was
   missing the same logic.

3. **GRN trigger doesn't create inventory_batches on INSERT**
   The `grn_accounting_trigger` function only fires on `UPDATE` when status transitions
   from non-'posted' to 'posted'. But the frontend inserts GRNs with `status: 'posted'`
   directly (there is no two-step create-then-post flow). This means the trigger never
   creates `inventory_batches` rows for purchased goods, so FIFO has no batches to
   consume and falls back to `products.cost_price`.

## Changes

### 1. cancel_invoice function updated
- Returns `invoice_number`, `stock_restored` (true), `journal_reversed` (true),
  `payments_reversed` (boolean), `total_payments_reversed` (numeric), and
  `cogs_reversed` (numeric) in the success JSON.
- Inserts `stock_movements` records (`movement_type = 'return_in'`) for each invoice
  item when stock is restored, mirroring the pattern used in `edit_invoice`.
- Uses `base_quantity` (falling back to `quantity`) for the stock movement amount and
  inventory restoration, consistent with multi-unit handling elsewhere.

### 2. grn_accounting_trigger function updated
- Handles `INSERT` in addition to `UPDATE`. When a GRN is inserted with
  `status = 'posted'`, the trigger now creates `inventory_batches` rows for each
  purchase order item with `received_quantity > 0`, and posts the AP journal entry.
- The `UPDATE` path continues to fire when status transitions to 'posted'.
- For direct receipts (no purchase_order_id), the trigger reads items from
  `purchase_order_items` where `purchase_order_id` matches; if there are none (direct
  mode with no PO), it falls back to checking `stock_movements` for that GRN to
  determine products, quantities, and costs.

### 3. No schema changes
- No tables or columns are created, modified, or dropped.
- No RLS policy changes.

## Important Notes
1. This migration is idempotent — it uses `CREATE OR REPLACE FUNCTION` for all
   functions.
2. Existing cancelled invoices are not affected; the fix applies to future cancellations.
3. Existing GRNs that were inserted without creating batches will NOT be backfilled by
   this migration. Batches will be created for new GRNs going forward.
4. The `grn_accounting_trigger` is dropped and recreated to ensure the new function body
   is bound to the trigger.
*/

-- ============================================================
-- 1. Fix cancel_invoice: return status fields + insert stock movements
-- ============================================================
CREATE OR REPLACE FUNCTION public.cancel_invoice(
  p_invoice_id uuid,
  p_reason text DEFAULT NULL,
  p_cancelled_by text DEFAULT NULL
) RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_invoice          RECORD;
  v_ar_account       uuid;
  v_revenue_account  uuid;
  v_cogs_account     uuid;
  v_inventory_account uuid;
  v_default_wh       uuid;
  v_item             RECORD;
  v_qty              numeric;
  v_cost             numeric;
  v_payment          RECORD;
  v_total_payments   numeric := 0;
  v_has_deliveries   boolean;
  v_je_id            uuid;
  v_sr               RECORD;
  v_returned_qty     numeric;
  v_rev_pay_num      text;
  v_cogs_total       decimal(15,2) := 0;
  v_stock_restored   boolean := false;
  v_journal_reversed boolean := false;
BEGIN
  SELECT * INTO v_invoice FROM invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Invoice not found');
  END IF;

  IF v_invoice.status = 'cancelled' THEN
    RETURN json_build_object('success', false, 'error', 'Invoice is already cancelled');
  END IF;

  IF v_invoice.status = 'draft' THEN
    UPDATE invoices
    SET status = 'cancelled', amount_paid = 0, total_amount = 0, subtotal = 0, bad_debt_amount = 0, updated_at = now()
    WHERE id = p_invoice_id;

    INSERT INTO invoice_edit_history (
      invoice_id, invoice_number, edited_by_name, change_type, reason,
      snapshot_before, snapshot_after
    ) VALUES (
      p_invoice_id, v_invoice.invoice_number, p_cancelled_by, 'cancelled', p_reason,
      json_build_object('status', v_invoice.status, 'total_amount', v_invoice.total_amount),
      json_build_object('status', 'cancelled')
    );
    RETURN json_build_object(
      'success', true,
      'message', 'Draft invoice cancelled (no reversals needed)',
      'invoice_number', v_invoice.invoice_number,
      'stock_restored', true,
      'journal_reversed', true,
      'payments_reversed', false,
      'total_payments_reversed', 0
    );
  END IF;

  SELECT EXISTS(SELECT 1 FROM deliveries WHERE invoice_id = p_invoice_id AND status = 'delivered') INTO v_has_deliveries;
  IF v_has_deliveries THEN
    RETURN json_build_object('success', false, 'error', 'Cannot cancel an invoice that has been delivered. Please process a return instead.');
  END IF;

  SELECT id INTO v_ar_account FROM accounts WHERE code = '1100' LIMIT 1;
  SELECT id INTO v_revenue_account FROM accounts WHERE code = '4000' LIMIT 1;
  SELECT id INTO v_cogs_account FROM accounts WHERE code = '5000' LIMIT 1;
  SELECT id INTO v_inventory_account FROM accounts WHERE code = '1200' LIMIT 1;
  SELECT id INTO v_default_wh FROM warehouses WHERE is_default = true LIMIT 1;

  -- Reverse AR and Revenue
  IF v_ar_account IS NOT NULL AND v_revenue_account IS NOT NULL THEN
    PERFORM post_journal_entry(
      'Reverse AR/Revenue - Cancelled ' || v_invoice.invoice_number,
      COALESCE(v_invoice.invoice_date, CURRENT_DATE),
      'invoice_cancel',
      p_invoice_id,
      json_build_array(
        json_build_object('account_id', v_revenue_account, 'debit', v_invoice.total_amount, 'credit', 0,
          'description', 'Reverse revenue for cancelled ' || v_invoice.invoice_number),
        json_build_object('account_id', v_ar_account, 'debit', 0, 'credit', v_invoice.total_amount,
          'description', 'Reverse AR for cancelled ' || v_invoice.invoice_number)
      )::json,
      v_invoice.customer_id
    );
    v_journal_reversed := true;
  END IF;

  -- FIFO: Calculate COGS total from consumption records BEFORE restoring
  SELECT COALESCE(SUM(cogs_amount), 0) INTO v_cogs_total
  FROM invoice_item_batch_consumption
  WHERE invoice_item_id IN (SELECT id FROM invoice_items WHERE invoice_id = p_invoice_id);

  -- FIFO: Restore batch quantities for all invoice items
  FOR v_item IN SELECT * FROM invoice_items WHERE invoice_id = p_invoice_id LOOP
    PERFORM restore_fifo(v_item.id);
  END LOOP;

  -- If no consumption records existed, compute from cost_price
  IF v_cogs_total = 0 THEN
    FOR v_item IN SELECT * FROM invoice_items WHERE invoice_id = p_invoice_id LOOP
      v_cogs_total := v_cogs_total + (COALESCE(v_item.cost_price, 0) * COALESCE(v_item.quantity, 0));
    END LOOP;
  END IF;

  -- Reverse COGS
  IF v_cogs_account IS NOT NULL AND v_inventory_account IS NOT NULL AND v_cogs_total > 0 THEN
    PERFORM post_journal_entry(
      'Reverse COGS - Cancelled ' || v_invoice.invoice_number,
      COALESCE(v_invoice.invoice_date, CURRENT_DATE),
      'invoice_cancel',
      p_invoice_id,
      json_build_array(
        json_build_object('account_id', v_inventory_account, 'debit', v_cogs_total, 'credit', 0,
          'description', 'Restore inventory for cancelled ' || v_invoice.invoice_number),
        json_build_object('account_id', v_cogs_account, 'debit', 0, 'credit', v_cogs_total,
          'description', 'Reverse COGS for cancelled ' || v_invoice.invoice_number)
      )::json,
      v_invoice.customer_id
    );
    v_journal_reversed := true;
  END IF;

  -- Restore stock + record stock movements
  FOR v_item IN SELECT * FROM invoice_items WHERE invoice_id = p_invoice_id LOOP
    v_qty := COALESCE(v_item.base_quantity, v_item.quantity);
    UPDATE inventory_items
    SET quantity_on_hand = quantity_on_hand + v_qty,
        updated_at = now()
    WHERE product_id = v_item.product_id
      AND warehouse_id = COALESCE(v_item.warehouse_id, v_default_wh);

    -- Insert stock movement record so it shows in stock movements page
    INSERT INTO stock_movements (product_id, warehouse_id, movement_type, quantity, unit_cost, reference_type, reference_id, reference_number, notes)
    VALUES (
      v_item.product_id,
      COALESCE(v_item.warehouse_id, v_default_wh),
      'return_in',
      v_qty,
      COALESCE(v_item.cost_price, 0),
      'invoice_cancel',
      p_invoice_id,
      v_invoice.invoice_number,
      'Stock restoration - invoice cancelled'
    );
    v_stock_restored := true;
  END LOOP;

  -- Reverse payments
  FOR v_payment IN SELECT * FROM payments WHERE reference_id = p_invoice_id AND reference_type = 'invoice' AND is_reversed = false LOOP
    v_total_payments := v_total_payments + v_payment.amount;
    UPDATE payments SET is_reversed = true WHERE id = v_payment.id;
    SELECT generate_payment_number() INTO v_rev_pay_num;
    INSERT INTO payments (
      payment_number, payment_type, reference_type, reference_id, customer_id,
      amount, payment_method, payment_date, is_reversed, payment_for,
      notes, created_at
    ) VALUES (
      v_rev_pay_num, 'received', 'invoice_cancel', p_invoice_id, v_invoice.customer_id,
      v_payment.amount, v_payment.payment_method, COALESCE(v_invoice.invoice_date, CURRENT_DATE),
      false, 'reversal_payment',
      'Reversal of payment for cancelled invoice ' || v_invoice.invoice_number, now()
    );
  END LOOP;

  IF v_total_payments > 0 AND v_ar_account IS NOT NULL THEN
    PERFORM post_journal_entry(
      'Reverse Payment - Cancelled ' || v_invoice.invoice_number,
      COALESCE(v_invoice.invoice_date, CURRENT_DATE),
      'invoice_cancel',
      p_invoice_id,
      json_build_array(
        json_build_object('account_id', v_ar_account, 'debit', v_total_payments, 'credit', 0,
          'description', 'Restore AR for reversed payments - ' || v_invoice.invoice_number)
      )::json,
      v_invoice.customer_id
    );
    v_journal_reversed := true;
  END IF;

  FOR v_sr IN SELECT * FROM sales_returns WHERE invoice_id = p_invoice_id LOOP
    UPDATE sales_returns SET status = 'void', updated_at = now() WHERE id = v_sr.id;
  END LOOP;

  -- balance_due is a GENERATED ALWAYS column: (total_amount - amount_paid - bad_debt_amount)
  -- Zero out the source columns so balance_due auto-computes to 0
  UPDATE invoices
  SET status = 'cancelled',
      amount_paid = 0,
      total_amount = 0,
      subtotal = 0,
      bad_debt_amount = 0,
      updated_at = now()
  WHERE id = p_invoice_id;

  INSERT INTO invoice_edit_history (
    invoice_id, invoice_number, edited_by_name, change_type, reason,
    snapshot_before, snapshot_after
  ) VALUES (
    p_invoice_id, v_invoice.invoice_number, p_cancelled_by, 'cancelled', p_reason,
    json_build_object('status', v_invoice.status, 'total_amount', v_invoice.total_amount, 'amount_paid', v_invoice.amount_paid),
    json_build_object('status', 'cancelled', 'total_amount', 0, 'amount_paid', 0)
  );

  RETURN json_build_object(
    'success', true,
    'message', 'Invoice cancelled successfully',
    'invoice_number', v_invoice.invoice_number,
    'stock_restored', v_stock_restored,
    'journal_reversed', v_journal_reversed,
    'payments_reversed', v_total_payments > 0,
    'total_payments_reversed', v_total_payments,
    'cogs_reversed', v_cogs_total
  );
END;
$function$;

-- ============================================================
-- 2. Fix grn_accounting_trigger: handle INSERT (not just UPDATE)
-- ============================================================
CREATE OR REPLACE FUNCTION public.grn_accounting_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id uuid;
  v_total_cost decimal(15,2);
  v_po_number text;
  v_item RECORD;
  v_batch_counter integer := 0;
  v_batch_num text;
  v_should_process boolean := false;
BEGIN
  v_tenant_id := COALESCE(NEW.tenant_id, '00000000-0000-0000-0000-000000000001');

  -- Determine whether we should process this GRN:
  -- - INSERT with status = 'posted' (frontend creates GRNs directly as posted)
  -- - UPDATE where status transitions to 'posted' from something else
  IF TG_OP = 'INSERT' AND NEW.status = 'posted' THEN
    v_should_process := true;
  ELSIF TG_OP = 'UPDATE' AND NEW.status = 'posted' AND OLD.status != 'posted' THEN
    v_should_process := true;
  END IF;

  IF NOT v_should_process THEN
    RETURN NEW;
  END IF;

  SELECT po.po_number INTO v_po_number
  FROM purchase_orders po
  WHERE po.id = NEW.purchase_order_id;

  -- Create inventory batches for each received item
  FOR v_item IN
    SELECT poi.product_id, poi.variant_id, poi.received_quantity, poi.unit_cost, poi.warehouse_id
    FROM purchase_order_items poi
    WHERE poi.purchase_order_id = NEW.purchase_order_id
      AND poi.received_quantity > 0
  LOOP
    v_batch_counter := v_batch_counter + 1;
    v_batch_num := 'GRN-' || COALESCE(NEW.grn_number, v_batch_counter::text);

    INSERT INTO inventory_batches (
      product_id, variant_id, warehouse_id, batch_number,
      quantity_received, quantity_remaining, unit_cost,
      batch_type, reference_type, reference_id, reference_number,
      notes, created_at
    ) VALUES (
      v_item.product_id, v_item.variant_id, COALESCE(v_item.warehouse_id, NEW.warehouse_id), v_batch_num,
      v_item.received_quantity, v_item.received_quantity, v_item.unit_cost,
      'purchase', 'grn', NEW.id, NEW.grn_number,
      'Goods received via GRN', COALESCE(NEW.received_date, CURRENT_DATE)
    );
  END LOOP;

  -- If no PO items were found (direct receipt mode), check stock_movements
  -- that the frontend created for this GRN
  IF v_batch_counter = 0 THEN
    FOR v_item IN
      SELECT sm.product_id, sm.quantity, sm.unit_cost, sm.warehouse_id
      FROM stock_movements sm
      WHERE sm.reference_id = NEW.id
        AND sm.reference_type = 'grn'
        AND sm.movement_type = 'purchase'
    LOOP
      v_batch_counter := v_batch_counter + 1;
      v_batch_num := 'GRN-' || COALESCE(NEW.grn_number, v_batch_counter::text);

      INSERT INTO inventory_batches (
        product_id, warehouse_id, batch_number,
        quantity_received, quantity_remaining, unit_cost,
        batch_type, reference_type, reference_id, reference_number,
        notes, created_at
      ) VALUES (
        v_item.product_id, COALESCE(v_item.warehouse_id, NEW.warehouse_id), v_batch_num,
        v_item.quantity, v_item.quantity, v_item.unit_cost,
        'purchase', 'grn', NEW.id, NEW.grn_number,
        'Goods received via GRN (direct receipt)', COALESCE(NEW.received_date, CURRENT_DATE)
      );
    END LOOP;
  END IF;

  -- Post the AP journal entry
  SELECT COALESCE(SUM(poi.received_quantity * poi.unit_cost), 0)
  INTO v_total_cost
  FROM purchase_order_items poi
  WHERE poi.purchase_order_id = NEW.purchase_order_id;

  -- If no PO items, compute from stock_movements
  IF v_total_cost = 0 THEN
    SELECT COALESCE(SUM(sm.quantity * sm.unit_cost), 0)
    INTO v_total_cost
    FROM stock_movements sm
    WHERE sm.reference_id = NEW.id
      AND sm.reference_type = 'grn'
      AND sm.movement_type = 'purchase';
  END IF;

  IF v_total_cost > 0 THEN
    PERFORM post_journal_entry(
      p_description := 'Goods Received - GRN #' || NEW.grn_number || COALESCE(' / PO #' || v_po_number, ''),
      p_lines := jsonb_build_array(
        jsonb_build_object('account_code', '1200', 'debit', v_total_cost, 'description', 'Inventory received'),
        jsonb_build_object('account_code', '2000', 'credit', v_total_cost, 'description', 'Accounts Payable - goods received')
      ),
      p_entry_date := COALESCE(NEW.received_date, CURRENT_DATE),
      p_reference_type := 'grn',
      p_reference_id := NEW.id,
      p_tenant_id := v_tenant_id
    );
  END IF;

  RETURN NEW;
END;
$$;

-- Rebind the trigger to the updated function
DROP TRIGGER IF EXISTS trg_grn_accounting ON goods_receipt_notes;
CREATE TRIGGER trg_grn_accounting
  AFTER INSERT OR UPDATE ON goods_receipt_notes
  FOR EACH ROW EXECUTE FUNCTION grn_accounting_trigger();
