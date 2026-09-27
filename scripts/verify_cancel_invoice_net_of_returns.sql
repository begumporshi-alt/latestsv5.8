-- ============================================================================
-- Verify cancel_invoice's sales-return netting (read-only by default).
--
-- Usage:
--   psql "$NEXT_PUBLIC_SUPABASE_DB_URL" -f scripts/verify_cancel_invoice_net_of_returns.sql
--
-- Section 1 audits every live invoice that carries a sales return and prints
-- exactly what cancelling it WOULD do. Section 2 re-checks the invariants the
-- RPC must satisfy. Section 3 is an OPTIONAL dry run: it cancels one invoice
-- inside a transaction that is rolled back, so nothing is written.
-- ============================================================================

\pset pager off

\echo '=== 1. netting plan for live invoices that have sales returns ==='
WITH inv AS (
  SELECT i.id, i.invoice_number, i.status,
         COALESCE(i.total_amount, 0)     AS total,
         COALESCE(i.refunded_amount, 0)  AS refunded,
         (SELECT COALESCE(SUM(p.amount), 0) FROM payments p
           WHERE p.reference_type = 'invoice' AND p.reference_id = i.id AND p.is_reversed = false) AS collected,
         (SELECT COALESCE(SUM(r.returned_base), 0) FROM public.sales_return_base_units(i.id) r) AS returned_units,
         (SELECT COALESCE(SUM(li.base_quantity), 0) FROM invoice_items li
            JOIN products pr ON pr.id = li.product_id
           WHERE li.invoice_id = i.id AND pr.track_inventory) AS invoiced_units
    FROM invoices i
   WHERE EXISTS (SELECT 1 FROM sales_returns sr WHERE sr.invoice_id = i.id AND sr.status <> 'void')
)
SELECT invoice_number, status,
       total, collected, refunded,
       GREATEST(0, total - LEAST(collected, refunded)) AS ar_to_reverse,
       GREATEST(0, collected - refunded)               AS cash_to_refund,
       invoiced_units, returned_units,
       GREATEST(0, invoiced_units - returned_units)    AS units_to_restock
  FROM inv
 ORDER BY invoice_number;

\echo '=== 2. invariants ==='
\echo '--- 2a. data invariants the netting relies on (both must be 0) ---'
\echo '    returns_without_refund       : a return that refunded nothing would leave the'
\echo '                                   returned revenue unreversed for that invoice'
\echo '    refund_without_returns       : a refund with no return document to net against'
SELECT COUNT(*) FILTER (WHERE has_returns AND COALESCE(refunded_amount, 0) = 0)      AS returns_without_refund,
       COUNT(*) FILTER (WHERE NOT has_returns AND COALESCE(refunded_amount, 0) <> 0) AS refund_without_returns,
       COUNT(*) FILTER (WHERE NOT has_returns)                                       AS invoices_where_netting_is_inert
  FROM (
    SELECT i.id, i.refunded_amount,
           EXISTS (SELECT 1 FROM sales_returns sr WHERE sr.invoice_id = i.id AND sr.status <> 'void') AS has_returns
      FROM invoices i
     WHERE i.status NOT IN ('cancelled', 'draft')
  ) t;

\echo '--- 2b. cancelled invoices that carried returns (historical audit) ---'
\echo '    ar_credit_from_cancel  : AR credited by the cancellation journal'
\echo '    collections_reversed   : collections the cancellation reversed'
SELECT i.invoice_number,
       COALESCE((SELECT SUM(jl.credit) FROM journal_lines jl
                   JOIN journal_entries je ON je.id = jl.journal_entry_id
                   JOIN accounts a ON a.id = jl.account_id
                  WHERE je.reference_type = 'invoice_cancel' AND je.reference_id = i.id
                    AND a.code = '1100' AND je.description LIKE 'Reverse AR/Revenue%'), 0) AS ar_credit_from_cancel,
       COALESCE((SELECT SUM(p.amount) FROM payments p
                  WHERE p.reference_type = 'invoice' AND p.reference_id = i.id AND p.is_reversed = true), 0) AS collections_reversed
  FROM invoices i
 WHERE i.status = 'cancelled'
   AND EXISTS (SELECT 1 FROM sales_returns sr WHERE sr.invoice_id = i.id)
 ORDER BY i.invoice_number;

\echo '--- 2c. helper sanity: derived base units match base_quantity_returned where present ---'
SELECT COUNT(*) AS rows_checked,
       bool_and(derived = stored) AS all_match
  FROM (
    SELECT COALESCE(sri.base_quantity_returned, 0) AS stored,
           ROUND(COALESCE(sri.quantity_returned, 0)
                 * GREATEST(COALESCE(li.base_quantity / NULLIF(li.quantity, 0), li.unit_conversion_factor, 1), 0), 6) AS derived
      FROM sales_return_items sri
      JOIN sales_returns sr ON sr.id = sri.sales_return_id
      LEFT JOIN invoice_items li ON li.id = sri.invoice_item_id
     WHERE sri.base_quantity_returned IS NOT NULL
  ) t;

-- ============================================================================
-- 3. OPTIONAL dry run — uncomment to cancel one invoice inside a transaction
--    that is rolled back (nothing is written; production is left untouched).
-- ============================================================================
-- BEGIN;
-- SELECT public.cancel_invoice(
--   (SELECT id FROM invoices WHERE invoice_number = 'REPLACE-ME'),
--   'dry run', 'verify-script', true);
-- ROLLBACK;
