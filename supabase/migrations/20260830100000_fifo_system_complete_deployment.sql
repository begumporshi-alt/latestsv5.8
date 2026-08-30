-- ============================================================
-- FIFO SYSTEM: COMPLETE DEPLOYMENT & BACKFILL
-- Date: 2026-08-30
-- Author: Buffy (Codebuff)
--
-- This migration:
--   1. Ensures inventory_batches table exists with RLS
--   2. Ensures invoice_item_batch_consumption table exists with RLS
--   3. Creates/updates consume_fifo() function (with NULL warehouse_id handling)
--   4. Creates/updates restore_fifo() function
--   5. Creates/updates get_fifo_inventory_value() function
--   6. Creates trg_invoice_items_cogs trigger (auto FIFO on sale)
--   7. Cleans up duplicate inventory batches
--   8. Backfills consumption records for all existing sales
--
-- Applied via: PostgreSQL direct connection (not Supabase SQL Editor)
-- ============================================================

-- ============================================================
-- SECTION 1: TABLES
-- ============================================================

-- 1a. inventory_batches — one row per stock-in event
CREATE TABLE IF NOT EXISTS inventory_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id uuid,
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
  created_by uuid,
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

-- 1b. invoice_item_batch_consumption — link between sales and batches
CREATE TABLE IF NOT EXISTS invoice_item_batch_consumption (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_item_id uuid NOT NULL REFERENCES invoice_items(id) ON DELETE CASCADE,
  batch_id uuid REFERENCES inventory_batches(id) ON DELETE CASCADE,
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

-- ============================================================
-- SECTION 2: FUNCTIONS
-- ============================================================

-- 2a. exec_sql helper (for diagnostic queries)
CREATE OR REPLACE FUNCTION exec_sql(sql text)
RETURNS SETOF json AS $$
BEGIN
  RETURN QUERY EXECUTE sql;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2b. consume_fifo — consume stock from oldest batches (FIFO order)
-- Handles NULL warehouse_id by falling back to default warehouse
DROP FUNCTION IF EXISTS consume_fifo(uuid, uuid, numeric, numeric, uuid);
DROP FUNCTION IF EXISTS consume_fifo(uuid, uuid, numeric, numeric);
DROP FUNCTION IF EXISTS consume_fifo(uuid, uuid, uuid, numeric, numeric);

CREATE OR REPLACE FUNCTION consume_fifo(
  p_invoice_item_id uuid,
  p_product_id uuid,
  p_warehouse_id uuid,
  p_quantity numeric,
  p_unit_cost numeric
)
RETURNS void AS $$
DECLARE
  v_remaining numeric := p_quantity;
  v_batch record;
  v_consume numeric;
  v_wh uuid;
  v_cogs numeric;
BEGIN
  -- If warehouse_id is NULL, find default warehouse
  v_wh := COALESCE(p_warehouse_id, (
    SELECT id FROM warehouses WHERE is_default = true AND is_active = true LIMIT 1
  ));

  IF v_wh IS NULL THEN
    RAISE WARNING 'consume_fifo: No warehouse found for product %', p_product_id;
    RETURN;
  END IF;

  -- Idempotency guard: skip if already consumed
  IF EXISTS (SELECT 1 FROM invoice_item_batch_consumption WHERE invoice_item_id = p_invoice_item_id) THEN
    RETURN;
  END IF;

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

  -- If still remaining (no batches with stock), create fallback
  IF v_remaining > 0 THEN
    DECLARE
      v_fallback_id uuid;
      v_base_cost numeric;
    BEGIN
      -- Use products.cost_price (always in base units) for fallback
      SELECT cost_price INTO v_base_cost FROM products WHERE id = p_product_id;
      v_base_cost := COALESCE(v_base_cost, 0);

      INSERT INTO inventory_batches (
        product_id, warehouse_id, batch_number, quantity_received,
        quantity_remaining, unit_cost, batch_type, notes
      ) VALUES (
        p_product_id, v_wh, 'FIFO-FALLBACK-' || substr(p_product_id::text, 1, 8),
        0, 0, v_base_cost, 'adjustment', 'Created by consume_fifo fallback'
      ) RETURNING id INTO v_fallback_id;

      INSERT INTO invoice_item_batch_consumption (
        invoice_item_id, batch_id, product_id, warehouse_id,
        quantity_consumed, unit_cost, cogs_amount
      ) VALUES (
        p_invoice_item_id, v_fallback_id, p_product_id, v_wh,
        v_remaining, v_base_cost, v_remaining * v_base_cost
      );
    END;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2c. restore_fifo — restore stock to batches (on invoice edit/cancel)
CREATE OR REPLACE FUNCTION restore_fifo(
  p_invoice_item_id uuid
)
RETURNS void AS $$
DECLARE
  v_item record;
  v_wh uuid;
BEGIN
  -- Get the invoice item details
  SELECT ii.product_id, ii.warehouse_id, ii.quantity, ii.base_quantity
  INTO v_item
  FROM invoice_items ii
  WHERE ii.id = p_invoice_item_id;

  IF NOT FOUND THEN RETURN; END IF;

  v_wh := COALESCE(v_item.warehouse_id, (
    SELECT id FROM warehouses WHERE is_default = true AND is_active = true LIMIT 1
  ));

  IF v_wh IS NULL THEN RETURN; END IF;

  -- Restore to the most recent batch (LIFO restoration)
  UPDATE inventory_batches
  SET quantity_remaining = quantity_remaining + COALESCE(v_item.base_quantity, v_item.quantity)
  WHERE product_id = v_item.product_id
    AND warehouse_id = v_wh
    AND batch_type != 'adjustment'
  ORDER BY created_at DESC
  LIMIT 1;

  -- If no non-adjustment batch found, restore to any batch
  IF NOT FOUND THEN
    UPDATE inventory_batches
    SET quantity_remaining = quantity_remaining + COALESCE(v_item.base_quantity, v_item.quantity)
    WHERE product_id = v_item.product_id
      AND warehouse_id = v_wh
    ORDER BY created_at DESC
    LIMIT 1;
  END IF;

  -- Delete consumption records
  DELETE FROM invoice_item_batch_consumption
  WHERE invoice_item_id = p_invoice_item_id;

  -- Delete temporary fallback batches (zero remaining, adjustment type)
  DELETE FROM inventory_batches
  WHERE product_id = v_item.product_id
    AND warehouse_id = v_wh
    AND batch_type = 'adjustment'
    AND quantity_remaining = 0
    AND batch_number LIKE 'FIFO-FALLBACK-%';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2d. get_fifo_inventory_value — get total inventory value using FIFO batches
CREATE OR REPLACE FUNCTION get_fifo_inventory_value()
RETURNS TABLE (
  product_id uuid,
  product_name text,
  product_sku text,
  warehouse_name text,
  quantity_on_hand numeric,
  batch_value numeric,
  avg_cost numeric
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    p.id as product_id,
    p.name as product_name,
    p.sku as product_sku,
    w.name as warehouse_name,
    COALESCE(ii.quantity_on_hand, 0) as quantity_on_hand,
    COALESCE(SUM(ib.quantity_remaining * ib.unit_cost), 0) as batch_value,
    CASE
      WHEN COALESCE(SUM(ib.quantity_remaining), 0) > 0
      THEN ROUND(SUM(ib.quantity_remaining * ib.unit_cost) / SUM(ib.quantity_remaining), 2)
      ELSE 0
    END as avg_cost
  FROM products p
  JOIN inventory_items ii ON ii.product_id = p.id
  JOIN warehouses w ON ii.warehouse_id = w.id
  LEFT JOIN inventory_batches ib ON ib.product_id = p.id AND ib.warehouse_id = ii.warehouse_id
  WHERE ii.quantity_on_hand > 0
  GROUP BY p.id, p.name, p.sku, w.name, ii.quantity_on_hand
  ORDER BY p.name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- SECTION 3: TRIGGERS
-- ============================================================

-- 3a. Trigger function: auto-consume FIFO on invoice item insert
CREATE OR REPLACE FUNCTION trg_invoice_items_cogs_fn()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM consume_fifo(
    NEW.id,
    NEW.product_id,
    NEW.warehouse_id,
    COALESCE(NEW.base_quantity, NEW.quantity),
    COALESCE(NEW.cost_price, 0)
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3b. Install trigger on invoice_items
DROP TRIGGER IF EXISTS trg_invoice_items_cogs ON invoice_items;
CREATE TRIGGER trg_invoice_items_cogs
  AFTER INSERT ON invoice_items
  FOR EACH ROW
  EXECUTE FUNCTION trg_invoice_items_cogs_fn();

-- ============================================================
-- SECTION 4: CLEANUP — Remove duplicate batches
-- ============================================================

DELETE FROM inventory_batches
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY product_id, warehouse_id, batch_number
      ORDER BY created_at
    ) as rn
    FROM inventory_batches
  ) t WHERE rn > 1
);

