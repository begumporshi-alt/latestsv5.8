-- Phase 3 — account 1026 Al-arafah islami bank reconciliation
--
-- Executed 2026-10-31. See docs/BANK-1026-PHASE3-RECONCILIATION.md for the
-- analysis this script implements.
--
-- Owner decisions taken before running:
--   A. Reverse the Tier 1 duplicates .................. YES
--   B. Reverse the Tier 2 overpayments (৳42,473.92) ... NO — parked pending a
--      supplier confirmation. POPAY-000129 and POPAY-000102 are deliberately
--      left untouched.
--   C. Handle the remaining shortfall ................. reclassify from cash
--
-- Net effect:
--   cash 1001 : 2,814,063.71 -> 2,096,537.31   (-717,526.40)
--   bank 1026 :  -796,504.38 ->   -42,473.92   (+754,030.46)
--
-- The bank is left at exactly -42,473.92, which is the sum of the two parked
-- Tier 2 overpayments. Both ways that item can resolve then land on zero:
--   * if they were keying errors -> reverse them -> 1026 = 0
--   * if they were real overpayments -> reclassify a further 42,473.92 -> 1026 = 0
-- Nothing has to be reversed back out either way.
--
-- Safe to re-run: reverse_supplier_payment refuses an already-reversed payment,
-- so a second execution fails loudly instead of double-posting.

BEGIN;

DO $$
DECLARE
  v_cash uuid;
  v_bank uuid;
  v_res  json;
BEGIN
  SELECT id INTO v_cash FROM accounts WHERE code = '1001';
  SELECT id INTO v_bank FROM accounts WHERE code = '1026';

  IF v_cash IS NULL OR v_bank IS NULL THEN
    RAISE EXCEPTION 'Cash in Hand (1001) or Al-arafah (1026) not found';
  END IF;

  RAISE NOTICE 'BEFORE  cash=%  bank=%',
    (SELECT balance FROM accounts WHERE code = '1001'),
    (SELECT balance FROM accounts WHERE code = '1026');

  -- 1. PO-000133 paid twice: POPAY-000093 from cash, POPAY-000094 from 1026.
  v_res := public.reverse_supplier_payment(
    (SELECT id FROM payments WHERE payment_number = 'POPAY-000094'),
    'duplicate of POPAY-000093 — same PO paid twice on 2026-10-01, once from cash');
  RAISE NOTICE '1/4 %', v_res::text;

  -- 2. PO-000144 rounding double-post (POPAY-000091 / POPAY-000092, ৳0.06 each).
  v_res := public.reverse_supplier_payment(
    (SELECT id FROM payments WHERE payment_number = 'POPAY-000092'),
    'duplicate of POPAY-000091 — PO-000144 rounding double-post');
  RAISE NOTICE '2/4 %', v_res::text;

  -- 3. PO-000014 paid twice from cash (POPAY-000009 / POPAY-000010, ৳5,865 each).
  v_res := public.reverse_supplier_payment(
    (SELECT id FROM payments WHERE payment_number = 'POPAY-000010'),
    'duplicate of POPAY-000009 — PO-000014 paid twice from cash on 2026-08-03');
  RAISE NOTICE '3/4 %', v_res::text;

  -- 4. Reclassify the remaining shortfall as cash-funded. This is the amount
  --    left after the three reversals above, NOT the full -796,504.38.
  v_res := public.record_fund_transfer(
    v_cash, v_bank, 723391.40, CURRENT_DATE,
    'Reclassification: supplier payments recorded against 1026 were funded from cash (phase 3)');
  RAISE NOTICE '4/4 %', v_res::text;

  RAISE NOTICE 'AFTER   cash=%  bank=%',
    (SELECT balance FROM accounts WHERE code = '1001'),
    (SELECT balance FROM accounts WHERE code = '1026');
END $$;

COMMIT;
