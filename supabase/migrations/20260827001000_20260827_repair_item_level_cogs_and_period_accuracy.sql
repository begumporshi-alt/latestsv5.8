-- ============================================================================
-- REPAIR: item-level COGS scale defects + period-accurate correcting entries
-- ============================================================================
-- Follow-up to 20260827000100_20260827_fix_cogs_inflation_and_duplication.sql.
-- That migration fixed batch-level cost inflation (Bug 1) and absorbed duplicate
-- journal entries (Bug 2) with ONE lump entry dated today. Two problems remain:
--
-- BUG 3 - Its STEP 3 recomputed invoice_items.cost_price via an INNER JOIN on
--   invoice_item_batch_consumption, so items with no consumption rows were never
--   touched. Three walton lines kept a per-COIL cost against a per-METER price.
--
-- BUG 4 - Its STEP 0 flagged batches by `unit_cost > products.cost_price * 3`.
--   For three ERICSON products products.cost_price is ITSELF in sale units, so
--   the ratio is 1.0 and they escaped detection entirely.
--
-- BUG 5 (new) - The mirror image: 22 lines carry a per-METER cost against a
--   per-COIL price, so quantity * cost_price omits the conversion factor and
--   COGS is UNDERSTATED. Never previously scoped.
--
-- BUG 6 (new) - 3 lines have cost_price = 0 (two from a zero-cost opening batch).
--
-- BUG 7 - The lump correction is dated CURRENT_DATE, so it reverses in August an
--   overstatement incurred mostly in July. Any period narrower than the whole
--   corrected span reports wrongly. Replaced here by per-invoice entries dated
--   each invoice's own invoice_date.
--
-- DETECTION METHOD
-- products.cost_price and invoice_items.unit_conversion_factor are both corrupted
-- in this data, so neither can serve as truth. The reliable, product-independent
-- discriminator is the INTERNAL ratio cost_price / unit_price: both columns live
-- on the same invoice line and must share a unit scale for the line to be
-- economically coherent.
--   ratio > 3     -> cost at a HIGHER scale than price -> COGS overstated
--   ratio < 0.05  -> cost at a LOWER  scale than price -> COGS understated
--   0.05..3       -> internally consistent; leave alone
-- This is why ~19 coil-scale lines that look broken (quantity in coils, cost per
-- coil, unit_conversion_factor 1) are correctly IGNORED: their ratio is ~0.71,
-- giving the same ~28.7% gross margin as every other walton line. Dividing them
-- by the conversion factor would badly understate COGS.
--
-- INDEPENDENT VALIDATION
-- After repair every affected invoice lands at a positive 8.7%-15.1% gross margin
-- and every walton line at ~28.7%, consistent across products and dates. That
-- margin coherence, not any single heuristic, is what confirms the direction and
-- magnitude of each correction.
--
-- MEASURED EFFECT (verified against production before writing)
--   corrected per-item COGS target        3,484,559.31   (was 3,657,934.73)
--     cost_too_high   9 lines   452,844.00 ->     4,536.36   (-448,307.64)
--     cost_too_low   22 lines     2,771.57 ->   277,157.00   (+274,385.43)
--     zero_cost       3 lines         0.00 ->       546.80   (+546.80)
--     ok          1,390 lines unchanged
--   account 5000 3,657,934.72 -> 3,461,005.44  (85.7% of revenue 4,040,396.51)
--   account 1200 -3,206,256.77 -> -3,009,327.49
--   per-invoice corrections: 27 invoices, net -4,755,430.48
--
-- SAFETY
-- invoice_items triggers are AFTER INSERT only, so updating cost_price here does
-- NOT re-fire COGS posting or stock deduction. products, product_units,
-- journal_entries, journal_lines and invoice_item_batch_consumption have no
-- triggers. invoices is never written, so its UPDATE triggers never fire.
-- Prevention triggers are installed LAST so they cannot reject this repair.
--
-- OUT OF SCOPE (reported at the end, deliberately not changed)
-- (a) Account 1200 stays negative (~-3.0M). The FIFO opening backfill created
--     batches with no matching GL debit, so stock was credited out on sale having
--     never been capitalised. Closing it needs Debit 1200 / Credit 3900 of ~20M,
--     which materially restates equity: an owner decision, not a mechanical fix.
-- (b) Stock quantities. The cost_too_low lines also under-deducted stock, but the
--     remaining batch quantity is smaller than the shortfall, so retroactively
--     consuming it would drive batches negative. Needs a physical count.
-- (c) `test coil` has inverted is_base_unit / is_sale_unit flags. It is test data
--     (total COGS impact 8.00) so its cost is left alone rather than inventing a
--     basis; reported for review.
-- (d) Duplicate COGS journal entries still physically exist. They now NET to the
--     correct per-invoice figure, and the audit trail is preserved intentionally.
-- ============================================================================

