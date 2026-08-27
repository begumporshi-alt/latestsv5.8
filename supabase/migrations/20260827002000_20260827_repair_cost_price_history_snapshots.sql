-- ============================================================================
-- Repair cost_price_history snapshots for multi-unit products, and guard the
-- table so the sale-vs-base unit scale defect cannot recur.
--
-- CONTEXT
--   cost_price_history is a DISPLAY-ONLY snapshot table. It is shown in the
--   "Cost Price History" tab of the invoice preview and the POS cart. It does
--   NOT feed the general ledger, COGS (account 5000), inventory valuation, or
--   any financial report - those were repaired separately in
--   20260827001000_..._repair_item_level_cogs_and_period_accuracy.sql.
--
--   By design (see the backfill migration 20260810152927, which sets
--   cost_price_per_qty := invoice_items.cost_price) each invoice-linked row is a
--   frozen copy of the matching invoice line's cost. Both are meant to be the
--   per-SALE-unit cost, on the same scale as unit_price.
--
-- THE DEFECT
--   The COGS repair corrected invoice_items.cost_price for the multi-unit lines
--   (cost was stored per BASE unit - e.g. per metre of cable, per piece of clip -
--   where a per-SALE-unit value, per coil / per box, was expected, and vice
--   versa). That repair did NOT touch this snapshot table, so the "Cost Price
--   History" tab still shows the old, wrong figure while the invoice itself now
--   shows the corrected one. The gap is the conversion factor (100x for the
--   cables/clips, both directions), exactly the class already fixed upstream.
--
-- DETECTION (product-independent, same technique as the COGS repair)
--   Compare each snapshot's cost_price_per_qty against the CORRECTED, 1:1-matched
--   invoice_items.cost_price for the same (invoice_id, product_id). The join is
--   unambiguous: every pair has exactly one invoice_item and one history row
--   (verified: 1597 item-pairs and 1517 history-pairs, all count = 1, zero pairs
--   with differing costs). invoice_items.cost_price is authoritative because it
--   is the value that actually drove COGS and is what the invoice displays.
--
-- MEASURED SCOPE (all dates)
--   invoice-linked rows:  1474 already match, 10 stale-too-high, 5 stale-too-low
--                         (the 15 multi-unit scale defects), 17 minor non-scale
--                         gaps (also stale vs the corrected invoice), 11 orphans.
--   quotation-linked rows: 559 self-consistent, 0 scale defects.
--
-- WHAT THIS MIGRATION DOES
--   STEP 1  Re-sync every invoice-linked snapshot that diverges from the
--           corrected invoice line (the 15 scale defects + 17 minor gaps = 32
--           rows). All four cost columns are rewritten together so the tab is
--           internally consistent. Naturally idempotent: a second run finds
--           nothing beyond the 0.01 rounding tolerance.
--   STEP 2  Install a BEFORE INSERT OR UPDATE guard on cost_price_history that
--           rejects a snapshot whose cost/price ratio betrays a scale error,
--           using the SAME cf/2 .. 2/cf bounds validated for invoice_items. This
--           protects BOTH write paths - the invoice path (already protected
--           transitively, since the invoice_items insert is guarded and errors
--           out before the snapshot insert) and the quotation path (which has no
--           other guard). Installed AFTER the re-sync so it cannot reject it.
--
-- OUT OF SCOPE (deliberate)
--   a) 11 orphan rows with no matching invoice_item (product swapped or line
--      deleted). They are self-consistent (cost < price, plausible margins) and
--      have no authoritative source to re-sync from. Left untouched.
--   b) quotation-linked rows: 0 scale defects, nothing to correct.
--   c) the underlying financial repair - already done upstream.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- STEP 1: Re-sync invoice-linked snapshots to the corrected invoice line cost
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_before int;
BEGIN
  SELECT COUNT(*) INTO v_before
  FROM cost_price_history cph
  JOIN invoice_items ii
    ON ii.invoice_id = cph.invoice_id AND ii.product_id = cph.product_id
  WHERE cph.invoice_id IS NOT NULL
    AND ABS(cph.cost_price_per_qty - ii.cost_price) > 0.01;
  RAISE NOTICE 'STEP 1: % invoice-linked snapshot rows diverge and will be re-synced.', v_before;
