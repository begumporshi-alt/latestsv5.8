-- Analyze the COGS journal-entry landscape before in-place repair.
-- Goal: understand entry shapes per invoice so we can delete duplicates and
-- reset surviving entries to true per-invoice COGS, making EVERY date range
-- (day/week/month/quarter/year) report correctly.

\echo '=== 1. COGS entry description shapes ==='
SELECT CASE
         WHEN je.description LIKE 'COGS (FIFO)%'      THEN 'fifo_invoice_level'
         WHEN je.description LIKE 'COGS - % - Item %' THEN 'per_item'
         WHEN je.description LIKE 'COGS - % items, total%' THEN 'invoice_level_total'
         WHEN je.description LIKE 'COGS%'             THEN 'other_cogs'
         ELSE 'non_cogs'
       END AS shape,
       COUNT(*) AS entries,
       COUNT(DISTINCT je.reference_id) AS invoices,
       ROUND(SUM(je.total_debit),2) AS total_debit
FROM journal_entries je
WHERE je.description LIKE 'COGS%'
GROUP BY 1 ORDER BY 2 DESC;

\echo ''
\echo '=== 2. Entries per invoice: duplicate distribution ==='
WITH per_inv AS (
  SELECT je.reference_id AS invoice_id, COUNT(*) AS je_count,
         ROUND(SUM(je.total_debit),2) AS booked
  FROM journal_entries je
  WHERE je.description LIKE 'COGS%' AND je.reference_type = 'invoice'
  GROUP BY 1
)
SELECT je_count AS cogs_entries_per_invoice, COUNT(*) AS invoices,
       ROUND(SUM(booked),2) AS booked_total
FROM per_inv GROUP BY 1 ORDER BY 1;

\echo ''
\echo '=== 3. Per invoice: booked vs true COGS (the repair target) ==='
WITH item_true AS (
  SELECT ii.invoice_id,
         SUM(COALESCE(
           (SELECT SUM(ibc.cogs_amount) FROM invoice_item_batch_consumption ibc
            WHERE ibc.invoice_item_id = ii.id),
           ii.quantity * ii.cost_price)) AS true_cogs
  FROM invoice_items ii
  JOIN invoices i ON i.id = ii.invoice_id
  WHERE i.status IN ('sent','partially_paid','paid')
  GROUP BY 1
),
booked AS (
  SELECT je.reference_id AS invoice_id, COUNT(*) AS je_count,
         SUM(je.total_debit) AS booked_cogs
  FROM journal_entries je
  WHERE je.description LIKE 'COGS%' AND je.reference_type = 'invoice'
  GROUP BY 1
)
SELECT CASE
         WHEN b.invoice_id IS NULL THEN 'true_cogs_but_no_je'
         WHEN t.invoice_id IS NULL THEN 'je_but_no_true_cogs'
         WHEN ROUND(b.booked_cogs,2) = ROUND(t.true_cogs,2) THEN 'match'
         WHEN b.booked_cogs > t.true_cogs THEN 'overbooked'
         ELSE 'underbooked'
       END AS bucket,
       COUNT(*) AS invoices,
       ROUND(SUM(COALESCE(b.booked_cogs,0)),2) AS booked,
       ROUND(SUM(COALESCE(t.true_cogs,0)),2)   AS truth,
       ROUND(SUM(COALESCE(b.booked_cogs,0) - COALESCE(t.true_cogs,0)),2) AS delta
FROM item_true t
FULL OUTER JOIN booked b ON b.invoice_id = t.invoice_id
GROUP BY 1 ORDER BY ABS(SUM(COALESCE(b.booked_cogs,0) - COALESCE(t.true_cogs,0))) DESC;

\echo ''
\echo '=== 4. Do COGS entries have exactly 2 lines (5000 Dr / 1200 Cr)? ==='
SELECT line_count, COUNT(*) AS entries
FROM (
  SELECT je.id, COUNT(jl.id) AS line_count
  FROM journal_entries je
  JOIN journal_lines jl ON jl.journal_entry_id = je.id
  WHERE je.description LIKE 'COGS%' AND je.reference_type = 'invoice'
  GROUP BY je.id
) x GROUP BY 1 ORDER BY 1;

\echo ''
\echo '=== 5. Accounts touched by COGS entries (expect only 5000 and 1200) ==='
SELECT a.code, a.name, COUNT(*) AS lines,
       ROUND(SUM(jl.debit),2) AS dr, ROUND(SUM(jl.credit),2) AS cr
FROM journal_lines jl
JOIN journal_entries je ON je.id = jl.journal_entry_id
JOIN accounts a ON a.id = jl.account_id
WHERE je.description LIKE 'COGS%' AND je.reference_type = 'invoice'
GROUP BY 1,2 ORDER BY 3 DESC;
