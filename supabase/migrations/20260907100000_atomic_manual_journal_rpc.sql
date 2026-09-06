-- Batch 1 of the 2026-09-06 accounting gap audit (P1-1):
-- One transactional server-side writer for every manual journal entry in the app.
-- Replaces five frontend write paths that maintained accounts.balance with
-- sequential client-side calls (journal page, expenses page, accounts page
-- opening balance, account-statement adjustment, dashboard modals).
--
-- Invariants enforced here:
--   * every create posts through the canonical poster post_journal_entry
--     (sole owner of the per-account-type balance sign convention)
--   * edit reverses the old lines with the same convention before applying new
--   * delete always reverses before deleting (never a bare DELETE)
--   * manual receivable/payable payments write payment row + JEs in ONE call
--   * auto-posted entries require an explicit p_allow_auto override to
--     edit/delete, so the UI confirmation becomes part of the protocol
--
-- Reference types handled by payment_accounting_trigger (received+invoice,
-- made+purchase_order) are deliberately NOT posted here; for
-- receivable/payable payments the trigger falls through and this RPC is the
-- only poster (verified: no double posting).

-- 1. CREATE — thin validated wrapper over the canonical poster.
CREATE OR REPLACE FUNCTION public.post_manual_journal_entry(
  p_entry_date date,
  p_description text,
  p_reference_type text DEFAULT 'manual',
  p_reference_id uuid DEFAULT NULL,
  p_customer_id uuid DEFAULT NULL,
  p_supplier_id uuid DEFAULT NULL,
  p_lines json DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_line json;
  v_account_id uuid;
  v_debit numeric;
  v_credit numeric;
  v_total_debit numeric := 0;
  v_total_credit numeric := 0;
  v_entry_id uuid;
  v_entry_number text;
BEGIN
  IF p_lines IS NULL OR json_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Journal entry needs at least one line';
  END IF;

  FOR v_line IN SELECT * FROM json_array_elements(p_lines) LOOP
    v_account_id := NULLIF(v_line->>'account_id', '')::uuid;
    v_debit := COALESCE((v_line->>'debit')::numeric, 0);
    v_credit := COALESCE((v_line->>'credit')::numeric, 0);

    IF v_account_id IS NULL THEN
      RAISE EXCEPTION 'Every line needs an account';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = v_account_id) THEN
      RAISE EXCEPTION 'Account % does not exist', v_account_id;
    END IF;
    IF v_debit < 0 OR v_credit < 0 THEN
      RAISE EXCEPTION 'Line amounts cannot be negative';
    END IF;
    IF v_debit = 0 AND v_credit = 0 THEN
      RAISE EXCEPTION 'Every line needs a debit or a credit amount';
    END IF;

    v_total_debit := v_total_debit + v_debit;
    v_total_credit := v_total_credit + v_credit;
  END LOOP;

  IF abs(v_total_debit - v_total_credit) > 0.01 THEN
    RAISE EXCEPTION 'Entry is not balanced: debits % vs credits %', v_total_debit, v_total_credit;
  END IF;
  IF v_total_debit <= 0 THEN
    RAISE EXCEPTION 'Entry total must be greater than zero';
  END IF;

  v_entry_id := public.post_journal_entry(
    p_description, p_entry_date, p_reference_type, p_reference_id,
    p_lines, p_customer_id, p_supplier_id
  );

  SELECT entry_number INTO v_entry_number FROM journal_entries WHERE id = v_entry_id;

  RETURN json_build_object('id', v_entry_id, 'entry_number', v_entry_number);
END;
$$;