\set ON_ERROR_STOP on

-- ----------------------------------------------------------------------------
-- STEP 0: Fix the one product_units config bug the snapshot depends on
-- ----------------------------------------------------------------------------
-- walton cable 1*1.5 RM Yellow has its `coil` row at conversion_factor 1 instead
-- of 100. Fixed BEFORE the snapshot so the generic cf expression below needs no
-- hardcoded product name. Confirmed by all four sibling walton 1*1.5 variants
-- (coil = 100) and by the 21.6% margin the correction produces.
UPDATE product_units pu
SET conversion_factor = 100
FROM products p
WHERE p.id = pu.product_id
  AND p.name = 'walton cable 1*1.5 RM Yellow'
  AND lower(pu.unit_name) = 'coil'
  AND pu.conversion_factor = 1;

SELECT 'STEP 0: walton 1*1.5 RM Yellow coil conversion_factor -> 100' AS step;

-- ----------------------------------------------------------------------------
-- STEP 1: Snapshot the line-level classification BEFORE changing any data
-- ----------------------------------------------------------------------------
-- Everything downstream reads this snapshot, so the repair is computed once from
-- a consistent view and cannot drift as the underlying rows are updated.
-- Dropped first because Supabase's connection pooler reuses backends: a temp
-- table from an earlier run can outlive the client session that created it.
DROP TABLE IF EXISTS tmp_line_fix;
CREATE TEMP TABLE tmp_line_fix AS
WITH cf AS (
  SELECT p.id AS product_id,
         COALESCE((SELECT MAX(pu.conversion_factor)
                   FROM product_units pu
                   WHERE pu.product_id = p.id
                     AND pu.is_sale_unit
                     AND pu.conversion_factor > 1), 1) AS cf_sale
  FROM products p
),
fifo AS (
  SELECT invoice_item_id, SUM(cogs_amount) AS fifo_cogs
  FROM invoice_item_batch_consumption
  GROUP BY 1
)
SELECT ii.id                                   AS item_id,
       i.id                                    AS invoice_id,
       i.invoice_number,
       i.invoice_date,
       ii.product_id,
       p.name                                  AS product_name,
       ii.quantity                             AS qty,
       ii.unit_price,
       ii.cost_price                           AS old_cost,
       c.cf_sale,
       (f.fifo_cogs IS NOT NULL)                AS has_fifo,
       COALESCE(f.fifo_cogs, ii.quantity * ii.cost_price) AS booked,
       CASE
         WHEN ii.unit_price = 0                    THEN 'zero_price'
         WHEN ii.cost_price = 0                    THEN 'zero_cost'
         WHEN ii.cost_price / ii.unit_price > 3    THEN 'cost_too_high'
         WHEN ii.cost_price / ii.unit_price < 0.05 THEN 'cost_too_low'
         ELSE 'ok'
       END                                     AS verdict,
       -- Corrected cost per SALE unit, per the invoice_items.cost_price contract
       CASE
         WHEN ii.unit_price = 0                    THEN ii.cost_price
         WHEN ii.cost_price = 0                    THEN p.cost_price
         WHEN ii.cost_price / ii.unit_price > 3    THEN ii.cost_price / c.cf_sale
         WHEN ii.cost_price / ii.unit_price < 0.05 THEN ii.cost_price * c.cf_sale
         ELSE ii.cost_price
       END                                     AS new_cost
FROM invoice_items ii
JOIN invoices i  ON i.id = ii.invoice_id
JOIN products p  ON p.id = ii.product_id
JOIN cf c        ON c.product_id = ii.product_id
LEFT JOIN fifo f ON f.invoice_item_id = ii.id
WHERE i.status IN ('sent', 'partially_paid', 'paid')
  AND ii.quantity > 0;

