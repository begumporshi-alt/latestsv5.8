-- Breakdown RPC explaining WHY Total COGS (journal, account 5000) differs
-- from Total Cost (History) on the invoices page.
--
-- Gap = journal_cogs − history_total where:
--   journal_cogs  = net 5000 by entry_date in period (exactly what the
--                   Total COGS card shows via period_net_debit)
--   history_total = Σ cost_price_history over active (non-cancelled,
--                   non-draft) invoices dated in period (exactly what the
--                   Total Cost (History) card shows)
--
-- Components (each signed, sum + residual = gap):
--   returns_credit : sales_return COGS reversal credits dated in period —
--                    journal side drops, history is never rewritten
--   cancelled_net  : net COGS of cancelled invoices (their ^COGS postings
--                    plus cancel reversals) — sits in the journal with no
--                    history counterpart (cancelled invoices are excluded
--                    from the history card)
--   stale_history / journal_wrong / both_off : per-invoice C−B over active
--                    invoices dated in period, classified by which side
--                    disagrees with items × cost (A) using the audit's
--                    tolerance (±1 or 1% + 10 of a positive A) — same
--                    classification the COGS Audit History Δ tab repairs
--   residual       : timing differences (entries dated in period for
--                    invoices outside it, e.g. edited invoices reposted
--                    later) and anything else — kept visible, never hidden

BEGIN;

CREATE OR REPLACE FUNCTION get_cogs_history_gap_breakdown(
  p_start_date date DEFAULT NULL,
  p_end_date date DEFAULT NULL
) RETURNS TABLE(
  journal_cogs numeric,
  history_total numeric,
  gap numeric,
  returns_credit numeric,
  cancelled_net numeric,
  stale_history numeric,
  stale_history_count integer,
  journal_wrong numeric,
  journal_wrong_count integer,
  both_off numeric,
  both_off_count integer,
  residual numeric
) LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
WITH bounds AS (
  SELECT COALESCE(p_start_date, '1900-01-01'::date) AS s,
         COALESCE(p_end_date,   '2100-12-31'::date) AS e
),
-- GL 5000 net by family over the period (same basis as period_net_debit)
gl AS (
  SELECT
    CASE
      WHEN je.reference_type = 'sales_return' THEN 'returns'
      WHEN je.reference_type = 'invoice_cancel' THEN 'cancelled'
      WHEN je.reference_type IN ('invoice', 'invoice_edit')
           AND inv.status = 'cancelled' THEN 'cancelled'
      ELSE 'invoice'
    END AS family,
    SUM(jl.debit - jl.credit) AS net
  FROM journal_lines jl
  JOIN journal_entries je ON je.id = jl.journal_entry_id
  JOIN accounts a ON a.id = jl.account_id AND a.code = '5000'
  LEFT JOIN invoices inv ON inv.id = je.reference_id
                        AND je.reference_type IN ('invoice', 'invoice_edit')
  WHERE je.entry_date BETWEEN (SELECT s FROM bounds) AND (SELECT e FROM bounds)
  GROUP BY 1
),
-- Per-invoice bases over active invoices DATED in the period (the history
-- card's basis). je_c is the invoice's own COGS entries regardless of their
-- posting date, so classification is stable across periods.
items AS (
  SELECT invoice_id, SUM(quantity * cost_price) AS a
  FROM invoice_items WHERE quantity > 0 GROUP BY invoice_id
),
hist AS (
  SELECT invoice_id, SUM(cost_price_for_added_qty) AS b
  FROM cost_price_history GROUP BY invoice_id
),
jec AS (
  SELECT je.reference_id AS invoice_id, SUM(jl.debit - jl.credit) AS c
  FROM journal_lines jl
  JOIN journal_entries je ON je.id = jl.journal_entry_id
  JOIN accounts a ON a.id = jl.account_id AND a.code = '5000'
  WHERE je.reference_type IN ('invoice', 'invoice_edit')
    AND je.description ~* '^COGS'
  GROUP BY je.reference_id
),
inv AS (
  SELECT i.id,
         COALESCE(it.a, 0) AS items_a,
         COALESCE(h.b, 0)  AS hist_b,
         COALESCE(j.c, 0)  AS je_c
  FROM invoices i
  LEFT JOIN items it ON it.invoice_id = i.id
  LEFT JOIN hist  h  ON h.invoice_id = i.id
  LEFT JOIN jec   j  ON j.invoice_id = i.id
  WHERE i.status NOT IN ('cancelled', 'draft')
    AND i.invoice_date BETWEEN (SELECT s FROM bounds) AND (SELECT e FROM bounds)
),
-- Same tolerance as get_cogs_audit's keeper detection
cls AS (
  SELECT inv.*,
    ( ABS(je_c - items_a) <= 1.00
      OR (items_a > 0 AND ABS(je_c - items_a) <= items_a * 0.01 + 10)
      OR (items_a = 0 AND je_c = 0) ) AS je_ok,
    ( ABS(hist_b - items_a) <= 1.00
      OR (items_a > 0 AND ABS(hist_b - items_a) <= items_a * 0.01 + 10)
      OR (items_a = 0 AND hist_b = 0) ) AS hist_ok
  FROM inv
),
parts AS (
  SELECT
    (SELECT COALESCE(SUM(net), 0) FROM gl) AS journal_cogs,
    (SELECT COALESCE(SUM(hist_b), 0) FROM cls) AS history_total,
    (SELECT COALESCE(SUM(net), 0) FROM gl WHERE family = 'returns') AS returns_credit,
    (SELECT COALESCE(SUM(net), 0) FROM gl WHERE family = 'cancelled') AS cancelled_net,
    COALESCE(SUM((je_c - hist_b)) FILTER (WHERE je_ok AND NOT hist_ok), 0) AS stale_history,
    COUNT(*) FILTER (WHERE je_ok AND NOT hist_ok) AS stale_history_count,
    COALESCE(SUM((je_c - hist_b)) FILTER (WHERE NOT je_ok AND hist_ok), 0) AS journal_wrong,
    COUNT(*) FILTER (WHERE NOT je_ok AND hist_ok) AS journal_wrong_count,
    COALESCE(SUM((je_c - hist_b)) FILTER (WHERE NOT je_ok AND NOT hist_ok), 0) AS both_off,
    COUNT(*) FILTER (WHERE NOT je_ok AND NOT hist_ok) AS both_off_count
  FROM cls
)
SELECT
  ROUND(journal_cogs, 2),
  ROUND(history_total, 2),
  ROUND(journal_cogs - history_total, 2),
  ROUND(returns_credit, 2),
  ROUND(cancelled_net, 2),
  ROUND(stale_history, 2),
  stale_history_count,
  ROUND(journal_wrong, 2),
  journal_wrong_count,
  ROUND(both_off, 2),
  both_off_count,
  ROUND((journal_cogs - history_total) - returns_credit - cancelled_net
        - stale_history - journal_wrong - both_off, 2)
FROM parts
$function$;

COMMIT;