-- 2. EDIT — reverse old lines (poster convention), replace header + lines,
--    apply new line deltas. One transaction.
CREATE OR REPLACE FUNCTION public.edit_manual_journal_entry(
  p_entry_id uuid,
  p_entry_date date,
  p_description text,
  p_lines json,
  p_allow_auto boolean DEFAULT false
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_entry record;
  v_line json;
  v_account_id uuid;
  v_debit numeric;
  v_credit numeric;
  v_total_debit numeric := 0;
  v_total_credit numeric := 0;
  v_sort integer := 0;
  v_old record;
BEGIN
  SELECT * INTO v_entry FROM journal_entries WHERE id = p_entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Journal entry % not found', p_entry_id;
  END IF;
  IF v_entry.reference_type IS DISTINCT FROM 'manual' AND NOT p_allow_auto THEN
    RAISE EXCEPTION '% is an auto-posted entry (%); pass p_allow_auto to edit it',
      v_entry.entry_number, v_entry.reference_type;
  END IF;

  IF p_lines IS NULL OR json_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Journal entry needs at least one line';
  END IF;

  FOR v_line IN SELECT * FROM json_array_elements(p_lines) LOOP
    v_account_id := NULLIF(v_line->>'account_id', '')::uuid;
    v_debit := COALESCE((v_line->>'debit')::numeric, 0);
    v_credit := COALESCE((v_line->>'credit')::numeric, 0);
    IF v_account_id IS NULL OR NOT EXISTS (SELECT 1 FROM accounts WHERE id = v_account_id) THEN
      RAISE EXCEPTION 'Every line needs a valid account';
    END IF;
    IF v_debit < 0 OR v_credit < 0 OR (v_debit = 0 AND v_credit = 0) THEN
      RAISE EXCEPTION 'Every line needs a positive debit or credit amount';
    END IF;
    v_total_debit := v_total_debit + v_debit;
    v_total_credit := v_total_credit + v_credit;
  END LOOP;

  IF abs(v_total_debit - v_total_credit) > 0.01 THEN
    RAISE EXCEPTION 'Entry is not balanced: debits % vs credits %', v_total_debit, v_total_credit;
  END IF;

  -- Reverse the old lines' effect on accounts.balance (poster's convention).
  FOR v_old IN
    SELECT account_id, SUM(debit) AS d, SUM(credit) AS c
    FROM journal_lines WHERE journal_entry_id = p_entry_id
    GROUP BY account_id
  LOOP
    UPDATE accounts
      SET balance = balance - CASE
        WHEN account_type IN ('liability', 'equity', 'revenue') THEN (v_old.c - v_old.d)
        ELSE (v_old.d - v_old.c)
      END
      WHERE id = v_old.account_id;
  END LOOP;

  DELETE FROM journal_lines WHERE journal_entry_id = p_entry_id;

  UPDATE journal_entries
    SET entry_date = p_entry_date,
        description = p_description,
        total_debit = v_total_debit,
        total_credit = v_total_credit
    WHERE id = p_entry_id;

  FOR v_line IN SELECT * FROM json_array_elements(p_lines) LOOP
    v_account_id := (v_line->>'account_id')::uuid;
    v_debit := COALESCE((v_line->>'debit')::numeric, 0);
    v_credit := COALESCE((v_line->>'credit')::numeric, 0);

    INSERT INTO journal_lines (journal_entry_id, account_id, description, debit, credit, sort_order)
    VALUES (p_entry_id, v_account_id, v_line->>'description', v_debit, v_credit, v_sort);

    UPDATE accounts
      SET balance = balance + CASE
        WHEN account_type IN ('asset', 'expense') THEN v_debit - v_credit
        WHEN account_type IN ('liability', 'equity', 'revenue') THEN v_credit - v_debit
        ELSE v_debit - v_credit
      END
      WHERE id = v_account_id;

    v_sort := v_sort + 1;
  END LOOP;

  RETURN json_build_object('id', p_entry_id, 'entry_number', v_entry.entry_number);
END;
$$;

