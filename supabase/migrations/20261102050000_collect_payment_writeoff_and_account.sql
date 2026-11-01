-- ============================================================================
-- Collect Payment: allow a pure write-off, and honour the chosen account
-- ----------------------------------------------------------------------------
-- Two defects in `collect_customer_payment`, both reported from the customer
-- page (/crm) and the customer profile (/crm/[id]).
--
-- 1. A pure write-off was impossible.
--
--    The closing guard counted cash only:
--
--        if v_allocated + p_overpayment <= 0 then
--          raise exception '... total received must be greater than 0';
--
--    but `payment_accounting_trigger` already handles amount = 0 with
--    bad_debt_amount > 0: it skips the cash journal entry (it is guarded by
--    `IF v_amount > 0`) and posts the write-off on its own
--    (Dr 5600 / Cr 1100). So the accounting layer supported the case and only
--    this guard rejected it. Collectors were forced to enter a token cash
--    amount to clear a dead invoice -- booking cash that never arrived.
--
--    The manual-receivable tab and the sales-page RecordPaymentModal both
--    already allow a pure write-off, so the three entry points disagreed.
--
-- 2. The "Receive Into" account was discarded.
--
--    The RPC had no `p_account_id`, and its INSERT did not list
--    `payments.account_id`. Every collection therefore wrote NULL and
--    `resolve_payment_account(NULL, payment_method)` fell back to the
--    payment-method default -- so with two bank accounts a transfer posted to
--    whichever bank `payment_methods` points at. The modal, meanwhile, showed
--    a *required* dropdown whose value never left the browser.
--
--    `20261031040000_payment_bank_account_routing.sql` introduced
--    `payments.account_id` and made `resolve_payment_account` prefer it. This
--    migration simply carries the operator's choice through to that column.
--
-- 3. The offline replay dropped the account too.
--
--    A collection taken offline is replayed by `sync_payment_create`, which
--    did not read `account_id` from the queued payload. So the same collection
--    posted to the chosen bank when made online and to the payment-method
--    default when made offline — a difference that only surfaced after
--    reconnect. It now carries the account through the same validation.
--
-- Compatibility
-- -------------
-- `p_account_id` is appended last and defaults to NULL, which reproduces the
-- previous behaviour exactly. Both call sites pass named arguments
-- (CollectPaymentModal and the POS due collection), so no call site changes
-- shape. The 9-argument overload is dropped first: leaving it in place would
-- make the named-argument calls ambiguous ("function is not unique").
-- ============================================================================

begin;

drop function if exists public.collect_customer_payment(
  uuid, date, text, text, text, jsonb, numeric, boolean, uuid);

