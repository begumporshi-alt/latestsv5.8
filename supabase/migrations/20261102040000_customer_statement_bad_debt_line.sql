-- ============================================================================
-- Customer statement: show bad-debt write-offs as their own credit line
-- ----------------------------------------------------------------------------
-- Problem
-- -------
-- `payment_accounting_trigger()` posts a write-off as a SEPARATE journal entry
-- (Dr 5600 Bad Debt Expense / Cr 1100 AR) carrying
-- `reference_type = 'payment'` and `reference_id = payments.id`. The statement
-- keyed every AR line by the payment document and derived its label from the
-- payment, so the cash leg and the write-off leg collapsed into ONE row
-- labelled "Payment" whose `paid` was cash + written-off amount.
--
-- Live impact at the time of this migration: 24 statement rows across 25
-- customers printed ৳6,693.69 of write-offs as money received; 6 of those rows
-- were pure write-offs with zero cash (৳4,787.32). A customer who never paid
-- received a statement showing a payment in their name.
--
-- A second, rarer case: the 2026-09-06 repair entry (JE-965212) is
-- `reference_type = 'invoice'` with no customer_id, so its ৳7.60 AR credit was
-- netted into POS-00589983's Bill column — the printed bill (৳6,650.00) did not
-- match the invoice face value (৳6,657.60).
--
-- Fix
-- ---
-- 1. Classify a journal entry as a write-off by the presence of a 5600 DEBIT
--    line on the same entry — structural, not description-string matching.
--    Verified live: 25 entries carry such a line and every one is a write-off
--    (24 on payments, 1 on an invoice); no invoice/payment/return entry does.
-- 2. Write-offs become their own document row (`kind = 'bad_debt'`, keyed by
--    journal entry id) so they never merge into the payment or the invoice.
-- 3. Rows gain `written_off`; `paid` and `total_paid` now contain CASH only.
--    `total_written_off` is reported separately.
--
-- Balance invariant is unchanged and must stay so:
--   opening_balance + total_bills - total_paid - total_written_off
--     == closing_balance == AR ledger (1100+1300) balance at p_to
-- The write-off row still carries its net_amount into `kept`, so the running
-- balance and the closing balance are bit-for-bit what they were before.
--
-- Output shape (single consumer: components/CustomerStatementModal):
--   rows[].written_off    NEW  — credit amount written off (negative if a
--                                write-off was reversed), 0 on all other rows
--   total_written_off     NEW  — sum of the above
--   total_paid                 — no longer includes write-offs
--   everything else            — unchanged
-- ============================================================================

