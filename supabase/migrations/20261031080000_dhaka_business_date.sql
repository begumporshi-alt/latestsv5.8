-- Stop stamping entries with yesterday's date for anything posted between
-- 00:00 and 05:59 Asia/Dhaka.
--
-- Postgres runs in UTC. `CURRENT_DATE` therefore resolves to the UTC date,
-- which is the previous calendar day for the first six hours of a Dhaka day.
-- The four Phase 3 entries (JE-969291..969294) were posted at 04:36 Dhaka on
-- 31 Oct and were stamped 2026-10-30 because of this.
--
-- Fix: resolve the business date in Asia/Dhaka instead of relying on the
-- server's UTC clock. Applied to the two functions that produced the bad
-- dates — record_fund_transfer (which also backs the /accounting/transfers
-- page and the transfer.create offline op) and reverse_supplier_payment.
--
-- Deliberately NOT changed here: pay_supplier_outstanding, collect_customer_payment
-- and the other payment RPCs. Their callers always pass an explicit date from
-- the form, so the default rarely applies; changing them is a wider decision
-- and belongs with a review of every date entry point.

BEGIN;

-- 1. record_fund_transfer -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_fund_transfer(
  p_from_account_id uuid,
  p_to_account_id uuid,
  p_amount numeric,
  p_transfer_date date DEFAULT ((now() AT TIME ZONE 'Asia/Dhaka'))::date,
  p_notes text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_from record;
  v_to record;
  v_description text;
  v_entry_id uuid;
  v_entry_number text;
  v_from_balance numeric;
  v_to_balance numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Transfer amount must be greater than zero';
  END IF;
  IF p_from_account_id IS NULL OR p_to_account_id IS NULL THEN
    RAISE EXCEPTION 'Source and destination accounts are required';
  END IF;
  IF p_from_account_id = p_to_account_id THEN
    RAISE EXCEPTION 'Source and destination accounts must be different';
  END IF;

  SELECT * INTO v_from FROM accounts WHERE id = p_from_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Source account % not found', p_from_account_id;
  END IF;
  SELECT * INTO v_to FROM accounts WHERE id = p_to_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Destination account % not found', p_to_account_id;
  END IF;

  IF NOT v_from.is_active OR NOT v_to.is_active THEN
    RAISE EXCEPTION 'Both accounts must be active';
  END IF;
  IF v_from.account_type <> 'asset' OR NOT (COALESCE(v_from.is_cash, false) OR COALESCE(v_from.is_bank, false)) THEN
    RAISE EXCEPTION 'Source must be a cash or bank account (% %)', v_from.code, v_from.name;
  END IF;
  IF v_to.account_type <> 'asset' OR NOT (COALESCE(v_to.is_cash, false) OR COALESCE(v_to.is_bank, false)) THEN
    RAISE EXCEPTION 'Destination must be a cash or bank account (% %)', v_to.code, v_to.name;
  END IF;

  -- A transfer can never drive the source account negative.
  IF COALESCE(v_from.balance, 0) < p_amount THEN
    RAISE EXCEPTION 'Insufficient balance in % %: available %, tried to move %',
      v_from.code, v_from.name, COALESCE(v_from.balance, 0), p_amount;
  END IF;

  IF COALESCE(v_from.is_bank, false) AND COALESCE(v_to.is_cash, false) THEN
    v_description := 'Bank Withdrawal';
  ELSIF COALESCE(v_from.is_cash, false) AND COALESCE(v_to.is_bank, false) THEN
    v_description := 'Bank Deposit';
  ELSE
    v_description := 'Fund Transfer';
  END IF;
  v_description := v_description || ': ' || v_from.code || ' ' || v_from.name
    || ' → ' || v_to.code || ' ' || v_to.name;
  IF NULLIF(TRIM(COALESCE(p_notes, '')), '') IS NOT NULL THEN
    v_description := v_description || ' — ' || TRIM(p_notes);
  END IF;

  v_entry_id := public.post_journal_entry(
    v_description,
    COALESCE(p_transfer_date, (now() AT TIME ZONE 'Asia/Dhaka')::date),
    'transfer',
    NULL,
    json_build_array(
      json_build_object('account_id', p_to_account_id, 'debit', p_amount, 'credit', 0, 'description', v_description),
      json_build_object('account_id', p_from_account_id, 'debit', 0, 'credit', p_amount, 'description', v_description)
    ),
    NULL,
    NULL
  );

  SELECT entry_number INTO v_entry_number FROM journal_entries WHERE id = v_entry_id;
  SELECT balance INTO v_from_balance FROM accounts WHERE id = p_from_account_id;
  SELECT balance INTO v_to_balance FROM accounts WHERE id = p_to_account_id;

  RETURN json_build_object(
    'id', v_entry_id,
    'entry_number', v_entry_number,
    'from_balance', v_from_balance,
    'to_balance', v_to_balance
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_fund_transfer(uuid, uuid, numeric, date, text) TO authenticated;

-- 2. reverse_supplier_payment — reversal date in Dhaka ------------------------
CREATE OR REPLACE FUNCTION public.reverse_supplier_payment(
  p_payment_id uuid,
  p_reason     text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_payment   record;
  v_je        record;
  v_lines     json;
  v_entry_id  uuid;
  v_count     int := 0;
  v_reason    text;
  v_today     date := (now() AT TIME ZONE 'Asia/Dhaka')::date;
BEGIN
  IF p_payment_id IS NULL THEN
    RAISE EXCEPTION 'Payment id is required';
  END IF;

  v_reason := NULLIF(TRIM(COALESCE(p_reason, '')), '');
  IF v_reason IS NULL OR length(v_reason) < 5 THEN
    RAISE EXCEPTION 'A reversal reason of at least 5 characters is required';
  END IF;

  SELECT * INTO v_payment FROM payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment % not found', p_payment_id;
  END IF;

  IF v_payment.payment_type <> 'made' THEN
    RAISE EXCEPTION 'Only supplier payments (payment_type = made) can be reversed here; % is %',
      v_payment.payment_number, v_payment.payment_type;
  END IF;

  IF v_payment.is_reversed THEN
    RAISE EXCEPTION 'Payment % is already reversed', v_payment.payment_number;
  END IF;

  IF EXISTS (
    SELECT 1 FROM journal_entries
     WHERE reference_type = 'payment_reversal' AND reference_id = p_payment_id
  ) THEN
    RAISE EXCEPTION 'A reversal entry already exists for payment %', v_payment.payment_number;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM journal_entries
     WHERE reference_type = 'payment' AND reference_id = p_payment_id
  ) THEN
    RAISE EXCEPTION 'Payment % has no journal entry to reverse', v_payment.payment_number;
  END IF;

  FOR v_je IN
    SELECT id
      FROM journal_entries
     WHERE reference_type = 'payment' AND reference_id = p_payment_id
     ORDER BY created_at, id
  LOOP
    SELECT json_agg(
             json_build_object(
               'account_id',  jl.account_id,
               'debit',       jl.credit,
               'credit',      jl.debit,
               'description', 'Reversal: ' || COALESCE(jl.description, '')
             )
           )
      INTO v_lines
      FROM journal_lines jl
     WHERE jl.journal_entry_id = v_je.id
       AND (jl.debit <> 0 OR jl.credit <> 0);

    CONTINUE WHEN v_lines IS NULL;

    v_entry_id := public.post_journal_entry(
      'Reversal of ' || COALESCE(v_payment.payment_number, 'payment') || ' — ' || v_reason,
      v_today,
      'payment_reversal',
      p_payment_id,
      v_lines,
      NULL,
      v_payment.supplier_id
    );

    v_count := v_count + 1;
  END LOOP;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'Nothing was reversed for payment %', v_payment.payment_number;
  END IF;

  UPDATE payments
     SET is_reversed = true,
         updated_at  = now()
   WHERE id = p_payment_id;

  RETURN json_build_object(
    'payment_number',   v_payment.payment_number,
    'reversed_entries', v_count,
    'amount',           v_payment.amount,
    'reason',           v_reason
  );
END;
$$;

DO $$
BEGIN
  RAISE NOTICE 'dhaka_business_date: applied — record_fund_transfer + reverse_supplier_payment now resolve the date in Asia/Dhaka';
END $$;

COMMIT;
