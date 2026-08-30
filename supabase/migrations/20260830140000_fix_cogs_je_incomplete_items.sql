-- ============================================================
-- FIX: COGS JE only includes first item (idempotency bug)
-- Date: 2026-08-30
--
-- PROBLEM:
--   When items are inserted one-by-one (POS page), the first
--   item creates the COGS JE, but the second item's trigger
--   skips because the JE already exists.
--
-- FIX:
--   Instead of skipping, UPDATE the existing JE by:
--   1. Deleting old journal lines
--   2. Recalculating COGS for ALL items
--   3. Inserting new lines with correct totals
-- ============================================================

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
  v_existing_je_id uuid;
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
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Re-install the trigger
DROP TRIGGER IF EXISTS trg_post_cogs_je_on_item_insert ON invoice_items;
CREATE TRIGGER trg_post_cogs_je_on_item_insert
  AFTER INSERT ON invoice_items
  FOR EACH ROW
  EXECUTE FUNCTION post_cogs_je_from_item_insert();

-- Fix POS-00590100: Recalculate COGS JE with both items
DO $$
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
  v_count int := 0;
BEGIN
  SELECT id INTO v_cogs_account FROM accounts WHERE code = '5000' LIMIT 1;
  SELECT id INTO v_inventory_account FROM accounts WHERE code = '1200' LIMIT 1;

  -- Fix all invoices where COGS JE has fewer items than invoice_items
  FOR v_invoice IN
    SELECT i.id, i.invoice_number, i.invoice_date, i.customer_id,
           (SELECT COUNT(*) FROM invoice_items ii WHERE ii.invoice_id = i.id) as item_count,
           (SELECT je.id FROM journal_entries je 
            WHERE je.reference_type = 'invoice' AND je.reference_id = i.id 
            AND je.description LIKE 'COGS%' LIMIT 1) as je_id
    FROM invoices i
    WHERE i.status != 'cancelled'
    AND i.status IN ('sent', 'partially_paid', 'paid')
  LOOP
    IF v_invoice.je_id IS NULL THEN CONTINUE; END IF;

    -- Check if COGS JE item count matches invoice item count
    DECLARE
      v_je_desc text;
      v_je_item_count int;
    BEGIN
      SELECT description INTO v_je_desc FROM journal_entries WHERE id = v_invoice.je_id;
      -- Extract item count from description like "COGS - INV-XXX (2 items, total: 4.00)"
      v_je_item_count := (regexp_match(v_je_desc, '\((\d+) items'))[1]::int;
      
      IF v_je_item_count >= v_invoice.item_count THEN
        CONTINUE; -- Already correct
      END IF;
    EXCEPTION WHEN OTHERS THEN
      CONTINUE; -- Skip if parsing fails
    END;

    -- Recalculate COGS for ALL items
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

    IF v_total_cogs > 0 AND v_line_count > 0 THEN
      -- Delete old lines
      DELETE FROM journal_lines WHERE journal_entry_id = v_invoice.je_id;

      -- Insert new lines
      FOR i IN 1..array_length(v_lines, 1) LOOP
        INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit, description, sort_order)
        VALUES (
          v_invoice.je_id,
          (v_lines[i]->>'account_id')::uuid,
          (v_lines[i]->>'debit')::decimal(15,2),
          (v_lines[i]->>'credit')::decimal(15,2),
          v_lines[i]->>'description',
          i
        );
      END LOOP;

      -- Update entry
      UPDATE journal_entries
      SET description = 'COGS - ' || v_invoice.invoice_number || ' (' || v_line_count || ' items, total: ' || v_total_cogs || ')',
          total_debit = v_total_cogs,
          total_credit = v_total_cogs
      WHERE id = v_invoice.je_id;

      v_count := v_count + 1;
      RAISE NOTICE 'Fixed COGS JE for %: % items, ৳%', v_invoice.invoice_number, v_line_count, v_total_cogs;
    END IF;
  END LOOP;

  RAISE NOTICE '=== COGS FIX COMPLETE: % invoices fixed ===', v_count;
END $$;

-- Verification
DO $$
DECLARE
  v_total int;
  v_with_cogs int;
  v_incomplete int;
BEGIN
  SELECT COUNT(*) INTO v_total FROM invoices WHERE status != 'cancelled';
  SELECT COUNT(DISTINCT i.id) INTO v_with_cogs FROM invoices i
  WHERE EXISTS (
    SELECT 1 FROM journal_entries je
    WHERE je.reference_type = 'invoice' AND je.reference_id = i.id
    AND je.description LIKE 'COGS%'
  );

  -- Check for incomplete COGS JEs
  SELECT COUNT(*) INTO v_incomplete
  FROM invoices i
  JOIN journal_entries je ON je.reference_type = 'invoice' AND je.reference_id = i.id AND je.description LIKE 'COGS%'
  WHERE i.status != 'cancelled'
  AND (regexp_match(je.description, '\((\d+) items'))[1]::int < (
    SELECT COUNT(*) FROM invoice_items ii WHERE ii.invoice_id = i.id
  );

  RAISE NOTICE '=== COGS FIX VERIFICATION ===';
  RAISE NOTICE 'Total non-cancelled invoices: %', v_total;
  RAISE NOTICE 'Invoices with COGS JE: %', v_with_cogs;
  RAISE NOTICE 'Invoices with incomplete COGS JE: %', v_incomplete;
  RAISE NOTICE '=== VERIFICATION COMPLETE ===';
END $$;
