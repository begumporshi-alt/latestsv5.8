-- ============================================================================
-- COMPLETE FIX: COGS Inflation (Bug 1) + Duplicate Journal Entries (Bug 2)
-- + Prevention: Guard trigger and unit-contract documentation
-- ============================================================================
-- BUG 1: 19 batches have unit_cost in SALE units instead of BASE units
-- - Opening/adjustment batches for multi-unit cable products wrote products.cost_price
--   (which was per-coil) into a per-meter column
-- - Impact: ~4.54M COGS overstatement
-- BUG 2: Duplicate / unreversed COGS journal entries
-- - 244 invoices have more COGS journal entries than line items + 1, and 6 have
--   both per-item and invoice-level entries. Cause: three overlapping COGS
--   triggers with incompatible idempotency guards. invoice_items_cogs_trigger
--   dedupes on a per-item description while the two invoice-level triggers dedupe
--   on description LIKE 'COGS%', so they do not see each other's work.
--
-- Strategy:
-- 1. Correct the 19 inflated batch unit_cost values (divide by conversion_factor,
--    fallback to products.cost_price for 2 batches lacking product_units row)
-- 2. Re-derive invoice_item_batch_consumption.unit_cost / cogs_amount from batch cost
-- 3. Recompute invoice_items.cost_price for FIFO-backed items
-- 4. Post ONE balanced correcting journal entry: Debit 1200 (Inventory) / Credit 5000 (COGS)
--    sized so account 5000 lands on the per-item TRUE cost of goods sold. This
--    absorbs both the batch inflation and the duplicate entries in a single entry.
-- 5. Re-derive balances for accounts 5000 and 1200; report other drift without changing it
-- 6. Add prevention: trigger rejecting sale-unit costs on inventory_batches insert/update
-- 7. Add column COMMENTs documenting the base-unit contract
--
-- OUT OF SCOPE / KNOWN REMAINING ISSUES:
--
-- (a) Account 1200 (Inventory) is currently -9,165,220.83, which is impossible for
-- an asset. This correction debits it by the overstatement (~4.56M), leaving it
-- still negative (~-3.2M). The residual is a SEPARATE defect: the FIFO opening
-- backfill created inventory_batches without any matching GL debit, so stock was
-- credited out on sale having never been capitalised. True inventory value is
-- ~16.8M. Closing that gap requires an opening-balance entry (Debit 1200 / Credit
-- 3900 Opening Balance Equity) of ~20M, which materially restates equity and is an
-- accounting decision for the business owner, not a mechanical fix.
--
-- (b) The COGS trigger topology is still the three overlapping triggers described
-- above, so duplicates CAN still accumulate on future sales. This migration repairs
-- the data and prevents Bug 1 recurring, but Bug 2's structural prevention needs
-- those triggers consolidated into a single authoritative FIFO-based path. That
-- touches the hot path of every sale and is handled separately.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- STEP 0: Identify affected batches and their correction factors
-- ----------------------------------------------------------------------------
CREATE TEMP TABLE temp_inflated_batches AS
WITH su AS (
  SELECT product_id, MAX(conversion_factor) AS cf
  FROM product_units
  WHERE is_sale_unit AND conversion_factor > 1
  GROUP BY product_id
),
flagged AS (
  SELECT b.id, b.product_id, b.unit_cost AS old_cost,
         p.cost_price AS current_base_cost,
         p.enable_multi_unit,
         su.cf,
         CASE
           WHEN su.cf IS NOT NULL THEN b.unit_cost / su.cf
           ELSE p.cost_price  -- fallback for the 2 batches without product_units row
         END AS new_cost,
         CASE WHEN su.cf IS NOT NULL THEN 'divide_by_cf' ELSE 'fallback_to_product_cost' END AS method
  FROM inventory_batches b
  JOIN products p ON p.id = b.product_id
  LEFT JOIN su ON su.product_id = b.product_id
  WHERE p.enable_multi_unit
    AND p.cost_price > 0
    AND b.unit_cost > p.cost_price * 3  -- inflated by more than 3x
)
SELECT * FROM flagged;

-- ----------------------------------------------------------------------------
-- STEP 1: Correct the 19 inflated batch unit_cost values
-- ----------------------------------------------------------------------------
UPDATE inventory_batches b
SET unit_cost = t.new_cost
FROM temp_inflated_batches t
WHERE b.id = t.id;

SELECT 'STEP 1: Batch unit_cost corrected' AS step, COUNT(*) AS rows
FROM temp_inflated_batches;

