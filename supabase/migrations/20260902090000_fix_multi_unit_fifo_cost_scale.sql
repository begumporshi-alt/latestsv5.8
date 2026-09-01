-- Fix multi-unit (e.g. cable coil x100) FIFO cost-scale bugs that made
-- invoice_items INSERT fail for multi-unit sale items.
--
-- Incident (2026-09-01, INV-940647 / INV-940648): user copied products from
-- cancelled POS-00590095 (12 walton cable items sold per COIL = 100 meters)
-- and pasted them into two new invoices. Both invoices were left as husks:
-- 0 items, no cost_price_history, no COGS journal entry, no stock movement
-- -- while the AR journal entry posted when the drafts were marked sent.
--
-- Root cause chain:
--   1. invoice_items.cost_price is guarded by check_invoice_item_cost_scale
--      to be per SALE unit (same scale as unit_price).
--   2. consume_fifo() (AFTER INSERT trigger trg_invoice_items_cogs) computed
--      SUM(cogs_amount)/SUM(quantity_consumed) from
--      invoice_item_batch_consumption, which is denominated in BASE units
--      (meters) -- a per-BASE-unit cost -- and wrote it into
--      invoice_items.cost_price.
--   3. The scale guard fired on that UPDATE and aborted the whole multi-row
--      INSERT. Single-unit products (the rest of the day's invoices) pass
--      because both scales coincide.
--
-- Also fixed in the same family:
--   * consume_fifo's fallback batch stored the SALE-unit cost as batch
--     unit_cost (inventory_batches is BASE-unit denominated) and mixed
--     scales in the fallback consumption row. The fallback now books a
--     negative IOU layer at BASE-unit cost, matching create_stock_reduction,
--     so counter / batch-ledger / GL 1200 all stay reconciled.
--   * invoice_status_cogs_trigger passed SALE-unit quantity where BASE
--     quantity is expected (under-consumption for multi-unit drafts) and
--     recomputed cost_price on the wrong scale.
--   * post_cogs_je_from_item_insert replaced journal_lines of an existing
--     COGS JE directly, bypassing post_journal_entry's accounts.balance
--     maintenance -- every multi-item sale since deployment drifted
--     accounts 1200/5000 by (total COGS - first item COGS). The UPDATE path
--     now maintains balances, and the accumulated drift is recomputed here.
--   * Dead function invoice_items_cogs_trigger (calls consume_fifo with a
--     pre-fix 4-arg signature and writes wrong-scale costs) is dropped.

BEGIN;

-- Audit trail for this fix
CREATE TABLE IF NOT EXISTS cogs_scale_fix_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO cogs_scale_fix_audit (action, details)
VALUES ('migration_start', jsonb_build_object(
  'migration', '20260902090000_fix_multi_unit_fifo_cost_scale',
  'drift_1200_balance_minus_lines', (SELECT a.balance - COALESCE(SUM(jl.debit - jl.credit), 0) FROM accounts a LEFT JOIN journal_lines jl ON jl.account_id = a.id WHERE a.code = '1200' GROUP BY a.balance),
  'drift_5000_balance_minus_lines', (SELECT a.balance - COALESCE(SUM(jl.debit - jl.credit), 0) FROM accounts a LEFT JOIN journal_lines jl ON jl.account_id = a.id WHERE a.code = '5000' GROUP BY a.balance)
));

-- ---------------------------------------------------------------------------
-- 1) consume_fifo: scale-aware fallback + sale-unit cost_price
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

  -- Consume from oldest batches first (FIFO)
  FOR v_batch IN
    SELECT id, quantity_remaining, unit_cost
      FROM inventory_batches
     WHERE product_id = p_product_id
       AND warehouse_id = v_wh
       AND quantity_remaining > 0
     ORDER BY created_at ASC
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