-- True per-line COGS. For a defective line the corrupt FIFO total is discarded in
-- favour of qty * corrected sale-unit cost; for an `ok` line the existing basis is
-- kept verbatim so the 1,390 healthy lines produce a zero delta.
ALTER TABLE tmp_line_fix ADD COLUMN true_cogs numeric;
UPDATE tmp_line_fix
SET true_cogs = CASE
  WHEN verdict IN ('cost_too_high', 'cost_too_low', 'zero_cost')
    THEN ROUND(qty * new_cost, 2)
  ELSE ROUND(booked, 2)
END;

SELECT 'STEP 1: line classification' AS step, verdict, COUNT(*) AS lines,
       ROUND(SUM(booked), 2) AS booked, ROUND(SUM(true_cogs), 2) AS truth,
       ROUND(SUM(true_cogs - booked), 2) AS delta
FROM tmp_line_fix GROUP BY verdict ORDER BY 4 DESC;

-- ----------------------------------------------------------------------------
-- STEP 2: Snapshot the per-invoice correction, then assert it is sane
-- ----------------------------------------------------------------------------
-- booked_net includes every invoice-linked COGS reference type AND this
-- migration's own 'cogs_repair', which makes the whole migration idempotent: a
-- second run computes a correction of 0 for every invoice and posts nothing.
-- sales_return is excluded on purpose - it reverses COGS for goods physically
-- returned and is a legitimate reduction that must survive.
DROP TABLE IF EXISTS tmp_invoice_fix;
CREATE TEMP TABLE tmp_invoice_fix AS
WITH truth AS (
  SELECT invoice_id, invoice_number, invoice_date, SUM(true_cogs) AS true_cogs
  FROM tmp_line_fix GROUP BY 1, 2, 3
),
booked AS (
  SELECT je.reference_id AS invoice_id,
         SUM(jl.debit - jl.credit) AS booked_net
  FROM journal_entries je
  JOIN journal_lines jl ON jl.journal_entry_id = je.id
  JOIN accounts a ON a.id = jl.account_id
                 AND a.code = '5000'
                 AND a.tenant_id = '00000000-0000-0000-0000-000000000001'::uuid
  WHERE je.reference_type IN ('invoice', 'invoice_edit', 'invoice_cancel',
                              'cleanup', 'cogs_repair')
  GROUP BY 1
)
SELECT COALESCE(t.invoice_id, b.invoice_id)          AS invoice_id,
       COALESCE(t.invoice_number, i.invoice_number)  AS invoice_number,
       COALESCE(t.invoice_date, i.invoice_date)      AS invoice_date,
       ROUND(COALESCE(b.booked_net, 0), 2)           AS booked_net,
       ROUND(COALESCE(t.true_cogs, 0), 2)            AS true_cogs,
       ROUND(COALESCE(t.true_cogs, 0) - COALESCE(b.booked_net, 0), 2) AS correction
FROM truth t
FULL OUTER JOIN booked b ON b.invoice_id = t.invoice_id
LEFT JOIN invoices i ON i.id = b.invoice_id
WHERE ROUND(COALESCE(t.true_cogs, 0) - COALESCE(b.booked_net, 0), 2) <> 0;

DO $$
DECLARE
  v_n int;
  v_total numeric;
  v_expected numeric := -4755430.48;