-- ----------------------------------------------------------------------------
-- STEP 2: Re-derive ALL consumption records from their batch cost
-- ----------------------------------------------------------------------------
-- Deliberately covers every row, not just inflated ones, so that
-- invoice_item_batch_consumption becomes fully self-consistent with
-- inventory_batches. This also clears any unrelated historical drift and makes
-- STEP 4's target identical to the VERIFICATION query below.
UPDATE invoice_item_batch_consumption ibc
SET unit_cost = b.unit_cost,
    cogs_amount = ROUND(ibc.quantity_consumed * b.unit_cost, 2)
FROM inventory_batches b
WHERE ibc.batch_id = b.id
  AND (ibc.unit_cost IS DISTINCT FROM b.unit_cost
       OR ibc.cogs_amount IS DISTINCT FROM ROUND(ibc.quantity_consumed * b.unit_cost, 2));

-- ----------------------------------------------------------------------------
-- STEP 3: Recompute invoice_items.cost_price = corrected FIFO cogs / SALE qty
-- ----------------------------------------------------------------------------
-- Sums ALL consumption per item (an item may draw on both a corrected and an
-- unaffected batch). ii.quantity is in SALE units, so it must be grouped on,
-- not SUM()'d, or it would be multiplied by the number of consumption rows.
UPDATE invoice_items ii
SET cost_price = cic.total_cogs / cic.sale_qty
FROM (
  SELECT ii2.id AS item_id,
         ii2.quantity AS sale_qty,
         SUM(ibc.cogs_amount) AS total_cogs
  FROM invoice_items ii2
  JOIN invoice_item_batch_consumption ibc ON ibc.invoice_item_id = ii2.id
  WHERE ii2.quantity > 0
  GROUP BY ii2.id, ii2.quantity
) cic
WHERE ii.id = cic.item_id
  AND ii.cost_price IS DISTINCT FROM cic.total_cogs / cic.sale_qty;

-- ----------------------------------------------------------------------------
-- STEP 4: Compute correction and post balanced correcting journal entry
-- ----------------------------------------------------------------------------
-- Target = true cost of goods actually sold, summed per invoice item.
--
-- IMPORTANT: two cost bases coexist in this data, so the FIFO table alone is NOT
-- a complete source of truth. deduct_stock_on_invoice_item does not call
-- consume_fifo, so only 65 invoices (the insert/status-trigger path) have
-- invoice_item_batch_consumption rows. The other 316 had COGS posted by
-- invoice_items_cogs_trigger as quantity * cost_price and have no consumption
-- rows at all. Targeting the FIFO total alone would erase ~2.16M of legitimate
-- COGS and understate cost / overstate profit.
--
--   item has consumption rows -> SUM(cogs_amount)  (true FIFO, corrected in STEP 2)
--   item has none             -> quantity * cost_price
--                                (sale-unit qty x per-sale-unit cost: consistent)
--
-- Only invoices in a sold status count; 'cancelled' and 'draft' are excluded, so
-- any unreversed COGS left behind by a cancellation is swept out too.
--
-- Measured at time of writing:
--   target_cogs              3,657,934.72   (94.7% of 3,861,462.96 invoice revenue)
--   current journal 5000 net 8,216,435.92
--   correction               4,558,501.20
-- Direction: Debit 1200 (Inventory Asset) / Credit 5000 (COGS), which reverses
-- the original inflated/duplicated Debit 5000 / Credit 1200 postings.

DO $$
DECLARE
  v_cogs_account_id uuid;
  v_inv_account_id uuid;
  v_je_id uuid;
  v_correction_amount numeric;
  v_target_cogs numeric;
  v_current_cogs numeric;
  v_tenant_id uuid := '00000000-0000-0000-0000-000000000001'::uuid;
