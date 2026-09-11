-- Offline Phase 2: purchases + suppliers (2026-09-11)
--
-- Supplier management, purchase orders (create/edit/status/cancel/payment),
-- goods receipt (GRN), and purchase returns queue offline and replay
-- atomically. Stock/accounting consequences stay server-side: GRN wraps the
-- atomic receive_grn RPC (FIFO batches, cost ratchet, journals), PO payments
-- rely on the payment_po_amount_paid_trigger + AP journal trigger, and the
-- purchase-return handler replicates the page's flow inside one transaction.

-- ---------------------------------------------------------------------------
-- supplier.create — optional client id so a queued PO can reference it.
-- ---------------------------------------------------------------------------
create or replace function public.sync_supplier_create(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  d    jsonb := p_payload->'data';
  v_id uuid;
begin
  if nullif(d->>'name', '') is null then
    raise exception 'supplier.create: name is required';
  end if;

  if p_payload ? 'id' then
    insert into suppliers (id, name, code, phone, email, mobile, company_name, city, address,
      credit_limit, credit_days, rating, is_active, country)
    values ((p_payload->>'id')::uuid, d->>'name', d->>'code',
      nullif(d->>'phone', ''), nullif(d->>'email', ''), nullif(d->>'mobile', ''),
      nullif(d->>'company_name', ''), nullif(d->>'city', ''), nullif(d->>'address', ''),
      coalesce(nullif(d->>'credit_limit', '')::numeric, 0),
      coalesce(nullif(d->>'credit_days', '')::int, 0),
      nullif(d->>'rating', '')::numeric,
      coalesce((d->>'is_active')::boolean, true),
      coalesce(nullif(d->>'country', ''), 'Bangladesh'))
    returning id into v_id;
  else
    insert into suppliers (name, code, phone, email, mobile, company_name, city, address,
      credit_limit, credit_days, rating, is_active, country)
    values (d->>'name', d->>'code',
      nullif(d->>'phone', ''), nullif(d->>'email', ''), nullif(d->>'mobile', ''),
      nullif(d->>'company_name', ''), nullif(d->>'city', ''), nullif(d->>'address', ''),
      coalesce(nullif(d->>'credit_limit', '')::numeric, 0),
      coalesce(nullif(d->>'credit_days', '')::int, 0),
      nullif(d->>'rating', '')::numeric,
      coalesce((d->>'is_active')::boolean, true),
      coalesce(nullif(d->>'country', ''), 'Bangladesh'))
    returning id into v_id;
  end if;

  return jsonb_build_object('status', 'synced', 'supplier_id', v_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- supplier.update — PATCH semantics: only fields present in `data` change,
-- so a partial update (e.g. deactivate: {is_active:false}) can't overwrite
-- fields the device never saw. expected_updated_at version check.
-- ---------------------------------------------------------------------------
create or replace function public.sync_supplier_update(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  d        jsonb := p_payload->'data';
  v_row    suppliers%rowtype;
begin
  select * into v_row from suppliers where id = (p_payload->>'id')::uuid for update;
  if not found then
    raise exception 'supplier.update: supplier not found';
  end if;

  if coalesce((p_payload->>'force')::boolean, false) = false
     and p_payload ? 'expected_updated_at'
     and p_payload->>'expected_updated_at' <> ''
     and v_row.updated_at <> (p_payload->>'expected_updated_at')::timestamptz then
    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'Supplier changed on the server since this device last saw it',
      'server_row', to_jsonb(v_row)
    );
  end if;

  update suppliers set
    name          = case when d ? 'name' then d->>'name' else suppliers.name end,
    code          = case when d ? 'code' then d->>'code' else suppliers.code end,
    phone         = case when d ? 'phone' then nullif(d->>'phone', '') else suppliers.phone end,
    email         = case when d ? 'email' then nullif(d->>'email', '') else suppliers.email end,
    mobile        = case when d ? 'mobile' then nullif(d->>'mobile', '') else suppliers.mobile end,
    company_name  = case when d ? 'company_name' then nullif(d->>'company_name', '') else suppliers.company_name end,
    city          = case when d ? 'city' then nullif(d->>'city', '') else suppliers.city end,
    address       = case when d ? 'address' then nullif(d->>'address', '') else suppliers.address end,
    credit_limit  = case when d ? 'credit_limit' then coalesce(nullif(d->>'credit_limit', '')::numeric, 0) else suppliers.credit_limit end,
    credit_days   = case when d ? 'credit_days' then coalesce(nullif(d->>'credit_days', '')::int, 0) else suppliers.credit_days end,
    rating        = case when d ? 'rating' then nullif(d->>'rating', '')::numeric else suppliers.rating end,
    is_active     = case when d ? 'is_active' then coalesce((d->>'is_active')::boolean, true) else suppliers.is_active end,
    updated_at    = now()
  where id = v_row.id;

  return jsonb_build_object('status', 'synced', 'supplier_id', v_row.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- po.create — PO header + items + optional payment-at-order-time (triggers
-- post the AP journal and maintain amount_paid/supplier balance).
-- Optional client id so later queued commands can reference the PO.
-- ---------------------------------------------------------------------------
create or replace function public.sync_po_create(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_supplier uuid;
  v_number   text;
  v_paid     numeric := coalesce((p_payload->>'amount_paid')::numeric, 0);
  v_po_id    uuid;
  v_pnum     text;
begin
  v_supplier := (p_payload->>'supplier_id')::uuid;
  if v_supplier is null then
    raise exception 'po.create: supplier_id is required';
  end if;
  if p_payload->'items' is null or jsonb_array_length(p_payload->'items') = 0 then
    raise exception 'po.create: items array is required';
  end if;

  v_number := public.generate_purchase_order_number();

  if p_payload ? 'id' then
    insert into purchase_orders (id, po_number, supplier_id, order_date, expected_date,
      subtotal, cart_discount_percent, extra_discount, discount_amount, total_amount,
      amount_paid, status, notes, reference)
    values ((p_payload->>'id')::uuid, v_number, v_supplier,
      coalesce(nullif(p_payload->>'order_date', '')::date, current_date),
      nullif(p_payload->>'expected_date', '')::date,
      coalesce((p_payload->>'subtotal')::numeric, 0),
      coalesce((p_payload->>'cart_discount_percent')::numeric, 0),
      coalesce((p_payload->>'extra_discount')::numeric, 0),
      coalesce((p_payload->>'discount_amount')::numeric, 0),
      coalesce((p_payload->>'total_amount')::numeric, 0),
      0, 'draft',
      nullif(p_payload->>'notes', ''),
      nullif(p_payload->>'reference', ''))
    returning id into v_po_id;
  else
    insert into purchase_orders (po_number, supplier_id, order_date, expected_date,
      subtotal, cart_discount_percent, extra_discount, discount_amount, total_amount,
      amount_paid, status, notes, reference)
    values (v_number, v_supplier,
      coalesce(nullif(p_payload->>'order_date', '')::date, current_date),
      nullif(p_payload->>'expected_date', '')::date,
      coalesce((p_payload->>'subtotal')::numeric, 0),
      coalesce((p_payload->>'cart_discount_percent')::numeric, 0),
      coalesce((p_payload->>'extra_discount')::numeric, 0),
      coalesce((p_payload->>'discount_amount')::numeric, 0),
      coalesce((p_payload->>'total_amount')::numeric, 0),
      0, 'draft',
      nullif(p_payload->>'notes', ''),
      nullif(p_payload->>'reference', ''))
    returning id into v_po_id;
  end if;

  insert into purchase_order_items (purchase_order_id, product_id, quantity, unit_cost,
    discount_percent, subtotal, unit_name, unit_conversion_factor, base_quantity, warehouse_id)
  select v_po_id,
    (r->>'product_id')::uuid,
    (r->>'quantity')::numeric,
    (r->>'unit_cost')::numeric,
    coalesce((r->>'discount_percent')::numeric, 0),
    (r->>'subtotal')::numeric,
    nullif(r->>'unit_name', ''),
    nullif(r->>'unit_conversion_factor', '')::numeric,
    (r->>'base_quantity')::numeric,
    nullif(r->>'warehouse_id', '')::uuid
  from jsonb_array_elements(p_payload->'items') r;

  if v_paid > 0 then
    v_pnum := public.generate_purchase_payment_number();
    insert into payments (payment_number, payment_type, reference_type, reference_id, supplier_id,
      amount, payment_method, payment_date, reference_number, notes, payment_for)
    values (coalesce(v_pnum, 'POPAY-' || to_char(now(), 'HH24MISS')),
      'made', 'purchase_order', v_po_id, v_supplier,
      v_paid,
      coalesce(p_payload->>'payment_method', 'cash'),
      coalesce(nullif(p_payload->>'payment_date', '')::date, current_date),
      nullif(p_payload->>'payment_reference', ''),
      coalesce(nullif(p_payload->>'payment_notes', ''),
        case when v_paid >= (p_payload->>'total_amount')::numeric
          then 'Full payment at order time' else 'Partial payment at order time' end),
      'supplier_payment');
  end if;

  return jsonb_build_object('status', 'synced', 'po_id', v_po_id, 'po_number', v_number);
end;
$$;

-- ---------------------------------------------------------------------------
-- po.update — version-checked edit: fields, items replaced, amount_paid
-- capped at the new total (mirror of the online edit modal).
-- ---------------------------------------------------------------------------
create or replace function public.sync_po_update(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_po  purchase_orders%rowtype;
  v_new_total numeric;
begin
  select * into v_po from purchase_orders where id = (p_payload->>'id')::uuid for update;
  if not found then
    raise exception 'po.update: purchase order not found';
  end if;
  if v_po.status = 'cancelled' then
    raise exception 'po.update: purchase order % is cancelled', v_po.po_number;
  end if;

  if coalesce((p_payload->>'force')::boolean, false) = false
     and p_payload ? 'expected_updated_at'
     and p_payload->>'expected_updated_at' <> ''
     and v_po.updated_at <> (p_payload->>'expected_updated_at')::timestamptz then
    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'Purchase order changed on the server since this device last saw it',
      'server_row', to_jsonb(v_po)
    );
  end if;

  v_new_total := coalesce((p_payload->>'total_amount')::numeric, v_po.total_amount);

  update purchase_orders set
    supplier_id  = (p_payload->>'supplier_id')::uuid,
    order_date   = coalesce(nullif(p_payload->>'order_date', '')::date, order_date),
    expected_date = nullif(p_payload->>'expected_date', '')::date,
    subtotal     = coalesce((p_payload->>'subtotal')::numeric, subtotal),
    cart_discount_percent = coalesce((p_payload->>'cart_discount_percent')::numeric, 0),
    extra_discount = coalesce((p_payload->>'extra_discount')::numeric, 0),
    discount_amount = coalesce((p_payload->>'discount_amount')::numeric, 0),
    total_amount = v_new_total,
    notes        = nullif(p_payload->>'notes', ''),
    reference    = nullif(p_payload->>'reference', ''),
    amount_paid  = least(amount_paid, v_new_total),
    updated_at   = now()
  where id = v_po.id;

  delete from purchase_order_items where purchase_order_id = v_po.id;
  insert into purchase_order_items (purchase_order_id, product_id, quantity, unit_cost,
    discount_percent, subtotal, unit_name, unit_conversion_factor, base_quantity, warehouse_id)
  select v_po.id,
    (r->>'product_id')::uuid,
    (r->>'quantity')::numeric,
    (r->>'unit_cost')::numeric,
    coalesce((r->>'discount_percent')::numeric, 0),
    (r->>'subtotal')::numeric,
    nullif(r->>'unit_name', ''),
    nullif(r->>'unit_conversion_factor', '')::numeric,
    (r->>'base_quantity')::numeric,
    nullif(r->>'warehouse_id', '')::uuid
  from jsonb_array_elements(p_payload->'items') r;

  return jsonb_build_object('status', 'synced', 'po_id', v_po.id, 'po_number', v_po.po_number);
end;
$$;

-- ---------------------------------------------------------------------------
-- po.status — version-checked status change. Receiving stock offline must go
-- through the GRN flow (FIFO batches + journals); the legacy status-mark
-- receive path is rejected so the batch ledger can never drift.
-- ---------------------------------------------------------------------------
create or replace function public.sync_po_status(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_po     purchase_orders%rowtype;
  v_status text := p_payload->>'status';
begin
  if v_status in ('received', 'partially_received') then
    raise exception 'po.status: receiving stock must go through the GRN flow (it maintains FIFO batches and journals)';
  end if;

  select * into v_po from purchase_orders where id = (p_payload->>'id')::uuid for update;
  if not found then
    raise exception 'po.status: purchase order not found';
  end if;

  if coalesce((p_payload->>'force')::boolean, false) = false
     and p_payload ? 'expected_updated_at'
     and p_payload->>'expected_updated_at' <> ''
     and v_po.updated_at <> (p_payload->>'expected_updated_at')::timestamptz then
    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'Purchase order changed on the server since this device last saw it',
      'server_row', to_jsonb(v_po)
    );
  end if;

  update purchase_orders set status = v_status, updated_at = now() where id = v_po.id;

  return jsonb_build_object('status', 'synced', 'po_id', v_po.id, 'po_status', v_status);
end;
$$;

-- ---------------------------------------------------------------------------
-- po.cancel — atomic replication of the page's cancel flow: status +
-- payment reversal flags + stock reversal for received goods. The
-- purchase_order_cancellation_trigger posts the journal reversals.
-- ---------------------------------------------------------------------------
create or replace function public.sync_po_cancel(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_po     purchase_orders%rowtype;
  v_item   record;
  v_wh     uuid;
  v_inv_id uuid;
  v_qty    numeric;
begin
  select * into v_po from purchase_orders where id = (p_payload->>'id')::uuid for update;
  if not found then
    raise exception 'po.cancel: purchase order not found';
  end if;
  if v_po.status = 'cancelled' then
    return jsonb_build_object('status', 'synced', 'po_id', v_po.id,
      'note', 'already cancelled');
  end if;

  update purchase_orders set
    status = 'cancelled',
    amount_paid = total_amount,
    updated_at = now()
  where id = v_po.id;
  -- purchase_order_cancellation_trigger reverses the receipt and payment
  -- journal entries and the account balances.

  update payments set is_reversed = true
  where reference_type = 'purchase_order'
    and reference_id = v_po.id
    and is_reversed = false;

  if v_po.status in ('received', 'partially_received') then
    select id into v_wh from warehouses where is_default limit 1;
    for v_item in
      select product_id, quantity, warehouse_id, base_quantity
      from purchase_order_items where purchase_order_id = v_po.id
    loop
      v_qty := coalesce(v_item.base_quantity, v_item.quantity);
      v_inv_id := null;
      if coalesce(v_item.warehouse_id, v_wh) is not null then
        select id into v_inv_id from inventory_items
        where product_id = v_item.product_id
          and warehouse_id = coalesce(v_item.warehouse_id, v_wh)
        limit 1;
        if v_inv_id is not null then
          update inventory_items set
            quantity_on_hand = greatest(0, quantity_on_hand - v_qty),
            updated_at = now()
          where id = v_inv_id;
        end if;
        insert into stock_movements (tenant_id, product_id, warehouse_id, movement_type,
          quantity, reference_type, reference_id, reference_number, notes)
        values ('00000000-0000-0000-0000-000000000001', v_item.product_id,
          coalesce(v_item.warehouse_id, v_wh), 'purchase_return', -v_qty,
          'purchase_order', v_po.id, v_po.po_number, 'Stock reversed on PO cancellation');
      end if;
    end loop;
  end if;

  return jsonb_build_object('status', 'synced', 'po_id', v_po.id, 'po_number', v_po.po_number);
end;
$$;

-- ---------------------------------------------------------------------------
-- po.payment — payments insert; payment_po_amount_paid_trigger maintains
-- amount_paid, the AP journal trigger maintains supplier balance. Re-validated
-- against the LIVE outstanding balance at replay.
-- ---------------------------------------------------------------------------
create or replace function public.sync_po_payment(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_po    purchase_orders%rowtype;
  v_amount numeric;
  v_wht   numeric;
  v_bal   numeric;
  v_num   text;
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

  v_num := public.generate_purchase_payment_number();
  insert into payments (payment_number, payment_type, reference_type, reference_id, supplier_id,
    amount, wht_amount, payment_method, payment_date, reference_number, notes, payment_for)
  values (coalesce(v_num, 'POPAY-' || to_char(now(), 'HH24MISS')),
    'made', 'purchase_order', v_po.id, v_po.supplier_id,
    v_amount, v_wht,
    coalesce(p_payload->>'payment_method', 'cash'),
    coalesce(nullif(p_payload->>'payment_date', '')::date, current_date),
    nullif(p_payload->>'reference_number', ''),
    nullif(p_payload->>'notes', ''),
    'supplier_payment');

  return jsonb_build_object('status', 'synced', 'payment_number', v_num);
end;
$$;

-- ---------------------------------------------------------------------------
-- grn.receive — wraps the atomic receive_grn RPC (GRN header, movements,
-- counters, FIFO batches with cost ratchet, journal, PO status).
-- ---------------------------------------------------------------------------
create or replace function public.sync_grn_receive(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res json;
begin
  v_res := public.receive_grn(
    (p_payload->>'supplier_id')::uuid,
    nullif(p_payload->>'purchase_order_id', '')::uuid,
    nullif(p_payload->>'warehouse_id', '')::uuid,
    (p_payload->'items')::json,
    nullif(p_payload->>'notes', ''));

  return to_jsonb(v_res) || jsonb_build_object('status', 'synced');
end;
$$;

-- ---------------------------------------------------------------------------
-- purchase_return.create — atomic replication of the returns page: per-item
-- stock movements + FIFO reversal (youngest first) + counter update + PO
-- received-quantity rollback, then the return header (its trigger posts the
-- Dr AP journal) and items. Net-cost ratio derived from the LIVE PO.
-- ---------------------------------------------------------------------------
create or replace function public.sync_purchase_return_create(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_po       purchase_orders%rowtype;
  v_id       uuid;
  v_number   text;
  v_ratio    numeric;
  v_total    numeric := 0;
  v_wh       uuid;
  v_item     jsonb;
  v_po_item  purchase_order_items%rowtype;
  v_inv_id   uuid;
  v_qty      numeric;
  v_refund   numeric;
  v_wh_id    uuid;
  v_rcvd     numeric;
begin
  select * into v_po from purchase_orders where id = (p_payload->>'purchase_order_id')::uuid;
  if not found then
    raise exception 'purchase_return.create: purchase order not found';
  end if;

  if p_payload ? 'id' then
    v_id := (p_payload->>'id')::uuid;
  else
    v_id := gen_random_uuid();
  end if;
  v_number := coalesce(nullif(p_payload->>'return_number', ''),
    'PRET-' || to_char(now(), 'HH24MISS'));

  v_ratio := case when coalesce(v_po.subtotal, 0) > 0
    then v_po.total_amount / v_po.subtotal else 1 end;

  select id into v_wh from warehouses where is_default limit 1;

  for v_item in select * from jsonb_array_elements(p_payload->'items')
  loop
    select * into v_po_item from purchase_order_items
      where id = (v_item->>'purchase_order_item_id')::uuid;
    if not found then
      raise exception 'purchase_return.create: PO item not found';
    end if;

    v_qty    := (v_item->>'quantity')::numeric;
    v_wh_id  := coalesce(nullif(v_item->>'warehouse_id', '')::uuid, v_po_item.warehouse_id, v_wh);
    v_refund := v_qty * coalesce(v_po_item.unit_cost, 0) * v_ratio;
    v_total  := v_total + v_refund;

    insert into stock_movements (tenant_id, product_id, warehouse_id, movement_type,
      quantity, unit_cost, reference_type, reference_id, reference_number, notes)
    values ('00000000-0000-0000-0000-000000000001', v_po_item.product_id, v_wh_id,
      'return_out', -v_qty, coalesce(v_po_item.unit_cost, 0),
      'purchase_return', v_id, v_number,
      coalesce(nullif(v_item->>'reason', ''), 'Return to supplier from PO ' || v_po.po_number));

    perform public.reverse_fifo_on_purchase_return(
      v_po_item.product_id, v_wh_id, v_qty, coalesce(v_po_item.unit_cost, 0), v_id, v_number);

    update inventory_items set
      quantity_on_hand = greatest(0, quantity_on_hand - v_qty),
      updated_at = now()
    where product_id = v_po_item.product_id and warehouse_id = v_wh_id;

    v_rcvd := coalesce(v_po_item.received_quantity, v_po_item.quantity);
    update purchase_order_items set received_quantity = greatest(0, v_rcvd - v_qty)
    where id = v_po_item.id;
  end loop;

  insert into purchase_returns (id, return_number, purchase_order_id, supplier_id,
    warehouse_id, return_date, total_amount, status)
  values (v_id, v_number, v_po.id, v_po.supplier_id, v_wh,
    coalesce(nullif(p_payload->>'return_date', '')::date, current_date),
    v_total, 'completed');

  insert into purchase_return_items (purchase_return_id, product_id, quantity, unit_cost,
    subtotal, reason)
  select v_id,
    pi.product_id,
    (it.item->>'quantity')::numeric,
    coalesce(pi.unit_cost, 0),
    (it.item->>'quantity')::numeric * coalesce(pi.unit_cost, 0) * v_ratio,
    case when it.item->>'reason' in ('defective','wrong_item','quality_issue','overstock','other')
      then it.item->>'reason' else 'other' end
  from (select item from jsonb_array_elements(p_payload->'items') item) it
  join purchase_order_items pi
    on pi.id = (it.item->>'purchase_order_item_id')::uuid;

  return jsonb_build_object('status', 'synced', 'return_id', v_id,
    'return_number', v_number, 'refund_amount', v_total);
end;
$$;

-- ---------------------------------------------------------------------------
-- supplier.payable_payment — wraps the atomic record_manual_payable_payment
-- RPC (payment row + Dr AP / Cr cash / Cr WHT journal + balances).
-- ---------------------------------------------------------------------------
create or replace function public.sync_supplier_payable_payment(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res json;
begin
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
$$;

-- ---------------------------------------------------------------------------
-- Dispatcher — Phase 2 ops.
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

  insert into sync_applied_items (user_id, item_id, op)
  values (auth.uid(), p_item_id, p_op)
  on conflict (user_id, item_id) do nothing
  returning true into v_claimed;

  if not coalesce(v_claimed, false) then
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
  elsif p_op = 'supplier.create' then
    v_result := public.sync_supplier_create(p_payload);
  elsif p_op = 'supplier.update' then
    v_result := public.sync_supplier_update(p_payload);
  elsif p_op = 'po.create' then
    v_result := public.sync_po_create(p_payload);
  elsif p_op = 'po.update' then
    v_result := public.sync_po_update(p_payload);
  elsif p_op = 'po.status' then
    v_result := public.sync_po_status(p_payload);
  elsif p_op = 'po.cancel' then
    v_result := public.sync_po_cancel(p_payload);
  elsif p_op = 'po.payment' then
    v_result := public.sync_po_payment(p_payload);
  elsif p_op = 'grn.receive' then
    v_result := public.sync_grn_receive(p_payload);
  elsif p_op = 'purchase_return.create' then
    v_result := public.sync_purchase_return_create(p_payload);
  elsif p_op = 'supplier.payable_payment' then
    v_result := public.sync_supplier_payable_payment(p_payload);
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
  public.sync_supplier_create(jsonb),
  public.sync_supplier_update(jsonb),
  public.sync_po_create(jsonb),
  public.sync_po_update(jsonb),
  public.sync_po_status(jsonb),
  public.sync_po_cancel(jsonb),
  public.sync_po_payment(jsonb),
  public.sync_grn_receive(jsonb),
  public.sync_purchase_return_create(jsonb),
  public.sync_supplier_payable_payment(jsonb)
from public, anon, authenticated;

revoke all on function public.sync_apply(uuid, text, jsonb) from public, anon;
grant execute on function public.sync_apply(uuid, text, jsonb) to authenticated;
