-- Batch unit-cost correction (2026-09-14): self-service repair for mis-scaled
-- batch costs, e.g. a 100x coil-price entered per meter (OPN-000490 held
-- ৳21,066/m against a ৳216.6/m product — which made consume_fifo overwrite
-- invoice_items.cost_price with a sale-unit-scale cost and abort every
-- Meter-denominated sale via check_invoice_item_cost_scale).
--
-- Three pieces, mirroring the inventory-audit repair conventions:
--   1) batch_cost_correction_audit — every correction is logged with the
--      reason, old/new cost and the value-delta journal entry
--   2) get_batch_cost_outliers() — detection: batches with remaining stock
--      whose unit cost is >p_threshold x (or <1/p_threshold x) the product's
--      base-unit cost; feeds the /inventory/audit check card
--   3) correct_batch_cost() — the audited repair: updates unit_cost (the
--      existing check_batch_unit_cost_is_base_unit trigger still guards the
--      scale on UPDATE) and posts a value-delta JE Dr/Cr 1200 vs 3900 so the
--      inventory GL and the batch ledger move together (same convention as
--      purge_negative_inventory_layers).

-- ---------------------------------------------------------------------------
-- 1) Audit table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS batch_cost_correction_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id uuid NOT NULL,
  batch_number text,
  product_id uuid NOT NULL,
  product_name text,
  product_sku text,
  old_unit_cost numeric NOT NULL,
  new_unit_cost numeric NOT NULL,
  quantity_remaining numeric NOT NULL,
  value_delta numeric NOT NULL,
  je_entry_number text,
  reason text NOT NULL,
  corrected_by text NOT NULL DEFAULT 'inventory-audit',
  corrected_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE batch_cost_correction_audit ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE tablename = 'batch_cost_correction_audit'
                   AND policyname = 'read_batch_cost_correction_audit') THEN
    CREATE POLICY read_batch_cost_correction_audit ON batch_cost_correction_audit
      FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

GRANT SELECT ON batch_cost_correction_audit TO authenticated;

-- ---------------------------------------------------------------------------
-- 2) Detection: batches whose unit cost is wildly off the product's base cost
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_batch_cost_outliers(p_threshold numeric DEFAULT 20)
RETURNS TABLE (
  batch_id uuid,
  batch_number text,
  batch_type text,
  product_id uuid,
  product_name text,
  product_sku text,
  base_unit text,
  warehouse text,
  quantity_remaining numeric,
  unit_cost numeric,
  product_cost numeric,
  ratio numeric,
  current_value numeric,
  expected_value numeric,
  created_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT b.id,
         b.batch_number,
         b.batch_type,
         p.id,
         p.name,
         p.sku,
         COALESCE(p.base_unit, p.unit),
         w.name,
         b.quantity_remaining,
         b.unit_cost,
         p.cost_price,
         round(b.unit_cost / p.cost_price, 2),
         b.quantity_remaining * b.unit_cost,
         b.quantity_remaining * p.cost_price,
         b.created_at
  FROM inventory_batches b
  JOIN products p ON p.id = b.product_id
  LEFT JOIN warehouses w ON w.id = b.warehouse_id
  WHERE b.quantity_remaining > 0
    AND COALESCE(p.cost_price, 0) > 0
    AND (b.unit_cost > p.cost_price * p_threshold
         OR b.unit_cost < p.cost_price / p_threshold)
  ORDER BY b.unit_cost / p.cost_price DESC;
$$;

GRANT EXECUTE ON FUNCTION get_batch_cost_outliers(numeric) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3) Repair: correct one batch's unit cost, audited + GL-consistent
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION correct_batch_cost(
  p_batch_id uuid,
  p_new_unit_cost numeric,
  p_reason text,
  p_username text DEFAULT 'inventory-audit'
)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_batch inventory_batches%ROWTYPE;
  v_product record;
  v_delta numeric;
  v_ratio numeric;
  v_je_id uuid;
  v_je_number text;
  v_acct_inventory uuid;
  v_acct_equity uuid;
  v_lines json;
