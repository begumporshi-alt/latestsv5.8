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
--     2. Posts a journal entry (Dr 1200 Inventory / Cr 3900 Opening Balance Equity)
--        mirroring the one-time backfill in 20260827003000
--
--   This mirrors the GRN pattern in grn_accounting_trigger() (Dr 1200 / Cr 2000)
--   but with a different credit side since opening stock isn't from a supplier.
--
-- ACCOUNT 3900
--   Opening Balance Equity (3900) was created in 20260724082749 as an equity
--   account. It already exists in the chart of accounts and is used by
--   20260827003000. The function is idempotent in spirit: if 3900 or 1200
--   are missing, it falls through silently (returns the batch id) rather
--   than raising, so missing accounts don't block inventory creation.
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
-- SAFETY
--   * SECURITY DEFINER so the journal insert can run with table privileges even
--     if the calling user has limited access.
--   * Only posts journal if amount > 0 (no empty entries).
--   * Returns the batch id for caller convenience.
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
  v_batch_number text;
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

  -- 3. Post journal entry (Dr 1200 / Cr 3900) if amount > 0
  IF v_amount > 0 THEN
    SELECT id INTO v_account_1200 FROM accounts
      WHERE code = '1200' AND tenant_id = p_tenant_id;
    SELECT id INTO v_account_3900 FROM accounts
      WHERE code = '3900' AND tenant_id = p_tenant_id;

    IF v_account_1200 IS NOT NULL AND v_account_3900 IS NOT NULL THEN
      PERFORM post_journal_entry(
        p_description := COALESCE(p_notes, 'Opening stock entry'),
        p_lines := jsonb_build_array(
          jsonb_build_object(
            'account_code', '1200',
            'debit', v_amount,
            'description', 'Inventory received - ' || COALESCE(p_notes, 'Opening stock')
          ),
          jsonb_build_object(
            'account_code', '3900',
            'credit', v_amount,
            'description', 'Opening balance equity offset'
          )
        ),
        p_entry_date := CURRENT_DATE,
        p_reference_type := p_reference_type,
        p_reference_id := p_reference_id,
        p_tenant_id := p_tenant_id
      );
    ELSE
      -- Log but don't block: missing accounts shouldn't prevent inventory creation
      RAISE WARNING 'Accounts 1200 or 3900 missing for tenant %; batch % created without GL entry',
        p_tenant_id, v_batch_id;
    END IF;
  END IF;

  RETURN v_batch_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute to authenticated users (frontend pattern)
GRANT EXECUTE ON FUNCTION create_opening_batch(
  uuid, uuid, numeric, numeric, text, text, uuid, text, uuid
) TO authenticated;

COMMENT ON FUNCTION create_opening_batch IS
  'Creates an inventory_batches row and posts a Dr 1200 / Cr 3900 journal entry. Used by product creation, stock adjustment, and import flows.';

-- ============================================================================
-- 2. UNIQUENESS CONSTRAINT
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