-- ============================================================
-- SECTION 5: BACKFILL — Create consumption for existing sales
-- ============================================================

DO $$
DECLARE
  v_item record;
  v_wh uuid;
  v_remaining numeric;
  v_consume numeric;
  v_batch record;
  v_cogs numeric;
  v_fallback_id uuid;
  v_count integer := 0;
  v_skip integer := 0;
  v_base_cost numeric;
BEGIN
  RAISE NOTICE 'Starting FIFO backfill...';

  FOR v_item IN
    SELECT ii.id, ii.product_id, ii.quantity, ii.base_quantity, ii.cost_price, ii.warehouse_id
    FROM invoice_items ii
    JOIN invoices i ON ii.invoice_id = i.id
    WHERE i.status != 'cancelled'
    AND NOT EXISTS (
      SELECT 1 FROM invoice_item_batch_consumption iibc
      WHERE iibc.invoice_item_id = ii.id
    )
    ORDER BY i.invoice_date DESC, ii.id
  LOOP
    v_remaining := COALESCE(v_item.base_quantity, v_item.quantity);
    v_wh := COALESCE(v_item.warehouse_id, (
      SELECT id FROM warehouses WHERE is_default = true AND is_active = true LIMIT 1
    ));

    IF v_wh IS NULL THEN
      v_skip := v_skip + 1;
      CONTINUE;
    END IF;

    IF EXISTS (SELECT 1 FROM invoice_item_batch_consumption WHERE invoice_item_id = v_item.id) THEN
      v_skip := v_skip + 1;
      CONTINUE;
    END IF;

    FOR v_batch IN
      SELECT id, quantity_remaining, unit_cost
      FROM inventory_batches
      WHERE product_id = v_item.product_id
        AND warehouse_id = v_wh
        AND quantity_remaining > 0
      ORDER BY created_at ASC
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
        v_item.id, v_batch.id, v_item.product_id, v_wh,
        v_consume, v_batch.unit_cost, v_cogs
      );

      v_remaining := v_remaining - v_consume;
    END LOOP;

    IF v_remaining > 0 THEN
      SELECT cost_price INTO v_base_cost FROM products WHERE id = v_item.product_id;
      v_base_cost := COALESCE(v_base_cost, 0);

      INSERT INTO inventory_batches (
        product_id, warehouse_id, batch_number, quantity_received,
        quantity_remaining, unit_cost, batch_type, notes
      ) VALUES (
        v_item.product_id, v_wh, 'FIFO-FALLBACK-' || substr(v_item.product_id::text, 1, 8),
        0, 0, v_base_cost, 'adjustment', 'FIFO backfill fallback'
      ) RETURNING id INTO v_fallback_id;

      INSERT INTO invoice_item_batch_consumption (
        invoice_item_id, batch_id, product_id, warehouse_id,
        quantity_consumed, unit_cost, cogs_amount
      ) VALUES (
        v_item.id, v_fallback_id, v_item.product_id, v_wh,
        v_remaining, v_base_cost, v_remaining * v_base_cost
      );
    END IF;

    v_count := v_count + 1;

    IF v_count % 500 = 0 THEN
      RAISE NOTICE 'Backfill progress: % items processed', v_count;
    END IF;
  END LOOP;

  RAISE NOTICE 'Backfill complete: % items processed, % skipped', v_count, v_skip;
