-- Simulate what each repaired page will actually display, by calling the same
-- period_net_debit RPC the UI calls, over the same ranges.
-- Original complaint: "all time COGS amount is higher than sales revenue" on the
-- invoices page, accounting overview, reports page and reports/pl.

\echo '=== A. ALL TIME (the original complaint): COGS vs Revenue ==='
WITH ids AS (
  SELECT
    (SELECT id FROM accounts WHERE code = '5000' AND tenant_id = '00000000-0000-0000-0000-000000000001'::uuid) AS cogs,
    (SELECT id FROM accounts WHERE code = '4000' AND tenant_id = '00000000-0000-0000-0000-000000000001'::uuid) AS rev,
    (SELECT id FROM accounts WHERE code = '4050' AND tenant_id = '00000000-0000-0000-0000-000000000001'::uuid) AS ret
)
SELECT ROUND(period_net_credit(ids.rev,  '1900-01-01', '2100-12-31'), 2) AS revenue,
       ROUND(period_net_debit (ids.ret,  '1900-01-01', '2100-12-31'), 2) AS sales_returns,
       ROUND(period_net_debit (ids.cogs, '1900-01-01', '2100-12-31'), 2) AS cogs,
       ROUND(period_net_credit(ids.rev,  '1900-01-01', '2100-12-31')
             - GREATEST(period_net_debit(ids.ret, '1900-01-01', '2100-12-31'), 0)
             - GREATEST(period_net_debit(ids.cogs,'1900-01-01', '2100-12-31'), 0), 2) AS gross_profit,
       CASE WHEN period_net_debit(ids.cogs, '1900-01-01', '2100-12-31')
                 < period_net_credit(ids.rev, '1900-01-01', '2100-12-31')
            THEN 'PASS - COGS below revenue' ELSE 'FAIL - COGS still exceeds revenue' END AS verdict
FROM ids;

\echo ''
\echo '=== B. Monthly chart on reports page (now ledger-backed, was stock_movements) ==='
WITH ids AS (
  SELECT (SELECT id FROM accounts WHERE code = '5000' AND tenant_id = '00000000-0000-0000-0000-000000000001'::uuid) AS cogs
),
m AS (
  SELECT d::date AS month_start,
         (d + interval '1 month - 1 day')::date AS month_end,
         to_char(d, 'Mon') AS label
  FROM generate_series('2026-01-01'::date, '2026-08-01'::date, interval '1 month') d
)
SELECT m.label AS month,
       ROUND(COALESCE((SELECT SUM(total_amount) FROM invoices
                       WHERE invoice_date BETWEEN m.month_start AND m.month_end
                         AND status <> 'cancelled'), 0), 2) AS sales,
       ROUND(GREATEST(period_net_debit(ids.cogs, m.month_start, m.month_end), 0), 2) AS cogs,
       ROUND(COALESCE((SELECT SUM(total_amount) FROM invoices
                       WHERE invoice_date BETWEEN m.month_start AND m.month_end
                         AND status <> 'cancelled'), 0)
             - GREATEST(period_net_debit(ids.cogs, m.month_start, m.month_end), 0), 2) AS profit
FROM m CROSS JOIN ids ORDER BY m.month_start;

\echo ''
\echo '=== C. Period accuracy: no single day now carries a lump correction ==='
SELECT je.entry_date, COUNT(*) AS cogs_repair_entries,
       ROUND(SUM(jl.debit - jl.credit), 2) AS net_effect_on_5000
FROM journal_entries je
JOIN journal_lines jl ON jl.journal_entry_id = je.id
JOIN accounts a ON a.id = jl.account_id AND a.code = '5000'
WHERE je.reference_type = 'cogs_repair'
GROUP BY je.entry_date ORDER BY je.entry_date;

\echo ''
\echo '=== D. Day / week / quarter / year all reconcile to the same basis ==='
WITH ids AS (
  SELECT (SELECT id FROM accounts WHERE code = '5000' AND tenant_id = '00000000-0000-0000-0000-000000000001'::uuid) AS cogs,
         (SELECT id FROM accounts WHERE code = '4000' AND tenant_id = '00000000-0000-0000-0000-000000000001'::uuid) AS rev
), r(label, s, e) AS (
  VALUES ('this year',    '2026-01-01'::date, '2026-12-31'::date),
         ('Q3 2026',      '2026-07-01'::date, '2026-09-30'::date),
         ('Aug 2026',     '2026-08-01'::date, '2026-08-31'::date),
         ('Jul 2026',     '2026-07-01'::date, '2026-07-31'::date),
         ('week 8/17-23', '2026-08-17'::date, '2026-08-23'::date),
         ('day 2026-08-23','2026-08-23'::date,'2026-08-23'::date)
)
SELECT r.label AS period,
       ROUND(period_net_credit(ids.rev,  r.s, r.e), 2) AS revenue,
       ROUND(period_net_debit (ids.cogs, r.s, r.e), 2) AS cogs,
       ROUND(period_net_credit(ids.rev, r.s, r.e) - period_net_debit(ids.cogs, r.s, r.e), 2) AS gross_profit,
       CASE WHEN period_net_debit(ids.cogs, r.s, r.e) <= period_net_credit(ids.rev, r.s, r.e)
            THEN 'ok' ELSE 'COGS > revenue' END AS check
FROM r CROSS JOIN ids ORDER BY r.s, r.e;
