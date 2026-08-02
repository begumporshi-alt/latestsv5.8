/*
# Fix COGS not posted for invoices created directly as paid/partially_paid

## Problem
The `trg_invoice_items_cogs` trigger was dropped in migration 20260801091939
to fix duplicate COGS entries. Only `trg_invoice_status_cogs` remained,
which fires on `UPDATE OF status` from 'draft' → active.

But invoices are typically created directly as 'paid' or 'partially_paid'
(see sales/page.tsx line 1108, pos/page.tsx). There is no draft→active
transition, so `invoice_status_cogs_trigger` never fires and COGS is never
posted. The P&L report shows ৳0 COGS.

## Fix
1. Recreate `trg_invoice_items_cogs` on `invoice_items` AFTER INSERT.
   This trigger posts COGS per-item when the invoice is already non-draft.
   It has an idempotency guard: checks if a COGS JE already exists for
   this specific invoice_id + product_id combination to avoid duplicates
   with the status trigger.

2. Keep `trg_invoice_status_cogs` for the draft→active transition case
   (items inserted while draft, then status changes to active).

3. The per-item trigger uses a precise dedup check: it looks for an
   existing COGS JE for this invoice that mentions this product name
   in the description. This prevents double-posting when both triggers
   could fire for the same invoice.

## Backfill
Post missing COGS journal entries for all non-cancelled, non-draft
invoices that have items with cost_price > 0 but no COGS JE.
*/

-- ============================================================
-- 1. Recreate per-item COGS trigger with idempotency guard
-- ============================================================
CREATE OR REPLACE FUNCTION invoice_items_cogs_trigger()
RETURNS TRIGGER AS $$
DECLARE
  v_cogs_account uuid;
  v_inventory_account uuid;
  v_qty numeric;
  v_cost numeric;
  v_cogs_amount numeric;
  v_invoice_record RECORD;
  v_product RECORD;
  v_desc text;
  v_je_desc text;
  v_product_name text;
