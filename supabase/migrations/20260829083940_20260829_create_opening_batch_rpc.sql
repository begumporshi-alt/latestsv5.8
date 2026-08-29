-- ============================================================================
-- Create the missing create_opening_batch RPC function.
--
-- CONTEXT
--   The frontend (app/(erp)/inventory/page.tsx) calls supabase.rpc('create_opening_batch')
--   in 4 places (product creation, stock adjustment, import update, import initial)
--   but this function was never defined. As a result, opening stock entries create
--   inventory_batches rows via the stock_movements flow but the GL control account
--   (1200) is never debited, causing a subsidiary-vs-GL drift.
--
-- THE FIX
--   Create create_opening_batch() as a SECURITY DEFINER RPC that:
--     1. Inserts the batch row into inventory_batches (what the frontend expects)
--     2. Posts a journal entry based on batch_type:
--        - 'opening'  -> Dr 1200 / Cr 3900 (Opening Balance Equity - go-live only)
--        - 'adjustment' -> Dr 1200 / Cr 5900 (Inventory Adjustment - variance)
--
--   Plus create_stock_reduction() for when stock is REDUCED:
--        Dr 5900 / Cr 1200 (Inventory Adjustment / Inventory Asset)
--
--   This mirrors the GRN pattern in grn_accounting_trigger() (Dr 1200 / Cr 2000)
--   but with the appropriate equity/variance credit side.
--
-- ACCOUNT 3900
--   Opening Balance Equity (3900) was created in 20260724082749 as an equity
--   account. It is ONLY used for the one-time go-live opening balance entry
--   (see 20260827003000). Routine stock adjustments use 5900 instead.
--
-- ACCOUNT 5900
--   Inventory Adjustment (5900) is an expense account that captures variance
--   from stock adjustments after go-live. Increases are booked as a credit
--   (reduces COGS / acts as a gain), decreases as a debit (increases expense).
--
-- PARAMETER MAPPING (matches frontend calls in inventory/page.tsx)
--   p_product_id       : uuid
--   p_warehouse_id     : uuid
--   p_quantity         : numeric
--   p_unit_cost        : numeric
--   p_batch_type       : 'opening' | 'adjustment'
--   p_reference_type   : 'product_creation' | 'stock_adjustment' | 'import_update' | 'import'
--   p_reference_id     : uuid
--   p_notes            : text
--
-- POST_JOURNAL_ENTRY SIGNATURE (verified from DB)
--   post_journal_entry(p_description text, p_entry_date date, p_reference_type text,
--                       p_reference_id uuid, p_lines json, p_customer_id uuid, p_supplier_id uuid)
--   NOTE: Uses account_id (uuid) in JSON, not account_code. Uses json type, not jsonb.
--
-- SAFETY
--   * SECURITY DEFINER so the journal insert can run with table privileges even
--     if the calling user has limited access.
--   * Only posts journal if amount > 0 (no empty entries).
--   * Returns the batch id for caller convenience.
--   * Missing accounts fall through with a warning, not an error.
-- ============================================================================
-- 1. CREATE_OPENING_BATCH FUNCTION
-- ============================================================================
CREATE OR REPLACE FUNCTION create_opening_batch(
  p_product_id uuid,
  p_warehouse_id uuid,
  p_quantity numeric,
  p_unit_cost numeric,
  p_batch_type text DEFAULT 'opening',
  p_reference_type text DEFAULT 'product_creation',
  p_reference_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_tenant_id uuid DEFAULT '00000000-0000-0000-0000-000000000001'
) RETURNS uuid AS $$
DECLARE
  v_batch_id uuid;
  v_amount numeric := ROUND(p_quantity * p_unit_cost, 2);
  v_account_1200 uuid;
  v_account_3900 uuid;
  v_account_5900 uuid;
  v_batch_number text;
  v_credit_account_id uuid;
  v_credit_account_code text;
  v_credit_desc text;
