# CUTOVER — move sisolution to a new Supabase project

Status: **data captured, restore kit built and validated. Waiting on the new
Supabase project.**

| | |
|---|---|
| Source project | `qdnbefqmcxjvddlabeww` · `ap-southeast-2` · PostgreSQL 17.6 |
| Archive | `~/Backups/sisolution/cutover-20261030-1817.dump` · 7.1 MB · `3e6e78ff…38629` |
| Captured | 2026-10-30 18:17 (+06) |
| Contents | 79 tables · 79,148 rows · 8 auth users · 222 RLS policies · 77 triggers |

The archive was taken after the three PR #208 migrations were applied, so it
includes `write_off_product_stock` and the 9-argument `create_stock_reduction`.
It supersedes `sisolution-20261030-1502.dump`, which was six rows of
`journal_lines` out of date.

## What has been proven already

The restore kit was run end to end against a throwaway PostgreSQL 17 cluster
configured to resemble a fresh Supabase project. Result:

```
tables compared : 79
total rows      : 79148 (expected 79148)
OK   public tables    79    OK   RLS policies  222
OK   triggers         77    OK   auth.users      8
OK   debits - credits = 0
OK   invoices: 1 accounting trigger    OK   payments: 1 accounting trigger
OK   next journal number JE-969278 is unused
OK   verify/00_verify_schema.sql       OK   verify/01_app_contract.sql
PASS
```

Also confirmed on the restored copy: 8/8 users carry bcrypt password hashes,
8/8 have identities, and zero orphaned `profiles`, `invoices` or `journal_lines`.

The test surfaced two defects that would have failed against the real project,
both now fixed: `auth.users.confirmed_at` and `auth.identities.email` are
`GENERATED ALWAYS` columns that reject supplied values, and a leading blank line
was being parsed as a data row.

## What you need to do

### 1. Create the new project

Supabase dashboard → New project. **Same region (`ap-southeast-2`)** — the app
runs RLS-guarded queries on every page load, and a cross-region hop adds latency
to all of them.

Then enable, under Database → Extensions:

- `pgcrypto`, `uuid-ossp` (usually on by default)
- `pg_cron` — required for the nightly reconciliation and the overdue-invoice digest
- `supabase_vault`, `pg_stat_statements`

### 2. Fill in `.env`

```bash
cd ~/Desktop/sisolution-new
cp .env.example .env      # already done; edit the values
```

Four values, from Project Settings → API and → Database:

```
NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service_role key>
NEXT_PUBLIC_SUPABASE_DB_URL=postgresql://postgres.<ref>:<pw>@aws-1-ap-southeast-2.pooler.supabase.com:5432/postgres
```

Use the **session pooler on 5432**, not the 6543 the old `.env` used. The
transaction pooler drops DDL sessions.

The service role key deliberately has no `NEXT_PUBLIC_` prefix. Anything with
that prefix is inlined into the browser bundle, publishing a key that bypasses
every RLS policy. `lib/admin-auth.ts` reads `SUPABASE_SERVICE_ROLE_KEY` first, so
nothing else needs to change.

### 3. Restore and verify

```bash
cd db
./03_restore.sh --url "$NEW_DB_URL" --dump ~/Backups/sisolution/cutover-20261030-1817.dump
./05_verify.py  --url "$NEW_DB_URL"
```

`05_verify.py` must print `PASS`. If it prints `FAILED`, stop — do not point the
app at that database.

### 4. Cut the application over

```bash
npm run build          # confirm it builds with the new env
```

Then update the deployment environment (Netlify → Site settings → Environment
variables) with the same four values, and redeploy.

### 5. Three things that will silently keep pointing at the old database

1. **Client-side config cache.** `lib/runtime-config.ts` writes the connection
   config to `localStorage` under `sisolution.runtime-config`, and the service
   worker serves cached HTML. A device that boots from cache keeps writing to the
   **old** project. Bump the cache key in that file before deploying, or the
   first load after cutover is a coin flip.
2. **Edge functions.** `supabase/functions/db-backup` and `db-restore` must be
   redeployed to the new project. They read `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY` from the platform environment, which changes with
   the project.
3. **Nightly backup.** `scripts/db-backup.sh` reads
   `NEXT_PUBLIC_SUPABASE_DB_URL`. It will keep backing up the old project until
   that value changes.

### 6. Auth after cutover

The new project has a different JWT secret, so every existing session is invalid
and all 8 users must log in again. Their passwords still work — the bcrypt hashes
moved with the rows. Confirm under Authentication → Providers that email
sign-in is enabled, set the Site URL and redirect allow-list to the new domain,
and configure SMTP if magic links are in use.

## Rollback

The old project is untouched and still holds the data. Rollback is: restore the
old four values in `.env` and in Netlify, then redeploy. Keep the old project
alive for at least 30 days.

## Repository

This folder is a fresh repository on branch `main`, cloned from the previous
working copy with full history intact. The old repository is still reachable as
the `source` remote:

```bash
git remote -v          # source -> ~/Desktop/Myapps/for final si/sisolution
```

To publish it as a new GitHub repository:

```bash
gh repo create sisolution-new --private --source=. --remote=origin --push
```

Nothing has been committed yet — the first commit is yours to make once the
project exists and `.env` is filled in.
