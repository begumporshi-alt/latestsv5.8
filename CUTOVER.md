# CUTOVER — move sisolution to a new Supabase project

Status: **restore complete and verified on the new project. Remaining work is
dashboard-side (auth settings, Netlify env, edge functions).**

| | |
|---|---|
| Source project | `qdnbefqmcxjvddlabeww` · `ap-southeast-2` · PostgreSQL 17.6 |
| Target project | `vkvurkuzahclerqnsqbz` · `eu-north-1` · PostgreSQL 17.11 |
| Archive | `~/Backups/sisolution/cutover-20261030-1817.dump` · 7.1 MB · `3e6e78ff…38629` |
| Captured | 2026-10-30 18:17 (+06) |
| Restored | 2026-10-30 18:52 (+06) |
| Contents | 79 tables · 79,148 rows · 8 auth users · 222 RLS policies · 77 triggers |

### Restore result

```
tables compared : 79      total rows : 79148 (expected 79148)
OK  public tables 79      OK  RLS policies 222      OK  triggers 77
OK  auth.users 8          OK  debits - credits = 0
OK  invoices/payments: 1 accounting trigger each
OK  next journal number JE-969278 is unused
OK  verify/00_verify_schema.sql   OK  verify/01_app_contract.sql
PASS
```

Independently confirmed on the target: 8/8 users carry bcrypt hashes, 8/8 are
confirmed and have identities, 4 profiles (all active, zero orphans — matches
the source count), `supabase_migrations.schema_migrations` holds all 124 rows,
`pg_cron` is installed with both jobs scheduled, and the REST API answers anon
(200), service-role reads, and `get_next_journal_number()` → `JE-969278`.

> **Region deviation.** The new project is in `eu-north-1`, not the
> `ap-southeast-2` recommended below. Every RLS-guarded page load pays the
> extra round-trip. Recreating in `ap-southeast-2` (or `ap-southeast-1`) is
> cheap *now* — the dump and this kit re-run in about three minutes — and
> expensive later. Decide before the app is pointed at it.


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

### 2. Fill in `.env` — **done**

Four values are in place. One correction was applied: the file also carried a
`NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY` line duplicating the service-role key.
It has been removed, and `lib/admin-auth.ts` no longer accepts a
`NEXT_PUBLIC_`-prefixed fallback at all — webpack substitutes those names at
build time, so the mere reference risks inlining a key that bypasses RLS into a
browser bundle. The build was re-checked afterwards: zero occurrences of the
service key in `.next/static`.

Use the **session pooler on 5432**, not the 6543 the old `.env` used. The
transaction pooler drops DDL sessions.

### 3. Restore and verify — **done**

```bash
cd db
./03_restore.sh --url "$NEW_DB_URL" --dump ~/Backups/sisolution/cutover-20261030-1817.dump
./05_verify.py  --url "$NEW_DB_URL"
```

All four passes reported `exit=0 errors=0`. `05_verify.py` printed `PASS`.
A fresh backup of the new database was then taken with `scripts/db-backup.sh`
(6.1 MB, TOC verified to contain `products` and `auth.users`).


### 4. Cut the application over — **partly done**

`npm run build` passes with the new env; the new project ref is inlined into the
client bundle and the old ref appears nowhere under `.next`.

Still to do:

- **Netlify** → Site settings → Environment variables: the same four values,
  then redeploy. The Netlify CLI is not installed locally, so this is a
  dashboard step.
- **Supabase Auth** on the new project: enable email sign-in, set Site URL and
  the redirect allow-list to the deployed domain, configure SMTP if magic links
  are used. See §6.
- **Edge functions** (`db-backup`, `db-restore`): the local Supabase CLI is
  authenticated to the *MedFind* org, which does not contain
  `vkvurkuzahclerqnsqbz`. Run `supabase login` for the new account, then:

  ```bash
  supabase link --project-ref vkvurkuzahclerqnsqbz
  supabase functions deploy db-backup db-restore
  ```

### 5. Three things that silently keep pointing at the old database

1. **Client-side config cache — fixed.** `lib/runtime-config.ts` now scopes the
   `localStorage` key to the project ref this build was compiled against
   (`sisolution.runtime-config.<ref>`), so an entry written by a pre-cutover
   bundle is unreachable after deploy. The legacy unscoped key is deleted on
   first load. No manual bump is required for future cutovers.
2. **Edge functions — pending.** See §4; they read `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY` from the platform environment, which changes with
   the project.
3. **Nightly backup — fixed.** The launchd agent
   `com.sisolution.db-backup` ran the *old* repository's script, so it would
   have kept dumping the old project. It now points at
   `~/Desktop/sisolution-new/scripts/db-backup.sh`, which reads this repo's
   `.env`. The agent was unloaded during the edit and could not be re-bootstrapped
   from the automation context (`Bootstrap failed: 5`, reproducible with a
   minimal test plist). Load it once from your own terminal:

   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.sisolution.db-backup.plist
   ```

   Until then the 03:00 job will not fire; the script itself has been run
   manually and works against the new database. If the machine logs out and back
   in first, launchd loads it automatically.


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

Published as a **private** GitHub repository under the same account that owns
the old one (`begumporshi-alt`):

```
https://github.com/begumporshi-alt/sisolution-new
```

`main` tracks `origin/main`; the full history (667 commits) is pushed. Only
`.env.example` is tracked — `.env`, `.env.source` and `.env*.local` are
ignored, and no credential appears in any commit.

The first push failed with `HTTP 400 / send-pack: unexpected disconnect` on a
36 MB repository with no oversized blobs. Setting `http.postBuffer` to 512 MB
and forcing `http.version` to HTTP/1.1 in the local git config fixed it; both
settings are repo-local and not committed.

