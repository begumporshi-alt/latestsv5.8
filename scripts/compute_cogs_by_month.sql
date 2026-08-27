-- Per-month true COGS vs current journal COGS.
-- The single lump correction dated today distorts monthly P&L: it reverses in
-- August an overstatement that was booked mostly in July. This sizes a
-- per-month correction instead.
--
-- True COGS attributed to the month of the INVOICE date (matching revenue
-- recognition), using the same per-item basis as the migration:
--   item has consumption rows -> SUM(cogs_amount)
--   item has none             -> quantity * cost_price

\echo '=== Per-month: true COGS vs current journal COGS vs revenue ==='
WITH item_true AS (
  SELECT i.id AS invoice_id,
         to_char(i.invoice_date,'YYYY-MM') AS month,
         COALESCE(
           (SELECT SUM(ibc.cogs_amount) FROM invoice_item_batch_consumption ibc
            WHERE ibc.invoice_item_id = ii.id),
           ii.quantity * ii.cost_price
         ) AS true_cost
  FROM invoice_items ii
  JOIN invoices i ON i.id = ii.invoice_id
  WHERE i.status IN ('sent','partially_paid','paid')
),
target_by_month AS (
  SELECT month, SUM(true_cost) AS target_cogs FROM item_true GROUP BY month
),
journal_by_month AS (
  SELECT to_char(je.entry_date,'YYYY-MM') AS month,
         SUM(jl.debit - jl.credit) AS journal_cogs
  FROM journal_lines jl
  JOIN journal_entries je ON je.id = jl.journal_entry_id
  JOIN accounts a ON a.id = jl.account_id
  WHERE a.code = '5000'
    AND a.tenant_id = '00000000-0000-0000-0000-000000000001'::uuid
  GROUP BY 1
),
rev_by_month AS (
  SELECT to_char(invoice_date,'YYYY-MM') AS month, SUM(total_amount) AS revenue
  FROM invoices WHERE status <> 'cancelled' GROUP BY 1
)
SELECT COALESCE(t.month, j.month, r.month) AS month,
       ROUND(COALESCE(t.target_cogs,0),2)  AS target_cogs,
       ROUND(COALESCE(j.journal_cogs,0),2) AS journal_cogs_now,
       ROUND(COALESCE(j.journal_cogs,0) - COALESCE(t.target_cogs,0),2) AS correction_needed,
       ROUND(COALESCE(r.revenue,0),2)      AS revenue,
       ROUND(COALESCE(t.target_cogs,0) / NULLIF(r.revenue,0) * 100,2) AS target_pct_of_rev
FROM target_by_month t
FULL OUTER JOIN journal_by_month j ON j.month = t.month
FULL OUTER JOIN rev_by_month r ON r.month = COALESCE(t.month, j.month)
ORDER BY 1;

\echo ''
\echo '=== Existing lump correction to be replaced ==='
SELECT je.entry_number, je.entry_date, ROUND(je.total_debit,2) AS amount
FROM journal_entries je WHERE je.reference_type = 'cogs_correction'
ORDER BY je.entry_date;
