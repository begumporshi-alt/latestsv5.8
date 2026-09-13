-- Quick Sell: non-stock items bought on demand from another shop and sold
-- immediately to a standing customer, never stocked.
--
-- Model:
--   * products.track_inventory = false marks a non-stock (quick-sell) item.
--     It is still a real products row — invoice_items.product_id is NOT NULL
--     and reports/history need the join — but the whole FIFO/stock chain
--     skips it: no batch consumption, no negative IOU layer, no
--     inventory_items counter row, no stock_movements, and the manually
--     entered per-sale-unit cost on the line survives untouched.
--   * invoices.is_quick_sell marks an invoice created by the Quick Sell form
--     (display badge + audit context only — behaviour is driven by the
--     product flag, so quick-sell items mixed into any invoice are safe).
--   * invoices.cost_payment_method is the "source purchase paid from"
--     payment-method code. The cost leg posts
--       Dr 5000 COGS / Cr <account of that method, fallback 1001 Cash>
--     so cash/bank and margins stay exact without a second manual entry.
--     Inventory 1200 is never involved — the item never enters the balance
--     sheet as an asset. Cost 0 => no cost JE.
--   * The cost JE is its own journal entry ('Quick Sell Cost - <invnum> …'),
--     deliberately NOT prefixed 'COGS' so post_cogs_je_from_item_insert's
--     LIKE 'COGS%' lookup can never grab and overwrite it on mixed invoices.
--     cancel/edit/audit read it via the widened regex
--     ^(COGS|Quick Sell Cost).
--
-- Consulted design review (ChatGPT, 2026-09-14) folded in: server-side
-- enforcement that quick-sell lines only reference track_inventory=false
-- products (not just UI refusal), and invoice_items.source_shop as an
-- optional free-text audit trail for where the item was bought.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- 0) Columns
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE products ADD COLUMN IF NOT EXISTS track_inventory boolean NOT NULL DEFAULT true;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS is_quick_sell boolean NOT NULL DEFAULT false;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS cost_payment_method text;
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS source_shop text;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1) Helpers
-- ═══════════════════════════════════════════════════════════════════════════

-- GL account the source shop was paid from: the payment method's account,
-- falling back to 1001 Cash (same convention as the payment trigger).
CREATE OR REPLACE FUNCTION quick_sell_cost_account(p_method text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT pm.account_id
       FROM payment_methods pm
      WHERE pm.code = p_method AND pm.is_active = true
      LIMIT 1),
    (SELECT a.id FROM accounts a WHERE a.code = '1001' LIMIT 1)
  );
$$;

-- Post (or idempotently refresh) the Quick Sell Cost JE for an invoice:
--   Dr 5000 COGS / Cr <quick_sell_cost_account(invoices.cost_payment_method)>
-- per non-stock item with quantity > 0 and cost > 0. Draft and cancelled
-- invoices post nothing. Re-running with the same data is a no-op (the
-- UPDATE path replaces lines with identical values => zero balance delta),
-- which is what makes the draft->sent trigger and edit_invoice STEP 7b both
-- safe callers.
CREATE OR REPLACE FUNCTION post_quick_sell_cost_je(p_invoice_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_invoice RECORD;
  v_cogs_account uuid;
  v_paid_account uuid;
  v_item RECORD;
  v_total decimal(15,2) := 0;
  v_item_cost decimal(15,2);
  v_lines json[] := '{}';
  v_line_count int := 0;
  v_existing_je_id uuid;
  v_old_nets jsonb;
  v_new_nets jsonb;
  v_acc record;
BEGIN
  SELECT * INTO v_invoice FROM invoices WHERE id = p_invoice_id;
  IF NOT FOUND OR v_invoice.status IN ('draft', 'cancelled') THEN
    RETURN NULL;
  END IF;

  -- Non-stock items only; stocked items' COGS belongs to the FIFO JE.
  SELECT id INTO v_cogs_account FROM accounts WHERE code = '5000' LIMIT 1;
  IF v_cogs_account IS NULL THEN
    RETURN NULL;
  END IF;

  FOR v_item IN
    SELECT ii.id, ii.quantity, ii.cost_price, ii.source_shop, p.name, p.sku
      FROM invoice_items ii
      JOIN products p ON p.id = ii.product_id
     WHERE ii.invoice_id = p_invoice_id
       AND NOT p.track_inventory
       AND ii.quantity > 0
     ORDER BY ii.sort_order, ii.id
  LOOP
    v_item_cost := ROUND(COALESCE(v_item.cost_price, 0) * v_item.quantity, 2);
    CONTINUE WHEN v_item_cost <= 0;

    v_total := v_total + v_item_cost;
    v_line_count := v_line_count + 1;

    v_lines := array_append(v_lines, json_build_object(
      'account_id', v_cogs_account, 'debit', v_item_cost, 'credit', 0,
      'description', 'Quick Sell Cost (manual): ' || COALESCE(v_item.name, 'Unknown') ||
        ' (SKU: ' || COALESCE(v_item.sku, 'N/A') || ') - Qty: ' || v_item.quantity ||
        ' x Cost: ' || COALESCE(v_item.cost_price, 0) || ' = ' || v_item_cost ||
        CASE WHEN COALESCE(v_item.source_shop, '') <> ''
             THEN ' [bought from: ' || v_item.source_shop || ']' ELSE '' END
    ));
    v_lines := array_append(v_lines, json_build_object(
      'account_id', NULL, 'debit', 0, 'credit', v_item_cost,  -- account filled below
      'description', 'Paid source shop for ' || COALESCE(v_item.name, 'Unknown') ||
        ' (Qty: ' || v_item.quantity || ') for ' || v_invoice.invoice_number
    ));
  END LOOP;

  IF v_total <= 0 THEN
    RETURN NULL;
  END IF;

  v_paid_account := quick_sell_cost_account(v_invoice.cost_payment_method);
  IF v_paid_account IS NULL THEN
    RAISE EXCEPTION 'Quick Sell cost account unavailable: payment method "%" has no GL account and Cash (1001) is missing', COALESCE(v_invoice.cost_payment_method, 'cash');
  END IF;
  -- Fill the credit-side account now that we know the invoice has cost lines.
  FOR i IN 1..array_length(v_lines, 1) LOOP
    IF (v_lines[i]->>'account_id')::text IS NULL THEN
      v_lines[i] := jsonb_set(v_lines[i]::jsonb, '{account_id}', to_jsonb(v_paid_account))::json;
    END IF;
  END LOOP;

  SELECT id INTO v_existing_je_id
    FROM journal_entries
   WHERE reference_type = 'invoice'
     AND reference_id = p_invoice_id
     AND description LIKE 'Quick Sell Cost%'
   ORDER BY entry_date ASC, id ASC
   LIMIT 1;

  IF v_existing_je_id IS NOT NULL THEN
    -- Capture the per-account nets BEFORE replacing lines so accounts.balance
    -- can be adjusted by the delta for every account the JE ever touched
    -- (the paid-from account may itself change between posts).
    SELECT COALESCE(jsonb_object_agg(account_id, net), '{}'::jsonb) INTO v_old_nets
      FROM (SELECT account_id, SUM(debit - credit) AS net
              FROM journal_lines WHERE journal_entry_id = v_existing_je_id
             GROUP BY account_id) t;

    DELETE FROM journal_lines WHERE journal_entry_id = v_existing_je_id;

    FOR i IN 1..array_length(v_lines, 1) LOOP
      INSERT INTO journal_lines (journal_entry_id, account_id, description, debit, credit, sort_order)
      VALUES (
        v_existing_je_id,
        (v_lines[i]->>'account_id')::uuid,
        v_lines[i]->>'description',
        (v_lines[i]->>'debit')::decimal(15,2),
        (v_lines[i]->>'credit')::decimal(15,2),
        i
      );
    END LOOP;

    UPDATE journal_entries
       SET description = 'Quick Sell Cost - ' || v_invoice.invoice_number || ' (' || v_line_count || ' items, total: ' || v_total || ')',
           total_debit = v_total,
           total_credit = v_total
     WHERE id = v_existing_je_id;

    SELECT COALESCE(jsonb_object_agg(account_id, net), '{}'::jsonb) INTO v_new_nets
      FROM (SELECT account_id, SUM(debit - credit) AS net
              FROM journal_lines WHERE journal_entry_id = v_existing_je_id
             GROUP BY account_id) t;

    -- Maintain denormalized balances by the net change per account (same
    -- sign convention as post_journal_entry).
    FOR v_acc IN
      SELECT DISTINCT k AS account_id
        FROM jsonb_object_keys(v_old_nets || v_new_nets) AS k
    LOOP
      UPDATE accounts
         SET balance = balance + CASE
               WHEN account_type IN ('liability', 'equity', 'revenue')
                 THEN -((COALESCE((v_new_nets ->> v_acc.account_id)::numeric, 0)) - (COALESCE((v_old_nets ->> v_acc.account_id)::numeric, 0)))
               ELSE ((COALESCE((v_new_nets ->> v_acc.account_id)::numeric, 0)) - (COALESCE((v_old_nets ->> v_acc.account_id)::numeric, 0)))
             END
       WHERE id = (v_acc.account_id)::uuid;
    END LOOP;

    RETURN v_existing_je_id;
  ELSE
    RETURN post_journal_entry(
      'Quick Sell Cost - ' || v_invoice.invoice_number || ' (' || v_line_count || ' items, total: ' || v_total || ')',
      COALESCE(v_invoice.invoice_date, CURRENT_DATE),
      'invoice',
      p_invoice_id,
      to_json(v_lines),
      v_invoice.customer_id
    );
  END IF;
END
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2) consume_fifo: skip non-stock products entirely (full re-create of the
--    live 20260906140000 strategy-aware version + guard). Skipping means:
--    no batch consumption, no FIFO-SHORTFALL IOU layer, and NO cost_price
--    overwrite — the manually entered per-sale-unit cost survives.
-- ═══════════════════════════════════════════════════════════════════════════
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
  SELECT COALESCE(setting_value->>'batch_allocation_method', 'fifo')
    INTO v_strategy
    FROM app_settings
   WHERE setting_key = 'inventory';
  v_strategy := COALESCE(v_strategy, 'fifo');

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

-- ═══════════════════════════════════════════════════════════════════════════
-- 3) deduct_stock_on_invoice_item: skip non-stock products (full re-create
--    of the live 20260830110000 version + guard). Without the guard the
--    function INSERTs an inventory_items row with NEGATIVE quantity for a
--    product that has no stock row at all.
-- ═══════════════════════════════════════════════════════════════════════════
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
    SET quantity_on_hand = quantity_on_hand - v_qty_to_deduct,
        updated_at = now()
    WHERE id = v_inv_id;
  ELSE
    INSERT INTO inventory_items (product_id, warehouse_id, quantity_on_hand, quantity_reserved, quantity_incoming)
    VALUES (NEW.product_id, v_target_wh, -v_qty_to_deduct, 0, 0);
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

-- ═══════════════════════════════════════════════════════════════════════════
-- 4) restore_stock_on_invoice_item_delete: same skip on the way back
--    (full re-create of the live 20260830160000 version + guard). Normally
--    a no-op for non-stock items (no sale movement exists to restore), but a
--    product flipped from stocked to non-stock must not gain phantom stock.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION restore_stock_on_invoice_item_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_invoice_record RECORD;
  v_target_wh uuid;
  v_qty_to_restore numeric;
  v_inv_id uuid;
  v_product_cost numeric;
  v_existing_movement RECORD;