BEGIN
  SELECT id INTO v_cogs_account FROM accounts WHERE code = '5000' LIMIT 1;
  SELECT id INTO v_inventory_account FROM accounts WHERE code = '1200' LIMIT 1;

  IF v_cogs_account IS NULL OR v_inventory_account IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_invoice_record FROM invoices WHERE id = NEW.invoice_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- Only post COGS for non-draft invoices
  IF v_invoice_record.status = 'draft' THEN
    RETURN NEW;
  END IF;

  -- Use quantity (not base_quantity) since cost_price is per sales unit
  v_qty := NEW.quantity;
  v_cost := COALESCE(NEW.cost_price, 0);
  v_cogs_amount := v_qty * v_cost;

  IF v_cogs_amount <= 0 THEN
    RETURN NEW;
  END IF;

  SELECT name, sku INTO v_product FROM products WHERE id = NEW.product_id;
  v_product_name := COALESCE(v_product.name, 'Unknown');

  -- Idempotency guard: skip if a COGS JE already exists for this invoice
  -- that mentions this product name (covers both per-item and batch JEs)
  PERFORM 1 FROM journal_entries je
  WHERE je.reference_type = 'invoice'
    AND je.reference_id = NEW.invoice_id
    AND je.description LIKE 'COGS%'
    AND je.description LIKE '%' || v_product_name || '%';

  IF FOUND THEN
    RETURN NEW;
  END IF;

  v_desc := 'COGS: ' || v_product_name ||
    ' (SKU: ' || COALESCE(v_product.sku, 'N/A') || ') - Qty: ' || v_qty ||
    ' x Cost: ' || v_cost || ' = ' || v_cogs_amount;

  v_je_desc := 'COGS - ' || v_invoice_record.invoice_number || ' - ' || v_product_name;

  PERFORM post_journal_entry(
    v_je_desc,
    COALESCE(v_invoice_record.invoice_date, CURRENT_DATE),
    'invoice',
    NEW.invoice_id,
    json_build_array(
      json_build_object('account_id', v_cogs_account, 'debit', v_cogs_amount, 'credit', 0,
        'description', v_desc),
      json_build_object('account_id', v_inventory_account, 'debit', 0, 'credit', v_cogs_amount,
        'description', 'Inventory released: ' || v_product_name ||
        ' (Qty: ' || v_qty || ') for ' || v_invoice_record.invoice_number)
    )::json,
    v_invoice_record.customer_id
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_invoice_items_cogs ON invoice_items;
CREATE TRIGGER trg_invoice_items_cogs
  AFTER INSERT ON invoice_items
  FOR EACH ROW EXECUTE FUNCTION invoice_items_cogs_trigger();

-- ============================================================
-- 2. Backfill missing COGS for existing non-draft, non-cancelled invoices
-- ============================================================
DO $$
DECLARE
  v_inv RECORD;
  v_item RECORD;
  v_cogs_account uuid;
  v_inventory_account uuid;
  v_qty numeric;
  v_cost numeric;
  v_cogs_amount numeric;
  v_total_cogs numeric;
  v_lines json[] := '{}';
  v_desc text;
  v_product RECORD;
  v_product_name text;
  v_has_cogs boolean;
BEGIN
  SELECT id INTO v_cogs_account FROM accounts WHERE code = '5000' LIMIT 1;
  SELECT id INTO v_inventory_account FROM accounts WHERE code = '1200' LIMIT 1;

  IF v_cogs_account IS NULL OR v_inventory_account IS NULL THEN
    RAISE NOTICE 'COGS or Inventory account not found, skipping backfill';
    RETURN;
  END IF;

  FOR v_inv IN
    SELECT i.id, i.invoice_number, i.invoice_date, i.customer_id, i.status
    FROM invoices i
    WHERE i.status IN ('paid', 'partially_paid', 'sent')
    AND EXISTS (
      SELECT 1 FROM invoice_items ii
      WHERE ii.invoice_id = i.id
      AND COALESCE(ii.cost_price, 0) > 0
    )
    AND NOT EXISTS (
      SELECT 1 FROM journal_entries je
      WHERE je.reference_type = 'invoice'
        AND je.reference_id = i.id
        AND je.description LIKE 'COGS%'
    )
  LOOP
    v_total_cogs := 0;
    v_lines := '{}';

    FOR v_item IN
      SELECT * FROM invoice_items WHERE invoice_id = v_inv.id ORDER BY sort_order
    LOOP
      v_qty := v_item.quantity;
      v_cost := COALESCE(v_item.cost_price, 0);
      v_cogs_amount := v_qty * v_cost;

      IF v_cogs_amount > 0 THEN
        SELECT name, sku INTO v_product FROM products WHERE id = v_item.product_id;
        v_product_name := COALESCE(v_product.name, 'Unknown');

        v_desc := 'COGS: ' || v_product_name ||
          ' (SKU: ' || COALESCE(v_product.sku, 'N/A') || ') - Qty: ' || v_qty ||
          ' x Cost: ' || v_cost || ' = ' || v_cogs_amount;

        v_lines := array_append(v_lines, json_build_object(
          'account_id', v_cogs_account, 'debit', v_cogs_amount, 'credit', 0,
          'description', v_desc
        ));
        v_lines := array_append(v_lines, json_build_object(
          'account_id', v_inventory_account, 'debit', 0, 'credit', v_cogs_amount,
          'description', 'Inventory released: ' || v_product_name ||
          ' (Qty: ' || v_qty || ') for ' || v_inv.invoice_number
        ));

        v_total_cogs := v_total_cogs + v_cogs_amount;
      END IF;
    END LOOP;

    IF v_total_cogs > 0 THEN
      PERFORM post_journal_entry(
        'COGS - ' || v_inv.invoice_number || ' (' || array_length(v_lines, 1) / 2 || ' items, total: ' || v_total_cogs || ')',
        COALESCE(v_inv.invoice_date, CURRENT_DATE),
        'invoice',
        v_inv.id,
        to_json(v_lines),
        v_inv.customer_id
      );
      RAISE NOTICE 'Posted COGS for %: %', v_inv.invoice_number, v_total_cogs;
    END IF;
  END LOOP;
END $$;

-- ============================================================
-- 3. Recalculate account balances for COGS (5000) and Inventory (1200)
-- ============================================================
DO $$
DECLARE
  v_acc RECORD;
  v_calc numeric;
BEGIN
  FOR v_acc IN SELECT id, account_type FROM accounts WHERE code IN ('5000', '1200') AND is_active = true LOOP
    SELECT COALESCE(SUM(debit - credit), 0) INTO v_calc
    FROM journal_lines WHERE account_id = v_acc.id;

    IF v_acc.account_type IN ('liability', 'equity', 'revenue') THEN
      v_calc := -v_calc;
    END IF;

    UPDATE accounts SET balance = v_calc WHERE id = v_acc.id;
  END LOOP;
END $$;