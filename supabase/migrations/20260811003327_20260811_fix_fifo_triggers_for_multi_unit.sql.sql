-- Fix FIFO COGS triggers to use base_quantity for batch consumption
-- Batches store base-unit quantities (e.g. meters), but triggers were passing
-- sale-unit quantity (e.g. 1 coil), causing under-consumption and wrong COGS.

-- 1. Fix per-item COGS trigger
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
  v_consume_qty numeric;
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

  IF v_invoice_record.status = 'draft' THEN
    RETURN NEW;
  END IF;

  v_qty := NEW.quantity;
  IF v_qty <= 0 THEN
    RETURN NEW;
  END IF;

  PERFORM 1 FROM invoice_item_batch_consumption WHERE invoice_item_id = NEW.id;
  IF FOUND THEN
    RETURN NEW;
  END IF;

  SELECT name, sku INTO v_product FROM products WHERE id = NEW.product_id;
  v_product_name := COALESCE(v_product.name, 'Unknown');

  v_default_wh := v_invoice_record.warehouse_id;
  IF v_default_wh IS NULL THEN
    SELECT id INTO v_default_wh FROM warehouses WHERE is_default = true AND is_active = true LIMIT 1;
  END IF;
  IF v_default_wh IS NULL THEN
    SELECT id INTO v_default_wh FROM warehouses WHERE is_active = true LIMIT 1;
  END IF;

  -- Consume using base_quantity (batches are in base units)
  v_consume_qty := COALESCE(NEW.base_quantity, NEW.quantity);
  v_cogs_amount := consume_fifo(NEW.product_id, v_default_wh, v_consume_qty, NEW.id);

  IF v_cogs_amount <= 0 THEN
    RETURN NEW;
  END IF;

  -- Store per-sale-unit cost in invoice_items.cost_price
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

-- 2. Fix status-change COGS trigger
CREATE OR REPLACE FUNCTION invoice_status_cogs_trigger()
RETURNS TRIGGER AS $$
DECLARE
  v_cogs_account uuid;
  v_inventory_account uuid;
  v_cogs_amount decimal(15,2);
  v_item RECORD;
  v_default_wh uuid;
  v_qty numeric;
  v_consume_qty numeric;
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

      PERFORM 1 FROM invoice_item_batch_consumption WHERE invoice_item_id = v_item.id;
      IF FOUND THEN
        CONTINUE;
      END IF;

      SELECT name, sku INTO v_product FROM products WHERE id = v_item.product_id;
      v_product_name := COALESCE(v_product.name, 'Unknown');

      v_consume_qty := COALESCE(v_item.base_quantity, v_item.quantity);
      v_cogs_amount := consume_fifo(v_item.product_id, v_default_wh, v_consume_qty, v_item.id);

      IF v_cogs_amount > 0 THEN
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

-- 3. Fix invoice-level COGS trigger
CREATE OR REPLACE FUNCTION invoice_cogs_trigger()
RETURNS TRIGGER AS $$
DECLARE
  v_tenant_id uuid;
  v_cogs_total decimal(15,2) := 0;
  v_item record;
  v_default_wh uuid;
  v_qty numeric;
  v_consume_qty numeric;
  v_cogs_amount decimal(15,2);
BEGIN
  v_tenant_id := COALESCE(NEW.tenant_id, '00000000-0000-0000-0000-000000000001');

  IF NOT (
    (TG_OP = 'INSERT' AND NEW.status IN ('paid', 'sent', 'partial')) OR
    (TG_OP = 'UPDATE' AND NEW.status IN ('sent', 'paid', 'partial') AND OLD.status = 'draft')
  ) THEN
    RETURN NEW;
  END IF;

  v_default_wh := NEW.warehouse_id;
  IF v_default_wh IS NULL THEN
    SELECT id INTO v_default_wh FROM warehouses WHERE is_default = true AND is_active = true LIMIT 1;
  END IF;
  IF v_default_wh IS NULL THEN
    SELECT id INTO v_default_wh FROM warehouses WHERE is_active = true LIMIT 1;
  END IF;

  FOR v_item IN
    SELECT ii.id, ii.product_id, ii.quantity, ii.base_quantity
    FROM invoice_items ii
    WHERE ii.invoice_id = NEW.id
  LOOP
    v_qty := v_item.quantity;
    IF v_qty <= 0 THEN
      CONTINUE;
    END IF;

    PERFORM 1 FROM invoice_item_batch_consumption WHERE invoice_item_id = v_item.id;
    IF FOUND THEN
      SELECT COALESCE(SUM(cogs_amount), 0) INTO v_cogs_amount
      FROM invoice_item_batch_consumption WHERE invoice_item_id = v_item.id;
      v_cogs_total := v_cogs_total + v_cogs_amount;
      CONTINUE;
    END IF;

    v_consume_qty := COALESCE(v_item.base_quantity, v_item.quantity);
    v_cogs_amount := consume_fifo(v_item.product_id, v_default_wh, v_consume_qty, v_item.id);
    v_cogs_total := v_cogs_total + v_cogs_amount;

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