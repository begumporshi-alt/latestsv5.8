-- Customer period statement: a customer-facing statement of account for a
-- date range, printable from the customer profile ("Statement" modal).
--
-- Mirrors get_customer_ar_statement's attribution (accounts 1100 + 1300,
-- journal customer_id with the legacy NULL-invoice fallback) but instead of
-- one row per journal line, rows are aggregated PER BUSINESS DOCUMENT so the
-- printout shows documents a customer recognizes — Invoice POS-00589750,
-- Payment PAY-997229 · bank transfer — never JE numbers or edit/reversal
-- churn (an edited invoice's original + reversal + repost lines net to its
-- current total inside one row).
--
-- Opening balance = AR ledger balance before p_from, so
--   opening + Σ(charge − credit) == closing == AR ledger balance at p_to
-- always holds by construction. Store credit / advance balances ride along
-- as memo fields only — they are not part of the AR balance (the same
-- convention as the invoice view's Total Due).
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
      SUM(debit) AS charge,
      SUM(credit) AS credit,
      MIN(entry_date) AS first_date
    FROM ar_lines
    WHERE (p_from IS NULL OR entry_date >= p_from)
      AND (p_to IS NULL OR entry_date <= p_to)
      AND (debit <> 0 OR credit <> 0)
    GROUP BY 1, 2
  ),
  doc_rows AS (
    SELECT a.kind, a.rid, a.charge, a.credit,
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
             WHEN a.kind = 'receivable' THEN je2.entry_number
             WHEN a.kind IN ('advance', 'advance_refund') THEN ca.advance_number
             WHEN a.kind = 'store_credit_cash_out' THEN csc.credit_number
           END AS doc_number,
           CASE
             WHEN a.kind = 'invoice' AND i.status = 'cancelled' THEN 'Invoice (cancelled)'
             WHEN a.kind = 'invoice'    THEN 'Invoice'
             WHEN a.kind = 'payment' AND p.payment_type = 'refund' THEN 'Refund'
             WHEN a.kind = 'payment'    THEN 'Payment'
             WHEN a.kind = 'sales_return' THEN 'Sales Return'
             WHEN a.kind = 'receivable' THEN 'Manual Receivable'
             WHEN a.kind = 'advance'    THEN 'Advance'
             WHEN a.kind = 'advance_refund' THEN 'Advance Refund'
             WHEN a.kind = 'store_credit_cash_out' THEN 'Store Credit Cash-out'
             WHEN a.kind = 'opening_balance' THEN 'Opening Balance'
             ELSE 'Adjustment'
           END AS doc_type,
           CASE
             WHEN a.kind = 'invoice' THEN COALESCE(NULLIF(i.reference, ''), 'Invoice ' || i.invoice_number)
             WHEN a.kind = 'payment' THEN p.notes
             WHEN a.kind = 'sales_return' THEN sr.notes
             WHEN a.kind = 'receivable' THEN je2.description
           END AS description,
           CASE WHEN a.kind = 'payment' THEN p.payment_method END AS method,
           CASE WHEN a.kind = 'payment' THEN p.reference_number END AS reference_number
      FROM activity a
      LEFT JOIN invoices i   ON a.kind = 'invoice' AND i.id = a.rid
      LEFT JOIN payments p   ON a.kind = 'payment' AND p.id = a.rid
      LEFT JOIN sales_returns sr ON a.kind = 'sales_return' AND sr.id = a.rid
      LEFT JOIN journal_entries je2 ON a.kind = 'receivable' AND je2.id = a.rid
      LEFT JOIN customer_advances ca ON a.kind IN ('advance', 'advance_refund') AND ca.id = a.rid
      LEFT JOIN customer_store_credits csc ON a.kind = 'store_credit_cash_out' AND csc.id = a.rid
  ),
  ordered AS (
    SELECT d.*,
           (SELECT bal FROM opening)
         + SUM(d.charge - d.credit) OVER (ORDER BY d.sort_date, d.doc_number NULLS LAST, d.kind
                                          ROWS UNBOUNDED PRECEDING) AS balance
      FROM doc_rows d
  )
  SELECT json_build_object(
    'opening_balance', (SELECT bal FROM opening),
    'closing_balance', (SELECT bal FROM opening) + COALESCE((SELECT SUM(charge - credit) FROM doc_rows), 0),
    'total_charges',   COALESCE((SELECT SUM(charge) FROM doc_rows), 0),
    'total_credits',   COALESCE((SELECT SUM(credit) FROM doc_rows), 0),
    'store_credit_balance', (SELECT COALESCE(SUM(balance), 0) FROM customer_store_credits
                              WHERE customer_id = p_customer_id AND status = 'active'),
    'advance_balance', (SELECT COALESCE(SUM(balance), 0) FROM customer_advances
                         WHERE customer_id = p_customer_id AND status = 'active'),
    'rows', COALESCE((SELECT json_agg(json_build_object(
               'date', to_char(sort_date, 'YYYY-MM-DD'),
               'doc_type', doc_type,
               'doc_number', doc_number,
               'description', description,
               'method', method,
               'reference_number', reference_number,
               'charge', charge,
               'credit', credit,
               'balance', balance
             ) ORDER BY sort_date, doc_number NULLS LAST, kind) FROM ordered), '[]'::json)
  );
$$;

GRANT EXECUTE ON FUNCTION get_customer_period_statement(uuid, date, date) TO authenticated;
