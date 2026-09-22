-- ============================================================================
-- Multi-invoice payment collection
--
-- One call collects a customer's payment across multiple due invoices plus an
-- optional overpayment routed to their advance balance. Replaces the old
-- one-invoice-per-dialog flow (and its client-side partial-failure cleanup)
-- with a single atomic transaction.
--
-- p_allocations: [{"invoice_id": "...", "amount": 100, "bad_debt_amount": 0}, ...]
-- p_overpayment: cash received beyond the allocations; only accepted when
--                p_route_overpayment is true (then recorded as a customer
--                advance), otherwise the call fails so the operator fixes the
--                allocation.
--
-- The existing payment_accounting / advance triggers post the journal legs
-- (Dr Cash / Cr AR per payment, Dr Cash / Cr 2300 for the advance) and
-- recalculate customer outstanding automatically.
-- ============================================================================

create or replace function public.collect_customer_payment(
  p_customer_id uuid,
  p_payment_date date default current_date,
  p_payment_method text default 'cash',
  p_reference_number text default null,
  p_notes text default null,
  p_allocations jsonb default '[]'::jsonb,
  p_overpayment numeric default 0,
  p_route_overpayment boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_alloc        jsonb;
  v_invoice      invoices%rowtype;
  v_amount       numeric;
  v_bad          numeric;
  v_new_paid     numeric;
  v_new_bad      numeric;
  v_new_bal      numeric;
  v_status       text;
  v_num          text;
  v_allocated    numeric := 0;
  v_payment_nums text[] default '{}';
  v_advance_id   uuid;
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
      amount, bad_debt_amount, payment_method, payment_date, reference_number, notes, payment_for)
    values (
      coalesce(v_num, 'PAY-' || to_char(now(), 'HH24MISS')),
      'received', 'invoice', v_invoice.id, p_customer_id,
      v_amount, v_bad,
      coalesce(p_payment_method, 'cash'), p_payment_date,
      p_reference_number, p_notes, 'outstanding_invoice_pay'
    );

    v_status := case when v_new_bal <= 0.01 then 'paid' else 'partially_paid' end;
    update invoices set
      amount_paid = v_new_paid,
      bad_debt_amount = v_new_bad,
      status = v_status,
      updated_at = now()
    where id = v_invoice.id;

    v_allocated := v_allocated + v_amount;
    v_payment_nums := v_payment_nums || coalesce(v_num, '');
  end loop;

  if v_allocated + p_overpayment <= 0 then
    raise exception 'collect_customer_payment: total received must be greater than 0';
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
    'payment_numbers', to_jsonb(v_payment_nums),
    'allocated', v_allocated,
    'overpayment', p_overpayment,
    'advance_id', v_advance_id,
    'invoices_updated', jsonb_array_length(p_allocations)
  );
end;
$$;

grant execute on function public.collect_customer_payment(uuid, date, text, text, text, jsonb, numeric, boolean)
  to authenticated;
