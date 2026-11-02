# db/ — cutover kit for moving sisolution to a new Supabase project

This directory moves the **existing production data** from the current Supabase
project (`qdnbefqmcxjvddlabeww`, `ap-southeast-2`) into a brand-new, empty
project. It is not a schema rebuild — the schema and every row come from a
`pg_dump` archive, so the result is byte-for-byte the same data.

## Why not just `pg_restore` the whole archive

Three reasons, each of which breaks the restore if ignored:

1. **Platform schemas collide.** The archive contains `auth`, `storage`,
   `realtime`, `vault`, `graphql`, `pgbouncer` and `supabase_migrations`. The
   new project already owns those schemas with its own versions. Restoring them
   produces hundreds of "already exists" errors and can leave the auth schema
   inconsistent. The kit restores `public` only, and repairs the platform
   pieces explicitly.

2. **Triggers must not exist while rows load.** All 77 user triggers sit in the
   archive's `post-data` section. If they were present during the data pass,
   `trg_invoice_accounting` and `trg_payment_accounting` would post a second
   journal entry for every one of the 1,299 invoices — doubling the ledger.
   The kit restores in four ordered passes so data lands before triggers.

3. **`--disable-triggers` is unavailable.** It requires a superuser, and the
   `postgres` role on Supabase is not one. `session_replication_role = replica`
   fails for the same reason. Pass ordering is the supported substitute.

## Files

| File | Purpose |
|---|---|
| `01_dump_source.sh` | Fresh `pg_dump -Fc` of the current database, with a TOC integrity check |
| `01b_capture_baseline.py` | Records row counts and schema shape into `baseline.json` at dump time — called automatically by `01_dump_source.sh` |
| `02_extract_auth.py` | Pulls `auth.users` + `auth.identities` out of the archive and rewrites them for the target's column set |
| `03_restore.sh` | The four-pass restore, plus post-restore repair |
| `04_post_restore.sql` | Grants, the `on_auth_user_created` trigger, cron jobs, realtime publication |
| `05_verify.py` | Compares the target to `baseline.json` row by row |
| `06_seed_migration_history.sh` | Records the repo's migration files in `supabase_migrations.schema_migrations` on the new project |
| `baseline.json` | Row counts captured from live source at dump time |
| `verify/` | The schema and app-contract assertions from the validated `safe_migration` package |
| `checksums.txt` | SHA-256 of the archive actually used |
| `logs/` | Per-run restore logs (gitignored) |

## Order of operations

```bash
# 1. dump the source (only while no writes are happening)
#    also rewrites baseline.json from the same database, so verify has
#    something current to compare against
./01_dump_source.sh "$SOURCE_DB_URL"

# 2. restore into the new project
./03_restore.sh --url "$TARGET_DB_URL" --dump ~/Backups/sisolution/cutover-XXXX.dump

# 3. record which migrations the restored schema already contains
./06_seed_migration_history.sh "$TARGET_DB_URL"

# 4. prove it before pointing the app at it
./05_verify.py --url "$TARGET_DB_URL"
```

`05_verify.py` must print `PASS`. If it prints `FAILED`, do not cut over.

## Why step 3 exists

The restore rebuilds `public` from a `pg_dump`, so every migration is already
reflected in the new schema — but the new project's own
`supabase_migrations.schema_migrations` is empty. The kit deliberately does not
restore the source's history table, because its rows describe the *source*
project.

That empty table is a trap. A later `supabase db push` sees no history and tries
to replay all ~348 migrations against a populated database. It fails on the
first non-idempotent `create table` or `alter table ... add column`, and because
migrations run in order it can leave a partially applied chain behind.

`06_seed_migration_history.sh` closes the gap: it inserts one row per migration
file, using `on conflict (version) do nothing`, so it is safe to re-run.

Pass `--until <timestamp>` when the dump predates the newest migrations. Anything
written after the dump is **not** in the restored schema and must stay
unrecorded so it can still be applied.

The script reports two numbers worth reading:

- **files not yet recorded** should be `0`; a non-zero count exits `2`.
- **recorded with no file on disk** is expected to be non-zero. Fourteen rows in
  the source history name migrations whose file was later renamed or removed.
  They are real historical entries and are left untouched.

## What `05_verify.py` asserts

- Every public table exists with its **exact** row count. Not approximately —
  six missing journal lines is a changed ledger.
- The RLS policy, trigger and `auth.users` counts match the baseline.
- Sum of debits equals sum of credits in `journal_lines`.
- `invoices` and `payments` carry exactly **one** accounting trigger each. Two
  would double-post every transaction; this is the defect the upstream migration
  chain contains.
- `get_next_journal_number()` returns a number that does not already exist. A
  single over-long entry number makes `LPAD(text,6,'0')` truncate, which collapses
  every subsequent number onto an existing row and blocks all posting.
- Every table and RPC the Next.js app calls is present (53 tables, 68 RPCs).

The expected counts live in `baseline.json`, not in this README. They change with
every business day, so hardcoding them here would only guarantee they are wrong
by the next cutover. `01_dump_source.sh` rewrites the baseline from the source
database immediately after `pg_dump` returns, so the two always describe the same
moment. Do not edit `baseline.json` by hand.

## Prerequisites on the new project

- PostgreSQL 17, same region as the source (`ap-southeast-2`).
- Extensions enabled: `pgcrypto`, `uuid-ossp`, `pg_cron`, `supabase_vault`,
  `pg_stat_statements`. `pg_cron` is required for the two scheduled jobs; the
  kit warns and continues without it, but the nightly reconciliation and the
  overdue-invoice digest will not run.
- Connection string from **Project Settings → Database → Session pooler, port
  5432**. Port 6543 is the transaction pooler and will drop DDL sessions.

## Deliberately not migrated

- `cogs_fix_backup` schema (7 manual pre-repair snapshot tables) — excluded
  automatically because only `public` is restored.
- `storage` — the source has **0 buckets and 0 objects**, and the app makes no
  `supabase.storage` calls. Nothing to copy.
- `vault.secrets` — **0 rows**.
- `auth.sessions` and `auth.refresh_tokens` — the new project has a different JWT
  secret, so every existing session is invalid regardless. Users re-login; their
  passwords still work because `auth.users.encrypted_password` is restored.

## Re-running

`03_restore.sh` refuses to run against a target with more than 5 public tables.
That guard exists because a second run produces duplicate-key errors and a
half-built database. To start over, delete the Supabase project and create a
fresh one — do not try to clean up in place.