BEGIN
  -- 1. Generate a batch number for traceability
  v_batch_number := UPPER(COALESCE(p_batch_type, 'OPENING')) || '-' ||
                    to_char(CURRENT_DATE, 'YYYYMMDD') || '-' ||
                    substring(p_product_id::text, 1, 8);

  -- 2. Insert the inventory batch (what frontend expects)
  INSERT INTO inventory_batches (
    tenant_id, product_id, warehouse_id, batch_number,
    quantity_received, quantity_remaining, unit_cost,
    batch_type, reference_type, reference_id, notes, created_at
  ) VALUES (
    p_tenant_id, p_product_id, p_warehouse_id, v_batch_number,
    p_quantity, p_quantity, p_unit_cost,
    p_batch_type, p_reference_type, p_reference_id, p_notes, CURRENT_DATE
  ) RETURNING id INTO v_batch_id;

  -- 3. Post journal entry based on batch_type
  IF v_amount > 0 THEN
    SELECT id INTO v_account_1200 FROM accounts
      WHERE code = '1200' AND tenant_id = p_tenant_id;

    IF v_account_1200 IS NULL THEN
      RAISE WARNING 'Account 1200 missing for tenant %; batch % created without GL entry',
        p_tenant_id, v_batch_id;
      RETURN v_batch_id;
    END IF;

    -- Route credit account based on batch_type
    IF p_batch_type = 'opening' THEN
      -- Go-live opening balance: credit Opening Balance Equity (3900)
      SELECT id INTO v_account_3900 FROM accounts
        WHERE code = '3900' AND tenant_id = p_tenant_id;
      IF v_account_3900 IS NOT NULL THEN
        v_credit_account_id := v_account_3900;
        v_credit_account_code := '3900';
        v_credit_desc := 'Opening balance equity offset';
      ELSE
        RAISE WARNING 'Account 3900 missing for tenant %; batch % created without GL entry',
          p_tenant_id, v_batch_id;
        RETURN v_batch_id;
      END IF;
    ELSE
      -- Stock adjustment (post-go-live): credit Inventory Adjustment (5900)
      SELECT id INTO v_account_5900 FROM accounts
        WHERE code = '5900' AND tenant_id = p_tenant_id;
      IF v_account_5900 IS NOT NULL THEN
        v_credit_account_id := v_account_5900;
        v_credit_account_code := '5900';
        v_credit_desc := 'Inventory adjustment variance';
      ELSE
        RAISE WARNING 'Account 5900 missing for tenant %; batch % created without GL entry',
          p_tenant_id, v_batch_id;
        RETURN v_batch_id;
      END IF;
    END IF;

    -- Post Dr 1200 / Cr (3900 or 5900)
    v_credit_desc := 'Opening balance equity offset';

    IF p_batch_type = 'opening' THEN
      v_credit_desc := 'Opening balance equity offset';
    ELSE
      v_credit_desc := 'Inventory adjustment variance';
    END IF;

    PERFORM post_journal_entry(
      p_description := COALESCE(p_notes, 'Opening stock entry'),
      p_entry_date := CURRENT_DATE,
      p_reference_type := p_reference_type,
      p_reference_id := p_reference_id,
      p_lines := json_build_array(
        json_build_object(
          'account_id', v_account_1200,
          'debit', v_amount,
          'description', 'Opening stock: ' || COALESCE(p_notes, 'Inventory received')
        ),
        json_build_object(
          'account_id', v_credit_account_id,
          'credit', v_amount,
          'description', v_credit_desc
        )
      )
    );
  END IF;

  RETURN v_batch_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute to authenticated users (frontend pattern)
GRANT EXECUTE ON FUNCTION create_opening_batch(
  uuid, uuid, numeric, numeric, text, text, uuid, text, uuid
) TO authenticated;

COMMENT ON FUNCTION create_opening_batch IS
  'Creates an inventory_batches row and posts a journal entry. Opening batches post Dr 1200 / Cr 3900; adjustment batches post Dr 1200 / Cr 5900 (Inventory Adjustment).';

-- ============================================================================
-- 2. CREATE_STOCK_REDUCTION FUNCTION
--   For stock decreases (physical loss, damage, write-offs).
--   Reduces inventory_batches and posts Dr 5900 / Cr 1200.
--
--   CONSUMES from oldest batches first (FIFO reversal pattern), then reduces
--   the batch layer that provided those units.
-- ============================================================================
CREATE OR REPLACE FUNCTION create_stock_reduction(
  p_product_id uuid,
  p_warehouse_id uuid,
  p_quantity numeric,
  p_unit_cost numeric,
  p_reference_type text DEFAULT 'stock_adjustment',
  p_reference_id uuid DEFAULT NULL,
  p_notes text DEFAULT 'Stock decrease adjustment',
  p_tenant_id uuid DEFAULT '00000000-0000-0000-0000-000000000001'
) RETURNS TABLE (batch_id uuid, qty_reduced numeric, journal_id uuid) AS $$
DECLARE
  v_qty_to_reduce numeric;
  v_amount numeric;
  v_account_1200 uuid;
  v_account_5900 uuid;
  v_journal_id uuid;
  v_batch_id uuid;