BEGIN
  -- Quick-sell (non-stock) products have no stock to restore.
  IF NOT COALESCE((SELECT p.track_inventory FROM products p WHERE p.id = OLD.product_id), true) THEN
    RETURN OLD;
  END IF;

  -- Skip if called from within edit_invoice (it handles stock restoration itself)
  IF current_setting('app.edit_invoice_active', true) = 'true' THEN
    RETURN OLD;
  END IF;

  SELECT * INTO v_invoice_record FROM invoices WHERE id = OLD.invoice_id;
  IF NOT FOUND THEN
    RETURN OLD;
  END IF;

  IF v_invoice_record.status = 'cancelled' THEN
    RETURN OLD;
  END IF;

  SELECT * INTO v_existing_movement
  FROM stock_movements
  WHERE reference_id = OLD.invoice_id
    AND reference_type = 'invoice'
    AND product_id = OLD.product_id
    AND movement_type = 'sale'
    AND notes LIKE '%invoice_item:' || OLD.id::text || '%'
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN OLD;
  END IF;

  v_qty_to_restore := ABS(v_existing_movement.quantity);

  v_target_wh := v_existing_movement.warehouse_id;

  IF v_target_wh IS NULL THEN
    v_target_wh := OLD.warehouse_id;
  END IF;

  IF v_target_wh IS NULL THEN
    SELECT id INTO v_target_wh FROM warehouses WHERE is_default = true AND is_active = true LIMIT 1;
  END IF;

  IF v_target_wh IS NULL THEN
    RETURN OLD;
  END IF;

  SELECT id INTO v_inv_id
  FROM inventory_items
  WHERE product_id = OLD.product_id AND warehouse_id = v_target_wh
  FOR UPDATE;

  IF v_inv_id IS NOT NULL THEN
    UPDATE inventory_items
    SET quantity_on_hand = quantity_on_hand + v_qty_to_restore,
        updated_at = now()
    WHERE id = v_inv_id;
  ELSE
    INSERT INTO inventory_items (product_id, warehouse_id, quantity_on_hand, quantity_reserved, quantity_incoming)
    VALUES (OLD.product_id, v_target_wh, v_qty_to_restore, 0, 0);
  END IF;

  SELECT cost_price INTO v_product_cost FROM products WHERE id = OLD.product_id;

  INSERT INTO stock_movements (
    product_id, warehouse_id, movement_type, quantity,
    unit_cost, reference_type, reference_id, reference_number, notes
  ) VALUES (
    OLD.product_id, v_target_wh, 'return_in', v_qty_to_restore,
    COALESCE(v_product_cost, 0), 'invoice', OLD.invoice_id,
    v_invoice_record.invoice_number,
    'Stock restoration - invoice item deleted - invoice_item:' || OLD.id::text
  );

  RETURN OLD;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5) invoice_status_cogs_trigger (draft -> sent/paid): quick-sell items are
--    skipped by consume_fifo's own guard, and the Quick Sell Cost JE is
--    (re)posted after the stocked COGS block. Full re-create of the live
--    20260902090000 version + the poster call.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.invoice_status_cogs_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_cogs uuid;
  v_inv uuid;
  v_item RECORD;
  v_wh uuid;
  v_qty numeric;
  v_amt decimal(15,2);
  v_total_cogs decimal(15,2) := 0;
  v_cogs_desc text;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'draft' AND NEW.status IN ('sent', 'partially_paid', 'paid') THEN
    SELECT id INTO v_cogs FROM accounts WHERE code = '5000' LIMIT 1;
    SELECT id INTO v_inv FROM accounts WHERE code = '1200' LIMIT 1;
    IF v_cogs IS NULL OR v_inv IS NULL THEN RETURN NEW; END IF;

    v_wh := COALESCE(NEW.warehouse_id, (SELECT id FROM warehouses WHERE is_default = true AND is_active = true LIMIT 1));

    FOR v_item IN SELECT * FROM invoice_items WHERE invoice_id = NEW.id ORDER BY sort_order LOOP
      -- FIFO consumption is denominated in BASE units
      v_qty := COALESCE(v_item.base_quantity, v_item.quantity);
      IF v_qty <= 0 THEN CONTINUE; END IF;

      PERFORM 1 FROM invoice_item_batch_consumption WHERE invoice_item_id = v_item.id;
      IF FOUND THEN
        SELECT COALESCE(SUM(cogs_amount), 0) INTO v_amt
        FROM invoice_item_batch_consumption WHERE invoice_item_id = v_item.id;
        IF v_amt > 0 THEN
          v_total_cogs := v_total_cogs + v_amt;
        END IF;
        CONTINUE;
      END IF;

      -- Non-stock items: consume_fifo returns immediately (no consumption
      -- rows, no cost overwrite) and the amount below reads 0, so the loop
      -- naturally skips them into the Quick Sell Cost JE posted after it.
      PERFORM consume_fifo(v_item.id, v_item.product_id, COALESCE(v_item.warehouse_id, v_wh), v_qty, COALESCE(v_item.cost_price, 0));
      SELECT COALESCE(SUM(cogs_amount), 0) INTO v_amt FROM invoice_item_batch_consumption WHERE invoice_item_id = v_item.id;
      IF v_amt > 0 THEN
        v_total_cogs := v_total_cogs + v_amt;
      END IF;
    END LOOP;

    IF v_total_cogs > 0 THEN
      v_cogs_desc := 'COGS - ' || NEW.invoice_number || ' (' ||
        (SELECT count(*) FROM invoice_items WHERE invoice_id = NEW.id) || ' items, total: ' || v_total_cogs || ')';

      PERFORM 1 FROM journal_entries
      WHERE reference_type = 'invoice' AND reference_id = NEW.id AND description LIKE 'COGS%';
      IF NOT FOUND THEN
        PERFORM post_journal_entry(v_cogs_desc, COALESCE(NEW.invoice_date, CURRENT_DATE), 'invoice', NEW.id,
          json_build_array(
            json_build_object('account_id', v_cogs, 'debit', v_total_cogs, 'credit', 0, 'description', 'COGS (FIFO)'),
            json_build_object('account_id', v_inv, 'debit', 0, 'credit', v_total_cogs, 'description', 'Inventory released (FIFO)')
          )::json, NEW.customer_id);
      END IF;
    END IF;

    -- Quick-sell cost leg (no-op when the invoice has no non-stock items;
    -- idempotent when edit_invoice STEP 7b already posted it).
    PERFORM post_quick_sell_cost_je(NEW.id);
  END IF;
  RETURN NEW;
