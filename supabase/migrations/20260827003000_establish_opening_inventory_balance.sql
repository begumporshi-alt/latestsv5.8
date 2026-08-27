-- ============================================================================
-- Establish the opening Inventory (1200) balance that was never posted to the GL.
--
-- CONTEXT
--   The FIFO opening backfill created inventory_batches rows of
--   batch_type='opening' (earliest 2026-06-01) representing stock on hand at
--   go-live. Those batches are the SUBSIDIARY LEDGER for account 1200. But no
--   journal entry ever debited 1200 for that opening value. As sales posted COGS
--   (crediting 1200), the account drifted negative:
--       account 1200 balance = 0 opening + purchases - COGS < 0
--   A negative inventory asset is impossible and makes every balance sheet wrong.
--
-- THE FIX
--   Post ONE opening-balance entry so the GL control account ties to its
--   subsidiary ledger (the batch table):
--       Dr 1200 Inventory Asset        <amount>
--       Cr 3900 Opening Balance Equity <amount>
--   where <amount> = (net value of inventory on hand per the batch ledger)
--                    - (current 1200 balance).
--
--   The amount is computed LIVE at apply time, not hardcoded, so it stays correct
--   if activity occurs between authoring and apply: any correctly-posted sale
--   reduces BOTH the batch value and the 1200 balance by the same COGS, leaving
--   the "missing opening debit" invariant. A structural guard aborts the
--   migration if the direction is wrong, rather than posting a garbage figure.
--
-- BALANCE CONVENTION (verified)
--   accounts.balance is natural-sign by type and is NOT trigger-maintained:
--     assets  -> SUM(debit - credit)      (1200 stored == debit-credit)
--     equity  -> SUM(credit - debit)      (3900 stored == credit-debit)
--   So this migration updates accounts.balance for BOTH lines explicitly, in the
--   same transaction as the journal rows. For a debit to an asset and a credit to
--   equity, both balances increase by <amount>.
--
-- NOT IN SCOPE (deliberate)
--   Any negative-quantity batches are a stock-QUANTITY accuracy problem, not a
--   valuation one. They remain visible in the subsidiary ledger to be trued up by
--   physical count later; they are NOT buried in this equity entry. The net batch
--   value (which already includes them) is used, so the control account ties to
--   the subsidiary ledger exactly as it stands today.
--
-- SAFETY
--   * Idempotent: if entry_number 'OPENING-INV-1200' already exists, does nothing.
--   * Structural guard: the computed amount must be positive (1200 understated).
--   * Self-verifies: 1200 must tie to the net batch value and debits==credits.
-- ============================================================================

DO $$
DECLARE
  v_tenant        uuid;
  v_acct_1200     uuid;
  v_acct_3900     uuid;
  v_current_1200  numeric;
  v_batch_value   numeric;
  v_amount        numeric;
  v_entry_id      uuid;
  v_entry_number  text := 'OPENING-INV-1200';
  v_entry_date    date := DATE '2026-06-01';
