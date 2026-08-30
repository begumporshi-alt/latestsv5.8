-- ============================================================
-- FIX: COGS Journal Entry Missing for POS Sales
-- Date: 2026-08-30
--
-- PROBLEM:
--   trg_invoice_insert_cogs fires on invoices INSERT, but
--   invoice_items don't exist yet (inserted in separate HTTP call).
--   So the COGS JE is never posted for invoices created directly
--   as non-draft status (e.g., POS sales).
--
-- FIX:
--   Add a trigger on invoice_items INSERT that posts COGS JE
--   when: invoice is non-draft + no COGS JE exists yet.
--   Uses idempotency guard to prevent duplicate JEs.
-- ============================================================

-- 1. Create function to post COGS JE from invoice_items context
CREATE OR REPLACE FUNCTION post_cogs_je_from_item_insert()
RETURNS TRIGGER AS $$
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

  -- Idempotency: skip if COGS JE already exists
  IF EXISTS (
    SELECT 1 FROM journal_entries
    WHERE reference_type = 'invoice' AND reference_id = v_invoice.id
    AND description LIKE 'COGS%'
  ) THEN
    RETURN NEW;
  END IF;

  -- Get accounts
  SELECT id INTO v_cogs_account FROM accounts WHERE code = '5000' LIMIT 1;
  SELECT id INTO v_inventory_account FROM accounts WHERE code = '1200' LIMIT 1;
  IF v_cogs_account IS NULL OR v_inventory_account IS NULL THEN
    RETURN NEW;
  END IF;

  -- Process ALL items for this invoice (not just the one being inserted)
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

  -- Post the aggregated COGS JE
  IF v_total_cogs > 0 THEN
    PERFORM post_journal_entry(
      'COGS - ' || v_invoice.invoice_number || ' (' || v_line_count || ' items, total: ' || v_total_cogs || ')',
      COALESCE(v_invoice.invoice_date, CURRENT_DATE),
      'invoice',
      v_invoice.id,
      to_json(v_lines),
      v_invoice.customer_id
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. Install trigger on invoice_items INSERT (fires AFTER the FIFO trigger)
DROP TRIGGER IF EXISTS trg_post_cogs_je_on_item_insert ON invoice_items;
CREATE TRIGGER trg_post_cogs_je_on_item_insert
  AFTER INSERT ON invoice_items
  FOR EACH ROW
  EXECUTE FUNCTION post_cogs_je_from_item_insert();

-- 3. Backfill: Post COGS JE for invoices that are missing it
DO $$
DECLARE
  v_invoice record;
  v_cogs_account uuid;
  v_inventory_account uuid;
  v_total_cogs decimal(15,2);
  v_lines json[];
  v_line_count int;
  v_item record;
  v_product record;
  v_cogs_amount decimal(15,2);
  v_qty numeric;
  v_desc text;
  v_count int := 0;
BEGIN
  SELECT id INTO v_cogs_account FROM accounts WHERE code = '5000' LIMIT 1;
  SELECT id INTO v_inventory_account FROM accounts WHERE code = '1200' LIMIT 1;

  IF v_cogs_account IS NULL OR v_inventory_account IS NULL THEN
    RAISE NOTICE 'COGS or Inventory account not found';
    RETURN;
  END IF;

  -- Find all non-cancelled invoices without COGS JE
  FOR v_invoice IN
    SELECT i.* FROM invoices i
    WHERE i.status != 'cancelled'
    AND i.status IN ('sent', 'partially_paid', 'paid')
    AND NOT EXISTS (
      SELECT 1 FROM journal_entries je
      WHERE je.reference_type = 'invoice' AND je.reference_id = i.id
      AND je.description LIKE 'COGS%'
    )
  LOOP
    v_total_cogs := 0;
    v_lines := '{}';
    v_line_count := 0;

    FOR v_item IN
      SELECT ii.* FROM invoice_items ii
      WHERE ii.invoice_id = v_invoice.id
      ORDER BY ii.sort_order
    LOOP
      v_qty := v_item.quantity;
      IF v_qty <= 0 THEN CONTINUE; END IF;

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

    IF v_total_cogs > 0 THEN
      PERFORM post_journal_entry(
        'COGS - ' || v_invoice.invoice_number || ' (' || v_line_count || ' items, total: ' || v_total_cogs || ')',
        COALESCE(v_invoice.invoice_date, CURRENT_DATE),
        'invoice',
        v_invoice.id,
        to_json(v_lines),
        v_invoice.customer_id
      );
      v_count := v_count + 1;
      RAISE NOTICE 'Posted COGS JE for %: ৳%', v_invoice.invoice_number, v_total_cogs;
    END IF;
  END LOOP;

  RAISE NOTICE '=== COGS BACKFILL COMPLETE: % invoices ===', v_count;
END $$;

-- 4. Verification
DO $$
DECLARE
  v_total int;
  v_with_cogs int;
  v_missing int;
  v_trigger_exists boolean;
BEGIN
  SELECT COUNT(*) INTO v_total FROM invoices WHERE status != 'cancelled';
  SELECT COUNT(DISTINCT i.id) INTO v_with_cogs FROM invoices i
  WHERE EXISTS (
    SELECT 1 FROM journal_entries je
    WHERE je.reference_type = 'invoice' AND je.reference_id = i.id
    AND je.description LIKE 'COGS%'
  );
  v_missing := v_total - v_with_cogs;

  SELECT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_post_cogs_je_on_item_insert'
  ) INTO v_trigger_exists;

  RAISE NOTICE '=== COGS FIX VERIFICATION ===';
  RAISE NOTICE 'Total non-cancelled invoices: %', v_total;
  RAISE NOTICE 'Invoices with COGS JE: %', v_with_cogs;
  RAISE NOTICE 'Invoices still missing COGS JE: %', v_missing;
  RAISE NOTICE 'New trigger installed: %', CASE WHEN v_trigger_exists THEN 'YES' ELSE 'NO' END;
  RAISE NOTICE '=== VERIFICATION COMPLETE ===';
END $$;