END
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6) edit_invoice: four surgical changes to the live 20260909100000 version.
--    a) STEP 1b restores stock for STOCKED items only (non-stock items would
--       otherwise gain a phantom inventory_items row).
--    b) STEP 3 also deletes the Quick Sell Cost JE so the edit re-posts it.
--    c) STEP 5 preserves/updates invoices.cost_payment_method.
--    d) STEP 7b posts the Quick Sell Cost JE for non-stock items and EXCLUDES
--       them from the no-FIFO fallback (which credits Inventory 1200).
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.edit_invoice(p_invoice_id uuid, p_new_data json, p_edited_by text DEFAULT NULL::text, p_reason text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_invoice RECORD;
  v_ar_account uuid;
  v_revenue_account uuid;
  v_cogs_account uuid;
  v_inventory_account uuid;
  v_cash_account uuid;
  v_default_wh uuid;
  v_item RECORD;
  v_qty numeric;
  v_cost numeric;
  v_payment RECORD;
  v_je_id uuid;
  v_new_items json;
  v_new_item json;
  v_new_subtotal numeric := 0;
  v_new_cart_discount_percent numeric := 0;
  v_new_extra_discount numeric := 0;
  v_cart_discount_amount numeric := 0;
  v_new_total numeric := 0;
  v_new_customer uuid;
  v_new_date date;
  v_new_due_date date;
  v_new_notes text;
  v_new_reference text;
  v_new_payment_term text := 'full';
  v_new_payment_method text := 'cash';
  v_new_partial_amount numeric := 0;
  v_has_deliveries boolean;
  v_has_returns boolean;
  v_old_snapshot json;
  v_new_snapshot json;
  v_i integer := 0;
  v_old_payments json;
  v_old_payment_term text;
  v_new_payment_id uuid;
  v_delivery RECORD;
  v_product RECORD;
  v_cost_per_unit numeric;
  v_total_cost_added numeric;
  v_target_wh uuid;
  v_vat_account uuid;
  v_vat_mode text;
  v_new_tax numeric := 0;
  v_old_tax numeric := 0;
  v_shipping_account uuid;
  v_new_shipping numeric := 0;
  v_old_shipping numeric := 0;
  v_lines json;
  v_new_cost_method text;
BEGIN
  SELECT * INTO v_invoice FROM invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Invoice not found');
  END IF;

  IF v_invoice.status = 'cancelled' THEN
    RETURN json_build_object('success', false, 'error', 'Cannot edit a cancelled invoice');
  END IF;

  SELECT EXISTS(SELECT 1 FROM deliveries WHERE invoice_id = p_invoice_id AND status = 'delivered') INTO v_has_deliveries;
  IF v_has_deliveries THEN
    RETURN json_build_object('success', false, 'error', 'Cannot edit an invoice that has been delivered. Please process a return instead.');
  END IF;

  SELECT EXISTS(SELECT 1 FROM sales_returns WHERE invoice_id = p_invoice_id AND status = 'completed') INTO v_has_returns;
  IF v_has_returns THEN
    RETURN json_build_object('success', false, 'error', 'Cannot edit an invoice with completed sales returns. Please process additional returns instead.');
  END IF;

  v_new_customer := (p_new_data->>'customer_id')::uuid;
  v_new_date := COALESCE((p_new_data->>'invoice_date')::date, CURRENT_DATE);
  v_new_due_date := CASE WHEN p_new_data->>'due_date' IS NULL OR p_new_data->>'due_date' = '' THEN NULL ELSE (p_new_data->>'due_date')::date END;
  v_new_notes := p_new_data->>'notes';
  v_new_reference := p_new_data->>'reference';
  v_new_items := p_new_data->'items';
  v_new_cart_discount_percent := COALESCE((p_new_data->>'cart_discount_percent')::numeric, 0);
  v_new_extra_discount := COALESCE((p_new_data->>'extra_discount')::numeric, 0);
  v_new_payment_term := COALESCE(p_new_data->>'payment_term', 'full');
  v_new_payment_method := COALESCE(p_new_data->>'payment_method', 'cash');
  v_new_partial_amount := COALESCE((p_new_data->>'partial_amount')::numeric, 0);
  v_new_tax := COALESCE((p_new_data->>'tax_amount')::numeric, 0);
  v_new_shipping := COALESCE((p_new_data->>'shipping_cost')::numeric, 0);
  v_new_cost_method := NULLIF(p_new_data->>'cost_payment_method', '');

  FOR v_i IN SELECT generate_series(0, json_array_length(v_new_items) - 1) LOOP
    v_new_item := v_new_items->v_i;
    v_new_subtotal := v_new_subtotal + (v_new_item->>'quantity')::numeric * (v_new_item->>'unit_price')::numeric * (1 - COALESCE((v_new_item->>'discount_percent')::numeric, 0) / 100);
  END LOOP;

  v_cart_discount_amount := (v_new_subtotal * v_new_cart_discount_percent) / 100;
  v_new_total := GREATEST(0, v_new_subtotal - v_cart_discount_amount - v_new_extra_discount);
  SELECT COALESCE(s.setting_value->>'mode', 'exclusive') INTO v_vat_mode
  FROM app_settings s WHERE s.setting_key = 'vat';
  v_vat_mode := COALESCE(v_vat_mode, 'exclusive');
  IF v_vat_mode = 'exclusive' THEN
    v_new_total := v_new_total + v_new_tax;
  END IF;
  v_new_shipping := GREATEST(0, v_new_shipping);
  v_new_total := v_new_total + v_new_shipping;

  IF v_invoice.amount_paid >= v_invoice.total_amount AND v_invoice.total_amount > 0 THEN
    v_old_payment_term := 'full';
  ELSIF v_invoice.amount_paid > 0 THEN
    v_old_payment_term := 'partial';
  ELSE
    v_old_payment_term := 'credit';
  END IF;

  SELECT id INTO v_ar_account FROM accounts WHERE code = '1100' LIMIT 1;
  SELECT id INTO v_revenue_account FROM accounts WHERE code = '4000' LIMIT 1;
  SELECT id INTO v_cogs_account FROM accounts WHERE code = '5000' LIMIT 1;
  SELECT id INTO v_inventory_account FROM accounts WHERE code = '1200' LIMIT 1;
  SELECT id INTO v_vat_account FROM accounts WHERE code = '2100' LIMIT 1;
  SELECT id INTO v_shipping_account FROM accounts WHERE code = '4020' LIMIT 1;
  SELECT id INTO v_cash_account FROM accounts WHERE code = '1000' LIMIT 1;

  SELECT id INTO v_default_wh FROM warehouses WHERE is_default = true AND is_active = true LIMIT 1;
  IF v_default_wh IS NULL THEN
    SELECT id INTO v_default_wh FROM warehouses WHERE is_active = true LIMIT 1;
  END IF;

  SELECT COALESCE(json_agg(json_build_object('id', p.id, 'payment_method', p.payment_method, 'amount', p.amount, 'payment_type', p.payment_type, 'payment_date', p.payment_date)), '[]'::json)
  INTO v_old_payments
  FROM payments p WHERE p.reference_type = 'invoice' AND p.reference_id = p_invoice_id;

  SELECT json_build_object(
    'customer_id', v_invoice.customer_id, 'invoice_date', v_invoice.invoice_date, 'due_date', v_invoice.due_date,
    'notes', v_invoice.notes, 'subtotal', v_invoice.subtotal,
    'cart_discount_percent', COALESCE(v_invoice.cart_discount_percent, 0),
    'extra_discount', COALESCE(v_invoice.extra_discount, 0),
    'shipping_cost', COALESCE(v_invoice.shipping_cost, 0),
    'total_amount', v_invoice.total_amount, 'amount_paid', v_invoice.amount_paid, 'status', v_invoice.status,
    'payment_term', v_old_payment_term, 'payments', v_old_payments,
    'cost_payment_method', v_invoice.cost_payment_method,
    'items', (SELECT json_agg(json_build_object('product_id', ii.product_id, 'quantity', ii.quantity, 'unit_price', ii.unit_price, 'discount_percent', ii.discount_percent, 'subtotal', ii.subtotal, 'unit_name', ii.unit_name, 'base_quantity', ii.base_quantity, 'warehouse_id', ii.warehouse_id)) FROM invoice_items ii WHERE ii.invoice_id = p_invoice_id)
  ) INTO v_old_snapshot;

  -- STEP 1: FIFO - Restore batch quantities for old items FIRST
  FOR v_item IN SELECT * FROM invoice_items WHERE invoice_id = p_invoice_id LOOP
    PERFORM restore_fifo(v_item.id);
  END LOOP;

  -- STEP 1b: Restore stock for old STOCKED items (PRESERVE original sale movements)
  FOR v_item IN SELECT ii.* FROM invoice_items ii JOIN products pr ON pr.id = ii.product_id WHERE ii.invoice_id = p_invoice_id AND pr.track_inventory LOOP
    v_qty := COALESCE(v_item.base_quantity, v_item.quantity);
    v_target_wh := COALESCE(v_item.warehouse_id, v_default_wh);
    IF v_target_wh IS NOT NULL THEN
      UPDATE inventory_items SET quantity_on_hand = quantity_on_hand + v_qty, updated_at = now()
      WHERE product_id = v_item.product_id AND warehouse_id = v_target_wh;
      IF NOT FOUND THEN
        INSERT INTO inventory_items (product_id, warehouse_id, quantity_on_hand, quantity_reserved, quantity_incoming)
        VALUES (v_item.product_id, v_target_wh, v_qty, 0, 0);
      END IF;
      INSERT INTO stock_movements (product_id, warehouse_id, movement_type, quantity, unit_cost, reference_type, reference_id, reference_number, notes)
      VALUES (v_item.product_id, v_target_wh, 'return_in', v_qty, COALESCE(v_item.cost_price, 0), 'invoice_edit', p_invoice_id, v_invoice.invoice_number, 'Stock restoration - invoice edited');
    END IF;
  END LOOP;

  -- STEP 2: Reverse AR + Revenue journal entry (net of the invoice's VAT and shipping)
  v_old_tax := LEAST(COALESCE(v_invoice.tax_amount, 0), v_invoice.total_amount);
  v_old_shipping := LEAST(COALESCE(v_invoice.shipping_cost, 0), GREATEST(0, v_invoice.total_amount - v_old_tax));
  IF v_old_tax > 0 AND v_vat_account IS NULL THEN
    RAISE EXCEPTION 'Invoice % carries VAT (%) but VAT Payable account (2100) is missing', v_invoice.invoice_number, v_old_tax;
  END IF;
  IF v_old_shipping > 0 AND v_shipping_account IS NULL THEN
    RAISE EXCEPTION 'Invoice % carries shipping (%) but Shipping Income account (4020) is missing', v_invoice.invoice_number, v_old_shipping;
  END IF;
  IF v_ar_account IS NOT NULL AND v_revenue_account IS NOT NULL AND v_invoice.total_amount > 0 THEN
    v_lines := to_json(ARRAY[]::json[]);
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_ar_account, 'debit', 0, 'credit', v_invoice.total_amount, 'description', 'Reverse AR for edited invoice ' || v_invoice.invoice_number)))::json);
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_revenue_account, 'debit', v_invoice.total_amount - v_old_tax - v_old_shipping, 'credit', 0, 'description',
      CASE WHEN v_old_tax > 0 OR v_old_shipping > 0
           THEN 'Reverse revenue (net of VAT and shipping) for edited invoice ' || v_invoice.invoice_number
           ELSE 'Reverse revenue for edited invoice ' || v_invoice.invoice_number END)))::json);
    IF v_old_tax > 0 THEN
      v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
        'account_id', v_vat_account, 'debit', v_old_tax, 'credit', 0, 'description', 'Reverse VAT for edited invoice ' || v_invoice.invoice_number)))::json);
    END IF;
    IF v_old_shipping > 0 THEN
      v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
        'account_id', v_shipping_account, 'debit', v_old_shipping, 'credit', 0, 'description', 'Reverse shipping income for edited invoice ' || v_invoice.invoice_number)))::json);
    END IF;
    PERFORM post_journal_entry(
      'REVERSAL - AR - Invoice ' || v_invoice.invoice_number || ' EDIT', COALESCE(v_invoice.invoice_date, CURRENT_DATE), 'invoice_edit', p_invoice_id,
      v_lines, v_invoice.customer_id
    );
  END IF;

  -- STEP 3: Delete original COGS journal entries (including the Quick Sell
  -- Cost JE, so the edit below re-posts it from the new lines) and roll back
  -- account balances
  FOR v_je_id IN
    SELECT je.id FROM journal_entries je
    WHERE je.reference_type = 'invoice'
      AND je.reference_id = p_invoice_id
      AND (je.description LIKE 'COGS%' OR je.description LIKE 'Quick Sell Cost%')
  LOOP
    UPDATE accounts a SET balance = balance - (
      SELECT CASE WHEN a.account_type IN ('asset', 'expense')
                  THEN COALESCE(SUM(jl.debit - jl.credit), 0)
                  ELSE COALESCE(SUM(jl.credit - jl.debit), 0) END
      FROM journal_lines jl
      WHERE jl.journal_entry_id = v_je_id AND jl.account_id = a.id
    )
    WHERE EXISTS (SELECT 1 FROM journal_lines jl
                  WHERE jl.journal_entry_id = v_je_id AND jl.account_id = a.id);
    DELETE FROM journal_lines WHERE journal_entry_id = v_je_id;
    DELETE FROM journal_entries WHERE id = v_je_id;
  END LOOP;

  -- STEP 4: Reverse original payments AND mark them as reversed
  FOR v_payment IN SELECT * FROM payments WHERE reference_type = 'invoice' AND reference_id = p_invoice_id AND is_reversed = false LOOP
    INSERT INTO payments (payment_number, payment_type, payment_method, amount, payment_date, reference_type, reference_id, reference_number, notes, payment_for)
    VALUES ('REV-' || COALESCE(v_payment.payment_number, 'PAY'), CASE WHEN v_payment.payment_type = 'received' THEN 'refund' ELSE 'payment' END, v_payment.payment_method, v_payment.amount, CURRENT_DATE, 'invoice_edit', p_invoice_id, v_invoice.invoice_number, 'Reversal payment for edited invoice ' || v_invoice.invoice_number, 'reversal_payment');
    UPDATE payments SET is_reversed = true WHERE id = v_payment.id;
  END LOOP;

  -- Delete original payment journal entries and roll back account balances
  FOR v_je_id IN
    SELECT je.id FROM journal_entries je
    WHERE je.reference_type = 'payment'
      AND je.reference_id IN (SELECT id FROM payments WHERE reference_type = 'invoice' AND reference_id = p_invoice_id)
  LOOP
    UPDATE accounts a SET balance = balance - (
      SELECT CASE WHEN a.account_type IN ('asset', 'expense')
                  THEN COALESCE(SUM(jl.debit - jl.credit), 0)
                  ELSE COALESCE(SUM(jl.credit - jl.debit), 0) END
      FROM journal_lines jl
      WHERE jl.journal_entry_id = v_je_id AND jl.account_id = a.id
    )
    WHERE EXISTS (SELECT 1 FROM journal_lines jl
                  WHERE jl.journal_entry_id = v_je_id AND jl.account_id = a.id);
    DELETE FROM journal_lines WHERE journal_entry_id = v_je_id;
    DELETE FROM journal_entries WHERE id = v_je_id;
  END LOOP;

  -- STEP 5: Update invoice header (cost_payment_method preserved unless the
  -- edit payload supplies a new one)
  UPDATE invoices
  SET customer_id = v_new_customer, invoice_date = v_new_date, due_date = v_new_due_date, notes = v_new_notes,
      reference = v_new_reference,
      subtotal = v_new_subtotal, cart_discount_percent = v_new_cart_discount_percent, extra_discount = v_new_extra_discount,
      discount_amount = v_cart_discount_amount, total_amount = v_new_total, tax_amount = v_new_tax, shipping_cost = v_new_shipping, amount_paid = 0,
      cost_payment_method = COALESCE(v_new_cost_method, cost_payment_method),
      status = 'draft', edit_count = COALESCE(edit_count, 0) + 1, updated_at = now()
  WHERE id = p_invoice_id;

  -- STEP 5b: Set session flag to prevent DELETE trigger from double-restoring stock
  PERFORM set_config('app.edit_invoice_active', 'true', true);

  -- STEP 6: Re-insert items
  DELETE FROM invoice_items WHERE invoice_id = p_invoice_id;
  FOR v_i IN SELECT generate_series(0, json_array_length(v_new_items) - 1) LOOP
    v_new_item := v_new_items->v_i;
    INSERT INTO invoice_items (invoice_id, product_id, quantity, unit_price, cost_price, discount_percent, tax_rate, subtotal, unit_name, unit_conversion_factor, base_quantity, warehouse_id, source_shop, sort_order)
    VALUES (
      p_invoice_id,
      (v_new_item->>'product_id')::uuid,
      (v_new_item->>'quantity')::numeric,
      (v_new_item->>'unit_price')::numeric,
      COALESCE((v_new_item->>'cost_price')::numeric, 0),
      COALESCE((v_new_item->>'discount_percent')::numeric, 0),
      0,
      (v_new_item->>'quantity')::numeric * (v_new_item->>'unit_price')::numeric * (1 - COALESCE((v_new_item->>'discount_percent')::numeric, 0) / 100),
      NULLIF(v_new_item->>'unit_name', ''),
      NULLIF(v_new_item->>'unit_conversion_factor', '')::numeric,
      COALESCE((v_new_item->>'base_quantity')::numeric, (v_new_item->>'quantity')::numeric),
      NULLIF(v_new_item->>'warehouse_id', '')::uuid,
      NULLIF(v_new_item->>'source_shop', ''),
      v_i
    );
  END LOOP;

  -- Reset session flag
  PERFORM set_config('app.edit_invoice_active', 'false', true);

  -- STEP 6a: Re-record cost price history
  DELETE FROM cost_price_history WHERE invoice_id = p_invoice_id;
  FOR v_i IN SELECT generate_series(0, json_array_length(v_new_items) - 1) LOOP
    v_new_item := v_new_items->v_i;
    SELECT name, sku INTO v_product FROM products WHERE id = (v_new_item->>'product_id')::uuid;
    v_cost_per_unit := COALESCE((v_new_item->>'cost_price')::numeric, 0);
    v_qty := (v_new_item->>'quantity')::numeric;
    v_total_cost_added := v_cost_per_unit * v_qty;
    INSERT INTO cost_price_history (
      product_id, product_name, product_sku, invoice_id, unit, quantity,
      unit_price, cost_price_per_qty, cost_price_for_added_qty,
      total_cost_price_single, total_cost_price_added
    ) VALUES (
      (v_new_item->>'product_id')::uuid,
      COALESCE(v_product.name, 'Unknown'),
      COALESCE(v_product.sku, ''),
      p_invoice_id,
      COALESCE(NULLIF(v_new_item->>'unit_name', ''), 'pcs'),
      v_qty,
      (v_new_item->>'unit_price')::numeric,
      v_cost_per_unit,
      v_total_cost_added,
      v_cost_per_unit,
      v_total_cost_added
    );
  END LOOP;

  -- STEP 6b: Sync delivery_items
  FOR v_delivery IN SELECT id FROM deliveries WHERE invoice_id = p_invoice_id AND status != 'delivered' LOOP
    DELETE FROM delivery_items WHERE delivery_id = v_delivery.id;
    FOR v_i IN SELECT generate_series(0, json_array_length(v_new_items) - 1) LOOP
      v_new_item := v_new_items->v_i;
      INSERT INTO delivery_items (delivery_id, product_id, quantity, delivered_quantity, unit_name, base_quantity)
      VALUES (
        v_delivery.id,
        (v_new_item->>'product_id')::uuid,
        (v_new_item->>'quantity')::numeric,
        0,
        NULLIF(v_new_item->>'unit_name', ''),
        COALESCE((v_new_item->>'base_quantity')::numeric, (v_new_item->>'quantity')::numeric)
      );
    END LOOP;
  END LOOP;

  -- STEP 7: Re-post AR + Revenue for new total (revenue net of VAT and shipping).
  IF v_ar_account IS NOT NULL AND v_revenue_account IS NOT NULL AND v_new_total > 0 THEN
    IF v_new_tax > 0 AND v_vat_account IS NULL THEN
      RAISE EXCEPTION 'Edited invoice % carries VAT (%) but VAT Payable account (2100) is missing', v_invoice.invoice_number, v_new_tax;
    END IF;
    IF v_new_shipping > 0 AND v_shipping_account IS NULL THEN
      RAISE EXCEPTION 'Edited invoice % carries shipping (%) but Shipping Income account (4020) is missing', v_invoice.invoice_number, v_new_shipping;
    END IF;
    v_lines := to_json(ARRAY[]::json[]);
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_ar_account, 'debit', v_new_total, 'credit', 0, 'description', 'AR for edited invoice ' || v_invoice.invoice_number)))::json);
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_revenue_account, 'debit', 0, 'credit', v_new_total - v_new_tax - v_new_shipping, 'description',
      CASE WHEN v_new_tax > 0 OR v_new_shipping > 0
           THEN 'Revenue (net of VAT and shipping) for edited invoice ' || v_invoice.invoice_number
           ELSE 'Revenue for edited invoice ' || v_invoice.invoice_number END)))::json);
    IF v_new_tax > 0 THEN
      v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
        'account_id', v_vat_account, 'debit', 0, 'credit', v_new_tax, 'description', 'VAT payable for edited invoice ' || v_invoice.invoice_number)))::json);
    END IF;
    IF v_new_shipping > 0 THEN
      v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
        'account_id', v_shipping_account, 'debit', 0, 'credit', v_new_shipping, 'description', 'Shipping income for edited invoice ' || v_invoice.invoice_number)))::json);
    END IF;
    PERFORM post_journal_entry(
      'Accounts Receivable - Invoice ' || v_invoice.invoice_number || ' EDITED', v_new_date, 'invoice', p_invoice_id,
      v_lines, v_new_customer
    );
  END IF;

  -- STEP 7b: Post COGS journal entry for new items. Non-stock (quick-sell)
  -- items post through post_quick_sell_cost_je against the account the source
  -- shop was paid from — never Inventory 1200 — and are excluded from the
  -- no-FIFO fallback below.
  IF v_cogs_account IS NOT NULL AND v_inventory_account IS NOT NULL THEN
    DECLARE
      v_cogs_total decimal(15,2) := 0;
      v_has_fifo_data boolean := false;
      v_has_nonstock boolean := false;
    BEGIN
      SELECT EXISTS(
        SELECT 1 FROM invoice_items ii JOIN products pr ON pr.id = ii.product_id
         WHERE ii.invoice_id = p_invoice_id AND NOT pr.track_inventory
           AND ii.quantity > 0 AND COALESCE(ii.cost_price, 0) > 0
      ) INTO v_has_nonstock;
      IF v_has_nonstock THEN
        PERFORM post_quick_sell_cost_je(p_invoice_id);
      END IF;

      FOR v_item IN SELECT ii.*, p.name as product_name, p.sku FROM invoice_items ii JOIN products p ON ii.product_id = p.id WHERE ii.invoice_id = p_invoice_id ORDER BY ii.sort_order LOOP
        v_cost := 0;
        SELECT COALESCE(SUM(cogs_amount), 0) INTO v_cost
        FROM invoice_item_batch_consumption WHERE invoice_item_id = v_item.id;

        IF v_cost > 0 THEN
          v_cogs_total := v_cogs_total + v_cost;
          v_has_fifo_data := true;
        END IF;
      END LOOP;

      IF v_has_fifo_data AND v_cogs_total > 0 THEN
        PERFORM post_journal_entry(
          'COGS - ' || v_invoice.invoice_number,
          COALESCE(v_new_date, CURRENT_DATE),
          'invoice', p_invoice_id,
          json_build_array(
            json_build_object('account_id', v_cogs_account, 'debit', v_cogs_total, 'credit', 0,
              'description', 'COGS (FIFO) from consumption records'),
            json_build_object('account_id', v_inventory_account, 'debit', 0, 'credit', v_cogs_total,
              'description', 'Inventory released (FIFO)')
          )::json, v_new_customer
        );
      ELSE
        -- FALLBACK: stocked items without FIFO data only. Non-stock items are
        -- handled by post_quick_sell_cost_je above.
        v_cogs_total := 0;
        FOR v_item IN SELECT ii.*, p.name as product_name, p.sku FROM invoice_items ii JOIN products p ON ii.product_id = p.id WHERE ii.invoice_id = p_invoice_id AND p.track_inventory ORDER BY ii.sort_order LOOP
          v_qty := COALESCE(v_item.base_quantity, v_item.quantity);
          v_cost := COALESCE(v_item.cost_price, 0) * v_qty;
          IF v_cost > 0 THEN
            v_cogs_total := v_cogs_total + v_cost;
          END IF;
        END LOOP;

        IF v_cogs_total > 0 THEN
          PERFORM post_journal_entry(
            'COGS - ' || v_invoice.invoice_number,
            COALESCE(v_new_date, CURRENT_DATE),
            'invoice', p_invoice_id,
            json_build_array(
              json_build_object('account_id', v_cogs_account, 'debit', v_cogs_total, 'credit', 0,
                'description', 'COGS (fallback: cost_price × quantity)'),
              json_build_object('account_id', v_inventory_account, 'debit', 0, 'credit', v_cogs_total,
                'description', 'Inventory released (fallback)')
            )::json, v_new_customer
          );
        END IF;
      END IF;
    END;
  END IF;

  -- STEP 8: Apply new payment term
  IF v_new_payment_term = 'credit' THEN
    UPDATE invoices SET status = 'sent', amount_paid = 0 WHERE id = p_invoice_id;
  ELSIF v_new_payment_term = 'partial' THEN
    v_new_partial_amount := LEAST(v_new_partial_amount, v_new_total);
    IF v_new_partial_amount > 0 THEN
      INSERT INTO payments (payment_number, payment_type, payment_method, amount, payment_date, reference_type, reference_id, reference_number, notes, payment_for)
      VALUES ('EDIT-' || v_invoice.invoice_number, 'received', v_new_payment_method, v_new_partial_amount, v_new_date, 'invoice', p_invoice_id, v_invoice.invoice_number, 'Partial payment for edited invoice ' || v_invoice.invoice_number, 'paid_invoice_pay')
      RETURNING id INTO v_new_payment_id;
      IF v_cash_account IS NOT NULL AND v_ar_account IS NOT NULL THEN
        PERFORM post_journal_entry(
          'Payment - Invoice ' || v_invoice.invoice_number || ' EDITED', v_new_date, 'payment', v_new_payment_id,
          json_build_array(
            json_build_object('account_id', v_cash_account, 'debit', v_new_partial_amount, 'credit', 0, 'description', 'Partial payment received for ' || v_invoice.invoice_number),
            json_build_object('account_id', v_ar_account, 'debit', 0, 'credit', v_new_partial_amount, 'description', 'AR cleared for ' || v_invoice.invoice_number)
          )::json, v_new_customer
        );
      END IF;
      UPDATE invoices SET status = 'partially_paid', amount_paid = v_new_partial_amount WHERE id = p_invoice_id;
    ELSE
      UPDATE invoices SET status = 'sent', amount_paid = 0 WHERE id = p_invoice_id;
    END IF;
  ELSE
    IF v_new_total > 0 THEN
      INSERT INTO payments (payment_number, payment_type, payment_method, amount, payment_date, reference_type, reference_id, reference_number, notes, payment_for)
      VALUES ('EDIT-' || v_invoice.invoice_number, 'received', v_new_payment_method, v_new_total, v_new_date, 'invoice', p_invoice_id, v_invoice.invoice_number, 'Payment for edited invoice ' || v_invoice.invoice_number, 'paid_invoice_pay')
      RETURNING id INTO v_new_payment_id;
      IF v_cash_account IS NOT NULL AND v_ar_account IS NOT NULL THEN
        PERFORM post_journal_entry(
          'Payment - Invoice ' || v_invoice.invoice_number || ' EDITED', v_new_date, 'payment', v_new_payment_id,
          json_build_array(
            json_build_object('account_id', v_cash_account, 'debit', v_new_total, 'credit', 0, 'description', 'Payment received for ' || v_invoice.invoice_number),
            json_build_object('account_id', v_ar_account, 'debit', 0, 'credit', v_new_total, 'description', 'AR cleared for ' || v_invoice.invoice_number)
          )::json, v_new_customer
        );
      END IF;
      UPDATE invoices SET status = 'paid', amount_paid = v_new_total WHERE id = p_invoice_id;
    ELSE
      UPDATE invoices SET status = 'paid', amount_paid = 0 WHERE id = p_invoice_id;
    END IF;
  END IF;

  -- STEP 9: Record edit history
  SELECT json_build_object('customer_id', v_new_customer, 'invoice_date', v_new_date, 'due_date', v_new_due_date, 'notes', v_new_notes, 'reference', v_new_reference, 'subtotal', v_new_subtotal, 'cart_discount_percent', v_new_cart_discount_percent, 'extra_discount', v_new_extra_discount, 'shipping_cost', v_new_shipping, 'total_amount', v_new_total, 'payment_term', v_new_payment_term, 'payment_method', v_new_payment_method, 'items', v_new_items) INTO v_new_snapshot;

  INSERT INTO invoice_edit_history (invoice_id, invoice_number, edited_by_name, change_type, reason, snapshot_before, snapshot_after, old_value, new_value)
  VALUES (p_invoice_id, v_invoice.invoice_number, p_edited_by, 'full_edit', p_reason, v_old_snapshot, v_new_snapshot, v_old_snapshot, v_new_snapshot);

  -- STEP 10: Update customer outstanding_balance
  IF v_invoice.customer_id IS NOT NULL THEN
    UPDATE customers SET outstanding_balance = (SELECT COALESCE(SUM(balance_due), 0) FROM invoices WHERE customer_id = v_invoice.customer_id AND status IN ('sent', 'partially_paid', 'unpaid', 'overdue')), updated_at = now() WHERE id = v_invoice.customer_id;
  END IF;
  IF v_new_customer IS NOT NULL AND v_new_customer <> v_invoice.customer_id THEN
    UPDATE customers SET outstanding_balance = (SELECT COALESCE(SUM(balance_due), 0) FROM invoices WHERE customer_id = v_new_customer AND status IN ('sent', 'partially_paid', 'unpaid', 'overdue')), updated_at = now() WHERE id = v_new_customer;
  END IF;

  RETURN json_build_object('success', true, 'invoice_id', p_invoice_id, 'old_total', v_invoice.total_amount, 'new_total', v_new_total);
