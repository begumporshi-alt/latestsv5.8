/*
# FIFO Inventory Batch Tracking System

## Overview
Implements First-In-First-Out (FIFO) inventory costing. Each purchase creates a
"batch" (stock layer) with its own unit cost. When goods are sold, the oldest
batches are consumed first, and COGS is calculated from the actual purchase
costs of those batches — not from a static products.cost_price.

## New Tables
1. `inventory_batches` — One row per purchase/stock-in event. Tracks the unit
   cost, quantity received, and quantity remaining for each batch. Rows are
   ordered by `created_at` for FIFO consumption.
2. `invoice_item_batch_consumption` — Records which batches were consumed for
   each invoice item, including the quantity and cost taken from each batch.
   This enables reversal on invoice cancel/edit and sales returns.

## New Functions
1. `consume_fifo(p_product_id, p_warehouse_id, p_quantity, p_invoice_item_id)`
   — Consumes stock from oldest batch first. Updates
   `inventory_batches.quantity_remaining`. Inserts consumption records into
   `invoice_item_batch_consumption`. Returns the total COGS for the consumed
   quantity.
2. `restore_fifo(p_invoice_item_id)` — Restores consumed quantities back to
   their batches (used on invoice cancel/edit). Deletes the consumption records.
3. `get_fifo_inventory_value(p_warehouse_id)` — Returns total inventory value
   based on remaining batch quantities × unit cost.

## Modified Triggers
1. `invoice_items_cogs_trigger()` — Replaced to call `consume_fifo()` instead of
   using `products.cost_price`. Stores the returned COGS amount on the
   invoice_item's `cost_price` column so reports still work.
2. `invoice_status_cogs_trigger()` — Replaced to call `consume_fifo()` for items
   that were inserted while the invoice was draft.
3. GRN accounting trigger — Updated to create inventory_batches when goods are
   received (posted).

## Backfill
Creates a single "opening stock" batch per product-warehouse from existing
`inventory_items.quantity_on_hand` at the current `products.cost_price`, so
historical inventory is represented in the FIFO system.

## Security
- RLS enabled on both new tables.
- Authenticated users have full CRUD (internal ERP pattern, matching existing
  tables).
*/

