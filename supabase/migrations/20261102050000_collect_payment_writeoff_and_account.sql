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

  -- The explicit account is normally validated by resolve_payment_account()
  -- inside payment_accounting_trigger(). That call only happens when cash is
  -- received, so a pure write-off would otherwise store an unvalidated
  -- account_id. Validate here too, with the same predicate.
  if p_account_id is not null then
    if not exists (
      select 1 from accounts a
       where a.id = p_account_id
         and a.is_active
         and a.account_type = 'asset'
         and (a.is_cash or a.is_bank)
    ) then
      raise exception 'collect_customer_payment: account % is not an active cash/bank asset account', p_account_id;
    end if;
  end if;

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

commit;