END $$;

UPDATE cost_price_history cph
SET cost_price_per_qty       = ii.cost_price,
    cost_price_for_added_qty = ROUND(ii.cost_price * cph.quantity, 2),
    total_cost_price_single  = ii.cost_price,
    total_cost_price_added   = ROUND(ii.cost_price * cph.quantity, 2)
FROM invoice_items ii
WHERE ii.invoice_id = cph.invoice_id
  AND ii.product_id = cph.product_id
  AND cph.invoice_id IS NOT NULL
  AND ABS(cph.cost_price_per_qty - ii.cost_price) > 0.01;

SELECT 'STEP 1: re-sync complete' AS step;

-- ----------------------------------------------------------------------------
-- STEP 2: Guard cost_price_history against the scale defect (installed last)
-- ----------------------------------------------------------------------------
-- Same discriminator and bounds as trg_check_invoice_item_cost_scale on
-- invoice_items: the ratio cost_price_per_qty / unit_price is compared to the
-- product's own conversion factor. A scale error puts it near cf or near 1/cf;
-- genuine trading ratios sit around 0.7-0.9, and deep discounts / high-margin
-- items stay comfortably inside cf/2 .. 2/cf. Single-unit products (cf <= 1)
-- are skipped: they cannot have a scale error, so there is nothing to check.
CREATE OR REPLACE FUNCTION check_cost_price_history_scale()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_cf numeric;
  v_ratio numeric;
  v_name text;
BEGIN
  IF NEW.unit_price IS NULL OR NEW.unit_price <= 0
     OR NEW.cost_price_per_qty IS NULL OR NEW.cost_price_per_qty <= 0
     OR NEW.product_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT p.name,
         COALESCE((SELECT MAX(pu.conversion_factor)
                   FROM product_units pu
                   WHERE pu.product_id = NEW.product_id
                     AND pu.is_sale_unit
                     AND pu.conversion_factor > 1), 1)
  INTO v_name, v_cf
  FROM products p WHERE p.id = NEW.product_id;

  IF v_cf IS NULL OR v_cf <= 1 THEN
    RETURN NEW;
  END IF;

  v_ratio := NEW.cost_price_per_qty / NEW.unit_price;

  IF v_ratio > v_cf / 2.0 THEN
    RAISE EXCEPTION 'cost_price_history.cost_price_per_qty (%) is about %x unit_price (%) for multi-unit product "%" (conversion factor %). The snapshot cost must be per SALE unit, on the same scale as unit_price.',
      NEW.cost_price_per_qty, ROUND(v_ratio, 1), NEW.unit_price, v_name, v_cf
      USING HINT = 'Divide the base-unit cost by the conversion factor to get the sale-unit cost.';
  END IF;

  IF v_ratio < 2.0 / v_cf THEN
    RAISE EXCEPTION 'cost_price_history.cost_price_per_qty (%) is only a % fraction of unit_price (%) for multi-unit product "%" (conversion factor %). The snapshot cost must be per SALE unit, on the same scale as unit_price.',
      NEW.cost_price_per_qty, ROUND(v_ratio, 5), NEW.unit_price, v_name, v_cf
      USING HINT = 'Multiply the base-unit cost by the conversion factor to get the sale-unit cost.';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_check_cost_price_history_scale ON cost_price_history;
CREATE TRIGGER trg_check_cost_price_history_scale
  BEFORE INSERT OR UPDATE ON cost_price_history
  FOR EACH ROW EXECUTE FUNCTION check_cost_price_history_scale();

SELECT 'STEP 2: guard trigger installed' AS step;

