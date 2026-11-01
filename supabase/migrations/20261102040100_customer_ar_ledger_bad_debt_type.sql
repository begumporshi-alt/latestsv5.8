-- ============================================================================
-- Customer AR ledger: label bad-debt write-offs as such
-- ----------------------------------------------------------------------------
-- `get_customer_ar_statement` derives its Type column from
-- `journal_entries.reference_type`. Write-offs are posted with
-- `reference_type = 'payment'` (see payment_accounting_trigger), so the ledger
-- printed them as type "Payment" — only the description text revealed the
-- truth. Same structural test as the period statement: an entry that debits
-- 5600 Bad Debt Expense is a write-off.
--
-- The running balance is untouched; only the Type label changes.
-- ============================================================================

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
           EXISTS (
             SELECT 1
               FROM journal_lines x
               JOIN accounts ax ON ax.id = x.account_id
              WHERE x.journal_entry_id = je.id
                AND ax.code = '5600'
                AND x.debit > 0
           ) AS is_bad_debt,
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
         CASE WHEN is_bad_debt THEN 'Bad Debt Write-off'
              ELSE CASE rt
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
                   END
         END,
         descr, dr, cr,
         SUM(dr - cr) OVER (ORDER BY ed, en, jid
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
  FROM attributed
  WHERE dr <> 0 OR cr <> 0
  ORDER BY ed, en, jid;
$$;

GRANT EXECUTE ON FUNCTION get_customer_ar_statement(uuid) TO authenticated;

-- Verification:
--   SELECT doc_type, count(*) FROM get_customer_ar_statement('<customer>')
--    GROUP BY 1;   -- write-offs appear as 'Bad Debt Write-off', not 'Payment'
