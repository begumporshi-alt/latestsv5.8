-- ============================================================================
-- Payment funds guard
-- ============================================================================
--
-- Problem
-- -------
-- Nothing stopped a payment from overdrawing its cash/bank account. Account
-- 1026 was allowed to pay out ৳554,898.68 on 11-Oct-2026 against ৳323,048.07
-- available, and kept going to -৳796,504.38.
--
-- Policy
-- ------
--   * CASH accounts can never go negative. Hard block, no override. Physical
--     cash cannot be spent twice.
--   * BANK accounts may go negative only with an explicit, recorded override
--     (manager confirms, reason required). Banks can genuinely be overdrawn or
--     the ledger can lag a real deposit, so a hard block would halt operations
--     on a balance that may simply be wrong.
--   * `accounts.overdraft_limit` raises the floor for accounts with a real
--     overdraft facility: available = balance + overdraft_limit.
--   * Offline replay bypasses the guard (see below) -- a payment accepted by a
--     device must not wedge the sync queue.
--
-- Enforcement point
-- -----------------
-- `payment_accounting_trigger()` is the only place every payment passes
-- through, so the check lives there rather than in React. UI validation alone
-- is bypassable by offline replay and direct inserts.
--
-- Concurrency
-- -----------
-- `assert_payment_funds()` takes `SELECT ... FOR UPDATE` on the account row, so
-- two simultaneous payments cannot both pass against the same balance.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS overdraft_limit numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.accounts.overdraft_limit IS
  'How far below zero this account may go before the funds guard blocks a '
  'payment. Ignored for cash accounts, which are always hard-blocked at zero.';

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS allow_negative boolean NOT NULL DEFAULT false;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS override_reason text;

COMMENT ON COLUMN public.payments.allow_negative IS
  'Set by the operator to permit this payment to overdraw a bank account. '
  'Ignored for cash accounts.';

COMMENT ON COLUMN public.payments.override_reason IS
  'Mandatory justification when allow_negative is true.';

-- An override must always be justified.
ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS payments_override_reason_check;

ALTER TABLE public.payments
  ADD CONSTRAINT payments_override_reason_check
  CHECK (
    NOT allow_negative
    OR (override_reason IS NOT NULL AND length(btrim(override_reason)) > 0)
  );