END;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7) cancel_invoice: reverse the quick-sell cost portion against the account
--    the source shop was paid from (not Inventory 1200), and skip stock
--    restore for non-stock items. Full re-create of the live 20260909100000
--    version + the split.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.cancel_invoice(p_invoice_id uuid, p_reason text, p_cancelled_by text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_invoice invoices%ROWTYPE;
  v_ar_account uuid;
  v_revenue_account uuid;
  v_cogs_account uuid;
  v_inventory_account uuid;
  v_default_wh uuid;
  v_item RECORD;
  v_qty numeric;
  v_cost numeric;
  v_payment RECORD;
  v_payment_account uuid;
  v_total_payments numeric := 0;
  v_has_deliveries boolean;
  v_je_id uuid;
  v_sr RECORD;
  v_returned_qty numeric;
  v_rev_pay_num text;
  v_cogs_total decimal(15,2) := 0;
  v_qs_cogs decimal(15,2) := 0;
  v_stocked_cogs decimal(15,2) := 0;
  v_paid_account uuid;
  v_stock_restored boolean := false;
  v_journal_reversed boolean := false;
  v_vat_account uuid;
  v_vat numeric := 0;
  v_shipping_account uuid;
  v_shipping numeric := 0;
  v_lines json;
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
      'journal_reversed', false
    );
  END IF;

  -- Accounts
  SELECT id INTO v_ar_account FROM accounts WHERE code = '1100' LIMIT 1;
  SELECT id INTO v_revenue_account FROM accounts WHERE code = '4000' LIMIT 1;
  SELECT id INTO v_cogs_account FROM accounts WHERE code = '5000' LIMIT 1;
  SELECT id INTO v_inventory_account FROM accounts WHERE code = '1200' LIMIT 1;
  SELECT id INTO v_vat_account FROM accounts WHERE code = '2100' LIMIT 1;
  SELECT id INTO v_shipping_account FROM accounts WHERE code = '4020' LIMIT 1;
  SELECT id INTO v_default_wh FROM warehouses WHERE is_default = true LIMIT 1;

  -- Reverse AR and Revenue (net of the invoice's VAT and shipping)
  v_vat := LEAST(COALESCE(v_invoice.tax_amount, 0), v_invoice.total_amount);
  v_shipping := LEAST(COALESCE(v_invoice.shipping_cost, 0), GREATEST(0, v_invoice.total_amount - v_vat));
  IF v_vat > 0 AND v_vat_account IS NULL THEN
    RAISE EXCEPTION 'Invoice % carries VAT (%) but VAT Payable account (2100) is missing', v_invoice.invoice_number, v_vat;
  END IF;
  IF v_shipping > 0 AND v_shipping_account IS NULL THEN
    RAISE EXCEPTION 'Invoice % carries shipping (%) but Shipping Income account (4020) is missing', v_invoice.invoice_number, v_shipping;
  END IF;
  IF v_ar_account IS NOT NULL AND v_revenue_account IS NOT NULL THEN
    v_lines := to_json(ARRAY[]::json[]);
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_revenue_account, 'debit', v_invoice.total_amount - v_vat - v_shipping, 'credit', 0,
      'description', CASE WHEN v_vat > 0 OR v_shipping > 0
                          THEN 'Reverse revenue (net of VAT and shipping) for cancelled ' || v_invoice.invoice_number
                          ELSE 'Reverse revenue for cancelled ' || v_invoice.invoice_number END)))::json);
    IF v_vat > 0 THEN
      v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
        'account_id', v_vat_account, 'debit', v_vat, 'credit', 0,
        'description', 'Reverse VAT for cancelled ' || v_invoice.invoice_number)))::json);
    END IF;
    IF v_shipping > 0 THEN
      v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
        'account_id', v_shipping_account, 'debit', v_shipping, 'credit', 0,
        'description', 'Reverse shipping income for cancelled ' || v_invoice.invoice_number)))::json);
    END IF;
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_ar_account, 'debit', 0, 'credit', v_invoice.total_amount,
      'description', 'Reverse AR for cancelled ' || v_invoice.invoice_number)))::json);
    PERFORM post_journal_entry(
      'Reverse AR/Revenue - Cancelled ' || v_invoice.invoice_number,
      COALESCE(v_invoice.invoice_date, CURRENT_DATE),
      'invoice_cancel',
      p_invoice_id,
      v_lines,
      v_invoice.customer_id
    );
    v_journal_reversed := true;
  END IF;

  -- COGS reversal amount: from POSTED COGS JEs (net of reversals). Includes
  -- the Quick Sell Cost JE (no description filter — account-5000 lines only).
  SELECT COALESCE(SUM(jl.debit - jl.credit), 0) INTO v_cogs_total
  FROM journal_lines jl
  JOIN journal_entries je ON je.id = jl.journal_entry_id
  JOIN accounts a ON a.id = jl.account_id
  WHERE je.reference_type IN ('invoice', 'invoice_edit')
    AND je.reference_id = p_invoice_id
    AND a.code = '5000'
    AND je.is_posted = true;

  IF v_cogs_total = 0 THEN
    SELECT COALESCE(SUM(cogs_amount), 0) INTO v_cogs_total
    FROM invoice_item_batch_consumption
    WHERE invoice_item_id IN (SELECT id FROM invoice_items WHERE invoice_id = p_invoice_id);
  END IF;
  IF v_cogs_total = 0 THEN
    FOR v_item IN SELECT ii.* FROM invoice_items ii JOIN products pr ON pr.id = ii.product_id WHERE ii.invoice_id = p_invoice_id LOOP
      v_cogs_total := v_cogs_total + (COALESCE(v_item.cost_price, 0) * COALESCE(v_item.quantity, 0));
    END LOOP;
  END IF;

  -- Split the reversal: the quick-sell portion was credited to the account
  -- the source shop was paid from; only the stocked portion restores 1200.
  SELECT COALESCE(SUM(ii.quantity * ii.cost_price), 0) INTO v_qs_cogs
  FROM invoice_items ii JOIN products pr ON pr.id = ii.product_id
  WHERE ii.invoice_id = p_invoice_id AND NOT pr.track_inventory AND ii.quantity > 0;
  v_qs_cogs := LEAST(ROUND(v_qs_cogs, 2), v_cogs_total);
  v_stocked_cogs := v_cogs_total - v_qs_cogs;
  IF v_qs_cogs > 0 THEN
    v_paid_account := quick_sell_cost_account(v_invoice.cost_payment_method);
    IF v_paid_account IS NULL THEN
      RAISE EXCEPTION 'Cannot reverse quick-sell cost for cancelled %: paid-from account unavailable', v_invoice.invoice_number;
    END IF;
  END IF;

  IF v_cogs_account IS NOT NULL AND v_cogs_total > 0
     AND (v_stocked_cogs <= 0 OR v_inventory_account IS NOT NULL) THEN
    v_lines := to_json(ARRAY[]::json[]);
    IF v_stocked_cogs > 0 THEN
      v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
        'account_id', v_inventory_account, 'debit', v_stocked_cogs, 'credit', 0,
        'description', 'Restore inventory for cancelled ' || v_invoice.invoice_number)))::json);
    END IF;
    IF v_qs_cogs > 0 THEN
      v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
        'account_id', v_paid_account, 'debit', v_qs_cogs, 'credit', 0,
        'description', 'Restore source-shop payment for cancelled ' || v_invoice.invoice_number)))::json);
    END IF;
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_cogs_account, 'debit', 0, 'credit', v_cogs_total,
      'description', 'Reverse COGS for cancelled ' || v_invoice.invoice_number)))::json);
    PERFORM post_journal_entry(
      'Reverse COGS - Cancelled ' || v_invoice.invoice_number,
      COALESCE(v_invoice.invoice_date, CURRENT_DATE),
      'invoice_cancel',
      p_invoice_id,
      v_lines,
      v_invoice.customer_id
    );
    v_journal_reversed := true;
  END IF;

  -- Restore stock + record stock movements (STOCKED items only)
  FOR v_item IN SELECT ii.* FROM invoice_items ii JOIN products pr ON pr.id = ii.product_id WHERE ii.invoice_id = p_invoice_id AND pr.track_inventory LOOP
    v_qty := COALESCE(v_item.base_quantity, v_item.quantity);
    UPDATE inventory_items
    SET quantity_on_hand = quantity_on_hand + v_qty,
        updated_at = now()
    WHERE product_id = v_item.product_id
      AND warehouse_id = COALESCE(v_item.warehouse_id, v_default_wh);

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
      'Stock restored on cancel: ' || p_reason
    );
  END LOOP;
  v_stock_restored := true;

  -- FIFO: Restore batch quantities for all invoice items (restore_fifo is a
  -- natural no-op for non-stock items — they have no consumption rows)
  FOR v_item IN SELECT * FROM invoice_items WHERE invoice_id = p_invoice_id LOOP
    PERFORM restore_fifo(v_item.id);
  END LOOP;

  -- Restore advance applications.
  WITH restored AS (
    DELETE FROM customer_advance_applications
     WHERE invoice_id = p_invoice_id
    RETURNING advance_id, amount
  )
  UPDATE customer_advances ca
     SET balance = ca.balance + r.amount,
         status = CASE WHEN ca.status = 'applied' THEN 'active' ELSE ca.status END,
         updated_at = now()
    FROM restored r
   WHERE ca.id = r.advance_id;

  -- Cancel payments
  FOR v_payment IN SELECT * FROM payments WHERE reference_type = 'invoice' AND reference_id = p_invoice_id AND is_reversed = false LOOP
    v_total_payments := v_total_payments + v_payment.amount;
    UPDATE payments SET is_reversed = true, updated_at = now() WHERE id = v_payment.id;

    SELECT 'RVP-' || COALESCE(MAX(CAST(SUBSTRING(payment_number FROM 5) AS INTEGER)) + 1, 1)
    INTO v_rev_pay_num FROM payments WHERE payment_number LIKE 'RVP-%';

    INSERT INTO payments (payment_number, payment_type, reference_type, reference_id, customer_id, supplier_id,
    amount, payment_method, payment_date, reference_number, notes)
    VALUES (
      v_rev_pay_num, 'refund', 'invoice', p_invoice_id, v_payment.customer_id, v_payment.supplier_id,
      v_payment.amount, v_payment.payment_method, CURRENT_DATE, v_payment.payment_number,
      'Auto-refund on invoice cancellation'
    );

    IF v_ar_account IS NOT NULL AND COALESCE(v_payment.amount, 0) > 0 THEN
      SELECT pm.account_id INTO v_payment_account
      FROM payment_methods pm
      WHERE pm.code = v_payment.payment_method AND pm.is_active = true
      LIMIT 1;
      IF v_payment_account IS NULL THEN
        SELECT id INTO v_payment_account FROM accounts WHERE code = '1001' LIMIT 1;
      END IF;

      IF v_payment_account IS NOT NULL THEN
        PERFORM post_journal_entry(
          'Reverse Payment - Cancelled ' || v_invoice.invoice_number,
          COALESCE(v_invoice.invoice_date, CURRENT_DATE),
          'invoice_cancel',
          p_invoice_id,
          json_build_array(
            json_build_object('account_id', v_ar_account, 'debit', v_payment.amount, 'credit', 0,
              'description', 'Restore AR for reversed payment ' || v_payment.payment_number),
            json_build_object('account_id', v_payment_account, 'debit', 0, 'credit', v_payment.amount,
              'description', 'Refund ' || v_payment.payment_number || ' for cancelled ' || v_invoice.invoice_number)
          )::json,
          v_invoice.customer_id
        );
        v_journal_reversed := true;
      END IF;
    END IF;
  END LOOP;

  -- Mark invoice cancelled
  UPDATE invoices
  SET status = 'cancelled', amount_paid = 0, total_amount = 0, subtotal = 0, bad_debt_amount = 0, updated_at = now()
  WHERE id = p_invoice_id;

  -- Audit history
  INSERT INTO invoice_edit_history (
    invoice_id, invoice_number, edited_by_name, change_type, reason,
    snapshot_before, snapshot_after
  ) VALUES (
    p_invoice_id, v_invoice.invoice_number, p_cancelled_by, 'cancelled', p_reason,
    json_build_object('status', v_invoice.status, 'total_amount', v_invoice.total_amount, 'amount_paid', v_invoice.amount_paid),
    json_build_object('status', 'cancelled')
  );

  RETURN json_build_object(
    'success', true,
    'message', 'Invoice cancelled successfully',
    'invoice_number', v_invoice.invoice_number,
    'cogs_reversed', v_cogs_total,
    'payments_reversed', v_total_payments,
    'stock_restored', v_stock_restored,
    'journal_reversed', v_journal_reversed
  );
