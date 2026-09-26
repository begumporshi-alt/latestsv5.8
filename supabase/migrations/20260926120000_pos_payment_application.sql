-- ============================================================================
-- POS payment application — "advance balance first" (mode 3 of the checkout's
-- Collect From chooser)
--
-- The checkout can now settle the current sale from money the shop already
-- holds for the customer (customer_advances.balance) instead of taking fresh
-- cash. collect_customer_advance is the online twin of the offline
-- `advance.apply` queue, so both paths leave identical books:
--
--   collect_customer_advance(p_customer_id, p_invoice_id, p_amount, ...)
--     1. locks the invoice (must belong to the customer) and applies the
--        amount oldest-advance-first across the customer's ACTIVE advances,
--        optionally restricted to the advance ids the POS displayed
--        (p_advance_ids) — a stale client figure can then never debit a wallet
--        the cashier never saw
--     2. one customer_advance_applications row per advance touched, balance
--        decremented, status 'applied' when the wallet empties
--     3. Dr 2300 (customer advances) / Cr 1100 (AR) per application — the same
--        posting sync_advance_apply performs at offline replay
--     4. invoice amount_paid incremented and its status re-derived
--
-- The applied amount is capped at the LIVE balance and the shortfall is
-- reported back instead of raising: a sale must not fail because another
-- device spent the advance a minute ago. Mode choice itself is client-side —
-- see buildPosSettlement in app/(erp)/sales/pos/page.tsx.
-- ============================================================================

create or replace function public.collect_customer_advance(
  p_customer_id  uuid,
  p_invoice_id   uuid,
  p_amount       numeric,
  p_advance_ids  uuid[] default null,
  p_payment_date date default current_date,
  p_notes        text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount    numeric := round(coalesce(p_amount, 0), 2);
  v_remaining numeric;
  v_take      numeric;
  v_total     numeric := 0;
  v_apps      jsonb := '[]'::jsonb;
  v_advance   customer_advances%rowtype;
  v_invoice   invoices%rowtype;
  v_acc_2300  uuid;
  v_acc_1100  uuid;
  v_new_paid  numeric;
begin
  if v_amount <= 0 then
    raise exception 'collect_customer_advance: amount must be greater than 0';
  end if;

  select * into v_invoice from invoices
    where id = p_invoice_id and customer_id = p_customer_id
    for update;
  if not found then
    raise exception 'collect_customer_advance: invoice not found for this customer';
  end if;

  select id into v_acc_2300 from accounts where code = '2300' limit 1;
  select id into v_acc_1100 from accounts where code = '1100' limit 1;

  v_remaining := v_amount;

  for v_advance in
    select * from customer_advances
    where customer_id = p_customer_id
      and status = 'active'
      and coalesce(balance, 0) > 0.001
      and (p_advance_ids is null or id = any(p_advance_ids))
    order by created_at asc, id asc
    for update
  loop
    exit when v_remaining <= 0.001;

    v_take := least(round(coalesce(v_advance.balance, 0), 2), v_remaining);
    if v_take <= 0 then
      continue;
    end if;

    insert into customer_advance_applications (advance_id, customer_id, invoice_id, amount, notes)
    values (v_advance.id, p_customer_id, p_invoice_id, v_take,
      coalesce(nullif(p_notes, ''),
        'Advance ' || v_advance.advance_number || ' applied at POS checkout'));

    update customer_advances set
      balance = coalesce(balance, 0) - v_take,
      status = case when coalesce(balance, 0) - v_take <= 0.001 then 'applied' else 'active' end,
      updated_at = now()
    where id = v_advance.id;

    if v_acc_2300 is not null and v_acc_1100 is not null then
      perform public.post_journal_entry(
        'Advance ' || v_advance.advance_number || ' applied to ' || v_invoice.invoice_number,
        coalesce(p_payment_date, current_date),
        'advance_application',
        v_advance.id,
        json_build_array(
          json_build_object('account_id', v_acc_2300, 'debit', v_take, 'credit', 0,
            'description', 'Advance applied - ' || v_advance.advance_number),
          json_build_object('account_id', v_acc_1100, 'debit', 0, 'credit', v_take,
            'description', 'AR cleared - advance ' || v_advance.advance_number)
        )::json,
        p_customer_id
      );
    end if;

    v_apps := v_apps || jsonb_build_object(
      'advance_id', v_advance.id,
      'advance_number', v_advance.advance_number,
      'amount', v_take
    );
    v_total := round(v_total + v_take, 2);
    v_remaining := round(v_remaining - v_take, 2);
  end loop;

  if v_total > 0 then
    v_new_paid := round(coalesce(v_invoice.amount_paid, 0) + v_total, 2);
    update invoices set
      amount_paid = v_new_paid,
      status = case
        when coalesce(v_invoice.total_amount, 0) - v_new_paid - coalesce(v_invoice.bad_debt_amount, 0) <= 0.001
          then 'paid'
        else 'partially_paid'
      end,
      updated_at = now()
    where id = p_invoice_id;
  end if;

  return jsonb_build_object(
    'success', true,
    'requested_amount', v_amount,
    'applied_amount', v_total,
    'shortfall', round(v_amount - v_total, 2),
    'applications', v_apps
  );
end;
$$;

grant execute on function public.collect_customer_advance(uuid, uuid, numeric, uuid[], date, text)
  to authenticated;