create or replace function public.collect_customer_payment(
  p_customer_id uuid,
  p_payment_date date default current_date,
  p_payment_method text default 'cash',
  p_reference_number text default null,
  p_notes text default null,
  p_allocations jsonb default '[]'::jsonb,
  p_overpayment numeric default 0,
  p_route_overpayment boolean default false,
  p_collected_with_invoice_id uuid default null,
  p_account_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_alloc         jsonb;
  v_invoice       invoices%rowtype;
  v_amount        numeric;
  v_bad           numeric;
  v_new_paid      numeric;
  v_new_bad       numeric;
  v_new_bal       numeric;
  v_status        text;
  v_num           text;
  v_allocated     numeric := 0;
  v_written_off   numeric := 0;
  v_payment_nums  text[] default '{}';
  v_advance_id    uuid;
  v_collection_id uuid := gen_random_uuid();
begin
  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array'
     or jsonb_array_length(p_allocations) = 0 then
    raise exception 'collect_customer_payment: at least one invoice allocation is required';
  end if;

  if p_overpayment < 0 then
    raise exception 'collect_customer_payment: overpayment cannot be negative';
  end if;
  if p_overpayment > 0 and p_route_overpayment = false then
    raise exception 'collect_customer_payment: % is not allocated — allocate it or route the overpayment to the customer advance', p_overpayment;
  end if;

  -- Validate the account up front. payment_accounting_trigger() does this via
  -- resolve_payment_account(), but only on the cash branch — a pure write-off
  -- never reaches it and would otherwise store an unvalidated account_id.
  -- Calling the same helper keeps one definition of "valid".
  perform resolve_payment_account(p_account_id, coalesce(p_payment_method, 'cash'));

  for v_alloc in select * from jsonb_array_elements(p_allocations) loop
    v_amount := coalesce((v_alloc->>'amount')::numeric, 0);
    v_bad    := coalesce((v_alloc->>'bad_debt_amount')::numeric, 0);

    if v_amount < 0 or v_bad < 0 or v_amount + v_bad <= 0 then
      raise exception 'collect_customer_payment: allocation amount must be greater than 0';
    end if;

    select * into v_invoice from invoices
      where id = (v_alloc->>'invoice_id')::uuid
        and customer_id = p_customer_id
      for update;
    if not found then
      raise exception 'collect_customer_payment: invoice % not found for this customer', v_alloc->>'invoice_id';
    end if;
    if v_invoice.status in ('cancelled', 'paid', 'draft', 'refunded') then
      raise exception 'collect_customer_payment: invoice % is not collectable (status: %)',
        v_invoice.invoice_number, v_invoice.status;
    end if;

    v_new_paid := coalesce(v_invoice.amount_paid, 0) + v_amount;
    v_new_bad  := coalesce(v_invoice.bad_debt_amount, 0) + v_bad;
    v_new_bal  := v_invoice.total_amount - v_new_paid - v_new_bad;
    if v_new_bal < -0.01 then
      raise exception 'collect_customer_payment: allocation exceeds balance due on invoice % (due: %)',
        v_invoice.invoice_number,
        v_invoice.total_amount - coalesce(v_invoice.amount_paid, 0) - coalesce(v_invoice.bad_debt_amount, 0);
    end if;

    v_num := public.generate_payment_number();
    insert into payments (payment_number, payment_type, reference_type, reference_id, customer_id,
      amount, bad_debt_amount, payment_method, payment_date, reference_number, notes, payment_for,
      collected_with_invoice_id, collection_id, account_id)
    values (
      coalesce(v_num, 'PAY-' || to_char(now(), 'HH24MISS')),
      'received', 'invoice', v_invoice.id, p_customer_id,
      v_amount, v_bad,
      coalesce(p_payment_method, 'cash'), p_payment_date,
      p_reference_number, p_notes, 'outstanding_invoice_pay',
      p_collected_with_invoice_id, v_collection_id, p_account_id
    );

    v_status := case when v_new_bal <= 0.01 then 'paid' else 'partially_paid' end;
    update invoices set
      amount_paid = v_new_paid,
      bad_debt_amount = v_new_bad,
      status = v_status,
      updated_at = now()
    where id = v_invoice.id;

    v_allocated   := v_allocated + v_amount;
    v_written_off := v_written_off + v_bad;
    v_payment_nums := v_payment_nums || coalesce(v_num, '');
  end loop;

  -- Defence in depth. Every allocation already guarantees amount + bad_debt > 0
  -- above, so this can only fire if that check is ever weakened. It counts the
  -- write-off as consideration: a collection that clears a dead invoice by
  -- write-off alone is a legitimate collection.
  if v_allocated + v_written_off + p_overpayment <= 0 then
    raise exception 'collect_customer_payment: cash received plus bad debt written off must be greater than 0';
  end if;

  if p_overpayment > 0 and p_route_overpayment then
    insert into customer_advances (customer_id, amount, balance, status, payment_method,
      payment_date, reference_number, notes)
    values (
      p_customer_id, p_overpayment, p_overpayment, 'active',
      coalesce(p_payment_method, 'cash'), p_payment_date,
      p_reference_number,
      nullif(coalesce(p_notes, '') || ' Overpayment from multi-invoice collection.', ' ')
    )
    returning id into v_advance_id;
  end if;

  return jsonb_build_object(
    'collection_id', v_collection_id,
    'payment_numbers', to_jsonb(v_payment_nums),
    'allocated', v_allocated,
    'written_off', v_written_off,
    'overpayment', p_overpayment,
    'advance_id', v_advance_id,
    'invoices_updated', jsonb_array_length(p_allocations)
  );
end;
$$;

grant execute on function public.collect_customer_payment(
  uuid, date, text, text, text, jsonb, numeric, boolean, uuid, uuid)
  to authenticated;

comment on function public.collect_customer_payment(
  uuid, date, text, text, text, jsonb, numeric, boolean, uuid, uuid) is
  'Records a multi-invoice customer collection. Allocates cash and bad-debt '
  'write-offs per invoice, stamps one collection_id, and persists the chosen '
  'cash/bank account on every payment row. A collection may be write-off only.';

-- ---------------------------------------------------------------------------
-- Offline replay: carry the account too
--
-- The online path now records the chosen account, but an offline collection is
-- replayed through sync_payment_create, which did not read account_id from the
-- payload. A collection made offline therefore routed to the payment-method
-- default while the same collection online would have gone to the chosen bank
-- — the two paths disagreed, and the difference only surfaced after reconnect.
-- ---------------------------------------------------------------------------
create or replace function public.sync_payment_create(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice    invoices%rowtype;
  v_amount     numeric;
  v_bad        numeric;
  v_new_bal    numeric;
  v_status     text;
  v_num        text;
  v_collected  uuid;
  v_account    uuid;
begin
  v_amount := coalesce((p_payload->>'amount')::numeric, 0);
  v_bad    := coalesce((p_payload->>'bad_debt_amount')::numeric, 0);

  if v_amount + v_bad <= 0 then
    raise exception 'payment.create: amount or bad_debt_amount must be greater than 0';
  end if;

  -- Same helper the online path uses; NULL stays NULL and falls back to the
  -- payment-method mapping at posting time.
  v_account := nullif(p_payload->>'account_id', '')::uuid;
  perform resolve_payment_account(v_account, coalesce(p_payload->>'payment_method', 'cash'));

  -- Offline POS due collection link. The queued sale always syncs before this
  -- payment (strict outbox order), so the invoice must exist — if it does
  -- not, the outbox item was discarded manually and this op should fail
  -- loudly in the Sync Center rather than post an unlinked collection.
  v_collected := nullif(p_payload->>'collected_with_invoice_id', '')::uuid;
  if v_collected is not null and not exists (select 1 from invoices where id = v_collected) then
    raise exception 'payment.create: collected_with invoice % not found', v_collected;
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
    amount, bad_debt_amount, payment_method, payment_date, reference_number, notes, payment_for,
    collected_with_invoice_id, collection_id, account_id)
  values (coalesce(v_num, 'PAY-' || to_char(now(), 'HH24MISS')),
    'received', 'invoice', v_invoice.id, v_invoice.customer_id,
    v_amount, v_bad,
    coalesce(p_payload->>'payment_method', 'cash'),
    coalesce(nullif(p_payload->>'payment_date', '')::date, current_date),
    nullif(p_payload->>'reference_number', ''),
    nullif(p_payload->>'notes', ''),
    coalesce(p_payload->>'payment_for', 'paid_invoice_pay'),
    v_collected,
    nullif(p_payload->>'collection_id', '')::uuid,
    v_account);

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

commit;