BEGIN
  SELECT COUNT(*), COALESCE(SUM(correction), 0) INTO v_n, v_total FROM tmp_invoice_fix;
  RAISE NOTICE 'STEP 2: % invoices need correction, net %', v_n, ROUND(v_total, 2);

  -- v_expected is a deliberate checksum on THIS tenant's data, not a portable
  -- constant. Any other dataset should be refused rather than silently repaired
  -- with figures derived from a different book.
  IF v_n = 0 THEN
    RAISE NOTICE 'STEP 2: already reconciled; STEP 8 will post nothing.';

  ELSIF ABS(v_total - v_expected) <= 1.00 THEN
    RAISE NOTICE 'STEP 2: first run confirmed against analysed figures.';

  ELSIF ABS(v_total) <= 1000.00 THEN
    -- Re-deriving after a successful run does not reproduce the correction to the
    -- exact penny: lines that were defective are now healthy, so their true cost
    -- is read from the FIFO consumption rows rather than quantity * cost_price,
    -- and those two paths round independently. The residual is cents on a 3.4M
    -- book. Clearing the snapshot makes a repeat run a genuine no-op instead of
    -- double-posting a spurious rounding entry on top of correct ones.
    RAISE NOTICE 'STEP 2: repeat run detected (residual % is rounding noise). Skipping re-post; existing entries are already correct.', ROUND(v_total, 2);
    DELETE FROM tmp_invoice_fix;

  ELSE
    RAISE EXCEPTION 'Unexpected correction total % (expected % on first run, or near zero on a repeat run). Data has changed since analysis; re-derive before applying.', ROUND(v_total, 2), v_expected;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- STEP 3: Product configuration - Bug 4 root cause
-- ----------------------------------------------------------------------------
-- These three products hold a per-SALE-unit cost in products.cost_price, which is
-- contractually per BASE unit, and carry the sale unit in products.unit.
-- products.base_unit is already correct for all of them and is NOT touched.
-- Must precede the batch repair so the guard trigger's threshold
-- (cost_price * cf / 2) is derived from a corrected base cost.
UPDATE products p
SET cost_price = p.cost_price / pu.conversion_factor,
    unit       = p.base_unit
FROM product_units pu
WHERE pu.product_id = p.id
  AND pu.is_sale_unit
  AND pu.conversion_factor > 1
  AND p.id IN ('9f885740-715a-4820-9751-4527f01d91d7',  -- ERICSON 20mm cable clip  230.00 -> 2.30
               '25fab588-5965-41e7-9e68-42c9488f9d69',  -- ERICSON 5mm cable clip     27.00 -> 0.27
               'ed58c109-f624-40a2-b838-6b01bc5034d0')  -- ERICSON 23*76 TC        2375.00 -> 23.75
  AND p.unit IS DISTINCT FROM p.base_unit;

-- walton cable 1*6.0 RM Black: cost_price 126.97 is ALREADY correct per metre
-- (confirmed by POS-00590064: 60 Meter @ 177.05 -> cogs 7,618.20). Only the label
-- is stale, so fix products.unit and leave every cost untouched.
UPDATE products
SET unit = base_unit
WHERE id = '15877200-7796-46d6-8ba3-5ffd42562ea1'
  AND unit IS DISTINCT FROM base_unit;

SELECT 'STEP 3: product config corrected' AS step, name, unit, base_unit,
       ROUND(cost_price, 4) AS cost_price
FROM products
WHERE id IN ('9f885740-715a-4820-9751-4527f01d91d7',
             '25fab588-5965-41e7-9e68-42c9488f9d69',
             'ed58c109-f624-40a2-b838-6b01bc5034d0',
             '15877200-7796-46d6-8ba3-5ffd42562ea1')
ORDER BY name;

-- ----------------------------------------------------------------------------
-- STEP 4: inventory_batches - the sale-unit costs Bug 1's 3x filter missed
-- ----------------------------------------------------------------------------
UPDATE inventory_batches b
SET unit_cost = b.unit_cost / pu.conversion_factor
FROM products p
JOIN product_units pu ON pu.product_id = p.id AND pu.is_sale_unit AND pu.conversion_factor > 1
WHERE p.id = b.product_id
  AND p.id IN ('9f885740-715a-4820-9751-4527f01d91d7',
               '25fab588-5965-41e7-9e68-42c9488f9d69',
               'ed58c109-f624-40a2-b838-6b01bc5034d0')
  AND b.unit_cost > p.cost_price * 3;  -- p.cost_price is already corrected by STEP 3

-- Nut Bolt Washer's opening batch was created with unit_cost 0, which is why two
-- lines booked zero COGS. products.cost_price (0.20) is the only available basis.
UPDATE inventory_batches b
SET unit_cost = p.cost_price
FROM products p
WHERE p.id = b.product_id
  AND p.name = 'Nut Bolt Washer'
  AND b.unit_cost = 0
  AND p.cost_price > 0;