-- 3. DELETE — always reverse before deleting. Auto entries need p_allow_auto.
CREATE OR REPLACE FUNCTION public.delete_manual_journal_entry(
  p_entry_id uuid,
  p_allow_auto boolean DEFAULT false
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_entry record;
  v_old record;
BEGIN
  SELECT * INTO v_entry FROM journal_entries WHERE id = p_entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Journal entry % not found', p_entry_id;
  END IF;
  IF v_entry.reference_type IS DISTINCT FROM 'manual' AND NOT p_allow_auto THEN
    RAISE EXCEPTION '% is an auto-posted entry (%); pass p_allow_auto to delete it',
      v_entry.entry_number, v_entry.reference_type;
  END IF;

  FOR v_old IN
    SELECT account_id, SUM(debit) AS d, SUM(credit) AS c
    FROM journal_lines WHERE journal_entry_id = p_entry_id
    GROUP BY account_id
  LOOP
    UPDATE accounts
      SET balance = balance - CASE
        WHEN account_type IN ('liability', 'equity', 'revenue') THEN (v_old.c - v_old.d)
        ELSE (v_old.d - v_old.c)
      END
      WHERE id = v_old.account_id;
  END LOOP;

  DELETE FROM journal_lines WHERE journal_entry_id = p_entry_id;
  DELETE FROM journal_entries WHERE id = p_entry_id;

  RETURN json_build_object('deleted', true, 'entry_number', v_entry.entry_number);
END;
$$;

-- 4. Manual receivable collection — payment row + payment JE + bad-debt JE
--    in one call. Replaces the dashboard modal's 3 sequential inserts
--    (which could leave a payment with no JE, or an unbalanced bad-debt JE
--    when account 5600 was missing).
CREATE OR REPLACE FUNCTION public.record_manual_receivable_payment(
  p_receivable_je_id uuid,
  p_amount numeric,
  p_bad_debt_amount numeric DEFAULT 0,
  p_payment_date date DEFAULT CURRENT_DATE,
  p_payment_method text DEFAULT 'cash',
  p_cash_account_id uuid DEFAULT NULL,
  p_reference_number text DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_je record;
  v_customer_id uuid;
  v_outstanding numeric;
  v_paid numeric;
  v_mr_account uuid;
  v_bad_debt_account uuid;
  v_payment_id uuid;
  v_payment_number text;
  v_desc text;
BEGIN
  SELECT * INTO v_je FROM journal_entries WHERE id = p_receivable_je_id;
  IF NOT FOUND OR v_je.reference_type IS DISTINCT FROM 'receivable' THEN
    RAISE EXCEPTION 'Manual receivable % not found', p_receivable_je_id;
  END IF;

  v_customer_id := v_je.customer_id;

  SELECT COALESCE(SUM(amount + bad_debt_amount), 0) INTO v_paid
  FROM payments
  WHERE reference_type = 'receivable' AND reference_id = p_receivable_je_id
    AND is_reversed = false;

  v_outstanding := COALESCE(v_je.total_debit, 0) - v_paid;

  IF p_amount IS NULL OR p_amount < 0 OR p_bad_debt_amount IS NULL OR p_bad_debt_amount < 0 THEN
    RAISE EXCEPTION 'Payment and bad debt amounts cannot be negative';
  END IF;
  IF p_amount + p_bad_debt_amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount or bad debt amount must be greater than zero';
  END IF;
  IF p_amount + p_bad_debt_amount > v_outstanding + 0.01 THEN
    RAISE EXCEPTION 'Payment + bad debt (%) exceeds outstanding balance (%)',
      p_amount + p_bad_debt_amount, v_outstanding;
  END IF;

  SELECT id INTO v_mr_account FROM accounts WHERE code = '1300' LIMIT 1;
  IF v_mr_account IS NULL THEN
    RAISE EXCEPTION 'Manual Receivable account (1300) not found';
  END IF;
  IF p_bad_debt_amount > 0 THEN
    SELECT id INTO v_bad_debt_account FROM accounts WHERE code = '5600' LIMIT 1;
    IF v_bad_debt_account IS NULL THEN
      RAISE EXCEPTION 'Bad Debt Expense account (5600) not found';
    END IF;
  END IF;
  IF p_amount > 0 AND (p_cash_account_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM accounts WHERE id = p_cash_account_id AND account_type = 'asset')) THEN
    RAISE EXCEPTION 'Select a valid cash/bank account to receive into';
  END IF;

  v_payment_number := public.generate_payment_number();
  v_desc := COALESCE(NULLIF(p_notes, ''), 'Payment received for ' || v_je.entry_number);

  INSERT INTO payments (payment_number, payment_type, reference_type, reference_id,
    customer_id, amount, bad_debt_amount, payment_method, payment_date,
    reference_number, notes, payment_for)
  VALUES (v_payment_number, 'received', 'receivable', p_receivable_je_id,
    v_customer_id, p_amount, p_bad_debt_amount, p_payment_method, p_payment_date,
    p_reference_number, p_notes, 'manual_receivable')
  RETURNING id INTO v_payment_id;

  IF p_amount > 0 THEN
    PERFORM public.post_journal_entry(
      v_desc, p_payment_date, 'payment', v_payment_id,
      json_build_array(
        json_build_object('account_id', p_cash_account_id, 'debit', p_amount, 'credit', 0,
          'description', 'Cash received for ' || v_je.entry_number),
        json_build_object('account_id', v_mr_account, 'debit', 0, 'credit', p_amount,
          'description', 'Manual receivable settled: ' || v_je.entry_number)
      )::json,
      v_customer_id
    );
  END IF;

  IF p_bad_debt_amount > 0 THEN
    PERFORM public.post_journal_entry(
      'Bad debt write-off for ' || v_je.entry_number, p_payment_date, 'payment', v_payment_id,
      json_build_array(
        json_build_object('account_id', v_bad_debt_account, 'debit', p_bad_debt_amount, 'credit', 0,
          'description', 'Bad debt write-off - ' || v_je.entry_number),
        json_build_object('account_id', v_mr_account, 'debit', 0, 'credit', p_bad_debt_amount,
          'description', 'Manual receivable written off: ' || v_je.entry_number)
      )::json,
      v_customer_id
    );
  END IF;

  RETURN json_build_object(
    'payment_id', v_payment_id,
    'payment_number', v_payment_number,
    'amount', p_amount,
    'bad_debt_amount', p_bad_debt_amount,
    'remaining', GREATEST(v_outstanding - p_amount - p_bad_debt_amount, 0)
  );
END;
$$;

-- 5. Manual payable payment — payment row + JE in one call.
CREATE OR REPLACE FUNCTION public.record_manual_payable_payment(
  p_payable_je_id uuid,
  p_amount numeric,
  p_payment_date date DEFAULT CURRENT_DATE,
  p_payment_method text DEFAULT 'cash',
  p_cash_account_id uuid DEFAULT NULL,
  p_reference_number text DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_je record;
  v_supplier_id uuid;
  v_outstanding numeric;
  v_paid numeric;
  v_ap_account uuid;
  v_payment_id uuid;
  v_payment_number text;
  v_desc text;
BEGIN
  SELECT * INTO v_je FROM journal_entries WHERE id = p_payable_je_id;
  IF NOT FOUND OR v_je.reference_type IS DISTINCT FROM 'payable' THEN
    RAISE EXCEPTION 'Manual payable % not found', p_payable_je_id;
  END IF;

  v_supplier_id := v_je.supplier_id;

  SELECT COALESCE(SUM(amount), 0) INTO v_paid
  FROM payments
  WHERE reference_type = 'payable' AND reference_id = p_payable_je_id
    AND is_reversed = false;

  v_outstanding := COALESCE(v_je.total_credit, 0) - v_paid;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be greater than zero';
  END IF;
  IF p_amount > v_outstanding + 0.01 THEN
    RAISE EXCEPTION 'Payment (%) exceeds outstanding balance (%)', p_amount, v_outstanding;
  END IF;
  IF p_cash_account_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM accounts WHERE id = p_cash_account_id AND account_type = 'asset') THEN
    RAISE EXCEPTION 'Select a valid cash/bank account to pay from';
  END IF;

  SELECT id INTO v_ap_account FROM accounts WHERE code = '2000' LIMIT 1;
  IF v_ap_account IS NULL THEN
    RAISE EXCEPTION 'Accounts Payable account (2000) not found';
  END IF;

  v_payment_number := public.generate_payment_number();
  v_desc := COALESCE(NULLIF(p_notes, ''), 'Payment made for ' || v_je.entry_number);

  INSERT INTO payments (payment_number, payment_type, reference_type, reference_id,
    supplier_id, amount, payment_method, payment_date,
    reference_number, notes, payment_for)
  VALUES (v_payment_number, 'made', 'payable', p_payable_je_id,
    v_supplier_id, p_amount, p_payment_method, p_payment_date,
    p_reference_number, p_notes, 'manual_payable')
  RETURNING id INTO v_payment_id;

  PERFORM public.post_journal_entry(
    v_desc, p_payment_date, 'payment', v_payment_id,
    json_build_array(
      json_build_object('account_id', v_ap_account, 'debit', p_amount, 'credit', 0,
        'description', 'AP paid for ' || v_je.entry_number),
      json_build_object('account_id', p_cash_account_id, 'debit', 0, 'credit', p_amount,
        'description', 'Cash paid for ' || v_je.entry_number)
    )::json,
    NULL,
    v_supplier_id
  );

  RETURN json_build_object(
    'payment_id', v_payment_id,
    'payment_number', v_payment_number,
    'amount', p_amount,
    'remaining', GREATEST(v_outstanding - p_amount, 0)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.post_manual_journal_entry(date, text, text, uuid, uuid, uuid, json) TO authenticated;
GRANT EXECUTE ON FUNCTION public.edit_manual_journal_entry(uuid, date, text, json, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_manual_journal_entry(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_manual_receivable_payment(uuid, numeric, numeric, date, text, uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_manual_payable_payment(uuid, numeric, date, text, uuid, text, text) TO authenticated;
