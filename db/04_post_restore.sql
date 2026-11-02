-- ============================================================================
-- 04_post_restore.sql
--
-- Repairs everything a `pg_restore -n public` migration cannot carry over.
--
-- Three classes of object live outside the public schema and are therefore
-- silently absent after the restore:
--
--   1. table grants        - the archive was taken with --no-privileges, so no
--                            GRANT statements exist. Without these, requests
--                            made with the anon or authenticated key fail with
--                            "permission denied" even though RLS is correct.
--   2. the auth trigger    - on_auth_user_created lives ON auth.users, so it
--                            belongs to the auth schema's post-data section,
--                            not public's. New sign-ups get no profile row
--                            until it exists.
--   3. scheduled jobs      - pg_cron lives in the cron schema.
--
-- Idempotent: safe to run more than once.
-- ============================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------- 1. grants
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables    in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant all on all functions in schema public to anon, authenticated, service_role;

-- Match Supabase's own default privileges so that tables created later by the
-- app's migrations are reachable without an explicit grant.
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

-- ------------------------------------------- 2. trigger that creates profiles
do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'on_auth_user_created'
      and tgrelid = 'auth.users'::regclass
  ) then
    execute 'create trigger on_auth_user_created
             after insert on auth.users
             for each row execute function public.handle_new_user()';
    raise notice 'created trigger on_auth_user_created';
  else
    raise notice 'trigger on_auth_user_created already present';
  end if;
end $$;

-- --------------------------------------------------------- 3. scheduled jobs
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise warning 'pg_cron is not installed - skipping scheduled jobs. '
                  'Enable it in Dashboard -> Database -> Extensions, then re-run this file.';
    return;
  end if;

  if not exists (select 1 from cron.job where jobname = 'overdue-invoice-digest') then
    perform cron.schedule(
      'overdue-invoice-digest',
      '0 2 * * *',
      $job$SELECT notify_overdue_invoices()$job$
    );
    raise notice 'scheduled overdue-invoice-digest';
  end if;

  if not exists (select 1 from cron.job where jobname = 'inventory-reconciliation-nightly') then
    perform cron.schedule(
      'inventory-reconciliation-nightly',
      '5 2 * * *',
      $job$
    INSERT INTO inventory_reconciliation_log (all_ok, checks)
    SELECT NOT EXISTS (SELECT 1 FROM get_inventory_reconciliation() r WHERE r.status = 'drift'),
           (SELECT to_jsonb(x) FROM (SELECT array_agg(row_to_json(r) ORDER BY r.sort_key) AS checks
                                     FROM get_inventory_reconciliation() r) x);
    $job$
    );
    raise notice 'scheduled inventory-reconciliation-nightly';
  end if;
end $$;

-- ------------------------------------------------------ 4. realtime publication
-- public.notifications is the only application table in the source publication.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications'
    ) then
      execute 'alter publication supabase_realtime add table public.notifications';
      raise notice 'added public.notifications to supabase_realtime';
    end if;
  else
    raise warning 'supabase_realtime publication not found - realtime disabled';
  end if;
end $$;

-- ------------------------------------------------------------ 5. planner stats
-- Without this the first queries after cutover run on empty statistics.
analyze;
