-- 2026-09-07 (stock corrections out of the P&L — part 1 of 2)
--
-- Move ALL account-5900 (Inventory Adjustment, expense) activity from the
-- Aug 28 - Sep 6 inventory-cleanup week into Opening Balance Equity (3900),
-- attributed per-date, so no month's P&L sees it.
--
-- BACKGROUND
--   The cleanup week booked Tk 10,928,720.27 of stock-increase adjustment
--   credits and ~Tk 36.6L of reduction debits to 5900. These were quantity
--   corrections (mistaken increases/decreases during the cable/meter
--   migration), not income or expenses. Sitting in 5900 they made August's
--   P&L ~Tk 94.45L too profitable, and after the balance-sheet batch
--   (20260907120000) zeroed the account with a single Tk 7,268,841.85
--   reclass JE dated 2026-09-06, September's P&L absorbed the entire
--   historical amount as an expense (showing a Tk 93.34L net loss).
--
-- THE FIX (owner decision 2026-09-07: quantity corrections are not P&L items)
--   1. Reverse the lump reclass JE on its own date (the pair nets to zero
--      within September).
--   2. For each date with 5900 activity, post one offsetting JE mirroring
--      that date's net movement between 5900 and 3900 — net-credit days get
--      Dr 5900 / Cr 3900, net-debit days get Cr 5900 / Dr 3900. Every
--      date's 5900 then nets to exactly zero.
--   3. Audit-log the operation (each JE insert is also auto-logged by the
--      journal_entries audit trigger).
--
--   Account balances are unchanged (the lump reclass already moved the net
--   to 3900); only the per-date attribution between Current Earnings and
--   Opening Balance Equity changes. Expected results:
--     August 2026 net profit:    Tk 9,697,900.86 -> Tk 253,106.86
--     September 2026 net profit: Tk -9,334,049.78 -> Tk 110,744.22
--
--   Part 2 (20260907160000) reroutes future adjustments to 3900, so 5900
--   has no writers after this point (legacy account, kept for history).

DO $$
DECLARE
  v_5900 uuid;
  v_3900 uuid;
  v_reclass_id uuid;
  v_reclass_date date;
  v_reclass_amount numeric;
  v_reversal_id uuid;
  v_day record;
  v_net numeric;
  v_sum numeric;
  v_details jsonb := '[]'::jsonb;