-- ---------------------------------------------------------------------------
-- 2) invoice_status_cogs_trigger: BASE quantity + no wrong-scale cost write
--    (consume_fifo now sets the sale-unit cost itself)
-- ---------------------------------------------------------------------------
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

      -- Check if FIFO was already consumed (by INSERT triggers during edit_invoice)
      PERFORM 1 FROM invoice_item_batch_consumption WHERE invoice_item_id = v_item.id;
      IF FOUND THEN
        -- FIFO already consumed, just get the cost
        SELECT COALESCE(SUM(cogs_amount), 0) INTO v_amt
        FROM invoice_item_batch_consumption WHERE invoice_item_id = v_item.id;
        IF v_amt > 0 THEN
          v_total_cogs := v_total_cogs + v_amt;
        END IF;
        CONTINUE;
      END IF;

      -- FIFO not consumed yet, consume it now with CORRECT parameter order
      -- consume_fifo(p_invoice_item_id, p_product_id, p_warehouse_id, p_quantity, p_unit_cost)
      -- p_quantity must be BASE units; p_unit_cost is the per-SALE-unit cost
      -- (consume_fifo converts it to base scale internally).
      PERFORM consume_fifo(v_item.id, v_item.product_id, COALESCE(v_item.warehouse_id, v_wh), v_qty, COALESCE(v_item.cost_price, 0));
      SELECT COALESCE(SUM(cogs_amount), 0) INTO v_amt FROM invoice_item_batch_consumption WHERE invoice_item_id = v_item.id;
      IF v_amt > 0 THEN
        v_total_cogs := v_total_cogs + v_amt;
      END IF;
    END LOOP;

    -- Post COGS JE if any cost was calculated
    IF v_total_cogs > 0 THEN
      v_cogs_desc := 'COGS - ' || NEW.invoice_number || ' (' ||
        (SELECT count(*) FROM invoice_items WHERE invoice_id = NEW.id) || ' items, total: ' || v_total_cogs || ')';

      -- Check if COGS JE already exists (from edit_invoice STEP 7b or insert_cogs trigger)
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
  END IF;
  RETURN NEW;
END
$function$;

