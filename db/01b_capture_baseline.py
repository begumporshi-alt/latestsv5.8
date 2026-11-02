#!/usr/bin/env python3
"""
01b_capture_baseline.py - capture the verification baseline at dump time.

Why this exists
---------------
`05_verify.py` compares the restored target against `baseline.json` row by row.
That file has to describe the SAME moment as the dump, or the comparison is
meaningless: restore a dump taken a week later and every table that saw any
traffic reports a mismatch, while a genuinely lost row hides among the noise.

The baseline therefore cannot be a committed constant that someone remembers to
update. It is captured by `01_dump_source.sh` immediately after `pg_dump`
returns, from the same database, so the two always agree.

The SQL below is deliberately identical to `05_verify.py`'s, so a freshly
captured baseline is guaranteed to be comparable with what the verifier reads.

Usage:
    ./01b_capture_baseline.py --url <source-db-url> [--out baseline.json]
                              [--dump-file cutover-XXXX.dump]
                              [--project-ref abcd] [--region ap-southeast-2]
"""

import argparse
import datetime
import json
import os
import re
import subprocess
import sys

PGBIN_DEFAULT = "/opt/homebrew/opt/postgresql@17/bin"
HERE = os.path.dirname(os.path.abspath(__file__))

# Must stay in step with 05_verify.py.
SHAPE_SQL = """
select
  (select count(*) from pg_tables where schemaname='public'),
  (select count(*) from pg_policies where schemaname='public'),
  (select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid
    join pg_namespace n on n.oid=c.relnamespace
    where not t.tgisinternal and n.nspname='public'),
  (select count(*) from auth.users)
"""

TABLE_LIST_SQL = (
    "select string_agg(format('select %L as t, count(*)::text as n from public.%I', "
    "tablename, tablename), ' union all ') from pg_tables where schemaname='public'"
)


def q(psql, url, sql):
    proc = subprocess.run(
        [psql, url, "-tAF|", "-c", sql],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        raise SystemExit(f"psql failed for: {sql[:80]}...")
    return [line for line in proc.stdout.strip().splitlines() if line]


def infer_project_ref(url):
    # postgres://postgres.<ref>:...@aws-0-<region>.pooler.supabase.com
    # postgres://postgres:<pw>@db.<ref>.supabase.co
    match = re.search(r"db\.([a-z0-9]+)\.supabase\.co", url)
    if match:
        return match.group(1)
    match = re.search(r"postgres\.([a-z0-9]+)[:@]", url)
    if match:
        return match.group(1)
    return None


def infer_region(url):
    match = re.search(r"@aws-[0-9]-([a-z0-9-]+)\.pooler\.supabase\.com", url)
    return match.group(1) if match else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--out", default=os.path.join(HERE, "baseline.json"))
    ap.add_argument("--pgbin", default=PGBIN_DEFAULT)
    ap.add_argument("--dump-file", default=None)
    ap.add_argument("--project-ref", default=None)
    ap.add_argument("--region", default=None)
    args = ap.parse_args()

    psql = f"{args.pgbin}/psql"
    if not os.access(psql, os.X_OK):
        raise SystemExit(f"psql not found at {psql}")

    union = q(psql, args.url, TABLE_LIST_SQL)[0]
    table_counts = {}
    if union:
        for row in q(psql, args.url, union):
            table, count = row.split("|")
            table_counts[table] = int(count)

    shape = q(psql, args.url, SHAPE_SQL)[0].split("|")
    public_tables, public_policies, public_triggers, auth_users = (int(v) for v in shape)

    baseline = {
        "captured_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "source_project_ref": args.project_ref or infer_project_ref(args.url),
        "source_region": args.region or infer_region(args.url),
        "dump_file": os.path.basename(args.dump_file) if args.dump_file else None,
        "dump_sha256_note": "see checksums.txt next to the dump",
        "public_tables": public_tables,
        "public_policies": public_policies,
        "public_triggers": public_triggers,
        "auth_users": auth_users,
        "total_rows": sum(table_counts.values()),
        "table_counts": dict(sorted(table_counts.items())),
    }

    with open(args.out, "w") as handle:
        json.dump(baseline, handle, indent=2)
        handle.write("\n")

    print(f"==> baseline written: {args.out}")
    print(f"    captured_at   : {baseline['captured_at']}")
    print(f"    tables        : {public_tables}")
    print(f"    total rows    : {baseline['total_rows']:,}")
    print(f"    policies      : {public_policies}")
    print(f"    triggers      : {public_triggers}")
    print(f"    auth.users    : {auth_users}")


if __name__ == "__main__":
    main()
