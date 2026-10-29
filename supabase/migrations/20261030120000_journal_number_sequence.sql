-- Journal entry numbers come from the sequence that has existed since the
-- first accounting migration, not from MAX(digits)+1.
--
-- The old generator scanned every JE-% row, stripped non-digits and added one.
-- Two ways that breaks:
--   * lpad(n::text, 6, '0') truncates instead of widening, so once the series
--     passes 999,999 the generator returns a number that already exists and
--     every post fails on journal_entries_entry_number_key.
--   * any JE-% row carrying more than six digits (the opening-balance entry
--     mints JE-OPENING-YYYYMMDD) sets the MAX to a date, and the truncation
--     produces a short, already-used number from the first call.
--
-- The seed deliberately reads only JE-<1-6 digits> so a date-shaped opening
-- entry cannot move the series. nextval is not transactional: a rolled-back
-- post burns a number and leaves a gap. Gaps already exist (deleted entries
-- and the 2026-09-06 repairs); a repeated number is not an option.

begin;

create sequence if not exists journal_entry_seq start 1000;

do $$
declare
  v_max bigint := 0;
  v_last bigint;
begin
  select coalesce(max(substring(entry_number from 4)::bigint), 0)
    into v_max
    from journal_entries
   where entry_number ~ '^JE-[0-9]{1,6}$';

  select last_value into v_last from journal_entry_seq;
  if v_last < v_max then
    perform setval('journal_entry_seq', v_max);
  end if;
end
$$;

create or replace function public.get_next_journal_number()
returns text
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
  v_next bigint;
begin
  v_next := nextval('public.journal_entry_seq');
  return 'JE-' || case
    when v_next < 1000000 then lpad(v_next::text, 6, '0')
    else v_next::text
  end;
end;
$function$;

-- No GRANT here: create or replace keeps whatever ACL the target database
-- already has. The hosted project grants EXECUTE to authenticated and
-- service_role; the standby candidate is default-deny by design and the
-- rehearsal clones re-grant the cloud surface from compatibility/grants-parity.sql.
-- Granting anon here would widen access in every target.

commit;
