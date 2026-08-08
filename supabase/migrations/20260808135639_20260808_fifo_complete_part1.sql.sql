-- Part 1: Fix consume_fifo, batch_id nullability, GRN trigger, restore_fifo, and sales return function

-- 1. Fix: Make batch_id nullable in invoice_item_batch_consumption
ALTER TABLE invoice_item_batch_consumption ALTER COLUMN batch_id DROP NOT NULL;

-- 2. Fix: consume_fifo - create a fallback batch instead of NULL batch_id
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
  v_fallback_cost decimal(15,2);
  v_fallback_batch_id uuid;
BEGIN
  IF p_quantity <= 0 THEN
    RETURN 0;
  END IF;

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

    UPDATE inventory_batches
    SET quantity_remaining = quantity_remaining - v_consume_qty
    WHERE id = v_batch.id;

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

  IF v_remaining_to_consume > 0 THEN
    SELECT COALESCE(cost_price, 0) INTO v_fallback_cost
    FROM products WHERE id = p_product_id;

    v_fallback_batch_id := gen_random_uuid();

    INSERT INTO inventory_batches (
      id, product_id, warehouse_id, batch_number,
      quantity_received, quantity_remaining, unit_cost,
      batch_type, reference_type, notes
    ) VALUES (
      v_fallback_batch_id, p_product_id, p_warehouse_id, 'ADJ-' || p_invoice_item_id::text,
      0, -v_remaining_to_consume, v_fallback_cost,
      'adjustment', 'invoice_item', 'Negative adjustment - sold without sufficient stock (FIFO fallback)'
    );

    INSERT INTO invoice_item_batch_consumption (
      invoice_item_id, batch_id, product_id, warehouse_id,
      quantity_consumed, unit_cost, cogs_amount
    ) VALUES (
      p_invoice_item_id, v_fallback_batch_id, p_product_id, p_warehouse_id,
      v_remaining_to_consume, v_fallback_cost, v_remaining_to_consume * v_fallback_cost
    );

    v_cogs_total := v_cogs_total + (v_remaining_to_consume * v_fallback_cost);
  END IF;

  RETURN v_cogs_total;
END;
$$;

-- 3. Create the GRN trigger on goods_receipt_notes
DROP TRIGGER IF EXISTS trg_grn_accounting ON goods_receipt_notes;
CREATE TRIGGER trg_grn_accounting
  AFTER INSERT OR UPDATE ON goods_receipt_notes
  FOR EACH ROW EXECUTE FUNCTION grn_accounting_trigger();

-- 4. Update restore_fifo to handle adjustment batches
CREATE OR REPLACE FUNCTION restore_fifo(p_invoice_item_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_consumption RECORD;
  v_batch_type text;
BEGIN
  FOR v_consumption IN
    SELECT id, batch_id, quantity_consumed
    FROM invoice_item_batch_consumption
    WHERE invoice_item_id = p_invoice_item_id
    FOR UPDATE
  LOOP
    IF v_consumption.batch_id IS NOT NULL THEN
      SELECT batch_type INTO v_batch_type
      FROM inventory_batches WHERE id = v_consumption.batch_id;

      IF v_batch_type = 'adjustment' THEN
        DELETE FROM inventory_batches WHERE id = v_consumption.batch_id;
      ELSE
        UPDATE inventory_batches
        SET quantity_remaining = quantity_remaining + v_consumption.quantity_consumed
        WHERE id = v_consumption.batch_id;
      END IF;
    END IF;

    DELETE FROM invoice_item_batch_consumption WHERE id = v_consumption.id;
  END LOOP;
END;
$$;

-- 5. Create function to restore FIFO batches on sales returns
CREATE OR REPLACE FUNCTION restore_fifo_on_return(
  p_invoice_item_id uuid,
  p_product_id uuid,
  p_warehouse_id uuid,
  p_quantity numeric,
  p_unit_cost numeric,
  p_reference_id uuid,
  p_reference_number text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_consumption RECORD;
  v_remaining numeric := p_quantity;
  v_restore_qty numeric;
BEGIN
  IF p_quantity <= 0 THEN
    RETURN;
  END IF;

  -- Try to restore to the original consumed batches first
  FOR v_consumption IN
    SELECT batch_id, quantity_consumed
    FROM invoice_item_batch_consumption
    WHERE invoice_item_id = p_invoice_item_id
    ORDER BY created_at ASC
  LOOP
    EXIT WHEN v_remaining <= 0;

    IF v_consumption.batch_id IS NOT NULL THEN
      v_restore_qty := LEAST(v_consumption.quantity_consumed, v_remaining);
      UPDATE inventory_batches
      SET quantity_remaining = quantity_remaining + v_restore_qty
      WHERE id = v_consumption.batch_id
        AND batch_type != 'adjustment';
      v_remaining := v_remaining - v_restore_qty;
    END IF;
  END LOOP;

  -- If there's still remaining quantity, create a return batch
  IF v_remaining > 0 THEN
    INSERT INTO inventory_batches (
      product_id, warehouse_id, batch_number,
      quantity_received, quantity_remaining, unit_cost,
      batch_type, reference_type, reference_id, reference_number,
      notes
    ) VALUES (
      p_product_id, p_warehouse_id, 'RET-' || p_reference_number,
      v_remaining, v_remaining, p_unit_cost,
      'return', 'sales_return', p_reference_id, p_reference_number,
      'Stock returned from sales return ' || p_reference_number
    );
  END IF;
END;
$$;
