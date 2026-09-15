-- Customer statement v2: plain-language, net-per-document statement.
--
-- v1 rendered SUM(debit) and SUM(credit) per document as separate Charge and
-- Credit columns. For an edited invoice that printed the GROSS amounts
-- (original + repost debits vs reversal credits) — e.g. INV-940617 showed
-- Charge ৳269,392 / Credit ৳208,705 when the customer's actual bill is the
-- net ৳60,687 — and cancelled invoices appeared as equal charge+credit
-- pairs (e.g. ৳6.88L + ৳6.88L netting to zero). ~37% of all AR journal
-- entries are invoice_edit/invoice_cancel churn, so on churn-heavy
-- customers nearly every line carried two misleading numbers.
--
-- v2 nets every document to a SINGLE amount (bill column when positive,
-- paid column when negative — verified: an edited invoice's net always
-- equals its current total_amount exactly), drops zero-net documents
-- (counted in zero_net_excluded instead of printed), and returns
-- plain-language labels. The arithmetic invariant is unchanged:
--   opening_balance + total_bills − total_paid == closing_balance
--     == AR ledger (1100+1300) balance at p_to, always.
--
-- Output shape changed (single consumer: components/CustomerStatementModal):
--   total_charges/total_credits → total_bills/total_paid (net, real money),
--   rows[].charge/credit/doc_type → rows[].bill/paid/label/kind,
--   + rows[].revised, top-level zero_net_excluded / revised_count.
--
-- p_from/p_to NULL = unbounded on that side (All Time).