BEGIN
  -- Get account IDs
  SELECT id INTO v_cogs_account_id FROM accounts WHERE code = '5000' AND tenant_id = v_tenant_id;
  SELECT id INTO v_inv_account_id FROM accounts WHERE code = '1200' AND tenant_id = v_tenant_id;

  IF v_cogs_account_id IS NULL OR v_inv_account_id IS NULL THEN
    RAISE EXCEPTION 'Required accounts not found';
  END IF;

  -- True cost of goods sold, per item, across both cost bases
  SELECT COALESCE(SUM(
           COALESCE(
             (SELECT SUM(ibc.cogs_amount)
              FROM invoice_item_batch_consumption ibc
              WHERE ibc.invoice_item_id = ii.id),
             ii.quantity * ii.cost_price
           )
         ), 0)
  INTO v_target_cogs
  FROM invoice_items ii
  JOIN invoices i ON i.id = ii.invoice_id
  WHERE i.status IN ('sent', 'partially_paid', 'paid');

  -- Net over ALL journal_lines on 5000 (not just reference_type='invoice') so the
  -- result is robust to stray/manual COGS entries, and idempotent: a second run
  -- computes ~0 because 5000 already equals the target.
  SELECT COALESCE(SUM(jl.debit - jl.credit), 0)
  INTO v_current_cogs
  FROM journal_lines jl
  WHERE jl.account_id = v_cogs_account_id;

  v_correction_amount := ROUND(v_current_cogs - v_target_cogs, 2);

  RAISE NOTICE 'Target COGS: %, current journal COGS: %, correction (Dr 1200 / Cr 5000): %',
    ROUND(v_target_cogs, 2), ROUND(v_current_cogs, 2), v_correction_amount;

  IF v_correction_amount <= 0 THEN
    RAISE NOTICE 'No correction needed (amount <= 0)';
    RETURN;
  END IF;

  -- Create the correcting journal entry
  INSERT INTO journal_entries (
    tenant_id, entry_number, entry_date, description, reference_type, reference_id,
    total_debit, total_credit, is_posted, created_by
  )
  VALUES (
    v_tenant_id,
    'COGS-CORR-' || to_char(now(), 'YYYYMMDD'),
    CURRENT_DATE,
    'Correction: reverse COGS overstatement from inflated multi-unit batch costs '
      || 'and duplicate/unreversed COGS journal entries. Brings account 5000 to '
      || 'the per-item true cost of goods sold (' || ROUND(v_target_cogs, 2) || ').',
    'cogs_correction',
    gen_random_uuid(),
    v_correction_amount,  -- total_debit
    v_correction_amount,  -- total_credit
    true,                 -- is_posted
    NULL                  -- created_by (matches all existing entries; profiles table is empty)
  )
  RETURNING id INTO v_je_id;

  -- Debit 1200 Inventory Asset (increase asset back)
  INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit, description, sort_order)
  VALUES (v_je_id, v_inv_account_id, v_correction_amount, 0, 'Reverse COGS overstatement - restore inventory asset', 1);

  -- Credit 5000 COGS (decrease expense)
  INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit, description, sort_order)
  VALUES (v_je_id, v_cogs_account_id, 0, v_correction_amount, 'Reverse COGS overstatement - correct cost of goods sold', 2);

  RAISE NOTICE 'Created correcting journal entry: %', v_je_id;
END $$;

SELECT 'STEP 4: Correcting journal entry posted' AS step;

-- ----------------------------------------------------------------------------
-- STEP 5: Re-derive balances for the two accounts this migration touches
-- ----------------------------------------------------------------------------
-- Deliberately scoped to 5000 and 1200 rather than every account. A blanket
-- recalculation would zero out any account whose balance is maintained by a
-- path that does not write journal_lines, and that has not been verified here.
-- Other drifted accounts are reported below for review, not modified.
UPDATE accounts a
SET balance = (
  SELECT COALESCE(SUM(jl.debit - jl.credit), 0)
  FROM journal_lines jl
  WHERE jl.account_id = a.id
)
WHERE a.code IN ('5000', '1200')
  AND a.tenant_id = '00000000-0000-0000-0000-000000000001'::uuid;

-- Report (do NOT modify) any other account whose stored balance has drifted
-- from its journal-derived value. Needs a separate reconciliation decision.
SELECT 'STEP 5 REVIEW: other drifted accounts' AS note,
       a.code, a.name,
       ROUND(a.balance, 2) AS stored,
       ROUND(COALESCE(j.net, 0), 2) AS journal_derived,
       ROUND(COALESCE(j.net, 0) - a.balance, 2) AS delta
FROM accounts a
LEFT JOIN (
  SELECT account_id, SUM(debit - credit) AS net
  FROM journal_lines GROUP BY account_id
) j ON j.account_id = a.id
WHERE a.code NOT IN ('5000', '1200')
  AND ROUND(a.balance, 2) <> ROUND(COALESCE(j.net, 0), 2)
ORDER BY ABS(COALESCE(j.net, 0) - a.balance) DESC;

-- ----------------------------------------------------------------------------
-- STEP 6: Prevention - Guard trigger on inventory_batches
-- ----------------------------------------------------------------------------
-- Reject any insert/update where unit_cost appears to be a sale-unit cost
-- (i.e., >= base_cost * conversion_factor / 2 for multi-unit products)
CREATE OR REPLACE FUNCTION check_batch_unit_cost_is_base_unit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_base_cost numeric;
  v_cf numeric;
  v_threshold numeric;
  v_unit text;
  v_product_name text;
