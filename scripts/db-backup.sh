#!/bin/bash
# Nightly logical backup of the sisolution Supabase Postgres database.
#
# Runs from the launchd agent com.sisolution.db-backup (scripts/launchd/),
# but is safe to run manually:  scripts/db-backup.sh
#
# What it produces (in $BACKUP_DIR, default ~/Backups/sisolution):
#   sisolution-YYYYMMDD-HHMM.dump   pg_dump custom format, compressed
#   backup.log                      one line per run
# Retention: the newest 30 dumps are kept, older ones deleted.
#
# The dump includes auth.* (users) and storage metadata because it is a full
# cluster-database dump through the postgres role — see
# docs/restore-runbook.md for how to restore it into a fresh project.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${SISOLUTION_BACKUP_DIR:-$HOME/Backups/sisolution}"
PG_DUMP="/opt/homebrew/opt/libpq/bin/pg_dump"
PG_RESTORE="/opt/homebrew/opt/libpq/bin/pg_restore"
KEEP_DAILY=30
LOG="$BACKUP_DIR/backup.log"

mkdir -p "$BACKUP_DIR"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" | tee -a "$LOG"; }

# Read the DB URL straight from the repo's .env so credentials live in one place.
DB_URL="$(grep '^NEXT_PUBLIC_SUPABASE_DB_URL=' "$REPO_DIR/.env" | cut -d= -f2- | tr -d '"' | tr -d "'")"
if [ -z "$DB_URL" ]; then
  log "ERROR: NEXT_PUBLIC_SUPABASE_DB_URL not found in $REPO_DIR/.env"
  exit 1
fi

STAMP="$(date '+%Y%m%d-%H%M')"
OUT="$BACKUP_DIR/sisolution-$STAMP.dump"

log "Dump start -> $OUT"
if "$PG_DUMP" --no-owner --no-privileges -Fc -f "$OUT" "$DB_URL" 2>>"$LOG"; then
  SIZE=$(du -h "$OUT" | cut -f1)
  # Sanity check: the archive must be listable and contain the core tables.
  if "$PG_RESTORE" --list "$OUT" | grep -q "TABLE DATA public products" && \
     "$PG_RESTORE" --list "$OUT" | grep -q "TABLE DATA auth users"; then
    log "OK: $OUT ($SIZE)"
  else
    log "WARN: dump written ($SIZE) but products/auth.users not found in archive — inspect it"
  fi
else
  log "ERROR: pg_dump failed; removing partial file"
  rm -f "$OUT"
  exit 1
fi

# Retention
ls -1t "$BACKUP_DIR"/sisolution-*.dump 2>/dev/null | tail -n +$((KEEP_DAILY + 1)) | while read -r old; do
  rm -f "$old"
  log "Pruned old dump: $old"
done