CREATE OR REPLACE FUNCTION get_customer_period_statement(p_customer_id uuid, p_from date, p_to date)
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH ar_lines AS (
    SELECT je.entry_number, je.entry_date, je.reference_type AS rt,
           je.reference_id AS rid, je.description AS descr,
           jl.debit, jl.credit
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.journal_entry_id
      JOIN accounts a ON a.id = jl.account_id AND a.code IN ('1100', '1300')
     WHERE je.is_posted = TRUE
       AND (je.customer_id = p_customer_id
            OR (je.customer_id IS NULL
                AND je.reference_type IN ('invoice', 'invoice_cancel')
                AND EXISTS (SELECT 1 FROM invoices i
                             WHERE i.id = je.reference_id
                               AND i.customer_id = p_customer_id)))
  ),
  opening AS (
    SELECT COALESCE(SUM(debit - credit), 0) AS bal
      FROM ar_lines
     WHERE p_from IS NOT NULL AND entry_date < p_from
  ),
  activity AS (
    SELECT
      CASE WHEN rt IN ('invoice', 'invoice_edit', 'invoice_cancel') THEN 'invoice' ELSE rt END AS kind,
      rid,
      SUM(debit - credit) AS net_amount,
      MIN(entry_date) AS first_date
    FROM ar_lines
    WHERE (p_from IS NULL OR entry_date >= p_from)
      AND (p_to IS NULL OR entry_date <= p_to)
    GROUP BY 1, 2
  ),
  doc_rows AS (
    SELECT a.kind, a.rid, a.net_amount,
           COALESCE(
             CASE WHEN a.kind = 'invoice'    THEN i.invoice_date
                  WHEN a.kind = 'payment'    THEN p.payment_date
                  WHEN a.kind = 'sales_return' THEN sr.return_date
                  WHEN a.kind = 'receivable' THEN je2.entry_date
                  WHEN a.kind IN ('advance', 'advance_refund') THEN ca.created_at::date
                  WHEN a.kind = 'store_credit_cash_out' THEN csc.created_at::date
                  ELSE a.first_date END,
             a.first_date) AS sort_date,
           CASE
             WHEN a.kind = 'invoice'    THEN i.invoice_number
             WHEN a.kind = 'payment'    THEN p.payment_number
             WHEN a.kind = 'sales_return' THEN sr.return_number
             WHEN a.kind IN ('advance', 'advance_refund') THEN ca.advance_number
             WHEN a.kind = 'store_credit_cash_out' THEN csc.credit_number
           END AS doc_number,
           CASE
             WHEN a.kind = 'invoice' AND i.status = 'cancelled' THEN 'Invoice (cancelled)'
             WHEN a.kind = 'invoice'    THEN 'Invoice'
             WHEN a.kind = 'payment' AND p.payment_type = 'refund' THEN 'Refund'
             WHEN a.kind = 'payment'    THEN 'Payment'
             WHEN a.kind = 'sales_return' THEN 'Sales return'
             WHEN a.kind = 'receivable' THEN 'Previous due'
             WHEN a.kind = 'advance'    THEN 'Advance applied'
             WHEN a.kind = 'advance_refund' THEN 'Advance refunded'
             WHEN a.kind = 'store_credit_cash_out' THEN 'Store credit cash-out'
             WHEN a.kind = 'opening_balance' THEN 'Opening balance'
             ELSE 'Adjustment'
           END AS label,
           CASE
             WHEN a.kind = 'invoice' THEN NULLIF(i.reference, '')
             WHEN a.kind = 'payment' THEN p.notes
             WHEN a.kind = 'sales_return' THEN sr.notes
             WHEN a.kind = 'receivable' THEN je2.description
           END AS details,
           CASE WHEN a.kind = 'payment' THEN p.payment_method END AS method,
           CASE WHEN a.kind = 'payment' THEN p.reference_number END AS reference_number,
           CASE WHEN a.kind = 'invoice' AND i.status <> 'cancelled'
                 AND EXISTS (SELECT 1 FROM journal_entries je3
                              WHERE je3.reference_type = 'invoice_edit'
                                AND je3.reference_id = a.rid
                                AND je3.is_posted = TRUE)
                THEN TRUE ELSE FALSE END AS revised
      FROM activity a
      LEFT JOIN invoices i   ON a.kind = 'invoice' AND i.id = a.rid
      LEFT JOIN payments p   ON a.kind = 'payment' AND p.id = a.rid
      LEFT JOIN sales_returns sr ON a.kind = 'sales_return' AND sr.id = a.rid
      LEFT JOIN journal_entries je2 ON a.kind = 'receivable' AND je2.id = a.rid
      LEFT JOIN customer_advances ca ON a.kind IN ('advance', 'advance_refund') AND ca.id = a.rid
      LEFT JOIN customer_store_credits csc ON a.kind = 'store_credit_cash_out' AND csc.id = a.rid
  ),
  kept AS (
    SELECT * FROM doc_rows WHERE net_amount <> 0
  ),
  ordered AS (
    SELECT d.*,
           (SELECT bal FROM opening)
         + SUM(d.net_amount) OVER (ORDER BY d.sort_date, d.doc_number NULLS LAST, d.kind, d.rid
                                          ROWS UNBOUNDED PRECEDING) AS balance
      FROM kept d
  )
  SELECT json_build_object(
    'opening_balance', (SELECT bal FROM opening),
    'closing_balance', (SELECT bal FROM opening) + COALESCE((SELECT SUM(net_amount) FROM kept), 0),
    'total_bills',     COALESCE((SELECT SUM(net_amount) FROM kept WHERE net_amount > 0), 0),
    'total_paid',      COALESCE((SELECT -SUM(net_amount) FROM kept WHERE net_amount < 0), 0),
    'store_credit_balance', (SELECT COALESCE(SUM(balance), 0) FROM customer_store_credits
                              WHERE customer_id = p_customer_id AND status = 'active'),
    'advance_balance', (SELECT COALESCE(SUM(balance), 0) FROM customer_advances
                         WHERE customer_id = p_customer_id AND status = 'active'),
    'zero_net_excluded', (SELECT count(*) FROM doc_rows WHERE net_amount = 0),
    'revised_count', (SELECT count(*) FROM kept WHERE revised),
    'rows', COALESCE((SELECT json_agg(json_build_object(
               'date', to_char(sort_date, 'YYYY-MM-DD'),
               'kind', kind,
               'doc_number', doc_number,
               'label', label,
               'details', details,
               'method', method,
               'reference_number', reference_number,
               'bill', CASE WHEN net_amount > 0 THEN net_amount ELSE 0 END,
               'paid', CASE WHEN net_amount < 0 THEN -net_amount ELSE 0 END,
               'balance', balance,
               'revised', revised
             ) ORDER BY sort_date, doc_number NULLS LAST, kind, rid) FROM ordered), '[]'::json)
  );
$$;

GRANT EXECUTE ON FUNCTION get_customer_period_statement(uuid, date, date) TO authenticated;
