-- 2026-09-01: Housekeeping batch (audit fix #7).
--
-- Four out-of-band database objects existed only as live deployments (never in
-- migrations): rebuilding the DB from migrations would break stock transfers,
-- purchase returns, and the inventory-value RPC. This backfills them verbatim
-- from the live definitions. Plus:
--   - drop trg_invoice_insert_cogs (dead: calls a consume_fifo overload that
--     doesn't exist; unreachable only due to FK ordering)
--   - fix the latent void-assignment in invoice_status_cogs_trigger
--     (v_amt := consume_fifo(...) assigned a void function's result to numeric)
--   - revoke exec_sql from anon/authenticated (SECURITY DEFINER arbitrary-SQL
--     helper; only used by a local debug script, not the app)

BEGIN;

-- 1. Backfill: get_fifo_inventory_value (scalar, live definition)
CREATE OR REPLACE FUNCTION public.get_fifo_inventory_value(p_warehouse_id uuid DEFAULT NULL::uuid)
 RETURNS numeric
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
        SELECT COALESCE(SUM(quantity_remaining * unit_cost), 0) FROM inventory_batches
        WHERE (p_warehouse_id IS NULL OR warehouse_id = p_warehouse_id) AND quantity_remaining > 0;
      $function$;


GRANT EXECUTE ON FUNCTION get_fifo_inventory_value(uuid) TO authenticated;

-- 2. Backfill: transfer_fifo_batches (live definition)
CREATE OR REPLACE FUNCTION public.transfer_fifo_batches(p_product_id uuid, p_from_warehouse_id uuid, p_to_warehouse_id uuid, p_quantity numeric, p_reference_id uuid DEFAULT NULL::uuid, p_reference_number text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
v_remaining numeric := p_quantity;
v_batch RECORD;
v_consume_qty numeric;
v_batch_number text;
BEGIN
IF p_quantity <= 0 THEN
RETURN;
END IF;

FOR v_batch IN
SELECT id, unit_cost, quantity_remaining
FROM inventory_batches
WHERE product_id = p_product_id
AND warehouse_id = p_from_warehouse_id
AND quantity_remaining > 0
ORDER BY created_at ASC, id ASC
FOR UPDATE
LOOP
EXIT WHEN v_remaining <= 0;

v_consume_qty := LEAST(v_batch.quantity_remaining, v_remaining);

-- Reduce source batch
UPDATE inventory_batches
SET quantity_remaining = quantity_remaining - v_consume_qty
WHERE id = v_batch.id;

-- Create destination batch with same cost
v_batch_number := 'TRF-' || COALESCE(p_reference_number, 'MANUAL');
INSERT INTO inventory_batches (
product_id, warehouse_id, batch_number,
quantity_received, quantity_remaining, unit_cost,
batch_type, reference_type, reference_id, reference_number,
notes
) VALUES (
p_product_id, p_to_warehouse_id, v_batch_number,
v_consume_qty, v_consume_qty, v_batch.unit_cost,
'adjustment', 'transfer', p_reference_id, p_reference_number,
'Transferred from ' || p_from_warehouse_id::text
);

v_remaining := v_remaining - v_consume_qty;
END LOOP;

-- If v_remaining > 0, there wasn't enough batch stock to transfer.
-- The inventory_items table may still have stock (pre-FIFO legacy).
-- Create a fallback batch at product cost_price.
IF v_remaining > 0 THEN
DECLARE
v_fallback_cost decimal(15,2);
BEGIN
SELECT COALESCE(cost_price, 0) INTO v_fallback_cost
FROM products WHERE id = p_product_id;

INSERT INTO inventory_batches (
product_id, warehouse_id, batch_number,
quantity_received, quantity_remaining, unit_cost,
batch_type, reference_type, reference_id, reference_number,
notes
) VALUES (
p_product_id, p_to_warehouse_id, 'TRF-' || COALESCE(p_reference_number, 'MANUAL'),
v_remaining, v_remaining, v_fallback_cost,
'adjustment', 'transfer', p_reference_id, p_reference_number,
'Transferred from ' || p_from_warehouse_id::text || ' (fallback at product cost)'
);
END;
END IF;
END;
$function$;


GRANT EXECUTE ON FUNCTION transfer_fifo_batches(uuid, uuid, uuid, numeric, uuid, text) TO authenticated;

-- 3. Backfill: reverse_fifo_on_purchase_return (live definition)
CREATE OR REPLACE FUNCTION public.reverse_fifo_on_purchase_return(p_product_id uuid, p_warehouse_id uuid, p_quantity numeric, p_unit_cost numeric DEFAULT 0, p_reference_id uuid DEFAULT NULL::uuid, p_reference_number text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
v_remaining numeric := p_quantity;
v_batch RECORD;
v_reduce_qty numeric;
BEGIN
IF p_quantity <= 0 THEN
RETURN;
END IF;

FOR v_batch IN
SELECT id, quantity_remaining
FROM inventory_batches
WHERE product_id = p_product_id
AND warehouse_id = p_warehouse_id
AND quantity_remaining > 0
ORDER BY created_at DESC, id DESC
FOR UPDATE
LOOP
EXIT WHEN v_remaining <= 0;

v_reduce_qty := LEAST(v_batch.quantity_remaining, v_remaining);

UPDATE inventory_batches
SET quantity_remaining = quantity_remaining - v_reduce_qty
WHERE id = v_batch.id;

v_remaining := v_remaining - v_reduce_qty;
END LOOP;

-- If v_remaining > 0 here, the user is returning more than batch stock allows.
-- We silently ignore the overflow rather than creating negative batches.
END;
$function$;


GRANT EXECUTE ON FUNCTION reverse_fifo_on_purchase_return(uuid, uuid, numeric, numeric, uuid, text) TO authenticated;


-- 4. Backfill: purchase_returns tables (out-of-band DDL, live structure)
CREATE TABLE IF NOT EXISTS purchase_returns (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  return_number text NOT NULL,
  purchase_order_id uuid,
  supplier_id uuid,
  warehouse_id uuid,
  return_date date DEFAULT CURRENT_DATE,
  total_amount numeric(15,2) DEFAULT 0,
  status text DEFAULT 'completed',
  notes text,
  journal_entry_id uuid,
  created_by uuid,
  created_at timestamptz DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='purchase_returns'::regclass AND conname='purchase_returns_return_number_key') THEN
    ALTER TABLE purchase_returns ADD CONSTRAINT purchase_returns_return_number_key UNIQUE (return_number);
  END IF;
END $$;
ALTER TABLE purchase_returns DROP CONSTRAINT IF EXISTS purchase_returns_supplier_id_fkey;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='purchase_returns'::regclass AND conname='purchase_returns_supplier_id_fkey') THEN
    ALTER TABLE purchase_returns ADD CONSTRAINT purchase_returns_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES suppliers(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='purchase_returns'::regclass AND conname='purchase_returns_purchase_order_id_fkey') THEN
    ALTER TABLE purchase_returns ADD CONSTRAINT purchase_returns_purchase_order_id_fkey FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS purchase_return_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  purchase_return_id uuid NOT NULL,
  product_id uuid NOT NULL,
  quantity numeric(15,3) NOT NULL,
  unit_cost numeric(15,2) DEFAULT 0,
  subtotal numeric(15,2) DEFAULT 0,
  reason text,
  created_at timestamptz DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='purchase_return_items'::regclass AND conname='purchase_return_items_purchase_return_id_fkey') THEN
    ALTER TABLE purchase_return_items ADD CONSTRAINT purchase_return_items_purchase_return_id_fkey FOREIGN KEY (purchase_return_id) REFERENCES purchase_returns(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='purchase_return_items'::regclass AND conname='purchase_return_items_product_id_fkey') THEN
    ALTER TABLE purchase_return_items ADD CONSTRAINT purchase_return_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_purchase_returns_supplier ON purchase_returns(supplier_id);
CREATE INDEX IF NOT EXISTS idx_purchase_returns_po ON purchase_returns(purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_purchase_return_items_return ON purchase_return_items(purchase_return_id);

-- 5. Drop the dead trigger: invoice_insert_cogs_trigger calls a 4-arg
--    consume_fifo overload that does not exist; it only survives because FK
--    ordering prevents items from existing before their invoice.
DROP TRIGGER IF EXISTS trg_invoice_insert_cogs ON invoices;
DROP FUNCTION IF EXISTS invoice_insert_cogs_trigger();

-- 6. Revoke the arbitrary-SQL helper from client roles (postgres-only now).
REVOKE EXECUTE ON FUNCTION exec_sql(text) FROM anon, authenticated;

-- 7. Fix the latent void-assignment in invoice_status_cogs_trigger:
--    v_amt := consume_fifo(...) assigned a VOID function's result to numeric,
--    which would raise at runtime if the draft->posted unconsumed path
--    were ever reached. Consume, then read the amount back.
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
      v_qty := v_item.quantity;
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
      PERFORM consume_fifo(v_item.id, v_item.product_id, COALESCE(v_item.warehouse_id, v_wh), v_qty, COALESCE(v_item.cost_price, 0));
      SELECT COALESCE(SUM(cogs_amount), 0) INTO v_amt FROM invoice_item_batch_consumption WHERE invoice_item_id = v_item.id;
      IF v_amt > 0 THEN
        UPDATE invoice_items SET cost_price = v_amt / v_qty WHERE id = v_item.id;
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
END;
$function$;



COMMIT;