-- ---------------------------------------------------------------------------
-- 2. Guard
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assert_payment_funds(
  p_account_id     uuid,
  p_amount         numeric,
  p_allow_negative boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_account   accounts%rowtype;
  v_available numeric;
BEGIN
  IF p_account_id IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN;
  END IF;

  -- Transaction-local bypass, set by the offline replay functions.
  IF coalesce(current_setting('app.payment_funds_bypass', true), 'off') = 'on' THEN
    RETURN;
  END IF;

  -- Serialise concurrent payments against the same account. In READ COMMITTED
  -- the second waiter re-reads the row after the first commits.
  SELECT * INTO v_account FROM accounts WHERE id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment account % does not exist', p_account_id;
  END IF;

  -- Cash: absolute floor at zero, no override.
  IF v_account.is_cash THEN
    IF p_amount > v_account.balance THEN
      RAISE EXCEPTION
        'Insufficient cash in % — % available, % requested. Cash accounts cannot go negative.',
        v_account.name,
        to_char(v_account.balance, 'FM999999999990.00'),
        to_char(p_amount, 'FM999999999990.00')
        USING ERRCODE = 'PF001',
              DETAIL = format('account=%s; available=%s; requested=%s; kind=cash',
                              v_account.code, v_account.balance, p_amount);
    END IF;
    RETURN;
  END IF;

  v_available := v_account.balance + coalesce(v_account.overdraft_limit, 0);

  IF p_amount <= v_available THEN
    RETURN;
  END IF;

  IF p_allow_negative THEN
    RETURN;  -- explicit, audited override
  END IF;

  RAISE EXCEPTION
    'Insufficient funds in % — % available, % requested. Confirm the overdraft override to proceed.',
    v_account.name,
    to_char(v_available, 'FM999999999990.00'),
    to_char(p_amount, 'FM999999999990.00')
    USING ERRCODE = 'PF001',
          DETAIL = format('account=%s; available=%s; requested=%s; kind=bank',
                          v_account.code, v_available, p_amount);
END;
$function$;

COMMENT ON FUNCTION public.assert_payment_funds(uuid, numeric, boolean) IS
  'Blocks a payment that would overdraw its account. Cash is hard-blocked; '
  'banks require an explicit override. SQLSTATE PF001 on refusal.';

-- ---------------------------------------------------------------------------
-- 3. Trigger -- enforce before posting the supplier payment
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
  -- Case 1: Customer payment for an invoice (money in -- no guard)
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
  -- Case 2: Payment to supplier for a purchase order (money out)
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

    -- Funds guard: only the cash portion leaves the account; WHT stays payable.
    PERFORM assert_payment_funds(v_cash_account, v_amount - v_wht, NEW.allow_negative);

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
-- 4. pay_supplier_outstanding -- accept the override
--    Signature changes again, so drop the 7-arg version to avoid an overload.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.pay_supplier_outstanding(uuid, date, text, text, text, jsonb, uuid);

CREATE OR REPLACE FUNCTION public.pay_supplier_outstanding(
  p_supplier_id      uuid,
  p_payment_date     date DEFAULT CURRENT_DATE,
  p_payment_method   text DEFAULT 'cash'::text,
  p_reference_number text DEFAULT NULL::text,
  p_notes            text DEFAULT NULL::text,
  p_allocations      jsonb DEFAULT '[]'::jsonb,
  p_account_id       uuid DEFAULT NULL::uuid,
  p_allow_negative   boolean DEFAULT false,
  p_override_reason  text DEFAULT NULL::text
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

  if p_allow_negative and coalesce(btrim(p_override_reason), '') = '' then
    raise exception 'pay_supplier_outstanding: an override reason is required to overdraw an account';
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
      collection_id, account_id, allow_negative, override_reason)
    values (
      coalesce(v_num, 'POPAY-' || to_char(now(), 'HH24MISS')),
      'made', 'purchase_order', v_po.id, p_supplier_id,
      v_amount, v_wht,
      coalesce(p_payment_method, 'cash'), p_payment_date,
      p_reference_number, p_notes, 'supplier_payment',
      v_collection_id, v_account_id, p_allow_negative, p_override_reason
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
-- 5. Offline replay -- bypass the guard
--    A payment captured on a device must not wedge the queue because the
--    server balance moved in the meantime.
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
  perform set_config('app.payment_funds_bypass', 'on', true);

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

CREATE OR REPLACE FUNCTION public.sync_po_create(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_supplier uuid;
  v_number   text;
  v_paid     numeric := COALESCE((p_payload->>'amount_paid')::numeric, 0);
  v_po_id    uuid;
  v_pnum     text;
  v_account_id uuid;
BEGIN
  perform set_config('app.payment_funds_bypass', 'on', true);

  v_supplier := (p_payload->>'supplier_id')::uuid;
  IF v_supplier IS NULL THEN
    RAISE EXCEPTION 'po.create: supplier_id is required';
  END IF;
  IF p_payload->'items' IS NULL OR jsonb_array_length(p_payload->'items') = 0 THEN
    RAISE EXCEPTION 'po.create: items array is required';
  END IF;

  v_number := public.generate_purchase_order_number();

  IF p_payload ? 'id' THEN
    INSERT INTO purchase_orders (id, po_number, supplier_id, order_date, expected_date,
      subtotal, cart_discount_percent, extra_discount, discount_amount, total_amount,
      amount_paid, status, notes, reference)
    VALUES ((p_payload->>'id')::uuid, v_number, v_supplier,
      COALESCE(NULLIF(p_payload->>'order_date', '')::date, current_date),
      NULLIF(p_payload->>'expected_date', '')::date,
      COALESCE((p_payload->>'subtotal')::numeric, 0),
      COALESCE((p_payload->>'cart_discount_percent')::numeric, 0),
      COALESCE((p_payload->>'extra_discount')::numeric, 0),
      COALESCE((p_payload->>'discount_amount')::numeric, 0),
      COALESCE((p_payload->>'total_amount')::numeric, 0),
      0, 'draft',
      NULLIF(p_payload->>'notes', ''),
      NULLIF(p_payload->>'reference', ''))
    RETURNING id INTO v_po_id;
  ELSE
    INSERT INTO purchase_orders (po_number, supplier_id, order_date, expected_date,
      subtotal, cart_discount_percent, extra_discount, discount_amount, total_amount,
      amount_paid, status, notes, reference)
    VALUES (v_number, v_supplier,
      COALESCE(NULLIF(p_payload->>'order_date', '')::date, current_date),
      NULLIF(p_payload->>'expected_date', '')::date,
      COALESCE((p_payload->>'subtotal')::numeric, 0),
      COALESCE((p_payload->>'cart_discount_percent')::numeric, 0),
      COALESCE((p_payload->>'extra_discount')::numeric, 0),
      COALESCE((p_payload->>'discount_amount')::numeric, 0),
      COALESCE((p_payload->>'total_amount')::numeric, 0),
      0, 'draft',
      NULLIF(p_payload->>'notes', ''),
      NULLIF(p_payload->>'reference', ''))
    RETURNING id INTO v_po_id;
  END IF;

  INSERT INTO purchase_order_items (purchase_order_id, product_id, quantity, unit_cost,
    discount_percent, subtotal, unit_name, unit_conversion_factor, base_quantity, warehouse_id,
    sale_price, force_cost_update)
  SELECT v_po_id,
    (r->>'product_id')::uuid,
    (r->>'quantity')::numeric,
    (r->>'unit_cost')::numeric,
    COALESCE((r->>'discount_percent')::numeric, 0),
    (r->>'subtotal')::numeric,
    NULLIF(r->>'unit_name', ''),
    NULLIF(r->>'unit_conversion_factor', '')::numeric,
    (r->>'base_quantity')::numeric,
    NULLIF(r->>'warehouse_id', '')::uuid,
    NULLIF(r->>'sale_price', '')::numeric,
    COALESCE((r->>'force_cost_update')::boolean, false)
  FROM jsonb_array_elements(p_payload->'items') r;

  IF v_paid > 0 THEN
    v_account_id := public.resolve_payment_account(
      NULLIF(p_payload->>'account_id', '')::uuid,
      COALESCE(p_payload->>'payment_method', 'cash')
    );

    v_pnum := public.generate_purchase_payment_number();
    INSERT INTO payments (payment_number, payment_type, reference_type, reference_id, supplier_id,
      amount, payment_method, payment_date, reference_number, notes, payment_for, account_id)
    VALUES (COALESCE(v_pnum, 'POPAY-' || to_char(now(), 'HH24MISS')),
      'made', 'purchase_order', v_po_id, v_supplier,
      v_paid,
      COALESCE(p_payload->>'payment_method', 'cash'),
      COALESCE(NULLIF(p_payload->>'payment_date', '')::date, current_date),
      NULLIF(p_payload->>'payment_reference', ''),
      COALESCE(NULLIF(p_payload->>'payment_notes', ''),
        CASE WHEN v_paid >= (p_payload->>'total_amount')::numeric
          THEN 'Full payment at order time' ELSE 'Partial payment at order time' END),
      'supplier_payment',
      v_account_id);
  END IF;

  RETURN jsonb_build_object('status', 'synced', 'po_id', v_po_id, 'po_number', v_number);
END;
$function$;

COMMIT;