END $$;

-- ============================================================
-- SECTION 6: VERIFICATION
-- ============================================================

DO $$
DECLARE
  b integer;
  c integer;
  f integer;
  t integer;
  v_total_invoices integer;
  v_invoices_with_cons integer;
BEGIN
  SELECT COUNT(*) INTO b FROM inventory_batches;
  SELECT COUNT(*) INTO c FROM invoice_item_batch_consumption;
  SELECT COUNT(*) INTO f FROM pg_proc WHERE proname IN ('consume_fifo', 'restore_fifo', 'get_fifo_inventory_value');
  SELECT COUNT(*) INTO t FROM pg_trigger WHERE tgname = 'trg_invoice_items_cogs';

  SELECT COUNT(DISTINCT i.id) INTO v_total_invoices
  FROM invoices i WHERE i.status != 'cancelled';

  SELECT COUNT(DISTINCT i.id) INTO v_invoices_with_cons
  FROM invoices i
  WHERE EXISTS (
    SELECT 1 FROM invoice_items ii
    JOIN invoice_item_batch_consumption iibc ON iibc.invoice_item_id = ii.id
    WHERE ii.invoice_id = i.id
  );

  RAISE NOTICE '=== FIFO DEPLOYMENT VERIFICATION ===';
  RAISE NOTICE 'Inventory batches: %', b;
  RAISE NOTICE 'Consumption records: %', c;
  RAISE NOTICE 'FIFO functions (consume_fifo, restore_fifo, get_fifo_inventory_value): %', f;
  RAISE NOTICE 'COGS trigger (trg_invoice_items_cogs): %', CASE WHEN t > 0 THEN 'INSTALLED' ELSE 'MISSING' END;
  RAISE NOTICE 'Invoices with consumption: % / %', v_invoices_with_cons, v_total_invoices;
  RAISE NOTICE '=== DEPLOYMENT COMPLETE ===';
END $$;
