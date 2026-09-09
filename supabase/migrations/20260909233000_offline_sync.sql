-- Offline sync infrastructure (2026-09-09)
--
-- Server half of the offline-first layer. The browser queues mutations in an
-- encrypted local outbox while offline; when connectivity returns the sync
-- engine replays them through public.sync_apply(p_item_id, p_op, p_payload).
--
-- Idempotency: every outbox item carries a client-generated UUID
-- (p_item_id). sync_applied_items has a PK on (user_id, item_id); the claim
-- insert and the operation itself share one transaction, so:
--   * apply succeeds  -> claim + result persist; a redelivery of the same
--                        item_id returns the stored result as {"status":"duplicate"}
--   * apply raises     -> the whole transaction (claim included) rolls back;
--                        the engine retries safely
--   * conflict         -> the handler returns {"status":"conflict","server_row":…}
--                        WITHOUT persisting the claim, so a forced retry of the
--                        same item id re-executes
--
-- Conflict policy: updates carry expected_updated_at (the updated_at the
-- client last saw). A mismatch means the row changed server-side since the
-- cache snapshot; the handler reports the server row and applies nothing.
-- payload.force = true skips the version check ("overwrite server" resolve).

-- employees lacked a version column entirely
alter table public.employees
  add column if not exists updated_at timestamptz not null default now();

-- ---------------------------------------------------------------------------
-- Idempotency ledger
-- ---------------------------------------------------------------------------
create table if not exists public.sync_applied_items (
  user_id    uuid not null,
  item_id    uuid not null,
  op         text not null,
  applied_at timestamptz not null default now(),
  result     jsonb not null default '{}'::jsonb,
  primary key (user_id, item_id)
);

alter table public.sync_applied_items enable row level security;

drop policy if exists sync_applied_select on public.sync_applied_items;
create policy sync_applied_select on public.sync_applied_items
  for select to authenticated
  using (auth.uid() = user_id);

grant select on public.sync_applied_items to authenticated;

-- ---------------------------------------------------------------------------
-- invoice.create — replicates POS processOrder() server-side, atomically:
-- generate_pos_number -> invoices -> invoice_items (triggers consume FIFO,
-- post COGS/AR journals) -> cost_price_history -> store-credit redemptions +
-- PAY-SC payment -> cash/card payment.
-- ---------------------------------------------------------------------------
create or replace function public.sync_invoice_create(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_number     text;
  v_invoice_id uuid;
  v_customer   uuid;
  v_date       date;
  v_store_credit numeric;
  v_cash       numeric;
  v_remaining  numeric;
  v_redeem     numeric;
  v_scnum      text;
  v_pnum       text;
  v_credit     record;
begin
  v_customer     := (p_payload->>'customer_id')::uuid;
  v_date         := (p_payload->>'invoice_date')::date;
  v_store_credit := coalesce((p_payload->>'store_credit_amount')::numeric, 0);
  v_cash         := coalesce((p_payload->'cash_payment'->>'amount')::numeric, 0);

  if v_customer is null then
    raise exception 'invoice.create: customer_id is required';
  end if;
  if p_payload->'items' is null or jsonb_array_length(p_payload->'items') = 0 then
    raise exception 'invoice.create: items array is required';
  end if;

  v_number := public.generate_pos_number();

  insert into invoices (invoice_number, customer_id, invoice_date, subtotal, discount_amount,
    cart_discount_percent, extra_discount, tax_amount, shipping_cost, total_amount, amount_paid,
    status, is_pos, reference)
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
    nullif(p_payload->>'reference', ''))
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

