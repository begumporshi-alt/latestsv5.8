-- ============================================================================
-- Payment bank-account routing
-- ============================================================================
--
-- Problem
-- -------
-- `payment_accounting_trigger()` resolved the money account solely from
-- `payment_methods.account_id`. Because the generic `bank_transfer` method maps
-- to a single account (1026 Al-Arafah), every bank transfer -- receipt or
-- payment, whichever bank was actually used -- was posted to 1026. That is how
-- account 1026 reached -796,504.38 while Pubali/Islami held the deposits.
--
-- Fix
-- ---
-- 1. `payments.account_id` records the actual cash/bank account per payment.
-- 2. `resolve_payment_account()` prefers that explicit account and only falls
--    back to the method mapping (then to 1001 Cash in Hand) when it is NULL.
-- 3. `pay_supplier_outstanding()` and `sync_po_payment()` accept and persist it.
--
-- Backward compatibility
-- ----------------------
-- Existing rows keep `account_id = NULL`, so historical behaviour is unchanged:
-- they still resolve through `payment_methods`. No journal is rewritten here.
-- No backfill is performed -- the account that was actually posted is already
-- recorded on `journal_lines`, and rewriting it would mask history.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Column
-- ---------------------------------------------------------------------------
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES public.accounts(id);

COMMENT ON COLUMN public.payments.account_id IS
  'Cash/bank account the money actually moved through. NULL on historical rows '
  '(pre-2026-10-31); those fall back to payment_methods.account_id.';

CREATE INDEX IF NOT EXISTS idx_payments_account_id
  ON public.payments(account_id);

