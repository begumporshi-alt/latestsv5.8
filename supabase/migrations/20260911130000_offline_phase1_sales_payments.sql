-- Offline Phase 1: sales + payments (2026-09-11)
--
-- Extends the offline sync layer so the money-in flows queue offline:
-- sales-page invoice creation, invoice payments (+bad debt), invoice status
-- changes, invoice cancellation, sales returns, customer advances
-- (receive/apply/refund), store credit (issue/expire), and expenses.
--
-- New cross-cutting mechanism — generic intent idempotency:
-- sync_applied_items dedups redeliveries of ONE outbox item, but two distinct
-- outbox items can describe the same business intent (double-submit before
-- the UI guard engages, re-submit after an ambiguous failure). Payloads now
-- carry idempotency_key (a client UUID minted per submit intent); sync_apply
-- claims it in sync_intent_keys before dispatching and stores the result
-- after, so a second item with the same key returns the first result as
-- {"status":"duplicate"} — which the sync engine treats as applied.
-- invoices.idempotency_key (20260911120000) remains as the durable record +
-- unique-index race protection for POS orders.

-- ---------------------------------------------------------------------------
-- Intent idempotency ledger
-- ---------------------------------------------------------------------------
create table if not exists public.sync_intent_keys (
  intent_key text primary key,
  user_id    uuid not null,
  op         text not null,
  result     jsonb not null default '{}'::jsonb,
  applied_at timestamptz not null default now()
);

alter table public.sync_intent_keys enable row level security;

drop policy if exists sync_intent_keys_select on public.sync_intent_keys;
create policy sync_intent_keys_select on public.sync_intent_keys
  for select to authenticated
  using (auth.uid() = user_id);

grant select on public.sync_intent_keys to authenticated;