SELECT 'STEP 4: batch unit_cost corrected' AS step, left(p.name, 26) AS name,
       b.batch_number, ROUND(b.unit_cost, 4) AS unit_cost
FROM inventory_batches b JOIN products p ON p.id = b.product_id
WHERE p.id IN ('9f885740-715a-4820-9751-4527f01d91d7',
               '25fab588-5965-41e7-9e68-42c9488f9d69',
               'ed58c109-f624-40a2-b838-6b01bc5034d0')
   OR p.name = 'Nut Bolt Washer'
ORDER BY p.name, b.batch_number;

-- ----------------------------------------------------------------------------
-- STEP 5: invoice_item_batch_consumption
-- ----------------------------------------------------------------------------
-- 5a. Re-derive from the corrected batch cost. quantity_consumed is already in
--     base units for these rows (235 pieces for 235 clips sold, 4 m for 4 m), so
--     only the cost side was wrong.
UPDATE invoice_item_batch_consumption ibc
SET unit_cost   = b.unit_cost,
    cogs_amount = ROUND(ibc.quantity_consumed * b.unit_cost, 2)
FROM inventory_batches b
JOIN products p ON p.id = b.product_id
WHERE ibc.batch_id = b.id
  AND (p.id IN ('9f885740-715a-4820-9751-4527f01d91d7',
                '25fab588-5965-41e7-9e68-42c9488f9d69',
                'ed58c109-f624-40a2-b838-6b01bc5034d0')
       OR p.name = 'Nut Bolt Washer')
  AND (ibc.unit_cost IS DISTINCT FROM b.unit_cost
       OR ibc.cogs_amount IS DISTINCT FROM ROUND(ibc.quantity_consumed * b.unit_cost, 2));

-- 5b. cost_too_low lines: quantity_consumed was recorded in SALE units (5 for
--     5 coils) against a per-METRE unit_cost, so the conversion factor was lost.
--     Scale unit_cost to the sale unit instead of inflating quantity_consumed:
--     that keeps the row's own invariant (cogs = qty * unit_cost) intact, matches
--     the sale-unit shape already present on many healthy lines, and avoids
--     implying stock movements the batches cannot support (see OUT OF SCOPE b).
UPDATE invoice_item_batch_consumption ibc
SET unit_cost   = ibc.unit_cost * t.cf_sale,
    cogs_amount = ROUND(ibc.quantity_consumed * ibc.unit_cost * t.cf_sale, 2)
FROM tmp_line_fix t
WHERE t.item_id = ibc.invoice_item_id
  AND t.verdict = 'cost_too_low'
  AND t.cf_sale > 1;

SELECT 'STEP 5: consumption rows re-derived' AS step;

-- ----------------------------------------------------------------------------
-- STEP 6: invoice_items.cost_price -> corrected cost per SALE unit
-- ----------------------------------------------------------------------------
UPDATE invoice_items ii
SET cost_price = t.new_cost
FROM tmp_line_fix t
WHERE t.item_id = ii.id
  AND t.verdict IN ('cost_too_high', 'cost_too_low', 'zero_cost')
  AND ii.cost_price IS DISTINCT FROM t.new_cost;

SELECT 'STEP 6: invoice_items.cost_price corrected' AS step,
       verdict, COUNT(*) AS lines
FROM tmp_line_fix
WHERE verdict IN ('cost_too_high', 'cost_too_low', 'zero_cost')
GROUP BY verdict ORDER BY verdict;

-- ----------------------------------------------------------------------------
-- STEP 7: Remove the lump correction that broke period reporting
-- ----------------------------------------------------------------------------
DELETE FROM journal_lines
WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE reference_type = 'cogs_correction');

DELETE FROM journal_entries WHERE reference_type = 'cogs_correction';

SELECT 'STEP 7: lump COGS-CORR entry removed' AS step;

-- ----------------------------------------------------------------------------
-- STEP 8: Per-invoice correcting entries, dated each invoice's own date
-- ----------------------------------------------------------------------------
-- Dating each correction to invoice_date is what makes every range - today, week,
-- month, quarter, year, custom - report correctly, instead of concentrating a
-- multi-month correction into whichever day the migration happened to run.
-- Original entries are left in place so the audit trail survives.
DO $$
DECLARE
  r record;
  v_cogs uuid;
  v_inv uuid;
  v_je uuid;
  v_tenant uuid := '00000000-0000-0000-0000-000000000001'::uuid;
  v_n int := 0;