-- ---------------------------------------------------------------------------
-- 2. Account resolution helper
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_payment_account(
  p_account_id     uuid,
  p_payment_method text
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_account uuid;
BEGIN
  -- 1. An explicit account on the payment always wins. Validate it is a real
  --    cash/bank asset account so a mis-wired dropdown cannot post to, say,
  --    Accounts Receivable.
  IF p_account_id IS NOT NULL THEN
    SELECT a.id INTO v_account
      FROM accounts a
     WHERE a.id = p_account_id
       AND a.is_active
       AND a.account_type = 'asset'
       AND (a.is_cash OR a.is_bank);

    IF v_account IS NULL THEN
      RAISE EXCEPTION
        'Payment account % is not an active cash/bank asset account', p_account_id;
    END IF;

    RETURN v_account;
  END IF;

  -- 2. Legacy path: the payment-method mapping.
  SELECT pm.account_id INTO v_account
    FROM payment_methods pm
   WHERE pm.code = p_payment_method
     AND pm.is_active = true
   LIMIT 1;

  IF v_account IS NOT NULL THEN
    RETURN v_account;
  END IF;

  -- 3. Last resort, unchanged from the original trigger.
  SELECT id INTO v_account FROM accounts WHERE code = '1001' LIMIT 1;
  RETURN v_account;
END;
$function$;

COMMENT ON FUNCTION public.resolve_payment_account(uuid, text) IS
  'Resolves the cash/bank account for a payment: explicit account, then '
  'payment_methods mapping, then 1001 Cash in Hand.';

-- ---------------------------------------------------------------------------
-- 3. Payment accounting trigger -- prefer the explicit account
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payment_accounting_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_ar_account        uuid;
  v_ap_account        uuid;
  v_cash_account      uuid;
  v_bad_debt_account  uuid;
  v_invoice_record    RECORD;
  v_po_record         RECORD;
  v_amount            numeric;
  v_bad_debt          numeric;
  v_wht               numeric;
  v_wht_account       uuid;
BEGIN
  v_amount   := COALESCE(NEW.amount, 0);
  v_bad_debt := COALESCE(NEW.bad_debt_amount, 0);

  IF v_amount <= 0 AND v_bad_debt <= 0 THEN
    RETURN NEW;
  END IF;

  -- Idempotency: if any JE already exists for this payment row (backfill,
  -- re-import, re-fire), never post a second one.
  IF EXISTS (SELECT 1 FROM journal_entries je
              WHERE je.reference_type = 'payment' AND je.reference_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  -- ============================================================
  -- Case 1: Customer payment for an invoice
  -- ============================================================
  IF NEW.payment_type = 'received' AND NEW.reference_type = 'invoice' THEN
    SELECT id INTO v_ar_account FROM accounts WHERE code = '1100' LIMIT 1;
    IF v_ar_account IS NULL THEN
      RETURN NEW;
    END IF;

    SELECT id INTO v_bad_debt_account FROM accounts WHERE code = '5600' LIMIT 1;

    v_cash_account := resolve_payment_account(NEW.account_id, NEW.payment_method);

    SELECT * INTO v_invoice_record FROM invoices WHERE id = NEW.reference_id;

    -- Post payment: Debit Cash/Bank, Credit AR
    IF v_amount > 0 THEN
      IF v_cash_account IS NULL THEN
        RETURN NEW;
      END IF;

      PERFORM post_journal_entry(
        'Payment Received - ' || COALESCE(NEW.payment_number, 'invoice payment'),
        COALESCE(NEW.payment_date, CURRENT_DATE),
        'payment',
        NEW.id,
        json_build_array(
          json_build_object('account_id', v_cash_account, 'debit', v_amount, 'credit', 0, 'description', 'Cash received for ' || COALESCE(v_invoice_record.invoice_number, 'invoice')),
          json_build_object('account_id', v_ar_account, 'debit', 0, 'credit', v_amount, 'description', 'AR cleared for ' || COALESCE(v_invoice_record.invoice_number, 'invoice'))
        )::json,
        v_invoice_record.customer_id
      );
    END IF;

    -- Post bad debt: Debit Bad Debt Expense, Credit AR
    IF v_bad_debt > 0 AND v_bad_debt_account IS NOT NULL THEN
      PERFORM post_journal_entry(
        'Bad Debt Write-off - ' || COALESCE(NEW.payment_number, 'invoice payment'),
        COALESCE(NEW.payment_date, CURRENT_DATE),
        'payment',
        NEW.id,
        json_build_array(
          json_build_object('account_id', v_bad_debt_account, 'debit', v_bad_debt, 'credit', 0, 'description', 'Bad debt write-off for ' || COALESCE(v_invoice_record.invoice_number, 'invoice')),
          json_build_object('account_id', v_ar_account, 'debit', 0, 'credit', v_bad_debt, 'description', 'AR cleared (bad debt) for ' || COALESCE(v_invoice_record.invoice_number, 'invoice'))
        )::json,
        v_invoice_record.customer_id
      );
    END IF;

    RETURN NEW;
  END IF;

  -- ============================================================
  -- Case 2: Payment to supplier for a purchase order
  -- ============================================================
  IF NEW.payment_type = 'made' AND NEW.reference_type = 'purchase_order' THEN
    SELECT id INTO v_ap_account FROM accounts WHERE code = '2000' LIMIT 1;
    IF v_ap_account IS NULL THEN
      RETURN NEW;
    END IF;

    v_cash_account := resolve_payment_account(NEW.account_id, NEW.payment_method);

    IF v_cash_account IS NULL THEN
      RETURN NEW;
    END IF;

    SELECT * INTO v_po_record FROM purchase_orders WHERE id = NEW.reference_id;

    -- Post payment: Debit AP (full), Credit Cash/Bank (paid), Credit WHT Payable (withheld)
    v_wht := LEAST(COALESCE(NEW.wht_amount, 0), v_amount);
    IF v_wht < 0 THEN
      RAISE EXCEPTION 'Withholding amount (%) cannot be negative on payment %', NEW.wht_amount, COALESCE(NEW.payment_number, NEW.id);
    END IF;
    IF v_wht > 0 THEN
      SELECT id INTO v_wht_account FROM accounts WHERE code = '2110' LIMIT 1;
      IF v_wht_account IS NULL THEN
        RAISE EXCEPTION 'Payment % carries withholding (%) but WHT Payable account (2110) is missing', COALESCE(NEW.payment_number, NEW.id), v_wht;
      END IF;
      PERFORM post_journal_entry(
        'Payment Made - ' || COALESCE(NEW.payment_number, 'PO payment'),
        COALESCE(NEW.payment_date, CURRENT_DATE),
        'payment',
        NEW.id,
        json_build_array(
          json_build_object('account_id', v_ap_account, 'debit', v_amount, 'credit', 0, 'description', 'AP paid for ' || COALESCE(v_po_record.po_number, 'PO')),
          json_build_object('account_id', v_cash_account, 'debit', 0, 'credit', v_amount - v_wht, 'description', 'Cash paid for ' || COALESCE(v_po_record.po_number, 'PO')),
          json_build_object('account_id', v_wht_account, 'debit', 0, 'credit', v_wht, 'description', 'Withholding tax deducted for ' || COALESCE(v_po_record.po_number, 'PO'))
        )::json,
        NULL,
        NEW.supplier_id
      );
    ELSE
      PERFORM post_journal_entry(
        'Payment Made - ' || COALESCE(NEW.payment_number, 'PO payment'),
        COALESCE(NEW.payment_date, CURRENT_DATE),
        'payment',
        NEW.id,
        json_build_array(
          json_build_object('account_id', v_ap_account, 'debit', v_amount, 'credit', 0, 'description', 'AP paid for ' || COALESCE(v_po_record.po_number, 'PO')),
          json_build_object('account_id', v_cash_account, 'debit', 0, 'credit', v_amount, 'description', 'Cash paid for ' || COALESCE(v_po_record.po_number, 'PO'))
        )::json,
        NULL,
        NEW.supplier_id
      );
    END IF;

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 4. pay_supplier_outstanding -- accept the chosen account
--    Adding a parameter changes the signature, so CREATE OR REPLACE would
--    create an overload rather than replace. Drop the old 6-arg version first.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.pay_supplier_outstanding(uuid, date, text, text, text, jsonb);

CREATE OR REPLACE FUNCTION public.pay_supplier_outstanding(
  p_supplier_id      uuid,
  p_payment_date     date DEFAULT CURRENT_DATE,
  p_payment_method   text DEFAULT 'cash'::text,
  p_reference_number text DEFAULT NULL::text,
  p_notes            text DEFAULT NULL::text,
  p_allocations      jsonb DEFAULT '[]'::jsonb,
  p_account_id       uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_alloc        jsonb;
  v_po           purchase_orders%rowtype;
  v_amount       numeric;
  v_wht          numeric;
  v_new_paid     numeric;
  v_bal          numeric;
  v_num          text;
  v_paid         numeric := 0;
  v_wht_total    numeric := 0;
  v_payment_nums text[] default '{}';
  v_collection_id uuid := gen_random_uuid();
  v_account_id   uuid;
begin
  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array'
     or jsonb_array_length(p_allocations) = 0 then
    raise exception 'pay_supplier_outstanding: at least one PO allocation is required';
  end if;

  -- Validate once, up front, so a bad account fails before any row is written.
  v_account_id := public.resolve_payment_account(p_account_id, p_payment_method);

  for v_alloc in select * from jsonb_array_elements(p_allocations) loop
    v_amount := coalesce((v_alloc->>'amount')::numeric, 0);
    v_wht    := coalesce((v_alloc->>'wht_amount')::numeric, 0);

    if v_amount <= 0 then
      raise exception 'pay_supplier_outstanding: allocation amount must be greater than 0';
    end if;
    if v_wht < 0 or v_wht >= v_amount then
      raise exception 'pay_supplier_outstanding: withholding must be >= 0 and less than the payment amount';
    end if;

    select * into v_po from purchase_orders
      where id = (v_alloc->>'po_id')::uuid
        and supplier_id = p_supplier_id
      for update;
    if not found then
      raise exception 'pay_supplier_outstanding: purchase order % not found for this supplier', v_alloc->>'po_id';
    end if;
    if v_po.status = 'cancelled' then
      raise exception 'pay_supplier_outstanding: purchase order % is cancelled', v_po.po_number;
    end if;

    v_new_paid := coalesce(v_po.amount_paid, 0) + v_amount;
    v_bal      := v_po.total_amount - v_new_paid;
    if v_bal < -0.01 then
      raise exception 'pay_supplier_outstanding: allocation exceeds balance due on PO % (due: %)',
        v_po.po_number, v_po.total_amount - coalesce(v_po.amount_paid, 0);
    end if;

    v_num := public.generate_purchase_payment_number();
    insert into payments (payment_number, payment_type, reference_type, reference_id, supplier_id,
      amount, wht_amount, payment_method, payment_date, reference_number, notes, payment_for,
      collection_id, account_id)
    values (
      coalesce(v_num, 'POPAY-' || to_char(now(), 'HH24MISS')),
      'made', 'purchase_order', v_po.id, p_supplier_id,
      v_amount, v_wht,
      coalesce(p_payment_method, 'cash'), p_payment_date,
      p_reference_number, p_notes, 'supplier_payment',
      v_collection_id, v_account_id
    );

    v_paid      := v_paid + v_amount;
    v_wht_total := v_wht_total + v_wht;
    v_payment_nums := v_payment_nums || coalesce(v_num, '');
  end loop;

  if v_paid <= 0 then
    raise exception 'pay_supplier_outstanding: total paid must be greater than 0';
  end if;

  return jsonb_build_object(
    'collection_id', v_collection_id,
    'payment_numbers', to_jsonb(v_payment_nums),
    'paid', v_paid,
    'wht_total', v_wht_total,
    'pos_updated', jsonb_array_length(p_allocations)
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- 5. sync_po_payment -- offline replay carries the account
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_po_payment(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_po    purchase_orders%rowtype;
  v_amount numeric;
  v_wht   numeric;
  v_bal   numeric;
  v_num   text;
  v_account_id uuid;
begin
  v_amount := coalesce((p_payload->>'amount')::numeric, 0);
  v_wht    := coalesce(nullif(p_payload->>'wht_amount', '')::numeric, 0);
  if v_amount <= 0 then
    raise exception 'po.payment: amount must be greater than 0';
  end if;

  select * into v_po from purchase_orders where id = (p_payload->>'po_id')::uuid for update;
  if not found then
    raise exception 'po.payment: purchase order not found';
  end if;
  if v_po.status = 'cancelled' then
    raise exception 'po.payment: purchase order % is cancelled', v_po.po_number;
  end if;

  v_bal := v_po.total_amount - coalesce(v_po.amount_paid, 0);
  if v_amount > v_bal + 0.01 and coalesce((p_payload->>'force')::boolean, false) = false then
    return jsonb_build_object(
      'status', 'conflict',
      'reason', format('Payment exceeds the outstanding balance (server balance: %s)', v_bal),
      'server_row', to_jsonb(v_po)
    );
  end if;

  -- Resolve here too, so a replay fails loudly rather than posting to the
  -- wrong bank when the chosen account has since been deactivated.
  v_account_id := public.resolve_payment_account(
    nullif(p_payload->>'account_id', '')::uuid,
    coalesce(p_payload->>'payment_method', 'cash')
  );

  v_num := public.generate_purchase_payment_number();
  insert into payments (payment_number, payment_type, reference_type, reference_id, supplier_id,
    amount, wht_amount, payment_method, payment_date, reference_number, notes, payment_for,
    collection_id, account_id)
  values (coalesce(v_num, 'POPAY-' || to_char(now(), 'HH24MISS')),
    'made', 'purchase_order', v_po.id, v_po.supplier_id,
    v_amount, v_wht,
    coalesce(p_payload->>'payment_method', 'cash'),
    coalesce(nullif(p_payload->>'payment_date', '')::date, current_date),
    nullif(p_payload->>'reference_number', ''),
    nullif(p_payload->>'notes', ''),
    'supplier_payment',
    nullif(p_payload->>'collection_id', '')::uuid,
    v_account_id);

  return jsonb_build_object('status', 'synced', 'payment_number', v_num);
end;
$function$;

COMMIT;
