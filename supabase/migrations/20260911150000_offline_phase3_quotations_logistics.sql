-- Offline Phase 3: quotations, deliveries, logistics, master data (2026-09-11)
--
-- The remaining business operations queue offline: quotation lifecycle
-- (create/edit/status/convert/delete), deliveries (create/edit/status),
-- projects, warehouses, stock transfers, customer notes, and product
-- deactivation. The quotation→invoice conversion wraps the atomic
-- convert_quotation_to_invoice RPC; stock transfers replicate the page flow
-- (movements + transfer_fifo_batches + counters) in one transaction.

-- ---------------------------------------------------------------------------
-- quotation.create — header + items + cost-price snapshot.
-- ---------------------------------------------------------------------------
create or replace function public.sync_quotation_create(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer uuid;
  v_number   text;
  v_id       uuid;
begin
  v_customer := (p_payload->>'customer_id')::uuid;
  if v_customer is null then
    raise exception 'quotation.create: customer_id is required';
  end if;
  if p_payload->'items' is null or jsonb_array_length(p_payload->'items') = 0 then
    raise exception 'quotation.create: items array is required';
  end if;

  v_number := public.generate_quotation_number();

  if p_payload ? 'id' then
    insert into quotations (id, quote_number, customer_id, issue_date, expiry_date,
      subtotal, cart_discount_percent, extra_discount, discount_amount, tax_amount,
      shipping_cost, total_amount, status, notes, reference)
    values ((p_payload->>'id')::uuid, v_number, v_customer,
      coalesce(nullif(p_payload->>'issue_date', '')::date, current_date),
      nullif(p_payload->>'expiry_date', '')::date,
      coalesce((p_payload->>'subtotal')::numeric, 0),
      coalesce((p_payload->>'cart_discount_percent')::numeric, 0),
      coalesce((p_payload->>'extra_discount')::numeric, 0),
      coalesce((p_payload->>'discount_amount')::numeric, 0),
      coalesce((p_payload->>'tax_amount')::numeric, 0),
      coalesce((p_payload->>'shipping_cost')::numeric, 0),
      coalesce((p_payload->>'total_amount')::numeric, 0),
      coalesce(p_payload->>'status', 'draft'),
      nullif(p_payload->>'notes', ''),
      nullif(p_payload->>'reference', ''))
    returning id into v_id;
  else
    insert into quotations (quote_number, customer_id, issue_date, expiry_date,
      subtotal, cart_discount_percent, extra_discount, discount_amount, tax_amount,
      shipping_cost, total_amount, status, notes, reference)
    values (v_number, v_customer,
      coalesce(nullif(p_payload->>'issue_date', '')::date, current_date),
      nullif(p_payload->>'expiry_date', '')::date,
      coalesce((p_payload->>'subtotal')::numeric, 0),
      coalesce((p_payload->>'cart_discount_percent')::numeric, 0),
      coalesce((p_payload->>'extra_discount')::numeric, 0),
      coalesce((p_payload->>'discount_amount')::numeric, 0),
      coalesce((p_payload->>'tax_amount')::numeric, 0),
      coalesce((p_payload->>'shipping_cost')::numeric, 0),
      coalesce((p_payload->>'total_amount')::numeric, 0),
      coalesce(p_payload->>'status', 'draft'),
      nullif(p_payload->>'notes', ''),
      nullif(p_payload->>'reference', ''))
    returning id into v_id;
  end if;

  insert into quotation_items (quotation_id, product_id, quantity, unit_price,
    discount_percent, tax_rate, subtotal, unit_name, unit_conversion_factor,
    base_quantity, warehouse_id)
  select v_id,
    (r->>'product_id')::uuid,
    (r->>'quantity')::numeric,
    (r->>'unit_price')::numeric,
    coalesce((r->>'discount_percent')::numeric, 0),
    coalesce((r->>'tax_rate')::numeric, 0),
    (r->>'subtotal')::numeric,
    nullif(r->>'unit_name', ''),
    nullif(r->>'unit_conversion_factor', '')::numeric,
    (r->>'base_quantity')::numeric,
    nullif(r->>'warehouse_id', '')::uuid
  from jsonb_array_elements(p_payload->'items') r;

  insert into cost_price_history (product_id, product_name, product_sku, quotation_id,
    unit, quantity, unit_price, cost_price_per_qty, cost_price_for_added_qty,
    total_cost_price_single, total_cost_price_added)
  select (r->>'product_id')::uuid,
    r->>'product_name',
    coalesce(r->>'product_sku', ''),
    v_id,
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

  return jsonb_build_object('status', 'synced', 'quotation_id', v_id, 'quote_number', v_number);
end;
$$;

-- ---------------------------------------------------------------------------
-- quotation.update — version-checked edit: fields, items + cost history
-- replaced (mirror of the edit modal).
-- ---------------------------------------------------------------------------
create or replace function public.sync_quotation_update(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_q quotations%rowtype;
begin
  select * into v_q from quotations where id = (p_payload->>'id')::uuid for update;
  if not found then
    raise exception 'quotation.update: quotation not found';
  end if;

  if coalesce((p_payload->>'force')::boolean, false) = false
     and p_payload ? 'expected_updated_at'
     and p_payload->>'expected_updated_at' <> ''
     and v_q.updated_at <> (p_payload->>'expected_updated_at')::timestamptz then
    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'Quotation changed on the server since this device last saw it',
      'server_row', to_jsonb(v_q)
    );
  end if;

  update quotations set
    customer_id  = (p_payload->>'customer_id')::uuid,
    issue_date   = coalesce(nullif(p_payload->>'issue_date', '')::date, issue_date),
    expiry_date  = nullif(p_payload->>'expiry_date', '')::date,
    subtotal     = coalesce((p_payload->>'subtotal')::numeric, 0),
    cart_discount_percent = coalesce((p_payload->>'cart_discount_percent')::numeric, 0),
    extra_discount = coalesce((p_payload->>'extra_discount')::numeric, 0),
    discount_amount = coalesce((p_payload->>'discount_amount')::numeric, 0),
    tax_amount   = coalesce((p_payload->>'tax_amount')::numeric, 0),
    shipping_cost = coalesce((p_payload->>'shipping_cost')::numeric, 0),
    total_amount = coalesce((p_payload->>'total_amount')::numeric, 0),
    notes        = nullif(p_payload->>'notes', ''),
    reference    = nullif(p_payload->>'reference', ''),
    updated_at   = now()
  where id = v_q.id;

  delete from quotation_items where quotation_id = v_q.id;
  delete from cost_price_history where quotation_id = v_q.id;

  insert into quotation_items (quotation_id, product_id, quantity, unit_price,
    discount_percent, tax_rate, subtotal, unit_name, unit_conversion_factor,
    base_quantity, warehouse_id)
  select v_q.id,
    (r->>'product_id')::uuid,
    (r->>'quantity')::numeric,
    (r->>'unit_price')::numeric,
    coalesce((r->>'discount_percent')::numeric, 0),
    coalesce((r->>'tax_rate')::numeric, 0),
    (r->>'subtotal')::numeric,
    nullif(r->>'unit_name', ''),
    nullif(r->>'unit_conversion_factor', '')::numeric,
    (r->>'base_quantity')::numeric,
    nullif(r->>'warehouse_id', '')::uuid
  from jsonb_array_elements(p_payload->'items') r;

  insert into cost_price_history (product_id, product_name, product_sku, quotation_id,
    unit, quantity, unit_price, cost_price_per_qty, cost_price_for_added_qty,
    total_cost_price_single, total_cost_price_added)
  select (r->>'product_id')::uuid,
    r->>'product_name',
    coalesce(r->>'product_sku', ''),
    v_q.id,
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

  return jsonb_build_object('status', 'synced', 'quotation_id', v_q.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- quotation.status — version-checked status change.
-- ---------------------------------------------------------------------------
create or replace function public.sync_quotation_status(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_q      quotations%rowtype;
  v_status text := p_payload->>'status';
begin
  if v_status not in ('draft', 'sent', 'accepted', 'rejected', 'expired', 'cancelled', 'converted') then
    raise exception 'quotation.status: invalid status %', v_status;
  end if;

  select * into v_q from quotations where id = (p_payload->>'id')::uuid for update;
  if not found then
    raise exception 'quotation.status: quotation not found';
  end if;

  if coalesce((p_payload->>'force')::boolean, false) = false
     and p_payload ? 'expected_updated_at'
     and p_payload->>'expected_updated_at' <> ''
     and v_q.updated_at <> (p_payload->>'expected_updated_at')::timestamptz then
    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'Quotation changed on the server since this device last saw it',
      'server_row', to_jsonb(v_q)
    );
  end if;

  update quotations set status = v_status, updated_at = now() where id = v_q.id;

  return jsonb_build_object('status', 'synced', 'quotation_id', v_q.id, 'quotation_status', v_status);
end;
$$;

-- ---------------------------------------------------------------------------
-- quotation.delete — items + cost history + header.
-- ---------------------------------------------------------------------------
create or replace function public.sync_quotation_delete(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := (p_payload->>'id')::uuid;
begin
  delete from quotation_items where quotation_id = v_id;
  delete from cost_price_history where quotation_id = v_id;
  delete from quotations where id = v_id;
  return jsonb_build_object('status', 'synced', 'quotation_id', v_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- quotation.convert — wraps the atomic convert_quotation_to_invoice RPC
-- (derives sale-unit costs server-side, posts invoice + items + payment).
-- ---------------------------------------------------------------------------
create or replace function public.sync_quotation_convert(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res jsonb;
begin
  v_res := public.convert_quotation_to_invoice(
    (p_payload->>'quotation_id')::uuid,
    coalesce(p_payload->'options', '{}'::jsonb));

  return v_res || jsonb_build_object('status', 'synced');
end;
$$;

-- ---------------------------------------------------------------------------
-- delivery.create — header + optional invoice-item copy (server-side read).
-- ---------------------------------------------------------------------------
create or replace function public.sync_delivery_create(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_number text;
  v_id     uuid;
  v_invoice uuid := nullif(p_payload->>'invoice_id', '')::uuid;
begin
  v_number := public.generate_delivery_number();

  if p_payload ? 'id' then
    insert into deliveries (id, delivery_number, customer_id, invoice_id, delivery_date,
      delivery_address, delivery_city, vehicle_number, notes, status)
    values ((p_payload->>'id')::uuid, v_number,
      nullif(p_payload->>'customer_id', '')::uuid, v_invoice,
      nullif(p_payload->>'delivery_date', '')::date,
      nullif(p_payload->>'delivery_address', ''),
      nullif(p_payload->>'delivery_city', ''),
      nullif(p_payload->>'vehicle_number', ''),
      nullif(p_payload->>'notes', ''),
      coalesce(p_payload->>'status', 'pending'))
    returning id into v_id;
  else
    insert into deliveries (delivery_number, customer_id, invoice_id, delivery_date,
      delivery_address, delivery_city, vehicle_number, notes, status)
    values (v_number,
      nullif(p_payload->>'customer_id', '')::uuid, v_invoice,
      nullif(p_payload->>'delivery_date', '')::date,
      nullif(p_payload->>'delivery_address', ''),
      nullif(p_payload->>'delivery_city', ''),
      nullif(p_payload->>'vehicle_number', ''),
      nullif(p_payload->>'notes', ''),
      coalesce(p_payload->>'status', 'pending'))
    returning id into v_id;
  end if;

  if v_invoice is not null then
    insert into delivery_items (delivery_id, product_id, quantity, delivered_quantity, unit_name)
    select v_id, product_id, quantity, quantity, unit_name
    from invoice_items where invoice_id = v_invoice;
  end if;

  return jsonb_build_object('status', 'synced', 'delivery_id', v_id, 'delivery_number', v_number);
end;
$$;

-- ---------------------------------------------------------------------------
-- delivery.update — version-checked edit (fields only; items copied at
-- creation stay).
-- ---------------------------------------------------------------------------
create or replace function public.sync_delivery_update(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_d deliveries%rowtype;
begin
  select * into v_d from deliveries where id = (p_payload->>'id')::uuid for update;
  if not found then
    raise exception 'delivery.update: delivery not found';
  end if;

  if coalesce((p_payload->>'force')::boolean, false) = false
     and p_payload ? 'expected_updated_at'
     and p_payload->>'expected_updated_at' <> ''
     and v_d.updated_at <> (p_payload->>'expected_updated_at')::timestamptz then
    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'Delivery changed on the server since this device last saw it',
      'server_row', to_jsonb(v_d)
    );
  end if;

  update deliveries set
    delivery_date   = nullif(p_payload->>'delivery_date', '')::date,
    delivery_address = nullif(p_payload->>'delivery_address', ''),
    delivery_city   = nullif(p_payload->>'delivery_city', ''),
    vehicle_number  = nullif(p_payload->>'vehicle_number', ''),
    notes           = nullif(p_payload->>'notes', ''),
    updated_at      = now()
  where id = v_d.id;

  return jsonb_build_object('status', 'synced', 'delivery_id', v_d.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- delivery.status — status change; sets delivered_at when delivered.
-- ---------------------------------------------------------------------------
create or replace function public.sync_delivery_status(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text := p_payload->>'status';
begin
  if v_status not in ('pending', 'assigned', 'in_transit', 'delivered', 'failed', 'returned', 'cancelled') then
    raise exception 'delivery.status: invalid status %', v_status;
  end if;

  update deliveries set
    status = v_status,
    delivered_at = case when v_status = 'delivered' then now() else delivered_at end,
    updated_at = now()
  where id = (p_payload->>'id')::uuid;

  if not found then
    raise exception 'delivery.status: delivery not found';
  end if;

  return jsonb_build_object('status', 'synced', 'delivery_status', v_status);
end;
$$;

-- ---------------------------------------------------------------------------
-- project.create / update / delete — simple master data (no accounting).
-- ---------------------------------------------------------------------------
create or replace function public.sync_project_create(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  d   jsonb := p_payload->'data';
  v_id uuid;
begin
  if p_payload ? 'id' then
    insert into projects (id, name, project_number, customer_id, status, priority,
      start_date, end_date, estimated_budget, actual_cost, revenue, progress_percent,
      location, description)
    values ((p_payload->>'id')::uuid, d->>'name', d->>'project_number',
      nullif(d->>'customer_id', '')::uuid, coalesce(d->>'status', 'planning'),
      coalesce(d->>'priority', 'medium'),
      nullif(d->>'start_date', '')::date, nullif(d->>'end_date', '')::date,
      nullif(d->>'estimated_budget', '')::numeric,
      coalesce(nullif(d->>'actual_cost', '')::numeric, 0),
      coalesce(nullif(d->>'revenue', '')::numeric, 0),
      coalesce(nullif(d->>'progress_percent', '')::numeric, 0),
      nullif(d->>'location', ''), nullif(d->>'description', ''))
    returning id into v_id;
  else
    insert into projects (name, project_number, customer_id, status, priority,
      start_date, end_date, estimated_budget, actual_cost, revenue, progress_percent,
      location, description)
    values (d->>'name', d->>'project_number',
      nullif(d->>'customer_id', '')::uuid, coalesce(d->>'status', 'planning'),
      coalesce(d->>'priority', 'medium'),
      nullif(d->>'start_date', '')::date, nullif(d->>'end_date', '')::date,
      nullif(d->>'estimated_budget', '')::numeric,
      coalesce(nullif(d->>'actual_cost', '')::numeric, 0),
      coalesce(nullif(d->>'revenue', '')::numeric, 0),
      coalesce(nullif(d->>'progress_percent', '')::numeric, 0),
      nullif(d->>'location', ''), nullif(d->>'description', ''))
    returning id into v_id;
  end if;

  return jsonb_build_object('status', 'synced', 'project_id', v_id);
end;
$$;

create or replace function public.sync_project_update(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  d     jsonb := p_payload->'data';
  v_row projects%rowtype;
begin
  select * into v_row from projects where id = (p_payload->>'id')::uuid for update;
  if not found then
    raise exception 'project.update: project not found';
  end if;

  if coalesce((p_payload->>'force')::boolean, false) = false
     and p_payload ? 'expected_updated_at'
     and p_payload->>'expected_updated_at' <> ''
     and v_row.updated_at <> (p_payload->>'expected_updated_at')::timestamptz then
    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'Project changed on the server since this device last saw it',
      'server_row', to_jsonb(v_row)
    );
  end if;

  update projects set
    name = case when d ? 'name' then d->>'name' else projects.name end,
    customer_id = case when d ? 'customer_id' then nullif(d->>'customer_id', '')::uuid else projects.customer_id end,
    status = case when d ? 'status' then d->>'status' else projects.status end,
    priority = case when d ? 'priority' then d->>'priority' else projects.priority end,
    start_date = case when d ? 'start_date' then nullif(d->>'start_date', '')::date else projects.start_date end,
    end_date = case when d ? 'end_date' then nullif(d->>'end_date', '')::date else projects.end_date end,
    estimated_budget = case when d ? 'estimated_budget' then nullif(d->>'estimated_budget', '')::numeric else projects.estimated_budget end,
    actual_cost = case when d ? 'actual_cost' then coalesce(nullif(d->>'actual_cost', '')::numeric, 0) else projects.actual_cost end,
    progress_percent = case when d ? 'progress_percent' then coalesce(nullif(d->>'progress_percent', '')::numeric, 0) else projects.progress_percent end,
    location = case when d ? 'location' then nullif(d->>'location', '') else projects.location end,
    description = case when d ? 'description' then nullif(d->>'description', '') else projects.description end,
    updated_at = now()
  where id = v_row.id;

  return jsonb_build_object('status', 'synced', 'project_id', v_row.id);
end;
$$;

create or replace function public.sync_project_delete(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from projects where id = (p_payload->>'id')::uuid;
  return jsonb_build_object('status', 'synced');
end;
$$;

-- ---------------------------------------------------------------------------
-- warehouse.create / update — storage locations (deactivate = update).
-- ---------------------------------------------------------------------------
create or replace function public.sync_warehouse_create(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  d   jsonb := p_payload->'data';
  v_id uuid;
begin
  if p_payload ? 'id' then
    insert into warehouses (id, name, code, address, city, is_default, is_active)
    values ((p_payload->>'id')::uuid, d->>'name', d->>'code',
      nullif(d->>'address', ''), nullif(d->>'city', ''),
      coalesce((d->>'is_default')::boolean, false),
      coalesce((d->>'is_active')::boolean, true))
    returning id into v_id;
  else
    insert into warehouses (name, code, address, city, is_default, is_active)
    values (d->>'name', d->>'code',
      nullif(d->>'address', ''), nullif(d->>'city', ''),
      coalesce((d->>'is_default')::boolean, false),
      coalesce((d->>'is_active')::boolean, true))
    returning id into v_id;
  end if;

  return jsonb_build_object('status', 'synced', 'warehouse_id', v_id);
end;
$$;

create or replace function public.sync_warehouse_update(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  d jsonb := p_payload->'data';
begin
  update warehouses set
    name = case when d ? 'name' then d->>'name' else warehouses.name end,
    code = case when d ? 'code' then d->>'code' else warehouses.code end,
    address = case when d ? 'address' then nullif(d->>'address', '') else warehouses.address end,
    city = case when d ? 'city' then nullif(d->>'city', '') else warehouses.city end,
    is_default = case when d ? 'is_default' then coalesce((d->>'is_default')::boolean, false) else warehouses.is_default end,
    is_active = case when d ? 'is_active' then coalesce((d->>'is_active')::boolean, true) else warehouses.is_active end
  where id = (p_payload->>'id')::uuid;

  if not found then
    raise exception 'warehouse.update: warehouse not found';
  end if;

  return jsonb_build_object('status', 'synced');
end;
$$;

-- ---------------------------------------------------------------------------
-- stock_transfer.create — atomic replication of the transfers page: out and
-- in movements, transfer_fifo_batches (true cost layers move warehouses),
-- counter updates. Client already generates the transfer id.
-- ---------------------------------------------------------------------------
create or replace function public.sync_stock_transfer_create(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id      uuid := (p_payload->>'id')::uuid;
  v_number  text := p_payload->>'transfer_number';
  v_product uuid := (p_payload->>'product_id')::uuid;
  v_from    uuid := (p_payload->>'from_warehouse_id')::uuid;
  v_to      uuid := (p_payload->>'to_warehouse_id')::uuid;
  v_qty     numeric := (p_payload->>'quantity')::numeric;
  v_cost    numeric := coalesce((p_payload->>'unit_cost')::numeric, 0);
  v_notes   text;
  v_inv_id  uuid;
begin
  if v_qty is null or v_qty <= 0 then
    raise exception 'stock_transfer.create: quantity must be greater than 0';
  end if;
  if v_from = v_to then
    raise exception 'stock_transfer.create: source and destination warehouse are the same';
  end if;

  insert into stock_movements (tenant_id, product_id, warehouse_id, movement_type,
    quantity, unit_cost, reference_type, reference_id, reference_number, notes)
  values ('00000000-0000-0000-0000-000000000001', v_product, v_from, 'transfer_out',
    -v_qty, v_cost, 'transfer', v_id, v_number,
    coalesce(nullif(p_payload->>'notes', ''), 'Transfer out'));

  insert into stock_movements (tenant_id, product_id, warehouse_id, movement_type,
    quantity, unit_cost, reference_type, reference_id, reference_number, notes)
  values ('00000000-0000-0000-0000-000000000001', v_product, v_to, 'transfer_in',
    v_qty, v_cost, 'transfer', v_id, v_number,
    coalesce(nullif(p_payload->>'notes', ''), 'Transfer in'));

  perform public.transfer_fifo_batches(v_product, v_from, v_to, v_qty, v_id, v_number);

  update inventory_items set
    quantity_on_hand = quantity_on_hand - v_qty,
    updated_at = now()
  where product_id = v_product and warehouse_id = v_from;

  select id into v_inv_id from inventory_items
  where product_id = v_product and warehouse_id = v_to limit 1;
  if v_inv_id is not null then
    update inventory_items set
      quantity_on_hand = quantity_on_hand + v_qty,
      updated_at = now()
    where id = v_inv_id;
  else
    insert into inventory_items (tenant_id, product_id, warehouse_id, quantity_on_hand)
    values ('00000000-0000-0000-0000-000000000001', v_product, v_to, v_qty);
  end if;

  return jsonb_build_object('status', 'synced', 'transfer_id', v_id,
    'transfer_number', v_number);
end;
$$;

-- ---------------------------------------------------------------------------
-- product.status — version-checked is_active update (deactivate).
-- ---------------------------------------------------------------------------
create or replace function public.sync_product_status(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row products%rowtype;
begin
  select * into v_row from products where id = (p_payload->>'id')::uuid for update;
  if not found then
    raise exception 'product.status: product not found';
  end if;

  if coalesce((p_payload->>'force')::boolean, false) = false
     and p_payload ? 'expected_updated_at'
     and p_payload->>'expected_updated_at' <> ''
     and v_row.updated_at <> (p_payload->>'expected_updated_at')::timestamptz then
    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'Product changed on the server since this device last saw it',
      'server_row', to_jsonb(v_row)
    );
  end if;

  update products set
    is_active = coalesce((p_payload->>'is_active')::boolean, false),
    updated_at = now()
  where id = v_row.id;

  return jsonb_build_object('status', 'synced', 'product_id', v_row.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- customer_note.create / delete — CRM notes.
-- ---------------------------------------------------------------------------
create or replace function public.sync_customer_note_create(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if nullif(p_payload->>'note', '') is null then
    raise exception 'customer_note.create: note is required';
  end if;

  if p_payload ? 'id' then
    insert into customer_notes (id, customer_id, note, note_type)
    values ((p_payload->>'id')::uuid, (p_payload->>'customer_id')::uuid,
      p_payload->>'note', coalesce(p_payload->>'note_type', 'general'))
    returning id into v_id;
  else
    insert into customer_notes (customer_id, note, note_type)
    values ((p_payload->>'customer_id')::uuid,
      p_payload->>'note', coalesce(p_payload->>'note_type', 'general'))
    returning id into v_id;
  end if;

  return jsonb_build_object('status', 'synced', 'note_id', v_id);
end;
$$;

create or replace function public.sync_customer_note_delete(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from customer_notes where id = (p_payload->>'id')::uuid;
  return jsonb_build_object('status', 'synced');
end;
$$;

-- ---------------------------------------------------------------------------
-- Dispatcher — Phase 3 ops.
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
  elsif p_op = 'quotation.create' then
    v_result := public.sync_quotation_create(p_payload);
  elsif p_op = 'quotation.update' then
    v_result := public.sync_quotation_update(p_payload);
  elsif p_op = 'quotation.status' then
    v_result := public.sync_quotation_status(p_payload);
  elsif p_op = 'quotation.delete' then
    v_result := public.sync_quotation_delete(p_payload);
  elsif p_op = 'quotation.convert' then
    v_result := public.sync_quotation_convert(p_payload);
  elsif p_op = 'delivery.create' then
    v_result := public.sync_delivery_create(p_payload);
  elsif p_op = 'delivery.update' then
    v_result := public.sync_delivery_update(p_payload);
  elsif p_op = 'delivery.status' then
    v_result := public.sync_delivery_status(p_payload);
  elsif p_op = 'project.create' then
    v_result := public.sync_project_create(p_payload);
  elsif p_op = 'project.update' then
    v_result := public.sync_project_update(p_payload);
  elsif p_op = 'project.delete' then
    v_result := public.sync_project_delete(p_payload);
  elsif p_op = 'warehouse.create' then
    v_result := public.sync_warehouse_create(p_payload);
  elsif p_op = 'warehouse.update' then
    v_result := public.sync_warehouse_update(p_payload);
  elsif p_op = 'stock_transfer.create' then
    v_result := public.sync_stock_transfer_create(p_payload);
  elsif p_op = 'product.status' then
    v_result := public.sync_product_status(p_payload);
  elsif p_op = 'customer_note.create' then
    v_result := public.sync_customer_note_create(p_payload);
  elsif p_op = 'customer_note.delete' then
    v_result := public.sync_customer_note_delete(p_payload);
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
  public.sync_quotation_create(jsonb),
  public.sync_quotation_update(jsonb),
  public.sync_quotation_status(jsonb),
  public.sync_quotation_delete(jsonb),
  public.sync_quotation_convert(jsonb),
  public.sync_delivery_create(jsonb),
  public.sync_delivery_update(jsonb),
  public.sync_delivery_status(jsonb),
  public.sync_project_create(jsonb),
  public.sync_project_update(jsonb),
  public.sync_project_delete(jsonb),
  public.sync_warehouse_create(jsonb),
  public.sync_warehouse_update(jsonb),
  public.sync_stock_transfer_create(jsonb),
  public.sync_product_status(jsonb),
  public.sync_customer_note_create(jsonb),
  public.sync_customer_note_delete(jsonb)
from public, anon, authenticated;

revoke all on function public.sync_apply(uuid, text, jsonb) from public, anon;
grant execute on function public.sync_apply(uuid, text, jsonb) to authenticated;
