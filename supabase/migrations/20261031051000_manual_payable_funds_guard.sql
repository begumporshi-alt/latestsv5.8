-- ============================================================================
-- Funds guard -- manual payable payments
-- ============================================================================
-- Companion to 20261031050000_payment_funds_guard.sql.
--
-- `record_manual_payable_payment()` writes its own journal entry instead of
-- relying on `payment_accounting_trigger()`, so the guard would otherwise be
-- trivially bypassed by paying a manual payable from the suppliers screen.
--
-- This migration:
--   * adds `p_allow_negative` / `p_override_reason`,
--   * calls `assert_payment_funds()` on the cash portion,
--   * records `account_id` on the payment row (it was never set before),
--   * bypasses the guard during offline replay.
-- ============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.record_manual_payable_payment(uuid, numeric, numeric, date, text, uuid, text, text);

CREATE OR REPLACE FUNCTION public.record_manual_payable_payment(
  p_payable_je_id    uuid,
  p_amount           numeric,
  p_wht_amount       numeric DEFAULT 0,
  p_payment_date     date DEFAULT CURRENT_DATE,
  p_payment_method   text DEFAULT 'cash'::text,
  p_cash_account_id  uuid DEFAULT NULL::uuid,
  p_reference_number text DEFAULT NULL::text,
  p_notes            text DEFAULT NULL::text,
  p_allow_negative   boolean DEFAULT false,
  p_override_reason  text DEFAULT NULL::text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_je record;
  v_supplier_id uuid;
  v_outstanding numeric;
  v_paid numeric;
  v_ap_account uuid;
  v_payment_id uuid;
  v_payment_number text;
  v_desc text;
  v_wht numeric := 0;
  v_wht_account uuid;
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
  v_wht := LEAST(COALESCE(p_wht_amount, 0), p_amount);
  IF v_wht < 0 THEN
    RAISE EXCEPTION 'Withholding amount cannot be negative';
  END IF;
  IF v_wht >= p_amount THEN
    RAISE EXCEPTION 'Withholding (%) must be less than the payment amount (%)', v_wht, p_amount;
  END IF;
  IF p_allow_negative AND coalesce(btrim(p_override_reason), '') = '' THEN
    RAISE EXCEPTION 'An override reason is required to overdraw an account';
  END IF;
  IF v_wht > 0 THEN
    SELECT id INTO v_wht_account FROM accounts WHERE code = '2110' LIMIT 1;
    IF v_wht_account IS NULL THEN
      RAISE EXCEPTION 'WHT Payable account (2110) not found';
    END IF;
  END IF;

  -- Funds guard: only the cash portion leaves the account.
  PERFORM public.assert_payment_funds(p_cash_account_id, p_amount - v_wht, p_allow_negative);

  SELECT id INTO v_ap_account FROM accounts WHERE code = '2000' LIMIT 1;
  IF v_ap_account IS NULL THEN
    RAISE EXCEPTION 'Accounts Payable account (2000) not found';
  END IF;

  v_payment_number := public.generate_payment_number();
  v_desc := COALESCE(NULLIF(p_notes, ''), 'Payment made for ' || v_je.entry_number);

  INSERT INTO payments (payment_number, payment_type, reference_type, reference_id,
    supplier_id, amount, payment_method, payment_date,
    reference_number, notes, payment_for, account_id, allow_negative, override_reason)
  VALUES (v_payment_number, 'made', 'payable', p_payable_je_id,
    v_supplier_id, p_amount, p_payment_method, p_payment_date,
    p_reference_number, p_notes, 'manual_payable',
    p_cash_account_id, p_allow_negative, p_override_reason)
  RETURNING id INTO v_payment_id;

  IF v_wht > 0 THEN
    PERFORM public.post_journal_entry(
      v_desc, p_payment_date, 'payment', v_payment_id,
      json_build_array(
        json_build_object('account_id', v_ap_account, 'debit', p_amount, 'credit', 0,
          'description', 'AP paid for ' || v_je.entry_number),
        json_build_object('account_id', p_cash_account_id, 'debit', 0, 'credit', p_amount - v_wht,
          'description', 'Cash paid for ' || v_je.entry_number),
        json_build_object('account_id', v_wht_account, 'debit', 0, 'credit', v_wht,
          'description', 'Withholding tax deducted for ' || v_je.entry_number)
      )::json,
      NULL,
      v_supplier_id
    );
  ELSE
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
  END IF;

  RETURN json_build_object(
    'payment_id', v_payment_id,
    'payment_number', v_payment_number,
    'amount', p_amount,
    'wht_amount', v_wht,
    'cash_paid', p_amount - v_wht,
    'remaining', GREATEST(v_outstanding - p_amount, 0)
  );
END;
$function$;

-- Offline replay: same bypass as the other sync paths.
CREATE OR REPLACE FUNCTION public.sync_supplier_payable_payment(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_res json;
begin
  perform set_config('app.payment_funds_bypass', 'on', true);

  v_res := public.record_manual_payable_payment(
    (p_payload->>'payable_je_id')::uuid,
    (p_payload->>'amount')::numeric,
    coalesce(nullif(p_payload->>'wht_amount', '')::numeric, 0),
    coalesce(nullif(p_payload->>'payment_date', '')::date, current_date),
    coalesce(p_payload->>'payment_method', 'cash'),
    (p_payload->>'cash_account_id')::uuid,
    nullif(p_payload->>'reference_number', ''),
    coalesce(p_payload->>'notes', 'Supplier payment'));

  return to_jsonb(v_res) || jsonb_build_object('status', 'synced');
end;
$function$;

COMMIT;