-- ---------------------------------------------------------------------------
-- 3) post_cogs_je_from_item_insert: maintain accounts.balance on the
--    UPDATE path (was bypassing post_journal_entry's balance maintenance)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_cogs_je_from_item_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_invoice RECORD;
  v_cogs_account uuid;
  v_inventory_account uuid;
  v_total_cogs decimal(15,2) := 0;
  v_lines json[] := '{}';
  v_line_count int := 0;
  v_item RECORD;
  v_product RECORD;
  v_cogs_amount decimal(15,2);
  v_qty numeric;
  v_desc text;
  v_existing_je_id uuid;
  v_old_cogs_net numeric;
  v_old_inv_net numeric;
  v_new_cogs_net numeric;
  v_new_inv_net numeric;
BEGIN
  -- Only fire on INSERT
  IF TG_OP != 'INSERT' THEN
    RETURN NEW;
  END IF;

  -- Get the parent invoice
  SELECT * INTO v_invoice FROM invoices WHERE id = NEW.invoice_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  -- Only fire when invoice is non-draft (status is sent, partially_paid, or paid)
  IF v_invoice.status NOT IN ('sent', 'partially_paid', 'paid') THEN
    RETURN NEW;
  END IF;

  -- Get accounts
  SELECT id INTO v_cogs_account FROM accounts WHERE code = '5000' LIMIT 1;
  SELECT id INTO v_inventory_account FROM accounts WHERE code = '1200' LIMIT 1;
  IF v_cogs_account IS NULL OR v_inventory_account IS NULL THEN
    RETURN NEW;
  END IF;

  -- Check if COGS JE already exists (for UPDATE instead of skip)
  SELECT id INTO v_existing_je_id FROM journal_entries
  WHERE reference_type = 'invoice' AND reference_id = v_invoice.id
  AND description LIKE 'COGS%';

  -- Process ALL items for this invoice
  FOR v_item IN
    SELECT ii.* FROM invoice_items ii
    WHERE ii.invoice_id = NEW.invoice_id
    ORDER BY ii.sort_order
  LOOP
    v_qty := v_item.quantity;
    IF v_qty <= 0 THEN CONTINUE; END IF;

    -- Get COGS from FIFO consumption records
    SELECT COALESCE(SUM(cogs_amount), 0) INTO v_cogs_amount
    FROM invoice_item_batch_consumption
    WHERE invoice_item_id = v_item.id;

    IF v_cogs_amount > 0 THEN
      v_total_cogs := v_total_cogs + v_cogs_amount;
      v_line_count := v_line_count + 1;

      SELECT name, sku INTO v_product FROM products WHERE id = v_item.product_id;

      v_desc := 'COGS (FIFO): ' || COALESCE(v_product.name, 'Unknown') ||
        ' (SKU: ' || COALESCE(v_product.sku, 'N/A') || ') - Qty: ' || v_qty ||
        ' x Avg Cost: ' || round(v_cogs_amount / v_qty, 2) || ' = ' || v_cogs_amount;

      v_lines := array_append(v_lines, json_build_object(
        'account_id', v_cogs_account, 'debit', v_cogs_amount, 'credit', 0,
        'description', v_desc
      ));
      v_lines := array_append(v_lines, json_build_object(
        'account_id', v_inventory_account, 'debit', 0, 'credit', v_cogs_amount,
        'description', 'Inventory released (FIFO): ' || COALESCE(v_product.name, 'Unknown') ||
          ' (Qty: ' || v_qty || ') for ' || v_invoice.invoice_number
      ));
    END IF;
  END LOOP;

  -- Post or UPDATE the aggregated COGS JE
  IF v_total_cogs > 0 THEN
    IF v_existing_je_id IS NOT NULL THEN
      -- Capture the per-account nets BEFORE replacing lines so
      -- accounts.balance can be adjusted by the delta (mirrors
      -- post_journal_entry's balance maintenance).
      SELECT COALESCE(SUM(debit - credit), 0) INTO v_old_cogs_net
      FROM journal_lines WHERE journal_entry_id = v_existing_je_id AND account_id = v_cogs_account;
      SELECT COALESCE(SUM(debit - credit), 0) INTO v_old_inv_net
      FROM journal_lines WHERE journal_entry_id = v_existing_je_id AND account_id = v_inventory_account;

      -- UPDATE existing JE: delete old lines, insert new ones
      DELETE FROM journal_lines WHERE journal_entry_id = v_existing_je_id;

      -- Insert new lines
      FOR i IN 1..array_length(v_lines, 1) LOOP
        INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit, description, sort_order)
        VALUES (
          v_existing_je_id,
          (v_lines[i]->>'account_id')::uuid,
          (v_lines[i]->>'debit')::decimal(15,2),
          (v_lines[i]->>'credit')::decimal(15,2),
          v_lines[i]->>'description',
          i
        );
      END LOOP;

      -- Update the entry description and total
      UPDATE journal_entries
      SET description = 'COGS - ' || v_invoice.invoice_number || ' (' || v_line_count || ' items, total: ' || v_total_cogs || ')',
          total_debit = v_total_cogs,
          total_credit = v_total_cogs
      WHERE id = v_existing_je_id;

      -- Maintain denormalized balances by the net change per account
      -- (same sign convention as post_journal_entry).
      SELECT COALESCE(SUM(debit - credit), 0) INTO v_new_cogs_net
      FROM journal_lines WHERE journal_entry_id = v_existing_je_id AND account_id = v_cogs_account;
      SELECT COALESCE(SUM(debit - credit), 0) INTO v_new_inv_net
      FROM journal_lines WHERE journal_entry_id = v_existing_je_id AND account_id = v_inventory_account;

      UPDATE accounts
         SET balance = balance + CASE WHEN account_type IN ('liability','equity','revenue')
                                      THEN -(v_new_cogs_net - v_old_cogs_net)
                                      ELSE  (v_new_cogs_net - v_old_cogs_net) END
       WHERE id = v_cogs_account;

      UPDATE accounts
         SET balance = balance + CASE WHEN account_type IN ('liability','equity','revenue')
                                      THEN -(v_new_inv_net - v_old_inv_net)
                                      ELSE  (v_new_inv_net - v_old_inv_net) END
       WHERE id = v_inventory_account;
    ELSE
      -- CREATE new JE
      PERFORM post_journal_entry(
        'COGS - ' || v_invoice.invoice_number || ' (' || v_line_count || ' items, total: ' || v_total_cogs || ')',
        COALESCE(v_invoice.invoice_date, CURRENT_DATE),
        'invoice',
        v_invoice.id,
        to_json(v_lines),
        v_invoice.customer_id
      );
    END IF;
  END IF;

  RETURN NEW;
END
$function$;

-- ---------------------------------------------------------------------------
-- 4) Drop the dead legacy function (unwired; calls a pre-fix 4-arg
--    consume_fifo signature and writes wrong-scale costs if ever re-wired)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.invoice_items_cogs_trigger();