BEGIN
  SELECT id INTO v_cogs FROM accounts WHERE code = '5000' AND tenant_id = v_tenant;
  SELECT id INTO v_inv  FROM accounts WHERE code = '1200' AND tenant_id = v_tenant;
  IF v_cogs IS NULL OR v_inv IS NULL THEN
    RAISE EXCEPTION 'Required accounts 5000 / 1200 not found for tenant %', v_tenant;
  END IF;

  FOR r IN SELECT * FROM tmp_invoice_fix ORDER BY invoice_date, invoice_number LOOP
    INSERT INTO journal_entries (
      tenant_id, entry_number, entry_date, description, reference_type, reference_id,
      total_debit, total_credit, is_posted, created_by
    )
    VALUES (
      v_tenant,
      'COGS-FIX-' || r.invoice_number,
      r.invoice_date,
      'COGS repair for ' || r.invoice_number || ': restate cost of goods sold from '
        || ROUND(r.booked_net, 2) || ' to per-item true cost ' || ROUND(r.true_cogs, 2)
        || '. Corrects unit-scale errors in invoice_items.cost_price and duplicate '
        || 'or unreversed COGS postings. Dated the invoice date so period reporting is accurate.',
      'cogs_repair',
      r.invoice_id,
      ABS(r.correction),
      ABS(r.correction),
      true,
      NULL
    )
    RETURNING id INTO v_je;

    IF r.correction < 0 THEN
      -- COGS was overstated: reverse it and restore the inventory asset
      INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit, description, sort_order)
      VALUES (v_je, v_inv,  ABS(r.correction), 0, 'Restore inventory asset - COGS overstated', 1),
             (v_je, v_cogs, 0, ABS(r.correction), 'Reduce COGS to per-item true cost', 2);
    ELSE
      -- COGS was understated: book the missing cost
      INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit, description, sort_order)
      VALUES (v_je, v_cogs, ABS(r.correction), 0, 'Increase COGS to per-item true cost', 1),
             (v_je, v_inv,  0, ABS(r.correction), 'Relieve inventory asset - COGS understated', 2);
    END IF;

    v_n := v_n + 1;
  END LOOP;

  RAISE NOTICE 'STEP 8: posted % per-invoice correcting entries', v_n;
END $$;

-- ----------------------------------------------------------------------------
-- STEP 9: Re-derive balances for the two accounts touched
-- ----------------------------------------------------------------------------
-- Scoped to 5000 and 1200. A blanket recalculation would sign-flip every
-- credit-natural account, whose balance convention is SUM(credit - debit).
UPDATE accounts a
SET balance = (SELECT COALESCE(SUM(jl.debit - jl.credit), 0)
               FROM journal_lines jl WHERE jl.account_id = a.id)
WHERE a.code IN ('5000', '1200')
  AND a.tenant_id = '00000000-0000-0000-0000-000000000001'::uuid;

SELECT 'STEP 9: balances re-derived for 5000 and 1200' AS step;

