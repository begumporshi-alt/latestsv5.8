-- 2026-09-01: Book the FIFO-cutover baseline divergence as a one-time adjustment (owner decision).
--
-- Context: the 2026-06-01 opening journal entry (OPENING-INV-1200, Dr 1200 / Cr 3900,
-- 19,239,266.48) was valued above the opening layers that were actually reconstructed
-- into inventory_batches at the 2026-08-08 FIFO cutover. After all subsequent repairs
-- every inflow family ties to its batches, but GL 1200 still carried the residual
-- divergence above SUM(inventory_batches.quantity_remaining * unit_cost).
--
-- Decision (2026-09-01): book the exact live gap as a one-time, balance-sheet-only
-- adjustment — Dr 3900 Opening Balance Equity / Cr 1200 Inventory Asset, dated at the
-- FIFO cutover — so account 1200 ties penny-for-penny to the batch ledger, which is
-- its subsidiary ledger. No P&L account is touched (COGS/margins unaffected).
--
-- The gap is COMPUTED LIVE at apply time (never hardcoded) and includes the negative
-- ADJ-/REDUCE- layers, because the GL has tracked those IOUs symmetrically (their COGS
-- was credited to 1200 when the layers were created).
--
-- Safety: idempotent (skips if already booked), guarded (aborts on non-positive gap),
-- post-condition verified (1200 == batch ledger, caches == lines), audited.

BEGIN;

CREATE TABLE IF NOT EXISTS cutover_baseline_adjustment_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gl_1200_balance_before numeric(15,2) NOT NULL,
  batch_ledger_value numeric(15,2) NOT NULL,
  gap_adjusted numeric(15,2) NOT NULL,
  journal_entry_id uuid,
  journal_entry_number text,
  created_by text NOT NULL DEFAULT 'migration_20260901120000',
  created_at timestamptz NOT NULL DEFAULT now(),
  notes text
);

DO $$
DECLARE
  v_inv uuid;
  v_obe uuid;
  v_gl_before numeric(15,2);
  v_batch_value numeric(15,2);
  v_gap numeric(15,2);
  v_je_id uuid;
  v_je_number text;
  v_gl_after numeric(15,2);
  v_cache_1200 numeric(15,2);
  v_cache_3900 numeric(15,2);
  v_lines_3900 numeric(15,2);
BEGIN
  -- Idempotency: never book twice.
  IF EXISTS (SELECT 1 FROM journal_entries WHERE reference_type = 'cutover_adjustment' LIMIT 1)
     OR EXISTS (SELECT 1 FROM cutover_baseline_adjustment_audit WHERE journal_entry_id IS NOT NULL LIMIT 1) THEN
    RAISE NOTICE 'FIFO cutover baseline adjustment already booked — skipping.';
    RETURN;
  END IF;

  SELECT id INTO v_inv FROM accounts WHERE code = '1200' LIMIT 1;
  SELECT id INTO v_obe FROM accounts WHERE code = '3900' LIMIT 1;
  IF v_inv IS NULL OR v_obe IS NULL THEN
    RAISE EXCEPTION 'Required accounts 1200 / 3900 not found.';
  END IF;

  -- Live gap: GL 1200 (from journal lines) minus the full batch ledger value.
  SELECT COALESCE(SUM(COALESCE(jl.debit, 0) - COALESCE(jl.credit, 0)), 0)::numeric(15,2)
    INTO v_gl_before
  FROM journal_lines jl
  WHERE jl.account_id = v_inv;

  SELECT COALESCE(SUM(quantity_remaining * unit_cost), 0)::numeric(15,2)
    INTO v_batch_value
  FROM inventory_batches;

  v_gap := ROUND(v_gl_before - v_batch_value, 2);

  IF v_gap <= 0 THEN
    RAISE EXCEPTION 'Expected GL 1200 above the batch ledger; got gap=% (gl=%, batches=%). Nothing to adjust — investigate before forcing.', v_gap, v_gl_before, v_batch_value;
  END IF;

  v_je_id := post_journal_entry(
    'FIFO cutover baseline adjustment — release ' || v_gap || ' from Inventory (1200) to Opening Balance Equity (3900) so 1200 ties to the batch ledger',
    '2026-08-08'::date,
    'cutover_adjustment',
    NULL,
    to_json(ARRAY[
      json_build_object('account_id', v_obe, 'debit', v_gap, 'credit', 0,
        'description', 'FIFO cutover baseline release — opening equity restated to reconstructed opening layers'),
      json_build_object('account_id', v_inv, 'debit', 0, 'credit', v_gap,
        'description', 'FIFO cutover baseline release — inventory restated to batch ledger value (' || v_batch_value || ')')
    ]),
    NULL,
    NULL
  );

  IF v_je_id IS NULL THEN
    RAISE EXCEPTION 'post_journal_entry returned NULL — adjustment not booked.';
  END IF;

  SELECT entry_number INTO v_je_number FROM journal_entries WHERE id = v_je_id;

  INSERT INTO cutover_baseline_adjustment_audit
    (gl_1200_balance_before, batch_ledger_value, gap_adjusted, journal_entry_id, journal_entry_number, notes)
  VALUES
    (v_gl_before, v_batch_value, v_gap, v_je_id, v_je_number,
     'Owner decision 2026-09-01: book the 2026-08-08 FIFO-cutover divergence (opening JE OPENING-INV-1200 19,239,266.48 vs reconstructed opening layers) as a one-time balance-sheet-only adjustment. No P&L accounts touched.');

  -- Post-condition 1: GL 1200 from lines must now equal the batch ledger exactly.
  SELECT COALESCE(SUM(COALESCE(jl.debit, 0) - COALESCE(jl.credit, 0)), 0)::numeric(15,2)
    INTO v_gl_after
  FROM journal_lines jl
  WHERE jl.account_id = v_inv;

  -- Post-condition 2/3: denormalized balances must equal the journal lines for both accounts.
  SELECT balance INTO v_cache_1200 FROM accounts WHERE id = v_inv;
  SELECT balance INTO v_cache_3900 FROM accounts WHERE id = v_obe;
  SELECT COALESCE(SUM(COALESCE(jl.credit, 0) - COALESCE(jl.debit, 0)), 0)::numeric(15,2)
    INTO v_lines_3900
  FROM journal_lines jl
  WHERE jl.account_id = v_obe;

  IF v_gl_after <> v_batch_value THEN
    RAISE EXCEPTION 'Post-condition failed: GL 1200 (%) does not equal batch ledger (%) after adjustment.', v_gl_after, v_batch_value;
  END IF;
  IF v_cache_1200 <> v_gl_after THEN
    RAISE EXCEPTION 'Post-condition failed: accounts.balance cache for 1200 (%) does not equal journal lines (%).', v_cache_1200, v_gl_after;
  END IF;
  IF v_cache_3900 <> v_lines_3900 THEN
    RAISE EXCEPTION 'Post-condition failed: accounts.balance cache for 3900 (%) does not equal journal lines (%).', v_cache_3900, v_lines_3900;
  END IF;

  RAISE NOTICE 'Booked FIFO cutover baseline adjustment: Cr 1200 / Dr 3900 by % (JE %). GL 1200 now equals the batch ledger at %.', v_gap, v_je_number, v_gl_after;
END $$;

COMMIT;