-- ---------------------------------------------------------------------------
-- product.create — replicates the Products page handleSave() create path:
-- products insert, variant rows, then opening stock per warehouse
-- (inventory_items + stock_movements 'opening' + create_opening_batch).
-- ---------------------------------------------------------------------------
create or replace function public.sync_product_create(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  d            jsonb := p_payload->'data';
  v_pid        uuid;
  v_tenant     uuid;
  v_qty        numeric;
  v_unit_cost  numeric;
  v_stock      record;
begin
  -- Optional client-generated id: lets an offline-created product be
  -- referenced by later queued operations (e.g. an offline POS sale).
  if p_payload ? 'id' then
    insert into products (id, name, sku, unit, base_unit, enable_multi_unit, enable_colors, enable_sizes,
      cost_price, sale_price, category_id, brand_id, min_stock_level, description, is_active,
      barcode_label_size, barcode_label_width, barcode_label_height)
    values ((p_payload->>'id')::uuid, d->>'name', d->>'sku', d->>'unit', d->>'base_unit',
      coalesce((d->>'enable_multi_unit')::boolean, false),
      coalesce((d->>'enable_colors')::boolean, false),
      coalesce((d->>'enable_sizes')::boolean, false),
      coalesce((d->>'cost_price')::numeric, 0),
      coalesce((d->>'sale_price')::numeric, 0),
      nullif(d->>'category_id', '')::uuid,
      nullif(d->>'brand_id', '')::uuid,
      coalesce((d->>'min_stock_level')::numeric, 0),
      nullif(d->>'description', ''),
      coalesce((d->>'is_active')::boolean, true),
      nullif(d->>'barcode_label_size', ''),
      nullif(d->>'barcode_label_width', '')::numeric,
      nullif(d->>'barcode_label_height', '')::numeric)
    returning id, tenant_id into v_pid, v_tenant;
  else
    insert into products (name, sku, unit, base_unit, enable_multi_unit, enable_colors, enable_sizes,
      cost_price, sale_price, category_id, brand_id, min_stock_level, description, is_active,
      barcode_label_size, barcode_label_width, barcode_label_height)
    values (d->>'name', d->>'sku', d->>'unit', d->>'base_unit',
      coalesce((d->>'enable_multi_unit')::boolean, false),
      coalesce((d->>'enable_colors')::boolean, false),
      coalesce((d->>'enable_sizes')::boolean, false),
      coalesce((d->>'cost_price')::numeric, 0),
      coalesce((d->>'sale_price')::numeric, 0),
      nullif(d->>'category_id', '')::uuid,
      nullif(d->>'brand_id', '')::uuid,
      coalesce((d->>'min_stock_level')::numeric, 0),
      nullif(d->>'description', ''),
      coalesce((d->>'is_active')::boolean, true),
      nullif(d->>'barcode_label_size', ''),
      nullif(d->>'barcode_label_width', '')::numeric,
      nullif(d->>'barcode_label_height', '')::numeric)
    returning id, tenant_id into v_pid, v_tenant;
  end if;

  if coalesce((d->>'enable_colors')::boolean, false) then
    delete from product_colors where product_id = v_pid;
    insert into product_colors (product_id, name, hex_code, image_url, is_default, sort_order)
    select v_pid, r->>'name', r->>'hex_code', nullif(r->>'image_url', ''),
      coalesce((r->>'is_default')::boolean, false), coalesce((r->>'sort_order')::int, 0)
    from jsonb_array_elements(coalesce(p_payload->'colors', '[]'::jsonb)) r
    where nullif(r->>'name', '') is not null;
  end if;

  if coalesce((d->>'enable_sizes')::boolean, false) then
    delete from product_sizes where product_id = v_pid;
    insert into product_sizes (product_id, name, dimensions, is_default, sort_order)
    select v_pid, r->>'name', nullif(r->>'dimensions', ''),
      coalesce((r->>'is_default')::boolean, false), coalesce((r->>'sort_order')::int, 0)
    from jsonb_array_elements(coalesce(p_payload->'sizes', '[]'::jsonb)) r
    where nullif(r->>'name', '') is not null;
  end if;

  if coalesce((d->>'enable_multi_unit')::boolean, false) then
    delete from product_units where product_id = v_pid;
    insert into product_units (product_id, unit_name, unit_short, conversion_factor,
      is_base_unit, is_sale_unit, price, cost_price, barcode, sort_order, is_active)
    select v_pid, r->>'unit_name', nullif(r->>'unit_short', ''),
      coalesce((r->>'conversion_factor')::numeric, 1),
      coalesce((r->>'is_base_unit')::boolean, false),
      coalesce((r->>'is_sale_unit')::boolean, false),
      coalesce((r->>'price')::numeric, 0),
      coalesce((r->>'cost_price')::numeric, 0),
      nullif(r->>'barcode', ''),
      coalesce((r->>'sort_order')::int, 0),
      coalesce((r->>'is_active')::boolean, true)
    from jsonb_array_elements(coalesce(p_payload->'units', '[]'::jsonb)) r
    where nullif(r->>'unit_name', '') is not null;
  end if;

  -- Opening stock per warehouse
  for v_stock in
    select (r->>'warehouse_id')::uuid as warehouse_id,
           (r->>'quantity')::numeric as quantity,
           coalesce((r->>'unit_cost')::numeric, (d->>'cost_price')::numeric, 0) as unit_cost
    from jsonb_array_elements(coalesce(p_payload->'stock', '[]'::jsonb)) r
  loop
    continue when v_stock.quantity is null or v_stock.quantity <= 0;
    insert into inventory_items (tenant_id, product_id, warehouse_id, quantity_on_hand)
    values (v_tenant, v_pid, v_stock.warehouse_id, v_stock.quantity);

    insert into stock_movements (tenant_id, product_id, warehouse_id, movement_type, quantity,
      unit_cost, reference_type, reference_id, notes)
    values (v_tenant, v_pid, v_stock.warehouse_id, 'opening', v_stock.quantity,
      v_stock.unit_cost, 'product_creation', v_pid, 'Initial stock on product creation');

    perform public.create_opening_batch(
      v_pid, v_stock.warehouse_id, v_stock.quantity, v_stock.unit_cost,
      'opening', 'product_creation', v_pid, 'Initial stock on product creation');
  end loop;

  return jsonb_build_object('status', 'synced', 'product_id', v_pid);
end;
$$;

-- ---------------------------------------------------------------------------
-- product.update — same as create for the products row + variants, then stock
-- adjustments: the client sends TARGET per-warehouse quantities; the diff is
-- recomputed against the server's inventory_items so a stale offline baseline
-- can never corrupt the adjustment. Increases post adjustment batches
-- (Dr 1200 / Cr 3900); decreases go through create_stock_reduction.
-- ---------------------------------------------------------------------------
create or replace function public.sync_product_update(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  d          jsonb := p_payload->'data';
  v_pid      uuid  := (p_payload->>'id')::uuid;
  v_tenant   uuid;
  v_server_row jsonb;
  v_current  numeric;
  v_diff     numeric;
  v_inv_id   uuid;
  v_stock    record;
begin
  select to_jsonb(p), p.tenant_id into v_server_row, v_tenant
  from products p where p.id = v_pid;

  if v_server_row is null then
    return jsonb_build_object('status', 'conflict', 'reason', 'missing',
      'server_row', 'null'::jsonb);
  end if;

  if not coalesce((p_payload->>'force')::boolean, false)
     and p_payload ? 'expected_updated_at'
     and (p_payload->>'expected_updated_at')::timestamptz
         is distinct from (v_server_row->>'updated_at')::timestamptz then
    return jsonb_build_object('status', 'conflict', 'reason', 'version_mismatch',
      'server_row', v_server_row);
  end if;

  update products set
    name = d->>'name', sku = d->>'sku', unit = d->>'unit', base_unit = d->>'base_unit',
    enable_multi_unit = coalesce((d->>'enable_multi_unit')::boolean, false),
    enable_colors = coalesce((d->>'enable_colors')::boolean, false),
    enable_sizes = coalesce((d->>'enable_sizes')::boolean, false),
    cost_price = coalesce((d->>'cost_price')::numeric, 0),
    sale_price = coalesce((d->>'sale_price')::numeric, 0),
    category_id = nullif(d->>'category_id', '')::uuid,
    brand_id = nullif(d->>'brand_id', '')::uuid,
    min_stock_level = coalesce((d->>'min_stock_level')::numeric, 0),
    description = nullif(d->>'description', ''),
    is_active = coalesce((d->>'is_active')::boolean, true),
    barcode_label_size = nullif(d->>'barcode_label_size', ''),
    barcode_label_width = nullif(d->>'barcode_label_width', '')::numeric,
    barcode_label_height = nullif(d->>'barcode_label_height', '')::numeric,
    updated_at = now()
  where id = v_pid;

  if coalesce((d->>'enable_colors')::boolean, false)
     and jsonb_array_length(coalesce(p_payload->'colors', '[]'::jsonb)) > 0 then
    delete from product_colors where product_id = v_pid;
    insert into product_colors (product_id, name, hex_code, image_url, is_default, sort_order)
    select v_pid, r->>'name', r->>'hex_code', nullif(r->>'image_url', ''),
      coalesce((r->>'is_default')::boolean, false), coalesce((r->>'sort_order')::int, 0)
    from jsonb_array_elements(p_payload->'colors') r
    where nullif(r->>'name', '') is not null;
  end if;

  if coalesce((d->>'enable_sizes')::boolean, false)
     and jsonb_array_length(coalesce(p_payload->'sizes', '[]'::jsonb)) > 0 then
    delete from product_sizes where product_id = v_pid;
    insert into product_sizes (product_id, name, dimensions, is_default, sort_order)
    select v_pid, r->>'name', nullif(r->>'dimensions', ''),
      coalesce((r->>'is_default')::boolean, false), coalesce((r->>'sort_order')::int, 0)
    from jsonb_array_elements(p_payload->'sizes') r
    where nullif(r->>'name', '') is not null;
  end if;

  if coalesce((d->>'enable_multi_unit')::boolean, false)
     and jsonb_array_length(coalesce(p_payload->'units', '[]'::jsonb)) > 0 then
    delete from product_units where product_id = v_pid;
    insert into product_units (product_id, unit_name, unit_short, conversion_factor,
      is_base_unit, is_sale_unit, price, cost_price, barcode, sort_order, is_active)
    select v_pid, r->>'unit_name', nullif(r->>'unit_short', ''),
      coalesce((r->>'conversion_factor')::numeric, 1),
      coalesce((r->>'is_base_unit')::boolean, false),
      coalesce((r->>'is_sale_unit')::boolean, false),
      coalesce((r->>'price')::numeric, 0),
      coalesce((r->>'cost_price')::numeric, 0),
      nullif(r->>'barcode', ''),
      coalesce((r->>'sort_order')::int, 0),
      coalesce((r->>'is_active')::boolean, true)
    from jsonb_array_elements(p_payload->'units') r
    where nullif(r->>'unit_name', '') is not null;
  end if;

  -- Stock adjustments against the server's current quantity
  for v_stock in
    select (r->>'warehouse_id')::uuid as warehouse_id,
           (r->>'quantity')::numeric as quantity,
           coalesce((r->>'unit_cost')::numeric, (d->>'cost_price')::numeric, 0) as unit_cost
    from jsonb_array_elements(coalesce(p_payload->'stock', '[]'::jsonb)) r
  loop
    continue when v_stock.quantity is null;
    select quantity_on_hand, id into v_current, v_inv_id
    from inventory_items
    where product_id = v_pid and warehouse_id = v_stock.warehouse_id
    order by created_at asc
    limit 1;

    v_diff := v_stock.quantity - coalesce(v_current, 0);
    continue when v_diff = 0;

    if v_inv_id is not null then
      update inventory_items set quantity_on_hand = v_stock.quantity, updated_at = now()
      where id = v_inv_id;
    else
      insert into inventory_items (tenant_id, product_id, warehouse_id, quantity_on_hand)
      values (v_tenant, v_pid, v_stock.warehouse_id, v_stock.quantity);
    end if;

    insert into stock_movements (tenant_id, product_id, warehouse_id, movement_type, quantity,
      unit_cost, reference_type, reference_id, notes)
    values (v_tenant, v_pid, v_stock.warehouse_id, 'adjustment', v_diff, v_stock.unit_cost,
      'stock_adjustment', v_pid,
      case when v_diff > 0 then 'Stock increase adjustment' else 'Stock decrease adjustment' end);

    if v_diff > 0 then
      perform public.create_opening_batch(
        v_pid, v_stock.warehouse_id, v_diff, v_stock.unit_cost,
        'adjustment', 'stock_adjustment', v_pid, 'Stock increase adjustment');
    else
      perform public.create_stock_reduction(
        v_pid, v_stock.warehouse_id, abs(v_diff), v_stock.unit_cost,
        'stock_adjustment', v_pid, 'Stock decrease adjustment');
    end if;
  end loop;

  return jsonb_build_object('status', 'synced', 'product_id', v_pid);
end;
$$;

-- ---------------------------------------------------------------------------
-- customer.create / customer.update — CRM modal payload; balances are
-- trigger-maintained and deliberately not written.
-- ---------------------------------------------------------------------------
create or replace function public.sync_customer_create(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  d    jsonb := p_payload->'data';
  v_id uuid;
  v_code text;
begin
  v_code := nullif(d->>'code', '');
  if v_code is null then
    v_code := public.generate_customer_code();
  end if;

  -- Optional client-generated id for offline-created customers so a queued
  -- offline sale can reference them.
  if p_payload ? 'id' then
    insert into customers (id, name, code, type, phone, mobile, email, company_name, city, address,
      tax_id, tags, notes, credit_limit, credit_days, loyalty_points, discount_percent, is_active, country)
    values ((p_payload->>'id')::uuid, d->>'name', v_code, d->>'type', nullif(d->>'phone', ''), nullif(d->>'mobile', ''),
      nullif(d->>'email', ''), nullif(d->>'company_name', ''), nullif(d->>'city', ''),
      nullif(d->>'address', ''), nullif(d->>'tax_id', ''),
      case when jsonb_typeof(d->'tags') = 'array' then ARRAY(SELECT jsonb_array_elements_text(d->'tags')) else '{}'::text[] end,
      nullif(d->>'notes', ''),
      coalesce((d->>'credit_limit')::numeric, 0),
      coalesce((d->>'credit_days')::int, 0),
      coalesce((d->>'loyalty_points')::int, 0),
      coalesce((d->>'discount_percent')::numeric, 0),
      coalesce((d->>'is_active')::boolean, true),
      d->>'country')
    returning id into v_id;
  else
    insert into customers (name, code, type, phone, mobile, email, company_name, city, address,
      tax_id, tags, notes, credit_limit, credit_days, loyalty_points, discount_percent, is_active, country)
    values (d->>'name', v_code, d->>'type', nullif(d->>'phone', ''), nullif(d->>'mobile', ''),
      nullif(d->>'email', ''), nullif(d->>'company_name', ''), nullif(d->>'city', ''),
      nullif(d->>'address', ''), nullif(d->>'tax_id', ''),
      case when jsonb_typeof(d->'tags') = 'array' then ARRAY(SELECT jsonb_array_elements_text(d->'tags')) else '{}'::text[] end,
      nullif(d->>'notes', ''),
      coalesce((d->>'credit_limit')::numeric, 0),
      coalesce((d->>'credit_days')::int, 0),
      coalesce((d->>'loyalty_points')::int, 0),
      coalesce((d->>'discount_percent')::numeric, 0),
      coalesce((d->>'is_active')::boolean, true),
      d->>'country')
    returning id into v_id;
  end if;

  return jsonb_build_object('status', 'synced', 'customer_id', v_id, 'code', v_code);
end;
$$;

create or replace function public.sync_customer_update(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  d            jsonb := p_payload->'data';
  v_id         uuid  := (p_payload->>'id')::uuid;
  v_server_row jsonb;
begin
  select to_jsonb(c) into v_server_row from customers c where c.id = v_id;

  if v_server_row is null then
    return jsonb_build_object('status', 'conflict', 'reason', 'missing', 'server_row', 'null'::jsonb);
  end if;

  if not coalesce((p_payload->>'force')::boolean, false)
     and p_payload ? 'expected_updated_at'
     and (p_payload->>'expected_updated_at')::timestamptz
         is distinct from (v_server_row->>'updated_at')::timestamptz then
    return jsonb_build_object('status', 'conflict', 'reason', 'version_mismatch',
      'server_row', v_server_row);
  end if;

  update customers set
    name = d->>'name', type = d->>'type', phone = nullif(d->>'phone', ''),
    mobile = nullif(d->>'mobile', ''), email = nullif(d->>'email', ''),
    company_name = nullif(d->>'company_name', ''), city = nullif(d->>'city', ''),
    address = nullif(d->>'address', ''), tax_id = nullif(d->>'tax_id', ''),
    tags = case when jsonb_typeof(d->'tags') = 'array' then ARRAY(SELECT jsonb_array_elements_text(d->'tags')) else '{}'::text[] end,
    notes = nullif(d->>'notes', ''),
    credit_limit = coalesce((d->>'credit_limit')::numeric, 0),
    credit_days = coalesce((d->>'credit_days')::int, 0),
    loyalty_points = coalesce((d->>'loyalty_points')::int, 0),
    discount_percent = coalesce((d->>'discount_percent')::numeric, 0),
    is_active = coalesce((d->>'is_active')::boolean, true),
    country = d->>'country',
    updated_at = now()
  where id = v_id;

  return jsonb_build_object('status', 'synced', 'customer_id', v_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- employee.create / employee.update — /employees modal payload
-- ---------------------------------------------------------------------------
create or replace function public.sync_employee_create(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  d    jsonb := p_payload->'data';
  v_id uuid;
begin
  -- Optional client-generated id for offline-created employees so queued
  -- attendance rows can reference them.
  if p_payload ? 'id' then
    insert into employees (id, employee_id, full_name, designation, department, email, phone,
      salary, join_date, status)
    values ((p_payload->>'id')::uuid, d->>'employee_id', d->>'full_name', d->>'designation', d->>'department',
      nullif(d->>'email', ''), nullif(d->>'phone', ''),
      coalesce((d->>'salary')::numeric, 0),
      (d->>'join_date')::date,
      coalesce(d->>'status', 'active'))
    returning id into v_id;
  else
    insert into employees (employee_id, full_name, designation, department, email, phone,
      salary, join_date, status)
    values (d->>'employee_id', d->>'full_name', d->>'designation', d->>'department',
      nullif(d->>'email', ''), nullif(d->>'phone', ''),
      coalesce((d->>'salary')::numeric, 0),
      (d->>'join_date')::date,
      coalesce(d->>'status', 'active'))
    returning id into v_id;
  end if;

  return jsonb_build_object('status', 'synced', 'employee_id', v_id);
end;
$$;

create or replace function public.sync_employee_update(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  d            jsonb := p_payload->'data';
  v_id         uuid  := (p_payload->>'id')::uuid;
  v_server_row jsonb;
begin
  select to_jsonb(e) into v_server_row from employees e where e.id = v_id;

  if v_server_row is null then
    return jsonb_build_object('status', 'conflict', 'reason', 'missing', 'server_row', 'null'::jsonb);
  end if;

  if not coalesce((p_payload->>'force')::boolean, false)
     and p_payload ? 'expected_updated_at'
     and (p_payload->>'expected_updated_at')::timestamptz
         is distinct from (v_server_row->>'updated_at')::timestamptz then
    return jsonb_build_object('status', 'conflict', 'reason', 'version_mismatch',
      'server_row', v_server_row);
  end if;

  update employees set
    employee_id = d->>'employee_id',
    full_name = d->>'full_name',
    designation = d->>'designation',
    department = d->>'department',
    email = nullif(d->>'email', ''),
    phone = nullif(d->>'phone', ''),
    salary = coalesce((d->>'salary')::numeric, 0),
    join_date = (d->>'join_date')::date,
    status = coalesce(d->>'status', 'active'),
    updated_at = now()
  where id = v_id;

  return jsonb_build_object('status', 'synced', 'employee_id', v_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- attendance.mark / attendance.details — /hr/attendance read-then-write
-- upserts, one op per UI action
-- ---------------------------------------------------------------------------
create or replace function public.sync_attendance_mark(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_emp  uuid := (p_payload->>'employee_id')::uuid;
  v_date date := (p_payload->>'date')::date;
  v_id   uuid;
begin
  select id into v_id from attendance
  where employee_id = v_emp and date = v_date
  order by created_at asc limit 1;

  if v_id is not null then
    update attendance set status = p_payload->>'status' where id = v_id;
  else
    insert into attendance (employee_id, date, status)
    values (v_emp, v_date, p_payload->>'status');
  end if;

  return jsonb_build_object('status', 'synced');
end;
$$;

create or replace function public.sync_attendance_details(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_emp  uuid := (p_payload->>'employee_id')::uuid;
  v_date date := (p_payload->>'date')::date;
  v_id   uuid;
begin
  select id into v_id from attendance
  where employee_id = v_emp and date = v_date
  order by created_at asc limit 1;

  if v_id is not null then
    update attendance set
      check_in = nullif(p_payload->>'check_in', '')::timestamptz,
      check_out = nullif(p_payload->>'check_out', '')::timestamptz,
      notes = nullif(p_payload->>'notes', '')
    where id = v_id;
  else
    insert into attendance (employee_id, date, check_in, check_out, status, notes)
    values (v_emp, v_date,
      nullif(p_payload->>'check_in', '')::timestamptz,
      nullif(p_payload->>'check_out', '')::timestamptz,
      coalesce(p_payload->>'status', 'present'),
      nullif(p_payload->>'notes', ''));
  end if;

  return jsonb_build_object('status', 'synced');
end;
$$;

-- ---------------------------------------------------------------------------
-- Dispatcher
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
begin
  if auth.uid() is null then
    raise exception 'sync_apply requires an authenticated session';
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
    -- Conflicts are resolvable: forget the claim so a forced retry of the
    -- same item id executes again.
    delete from sync_applied_items
    where user_id = auth.uid() and item_id = p_item_id;
    return v_result;
  end if;

  update sync_applied_items set result = v_result
  where user_id = auth.uid() and item_id = p_item_id;

  return v_result;
end;
$$;

-- Handler functions are internal: only the dispatcher may call them.
revoke all on function
  public.sync_invoice_create(jsonb),
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
