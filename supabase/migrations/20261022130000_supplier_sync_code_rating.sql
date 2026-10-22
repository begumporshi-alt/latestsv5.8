-- Offline-created suppliers can't reach generate_supplier_code() while
-- disconnected, and the PO-form Add Supplier modal never sends a rating.
-- sync_supplier_create now fills the code from the supplier_seq sequence and
-- defaults the rating to 1, matching the online insert paths.

create or replace function public.sync_supplier_create(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  d     jsonb := p_payload->'data';
  v_id  uuid;
  v_code text;
begin
  if nullif(d->>'name', '') is null then
    raise exception 'supplier.create: name is required';
  end if;

  -- The client can't call generate_supplier_code() offline; an empty or
  -- missing code falls back to the sequence at sync time.
  v_code := coalesce(nullif(d->>'code', ''), generate_supplier_code());

  if p_payload ? 'id' then
    insert into suppliers (id, name, code, phone, email, mobile, company_name, city, address,
      credit_limit, credit_days, rating, is_active, country)
    values ((p_payload->>'id')::uuid, d->>'name', v_code,
      nullif(d->>'phone', ''), nullif(d->>'email', ''), nullif(d->>'mobile', ''),
      nullif(d->>'company_name', ''), nullif(d->>'city', ''), nullif(d->>'address', ''),
      coalesce(nullif(d->>'credit_limit', '')::numeric, 0),
      coalesce(nullif(d->>'credit_days', '')::int, 0),
      coalesce(nullif(d->>'rating', '')::numeric, 1),
      coalesce((d->>'is_active')::boolean, true),
      coalesce(nullif(d->>'country', ''), 'Bangladesh'))
    returning id into v_id;
  else
    insert into suppliers (name, code, phone, email, mobile, company_name, city, address,
      credit_limit, credit_days, rating, is_active, country)
    values (d->>'name', v_code,
      nullif(d->>'phone', ''), nullif(d->>'email', ''), nullif(d->>'mobile', ''),
      nullif(d->>'company_name', ''), nullif(d->>'city', ''), nullif(d->>'address', ''),
      coalesce(nullif(d->>'credit_limit', '')::numeric, 0),
      coalesce(nullif(d->>'credit_days', '')::int, 0),
      coalesce(nullif(d->>'rating', '')::numeric, 1),
      coalesce((d->>'is_active')::boolean, true),
      coalesce(nullif(d->>'country', ''), 'Bangladesh'))
    returning id into v_id;
  end if;

  return jsonb_build_object('status', 'synced', 'supplier_id', v_id);
end;
$$;