-- ---------------------------------------------------------------------------
-- invoice.create — extended for the sales page (non-POS) channel:
-- is_pos flag, INV- vs POS- numbering, due_date, notes, payment
-- reference_number. POS payloads (no is_pos field) behave exactly as before.
-- ---------------------------------------------------------------------------
create or replace function public.sync_invoice_create(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key         text;
  v_is_pos      boolean;
  v_number      text;
  v_invoice_id  uuid;
  v_customer    uuid;
  v_date        date;
  v_store_credit numeric;
  v_cash        numeric;
  v_remaining   numeric;
  v_redeem      numeric;
  v_scnum       text;
  v_pnum        text;
  v_credit      record;
begin
  v_customer     := (p_payload->>'customer_id')::uuid;
  v_date         := (p_payload->>'invoice_date')::date;
  v_store_credit := coalesce((p_payload->>'store_credit_amount')::numeric, 0);
  v_cash         := coalesce((p_payload->'cash_payment'->>'amount')::numeric, 0);
  v_key          := nullif(p_payload->>'idempotency_key', '');
  v_is_pos       := coalesce((p_payload->>'is_pos')::boolean, true);

  if v_customer is null then
    raise exception 'invoice.create: customer_id is required';
  end if;
  if p_payload->'items' is null or jsonb_array_length(p_payload->'items') = 0 then
    raise exception 'invoice.create: items array is required';
  end if;

  -- Same charge intent already applied (a duplicate outbox item)? Hand back
  -- the original invoice; the sync engine treats "duplicate" as applied.
  if v_key is not null then
    select id, invoice_number into v_invoice_id, v_number
    from invoices
    where idempotency_key = v_key;
    if v_invoice_id is not null then
      return jsonb_build_object(
        'status', 'duplicate',
        'invoice_id', v_invoice_id,
        'invoice_number', v_number
      );
    end if;
  end if;

  if v_is_pos then
    v_number := public.generate_pos_number();
  else
    v_number := public.generate_invoice_number();
  end if;

  insert into invoices (invoice_number, customer_id, invoice_date, due_date, subtotal, discount_amount,
    cart_discount_percent, extra_discount, tax_amount, shipping_cost, total_amount, amount_paid,
    status, is_pos, reference, notes, idempotency_key)
  values (v_number, v_customer, v_date,
    nullif(p_payload->>'due_date', '')::date,
    coalesce((p_payload->>'subtotal')::numeric, 0),
    coalesce((p_payload->>'discount_amount')::numeric, 0),
    coalesce((p_payload->>'cart_discount_percent')::numeric, 0),
    coalesce((p_payload->>'extra_discount')::numeric, 0),
    coalesce((p_payload->>'tax_amount')::numeric, 0),
    coalesce((p_payload->>'shipping_cost')::numeric, 0),
    coalesce((p_payload->>'total_amount')::numeric, 0),
    coalesce((p_payload->>'amount_paid')::numeric, 0),
    coalesce(p_payload->>'status', 'draft'),
    v_is_pos,
    nullif(p_payload->>'reference', ''),
    nullif(p_payload->>'notes', ''),
    v_key)
  returning id into v_invoice_id;

  insert into invoice_items (invoice_id, product_id, description, quantity, unit_price,
    discount_percent, tax_rate, subtotal, cost_price, unit_name, unit_conversion_factor,
    base_quantity, warehouse_id, sort_order)
  select v_invoice_id,
    (r->>'product_id')::uuid,
    nullif(r->>'description', ''),
    (r->>'quantity')::numeric,
    (r->>'unit_price')::numeric,
    coalesce((r->>'discount_percent')::numeric, 0),
    coalesce((r->>'tax_rate')::numeric, 0),
    (r->>'subtotal')::numeric,
    coalesce((r->>'cost_price')::numeric, 0),
    nullif(r->>'unit_name', ''),
    (r->>'unit_conversion_factor')::numeric,
    (r->>'base_quantity')::numeric,
    nullif(r->>'warehouse_id', '')::uuid,
    coalesce(nullif(r->>'sort_order', '')::int, 0)
  from jsonb_array_elements(p_payload->'items') r;

  insert into cost_price_history (product_id, product_name, product_sku, invoice_id, unit,
    quantity, unit_price, cost_price_per_qty, cost_price_for_added_qty,
    total_cost_price_single, total_cost_price_added)
  select (r->>'product_id')::uuid,
    r->>'product_name',
    coalesce(r->>'product_sku', ''),
    v_invoice_id,
    coalesce(r->>'unit', 'pcs'),
    (r->>'quantity')::numeric,
    (r->>'unit_price')::numeric,
    coalesce((r->>'cost_price_per_qty')::numeric, 0),
    coalesce((r->>'cost_price_for_added_qty')::numeric, 0),
    coalesce((r->>'total_cost_price_single')::numeric, 0),
    coalesce((r->>'total_cost_price_added')::numeric, 0)
  from jsonb_array_elements(
    case when jsonb_typeof(p_payload->'cost_history') = 'array'
      then p_payload->'cost_history' else '[]'::jsonb end) r;

  -- Store credit: same fresh re-select + oldest-first redemption loop as POS.
  if v_store_credit > 0 then
    v_remaining := v_store_credit;
    for v_credit in
      select id, balance
      from customer_store_credits
      where customer_id = v_customer
        and status = 'active'
        and (expires_at is null or expires_at > now())
      order by created_at asc
    loop
      exit when v_remaining <= 0;
      v_redeem := least(coalesce(v_credit.balance, 0), v_remaining);
      if v_redeem > 0 then
        insert into store_credit_redemptions (store_credit_id, customer_id, invoice_id, amount, notes)
        values (v_credit.id, v_customer, v_invoice_id, v_redeem, 'Redeemed for ' || v_number);
        v_remaining := v_remaining - v_redeem;
      end if;
    end loop;

    v_scnum := public.generate_payment_number();
    insert into payments (payment_number, payment_type, reference_type, reference_id, customer_id,
      amount, payment_method, payment_date, notes, payment_for)
    values ('PAY-SC-' || replace(coalesce(v_scnum, ''), 'PAY-', ''),
      'received', 'invoice', v_invoice_id, v_customer,
      v_store_credit, 'store_credit', v_date,
      'Store credit redeemed for ' || v_number, 'paid_invoice_pay');
  end if;

  if v_cash > 0 then
    v_pnum := public.generate_payment_number();
    insert into payments (payment_number, payment_type, reference_type, reference_id, customer_id,
      amount, payment_method, payment_date, reference_number, notes, payment_for)
    values (coalesce(v_pnum, 'PAY-' || to_char(now(), 'HH24MISS')),
      'received', 'invoice', v_invoice_id, v_customer,
      v_cash,
      coalesce(p_payload->'cash_payment'->>'method', 'cash'),
      v_date,
      nullif(p_payload->'cash_payment'->>'reference_number', ''),
      coalesce(nullif(p_payload->'cash_payment'->>'notes', ''),
        case when v_store_credit > 0 then 'POS sale (partial store credit)' else 'POS sale' end),
      'paid_invoice_pay');
  end if;

  return jsonb_build_object(
    'status', 'synced',
    'invoice_id', v_invoice_id,
    'invoice_number', v_number
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- payment.create — invoice payment (+ optional bad-debt write-off).
-- Mirrors PaymentModal: payments insert (payment_accounting_trigger posts
-- Dr Cash/Bank / Cr AR and the bad-debt split) + invoice amount_paid/status
-- recompute. Re-validates against the LIVE balance at replay time: two
-- devices paying one invoice offline must not silently overpay.
-- ---------------------------------------------------------------------------
create or replace function public.sync_payment_create(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice  invoices%rowtype;
  v_amount   numeric;
  v_bad      numeric;
  v_new_bal  numeric;
  v_status   text;
  v_num      text;
begin
  v_amount := coalesce((p_payload->>'amount')::numeric, 0);
  v_bad    := coalesce((p_payload->>'bad_debt_amount')::numeric, 0);

  if v_amount + v_bad <= 0 then
    raise exception 'payment.create: amount or bad_debt_amount must be greater than 0';
  end if;

  select * into v_invoice from invoices where id = (p_payload->>'invoice_id')::uuid for update;
  if not found then
    raise exception 'payment.create: invoice not found';
  end if;
  if v_invoice.status = 'cancelled' then
    raise exception 'payment.create: invoice % is cancelled', v_invoice.invoice_number;
  end if;

  v_new_bal := v_invoice.total_amount
    - (coalesce(v_invoice.amount_paid, 0) + v_amount)
    - (coalesce(v_invoice.bad_debt_amount, 0) + v_bad);
  if v_new_bal < -0.01 and coalesce((p_payload->>'force')::boolean, false) = false then
    return jsonb_build_object(
      'status', 'conflict',
      'reason', format('Payment exceeds balance due (server balance: %s)',
        (v_invoice.total_amount - coalesce(v_invoice.amount_paid, 0) - coalesce(v_invoice.bad_debt_amount, 0))),
      'server_row', to_jsonb(v_invoice)
    );
  end if;

  v_status := case when v_new_bal <= 0.01 then 'paid' else 'partially_paid' end;

  v_num := public.generate_payment_number();
  insert into payments (payment_number, payment_type, reference_type, reference_id, customer_id,
    amount, bad_debt_amount, payment_method, payment_date, reference_number, notes, payment_for)
  values (coalesce(v_num, 'PAY-' || to_char(now(), 'HH24MISS')),
    'received', 'invoice', v_invoice.id, v_invoice.customer_id,
    v_amount, coalesce(nullif(p_payload->>'bad_debt_amount', '')::numeric, 0),
    coalesce(p_payload->>'payment_method', 'cash'),
    coalesce(nullif(p_payload->>'payment_date', '')::date, current_date),
    nullif(p_payload->>'reference_number', ''),
    nullif(p_payload->>'notes', ''),
    coalesce(p_payload->>'payment_for', 'paid_invoice_pay'));

  update invoices set
    amount_paid = coalesce(amount_paid, 0) + v_amount,
    bad_debt_amount = coalesce(bad_debt_amount, 0) + v_bad,
    status = v_status,
    updated_at = now()
  where id = v_invoice.id;

  return jsonb_build_object(
    'status', 'synced',
    'payment_number', v_num,
    'invoice_status', v_status
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- invoice.status — version-checked status update (the page dropdown).
-- ---------------------------------------------------------------------------
create or replace function public.sync_invoice_status(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice invoices%rowtype;
  v_status  text;
begin
  v_status := p_payload->>'status';
  if v_status is null or v_status = '' then
    raise exception 'invoice.status: status is required';
  end if;
  if v_status = 'cancelled' then
    raise exception 'invoice.status: use invoice.cancel, not a status update';
  end if;

  select * into v_invoice from invoices where id = (p_payload->>'invoice_id')::uuid for update;
  if not found then
    raise exception 'invoice.status: invoice not found';
  end if;

  if coalesce((p_payload->>'force')::boolean, false) = false
     and p_payload ? 'expected_updated_at'
     and p_payload->>'expected_updated_at' <> ''
     and v_invoice.updated_at <> (p_payload->>'expected_updated_at')::timestamptz then
    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'Invoice changed on the server since this device last saw it',
      'server_row', to_jsonb(v_invoice)
    );
  end if;

  update invoices set status = v_status, updated_at = now() where id = v_invoice.id;

  return jsonb_build_object('status', 'synced', 'invoice_status', v_status);
end;
$$;

-- ---------------------------------------------------------------------------
-- invoice.cancel — wraps the authoritative cancel_invoice RPC (FIFO restore,
-- journal reversals, payment reversals all live there).
-- ---------------------------------------------------------------------------
create or replace function public.sync_invoice_cancel(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res jsonb;
begin
  v_res := public.cancel_invoice(
    (p_payload->>'invoice_id')::uuid,
    p_payload->>'reason',
    coalesce(p_payload->>'cancelled_by', 'Offline sync'));

  if coalesce((v_res->>'success')::boolean, false) then
    return v_res || jsonb_build_object('status', 'synced');
  end if;
  raise exception 'invoice.cancel: %', coalesce(v_res->>'error', 'cancel_invoice failed');
end;
$$;

-- ---------------------------------------------------------------------------
-- sales_return.create — wraps the atomic record_sales_return RPC (batch-
-- accurate FIFO restore, COGS reversal journal, refund payment, store credit).
-- The RPC itself validates returnable quantities against live state, so a
-- second device returning the same items conflicts naturally (raise → parked
-- as failed with the server's message).
-- ---------------------------------------------------------------------------
create or replace function public.sync_sales_return_create(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res json;
begin
  v_res := public.record_sales_return(
    (p_payload->>'invoice_id')::uuid,
    p_payload->>'refund_method',
    nullif(p_payload->>'refund_account_id', '')::uuid,
    (p_payload->'items')::json,
    nullif(p_payload->>'created_by', '')::uuid);

  return to_jsonb(v_res) || jsonb_build_object('status', 'synced');
end;
$$;

-- ---------------------------------------------------------------------------
-- advance.receive — plain insert; set_advance_number assigns ADV- number and
-- advance_receipt_accounting_trigger posts Dr Cash / Cr 2300.
-- ---------------------------------------------------------------------------
create or replace function public.sync_advance_receive(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id     uuid;
  v_number text;
begin
  if coalesce((p_payload->>'amount')::numeric, 0) <= 0 then
    raise exception 'advance.receive: amount must be greater than 0';
  end if;

  insert into customer_advances (customer_id, amount, balance, status, payment_method,
    payment_date, reference_number, notes)
  values ((p_payload->>'customer_id')::uuid,
    (p_payload->>'amount')::numeric,
    (p_payload->>'amount')::numeric,
    'active',
    coalesce(p_payload->>'payment_method', 'cash'),
    coalesce(nullif(p_payload->>'payment_date', '')::date, current_date),
    nullif(p_payload->>'reference_number', ''),
    nullif(p_payload->>'notes', ''))
  returning id, advance_number into v_id, v_number;

  return jsonb_build_object('status', 'synced', 'advance_id', v_id, 'advance_number', v_number);
end;
$$;

-- ---------------------------------------------------------------------------
-- advance.apply — atomic version of the page's multi-step flow: application
-- row, advance balance/status, Dr 2300 / Cr 1100 journal (post_journal_entry
-- keeps lines + balances consistent), invoice amount_paid/status. The online
-- flow builds the JE manually; the handler uses the same RPC the rest of the
-- accounting system posts through.
-- ---------------------------------------------------------------------------
create or replace function public.sync_advance_apply(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_advance  customer_advances%rowtype;
  v_amount   numeric;
  v_acc_2300 uuid;
  v_acc_1100 uuid;
begin
  v_amount := coalesce((p_payload->>'amount')::numeric, 0);
  if v_amount <= 0 then
    raise exception 'advance.apply: amount must be greater than 0';
  end if;

  select * into v_advance from customer_advances
    where id = (p_payload->>'advance_id')::uuid for update;
  if not found then
    raise exception 'advance.apply: advance not found';
  end if;
  if v_amount > coalesce(v_advance.balance, 0) + 0.001 then
    return jsonb_build_object(
      'status', 'conflict',
      'reason', format('Advance balance on the server is %s — less than the amount being applied',
        coalesce(v_advance.balance, 0)),
      'server_row', to_jsonb(v_advance)
    );
  end if;

  insert into customer_advance_applications (advance_id, customer_id, invoice_id, amount, notes)
  values (v_advance.id, v_advance.customer_id, (p_payload->>'invoice_id')::uuid, v_amount,
    'Advance ' || v_advance.advance_number || ' applied to invoice');

  update customer_advances set
    balance = coalesce(balance, 0) - v_amount,
    status = case when coalesce(balance, 0) - v_amount <= 0.001 then 'applied' else 'active' end,
    updated_at = now()
  where id = v_advance.id;

  select id into v_acc_2300 from accounts where code = '2300' limit 1;
  select id into v_acc_1100 from accounts where code = '1100' limit 1;
  if v_acc_2300 is not null and v_acc_1100 is not null then
    perform public.post_journal_entry(
      'Advance ' || v_advance.advance_number || ' applied to invoice',
      current_date,
      'advance_application',
      v_advance.id,
      json_build_array(
        json_build_object('account_id', v_acc_2300, 'debit', v_amount, 'credit', 0,
          'description', 'Advance applied - ' || v_advance.advance_number),
        json_build_object('account_id', v_acc_1100, 'debit', 0, 'credit', v_amount,
          'description', 'AR cleared - advance ' || v_advance.advance_number)
      )::json,
      v_advance.customer_id
    );
  end if;

  update invoices set
    amount_paid = coalesce(amount_paid, 0) + v_amount,
    status = case
      when total_amount - (coalesce(amount_paid, 0) + v_amount) - coalesce(bad_debt_amount, 0) <= 0.001
        then 'paid' else 'partially_paid' end,
    updated_at = now()
  where id = (p_payload->>'invoice_id')::uuid;

  return jsonb_build_object(
    'status', 'synced',
    'advance_id', v_advance.id,
    'applied_amount', v_amount
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- advance.refund — atomic version of the page's multi-step flow: refund row,
-- advance balance/status, Dr 2300 / Cr payment-method account (1001
-- fallback) journal.
-- ---------------------------------------------------------------------------
create or replace function public.sync_advance_refund(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_advance  customer_advances%rowtype;
  v_amount   numeric;
  v_acc_2300 uuid;
  v_cash_acc uuid;
begin
  v_amount := coalesce((p_payload->>'amount')::numeric, 0);
  if v_amount <= 0 then
    raise exception 'advance.refund: amount must be greater than 0';
  end if;

  select * into v_advance from customer_advances
    where id = (p_payload->>'advance_id')::uuid for update;
  if not found then
    raise exception 'advance.refund: advance not found';
  end if;
  if v_amount > coalesce(v_advance.balance, 0) + 0.001 then
    return jsonb_build_object(
      'status', 'conflict',
      'reason', format('Advance balance on the server is %s — less than the refund amount',
        coalesce(v_advance.balance, 0)),
      'server_row', to_jsonb(v_advance)
    );
  end if;

  insert into customer_advance_refunds (advance_id, customer_id, amount, refund_method,
    refund_date, reference_number, notes)
  values (v_advance.id, v_advance.customer_id, v_amount,
    coalesce(p_payload->>'refund_method', 'cash'),
    coalesce(nullif(p_payload->>'refund_date', '')::date, current_date),
    nullif(p_payload->>'reference_number', ''),
    nullif(p_payload->>'notes', ''));

  update customer_advances set
    balance = coalesce(balance, 0) - v_amount,
    status = case when coalesce(balance, 0) - v_amount <= 0.001 then 'refunded' else 'active' end,
    updated_at = now()
  where id = v_advance.id;

  select id into v_acc_2300 from accounts where code = '2300' limit 1;
  select pm.account_id into v_cash_acc from payment_methods pm
    where pm.code = coalesce(p_payload->>'refund_method', 'cash') and pm.is_active limit 1;
  if v_cash_acc is null then
    select id into v_cash_acc from accounts where code = '1001' limit 1;
  end if;

  if v_acc_2300 is not null and v_cash_acc is not null then
    perform public.post_journal_entry(
      'Advance refund - ' || v_advance.advance_number,
      coalesce(nullif(p_payload->>'refund_date', '')::date, current_date),
      'advance_refund',
      v_advance.id,
      json_build_array(
        json_build_object('account_id', v_acc_2300, 'debit', v_amount, 'credit', 0,
          'description', 'Advance refunded - ' || v_advance.advance_number),
        json_build_object('account_id', v_cash_acc, 'debit', 0, 'credit', v_amount,
          'description', 'Cash/Bank paid out - refund ' || v_advance.advance_number)
      )::json,
      v_advance.customer_id
    );
  end if;

  return jsonb_build_object(
    'status', 'synced',
    'advance_id', v_advance.id,
    'refunded_amount', v_amount
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- store_credit.issue — credit row + Dr chosen account / Cr 2200 journal in
-- one transaction. Optional client id so a queued credit can be referenced
-- by later offline operations.
-- ---------------------------------------------------------------------------
create or replace function public.sync_store_credit_issue(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount  numeric;
  v_number  text;
  v_id      uuid;
  v_acc_2200 uuid;
begin
  v_amount := coalesce((p_payload->>'amount')::numeric, 0);
  if v_amount <= 0 then
    raise exception 'store_credit.issue: amount must be greater than 0';
  end if;
  if nullif(p_payload->>'debit_account_id', '') is null then
    raise exception 'store_credit.issue: debit_account_id is required';
  end if;

  v_number := public.generate_credit_number();

  if p_payload ? 'id' then
    insert into customer_store_credits (id, credit_number, customer_id, amount, balance,
      status, notes, expires_at)
    values ((p_payload->>'id')::uuid, v_number, (p_payload->>'customer_id')::uuid,
      v_amount, v_amount, 'active',
      nullif(p_payload->>'notes', '') , nullif(p_payload->>'expires_at', '')::date)
    returning id into v_id;
  else
    insert into customer_store_credits (credit_number, customer_id, amount, balance,
      status, notes, expires_at)
    values (v_number, (p_payload->>'customer_id')::uuid,
      v_amount, v_amount, 'active',
      nullif(p_payload->>'notes', ''), nullif(p_payload->>'expires_at', '')::date)
    returning id into v_id;
  end if;

  select id into v_acc_2200 from accounts where code = '2200' limit 1;
  if v_acc_2200 is null then
    raise exception 'store_credit.issue: Customer Refund Payable account (2200) not found';
  end if;

  perform public.post_journal_entry(
    'Store credit issued ' || v_number || ' — ' || coalesce(p_payload->>'customer_name', 'customer'),
    current_date,
    'store_credit',
    v_id,
    json_build_array(
      json_build_object('account_id', (p_payload->>'debit_account_id')::uuid,
        'debit', v_amount, 'credit', 0, 'description', 'Store credit issued'),
      json_build_object('account_id', v_acc_2200, 'debit', 0, 'credit', v_amount,
        'description', 'Store credit liability')
    )::json,
    (p_payload->>'customer_id')::uuid
  );

  return jsonb_build_object('status', 'synced', 'credit_id', v_id, 'credit_number', v_number);
end;
$$;

-- ---------------------------------------------------------------------------
-- store_credit.expire — version-checked status update.
-- ---------------------------------------------------------------------------
create or replace function public.sync_store_credit_expire(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_credit customer_store_credits%rowtype;
begin
  select * into v_credit from customer_store_credits
    where id = (p_payload->>'credit_id')::uuid for update;
  if not found then
    raise exception 'store_credit.expire: credit not found';
  end if;

  if coalesce((p_payload->>'force')::boolean, false) = false
     and p_payload ? 'expected_updated_at'
     and p_payload->>'expected_updated_at' <> ''
     and v_credit.updated_at <> (p_payload->>'expected_updated_at')::timestamptz then
    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'Store credit changed on the server since this device last saw it',
      'server_row', to_jsonb(v_credit)
    );
  end if;

  update customer_store_credits set status = 'expired', updated_at = now() where id = v_credit.id;

  return jsonb_build_object('status', 'synced', 'credit_id', v_credit.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- expense.create/update/delete — wrap the atomic manual-journal RPCs the
-- expenses page already uses. create can inline a new expense account when
-- the user typed a new name (code generated as next free 6xxx, matching the
-- page's 6xxx scheme without its collision risk).
-- ---------------------------------------------------------------------------
create or replace function public.sync_expense_create(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount  numeric;
  v_acc_id  uuid;
  v_code    text;
  v_res     json;
begin
  v_amount := coalesce((p_payload->>'amount')::numeric, 0);
  if v_amount <= 0 then
    raise exception 'expense.create: amount must be greater than 0';
  end if;

  v_acc_id := nullif(p_payload->>'expense_account_id', '')::uuid;
  if v_acc_id is null then
    if nullif(p_payload->>'new_account_name', '') is null then
      raise exception 'expense.create: expense_account_id or new_account_name is required';
    end if;
    select '6' || lpad((max((regexp_replace(code, '[^0-9]', '', 'g'))::int) + 1)::text, 3, '0')
      into v_code
      from accounts where code ~ '^6[0-9]{3}$';
    if v_code is null then
      v_code := '6001';
    end if;
    insert into accounts (code, name, account_type)
      values (v_code, p_payload->>'new_account_name', 'expense')
      returning id into v_acc_id;
  end if;

  v_res := public.post_manual_journal_entry(
    coalesce(nullif(p_payload->>'date', '')::date, current_date),
    coalesce(p_payload->>'description', 'Expense payment'),
    'manual',
    null, null, null,
    json_build_array(
      json_build_object('account_id', v_acc_id, 'debit', v_amount, 'credit', 0,
        'description', p_payload->>'description'),
      json_build_object('account_id', (p_payload->>'paid_from')::uuid, 'debit', 0, 'credit', v_amount,
        'description', p_payload->>'description')
    )::json
  );

  return to_jsonb(v_res) || jsonb_build_object('status', 'synced');
end;
$$;

create or replace function public.sync_expense_update(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount numeric;
  v_res    json;
begin
  v_amount := coalesce((p_payload->>'amount')::numeric, 0);
  if v_amount <= 0 then
    raise exception 'expense.update: amount must be greater than 0';
  end if;

  v_res := public.edit_manual_journal_entry(
    (p_payload->>'entry_id')::uuid,
    coalesce(nullif(p_payload->>'date', '')::date, current_date),
    coalesce(p_payload->>'description', 'Expense payment'),
    json_build_array(
      json_build_object('account_id', (p_payload->>'expense_account_id')::uuid,
        'debit', v_amount, 'credit', 0, 'description', p_payload->>'description'),
      json_build_object('account_id', (p_payload->>'paid_from')::uuid, 'debit', 0, 'credit', v_amount,
        'description', p_payload->>'description')
    )::json,
    false
  );

  return to_jsonb(v_res) || jsonb_build_object('status', 'synced');
end;
$$;

create or replace function public.sync_expense_delete(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res json;
begin
  v_res := public.delete_manual_journal_entry((p_payload->>'entry_id')::uuid, false);
  return to_jsonb(v_res) || jsonb_build_object('status', 'synced');
end;
$$;

-- ---------------------------------------------------------------------------
-- Dispatcher — adds the generic intent-key claim and the Phase 1 ops.
-- ---------------------------------------------------------------------------
create or replace function public.sync_apply(p_item_id uuid, p_op text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed boolean;
  v_result  jsonb;
  v_intent  text;
  v_intent_claimed boolean := false;
begin
  if auth.uid() is null then
    raise exception 'sync_apply requires an authenticated session';
  end if;

  -- Generic intent idempotency: two distinct outbox items describing the
  -- same business intent (same client idempotency_key) apply once.
  v_intent := nullif(p_payload->>'idempotency_key', '');
  if v_intent is not null then
    insert into sync_intent_keys (intent_key, user_id, op)
    values (v_intent, auth.uid(), p_op)
    on conflict (intent_key) do nothing
    returning true into v_intent_claimed;

    if not coalesce(v_intent_claimed, false) then
      select result into v_result
      from sync_intent_keys
      where intent_key = v_intent;
      return coalesce(v_result, '{}'::jsonb) || '{"status":"duplicate"}'::jsonb;
    end if;
  end if;

  -- Atomic claim: the insert and the operation below share this transaction.
  insert into sync_applied_items (user_id, item_id, op)
  values (auth.uid(), p_item_id, p_op)
  on conflict (user_id, item_id) do nothing
  returning true into v_claimed;

  if not coalesce(v_claimed, false) then
    -- Redelivery of an item that already applied: hand back the original
    -- outcome so the engine can reconcile without re-executing anything.
    select result into v_result
    from sync_applied_items
    where user_id = auth.uid() and item_id = p_item_id;
    return coalesce(v_result, '{}'::jsonb) || '{"status":"duplicate"}'::jsonb;
  end if;

  if p_op = 'invoice.create' then
    v_result := public.sync_invoice_create(p_payload);
  elsif p_op = 'payment.create' then
    v_result := public.sync_payment_create(p_payload);
  elsif p_op = 'invoice.status' then
    v_result := public.sync_invoice_status(p_payload);
  elsif p_op = 'invoice.cancel' then
    v_result := public.sync_invoice_cancel(p_payload);
  elsif p_op = 'sales_return.create' then
    v_result := public.sync_sales_return_create(p_payload);
  elsif p_op = 'advance.receive' then
    v_result := public.sync_advance_receive(p_payload);
  elsif p_op = 'advance.apply' then
    v_result := public.sync_advance_apply(p_payload);
  elsif p_op = 'advance.refund' then
    v_result := public.sync_advance_refund(p_payload);
  elsif p_op = 'store_credit.issue' then
    v_result := public.sync_store_credit_issue(p_payload);
  elsif p_op = 'store_credit.expire' then
    v_result := public.sync_store_credit_expire(p_payload);
  elsif p_op = 'expense.create' then
    v_result := public.sync_expense_create(p_payload);
  elsif p_op = 'expense.update' then
    v_result := public.sync_expense_update(p_payload);
  elsif p_op = 'expense.delete' then
    v_result := public.sync_expense_delete(p_payload);
  elsif p_op = 'product.create' then
    v_result := public.sync_product_create(p_payload);
  elsif p_op = 'product.update' then
    v_result := public.sync_product_update(p_payload);
  elsif p_op = 'customer.create' then
    v_result := public.sync_customer_create(p_payload);
  elsif p_op = 'customer.update' then
    v_result := public.sync_customer_update(p_payload);
  elsif p_op = 'employee.create' then
    v_result := public.sync_employee_create(p_payload);
  elsif p_op = 'employee.update' then
    v_result := public.sync_employee_update(p_payload);
  elsif p_op = 'attendance.mark' then
    v_result := public.sync_attendance_mark(p_payload);
  elsif p_op = 'attendance.details' then
    v_result := public.sync_attendance_details(p_payload);
  else
    raise exception 'Unknown sync op: %', p_op;
  end if;

  if v_result->>'status' = 'conflict' then
    -- Conflicts are resolvable: forget both claims so a forced retry of the
    -- same item executes again.
    delete from sync_applied_items
    where user_id = auth.uid() and item_id = p_item_id;
    if v_intent_claimed then
      delete from sync_intent_keys where intent_key = v_intent;
    end if;
    return v_result;
  end if;

  update sync_applied_items set result = v_result
  where user_id = auth.uid() and item_id = p_item_id;
  if v_intent_claimed then
    update sync_intent_keys set result = v_result
    where intent_key = v_intent;
  end if;

  return v_result;
end;
$$;

-- Handler functions are internal: only the dispatcher may call them.
revoke all on function
  public.sync_invoice_create(jsonb),
  public.sync_payment_create(jsonb),
  public.sync_invoice_status(jsonb),
  public.sync_invoice_cancel(jsonb),
  public.sync_sales_return_create(jsonb),
  public.sync_advance_receive(jsonb),
  public.sync_advance_apply(jsonb),
  public.sync_advance_refund(jsonb),
  public.sync_store_credit_issue(jsonb),
  public.sync_store_credit_expire(jsonb),
  public.sync_expense_create(jsonb),
  public.sync_expense_update(jsonb),
  public.sync_expense_delete(jsonb),
  public.sync_product_create(jsonb),
  public.sync_product_update(jsonb),
  public.sync_customer_create(jsonb),
  public.sync_customer_update(jsonb),
  public.sync_employee_create(jsonb),
  public.sync_employee_update(jsonb),
  public.sync_attendance_mark(jsonb),
  public.sync_attendance_details(jsonb)
from public, anon, authenticated;

revoke all on function public.sync_apply(uuid, text, jsonb) from public, anon;
grant execute on function public.sync_apply(uuid, text, jsonb) to authenticated;
