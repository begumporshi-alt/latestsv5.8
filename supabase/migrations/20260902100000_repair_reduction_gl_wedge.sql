-- 2026-09-02: True-up the GL 1200 vs FIFO batch-ledger wedge left by the two
-- 2026-09-01 14:56 UTC stock reductions that ran under the pre-20260901200000
-- create_stock_reduction (journal at the operator-entered unit cost instead of
-- the actual FIFO layer value; the layer-accurate rewrite shipped later that
-- evening but did not repair the wedge already booked).
--
-- Attribution (residual method: per batch, received - remaining - invoice
-- consumption = the reduction's real layer decrement):
--   Main Warehouse, walton cable 1*1.0 re Green, 8,975 m:
--     layers consumed 7,725 m @ 25.05 + 1,250 m @ 25.04 = 224,811.25
--     JE 62ca9147 credited 8,975 x 25.04             = 224,734.00  -> GL over by 77.25
--   Showroom Store, same product, 1 m:
--     layer consumed 1 @ 23.02                       =      23.02
--     JE 243e3261 credited 1 x 25.04                 =      25.04  -> GL under by 2.02
--   Net GL overstatement = 77.25 - 2.02 = 75.23 (dashboard check 3 drift).
--
-- All other post-cutover families pair to the taka: adjustment debits =
-- adjustment batches (757,122.54), invoice COGS credits = FIFO consumption
-- (1,232,670.91), and the other three 2026-09-01 reductions (1"ms screw,
-- shower, walton 2 PAIR) consumed layers exactly equal to their JE credits.
--
-- The batch ledger is the physical truth, so GL 1200 comes DOWN by the net
-- 75.23 (Dr 5900 / Cr 1200, the stock_adjustment family's routing).

BEGIN;

CREATE TABLE IF NOT EXISTS reduction_gl_wedge_repair_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id uuid,
  wedge_repaired numeric NOT NULL,
  main_wh_component numeric NOT NULL,
  showroom_component numeric NOT NULL,
  repaired_at timestamptz NOT NULL DEFAULT now(),
  repaired_by text NOT NULL DEFAULT 'migration_20260902100000'
);

DO $$
DECLARE
  v_gl numeric;
  v_batches numeric;
  v_wedge numeric;
  v_residual numeric;
  v_je_id uuid;
  v_account_1200 uuid;
  v_account_5900 uuid;
BEGIN
  SELECT COALESCE(SUM(jl.debit - jl.credit), 0) INTO v_gl
    FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
   WHERE a.code = '1200';
  SELECT COALESCE(SUM(quantity_remaining * unit_cost), 0) INTO v_batches
    FROM inventory_batches;
  v_wedge := v_gl - v_batches;

  IF ABS(v_wedge) <= 0.01 THEN
    RAISE NOTICE 'reduction GL wedge repair: GL 1200 already equals the batch ledger; nothing to do';
    RETURN;
  END IF;

  IF ROUND(v_wedge, 2) <> 75.23 THEN
    RAISE EXCEPTION 'reduction GL wedge repair: current wedge is % (expected 75.23) -- composition changed; aborting for manual attribution', ROUND(v_wedge, 2);
  END IF;

  IF EXISTS (SELECT 1 FROM reduction_gl_wedge_repair_audit WHERE repaired_by = 'migration_20260902100000') THEN
    RAISE NOTICE 'reduction GL wedge repair: audit row exists; skipping';
    RETURN;
  END IF;

  SELECT id INTO v_account_1200 FROM accounts WHERE code = '1200' AND tenant_id = '00000000-0000-0000-0000-000000000001';
  SELECT id INTO v_account_5900 FROM accounts WHERE code = '5900' AND tenant_id = '00000000-0000-0000-0000-000000000001';
  IF v_account_1200 IS NULL OR v_account_5900 IS NULL THEN
    RAISE EXCEPTION 'reduction GL wedge repair: accounts 1200/5900 not found';
  END IF;

  SELECT post_journal_entry(
    p_description := 'Reduction GL true-up - walton cable 1*1.0 re Green (1*1.0 re-GRN): 2026-09-01 reductions journalized at entered cost 25.04/m instead of FIFO layer value. Main WH: layers 224,811.25 vs JE credit 224,734.00 (+77.25). Showroom: layer 23.02 vs JE credit 25.04 (-2.02). Net 75.23.',
    p_entry_date := '2026-09-01',
    p_reference_type := 'stock_adjustment',
    p_reference_id := '8587cbeb-4cbb-465a-b6c5-8b675c85977c',
    p_lines := json_build_array(
      json_build_object(
        'account_id', v_account_5900,
        'debit', 75.23,
        'credit', 0,
        'description', 'Reduction value true-up: FIFO layers consumed 75.23 net above the journalized reduction value (pre-layer-accurate create_stock_reduction)'
      ),
      json_build_object(
        'account_id', v_account_1200,
        'debit', 0,
        'credit', 75.23,
        'description', 'Inventory true-up: walton cable 1*1.0 re Green reductions consumed layers worth 75.23 net more than journalized'
      )
    )
  ) INTO v_je_id;

  INSERT INTO reduction_gl_wedge_repair_audit (journal_entry_id, wedge_repaired, main_wh_component, showroom_component)
  VALUES (v_je_id, 75.23, 77.25, -2.02);

  -- Post-condition: GL 1200 now equals the batch ledger within a cent
  SELECT COALESCE(SUM(jl.debit - jl.credit), 0) INTO v_gl
    FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
   WHERE a.code = '1200';
  SELECT COALESCE(SUM(quantity_remaining * unit_cost), 0) INTO v_batches
    FROM inventory_batches;
  v_residual := v_gl - v_batches;

  IF ABS(v_residual) > 0.01 THEN
    RAISE EXCEPTION 'reduction GL wedge repair: post-condition failed, residual %', v_residual;
  END IF;

  RAISE NOTICE 'reduction GL wedge repair: posted JE % (Dr 5900 / Cr 1200 75.23); residual %', v_je_id, ROUND(v_residual, 4);
END $$;

COMMIT;
