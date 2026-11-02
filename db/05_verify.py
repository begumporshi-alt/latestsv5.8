#!/usr/bin/env python3
"""
05_verify.py - prove the restored database matches the source before cutover.

Compares the target against db/baseline.json, which was captured from the live
source database at dump time. Every table must match its exact row count - not
approximately. A migration that loses 6 journal lines is a migration that has
silently changed the ledger.

Also asserts the two things a row-count comparison cannot see:

  * the general ledger balances (sum of debits equals sum of credits)
  * invoices and payments carry exactly ONE accounting trigger each. The
    upstream migration chain creates two, which double-posts every transaction.
    Production has only the trg_ variants, and so must the copy.

Usage:
    ./05_verify.py --url <target-db-url> [--baseline baseline.json] [--skip-contract]
"""

import argparse
import json
import os
import subprocess
import sys

PGBIN_DEFAULT = "/opt/homebrew/opt/postgresql@17/bin"
HERE = os.path.dirname(os.path.abspath(__file__))


def q(psql, url, sql):
    r = subprocess.run(
        [psql, url, "-tA", "-F", "|", "-v", "ON_ERROR_STOP=1", "-c", sql],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip())
    return [ln for ln in r.stdout.strip().splitlines() if ln]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--baseline", default=os.path.join(HERE, "baseline.json"))
    ap.add_argument("--pgbin", default=PGBIN_DEFAULT)
    ap.add_argument("--skip-contract", action="store_true")
    args = ap.parse_args()

    psql = f"{args.pgbin}/psql"
    base = json.load(open(args.baseline))

    failures = []
    warnings = []

    print("=" * 68)
    print("row counts")
    print("=" * 68)

    expected = base["table_counts"]
    actual = {}

    # Build one UNION ALL over every public table so the whole comparison is a
    # single round trip rather than 79 sequential counts.
    union = q(
        psql, args.url,
        "select string_agg(format('select %L as t, count(*)::text as n from public.%I', "
        "tablename, tablename), ' union all ') from pg_tables where schemaname='public'"
    )[0]
    actual = {t: int(n) for t, n in (r.split("|") for r in q(psql, args.url, union))}

    for table in sorted(expected):
        exp = expected[table]
        if table not in actual:
            failures.append(f"{table}: MISSING (expected {exp} rows)")
            continue
        if actual[table] != exp:
            failures.append(f"{table}: {actual[table]} rows, expected {exp}")

    extra = sorted(set(actual) - set(expected))
    for table in extra:
        warnings.append(f"{table}: present on target but not in baseline ({actual[table]} rows)")

    exp_total = sum(expected.values())
    act_total = sum(actual.values())
    print(f"tables compared : {len(expected)}")
    print(f"total rows      : {act_total} (expected {exp_total})")

    # ------------------------------------------------------------ schema shape
    print()
    print("=" * 68)
    print("schema shape")
    print("=" * 68)

    shape_sql = """
    select
      (select count(*) from pg_tables where schemaname='public'),
      (select count(*) from pg_policies where schemaname='public'),
      (select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid
        join pg_namespace n on n.oid=c.relnamespace
        where not t.tgisinternal and n.nspname='public'),
      (select count(*) from auth.users)
    """
    tables, policies, triggers, users = q(psql, args.url, shape_sql)[0].split("|")
    checks = [
        ("public tables", int(tables), base["public_tables"]),
        ("RLS policies", int(policies), base["public_policies"]),
        ("triggers", int(triggers), base["public_triggers"]),
        ("auth.users", int(users), base["auth_users"]),
    ]
    for name, got, exp in checks:
        ok = got == exp
        print(f"{'OK  ' if ok else 'FAIL'} {name:<16} {got} (expected {exp})")
        if not ok:
            failures.append(f"{name}: {got}, expected {exp}")

    # --------------------------------------------------------- ledger integrity
    print()
    print("=" * 68)
    print("ledger integrity")
    print("=" * 68)

    gl = q(psql, args.url,
           "select coalesce(sum(debit) - sum(credit), 0)::text from public.journal_lines")[0]
    ok = float(gl) == 0.0
    print(f"{'OK  ' if ok else 'FAIL'} debits - credits = {gl}")
    if not ok:
        failures.append(f"ledger out of balance by {gl}")

    trig = q(psql, args.url, """
        select c.relname, count(*)
        from pg_trigger t
        join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
        where not t.tgisinternal and n.nspname='public'
          and c.relname in ('invoices','payments')
          and t.tgname like '%accounting%'
        group by c.relname order by c.relname
    """)
    for line in trig:
        rel, cnt = line.split("|")
        ok = int(cnt) == 1
        print(f"{'OK  ' if ok else 'FAIL'} {rel}: {cnt} accounting trigger(s)")
        if not ok:
            failures.append(f"{rel} has {cnt} accounting triggers - double posting")

    # ------------------------------------------------- journal number collision
    # The application's next journal number must not already exist. LPAD(text,6,'0')
    # truncates rather than pads when the input is longer than six characters, so a
    # single over-long entry number silently collapses every subsequent number onto
    # an existing row and blocks all posting. This check catches that class of bug.
    nxt = q(psql, args.url, "select public.get_next_journal_number()")[0]
    clash = q(
        psql, args.url,
        f"select count(*) from public.journal_entries where entry_number = '{nxt}'"
    )[0]
    ok = int(clash) == 0
    print(f"{'OK  ' if ok else 'FAIL'} next journal number {nxt} is unused")
    if not ok:
        failures.append(f"next journal number {nxt} already exists - posting would fail")

    # ------------------------------------------------------------ app contract
    if not args.skip_contract:
        print()
        print("=" * 68)
        print("application contract")
        print("=" * 68)
        for f in ("verify/00_verify_schema.sql", "verify/01_app_contract.sql"):
            path = os.path.join(HERE, f)
            r = subprocess.run(
                [psql, args.url, "-q", "-v", "ON_ERROR_STOP=1", "-f", path],
                capture_output=True, text=True,
            )
            if r.returncode == 0:
                print(f"OK   {f}")
            else:
                print(f"FAIL {f}")
                print("     " + r.stderr.strip().splitlines()[-1] if r.stderr else "")
                failures.append(f"{f} failed")

    # ------------------------------------------------------------------ report
    print()
    print("=" * 68)
    for w in warnings:
        print(f"WARN  {w}")
    if failures:
        print(f"FAILED - {len(failures)} problem(s):")
        for f in failures:
            print(f"  - {f}")
        print("=" * 68)
        print("Do NOT cut the application over to this database.")
        return 1

    print("PASS - target matches the source baseline.")
    print("=" * 68)
    return 0


if __name__ == "__main__":
    sys.exit(main())