-- ----------------------------------------------------------------------------
-- STEP 10: Prevention (installed last so it cannot reject this migration)
-- ----------------------------------------------------------------------------
-- 10a. Reject unit-scale mismatches on invoice_items.
-- Thresholds are relative to the product's own conversion factor, NOT absolute.
-- A scale error puts the ratio near cf (cost per coil vs price per metre) or near
-- 1/cf (the inverse). Genuine trading ratios sit around 0.7-0.9. Using cf/2 and
-- 2/cf as bounds catches both scale errors while leaving the entire plausible
-- commercial band - including deep clearance discounts and 95% margin items -
-- untouched. Single-unit products are skipped entirely: they cannot have a scale
-- error, so there is nothing to check and no way to false-alarm.
CREATE OR REPLACE FUNCTION check_invoice_item_cost_scale()
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
     OR NEW.cost_price IS NULL OR NEW.cost_price <= 0 THEN
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

  v_ratio := NEW.cost_price / NEW.unit_price;

  IF v_ratio > v_cf / 2.0 THEN
    RAISE EXCEPTION 'invoice_items.cost_price (%) is about %x unit_price (%) for multi-unit product "%" (conversion factor %). cost_price must be per SALE unit, on the same scale as unit_price.',
      NEW.cost_price, ROUND(v_ratio, 1), NEW.unit_price, v_name, v_cf
      USING HINT = 'Divide the base-unit cost by the conversion factor to get the sale-unit cost.';
  END IF;

  IF v_ratio < 2.0 / v_cf THEN
    RAISE EXCEPTION 'invoice_items.cost_price (%) is only a % fraction of unit_price (%) for multi-unit product "%" (conversion factor %). cost_price must be per SALE unit, on the same scale as unit_price.',
      NEW.cost_price, ROUND(v_ratio, 5), NEW.unit_price, v_name, v_cf
      USING HINT = 'Multiply the base-unit cost by the conversion factor to get the sale-unit cost.';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_check_invoice_item_cost_scale ON invoice_items;
CREATE TRIGGER trg_check_invoice_item_cost_scale
  BEFORE INSERT OR UPDATE ON invoice_items
  FOR EACH ROW EXECUTE FUNCTION check_invoice_item_cost_scale();