BEGIN
  -- consume_fifo updates quantity_remaining on every sale; skip the lookup
  -- entirely unless unit_cost is actually changing.
  IF TG_OP = 'UPDATE' AND NEW.unit_cost IS NOT DISTINCT FROM OLD.unit_cost THEN
    RETURN NEW;
  END IF;

  -- Only check for multi-unit products with a base cost
  SELECT p.cost_price, p.unit, p.name, COALESCE((
    SELECT MAX(conversion_factor)
    FROM product_units pu
    WHERE pu.product_id = NEW.product_id
      AND pu.is_sale_unit
      AND pu.conversion_factor > 1
  ), 1)
  INTO v_base_cost, v_unit, v_product_name, v_cf
  FROM products p
  WHERE p.id = NEW.product_id;

  IF v_base_cost > 0 AND v_cf > 1 THEN
    v_threshold := v_base_cost * v_cf / 2.0;  -- halfway between base and sale unit cost
    IF NEW.unit_cost >= v_threshold THEN
      RAISE EXCEPTION 'inventory_batches.unit_cost must be in BASE units (per %). Provided % looks like a SALE-unit cost; expected roughly % per base unit (conversion factor %x). Product: %',
        v_unit, NEW.unit_cost, v_base_cost, v_cf, v_product_name
        USING HINT = 'Divide the sale-unit cost by the conversion factor before inserting.';
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_check_batch_unit_cost ON inventory_batches;
CREATE TRIGGER trg_check_batch_unit_cost
  BEFORE INSERT OR UPDATE ON inventory_batches
  FOR EACH ROW EXECUTE FUNCTION check_batch_unit_cost_is_base_unit();

SELECT 'STEP 6: Prevention trigger installed on inventory_batches' AS step;

-- ----------------------------------------------------------------------------
-- STEP 7: Column COMMENTs documenting the base-unit contract
-- ----------------------------------------------------------------------------
COMMENT ON COLUMN inventory_batches.unit_cost IS 'MUST be in BASE units (e.g., per Meter). For multi-unit products, this is sale_unit_cost / conversion_factor. NEVER store per-coil or per-box cost here. Enforced by trg_check_batch_unit_cost.';

COMMENT ON COLUMN invoice_item_batch_consumption.unit_cost IS 'MUST be in BASE units (copied from inventory_batches.unit_cost at time of consumption).';

COMMENT ON COLUMN invoice_items.cost_price IS 'Per SALE unit (what customer sees on invoice). Computed as FIFO cogs_amount / quantity (sale units).';

COMMENT ON COLUMN products.cost_price IS 'Current standard cost per BASE unit. For multi-unit products, this is the per-meter cost.';

COMMENT ON COLUMN product_units.conversion_factor IS 'Multiplier from BASE unit to this unit. E.g., 1 coil = 100 meters => conversion_factor = 100 for the coil unit.';

SELECT 'STEP 7: Column COMMENTs added' AS step;

-- ----------------------------------------------------------------------------
-- VERIFICATION
-- ----------------------------------------------------------------------------
-- The pass condition is COGS (5000) < Revenue (4000), and 5000 == target_cogs.
WITH target AS (
  SELECT COALESCE(SUM(
           COALESCE(
             (SELECT SUM(ibc.cogs_amount)
              FROM invoice_item_batch_consumption ibc
              WHERE ibc.invoice_item_id = ii.id),
             ii.quantity * ii.cost_price
           )
         ), 0) AS total
  FROM invoice_items ii
  JOIN invoices i ON i.id = ii.invoice_id
  WHERE i.status IN ('sent', 'partially_paid', 'paid')
)
SELECT 'VERIFICATION: target COGS (per-item true cost)' AS metric,
       ROUND((SELECT total FROM target), 2) AS value
UNION ALL
SELECT 'VERIFICATION: COGS 5000 stored balance',
       ROUND((SELECT balance FROM accounts
              WHERE code = '5000' AND tenant_id = '00000000-0000-0000-0000-000000000001'::uuid), 2)
UNION ALL
SELECT 'VERIFICATION: COGS 5000 journal-derived',
       ROUND((SELECT COALESCE(SUM(jl.debit - jl.credit), 0)
              FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
              WHERE a.code = '5000' AND a.tenant_id = '00000000-0000-0000-0000-000000000001'::uuid), 2)
UNION ALL
SELECT 'VERIFICATION: Revenue 4000 stored balance',
       ROUND((SELECT balance FROM accounts
              WHERE code = '4000' AND tenant_id = '00000000-0000-0000-0000-000000000001'::uuid), 2)
UNION ALL
SELECT 'VERIFICATION: Inventory 1200 stored balance (still negative, see notes)',
       ROUND((SELECT balance FROM accounts
              WHERE code = '1200' AND tenant_id = '00000000-0000-0000-0000-000000000001'::uuid), 2)
UNION ALL
SELECT 'VERIFICATION: COGS as % of revenue (want < 100)',
       ROUND(
         (SELECT balance FROM accounts
          WHERE code = '5000' AND tenant_id = '00000000-0000-0000-0000-000000000001'::uuid)
         / NULLIF((SELECT balance FROM accounts
                   WHERE code = '4000' AND tenant_id = '00000000-0000-0000-0000-000000000001'::uuid), 0)
         * 100, 2);