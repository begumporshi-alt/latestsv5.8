#!/usr/bin/env python3
"""
02_extract_auth.py - extract auth.users and auth.identities from a dump and
emit SQL that can be replayed into the new Supabase project.

Why this exists
---------------
auth.users lives in the `auth` schema, which is owned by Supabase's
supabase_auth_admin. It is not part of the application's public schema, so a
`pg_restore -n public` migration silently drops it. That would be fatal here:
every public table that references a user (profiles.id, employees.user_id,
created_by columns, tenant ownership) points at an auth.users UUID. Recreating
users through the dashboard or the Admin API assigns NEW UUIDs and breaks
every one of those references.

Restoring the rows preserves both the UUIDs and the bcrypt password hashes, so
users keep their existing logins.

Column handling
---------------
The source and target GoTrue versions may not expose identical columns. This
script intersects the dump's column list with the target's actual columns, so
the COPY succeeds across minor auth-schema differences. If the target has a
NOT NULL column with no default that the dump cannot supply, it aborts rather
than emitting data that will fail halfway through.

Usage:
    ./02_extract_auth.py --dump <file.dump> --url <target-db-url> --out auth_data.sql
"""

import argparse
import re
import subprocess
import sys

PGBIN_DEFAULT = "/opt/homebrew/opt/postgresql@17/bin"
TABLES = ["users", "identities"]


def run(cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw)


def target_columns(psql, url, table):
    """Return [(name, is_nullable, has_default, is_generated)] in ordinal order."""
    sql = (
        "select column_name, is_nullable, "
        "coalesce(column_default, '') <> '' as has_default, "
        "is_generated = 'ALWAYS' as is_generated "
        "from information_schema.columns "
        f"where table_schema='auth' and table_name='{table}' "
        "order by ordinal_position"
    )
    out = run([psql, url, "-tA", "-F", "|", "-c", sql]).stdout
    cols = []
    for line in out.strip().splitlines():
        if not line.strip():
            continue
        name, nullable, has_def, gen = line.split("|")
        cols.append((name, nullable == "YES", has_def == "t", gen == "t"))
    return cols


def dump_copy_block(pg_restore, dump, table):
    """Return (columns, data_lines) for auth.<table>, or (None, None)."""
    sql = run(
        [pg_restore, "--data-only", "-n", "auth", "-t", table, "-f", "-", dump]
    ).stdout

    header_re = re.compile(r"^COPY auth\.%s \((.+?)\) FROM stdin;$" % table, re.M)
    m = header_re.search(sql)
    if not m:
        return None, None

    columns = [c.strip() for c in m.group(1).split(",")]

    # m.end() sits immediately after the semicolon, so the remainder starts with
    # the newline that terminates the header. Dropping it prevents an empty
    # string from being read as the first data row.
    rest = sql[m.end():]
    if rest.startswith("\n"):
        rest = rest[1:]

    data = []
    for line in rest.splitlines():
        if line == "\\.":
            break
        if line.startswith("\\"):
            continue
        data.append(line)
    return columns, data


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump", required=True)
    ap.add_argument("--url", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--pgbin", default=PGBIN_DEFAULT)
    args = ap.parse_args()

    pg_restore = f"{args.pgbin}/pg_restore"
    psql = f"{args.pgbin}/psql"

    chunks = []
    report = []

    for table in TABLES:
        src_cols, data = dump_copy_block(pg_restore, args.dump, table)
        if src_cols is None:
            print(f"  {table}: no data in dump, skipped")
            continue

        tgt_cols = target_columns(psql, args.url, table)
        if not tgt_cols:
            sys.exit(f"ERROR: auth.{table} does not exist on the target project")

        # Generated columns compute themselves and reject any supplied value.
        # Supabase's auth.users.confirmed_at and auth.identities.email are both
        # GENERATED ALWAYS, so they must be excluded from the COPY column list.
        insertable = [name for name, _n, _d, gen in tgt_cols if not gen]
        shared = [c for c in insertable if c in set(src_cols)]

        # A NOT NULL column with no default that the dump cannot populate means
        # the COPY would fail on every row. Fail loudly and early instead.
        blockers = [
            name
            for name, nullable, has_def, gen in tgt_cols
            if not nullable and not has_def and not gen and name not in set(shared)
        ]
        if blockers:
            sys.exit(
                f"ERROR: auth.{table} on the target requires {blockers} "
                "with no default, but the dump does not supply them.\n"
                "       The target GoTrue schema is incompatible; resolve manually."
            )

        dropped = [c for c in src_cols if c not in set(shared)]
        added = [c for c in insertable if c not in set(src_cols)]
        generated = [n for n, _n, _d, gen in tgt_cols if gen]
        report.append(
            f"  {table}: {len(data)} rows, {len(shared)} columns"
            + (f", dropped {dropped}" if dropped else "")
            + (f", target-only {added}" if added else "")
            + (f", generated (skipped) {generated}" if generated else "")
        )

        chunks.append(
            f"COPY auth.{table} ({', '.join(shared)}) FROM stdin;\n"
            + "\n".join(data)
            + "\n\\.\n"
        )

    if not chunks:
        sys.exit("ERROR: nothing to extract")

    header = (
        "-- generated by 02_extract_auth.py\n"
        "-- Restores Supabase auth users and identities with original UUIDs and\n"
        "-- password hashes. Must run BEFORE the public schema's post-data pass,\n"
        "-- otherwise the on_auth_user_created trigger collides with restored profiles.\n"
        "BEGIN;\n"
    )

    with open(args.out, "w") as fh:
        fh.write(header)
        fh.write("\n".join(chunks))
        fh.write("COMMIT;\n")

    print("\n".join(report))
    print(f"  -> {args.out}")


if __name__ == "__main__":
    main()
