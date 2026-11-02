#!/usr/bin/env bash
# ============================================================================
# 06_seed_migration_history.sh
# ----------------------------------------------------------------------------
# Record the repo's migration files in `supabase_migrations.schema_migrations`.
#
# Why this is needed after a cutover
# ----------------------------------
# The restore kit rebuilds `public` from a pg_dump, which is byte-for-byte the
# source data. The new project's own `supabase_migrations.schema_migrations`
# is therefore empty (or holds only whatever the platform created), even though
# every migration is already reflected in the restored schema.
#
# Left that way, a later `supabase db push` believes nothing has been applied
# and tries to replay the entire history against a populated database -- which
# fails on the first non-idempotent `create table` or `alter table ... add
# column`, and can partially apply changes before it stops.
#
# Seeding the table makes the history match reality: the schema is at version X,
# and only migrations after X are pending.
#
# Usage
# -----
#   ./06_seed_migration_history.sh "$TARGET_DB_URL" [--until VERSION] [--dry-run]
#
#   --until VERSION  Only seed versions <= VERSION. Use the timestamp of the
#                    migration that was current when the dump was taken. Any
#                    migration written after the dump is NOT in the restored
#                    schema, and must stay unrecorded so it can be applied.
#   --dry-run        Print the SQL and the counts; change nothing.
#
# Safe to run repeatedly: inserts use ON CONFLICT (version) DO NOTHING.
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/supabase/migrations"

DB_URL="${1:-${NEXT_PUBLIC_SUPABASE_DB_URL:-${SUPABASE_DB_URL:-}}}"
if [[ -z "$DB_URL" ]]; then
  echo "ERROR: no database URL. Pass it as the first argument or set NEXT_PUBLIC_SUPABASE_DB_URL." >&2
  exit 1
fi

UNTIL=""
DRY_RUN=0
shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --until) UNTIL="${2:-}"; shift 2 ;;
    --until=*) UNTIL="${1#*=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ ! -d "$MIGRATIONS_DIR" ]]; then
  echo "ERROR: $MIGRATIONS_DIR not found" >&2
  exit 1
fi

TMP_SQL="$(mktemp)"
TMP_RECORDED="$(mktemp)"
TMP_FILES="$(mktemp)"
trap 'rm -f "$TMP_SQL" "$TMP_RECORDED" "$TMP_FILES"' EXIT

{
  echo "begin;"
  echo "create schema if not exists supabase_migrations;"
  echo "create table if not exists supabase_migrations.schema_migrations ("
  echo "  version text primary key, statements text[], name text"
  echo ");"
} > "$TMP_SQL"

COUNT=0
while IFS= read -r file; do
  base="$(basename "$file")"
  # Strip .sql, twice: a few files carry a doubled extension.
  base="${base%.sql}"
  base="${base%.sql}"
  version="${base%%_*}"
  name="${base#*_}"
  [[ "$name" == "$base" ]] && name=""

  # Only 14-digit numeric timestamps are migrations.
  [[ "$version" =~ ^[0-9]{14}$ ]] || continue
  if [[ -n "$UNTIL" && "$version" > "$UNTIL" ]]; then
    continue
  fi

  escaped_name="${name//\'/\'\'}"
  printf "insert into supabase_migrations.schema_migrations (version, name) values ('%s', '%s') on conflict (version) do nothing;\n" \
    "$version" "$escaped_name" >> "$TMP_SQL"
  COUNT=$((COUNT + 1))
done < <(find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.sql' | sort)

echo "commit;" >> "$TMP_SQL"

echo "migrations on disk: $COUNT${UNTIL:+ (<= $UNTIL)}"

BEFORE="$(psql "$DB_URL" -tAc "select count(*) from supabase_migrations.schema_migrations" 2>/dev/null || echo 0)"
echo "recorded before:    $BEFORE"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "--- dry run, SQL follows ---"
  cat "$TMP_SQL"
  exit 0
fi

psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$TMP_SQL"

AFTER="$(psql "$DB_URL" -tAc "select count(*) from supabase_migrations.schema_migrations")"
echo "recorded after:     $AFTER"

psql "$DB_URL" -tAc "select version from supabase_migrations.schema_migrations order by version" > "$TMP_RECORDED"
find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.sql' -exec basename {} \; \
  | sed 's/\.sql$//; s/\.sql$//' \
  | awk -F_ '{print $1}' \
  | grep -E '^[0-9]{14}$' \
  | sort -u > "$TMP_FILES"

MISSING="$(comm -23 "$TMP_RECORDED" "$TMP_FILES" | wc -l | tr -d ' ')"
PENDING="$(comm -13 "$TMP_RECORDED" "$TMP_FILES" | wc -l | tr -d ' ')"

# Recorded versions with no file are real historical migrations whose file was
# removed or renamed. They are not errors and are left untouched.
echo "recorded with no file on disk: $MISSING (historical only)"
echo "files not yet recorded:        $PENDING"

if [[ "$PENDING" -gt 0 ]]; then
  echo "WARNING: $PENDING migration file(s) remain unrecorded -- inspect before relying on this history." >&2
  comm -13 "$TMP_RECORDED" "$TMP_FILES" >&2
  exit 2
fi
