-- allow_decimal: products whose unit is a continuous measure (meter, foot,
-- kg, gram, liter) may be sold in fractional quantities. Everything else
-- (pcs, box, pack, coil) is whole-number only.
alter table products add column if not exists allow_decimal boolean not null default false;

update products set allow_decimal = true
where lower(trim(unit)) in (
  'meter', 'meters', 'm',
  'foot', 'feet', 'ft',
  'kg', 'kgs', 'kilogram', 'kilograms',
  'gram', 'grams', 'g',
  'liter', 'litre', 'liters', 'litres', 'l'
);

-- Re-derive whenever the unit changes (or on insert) so a product switched
-- to/from a continuous unit stays correct. A manual override survives any
-- other edit; it is only reset when the unit itself changes.
create or replace function products_derive_allow_decimal() returns trigger as $$
declare
  decimal_units text[] := array[
    'meter', 'meters', 'm',
    'foot', 'feet', 'ft',
    'kg', 'kgs', 'kilogram', 'kilograms',
    'gram', 'grams', 'g',
    'liter', 'litre', 'liters', 'litres', 'l'
  ];
begin
  if tg_op = 'INSERT' or new.unit is distinct from old.unit then
    new.allow_decimal := lower(trim(new.unit)) = any(decimal_units);
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_products_derive_allow_decimal on products;
create trigger trg_products_derive_allow_decimal
  before insert or update on products
  for each row execute function products_derive_allow_decimal();
