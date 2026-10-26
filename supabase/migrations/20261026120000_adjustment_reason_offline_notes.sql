-- Adjustment reason in notes: ProductModal now sends an optional `reason` per
-- stock entry; sync_product_update composes it into the movement + RPC notes
-- ("Stock increase adjustment — <reason>") so offline replay records the same
-- context the online path does. Everything else is byte-identical to the
-- pg_get_functiondef dump of 2026-10-26.

create or replace function public.sync_product_update(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  d          jsonb := p_payload->'data';
  v_pid      uuid  := (p_payload->>'id')::uuid;
  v_tenant   uuid;
  v_server_row jsonb;
  v_current  numeric;
  v_diff     numeric;
  v_inv_id   uuid;
  v_stock    record;
  v_adj_notes text;
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
           coalesce((r->>'unit_cost')::numeric, (d->>'cost_price')::numeric, 0) as unit_cost,
           nullif(coalesce(r->>'reason', ''), '') as reason
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

    v_adj_notes := case when v_diff > 0 then 'Stock increase adjustment' else 'Stock decrease adjustment' end
                   || case when v_stock.reason is not null then ' — ' || v_stock.reason else '' end;

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
      'stock_adjustment', v_pid, v_adj_notes);

    if v_diff > 0 then
      perform public.create_opening_batch(
        v_pid, v_stock.warehouse_id, v_diff, v_stock.unit_cost,
        'adjustment', 'stock_adjustment', v_pid, v_adj_notes);
    else
      perform public.create_stock_reduction(
        v_pid, v_stock.warehouse_id, abs(v_diff), v_stock.unit_cost,
        'stock_adjustment', v_pid, v_adj_notes);
    end if;
  end loop;

  return jsonb_build_object('status', 'synced', 'product_id', v_pid);
end;
$function$;
