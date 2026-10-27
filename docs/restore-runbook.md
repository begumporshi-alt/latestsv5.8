# Disaster-Recovery Runbook — sisolution database

**Last rehearsed:** 2026-10-27 — full local drill passed (§4): the dump restored
into a throwaway Postgres 17 with all business tables + `auth.users` intact and
the journal balanced to the cent.
**Nightly backups:** every device? No — one machine: Tusher's Mac (launchd agent
`com.sisolution.db-backup`), dumping at **03:00** into `~/Backups/sisolution/`.

## 1. What exists

| Asset | Location | Contains |
|---|---|---|
| Nightly `pg_dump` | `~/Backups/sisolution/sisolution-YYYYMMDD-HHMM.dump` | Full logical dump: all 133 data tables incl. `auth.users` (login accounts), schema, triggers, RPCs, RLS. Compressed custom format. |
| Dump script | `scripts/db-backup.sh` (repo) | Reads `NEXT_PUBLIC_SUPABASE_DB_URL` from `.env`, dumps, verifies, keeps 30 |
| Scheduler | `scripts/launchd/com.sisolution.db-backup.plist` → installed at `~/Library/LaunchAgents/` | Runs the script daily at 03:00 |
| Log | `~/Backups/sisolution/backup.log` | One line per run (`OK:` / `ERROR:`) |
| Manual device backup (`.sibak`) | Sync page → Storage backup card | Encrypted per-device replica + pending outbox; passphrase-protected |
| Schema source of truth | `supabase/migrations/` in git | Every table/trigger/RPC/policy, replayable into an empty Postgres |

**RPO (data loss window):** up to 24 h of writes since the last 03:00 dump,
unless a device's `.sibak`/replica is newer — device replicas hold the last
24 h too and pending outbox items can be re-synced, so realistic loss is small.
**RTO (restore time):** ~1 h rehearsed, see §3.

## 2. Check it's alive

```bash
tail -5 ~/Backups/sisolution/backup.log          # look for "OK:" lines, one per day
ls -lht ~/Backups/sisolution/*.dump | head -3    # today's file exists, ~7 MB
```
The dump size is currently ~7 MB; if it collapses to KBs, investigate.

## 3. Restore into a fresh Supabase project (account lost / corrupted)

Prereqs: a new Supabase project, `supabase CLI` optional, `psql` +
`/opt/homebrew/opt/postgresql@17/bin/pg_restore` installed (the server is
Postgres 17; the PATH default pg_restore is v14 and cannot read the archive).

1. Create the new project; copy its **connection string** (Settings → Database).
2. **Restore data, then migrations replay nothing** — the dump already contains
   the full schema, so do NOT run the migration chain afterwards (it would
   conflict). Restore directly:
   ```bash
   pg_restore --no-owner --no-privileges -d "<NEW_PROJECT_DB_URL>" \
     ~/Backups/sisolution/sisolution-<latest>.dump
   ```
   Expect ~230 errors you can ignore. In the 2026-10-27 drill every one was
   Supabase-platform-only: GRANT/ownership statements referencing the
   `authenticated` role (221 of them), the `cron` schema (pg_cron), and
   `vault.secrets` (supabase_vault). A fresh Supabase project HAS those
   roles and extensions, so a real restore will see even fewer. With
   `--exit-on-error` off (the default) everything restorable is restored;
   re-run the core-table checks in step 3.
3. Verify:
   ```sql
   select count(*) from public.products;        -- ~2.5k
   select count(*) from public.invoices;        -- matches backup date
   select count(*) from auth.users;             -- login accounts survived
   ```
   and in the app: log in (magic link must be enabled on the new project),
   open POS, confirm catalog + stock.
4. **Point the app at the new project** — the only env changes:
   `.env`: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_DB_URL`
   from the new project. Redeploy.
5. **Re-enable email auth**: on the new project, magic-link must be ON; users
   from the old project carry over (emails + password hashes), but their
   `email_confirmed` state and new confirmation emails depend on the new
   project's SMTP settings — test one login per role.
6. Update `scripts/db-backup.sh`'s source via the new `.env`, reload nothing
   (script reads `.env` each run).

## 4. The drill — done 2026-10-27 ✅ (repeat after major schema changes)

Rehearse on a LOCAL Postgres, not a new cloud project (zero cost, zero risk):

```bash
createdb sisolution_drill
pg_restore --no-owner --no-privileges -d sisolution_drill \
  ~/Backups/sisolution/sisolution-<latest>.dump
psql sisolution_drill -tAc "select count(*) from public.invoices;"
psql sisolution_drill -tAc "select count(*) from auth.users;"
```
If both counts look sane, you have proven the RTO and the dump is restorable.
Delete after: `dropdb sisolution_drill`.

**2026-10-27 result:** `sisolution-20261027-0641.dump` restored into a
throwaway `initdb` cluster on port 5433 in ~2 minutes. 231 errors, all
Supabase-platform-only (classes listed in §3). Verified against the live DB
at dump time: products 2,939 · invoices 1,265 · customers 242 ·
invoice_items 3,816 · journal_entries 6,474 · journal_lines 16,130 ·
inventory_batches 2,882 · payments 1,919 · auth.users 8 — and the journal
balanced exactly: Dr = Cr = ৳170,837,087.30 (difference 0). The drill
cluster was stopped and deleted afterwards.

## 5. Known gaps (accepted for now)

- **Off-site copy.** `~/Backups/sisolution` is on one machine. Until an
  off-site copy exists (Time Machine to an external disk counts; or sync the
  folder to iCloud/Drive), a house fire or disk loss defeats everything. The
  dumps are unencrypted — treat the folder like the DB password; encrypt
  before using a cloud provider.
- **Storage bucket files** (company logo) are metadata-in-dump but objects are
  not; re-upload manually if ever needed.
- **Edge functions** are in `supabase/functions/` in git — redeployable, no backup needed.
- Backup depends on this Mac being on at 03:00; launchd runs a missed
  calendar job at the next wake, but after very long off periods check §2.
