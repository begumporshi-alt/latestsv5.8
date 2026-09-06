-- Customer AR statement: the printable per-customer statement RPC, mirroring
-- get_supplier_ap_statement (same output shape, debit-normal AR instead of
-- credit-normal AP, two AR accounts instead of one).
--
-- Sources AR movement for one customer from GL lines on accounts 1100
-- (Accounts Receivable) and 1300 (Manual Receivable), attributed by
-- journal_entries.customer_id — with a fallback for the 8 legacy repair
-- JEs that carry no customer_id but reference an invoice directly.
-- Running balance = SUM(debit - credit) — AR is debit-normal.

CREATE OR REPLACE FUNCTION get_customer_ar_statement(p_customer_id uuid)
RETURNS TABLE (
  entry_date date,
  entry_number text,
  doc_type text,
  description text,
  debit numeric,
  credit numeric,
  balance numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH attributed AS (
    SELECT je.id AS jid, je.entry_number AS en, je.entry_date AS ed,
           je.reference_type AS rt, je.description AS descr,
           jl.debit AS dr, jl.credit AS cr
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN accounts a ON a.id = jl.account_id AND a.code IN ('1100', '1300')
    WHERE je.is_posted = TRUE
      AND (je.customer_id = p_customer_id
           OR (je.customer_id IS NULL
               AND je.reference_type IN ('invoice', 'invoice_cancel')
               AND EXISTS (
                 SELECT 1 FROM invoices i
                  WHERE i.id = je.reference_id
                    AND i.customer_id = p_customer_id)))
  )
  SELECT ed,
         en,
         CASE rt
           WHEN 'invoice' THEN 'Invoice'
           WHEN 'invoice_cancel' THEN 'Invoice Cancellation'
           WHEN 'invoice_edit' THEN 'Invoice Edit'
           WHEN 'payment' THEN 'Payment'
           WHEN 'receivable' THEN 'Manual Receivable'
           WHEN 'sales_return' THEN 'Sales Return'
           WHEN 'advance' THEN 'Advance Applied'
           WHEN 'advance_refund' THEN 'Advance Refund'
           WHEN 'opening_balance' THEN 'Opening Balance'
           ELSE rt
         END,
         descr, dr, cr,
         SUM(dr - cr) OVER (ORDER BY ed, en, jid
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
  FROM attributed
  WHERE dr <> 0 OR cr <> 0
  ORDER BY ed, en, jid;
$$;

GRANT EXECUTE ON FUNCTION get_customer_ar_statement(uuid) TO authenticated;