CREATE OR REPLACE FUNCTION get_customer_period_statement(p_customer_id uuid, p_from date, p_to date)
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH ar_lines AS (
    SELECT je.id AS je_id, je.entry_number, je.entry_date,
           je.reference_type AS rt, je.reference_id AS ref_id,
           COALESCE(pay.collection_id, je.reference_id) AS rid,
           -- A write-off is any posted entry that expenses to 5600. This is the
           -- same test the AR aging report uses conceptually, and it is immune
           -- to the description text drifting.
           EXISTS (
             SELECT 1
               FROM journal_lines x
               JOIN accounts ax ON ax.id = x.account_id
              WHERE x.journal_entry_id = je.id
                AND ax.code = '5600'
                AND x.debit > 0
           ) AS is_bad_debt,
           jl.debit, jl.credit
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.journal_entry_id
      JOIN accounts a ON a.id = jl.account_id AND a.code IN ('1100', '1300')
      LEFT JOIN payments pay ON je.reference_type = 'payment' AND pay.id = je.reference_id
     WHERE je.is_posted = TRUE
       AND (je.customer_id = p_customer_id
            OR (je.customer_id IS NULL
                AND je.reference_type IN ('invoice', 'invoice_cancel')
                AND EXISTS (SELECT 1 FROM invoices i
                             WHERE i.id = je.reference_id
                               AND i.customer_id = p_customer_id)))
  ),
  pay_agg AS (
    SELECT coalesce(pay.collection_id, pay.id) AS gid,
           count(*) AS payment_count,
           bool_or(pay.payment_type = 'refund') AS is_refund,
           min(pay.payment_number) AS payment_number,
           min(pay.payment_date) AS payment_date,
           min(pay.payment_method) AS payment_method,
           min(pay.reference_number) AS reference_number,
           min(pay.notes) AS notes,
           string_agg(DISTINCT i.invoice_number, ', ' ORDER BY i.invoice_number) AS invoice_numbers
      FROM payments pay
      LEFT JOIN invoices i ON pay.reference_type = 'invoice' AND i.id = pay.reference_id
     WHERE pay.customer_id = p_customer_id
     GROUP BY 1
  ),
  opening AS (
    SELECT COALESCE(SUM(debit - credit), 0) AS bal
      FROM ar_lines
     WHERE p_from IS NOT NULL AND entry_date < p_from
  ),
  activity AS (
    SELECT
      CASE WHEN is_bad_debt THEN 'bad_debt'
           WHEN rt IN ('invoice', 'invoice_edit', 'invoice_cancel') THEN 'invoice'
           ELSE rt END AS kind,
      -- A write-off is its own document, keyed by the entry itself, so it can
      -- never be folded into the payment or invoice it references.
      CASE WHEN is_bad_debt THEN je_id ELSE rid END AS rid,
      MIN(rt)              FILTER (WHERE is_bad_debt) AS bd_rt,
      (MIN(ref_id::text)   FILTER (WHERE is_bad_debt))::uuid AS bd_ref,
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
                  WHEN a.kind = 'bad_debt'   THEN bd_je.entry_date
                  ELSE a.first_date END,
             a.first_date) AS sort_date,
           CASE
             WHEN a.kind = 'invoice'    THEN i.invoice_number
             WHEN a.kind = 'payment' AND p.payment_count > 1 THEN NULL
             WHEN a.kind = 'payment'    THEN p.payment_number
             WHEN a.kind = 'sales_return' THEN sr.return_number
             WHEN a.kind IN ('advance', 'advance_refund') THEN ca.advance_number
             WHEN a.kind = 'store_credit_cash_out' THEN csc.credit_number
             WHEN a.kind = 'bad_debt'   THEN COALESCE(bd_pay.payment_number,
                                                      bd_inv.invoice_number,
                                                      bd_je.entry_number)
           END AS doc_number,
           CASE
             WHEN a.kind = 'invoice' AND i.status = 'cancelled' THEN 'Invoice (cancelled)'
             WHEN a.kind = 'invoice'    THEN 'Invoice'
             WHEN a.kind = 'payment' AND p.payment_count > 1
                                        THEN 'Payment (' || p.payment_count || ' invoices)'
             WHEN a.kind = 'payment' AND p.is_refund THEN 'Refund'
             WHEN a.kind = 'payment'    THEN 'Payment'
             WHEN a.kind = 'sales_return' THEN 'Sales return'
             WHEN a.kind = 'receivable' THEN 'Previous due'
             WHEN a.kind = 'advance'    THEN 'Advance applied'
             WHEN a.kind = 'advance_refund' THEN 'Advance refunded'
             WHEN a.kind = 'store_credit_cash_out' THEN 'Store credit cash-out'
             WHEN a.kind = 'opening_balance' THEN 'Opening balance'
             WHEN a.kind = 'bad_debt'   THEN 'Bad debt written off'
             ELSE 'Adjustment'
           END AS label,
           CASE
             WHEN a.kind = 'invoice' THEN NULLIF(i.reference, '')
             WHEN a.kind = 'payment' AND p.payment_count > 1
                                     THEN concat_ws(' · ', 'Against ' || p.invoice_numbers, p.notes)
             WHEN a.kind = 'payment' THEN p.notes
             WHEN a.kind = 'sales_return' THEN sr.notes
             WHEN a.kind = 'receivable' THEN je2.description
             -- Name the invoice the write-off was applied to.
             WHEN a.kind = 'bad_debt' THEN bd_pay_inv.invoice_number
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
      LEFT JOIN pay_agg p    ON a.kind = 'payment' AND p.gid = a.rid
      LEFT JOIN sales_returns sr ON a.kind = 'sales_return' AND sr.id = a.rid
      LEFT JOIN journal_entries je2 ON a.kind = 'receivable' AND je2.id = a.rid
      LEFT JOIN customer_advances ca ON a.kind IN ('advance', 'advance_refund') AND ca.id = a.rid
      LEFT JOIN customer_store_credits csc ON a.kind = 'store_credit_cash_out' AND csc.id = a.rid
      LEFT JOIN journal_entries bd_je ON a.kind = 'bad_debt' AND bd_je.id = a.rid
      LEFT JOIN payments bd_pay
             ON a.kind = 'bad_debt' AND a.bd_rt = 'payment' AND bd_pay.id = a.bd_ref
      LEFT JOIN invoices bd_inv
             ON a.kind = 'bad_debt' AND a.bd_rt = 'invoice' AND bd_inv.id = a.bd_ref
      LEFT JOIN invoices bd_pay_inv
             ON a.kind = 'bad_debt' AND bd_pay.reference_type = 'invoice'
            AND bd_pay_inv.id = bd_pay.reference_id
  ),
  kept AS (
    SELECT * FROM doc_rows WHERE net_amount <> 0
  ),
  ordered AS (
    SELECT d.*,
           (SELECT bal FROM opening)
         + SUM(d.net_amount) OVER (ORDER BY d.sort_date,
                                            d.doc_number NULLS LAST,
                                            -- keep existing order for every
                                            -- other kind; a write-off sorts
                                            -- immediately after its payment
                                            CASE WHEN d.kind = 'bad_debt' THEN 'payment0'
                                                 ELSE d.kind END,
                                            d.rid
                                   ROWS UNBOUNDED PRECEDING) AS balance
      FROM kept d
  )
  SELECT json_build_object(
    'opening_balance', (SELECT bal FROM opening),
    'closing_balance', (SELECT bal FROM opening) + COALESCE((SELECT SUM(net_amount) FROM kept), 0),
    'total_bills',     COALESCE((SELECT SUM(net_amount) FROM kept
                                  WHERE kind <> 'bad_debt' AND net_amount > 0), 0),
    'total_paid',      COALESCE((SELECT -SUM(net_amount) FROM kept
                                  WHERE kind <> 'bad_debt' AND net_amount < 0), 0),
    'total_written_off', COALESCE((SELECT -SUM(net_amount) FROM kept
                                    WHERE kind = 'bad_debt'), 0),
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
               'bill', CASE WHEN kind <> 'bad_debt' AND net_amount > 0
                            THEN net_amount ELSE 0 END,
               'paid', CASE WHEN kind <> 'bad_debt' AND net_amount < 0
                            THEN -net_amount ELSE 0 END,
               'written_off', CASE WHEN kind = 'bad_debt' THEN -net_amount ELSE 0 END,
               'balance', balance,
               'revised', revised
             ) ORDER BY sort_date, doc_number NULLS LAST,
                        CASE WHEN kind = 'bad_debt' THEN 'payment0' ELSE kind END,
                        rid) FROM ordered), '[]'::json)
  );
$$;

GRANT EXECUTE ON FUNCTION get_customer_period_statement(uuid, date, date) TO authenticated;

-- Verification after applying:
--   1. Write-offs are their own rows and never inflate the Paid column:
--        SELECT (s->>'label') AS label, (s->>'paid')::numeric AS paid,
--               (s->>'written_off')::numeric AS written_off
--          FROM (SELECT get_customer_period_statement(c.id, NULL, NULL)::jsonb j
--                  FROM customers c WHERE c.id = '<customer>') g,
--               jsonb_array_elements(g.j->'rows') s
--         WHERE (s->>'kind') IN ('payment','bad_debt');
--   2. Per row, paid + written_off + bill must reconstruct the balance delta.
--   3. closing_balance must still equal the GL balance of 1100+1300 for the
--      customer — the write-off row carries the same net_amount as before.
