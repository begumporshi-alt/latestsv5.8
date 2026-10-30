#!/usr/bin/env bash
#
# 01_dump_source.sh - take a fresh full dump of the CURRENT (source) database.
#
# Run this only while no business transactions are being written. There is no
# change-data-capture layer, so anything written after the dump is lost.
#
# Usage:
#   ./01_dump_source.sh <source-db-url> [output.dump]
#
set -euo pipefail

PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
DB_URL="${1:-}"
OUT="${2:-$HOME/Backups/sisolution/cutover-$(date +%Y%m%d-%H%M).dump}"

if [[ -z "$DB_URL" ]]; then
  echo "usage: $0 <source-db-url> [output.dump]" >&2
  exit 2
fi
if [[ ! -x "$PGBIN/pg_dump" ]]; then
  echo "ERROR: pg_dump not found at $PGBIN/pg_dump" >&2
  exit 2
fi

echo "==> pg_dump $("$PGBIN/pg_dump" --version | awk '{print $3}')"
echo "==> output: $OUT"

# A full archive, no ownership or grants. Ownership and privileges are
# re-derived from the target project's roles at restore time; carrying the
# source project's role names over produces hundreds of harmless errors.
"$PGBIN/pg_dump" \
  -Fc \
  --no-owner \
  --no-privileges \
  --verbose \
  -d "$DB_URL" \
  -f "$OUT" \
  2> "${OUT%.dump}.log"

SIZE=$(ls -lh "$OUT" | awk '{print $5}')
echo "==> dump complete: $SIZE"

# Prove the archive is readable before declaring success. A truncated archive
# still produces a file, so file size alone is not evidence.
ENTRIES=$("$PGBIN/pg_restore" -l "$OUT" 2>/dev/null | grep -c '^[0-9]' || true)
if [[ "$ENTRIES" -lt 1000 ]]; then
  echo "ERROR: archive table of contents looks truncated ($ENTRIES entries)" >&2
  exit 1
fi
echo "==> archive verified: $ENTRIES TOC entries"

shasum -a 256 "$OUT" | tee -a "$(dirname "$OUT")/checksums.txt"
echo "==> recorded checksum"