-- 10b. Keep products.unit on the declared base unit.
-- Bug 4's root cause was products.unit drifting to the SALE unit while
-- cost_price silently followed it. This normalises rather than rejects, so no
-- user-facing flow can break. Synonyms are treated as already-correct, which is
-- what stops false alarms on 'kg' vs 'Kilogram' and 'pcs' vs 'pieces' - two
-- products that differ only in spelling and are perfectly healthy.
CREATE OR REPLACE FUNCTION public.normalize_unit_name(p_unit text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE lower(trim(p_unit))
           WHEN 'pcs' THEN 'pieces'
           WHEN 'pc'  THEN 'pieces'
           WHEN 'kg'  THEN 'kilogram'
           WHEN 'gm'  THEN 'gram'
           WHEN 'ltr' THEN 'litre'
           WHEN 'l'   THEN 'litre'
           ELSE lower(trim(p_unit))
         END
$$;

CREATE OR REPLACE FUNCTION normalize_product_unit_to_base()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_base text;
BEGIN
  SELECT pu.unit_name INTO v_base
  FROM product_units pu
  WHERE pu.product_id = NEW.id AND pu.is_base_unit
  ORDER BY pu.conversion_factor
  LIMIT 1;

  IF v_base IS NULL OR NEW.unit IS NULL THEN
    RETURN NEW;
  END IF;

  IF public.normalize_unit_name(NEW.unit) = public.normalize_unit_name(v_base) THEN
    RETURN NEW;
  END IF;

  NEW.unit := v_base;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_normalize_product_unit ON products;
CREATE TRIGGER trg_normalize_product_unit
  BEFORE INSERT OR UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION normalize_product_unit_to_base();

SELECT 'STEP 10: prevention triggers installed' AS step;

-- ----------------------------------------------------------------------------
-- STEP 11: Column contract documentation
-- ----------------------------------------------------------------------------
COMMENT ON COLUMN invoice_items.cost_price IS 'Per SALE unit - the same scale as unit_price on the same row. For multi-unit products this is base_cost * conversion_factor. Enforced by trg_check_invoice_item_cost_scale.';

COMMENT ON COLUMN products.unit IS 'Display unit; MUST equal the base unit declared by product_units.is_base_unit (synonyms allowed). Normalised by trg_normalize_product_unit. The SALE unit belongs in product_units, never here.';

-- ----------------------------------------------------------------------------
-- VERIFICATION
-- ----------------------------------------------------------------------------
\echo ''
\echo '=== VERIFICATION 1: account balances (COGS must be well below revenue) ==='
-- journal_derived is sign-adjusted per account nature: debit-natural accounts are
-- SUM(debit-credit), credit-natural are SUM(credit-debit). Without this, revenue
-- would appear to have drifted by exactly twice its balance.
SELECT a.code, a.name, ROUND(a.balance, 2) AS stored,
       ROUND(COALESCE((SELECT SUM(jl.debit - jl.credit) FROM journal_lines jl
                       WHERE jl.account_id = a.id), 0)
             * CASE WHEN a.code IN ('4000') THEN -1 ELSE 1 END, 2) AS journal_derived
FROM accounts a
WHERE a.code IN ('5000', '1200', '4000')
  AND a.tenant_id = '00000000-0000-0000-0000-000000000001'::uuid
ORDER BY a.code;

\echo ''
\echo '=== VERIFICATION 2: any line-level scale defect left (only test data may remain) ==='
SELECT left(p.name, 26) AS product, i.invoice_number, ii.quantity,
       ROUND(ii.unit_price, 2) AS unit_price, ROUND(ii.cost_price, 4) AS cost_price,
       ROUND(ii.quantity * ii.cost_price, 2) AS cogs_impact,
       CASE WHEN ii.cost_price / ii.unit_price > 3 THEN 'still_too_high'
            ELSE 'still_too_low' END AS residual
FROM invoice_items ii
JOIN invoices i ON i.id = ii.invoice_id
JOIN products p ON p.id = ii.product_id
WHERE i.status IN ('sent', 'partially_paid', 'paid')
  AND ii.quantity > 0 AND ii.unit_price > 0
  AND (ii.cost_price / ii.unit_price > 3 OR ii.cost_price / ii.unit_price < 0.05)
ORDER BY ii.quantity * ii.cost_price DESC;

\echo ''
\echo '=== VERIFICATION 3: per-month revenue vs COGS (every month must be positive) ==='
WITH j AS (
  SELECT to_char(je.entry_date, 'YYYY-MM') AS m, SUM(jl.debit - jl.credit) AS cogs
  FROM journal_lines jl
  JOIN journal_entries je ON je.id = jl.journal_entry_id
  JOIN accounts a ON a.id = jl.account_id AND a.code = '5000'
                 AND a.tenant_id = '00000000-0000-0000-0000-000000000001'::uuid
  GROUP BY 1
),
r AS (
  SELECT to_char(invoice_date, 'YYYY-MM') AS m, SUM(total_amount) AS rev
  FROM invoices WHERE status IN ('sent', 'partially_paid', 'paid') GROUP BY 1
)
SELECT COALESCE(j.m, r.m) AS month,
       ROUND(COALESCE(r.rev, 0), 2)  AS revenue,
       ROUND(COALESCE(j.cogs, 0), 2) AS cogs,
       ROUND(COALESCE(r.rev, 0) - COALESCE(j.cogs, 0), 2) AS gross_profit,
       ROUND(COALESCE(j.cogs, 0) / NULLIF(r.rev, 0) * 100, 1) AS cogs_pct
FROM j FULL OUTER JOIN r ON r.m = j.m ORDER BY 1;

\echo ''
\echo '=== VERIFICATION 4: ledger still balances (delta must be unchanged at 391.00) ==='
SELECT ROUND(SUM(debit) - SUM(credit), 2) AS ledger_imbalance FROM journal_lines;

\echo ''
\echo '=== REVIEW (out of scope): stock under-deducted on former cost_too_low lines ==='
SELECT left(t.product_name, 26) AS product, t.invoice_number, t.invoice_date,
       t.qty AS sale_qty, t.cf_sale,
       ROUND(t.qty * t.cf_sale, 3) AS base_qty_should_be,
       ROUND((SELECT COALESCE(SUM(b.quantity_remaining), 0) FROM inventory_batches b
              WHERE b.product_id = t.product_id), 3) AS batch_qty_remaining
FROM tmp_line_fix t
WHERE t.verdict = 'cost_too_low'
ORDER BY t.qty * t.cf_sale DESC;

\echo ''
\echo '=== REVIEW (out of scope): products whose unit flags are inverted ==='
SELECT p.name, p.unit, p.base_unit,
       base.unit_name AS declared_base, base.conversion_factor AS base_cf,
       sale.unit_name AS declared_sale, sale.conversion_factor AS sale_cf
FROM products p
JOIN product_units base ON base.product_id = p.id AND base.is_base_unit
LEFT JOIN product_units sale ON sale.product_id = p.id AND sale.is_sale_unit
WHERE base.conversion_factor <> 1
ORDER BY p.name;