BEGIN
  -- Idempotency guard: never double-post.
  IF EXISTS (SELECT 1 FROM journal_entries WHERE entry_number = v_entry_number) THEN
    RAISE NOTICE 'Entry % already exists - skipping (idempotent no-op).', v_entry_number;
    RETURN;
  END IF;

  SELECT id, tenant_id INTO v_acct_1200, v_tenant FROM accounts WHERE code = '1200';
  SELECT id            INTO v_acct_3900          FROM accounts WHERE code = '3900';
  IF v_acct_1200 IS NULL OR v_acct_3900 IS NULL THEN
    RAISE EXCEPTION 'Missing account: 1200=% 3900=%', v_acct_1200, v_acct_3900;
  END IF;

  SELECT balance INTO v_current_1200 FROM accounts WHERE id = v_acct_1200;

  -- Net inventory value per the subsidiary ledger (includes the negative-qty
  -- batches, so the control account ties to the batch table exactly).
  SELECT COALESCE(SUM(quantity_remaining * unit_cost), 0)
    INTO v_batch_value
    FROM inventory_batches
   WHERE tenant_id = v_tenant;

  v_amount := ROUND(v_batch_value - v_current_1200, 2);

  RAISE NOTICE 'Batch-ledger value = %, current 1200 = %, opening debit needed = %',
    ROUND(v_batch_value,2), ROUND(v_current_1200,2), v_amount;

  -- Structural guard: abort rather than post a wrong-direction or meaningless
  -- figure. Deliberately magnitude-free so this migration carries no live
  -- financial data. The real correctness proof is V1 below: after posting, 1200
  -- must tie to the batch ledger with zero drift.
  IF v_batch_value <= 0 THEN
    RAISE EXCEPTION 'Batch-ledger value is not positive (%); there is no opening inventory to establish. Aborting for manual review.', v_batch_value;
  END IF;

  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'Computed opening amount is not positive (%); account 1200 is not understated as expected, so this migration does not apply. Aborting for manual review.', v_amount;
  END IF;

  -- Header
  INSERT INTO journal_entries
    (id, tenant_id, entry_number, entry_date, description, reference_type,
     total_debit, total_credit, is_posted, created_at)
  VALUES
    (gen_random_uuid(), v_tenant, v_entry_number, v_entry_date,
     'Opening Balance - Inventory Asset (1200): establish opening inventory backfilled without a GL debit',
     'opening_balance', v_amount, v_amount, true, now())
  RETURNING id INTO v_entry_id;

  -- Lines: Dr 1200 / Cr 3900
  INSERT INTO journal_lines (id, journal_entry_id, account_id, description, debit, credit, sort_order)
  VALUES
    (gen_random_uuid(), v_entry_id, v_acct_1200, 'Opening inventory on hand (ties to batch ledger)', v_amount, 0, 1),
    (gen_random_uuid(), v_entry_id, v_acct_3900, 'Opening balance equity offset',                      0, v_amount, 2);

  -- Maintain accounts.balance (no trigger does this). Asset +debit, equity +credit.
  UPDATE accounts SET balance = balance + v_amount WHERE id = v_acct_1200;  -- asset: debit-credit
  UPDATE accounts SET balance = balance + v_amount WHERE id = v_acct_3900;  -- equity: credit-debit

  RAISE NOTICE 'Posted % : Dr 1200 % / Cr 3900 %', v_entry_number, v_amount, v_amount;
END $$;

-- ----------------------------------------------------------------------------
-- VERIFICATION
-- ----------------------------------------------------------------------------
\echo ''
\echo '=== V1. 1200 now ties to the net batch-ledger value (drift must be 0) ==='
SELECT ROUND(a.balance,2) AS acct_1200_balance,
       ROUND((SELECT SUM(quantity_remaining*unit_cost) FROM inventory_batches b WHERE b.tenant_id=a.tenant_id),2) AS batch_ledger_value,
       ROUND(a.balance - (SELECT SUM(quantity_remaining*unit_cost) FROM inventory_batches b WHERE b.tenant_id=a.tenant_id),2) AS drift
FROM accounts a WHERE a.code='1200';

\echo ''
\echo '=== V2. The opening entry balances (debit == credit) ==='
SELECT je.entry_number, je.entry_date, ROUND(je.total_debit,2) AS dr, ROUND(je.total_credit,2) AS cr,
       ROUND((SELECT SUM(debit) FROM journal_lines WHERE journal_entry_id=je.id),2) AS lines_dr,
       ROUND((SELECT SUM(credit) FROM journal_lines WHERE journal_entry_id=je.id),2) AS lines_cr
FROM journal_entries je WHERE je.entry_number='OPENING-INV-1200';

\echo ''
\echo '=== V3. Stored balances still tie to the posted ledger (assets d-c, equity c-d) ==='
SELECT a.code, a.name, a.account_type, ROUND(a.balance,2) AS stored,
       ROUND(CASE WHEN a.account_type IN ('asset','expense')
                  THEN COALESCE(SUM(jl.debit-jl.credit),0)
                  ELSE COALESCE(SUM(jl.credit-jl.debit),0) END,2) AS computed
FROM accounts a
LEFT JOIN journal_lines jl ON jl.account_id=a.id
LEFT JOIN journal_entries je ON je.id=jl.journal_entry_id AND je.is_posted=true
WHERE a.code IN ('1200','3900')
GROUP BY a.code,a.name,a.account_type,a.balance ORDER BY a.code;