BEGIN
  SELECT id INTO v_5900 FROM accounts WHERE code = '5900' LIMIT 1;
  SELECT id INTO v_3900 FROM accounts WHERE code = '3900' LIMIT 1;
  IF v_5900 IS NULL OR v_3900 IS NULL THEN
    RAISE NOTICE 'reclass skipped: accounts 5900/3900 missing';
    RETURN;
  END IF;

  -- Already applied? (idempotency marker)
  IF EXISTS (SELECT 1 FROM journal_entries
             WHERE reference_type = 'balance_adjustment'
               AND description LIKE 'Stock correction reclass 5900/3900 (per-date)%') THEN
    RAISE NOTICE 'per-date stock-correction reclass already applied';
    RETURN;
  END IF;

  -- Locate the lump reclass JE from the balance-sheet batch and its amount
  -- (from its 5900 debit line; journal_entries has no amount column).
  SELECT je.id, je.entry_date, jl.debit
    INTO v_reclass_id, v_reclass_date, v_reclass_amount
    FROM journal_entries je
    JOIN journal_lines jl ON jl.journal_entry_id = je.id
                         AND jl.account_id = v_5900
                         AND jl.debit > 0
   WHERE je.description LIKE 'Inventory Adjustment reclass to Opening Balance Equity%'
   ORDER BY je.entry_date
   LIMIT 1;

  -- 1. Reverse the lump reclass on its own date
  IF v_reclass_id IS NOT NULL THEN
    SELECT post_journal_entry(
      'REVERSAL - Inventory Adjustment reclass (superseded by per-date stock-correction reclass)',
      v_reclass_date,
      'balance_adjustment',
      v_reclass_id,
      json_build_array(
        json_build_object('account_id', v_3900, 'debit', v_reclass_amount, 'credit', 0,
          'description', 'Reverse the lump reclass; superseded by per-date offsets'),
        json_build_object('account_id', v_5900, 'debit', 0, 'credit', v_reclass_amount,
          'description', 'Reverse the lump reclass; superseded by per-date offsets')
      )::json,
      NULL,
      NULL
    ) INTO v_reversal_id;
    RAISE NOTICE 'reversal % posted for lump reclass % (Tk %), dated %',
      v_reversal_id, v_reclass_id, v_reclass_amount, v_reclass_date;
  ELSE
    RAISE NOTICE 'no lump reclass JE found; posting per-date offsets only';
  END IF;

  -- 2. Per-date offsets: mirror each date's net 5900 movement into 3900.
  --    Excludes the original lump reclass, the reversal above, and any prior
  --    per-date markers (idempotency).
  FOR v_day IN
    SELECT je.entry_date AS d, SUM(jl.credit - jl.debit) AS net_credit
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.journal_entry_id
                             AND je.is_posted = true
     WHERE jl.account_id = v_5900
       AND je.description NOT LIKE 'Inventory Adjustment reclass to Opening Balance Equity%'
       AND je.description NOT LIKE 'REVERSAL - Inventory Adjustment reclass%'
       AND je.description NOT LIKE 'Stock correction reclass 5900/3900 (per-date)%'
     GROUP BY je.entry_date
     ORDER BY je.entry_date
  LOOP
    v_net := v_day.net_credit;
    CONTINUE WHEN v_net = 0;

    IF v_net > 0 THEN
      -- Net stock-increase day: move the credit out of the P&L into equity
      PERFORM post_journal_entry(
        'Stock correction reclass 5900/3900 (per-date) - ' || v_day.d,
        v_day.d,
        'balance_adjustment',
        NULL,
        json_build_array(
          json_build_object('account_id', v_5900, 'debit', v_net, 'credit', 0,
            'description', 'Move this date''s stock-correction credits out of the P&L (quantity correction, not income)'),
          json_build_object('account_id', v_3900, 'debit', 0, 'credit', v_net,
            'description', 'Opening Balance Equity: stock corrections dated ' || v_day.d)
        )::json,
        NULL,
        NULL
      );
    ELSE
      -- Net reduction day: move the debit out of the P&L into equity
      PERFORM post_journal_entry(
        'Stock correction reclass 5900/3900 (per-date) - ' || v_day.d,
        v_day.d,
        'balance_adjustment',
        NULL,
        json_build_array(
          json_build_object('account_id', v_3900, 'debit', -v_net, 'credit', 0,
            'description', 'Opening Balance Equity: stock corrections dated ' || v_day.d),
          json_build_object('account_id', v_5900, 'debit', 0, 'credit', -v_net,
            'description', 'Move this date''s stock-correction reductions out of the P&L (quantity correction, not expense)')
        )::json,
        NULL,
        NULL
      );
    END IF;

    v_details := v_details || jsonb_build_object('date', v_day.d, 'net_credit', v_net);
    RAISE NOTICE 'offset posted for %: net credit Tk %', v_day.d, v_net;
  END LOOP;

  -- 3. Sanity: account 5900 must net to zero across all posted lines now
  SELECT COALESCE(SUM(jl.credit - jl.debit), 0) INTO v_sum
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
                           AND je.is_posted = true
   WHERE jl.account_id = v_5900;
  IF ABS(v_sum) > 0.01 THEN
    RAISE EXCEPTION 'account 5900 does not net to zero after reclass (Tk %)', v_sum;
  END IF;

  -- 4. Audit log
  INSERT INTO activity_logs (action, entity_type, entity_id, entity_label, metadata)
  VALUES (
    'stock_correction_reclass',
    'journal_entry',
    COALESCE(v_reversal_id, v_5900),
    'Per-date stock-correction reclass 5900 -> 3900',
    jsonb_build_object(
      'reversal_of', v_reclass_id,
      'reversal_entry', v_reversal_id,
      'per_date', v_details,
      'reason', 'Aug 28 - Sep 6 inventory-cleanup quantity corrections were sitting in P&L account 5900 (Inventory Adjustment); moved to Opening Balance Equity (3900) per-date so monthly P&Ls show real trading. Owner decision 2026-09-07.',
      'applied_at', now()
    )
  );

  RAISE NOTICE 'per-date stock-correction reclass complete: % dates, account 5900 nets to zero',
    jsonb_array_length(v_details);
END $$;