COMMENT ON COLUMN cost_price_history.cost_price_per_qty IS
  'Per-SALE-unit cost snapshot at time of sale/quotation, on the same scale as unit_price. Mirrors invoice_items.cost_price for invoice-linked rows. Guarded by trg_check_cost_price_history_scale against sale-vs-base unit scale errors.';

-- ----------------------------------------------------------------------------
-- VERIFICATION
-- ----------------------------------------------------------------------------
\echo ''
\echo '=== V1. Invoice-linked snapshots now match the corrected invoice ==='
WITH ii AS (
  SELECT invoice_id, product_id, MAX(cost_price) AS ii_cost
  FROM invoice_items GROUP BY invoice_id, product_id
)
SELECT CASE
         WHEN ABS(cph.cost_price_per_qty - ii.ii_cost) <= 0.01 THEN 'matches_corrected_invoice'
         ELSE 'still_diverges'
       END AS bucket,
       COUNT(*) AS rows
FROM cost_price_history cph
JOIN ii ON ii.invoice_id = cph.invoice_id AND ii.product_id = cph.product_id
WHERE cph.invoice_id IS NOT NULL
GROUP BY 1 ORDER BY 2 DESC;

\echo ''
\echo '=== V2. No MULTI-UNIT invoice-linked snapshot still carries a scale defect ==='
-- Scoped to multi-unit products, matching the guard's own scope: a single-unit
-- product cannot have a sale-vs-base scale error, so an extreme cost/price ratio
-- there is merely unusual data, not this defect. Four single-unit test fixtures
-- ("test", "test coil", "test11", "A-test") sell at ~100% margin (e.g. price
-- 2000 / cost 1) and already mirror their invoice line exactly; an unscoped
-- ratio test counts them and looks like 7 failures. Expect 0 here.
SELECT COUNT(*) AS scale_defect_rows_remaining
FROM cost_price_history cph
WHERE cph.invoice_id IS NOT NULL AND cph.unit_price > 0 AND cph.cost_price_per_qty > 0
  AND EXISTS (SELECT 1 FROM product_units pu
              WHERE pu.product_id = cph.product_id
                AND pu.is_sale_unit AND pu.conversion_factor > 1)
  AND (cph.cost_price_per_qty / cph.unit_price > 3
       OR cph.cost_price_per_qty / cph.unit_price < 0.05);

\echo ''
\echo '=== V2b. Every invoice-linked snapshot now equals its invoice line (expect 0) ==='
-- The guarantee the re-sync actually makes, and the primary success criterion.
SELECT COUNT(*) AS rows_still_diverging_from_invoice
FROM cost_price_history cph
JOIN invoice_items ii
  ON ii.invoice_id = cph.invoice_id AND ii.product_id = cph.product_id
WHERE cph.invoice_id IS NOT NULL
  AND ABS(cph.cost_price_per_qty - ii.cost_price) > 0.01;

\echo ''
\echo '=== V3. The 15 formerly-defective rows, after re-sync ==='
SELECT left(product_name, 26) AS product, unit, quantity,
       ROUND(unit_price,2) AS price, ROUND(cost_price_per_qty,2) AS cost_now,
       created_at::date AS recorded
FROM cost_price_history
WHERE invoice_id IS NOT NULL
  AND created_at >= CURRENT_DATE - 7
  AND product_id IN (
    '9f885740-715a-4820-9751-4527f01d91d7',  -- ERICSON 20mm
    '25fab588-5965-41e7-9e68-42c9488f9d69',  -- ERICSON 5mm
    'ed58c109-f624-40a2-b838-6b01bc5034d0',  -- ERICSON 23*76 TC
    '15877200-7796-46d6-8ba3-5ffd42562ea1'   -- walton 1*6.0
  )
ORDER BY recorded DESC, product;

\echo ''
\echo '=== V4. Guard is active on cost_price_history ==='
SELECT tgname, tgenabled FROM pg_trigger
WHERE tgrelid = 'cost_price_history'::regclass AND NOT tgisinternal;