BEGIN
  IF p_new_unit_cost IS NULL OR p_new_unit_cost <= 0 THEN
    RETURN json_build_object('success', false, 'error', 'New unit cost must be greater than zero');
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 THEN
    RETURN json_build_object('success', false, 'error', 'A reason is required (audit log)');
  END IF;

  SELECT * INTO v_batch FROM inventory_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Batch not found');
  END IF;

  SELECT p.name, p.sku, COALESCE(p.base_unit, p.unit) AS base_unit, p.cost_price
    INTO v_product
    FROM products p WHERE p.id = v_batch.product_id;
  IF v_product IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Product not found');
  END IF;

  v_delta := v_batch.quantity_remaining * (p_new_unit_cost - v_batch.unit_cost);
  v_ratio := CASE WHEN COALESCE(v_product.cost_price, 0) > 0
                  THEN p_new_unit_cost / v_product.cost_price END;

  -- The check_batch_unit_cost_is_base_unit trigger raises on sale-unit-scale
  -- costs; its message propagates to the caller as a clear error.
  UPDATE inventory_batches SET unit_cost = p_new_unit_cost WHERE id = p_batch_id;

  -- Value-delta JE so inventory GL and the batch ledger move together.
  -- (GL 1200 and the ledger total already drift; corrections must not add
  -- silent drift on top. Mirrors the purge-repair 1200/3900 convention.)
  IF abs(v_delta) >= 1 THEN
    SELECT id INTO v_acct_inventory FROM accounts WHERE code = '1200' LIMIT 1;
    SELECT id INTO v_acct_equity  FROM accounts WHERE code = '3900' LIMIT 1;
    IF v_acct_inventory IS NULL OR v_acct_equity IS NULL THEN
      RAISE EXCEPTION 'Accounts 1200 / 3900 not found — cannot post the value-delta entry';
    END IF;
    IF v_delta > 0 THEN
      v_lines := json_build_array(
        json_build_object('account_id', v_acct_inventory, 'debit', v_delta, 'credit', 0),
        json_build_object('account_id', v_acct_equity, 'debit', 0, 'credit', v_delta)
      );
    ELSE
      v_lines := json_build_array(
        json_build_object('account_id', v_acct_equity, 'debit', -v_delta, 'credit', 0),
        json_build_object('account_id', v_acct_inventory, 'debit', 0, 'credit', -v_delta)
      );
    END IF;
    v_je_id := post_journal_entry(
      format('Batch cost correction — %s (%s): %s → %s per %s (%s)',
             COALESCE(v_batch.batch_number, v_batch.id::text), v_product.name,
             v_batch.unit_cost, p_new_unit_cost, v_product.base_unit, btrim(p_reason)),
      CURRENT_DATE, 'batch_cost_correction', v_batch.id, v_lines, NULL, NULL
    );
    SELECT entry_number INTO v_je_number FROM journal_entries WHERE id = v_je_id;
  END IF;

  INSERT INTO batch_cost_correction_audit (
    batch_id, batch_number, product_id, product_name, product_sku,
    old_unit_cost, new_unit_cost, quantity_remaining, value_delta,
    je_entry_number, reason, corrected_by
  ) VALUES (
    v_batch.id, v_batch.batch_number, v_batch.product_id, v_product.name, v_product.sku,
    v_batch.unit_cost, p_new_unit_cost, v_batch.quantity_remaining, v_delta,
    v_je_number, btrim(p_reason), p_username
  );

  RETURN json_build_object(
    'success', true,
    'batch_number', v_batch.batch_number,
    'product_name', v_product.name,
    'old_unit_cost', v_batch.unit_cost,
    'new_unit_cost', p_new_unit_cost,
    'quantity_remaining', v_batch.quantity_remaining,
    'value_delta', v_delta,
    'je_number', v_je_number,
    'new_ratio', v_ratio,
    'outlier_warning', v_ratio IS NOT NULL AND (v_ratio > 20 OR v_ratio < 1.0 / 20)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION correct_batch_cost(uuid, numeric, text, text) TO authenticated;
