-- Offline invoice.create idempotency (2026-09-11)
--
-- The outbox item id already dedups redeliveries of ONE queued item
-- (sync_applied_items), but two DISTINCT outbox items can describe the same
-- charge intent: a double-submit in the pre-guard window, or a re-charge
-- after an ambiguous failure where the first enqueue already landed. The POS
-- stamps each checkout session with a client-generated idempotency key
-- carried in the invoice.create payload; sync_invoice_create records it on
-- the invoice and short-circuits when an invoice with that key exists.
--
-- Concurrency backstop: two devices racing the same key hit the unique
-- index; the loser's transaction (claim included) rolls back and the retry
-- takes the short-circuit above — self-healing, never a second invoice.

alter table public.invoices
  add column if not exists idempotency_key text;

create unique index if not exists invoices_idempotency_key_key
  on public.invoices (idempotency_key);

-- Full redefinition of sync_invoice_create from 20260909233000 with the
-- payload-level idempotency check and column write.
create or replace function public.sync_invoice_create(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key         text;
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

  v_number := public.generate_pos_number();

  insert into invoices (invoice_number, customer_id, invoice_date, subtotal, discount_amount,
    cart_discount_percent, extra_discount, tax_amount, shipping_cost, total_amount, amount_paid,
    status, is_pos, reference, idempotency_key)
  values (v_number, v_customer, v_date,
    coalesce((p_payload->>'subtotal')::numeric, 0),
    coalesce((p_payload->>'discount_amount')::numeric, 0),
    coalesce((p_payload->>'cart_discount_percent')::numeric, 0),
    coalesce((p_payload->>'extra_discount')::numeric, 0),
    coalesce((p_payload->>'tax_amount')::numeric, 0),
    coalesce((p_payload->>'shipping_cost')::numeric, 0),
    coalesce((p_payload->>'total_amount')::numeric, 0),
    coalesce((p_payload->>'amount_paid')::numeric, 0),
    coalesce(p_payload->>'status', 'draft'),
    true,
    nullif(p_payload->>'reference', ''),
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
    -- NOT NULL with default 0: an explicit NULL would override the default
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
  from jsonb_array_elements(coalesce(p_payload->'cost_history', '[]'::jsonb)) r;

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
      amount, payment_method, payment_date, notes, payment_for)
    values (coalesce(v_pnum, 'PAY-' || to_char(now(), 'HH24MISS')),
      'received', 'invoice', v_invoice_id, v_customer,
      v_cash,
      coalesce(p_payload->'cash_payment'->>'method', 'cash'),
      v_date,
      case when v_store_credit > 0 then 'POS sale (partial store credit)' else 'POS sale' end,
      'paid_invoice_pay');
  end if;

  return jsonb_build_object(
    'status', 'synced',
    'invoice_id', v_invoice_id,
    'invoice_number', v_number
  );
end;
$$;

-- Handler stays internal: only the dispatcher may call it (create or replace
-- preserves grants, but keep the contract explicit next to the definition).
revoke all on function public.sync_invoice_create(jsonb) from public, anon, authenticated;
