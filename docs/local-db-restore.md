# Local database restore runbook

Full backups of the Supabase `postgres` database live in `backups/` (gitignored) as
custom-format `pg_dump` archives. Each contains **everything**: all `public` business
tables, `auth` users, `storage` objects, functions, and triggers.

> **Always use the Postgres 17 binaries at `/opt/homebrew/opt/postgresql@17/bin/`.**
> The default `pg_restore` on PATH is v14 and cannot read these archives.

## 1. Start a disposable local server (port 5433)

```bash
/opt/homebrew/opt/postgresql@17/bin/initdb -D /tmp/restore-db -U restore_test -E UTF8
/opt/homebrew/opt/postgresql@17/bin/pg_ctl -D /tmp/restore-db -o "-p 5433" -l /tmp/restore-db.log -w start
/opt/homebrew/opt/postgresql@17/bin/createdb -h localhost -p 5433 -U restore_test sisolution_restore
```

The data dir lives in `/tmp` and is thrown away afterwards — nothing here touches the
running postgresql@14 service on port 5432.

## 2. Restore the backup

```bash
/opt/homebrew/opt/postgresql@17/bin/pg_restore \
  -h localhost -p 5433 -U restore_test -d sisolution_restore \
  --no-owner --no-privileges backups/sisolution-full-<timestamp>.dump
```

**Exit code 1 is expected and fine.** Supabase-only extensions (`supabase_vault`,
`pg_cron`, the `cron` schema) and grants to Supabase roles (`authenticated`, `anon`,
`service_role`) don't exist on a plain local Postgres — those objects are skipped while
all schema and data restore normally. Last verified end-to-end 2026-09-09.

## 3. Query the restored copy

```bash
/opt/homebrew/opt/postgresql@17/bin/psql -h localhost -p 5433 -U restore_test -d sisolution_restore
```

## 4. Tear down

```bash
/opt/homebrew/opt/postgresql@17/bin/pg_ctl -D /tmp/restore-db stop -m immediate
rm -rf /tmp/restore-db /tmp/restore-db.log
```

## Making a new backup

```bash
DB_URL=$(grep '^NEXT_PUBLIC_SUPABASE_DB_URL=' .env | cut -d= -f2-)
PGOPTIONS="-c statement_timeout=0" /opt/homebrew/opt/postgresql@17/bin/pg_dump \
  "${DB_URL/:6543/:5432}" -Fc -f "backups/sisolution-full-$(date +%Y%m%d-%H%M%S).dump"
```

The port swap 6543 → 5432 routes through the session pooler — `pg_dump` is unreliable
over the transaction pooler. A backup is a point-in-time snapshot: entries posted to
Supabase after the dump will not be in it.

## Restoring back into Supabase (disaster recovery)

For actual data loss, restore into a fresh Supabase project (or the same project after
`TRUNCATE`), not a local server:

```bash
NEW_DB_URL='postgresql://postgres.<ref>:<password>@aws-1-ap-southeast-2.pooler.supabase.com:5432/postgres'
/opt/homebrew/opt/postgresql@17/bin/pg_restore "$NEW_DB_URL" \
  --no-owner --no-privileges --clean --if-exists backups/sisolution-full-<timestamp>.dump
```