END;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 8) record_sales_return: non-stock items reverse COGS against the paid-from
--    account (not Inventory 1200) and skip FIFO restore / stock movements /
--    counter updates. Full re-create of the live 20260913120000 version +
--    the split and skips.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.record_sales_return(p_invoice_id uuid, p_refund_method text, p_refund_account_id uuid DEFAULT NULL::uuid, p_items json DEFAULT NULL::json, p_created_by uuid DEFAULT NULL::uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid := '00000000-0000-0000-0000-000000000001';
  v_invoice record;
  v_item json;
  v_it record;
  v_conversion numeric;
  v_base_qty numeric;
  v_fifo_cogs numeric;
  v_fifo_qty numeric;
  v_cost_per_base numeric;
  v_total_refund numeric := 0;
  v_total_cogs numeric := 0;
  v_qs_cogs numeric := 0;
  v_stocked_cogs numeric := 0;
  v_nonstock boolean;
  v_existing_refunds numeric;
  v_capped_refund numeric;
  v_vat_portion numeric := 0;
  v_shipping_portion numeric := 0;
  v_max_refundable numeric;
  v_return_id uuid;
  v_return_number text;
  v_je_id uuid;
  v_payment_id uuid;
  v_credit_account uuid;
  v_ar_account uuid;
  v_inv_account uuid;
  v_cogs_account uuid;
  v_sr_account uuid;
  v_vat_account uuid;
  v_shipping_account uuid;
  v_paid_account uuid;
  v_lines json;
  v_new_refunded numeric;
  v_new_status text;
  v_wh uuid;
  v_inv_item record;
BEGIN
  SELECT * INTO v_invoice FROM invoices WHERE id = p_invoice_id;
  IF v_invoice.id IS NULL THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;
  IF v_invoice.status = 'cancelled' THEN
    RAISE EXCEPTION 'Cannot return items on a cancelled invoice';
  END IF;
  IF p_items IS NULL OR json_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'At least one item with quantity > 0 is required';
  END IF;

  SELECT COALESCE(SUM(total_refund_amount), 0) INTO v_existing_refunds
  FROM sales_returns
  WHERE invoice_id = p_invoice_id AND status <> 'void';

  -- Validate items and compute refund + COGS totals from server data.
  FOR v_item IN SELECT * FROM json_array_elements(p_items) LOOP
    IF COALESCE((v_item->>'quantity')::numeric, 0) <= 0 THEN
      CONTINUE;
    END IF;
    SELECT * INTO v_it FROM invoice_items WHERE id = (v_item->>'invoice_item_id')::uuid AND invoice_id = p_invoice_id;
    IF v_it.id IS NULL THEN
      RAISE EXCEPTION 'Invoice item % not found on this invoice', v_item->>'invoice_item_id';
    END IF;
    SELECT COALESCE(NOT pr.track_inventory, false) INTO v_nonstock
    FROM products pr WHERE pr.id = v_it.product_id;

    v_conversion := CASE
      WHEN v_it.quantity > 0 AND v_it.base_quantity > 0 THEN v_it.base_quantity / v_it.quantity
      ELSE GREATEST(COALESCE(v_it.unit_conversion_factor, 0), 1)
    END;
    v_base_qty := (v_item->>'quantity')::numeric * v_conversion;

    SELECT COALESCE(SUM(cogs_amount), 0), COALESCE(SUM(quantity_consumed), 0)
    INTO v_fifo_cogs, v_fifo_qty
    FROM invoice_item_batch_consumption
    WHERE invoice_item_id = v_it.id;

    -- Non-stock (quick-sell) items have no consumption rows: the original
    -- line cost IS the cost (per sale unit / conversion).
    v_cost_per_base := CASE
      WHEN v_fifo_qty > 0 THEN v_fifo_cogs / v_fifo_qty
      ELSE COALESCE(v_it.cost_price, 0) / v_conversion
    END;

    v_total_refund := v_total_refund
      + (v_item->>'quantity')::numeric * v_it.unit_price * (1 - COALESCE(v_it.discount_percent, 0) / 100);
    v_total_cogs := v_total_cogs + v_base_qty * v_cost_per_base;
    IF v_nonstock THEN
      v_qs_cogs := v_qs_cogs + v_base_qty * v_cost_per_base;
    END IF;
  END LOOP;

  IF v_total_refund <= 0 THEN
    RAISE EXCEPTION 'Refund amount is zero';
  END IF;

  v_max_refundable := GREATEST(0, COALESCE(v_invoice.amount_paid, 0) - v_existing_refunds);
  v_capped_refund := LEAST(v_total_refund, v_max_refundable);
  IF v_capped_refund <= 0 THEN
    RAISE EXCEPTION 'Refund amount (%) exceeds refundable (%) — on-credit sale with no payment received, or previous refunds already processed', v_total_refund, v_max_refundable;
  END IF;

  SELECT id INTO v_sr_account FROM accounts WHERE code = '4050' LIMIT 1;
  SELECT id INTO v_ar_account FROM accounts WHERE code = '1100' LIMIT 1;
  SELECT id INTO v_inv_account FROM accounts WHERE code = '1200' LIMIT 1;
  SELECT id INTO v_cogs_account FROM accounts WHERE code = '5000' LIMIT 1;
  IF v_sr_account IS NULL OR v_ar_account IS NULL OR v_inv_account IS NULL OR v_cogs_account IS NULL THEN
    RAISE EXCEPTION 'Required accounts (4050/1100/1200/5000) not found';
  END IF;
  SELECT id INTO v_vat_account FROM accounts WHERE code = '2100' LIMIT 1;
  SELECT id INTO v_shipping_account FROM accounts WHERE code = '4020' LIMIT 1;

  IF p_refund_method = 'store_credit' THEN
    SELECT id INTO v_credit_account FROM accounts WHERE code = '2200' LIMIT 1;
    v_credit_account := COALESCE(v_credit_account, v_ar_account);
  ELSIF p_refund_account_id IS NOT NULL THEN
    v_credit_account := p_refund_account_id;
  ELSE
    v_credit_account := v_ar_account;
  END IF;

  SELECT generate_sales_return_number() INTO v_return_number;
  v_return_number := COALESCE(v_return_number, 'SR-' || to_char(clock_timestamp(), 'YYMMDDHH24MISS'));

  SELECT id INTO v_wh FROM warehouses WHERE is_default AND is_active LIMIT 1;
  v_wh := COALESCE(v_wh, '11000000-0000-0000-0000-000000000001');

  INSERT INTO sales_returns (tenant_id, return_number, invoice_id, customer_id, return_date,
                             total_refund_amount, refund_method, status, created_by)
  VALUES (v_tenant, v_return_number, p_invoice_id, v_invoice.customer_id, CURRENT_DATE,
          v_capped_refund, COALESCE(p_refund_method, 'store_credit'), 'completed', p_created_by)
  RETURNING id INTO v_return_id;

  v_vat_portion := CASE
    WHEN COALESCE(v_invoice.tax_amount, 0) > 0 AND v_invoice.total_amount > 0
    THEN round(v_capped_refund * v_invoice.tax_amount / v_invoice.total_amount, 2)
    ELSE 0 END;
  IF v_vat_portion > 0 AND v_vat_account IS NULL THEN
    RAISE EXCEPTION 'Invoice % carries VAT but VAT Payable account (2100) is missing', v_invoice.invoice_number;
  END IF;

  v_shipping_portion := CASE
    WHEN COALESCE(v_invoice.shipping_cost, 0) > 0 AND v_invoice.total_amount > 0
    THEN round(v_capped_refund * v_invoice.shipping_cost / v_invoice.total_amount, 2)
    ELSE 0 END;
  IF v_shipping_portion > 0 AND v_shipping_account IS NULL THEN
    RAISE EXCEPTION 'Invoice % carries shipping but Shipping Income account (4020) is missing', v_invoice.invoice_number;
  END IF;

  v_lines := to_json(ARRAY[]::json[]);
  IF v_vat_portion > 0 THEN
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_sr_account, 'debit', v_capped_refund - v_vat_portion - v_shipping_portion, 'credit', 0,
      'description', 'Sales Return (net of VAT and shipping) - ' || v_return_number)))::json);
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_vat_account, 'debit', v_vat_portion, 'credit', 0,
      'description', 'VAT reversal for return ' || v_return_number)))::json);
  ELSE
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_sr_account, 'debit', v_capped_refund - v_shipping_portion, 'credit', 0,
      'description', 'Sales Return - ' || v_return_number)))::json);
  END IF;
  IF v_shipping_portion > 0 THEN
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_shipping_account, 'debit', v_shipping_portion, 'credit', 0,
      'description', 'Shipping reversal for return ' || v_return_number)))::json);
  END IF;
  v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
    'account_id', v_credit_account, 'debit', 0, 'credit', v_capped_refund,
    'description', CASE WHEN p_refund_method = 'store_credit' THEN 'Customer Store Credit' ELSE 'Refund via ' || COALESCE(p_refund_method, 'payment') END)))::json);
  IF v_total_cogs > 0 THEN
    -- Quick-sell portion was credited to the paid-from account, not 1200.
    v_stocked_cogs := ROUND(v_total_cogs - v_qs_cogs, 2);
    IF v_stocked_cogs > 0 THEN
      v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
        'account_id', v_inv_account, 'debit', v_stocked_cogs, 'credit', 0,
        'description', 'Inventory restored from return')))::json);
    END IF;
    IF v_qs_cogs > 0 THEN
      v_paid_account := quick_sell_cost_account(v_invoice.cost_payment_method);
      IF v_paid_account IS NULL THEN
        RAISE EXCEPTION 'Cannot reverse quick-sell cost for return %: paid-from account unavailable', v_return_number;
      END IF;
      v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
        'account_id', v_paid_account, 'debit', ROUND(v_qs_cogs, 2), 'credit', 0,
        'description', 'Reverse source-shop payment for returned quick-sell items')))::json);
    END IF;
    v_lines := to_json((v_lines::jsonb || jsonb_build_array(json_build_object(
      'account_id', v_cogs_account, 'debit', 0, 'credit', v_total_cogs,
      'description', 'COGS reversal for returned items')))::json);
  END IF;

  v_je_id := post_journal_entry(
    'Sales Return ' || v_return_number || ' - Invoice ' || v_invoice.invoice_number,
    CURRENT_DATE,
    'sales_return',
    v_return_id,
    v_lines,
    v_invoice.customer_id,
    NULL
  );

  UPDATE sales_returns SET journal_entry_id = v_je_id WHERE id = v_return_id;

  IF p_refund_method <> 'store_credit' THEN
    INSERT INTO payments (payment_number, payment_type, reference_type, reference_id,
                          customer_id, amount, payment_method, payment_date, notes)
    VALUES (COALESCE(generate_payment_number(), 'PAY-' || to_char(clock_timestamp(), 'YYMMDDHH24MISS')),
            'refund', 'refund', v_je_id, v_invoice.customer_id, v_capped_refund,
            COALESCE(p_refund_method, 'cash'), CURRENT_DATE,
            'Refund for sales return ' || v_return_number)
    RETURNING id INTO v_payment_id;

    UPDATE sales_returns SET payment_id = v_payment_id WHERE id = v_return_id;
  END IF;

  -- Items: return rows, FIFO restore (batch-accurate), movements, counters.
  -- Non-stock items record the return row ONLY — no batch restore (would
  -- fabricate a positive layer), no stock movement, no counter update.
  FOR v_item IN SELECT * FROM json_array_elements(p_items) LOOP
    IF COALESCE((v_item->>'quantity')::numeric, 0) <= 0 THEN
      CONTINUE;
    END IF;
    SELECT * INTO v_it FROM invoice_items WHERE id = (v_item->>'invoice_item_id')::uuid;
    SELECT COALESCE(NOT pr.track_inventory, false) INTO v_nonstock
    FROM products pr WHERE pr.id = v_it.product_id;

    v_conversion := CASE
      WHEN v_it.quantity > 0 AND v_it.base_quantity > 0 THEN v_it.base_quantity / v_it.quantity
      ELSE GREATEST(COALESCE(v_it.unit_conversion_factor, 0), 1)
    END;
    v_base_qty := (v_item->>'quantity')::numeric * v_conversion;

    SELECT COALESCE(SUM(cogs_amount), 0), COALESCE(SUM(quantity_consumed), 0)
    INTO v_fifo_cogs, v_fifo_qty
    FROM invoice_item_batch_consumption
    WHERE invoice_item_id = v_it.id;

    v_cost_per_base := CASE
      WHEN v_fifo_qty > 0 THEN v_fifo_cogs / v_fifo_qty
      ELSE COALESCE(v_it.cost_price, 0) / v_conversion
    END;

    INSERT INTO sales_return_items (sales_return_id, invoice_item_id, product_id,
                                    quantity_returned, base_quantity_returned, unit_price,
                                    discount_percent, cost_price, subtotal, reason)
    VALUES (v_return_id, v_it.id, v_it.product_id,
            (v_item->>'quantity')::numeric, v_base_qty, v_it.unit_price,
            COALESCE(v_it.discount_percent, 0), v_cost_per_base * v_conversion,
            (v_item->>'quantity')::numeric * v_it.unit_price * (1 - COALESCE(v_it.discount_percent, 0) / 100),
            COALESCE(NULLIF(v_item->>'reason', ''), 'Not specified'));

    IF NOT v_nonstock THEN
      PERFORM restore_fifo_on_return(v_it.id, v_it.product_id, v_wh, v_base_qty,
                                     v_cost_per_base, v_return_id, v_return_number);

      INSERT INTO stock_movements (tenant_id, product_id, warehouse_id, movement_type,
                                   quantity, unit_cost, reference_type, reference_id,
                                   reference_number, notes)
      VALUES (v_tenant, v_it.product_id, v_wh, 'return_in', v_base_qty, v_cost_per_base,
              'sales_return', v_return_id, v_return_number,
              COALESCE(NULLIF(v_item->>'reason', ''), 'Return from invoice ' || v_invoice.invoice_number));

      SELECT ii.id INTO v_inv_item FROM inventory_items ii
      WHERE ii.product_id = v_it.product_id AND ii.warehouse_id = v_wh LIMIT 1;
      IF v_inv_item.id IS NOT NULL THEN
        UPDATE inventory_items
        SET quantity_on_hand = quantity_on_hand + v_base_qty, updated_at = now()
        WHERE id = v_inv_item.id;
      ELSE
        INSERT INTO inventory_items (tenant_id, product_id, warehouse_id, quantity_on_hand)
        VALUES (v_tenant, v_it.product_id, v_wh, v_base_qty);
      END IF;
    END IF;
  END LOOP;

  v_new_refunded := COALESCE(v_invoice.refunded_amount, 0) + v_capped_refund;
  v_new_status := CASE
    WHEN v_new_refunded >= COALESCE(v_invoice.total_amount, 0) THEN 'refunded'
    WHEN COALESCE(v_invoice.total_amount, 0) - COALESCE(v_invoice.bad_debt_amount, 0) - COALESCE(v_invoice.amount_paid, 0) <= 0 THEN 'paid'
    WHEN COALESCE(v_invoice.amount_paid, 0) > 0 THEN 'partially_paid'
    ELSE 'sent'
  END;
  UPDATE invoices SET refunded_amount = v_new_refunded, status = v_new_status, updated_at = now()
  WHERE id = p_invoice_id;

  IF p_refund_method = 'store_credit' AND v_invoice.customer_id IS NOT NULL THEN
    INSERT INTO customer_store_credits (customer_id, sales_return_id, credit_number,
                                        amount, balance, status, notes)
    VALUES (v_invoice.customer_id, v_return_id,
            COALESCE(generate_credit_number(), 'SC-' || to_char(clock_timestamp(), 'YYMMDDHH24MISS')),
            v_capped_refund, v_capped_refund, 'active',
            'Store credit from return ' || v_return_number || ' (Invoice ' || v_invoice.invoice_number || ')');
  END IF;

  RETURN json_build_object(
    'return_id', v_return_id,
    'return_number', v_return_number,
    'journal_entry_id', v_je_id,
    'refund_amount', v_capped_refund,
    'cogs_reversal', v_total_cogs
  );