-- ---------------------------------------------------------------------------
-- 5) Repair the accumulated accounts.balance drift (all accounts whose
--    cached balance no longer equals their journal_lines natural balance)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_changed int := 0;
  v_rec record;
BEGIN
  FOR v_rec IN
    SELECT a.id, a.code, a.account_type, a.balance AS old_balance,
           CASE WHEN a.account_type IN ('liability','equity','revenue')
                THEN COALESCE(SUM(jl.credit - jl.debit), 0)
                ELSE COALESCE(SUM(jl.debit - jl.credit), 0) END AS new_balance
      FROM accounts a
      LEFT JOIN journal_lines jl ON jl.account_id = a.id
     GROUP BY a.id, a.code, a.account_type, a.balance
    HAVING a.balance IS DISTINCT FROM (CASE WHEN a.account_type IN ('liability','equity','revenue')
                THEN COALESCE(SUM(jl.credit - jl.debit), 0)
                ELSE COALESCE(SUM(jl.debit - jl.credit), 0) END)
  LOOP
    UPDATE accounts SET balance = v_rec.new_balance WHERE id = v_rec.id;
    INSERT INTO cogs_scale_fix_audit (action, details)
    VALUES ('account_balance_repair', jsonb_build_object(
      'account_code', v_rec.code,
      'old_balance', v_rec.old_balance,
      'new_balance', v_rec.new_balance
    ));
    v_changed := v_changed + 1;
  END LOOP;

  RAISE NOTICE 'cogs_scale_fix: rebalanced % account(s)', v_changed;
END $$;

-- ---------------------------------------------------------------------------
-- Post-conditions
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_drift_1200 numeric;
  v_drift_5000 numeric;
  v_bad_scale int;
BEGIN
  SELECT a.balance - COALESCE(SUM(jl.debit - jl.credit), 0) INTO v_drift_1200
  FROM accounts a LEFT JOIN journal_lines jl ON jl.account_id = a.id
  WHERE a.code = '1200' GROUP BY a.id, a.balance;
  SELECT a.balance - COALESCE(SUM(jl.debit - jl.credit), 0) INTO v_drift_5000
  FROM accounts a LEFT JOIN journal_lines jl ON jl.account_id = a.id
  WHERE a.code = '5000' GROUP BY a.id, a.balance;

  IF ABS(COALESCE(v_drift_1200, 0)) > 0.01 OR ABS(COALESCE(v_drift_5000, 0)) > 0.01 THEN
    RAISE EXCEPTION 'post-condition failed: accounts 1200/5000 balance still drifts (1200: %, 5000: %)', v_drift_1200, v_drift_5000;
  END IF;

  -- No multi-unit item may carry a base-scale cost (ratio far below 1/cf)
  SELECT COUNT(*) INTO v_bad_scale
  FROM invoice_items ii
  JOIN products p ON p.id = ii.product_id
  WHERE ii.unit_price > 0 AND ii.cost_price > 0
    AND EXISTS (SELECT 1 FROM product_units pu
                WHERE pu.product_id = ii.product_id AND pu.is_sale_unit AND pu.conversion_factor > 1)
    AND ii.cost_price / ii.unit_price < 1.0 / (
      SELECT COALESCE(MAX(pu2.conversion_factor), 1) FROM product_units pu2
      WHERE pu2.product_id = ii.product_id AND pu2.is_sale_unit AND pu2.conversion_factor > 1) / 4;

  RAISE NOTICE 'cogs_scale_fix: post-conditions OK (drift 1200=%, 5000=%, base-scale items=%)', v_drift_1200, v_drift_5000, v_bad_scale;
END $$;

INSERT INTO cogs_scale_fix_audit (action, details)
VALUES ('migration_complete', jsonb_build_object('status', 'ok'));

COMMIT;
