-- Batch 6 of the 2026-09-06 gap audit (P1-5): GL-based AR aging with an
-- as-of date, and an as-of parameter for the AP aging.
--
-- get_receivables_aging(p_as_of): mirrors get_payables_aging — FIFO-allocates
-- settlement credits (payments, returns, bad debt) over receivable debits on
-- accounts 1100 (invoice AR) + 1300 (manual receivables), attributed by
-- customer_id on the journal entries. Buckets are computed against p_as_of so
-- the report can be back-dated.
--
-- get_payables_aging(p_as_of): same function, now parameterized. The default
-- keeps existing callers (dashboard) working unchanged.

CREATE OR REPLACE FUNCTION public.get_receivables_aging(p_as_of date DEFAULT CURRENT_DATE)
RETURNS TABLE(customer_id uuid, customer_name text, total_due numeric, bucket_current numeric, bucket_1_30 numeric, bucket_31_60 numeric, bucket_61_90 numeric, bucket_90_plus numeric, oldest_open_date date)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = 'public'
AS $function$
  WITH attributed AS (
    SELECT je.customer_id AS cid, je.entry_date AS ed, jl.debit, jl.credit
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.journal_entry_id
      JOIN accounts a ON a.id = jl.account_id AND a.code IN ('1100', '1300')
     WHERE je.is_posted = TRUE
       AND je.customer_id IS NOT NULL
       AND je.entry_date <= p_as_of
  ),
  debits AS (
    SELECT cid, ed, d,
           COALESCE(SUM(d) OVER (PARTITION BY cid ORDER BY ed
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS cum_prev
      FROM (SELECT cid, ed, SUM(debit) AS d FROM attributed GROUP BY cid, ed) x
     WHERE d > 0
  ),
  reductions AS (
    SELECT cid, SUM(credit) AS c FROM attributed GROUP BY cid
  ),
  open_docs AS (
    SELECT dr.cid, dr.ed,
           GREATEST(0, dr.cum_prev + dr.d - r.c) - GREATEST(0, dr.cum_prev - r.c) AS open_amt
      FROM debits dr
      JOIN reductions r ON r.cid = dr.cid
  )
  SELECT c.id,
         c.name,
         COALESCE(SUM(o.open_amt), 0),
         COALESCE(SUM(o.open_amt) FILTER (WHERE p_as_of - o.ed <= 0), 0),
         COALESCE(SUM(o.open_amt) FILTER (WHERE p_as_of - o.ed > 0 AND p_as_of - o.ed <= 30), 0),
         COALESCE(SUM(o.open_amt) FILTER (WHERE p_as_of - o.ed > 30 AND p_as_of - o.ed <= 60), 0),
         COALESCE(SUM(o.open_amt) FILTER (WHERE p_as_of - o.ed > 60 AND p_as_of - o.ed <= 90), 0),
         COALESCE(SUM(o.open_amt) FILTER (WHERE p_as_of - o.ed > 90), 0),
         MIN(o.ed) FILTER (WHERE o.open_amt > 0.005)
    FROM customers c
    LEFT JOIN open_docs o ON o.cid = c.id
   GROUP BY c.id, c.name
  HAVING COALESCE(SUM(o.open_amt), 0) > 0.005
   ORDER BY 3 DESC;
$function$;

DROP FUNCTION IF EXISTS public.get_payables_aging();

CREATE OR REPLACE FUNCTION public.get_payables_aging(p_as_of date DEFAULT CURRENT_DATE)
RETURNS TABLE(supplier_id uuid, supplier_name text, total_due numeric, bucket_current numeric, bucket_31_60 numeric, bucket_61_90 numeric, bucket_90_plus numeric, oldest_open_date date)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = 'public'
AS $function$
  WITH attributed AS (
    SELECT je.supplier_id AS sid, je.entry_date AS ed, jl.credit, jl.debit
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN accounts a ON a.id = jl.account_id AND a.code = '2000'
    WHERE je.is_posted = TRUE AND je.supplier_id IS NOT NULL
      AND je.entry_date <= p_as_of
    UNION ALL
    SELECT g.supplier_id, je.entry_date, jl.credit, jl.debit
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN accounts a ON a.id = jl.account_id AND a.code = '2000'
    JOIN goods_receipt_notes g ON g.id = je.reference_id
    WHERE je.is_posted = TRUE AND je.reference_type = 'grn' AND je.supplier_id IS NULL
      AND je.entry_date <= p_as_of
  ),
  credits AS (
    SELECT sid, ed, c,
           COALESCE(SUM(c) OVER (PARTITION BY sid ORDER BY ed
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS cum_prev
    FROM (SELECT sid, ed, SUM(credit) AS c FROM attributed GROUP BY sid, ed) x
    WHERE c > 0
  ),
  reductions AS (
    SELECT sid, SUM(debit) AS p FROM attributed GROUP BY sid
  ),
  open_docs AS (
    SELECT cr.sid, cr.ed,
           GREATEST(0, cr.cum_prev + cr.c - r.p) - GREATEST(0, cr.cum_prev - r.p) AS open_amt
    FROM credits cr
    JOIN reductions r ON r.sid = cr.sid
  )
  SELECT s.id,
         s.name,
         COALESCE(SUM(o.open_amt), 0),
         COALESCE(SUM(o.open_amt) FILTER (WHERE p_as_of - o.ed <= 30), 0),
         COALESCE(SUM(o.open_amt) FILTER (WHERE p_as_of - o.ed > 30 AND p_as_of - o.ed <= 60), 0),
         COALESCE(SUM(o.open_amt) FILTER (WHERE p_as_of - o.ed > 60 AND p_as_of - o.ed <= 90), 0),
         COALESCE(SUM(o.open_amt) FILTER (WHERE p_as_of - o.ed > 90), 0),
         MIN(o.ed) FILTER (WHERE o.open_amt > 0.005)
  FROM suppliers s
  LEFT JOIN open_docs o ON o.sid = s.id
  GROUP BY s.id, s.name
  HAVING COALESCE(SUM(o.open_amt), 0) > 0.005
  ORDER BY 3 DESC;
$function$;

GRANT EXECUTE ON FUNCTION public.get_receivables_aging(date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_payables_aging(date) TO authenticated;