END $function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 9) get_batch_stock_by_product_warehouse: never report batch stock for
--    non-stock products (defense in depth — the oversell gate also skips
--    them client-side; without this, a non-stock product reads "ledger 0"
--    and could fire the POS bothEmpty hard block if it ever lands in a
--    normal cart).
-- ═══════════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS get_batch_stock_by_product_warehouse(uuid[]);

CREATE FUNCTION get_batch_stock_by_product_warehouse(p_product_ids uuid[] DEFAULT NULL)
RETURNS TABLE (product_id uuid, warehouse_id uuid, qty numeric)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT b.product_id, b.warehouse_id, SUM(b.quantity_remaining)
  FROM inventory_batches b
  JOIN products p ON p.id = b.product_id AND p.track_inventory
  WHERE p_product_ids IS NULL OR b.product_id = ANY(p_product_ids)
  GROUP BY b.product_id, b.warehouse_id;
$$;

GRANT EXECUTE ON FUNCTION get_batch_stock_by_product_warehouse(uuid[]) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 10) get_cogs_audit: include Quick Sell Cost JEs in the journal side and
--     treat the non-stock items' manual cost as the FIFO-side expectation
--     (there is no FIFO by design), so quick-sell invoices audit as CONSISTENT
--     instead of drifted. Full re-create of the live 20260901010000 version
--     with those three changes + an is_quick_sell output column.
-- ═══════════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS get_cogs_audit();

