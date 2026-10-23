-- Decimal selling is a property of the UNIT, not just the product. Admins
-- manage unit types in Inventory → Manage Units; the checkbox there now
-- controls whether products using the unit accept fractional quantities.
alter table unit_types add column if not exists allow_decimal boolean not null default false;

update unit_types set allow_decimal = true
where lower(trim(unit_name)) in (
  'kilogram', 'kg', 'kgs',
  'gram', 'grams', 'g',
  'liter', 'litre', 'ltr', 'l',
  'meter', 'meters', 'mtr', 'm',
  'foot', 'feet', 'ft',
  'square feet', 'sqft',
  'yard', 'yards', 'yrd'
);

-- Products prefer the unit_types flag; the hardcoded list below is only a
-- fallback for free-text units that have no unit_types row.
create or replace function products_derive_allow_decimal() returns trigger as $$
declare
  decimal_units text[] := array[
    'meter', 'meters', 'm', 'mtr',
    'foot', 'feet', 'ft', 'square feet', 'sqft', 'yard', 'yards', 'yrd',
    'kg', 'kgs', 'kilogram', 'kilograms',
    'gram', 'grams', 'g',
    'liter', 'litre', 'liters', 'litres', 'l', 'ltr'
  ];
  from_unit_types boolean;
begin
  if tg_op = 'INSERT' or new.unit is distinct from old.unit then
    select ut.allow_decimal into from_unit_types
    from unit_types ut
    where lower(trim(ut.unit_name)) = lower(trim(new.unit))
    limit 1;
    if from_unit_types is not null then
      new.allow_decimal := from_unit_types;
    else
      new.allow_decimal := lower(trim(new.unit)) = any(decimal_units);
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

-- Toggling a unit type re-syncs every product that uses it, so the admin
-- checkbox takes effect immediately without editing each product.
create or replace function unit_types_sync_products() returns trigger as $$
begin
  if new.allow_decimal is distinct from old.allow_decimal then
    update products set allow_decimal = new.allow_decimal
    where lower(trim(unit)) = lower(trim(new.unit_name));
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_products_derive_allow_decimal on products;
create trigger trg_products_derive_allow_decimal
  before insert or update on products
  for each row execute function products_derive_allow_decimal();

drop trigger if exists trg_unit_types_sync_products on unit_types;
create trigger trg_unit_types_sync_products
  before update on unit_types
  for each row execute function unit_types_sync_products();