-- ============================================================
-- 1. INVENTORY BATCHES TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS inventory_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id uuid REFERENCES product_variants(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  batch_number text,
  quantity_received decimal(15,3) NOT NULL DEFAULT 0,
  quantity_remaining decimal(15,3) NOT NULL DEFAULT 0,
  unit_cost decimal(15,2) NOT NULL DEFAULT 0,
  batch_type text NOT NULL DEFAULT 'purchase'
    CHECK (batch_type IN ('purchase','opening','adjustment','return')),
  reference_type text,
  reference_id uuid,
  reference_number text,
  notes text,
  created_by uuid REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inv_batches_product ON inventory_batches(product_id);
CREATE INDEX IF NOT EXISTS inv_batches_warehouse ON inventory_batches(warehouse_id);
CREATE INDEX IF NOT EXISTS inv_batches_remaining ON inventory_batches(product_id, warehouse_id, quantity_remaining);
CREATE INDEX IF NOT EXISTS inv_batches_created ON inventory_batches(created_at);

ALTER TABLE inventory_batches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ib_select" ON inventory_batches;
CREATE POLICY "ib_select" ON inventory_batches FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "ib_insert" ON inventory_batches;
CREATE POLICY "ib_insert" ON inventory_batches FOR INSERT TO authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "ib_update" ON inventory_batches;
CREATE POLICY "ib_update" ON inventory_batches FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "ib_delete" ON inventory_batches;
CREATE POLICY "ib_delete" ON inventory_batches FOR DELETE TO authenticated USING (true);

-- ============================================================
-- 2. INVOICE ITEM BATCH CONSUMPTION TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS invoice_item_batch_consumption (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_item_id uuid NOT NULL REFERENCES invoice_items(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL REFERENCES inventory_batches(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  quantity_consumed decimal(15,3) NOT NULL DEFAULT 0,
  unit_cost decimal(15,2) NOT NULL DEFAULT 0,
  cogs_amount decimal(15,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS iibc_invoice_item ON invoice_item_batch_consumption(invoice_item_id);
CREATE INDEX IF NOT EXISTS iibc_batch ON invoice_item_batch_consumption(batch_id);
CREATE INDEX IF NOT EXISTS iibc_product ON invoice_item_batch_consumption(product_id);

ALTER TABLE invoice_item_batch_consumption ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "iibc_select" ON invoice_item_batch_consumption;
CREATE POLICY "iibc_select" ON invoice_item_batch_consumption FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "iibc_insert" ON invoice_item_batch_consumption;
CREATE POLICY "iibc_insert" ON invoice_item_batch_consumption FOR INSERT TO authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "iibc_update" ON invoice_item_batch_consumption;
CREATE POLICY "iibc_update" ON invoice_item_batch_consumption FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "iibc_delete" ON invoice_item_batch_consumption;
CREATE POLICY "iibc_delete" ON invoice_item_batch_consumption FOR DELETE TO authenticated USING (true);

-- ============================================================
-- 3. CONSUME_FIFO FUNCTION
--    Consumes quantity from oldest batches first (FIFO).
--    Records consumption in invoice_item_batch_consumption.
--    Returns total COGS for the consumed quantity.
-- ============================================================
CREATE OR REPLACE FUNCTION consume_fifo(
  p_product_id uuid,
  p_warehouse_id uuid,
  p_quantity numeric,
  p_invoice_item_id uuid
)
RETURNS decimal(15,2)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_remaining_to_consume numeric := p_quantity;
  v_batch RECORD;
  v_consume_qty numeric;
  v_cogs_total decimal(15,2) := 0;
  v_tenant_id uuid := '00000000-0000-0000-0000-000000000001';
BEGIN
  IF p_quantity <= 0 THEN
    RETURN 0;
  END IF;

  -- Consume from oldest batches with remaining stock
  FOR v_batch IN
    SELECT id, unit_cost, quantity_remaining
    FROM inventory_batches
    WHERE product_id = p_product_id
      AND warehouse_id = p_warehouse_id
      AND quantity_remaining > 0
    ORDER BY created_at ASC, id ASC
    FOR UPDATE
  LOOP
    EXIT WHEN v_remaining_to_consume <= 0;

    v_consume_qty := LEAST(v_batch.quantity_remaining, v_remaining_to_consume);

    -- Reduce batch remaining
    UPDATE inventory_batches
    SET quantity_remaining = quantity_remaining - v_consume_qty
    WHERE id = v_batch.id;

    -- Record consumption
    INSERT INTO invoice_item_batch_consumption (
      invoice_item_id, batch_id, product_id, warehouse_id,
      quantity_consumed, unit_cost, cogs_amount
    ) VALUES (
      p_invoice_item_id, v_batch.id, p_product_id, p_warehouse_id,
      v_consume_qty, v_batch.unit_cost, v_consume_qty * v_batch.unit_cost
    );

    v_cogs_total := v_cogs_total + (v_consume_qty * v_batch.unit_cost);
    v_remaining_to_consume := v_remaining_to_consume - v_consume_qty;
  END LOOP;

  -- If no batches had stock, create a negative adjustment batch at product cost_price
  -- so COGS is still posted (matches old behavior for sell-without-stock scenario)
  IF v_remaining_to_consume > 0 THEN
    DECLARE
      v_fallback_cost decimal(15,2);
    BEGIN
      SELECT COALESCE(cost_price, 0) INTO v_fallback_cost
      FROM products WHERE id = p_product_id;

      INSERT INTO invoice_item_batch_consumption (
        invoice_item_id, batch_id, product_id, warehouse_id,
        quantity_consumed, unit_cost, cogs_amount
      ) VALUES (
        p_invoice_item_id, NULL, p_product_id, p_warehouse_id,
        v_remaining_to_consume, v_fallback_cost, v_remaining_to_consume * v_fallback_cost
      );

      v_cogs_total := v_cogs_total + (v_remaining_to_consume * v_fallback_cost);
    END;
  END IF;

  RETURN v_cogs_total;
END;
$$;

-- ============================================================
-- 4. RESTORE_FIFO FUNCTION
--    Restores consumed quantities back to batches for an invoice item.
--    Used when an invoice is cancelled or edited.
--    Deletes the consumption records.
-- ============================================================
CREATE OR REPLACE FUNCTION restore_fifo(p_invoice_item_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_consumption RECORD;
BEGIN
  FOR v_consumption IN
    SELECT id, batch_id, quantity_consumed
    FROM invoice_item_batch_consumption
    WHERE invoice_item_id = p_invoice_item_id
    FOR UPDATE
  LOOP
    -- Restore quantity to the batch (if batch still exists)
    IF v_consumption.batch_id IS NOT NULL THEN
      UPDATE inventory_batches
      SET quantity_remaining = quantity_remaining + v_consumption.quantity_consumed
      WHERE id = v_consumption.batch_id;
    END IF;

    -- Delete the consumption record
    DELETE FROM invoice_item_batch_consumption WHERE id = v_consumption.id;
  END LOOP;
END;
$$;

-- ============================================================
-- 5. GET_FIFO_INVENTORY_VALUE FUNCTION
--    Returns total inventory value based on remaining batch quantities.
-- ============================================================
CREATE OR REPLACE FUNCTION get_fifo_inventory_value(p_warehouse_id uuid DEFAULT NULL)
RETURNS decimal(15,2)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT COALESCE(SUM(quantity_remaining * unit_cost), 0)
  FROM inventory_batches
  WHERE (p_warehouse_id IS NULL OR warehouse_id = p_warehouse_id)
    AND quantity_remaining > 0;
$$;

-- ============================================================
-- 6. BACKFILL: Create opening stock batches from existing inventory
-- ============================================================
DO $$
DECLARE
  v_inv RECORD;
  v_batch_num text;
  v_counter integer := 0;
BEGIN
  FOR v_inv IN
    SELECT i.product_id, i.variant_id, i.warehouse_id,
           i.quantity_on_hand, COALESCE(p.cost_price, 0) AS cost_price
    FROM inventory_items i
    JOIN products p ON p.id = i.product_id
    WHERE i.quantity_on_hand > 0
    AND NOT EXISTS (
      SELECT 1 FROM inventory_batches ib
      WHERE ib.product_id = i.product_id
        AND ib.warehouse_id = i.warehouse_id
        AND ib.batch_type = 'opening'
    )
  LOOP
    v_counter := v_counter + 1;
    v_batch_num := 'OPN-' || lpad(v_counter::text, 6, '0');

    INSERT INTO inventory_batches (
      product_id, variant_id, warehouse_id, batch_number,
      quantity_received, quantity_remaining, unit_cost,
      batch_type, reference_type, notes, created_at
    ) VALUES (
      v_inv.product_id, v_inv.variant_id, v_inv.warehouse_id, v_batch_num,
      v_inv.quantity_on_hand, v_inv.quantity_on_hand, v_inv.cost_price,
      'opening', 'inventory', 'Opening stock batch (FIFO backfill)',
      '2026-06-01T00:00:00Z'
    );

    RAISE NOTICE 'Created opening batch for product %, warehouse %, qty %, cost %',
      v_inv.product_id, v_inv.warehouse_id, v_inv.quantity_on_hand, v_inv.cost_price;
  END LOOP;
  RAISE NOTICE 'Backfill complete: % opening batches created', v_counter;
END $$;

-- ============================================================
-- 7. UPDATE COGS TRIGGERS TO USE FIFO
-- ============================================================

-- 7a. Per-item COGS trigger (fires on invoice_items INSERT for non-draft invoices)
CREATE OR REPLACE FUNCTION invoice_items_cogs_trigger()
RETURNS TRIGGER AS $$
DECLARE
  v_cogs_account uuid;
  v_inventory_account uuid;
  v_cogs_amount decimal(15,2);
  v_invoice_record RECORD;
  v_product RECORD;
  v_default_wh uuid;
  v_qty numeric;
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

  -- Use quantity (not base_quantity) since cost is per sales unit
  v_qty := NEW.quantity;

  IF v_qty <= 0 THEN
    RETURN NEW;
  END IF;

  -- Idempotency: skip if consumption records already exist for this invoice item
  PERFORM 1 FROM invoice_item_batch_consumption WHERE invoice_item_id = NEW.id;
  IF FOUND THEN
    RETURN NEW;
  END IF;

  SELECT name, sku INTO v_product FROM products WHERE id = NEW.product_id;
  v_product_name := COALESCE(v_product.name, 'Unknown');

  -- Get warehouse from invoice, or default
  v_default_wh := v_invoice_record.warehouse_id;
  IF v_default_wh IS NULL THEN
    SELECT id INTO v_default_wh FROM warehouses WHERE is_default = true AND is_active = true LIMIT 1;
  END IF;
  IF v_default_wh IS NULL THEN
    SELECT id INTO v_default_wh FROM warehouses WHERE is_active = true LIMIT 1;
  END IF;

  -- Consume from FIFO batches and get actual COGS
  v_cogs_amount := consume_fifo(NEW.product_id, v_default_wh, v_qty, NEW.id);

  IF v_cogs_amount <= 0 THEN
    RETURN NEW;
  END IF;

  -- Update the invoice item's cost_price with the FIFO-calculated cost
  -- so reports that read cost_price from invoice_items stay correct
  UPDATE invoice_items SET cost_price = v_cogs_amount / v_qty
  WHERE id = NEW.id;

  v_desc := 'COGS (FIFO): ' || v_product_name ||
    ' (SKU: ' || COALESCE(v_product.sku, 'N/A') || ') - Qty: ' || v_qty ||
    ' x Avg Cost: ' || round(v_cogs_amount / v_qty, 2) || ' = ' || v_cogs_amount;

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
        'description', 'Inventory released (FIFO): ' || v_product_name ||
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

-- 7b. Status-change COGS trigger (fires when draft → active)
CREATE OR REPLACE FUNCTION invoice_status_cogs_trigger()
RETURNS TRIGGER AS $$
DECLARE
  v_cogs_account uuid;
  v_inventory_account uuid;
  v_cogs_amount decimal(15,2);
  v_item RECORD;
  v_default_wh uuid;
  v_qty numeric;
  v_product RECORD;
  v_product_name text;
  v_desc text;
  v_je_desc text;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'draft' AND NEW.status IN ('sent', 'partially_paid', 'paid') THEN
    SELECT id INTO v_cogs_account FROM accounts WHERE code = '5000' LIMIT 1;
    SELECT id INTO v_inventory_account FROM accounts WHERE code = '1200' LIMIT 1;

    IF v_cogs_account IS NULL OR v_inventory_account IS NULL THEN
      RETURN NEW;
    END IF;

    -- Get warehouse from invoice, or default
    v_default_wh := NEW.warehouse_id;
    IF v_default_wh IS NULL THEN
      SELECT id INTO v_default_wh FROM warehouses WHERE is_default = true AND is_active = true LIMIT 1;
    END IF;
    IF v_default_wh IS NULL THEN
      SELECT id INTO v_default_wh FROM warehouses WHERE is_active = true LIMIT 1;
    END IF;

    FOR v_item IN SELECT * FROM invoice_items WHERE invoice_id = NEW.id ORDER BY sort_order LOOP
      v_qty := v_item.quantity;
      IF v_qty <= 0 THEN
        CONTINUE;
      END IF;

      -- Skip if already consumed (per-item trigger may have handled it)
      PERFORM 1 FROM invoice_item_batch_consumption WHERE invoice_item_id = v_item.id;
      IF FOUND THEN
        CONTINUE;
      END IF;

      SELECT name, sku INTO v_product FROM products WHERE id = v_item.product_id;
      v_product_name := COALESCE(v_product.name, 'Unknown');

      v_cogs_amount := consume_fifo(v_item.product_id, v_default_wh, v_qty, v_item.id);

      IF v_cogs_amount > 0 THEN
        -- Update cost_price with FIFO cost
        UPDATE invoice_items SET cost_price = v_cogs_amount / v_qty
        WHERE id = v_item.id;

        v_desc := 'COGS (FIFO): ' || v_product_name ||
          ' (SKU: ' || COALESCE(v_product.sku, 'N/A') || ') - Qty: ' || v_qty ||
          ' x Avg Cost: ' || round(v_cogs_amount / v_qty, 2) || ' = ' || v_cogs_amount;

        v_je_desc := 'COGS - ' || NEW.invoice_number || ' - ' || v_product_name;

        PERFORM post_journal_entry(
          v_je_desc,
          COALESCE(NEW.invoice_date, CURRENT_DATE),
          'invoice',
          NEW.id,
          json_build_array(
            json_build_object('account_id', v_cogs_account, 'debit', v_cogs_amount, 'credit', 0,
              'description', v_desc),
            json_build_object('account_id', v_inventory_account, 'debit', 0, 'credit', v_cogs_amount,
              'description', 'Inventory released (FIFO): ' || v_product_name ||
              ' (Qty: ' || v_qty || ') for ' || NEW.invoice_number)
          )::json,
          NEW.customer_id
        );
      END IF;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 8. UPDATE GRN TRIGGER TO CREATE BATCHES ON GOODS RECEIPT
-- ============================================================
CREATE OR REPLACE FUNCTION grn_accounting_trigger()
RETURNS TRIGGER AS $$
DECLARE
  v_tenant_id uuid;
  v_total_cost decimal(15,2);
  v_po_number text;
  v_item RECORD;
  v_batch_counter integer := 0;
  v_batch_num text;
BEGIN
  v_tenant_id := COALESCE(NEW.tenant_id, '00000000-0000-0000-0000-000000000001');

  IF TG_OP = 'UPDATE' AND NEW.status = 'posted' AND OLD.status != 'posted' THEN
    SELECT po.po_number INTO v_po_number
    FROM purchase_orders po
    WHERE po.id = NEW.purchase_order_id;

    FOR v_item IN
      SELECT poi.product_id, poi.variant_id, poi.received_quantity, poi.unit_cost
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
        v_item.product_id, v_item.variant_id, NEW.warehouse_id, v_batch_num,
        v_item.received_quantity, v_item.received_quantity, v_item.unit_cost,
        'purchase', 'grn', NEW.id, NEW.grn_number,
        'Goods received via GRN', COALESCE(NEW.received_date, CURRENT_DATE)
      );
    END LOOP;

    -- Post the AP journal entry (existing logic)
    SELECT COALESCE(SUM(poi.received_quantity * poi.unit_cost), 0)
    INTO v_total_cost
    FROM purchase_order_items poi
    WHERE poi.purchase_order_id = NEW.purchase_order_id;

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
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- 9. UPDATE INVOICE COGS TRIGGER (invoice-level, uses account_code)
--    This is the version from migration 20260701092813 that uses
--    account_code instead of account_id. Update it to use FIFO.
-- ============================================================
CREATE OR REPLACE FUNCTION invoice_cogs_trigger()
RETURNS TRIGGER AS $$
DECLARE
  v_tenant_id uuid;
  v_cogs_total decimal(15,2) := 0;
  v_item record;
  v_default_wh uuid;
  v_qty numeric;
  v_cogs_amount decimal(15,2);
BEGIN
  v_tenant_id := COALESCE(NEW.tenant_id, '00000000-0000-0000-0000-000000000001');

  IF NOT (
    (TG_OP = 'INSERT' AND NEW.status IN ('paid', 'sent', 'partial')) OR
    (TG_OP = 'UPDATE' AND NEW.status IN ('sent', 'paid', 'partial') AND OLD.status = 'draft')
  ) THEN
    RETURN NEW;
  END IF;

  -- Get warehouse
  v_default_wh := NEW.warehouse_id;
  IF v_default_wh IS NULL THEN
    SELECT id INTO v_default_wh FROM warehouses WHERE is_default = true AND is_active = true LIMIT 1;
  END IF;
  IF v_default_wh IS NULL THEN
    SELECT id INTO v_default_wh FROM warehouses WHERE is_active = true LIMIT 1;
  END IF;

  FOR v_item IN
    SELECT ii.id, ii.product_id, ii.quantity
    FROM invoice_items ii
    WHERE ii.invoice_id = NEW.id
  LOOP
    v_qty := v_item.quantity;
    IF v_qty <= 0 THEN
      CONTINUE;
    END IF;

    -- Skip if already consumed by per-item trigger
    PERFORM 1 FROM invoice_item_batch_consumption WHERE invoice_item_id = v_item.id;
    IF FOUND THEN
      -- Sum the already-posted COGS from consumption records
      SELECT COALESCE(SUM(cogs_amount), 0) INTO v_cogs_amount
      FROM invoice_item_batch_consumption WHERE invoice_item_id = v_item.id;
      v_cogs_total := v_cogs_total + v_cogs_amount;
      CONTINUE;
    END IF;

    v_cogs_amount := consume_fifo(v_item.product_id, v_default_wh, v_qty, v_item.id);
    v_cogs_total := v_cogs_total + v_cogs_amount;

    -- Update cost_price with FIFO cost
    IF v_qty > 0 AND v_cogs_amount > 0 THEN
      UPDATE invoice_items SET cost_price = v_cogs_amount / v_qty WHERE id = v_item.id;
    END IF;
  END LOOP;

  IF v_cogs_total > 0 THEN
    PERFORM post_journal_entry(
      p_description := 'COGS (FIFO) - Invoice #' || NEW.invoice_number,
      p_lines := jsonb_build_array(
        jsonb_build_object('account_code', '5000', 'debit', v_cogs_total, 'description', 'Cost of Goods Sold'),
        jsonb_build_object('account_code', '1200', 'credit', v_cogs_total, 'description', 'Inventory reduced (FIFO)')
      ),
      p_entry_date := COALESCE(NEW.invoice_date, CURRENT_DATE),
      p_reference_type := 'invoice',
      p_reference_id := NEW.id,
      p_tenant_id := v_tenant_id
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- 10. Recalculate account balances after backfill
-- ============================================================
DO $$
DECLARE
  acc RECORD;
  calc_balance numeric;
BEGIN
  FOR acc IN SELECT id, account_type FROM accounts WHERE is_active = true LOOP
    SELECT COALESCE(SUM(debit - credit), 0) INTO calc_balance
    FROM journal_lines WHERE account_id = acc.id;

    IF acc.account_type IN ('liability', 'equity', 'revenue') THEN
      calc_balance := -calc_balance;
    END IF;

    UPDATE accounts SET balance = calc_balance WHERE id = acc.id;
  END LOOP;
END $$;