BEGIN
  IF p_quantity <= 0 THEN
    RETURN QUERY SELECT NULL::uuid, 0::numeric, NULL::uuid;
    RETURN;
  END IF;

  v_qty_to_reduce := p_quantity;
  v_amount := ROUND(p_quantity * p_unit_cost, 2);

  -- 1. Reduce quantity_remaining from inventory_batches (oldest first)
  FOR v_batch_id IN
    SELECT ib.id
    FROM inventory_batches ib
    WHERE ib.product_id = p_product_id
      AND ib.warehouse_id = p_warehouse_id
      AND ib.quantity_remaining > 0
    ORDER BY ib.created_at ASC, ib.id ASC
    FOR UPDATE
  LOOP
    -- Reduce this batch
    UPDATE inventory_batches
    SET quantity_remaining = quantity_remaining - p_quantity,
        unit_cost = (quantity_remaining * unit_cost - p_quantity * p_unit_cost) / GREATEST(quantity_remaining - p_quantity, 1)
    WHERE id = v_batch_id AND quantity_remaining >= p_quantity;

    v_qty_reduced := LEAST(p_quantity, 
      (SELECT quantity_remaining FROM inventory_batches WHERE id = v_batch_id));

    p_quantity := p_quantity - v_qty_reduced;

    EXIT WHEN p_quantity <= 0;
  END LOOP;

  -- 2. Insert a reduction batch (for audit trail - negative quantity consumed)
  INSERT INTO inventory_batches (
    tenant_id, product_id, warehouse_id, batch_number,
    quantity_received, quantity_remaining, unit_cost,
    batch_type, reference_type, reference_id, notes, created_at
  ) VALUES (
    p_tenant_id, p_product_id, p_warehouse_id,
    'REDUCE-' || to_char(CURRENT_DATE, 'YYYYMMDD') || '-' || substring(p_product_id::text, 1, 8),
    0, -p_quantity::numeric, p_unit_cost,
    'adjustment', p_reference_type, p_reference_id, p_notes, CURRENT_DATE
  ) RETURNING id INTO v_batch_id;

  -- 3. Post journal entry: Dr 5900 / Cr 1200
  IF v_amount > 0 THEN
    SELECT id INTO v_account_1200 FROM accounts
      WHERE code = '1200' AND tenant_id = p_tenant_id;
    SELECT id INTO v_account_5900 FROM accounts
      WHERE code = '5900' AND tenant_id = p_tenant_id;

    IF v_account_1200 IS NOT NULL AND v_account_5900 IS NOT NULL THEN
      v_journal_id := post_journal_entry(
        p_description := p_notes,
        p_entry_date := CURRENT_DATE,
        p_reference_type := p_reference_type,
        p_reference_id := p_reference_id,
        p_lines := json_build_array(
          json_build_object(
            'account_id', v_account_5900,
            'debit', v_amount,
            'description', 'Inventory reduction: ' || COALESCE(p_notes, 'Stock decrease')
          ),
          json_build_object(
            'account_id', v_account_1200,
            'credit', v_amount,
            'description', 'Inventory reduced (FIFO layers depleted)'
          )
        )
      );
    ELSE
      RAISE WARNING 'Accounts 1200 or 5900 missing for tenant %; batch % created without GL entry',
        p_tenant_id, v_batch_id;
    END IF;
  END IF;

  -- Return the reduction batch id, qty reduced, and journal entry id
  RETURN QUERY SELECT v_batch_id, GREATEST(0, p_quantity - v_qty_to_reduce)::numeric, v_journal_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION create_stock_reduction(
  uuid, uuid, numeric, numeric, text, uuid, text, uuid
) TO authenticated;

COMMENT ON FUNCTION create_stock_reduction IS
  'Reduces inventory from oldest batches (FIFO) and posts Dr 5900 / Cr 1200 journal entry for stock decreases.';

-- ============================================================================
-- 3. UNIQUENESS CONSTRAINT
--   Each product-warehouse pair should have at most one 'opening' batch.
--   Adjustment batches are allowed multiple entries (periodic corrections).
--   The partial unique index below enforces this without blocking adjustment batches.
-- ============================================================================
CREATE UNIQUE INDEX IF NOT EXISTS inv_batches_one_opening_per_product_warehouse
  ON inventory_batches (product_id, warehouse_id)
  WHERE batch_type = 'opening';

-- Backfill: delete duplicate opening batches if any exist (keep the oldest)
-- This handles the case where product creation was called twice before this fix.
DO $$
BEGIN
  DELETE FROM inventory_batches ib1
  USING inventory_batches ib2
  WHERE ib1.product_id = ib2.product_id
    AND ib1.warehouse_id = ib2.warehouse_id
    AND ib1.batch_type = 'opening'
    AND ib2.batch_type = 'opening'
    AND ib1.id > ib2.id;
END;
$$;