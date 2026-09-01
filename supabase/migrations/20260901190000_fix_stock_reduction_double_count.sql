-- 2026-09-01: Fix create_stock_reduction double-count + repair today's REDUCE rows.
--
-- The reduction RPC consumed real FIFO layers AND unconditionally inserted a
-- negative audit row for the FULL quantity, while the journal entry credited
-- 1200 once. Whenever the reduction was covered by real stock (not an
-- over-reduction on empty layers), the batch ledger lost the amount TWICE and
-- GL-vs-batches drifted by the reduction value. The 11 historical REDUCE rows
-- were over-reductions on already-empty layers, where the audit row was the
-- only record — hence the tie held until today's fully-covered reduction
-- (walton cable 1*1.0 re Green, 8,975 @ 25.04 = 224,734 + 1 @ 25.04).

BEGIN;

CREATE OR REPLACE FUNCTION public.create_stock_reduction(p_product_id uuid, p_warehouse_id uuid, p_quantity numeric, p_unit_cost numeric, p_reference_type text DEFAULT 'stock_adjustment'::text, p_reference_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT 'Stock decrease adjustment'::text, p_tenant_id uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_remaining_qty numeric := p_quantity;
  v_reduce_qty numeric;
  v_batch_id uuid;
  v_audit_batch_id uuid;
  v_amount numeric := ROUND(p_quantity * p_unit_cost, 2);
  v_account_1200 uuid;
  v_account_5900 uuid;
  v_product_name text;
  v_product_sku text;
  v_warehouse_name text;
  v_header text;
BEGIN
  IF p_quantity <= 0 THEN
    RETURN NULL;
  END IF;

  -- Lookup product + warehouse for human-readable journal descriptions
  SELECT name, sku INTO v_product_name, v_product_sku
    FROM products WHERE id = p_product_id;
  SELECT name INTO v_warehouse_name FROM warehouses WHERE id = p_warehouse_id;

  v_product_name := COALESCE(v_product_name, 'Unknown Product');
  v_product_sku := COALESCE(v_product_sku, 'N/A');
  v_warehouse_name := COALESCE(v_warehouse_name, 'Unknown Warehouse');

  -- 1. Reduce quantity_remaining from oldest batches first (FIFO)
  FOR v_batch_id IN
    SELECT ib.id
    FROM inventory_batches ib
    WHERE ib.product_id = p_product_id
      AND ib.warehouse_id = p_warehouse_id
      AND ib.quantity_remaining > 0
    ORDER BY ib.created_at ASC, ib.id ASC
    FOR UPDATE
  LOOP
    EXIT WHEN v_remaining_qty <= 0;

    -- Only consume what this batch actually holds (and never more than remaining)
    SELECT LEAST(quantity_remaining, v_remaining_qty)
      INTO v_reduce_qty
      FROM inventory_batches WHERE id = v_batch_id;

    UPDATE inventory_batches
    SET quantity_remaining = quantity_remaining - v_reduce_qty
    WHERE id = v_batch_id;

    v_remaining_qty := v_remaining_qty - v_reduce_qty;
  END LOOP;

  -- 2. Insert a reduction batch ONLY for the shortfall the real layers could
  --    not cover (an over-reduction IOU). A fully-covered reduction is already
  --    recorded by the layer consumption + stock movement + journal entry —
  --    adding a full-qty audit row here double-subtracted the batch ledger
  --    against the GL whenever real stock was consumed (bug fixed 2026-09-01).
  IF v_remaining_qty > 0 THEN
    INSERT INTO inventory_batches (
      tenant_id, product_id, warehouse_id, batch_number,
      quantity_received, quantity_remaining, unit_cost,
      batch_type, reference_type, reference_id, notes, created_at
    ) VALUES (
      p_tenant_id, p_product_id, p_warehouse_id,
      'REDUCE-' || to_char(CURRENT_DATE, 'YYYYMMDD') || '-' || substring(p_product_id::text, 1, 8),
      0, -v_remaining_qty, p_unit_cost,
      'adjustment', p_reference_type, p_reference_id, p_notes, CURRENT_DATE
    ) RETURNING id INTO v_audit_batch_id;
  END IF;

  -- 3. Post journal entry: Dr 5900 / Cr 1200
  IF v_amount > 0 THEN
    SELECT id INTO v_account_1200 FROM accounts
      WHERE code = '1200' AND tenant_id = p_tenant_id;
    SELECT id INTO v_account_5900 FROM accounts
      WHERE code = '5900' AND tenant_id = p_tenant_id;

    IF v_account_1200 IS NOT NULL AND v_account_5900 IS NOT NULL THEN
      v_header := 'Stock reduction - ' || v_product_name || ' (' || v_product_sku || '): '
        || p_quantity || ' @ ' || p_unit_cost || ' in ' || v_warehouse_name;

      PERFORM post_journal_entry(
        p_description := v_header,
        p_entry_date := CURRENT_DATE,
        p_reference_type := p_reference_type,
        p_reference_id := p_reference_id,
        p_lines := json_build_array(
          json_build_object(
            'account_id', v_account_5900,
            'debit', v_amount,
            'description', 'Inventory reduction: ' || v_product_name || ' (' || v_product_sku || ') in ' || v_warehouse_name
          ),
          json_build_object(
            'account_id', v_account_1200,
            'credit', v_amount,
            'description', 'Inventory released (FIFO layers depleted): ' || v_product_name
          )
        )
      );
    ELSE
      RAISE WARNING 'Accounts 1200 or 5900 missing for tenant %; batch % created without GL entry',
        p_tenant_id, v_audit_batch_id;
    END IF;
  END IF;

  RETURN v_audit_batch_id;
END;
$function$;




-- Repair: delete the two erroneous full-qty audit rows from today (their
-- reductions were fully covered by real layers; JE + consumption + movement
-- already record them correctly). Audited.
CREATE TABLE IF NOT EXISTS stock_reduction_repair_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL,
  batch_number text NOT NULL,
  product_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  quantity_removed numeric(15,3) NOT NULL,
  unit_cost numeric(15,2) NOT NULL,
  journal_entry_number text,
  repaired_at timestamptz NOT NULL DEFAULT now(),
  repaired_by text NOT NULL DEFAULT 'migration_20260901190000'
);

WITH doomed AS (
  SELECT b.id, b.batch_number, b.product_id, b.warehouse_id, b.quantity_remaining, b.unit_cost
  FROM inventory_batches b
  WHERE b.batch_number = 'REDUCE-20260901-8587cbeb'
    AND b.quantity_remaining IN (-8975, -1)
    AND NOT EXISTS (SELECT 1 FROM stock_reduction_repair_audit a WHERE a.batch_id = b.id)
)
INSERT INTO stock_reduction_repair_audit (batch_id, batch_number, product_id, warehouse_id, quantity_removed, unit_cost, journal_entry_number)
SELECT d.id, d.batch_number, d.product_id, d.warehouse_id, d.quantity_remaining, d.unit_cost, 'JE-964760'
FROM doomed d WHERE d.quantity_remaining = -8975
UNION ALL
SELECT d.id, d.batch_number, d.product_id, d.warehouse_id, d.quantity_remaining, d.unit_cost, 'JE-964761'
FROM doomed d WHERE d.quantity_remaining = -1;

DELETE FROM inventory_batches b
USING stock_reduction_repair_audit a
WHERE a.batch_id = b.id AND a.repaired_by = 'migration_20260901190000';

COMMIT;