CREATE OR REPLACE FUNCTION get_cogs_audit()
RETURNS TABLE (
  aud_invoice_id            uuid,
  invoice_number            text,
  invoice_date              date,
  invoice_status            text,
  invoice_total             numeric,
  customer_name             text,
  warehouse_name            text,
  item_count                integer,
  expected_cogs_a           numeric,
  expected_cogs_b           numeric,
  journal_cogs_c            numeric,
  journal_je_count          integer,
  fifo_cogs_d               numeric,
  cogs_journal_entries      jsonb,
  keeper_je_id              uuid,
  keeper_je_total           numeric,
  keeper_je_diff            numeric,
  all_je_diff               numeric,
  issue_type                text,
  fix_action                text,
  balance_impact            numeric,
  audit_status              text,
  has_per_item_je           boolean,
  has_lump_je               boolean,
  per_item_je_ids           uuid[],
  lump_je_ids               uuid[],
  fifo_consumptions         jsonb,
  item_fifo_totals          jsonb,
  root_cause                text,
  is_quick_sell             boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH inv AS (
  SELECT i.id AS inv_id, i.invoice_number, i.invoice_date, i.status AS invoice_status,
         i.total_amount AS invoice_total,
         COALESCE(i.is_quick_sell, false) AS is_quick_sell,
         c.name AS customer_name, w.name AS warehouse_name,
         (i.status = 'cancelled') AS is_cancelled
  FROM invoices i
  LEFT JOIN customers c ON c.id = i.customer_id
  LEFT JOIN warehouses w ON w.id = i.warehouse_id
  WHERE i.status <> 'draft'
),
src_a AS (  -- Source A: items x cost_price (quantity > 0 only)
  SELECT invoice_id, SUM(quantity * cost_price) AS expected_a, COUNT(*) AS item_cnt
  FROM invoice_items
  WHERE quantity > 0
  GROUP BY invoice_id
),
src_b AS (  -- Source B: cost_price_history
  SELECT invoice_id, SUM(quantity * cost_price_per_qty) AS expected_b
  FROM cost_price_history
  GROUP BY invoice_id
),
qs AS (  -- Quick-sell (non-stock) items: manual cost, no FIFO by design
  SELECT ii.invoice_id AS inv_id, COALESCE(SUM(ii.quantity * ii.cost_price), 0) AS qs_cost
  FROM invoice_items ii
  JOIN products p ON p.id = ii.product_id
  WHERE ii.quantity > 0 AND NOT p.track_inventory
  GROUP BY ii.invoice_id
),
base AS (
  SELECT inv.*,
         CASE WHEN inv.is_cancelled THEN 0 ELSE COALESCE(a.expected_a, 0) END AS expected_a,
         CASE WHEN inv.is_cancelled THEN 0 ELSE COALESCE(b.expected_b, 0) END AS expected_b,
         COALESCE(a.item_cnt, 0)::integer AS item_count
  FROM inv
  LEFT JOIN src_a a ON a.invoice_id = inv.inv_id
  LEFT JOIN src_b b ON b.invoice_id = inv.inv_id
),
orig AS (  -- original COGS postings (invoice / invoice_edit), including the
           -- Quick Sell Cost JE
  SELECT je.reference_id AS inv_id, je.id AS je_id, je.entry_number, je.entry_date,
         je.description, je.total_debit,
         (je.description ~ ' - .+ - Item ') AS is_per_item
  FROM journal_entries je
  WHERE je.reference_type IN ('invoice', 'invoice_edit')
    AND je.description ~* '^(COGS|Quick Sell Cost)'
    AND je.is_posted = true
),
orig_agg AS (
  SELECT o.inv_id,
         COUNT(*)::integer AS je_count,
         SUM(o.total_debit) AS journal_cogs,
         COALESCE(bool_or(o.is_per_item), false) AS has_per_item,
         COALESCE(bool_or(NOT o.is_per_item), false) AS has_lump,
         COALESCE(array_agg(o.je_id ORDER BY o.entry_date, o.je_id) FILTER (WHERE o.is_per_item), '{}'::uuid[]) AS per_item_ids,
         COALESCE(array_agg(o.je_id ORDER BY o.entry_date, o.je_id) FILTER (WHERE NOT o.is_per_item), '{}'::uuid[]) AS lump_ids,
         COALESCE(jsonb_agg(jsonb_build_object(
                    'id', o.je_id,
                    'entry_number', o.entry_number,
                    'entry_date', o.entry_date,
                    'description', o.description,
                    'total_debit', o.total_debit,
                    'is_per_item', o.is_per_item,
                    'diff_from_expected', ROUND(o.total_debit - b.expected_a, 2)
                  ) ORDER BY o.entry_date, o.je_id), '[]'::jsonb) AS jes_json
  FROM orig o
  JOIN base b ON b.inv_id = o.inv_id
  GROUP BY o.inv_id
),
keeper AS (  -- keeper JE: lowest |total - expected|, tie-break oldest
  SELECT k.inv_id, k.je_id AS keeper_je_id, k.total_debit AS keeper_total, k.keeper_diff
  FROM (
    SELECT o.inv_id, o.je_id, o.total_debit,
           ABS(o.total_debit - b.expected_a) AS keeper_diff,
           ROW_NUMBER() OVER (PARTITION BY o.inv_id
                              ORDER BY ABS(o.total_debit - b.expected_a) ASC,
                                       o.entry_date ASC, o.je_id ASC) AS rn
    FROM orig o
    JOIN base b ON b.inv_id = o.inv_id
  ) k
  WHERE k.rn = 1
),
rev AS (  -- cancel reversals, only exist for cancelled invoices
  SELECT je.reference_id AS inv_id, je.id AS je_id, je.entry_number, je.entry_date,
         je.description, je.total_debit
  FROM journal_entries je
  JOIN base b ON b.inv_id = je.reference_id AND b.is_cancelled
  WHERE je.reference_type = 'invoice_cancel'
    AND je.description ~* '^Reverse COGS'
    AND je.is_posted = true
),
rev_agg AS (
  SELECT r.inv_id,
         COUNT(*)::integer AS rev_count,
         COALESCE(jsonb_agg(jsonb_build_object(
                    'id', r.je_id,
                    'entry_number', r.entry_number,
                    'entry_date', r.entry_date,
                    'description', r.description,
                    'total_debit', r.total_debit,
                    'is_per_item', false,
                    'is_reversal', true,
                    'diff_from_expected', 0
                  ) ORDER BY r.entry_date, r.je_id), '[]'::jsonb) AS rev_json
  FROM rev r
  GROUP BY r.inv_id
),
net5000 AS (  -- net GL 5000 impact of postings + reversals per invoice
  SELECT je.reference_id AS inv_id, SUM(jl.debit - jl.credit) AS net_gl5000
  FROM journal_lines jl
  JOIN journal_entries je ON je.id = jl.journal_entry_id
  JOIN accounts a ON a.id = jl.account_id
  WHERE je.reference_type IN ('invoice', 'invoice_edit', 'invoice_cancel')
    AND (je.description ~* '^(COGS|Quick Sell Cost)' OR je.description ~* '^Reverse COGS')
    AND je.is_posted = true
    AND a.code = '5000'
  GROUP BY je.reference_id
),
fifo AS (  -- Source D: FIFO batch consumption with per-item batch sequence
  SELECT ii.invoice_id AS inv_id, iic.invoice_item_id,
         iic.id AS consumption_id, iic.batch_id, ib.batch_number,
         p.name AS product_name, p.sku AS product_sku,
         ROW_NUMBER() OVER (PARTITION BY iic.invoice_item_id ORDER BY ib.created_at ASC, iic.id ASC) AS batch_seq,
         iic.quantity_consumed AS consume_qty, iic.unit_cost AS cost_per_unit,
         iic.cogs_amount AS total_cost,
         ii.quantity AS item_qty, ii.cost_price AS item_cost_price
  FROM invoice_item_batch_consumption iic
  JOIN invoice_items ii ON ii.id = iic.invoice_item_id
  JOIN products p ON p.id = ii.product_id
  JOIN inventory_batches ib ON ib.id = iic.batch_id
),
fifo_agg AS (
  SELECT f.inv_id,
         SUM(f.total_cost) AS fifo_cogs,
         COALESCE(jsonb_agg(jsonb_build_object(
                    'consumption_id', f.consumption_id,
                    'invoice_item_id', f.invoice_item_id,
                    'batch_id', f.batch_id,
                    'batch_number', f.batch_number,
                    'product_name', f.product_name,
                    'sku', f.product_sku,
                    'batch_seq', f.batch_seq,
                    'consume_qty', f.consume_qty,
                    'cost_per_unit', f.cost_per_unit,
                    'total_cost', f.total_cost,
                    'item_qty', f.item_qty,
                    'item_cost_price', f.item_cost_price
                  ) ORDER BY f.invoice_item_id, f.batch_seq), '[]'::jsonb) AS fifo_json
  FROM fifo f
  GROUP BY f.inv_id
),
item_fifo AS (  -- per-item FIFO totals; non-stock items carry their manual
                -- cost as the expected amount (no batches by design)
  SELECT t.invoice_id AS inv_id,
         jsonb_agg(jsonb_build_object(
                    'invoice_item_id', t.invoice_item_id,
                    'product_name', t.product_name,
                    'sku', t.sku,
                    'item_qty', t.item_qty,
                    'item_cost_price', t.item_cost_price,
                    'fifo_total', t.fifo_total,
                    'batch_count', t.batch_count,
                    'fifo_vs_cost', t.fifo_vs_cost
                  ) ORDER BY t.invoice_item_id) AS item_json
  FROM (
    SELECT ii2.invoice_id, ii2.id AS invoice_item_id,
           p2.name AS product_name, p2.sku, p2.track_inventory,
           ii2.quantity AS item_qty, ii2.cost_price AS item_cost_price,
           CASE WHEN NOT p2.track_inventory THEN ii2.quantity * ii2.cost_price
                ELSE COALESCE(SUM(iibc.cogs_amount), 0) END AS fifo_total,
           CASE WHEN NOT p2.track_inventory THEN 0 ELSE COUNT(iibc.id) END AS batch_count,
           CASE WHEN ABS((CASE WHEN NOT p2.track_inventory THEN ii2.quantity * ii2.cost_price
                               ELSE COALESCE(SUM(iibc.cogs_amount), 0) END)
                         - (ii2.quantity * ii2.cost_price)) < 0.01
                THEN 'EXACT' ELSE 'DRIFT' END AS fifo_vs_cost
    FROM invoice_items ii2
    JOIN products p2 ON p2.id = ii2.product_id
    LEFT JOIN invoice_item_batch_consumption iibc ON iibc.invoice_item_id = ii2.id
    GROUP BY ii2.id, ii2.invoice_id, p2.name, p2.sku, p2.track_inventory, ii2.quantity, ii2.cost_price
  ) t
  GROUP BY t.invoice_id
),
calc AS (
  SELECT b.inv_id,
         b.invoice_number, b.invoice_date, b.invoice_status, b.invoice_total,
         b.customer_name, b.warehouse_name, b.item_count, b.is_cancelled,
         b.is_quick_sell,
         b.expected_a, b.expected_b,
         COALESCE(oa.je_count, 0) AS je_cnt,
         COALESCE(ra.rev_count, 0) AS rev_cnt,
         oa.journal_cogs,
         COALESCE(oa.jes_json, '[]'::jsonb) || COALESCE(ra.rev_json, '[]'::jsonb) AS cogs_journal_entries,
         oa.has_per_item, oa.has_lump,
         COALESCE(oa.per_item_ids, '{}'::uuid[]) AS per_item_je_ids,
         COALESCE(oa.lump_ids, '{}'::uuid[]) AS lump_je_ids,
         k.keeper_je_id, k.keeper_total, k.keeper_diff,
         COALESCE(n.net_gl5000, 0) AS net_gl5000,
         fa.fifo_cogs,
         COALESCE(q.qs_cost, 0) AS qs_cost,
         COALESCE(fa.fifo_json, '[]'::jsonb) AS fifo_consumptions,
         ift.item_json AS item_fifo_totals,
         ABS(COALESCE(n.net_gl5000, 0)) > 1.00 AS is_orphan,
         ( NOT b.is_cancelled AND COALESCE(oa.je_count, 0) >= 1
           AND ( COALESCE(k.keeper_diff, 999999999) <= 1.00
                 OR (b.expected_a > 0 AND COALESCE(k.keeper_diff, 999999999) <= b.expected_a * 0.01 + 10)
                 OR (b.expected_a = 0 AND COALESCE(k.keeper_diff, 999999999) = 0) ) ) AS keeper_ok
  FROM base b
  LEFT JOIN orig_agg oa ON oa.inv_id = b.inv_id
  LEFT JOIN rev_agg ra ON ra.inv_id = b.inv_id
  LEFT JOIN keeper k ON k.inv_id = b.inv_id
  LEFT JOIN net5000 n ON n.inv_id = b.inv_id
  LEFT JOIN fifo_agg fa ON fa.inv_id = b.inv_id
  LEFT JOIN qs q ON q.inv_id = b.inv_id
  LEFT JOIN item_fifo ift ON ift.inv_id = b.inv_id
)
SELECT
  c.inv_id                                                                 AS aud_invoice_id,
  c.invoice_number, c.invoice_date, c.invoice_status, c.invoice_total,
  c.customer_name, c.warehouse_name, c.item_count,
  ROUND(c.expected_a, 2)                                                   AS expected_cogs_a,
  ROUND(c.expected_b, 2)                                                   AS expected_cogs_b,
  CASE WHEN c.is_cancelled THEN ROUND(c.net_gl5000, 2)
       ELSE ROUND(COALESCE(c.journal_cogs, 0), 2) END                      AS journal_cogs_c,
  c.je_cnt                                                                 AS journal_je_count,
  -- Quick-sell invoices: D mirrors the manual cost (no FIFO by design).
  CASE WHEN c.is_cancelled THEN 0
       ELSE ROUND(COALESCE(c.fifo_cogs, 0) + c.qs_cost, 2) END             AS fifo_cogs_d,
  c.cogs_journal_entries,
  CASE WHEN NOT c.is_cancelled AND c.je_cnt >= 1 THEN c.keeper_je_id END    AS keeper_je_id,
  CASE WHEN NOT c.is_cancelled AND c.je_cnt >= 1
       THEN ROUND(c.keeper_total, 2) ELSE 0 END                             AS keeper_je_total,
  CASE
    WHEN c.is_cancelled AND c.is_orphan THEN 0
    WHEN c.is_cancelled THEN 999999999
    WHEN c.je_cnt = 0 THEN 999999999
    ELSE ROUND(c.keeper_diff, 2)
  END                                                                      AS keeper_je_diff,
  0::numeric                                                               AS all_je_diff,
  CASE
    WHEN c.je_cnt = 0 AND c.rev_cnt = 0 THEN CASE WHEN c.is_cancelled THEN 'EXACT' ELSE 'MISSING' END
    WHEN c.is_cancelled THEN CASE WHEN c.is_orphan THEN 'CANCELLED_ORPHAN' ELSE 'EXACT' END
    WHEN c.keeper_ok THEN CASE WHEN c.je_cnt = 1 THEN 'EXACT' ELSE 'DUPLICATE_COGS' END
    ELSE 'MISMATCH'
  END                                                                      AS issue_type,
  CASE
    WHEN c.je_cnt = 0 AND c.rev_cnt = 0 THEN CASE WHEN c.is_cancelled THEN 'NONE' ELSE 'CREATE_JE' END
    WHEN c.is_cancelled THEN CASE WHEN c.is_orphan THEN 'DELETE_ALL_COGS' ELSE 'NONE' END
    WHEN c.keeper_ok THEN CASE WHEN c.je_cnt = 1 THEN 'NONE' ELSE 'DELETE_DUPLICATES' END
    ELSE 'REVIEW_MANUALLY'
  END                                                                      AS fix_action,
  CASE
    WHEN c.is_cancelled AND c.is_orphan THEN ROUND(c.net_gl5000, 2)
    WHEN NOT c.is_cancelled AND c.je_cnt >= 1
      THEN ROUND(COALESCE(c.journal_cogs, 0) - COALESCE(c.keeper_total, 0), 2)
    ELSE 0
  END                                                                      AS balance_impact,
  CASE
    WHEN c.je_cnt = 0 AND c.rev_cnt = 0 THEN CASE WHEN c.is_cancelled THEN 'CONSISTENT' ELSE 'MISSING' END
    WHEN c.is_cancelled THEN CASE WHEN c.is_orphan THEN 'CANCELLED_ORPHAN' ELSE 'CONSISTENT' END
    WHEN c.keeper_ok THEN CASE WHEN c.je_cnt = 1 THEN 'CONSISTENT' ELSE 'DUPLICATE_COGS' END
    ELSE 'MISMATCH'
  END                                                                      AS audit_status,
  COALESCE(c.has_per_item, false)                                          AS has_per_item_je,
  COALESCE(c.has_lump, false)                                              AS has_lump_je,
  c.per_item_je_ids, c.lump_je_ids,
  c.fifo_consumptions, c.item_fifo_totals,
  CASE
    WHEN c.je_cnt = 0 AND c.rev_cnt = 0 THEN CASE WHEN c.is_cancelled THEN NULL ELSE 'NO_COGS_JE' END
    WHEN c.is_cancelled THEN CASE WHEN c.is_orphan
                                    THEN CASE WHEN c.net_gl5000 > 0 THEN 'CANCELLED_NOT_FULLY_REVERSED'
                                              ELSE 'CANCELLED_STRAY_REVERSAL' END
                                    ELSE 'CANCELLED_FULLY_REVERSED' END
    WHEN c.keeper_ok THEN CASE WHEN c.je_cnt = 1 THEN NULL
                               ELSE CASE WHEN COALESCE(c.has_per_item, false) AND COALESCE(c.has_lump, false)
                                         THEN 'DOUBLE_TRIGGER' ELSE 'MULTIPLE_JES' END END
    ELSE 'KEEPER_OUTSIDE_TOLERANCE'
  END                                                                      AS root_cause,
  c.is_quick_sell                                                          AS is_quick_sell
FROM calc c
ORDER BY c.invoice_date ASC, c.invoice_number ASC;
$$;

GRANT EXECUTE ON FUNCTION get_cogs_audit() TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 11) get_invoice_item_cogs_detail: for non-stock products the "FIFO" column
--     shows the manual cost (nothing to reconcile against batches) and a
--     track_inventory flag lets the modal label it. Full re-create of the
--     live 20260913170000 version + the branch and output column.
-- ═══════════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS get_invoice_item_cogs_detail(uuid);

CREATE OR REPLACE FUNCTION get_invoice_item_cogs_detail(p_invoice_id uuid)
RETURNS TABLE (
  product_id        uuid,
  product_name      text,
  sku               text,
  unit              text,
  item_qty          numeric,
  item_unit_cost    numeric,
  line_cost_a       numeric,
  history_qty       numeric,
  history_unit_cost numeric,
  history_cost_b    numeric,
  history_rows      integer,
  fifo_cost_d       numeric,
  batch_count       integer,
  batches           jsonb,
  track_inventory   boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH items AS (  -- Source A per product
  SELECT ii.product_id,
         SUM(ii.quantity) AS qty,
         SUM(ii.quantity * ii.cost_price) AS cost_a,
         MIN(ii.unit_name) AS unit_name
  FROM invoice_items ii
  WHERE ii.invoice_id = p_invoice_id
    AND ii.quantity > 0
  GROUP BY ii.product_id
),
hist AS (  -- Source B per product
  SELECT c.product_id,
         SUM(c.quantity) AS qty,
         SUM(c.cost_price_for_added_qty) AS cost_b,
         COUNT(*)::integer AS row_cnt,
         MIN(c.unit) AS unit
  FROM cost_price_history c
  WHERE c.invoice_id = p_invoice_id
    AND c.product_id IS NOT NULL
  GROUP BY c.product_id
),
draws AS (  -- Source D batch draws (base-unit qty/cost, sale-unit money)
  SELECT ii.product_id,
         ib.batch_number,
         iic.quantity_consumed AS consume_qty,
         iic.unit_cost AS cost_per_unit,
         iic.cogs_amount AS total_cost,
         ib.created_at AS batch_created
  FROM invoice_item_batch_consumption iic
  JOIN invoice_items ii ON ii.id = iic.invoice_item_id
  JOIN inventory_batches ib ON ib.id = iic.batch_id
  WHERE ii.invoice_id = p_invoice_id
),
fifo AS (
  SELECT d.product_id,
         SUM(d.total_cost) AS cost_d,
         COUNT(*)::integer AS draw_cnt,
         COALESCE(jsonb_agg(jsonb_build_object(
                    'batch_number', d.batch_number,
                    'consume_qty', d.consume_qty,
                    'cost_per_unit', d.cost_per_unit,
                    'total_cost', d.total_cost
                  ) ORDER BY d.batch_created ASC, d.batch_number ASC), '[]'::jsonb) AS batches_json
  FROM draws d
  GROUP BY d.product_id
)
SELECT
  p.id                                                    AS product_id,
  p.name                                                  AS product_name,
  COALESCE(p.sku, '')                                     AS sku,
  COALESCE(it.unit_name, h.unit, p.unit, 'pcs')           AS unit,
  COALESCE(it.qty, 0)                                     AS item_qty,
  ROUND(COALESCE(it.cost_a, 0) / NULLIF(COALESCE(it.qty, 0), 0), 2) AS item_unit_cost,
  ROUND(COALESCE(it.cost_a, 0), 2)                        AS line_cost_a,
  COALESCE(h.qty, 0)                                      AS history_qty,
  ROUND(COALESCE(h.cost_b, 0) / NULLIF(COALESCE(h.qty, 0), 0), 2) AS history_unit_cost,
  ROUND(COALESCE(h.cost_b, 0), 2)                         AS history_cost_b,
  COALESCE(h.row_cnt, 0)                                  AS history_rows,
  -- Non-stock products: no FIFO by design — the manual line cost IS the
  -- expected amount; batches stay empty and track_inventory flags the modal.
  ROUND(CASE WHEN NOT p.track_inventory THEN COALESCE(it.cost_a, 0)
             ELSE COALESCE(f.cost_d, 0) END, 2)           AS fifo_cost_d,
  CASE WHEN NOT p.track_inventory THEN 0
       ELSE COALESCE(f.draw_cnt, 0) END                   AS batch_count,
  CASE WHEN NOT p.track_inventory THEN '[]'::jsonb
       ELSE COALESCE(f.batches_json, '[]'::jsonb) END     AS batches,
  p.track_inventory                                       AS track_inventory
FROM products p
LEFT JOIN items it ON it.product_id = p.id
LEFT JOIN hist  h  ON h.product_id  = p.id
LEFT JOIN fifo  f  ON f.product_id  = p.id
WHERE it.product_id IS NOT NULL
   OR h.product_id  IS NOT NULL
   OR f.product_id  IS NOT NULL
ORDER BY COALESCE(it.cost_a, 0) DESC, p.name ASC;
$$;

GRANT EXECUTE ON FUNCTION get_invoice_item_cogs_detail(uuid) TO authenticated;

DO $$
BEGIN
  RAISE NOTICE 'quick_sell_non_stock: applied — products.track_inventory, invoices.is_quick_sell/cost_payment_method, invoice_items.source_shop; consume_fifo/deduct/restore/status-trigger/edit/cancel/return branches; batch-stock RPC + cogs audit RPCs quick-sell aware';
END $$;

COMMIT;
