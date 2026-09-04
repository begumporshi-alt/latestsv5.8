-- Supplier gap fixes (2026-09-04): payables aging, AP statements,
-- supplier master-data audit trail, and schema aligned with the real
-- GRN/return status flow.
--
-- Aging model: every credit on account 2000 (GRN bookings, manual payables,
-- AP reinstatements) is a document that increases what we owe; every debit
-- (payments, purchase returns, PO cancellations) reduces it. Reductions are
-- applied to documents oldest-first — the standard aging convention — so
-- each bucket shows the part of the remaining balance that has been open
-- for that long. Suppliers in a net-advance position (overpaid) drop out.

-- ------------------------------------------------------------- aging RPC
CREATE OR REPLACE FUNCTION get_payables_aging()
RETURNS TABLE (
  supplier_id uuid,
  supplier_name text,
  total_due numeric,
  bucket_current numeric,
  bucket_31_60 numeric,
  bucket_61_90 numeric,
  bucket_90_plus numeric,
  oldest_open_date date
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH attributed AS (
    SELECT je.supplier_id AS sid, je.entry_date AS ed, jl.credit, jl.debit
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN accounts a ON a.id = jl.account_id AND a.code = '2000'
    WHERE je.is_posted = TRUE AND je.supplier_id IS NOT NULL
    UNION ALL
    SELECT g.supplier_id, je.entry_date, jl.credit, jl.debit
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN accounts a ON a.id = jl.account_id AND a.code = '2000'
    JOIN goods_receipt_notes g ON g.id = je.reference_id
    WHERE je.is_posted = TRUE AND je.reference_type = 'grn' AND je.supplier_id IS NULL
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
         COALESCE(SUM(o.open_amt) FILTER (WHERE CURRENT_DATE - o.ed <= 30), 0),
         COALESCE(SUM(o.open_amt) FILTER (WHERE CURRENT_DATE - o.ed > 30 AND CURRENT_DATE - o.ed <= 60), 0),
         COALESCE(SUM(o.open_amt) FILTER (WHERE CURRENT_DATE - o.ed > 60 AND CURRENT_DATE - o.ed <= 90), 0),
         COALESCE(SUM(o.open_amt) FILTER (WHERE CURRENT_DATE - o.ed > 90), 0),
         MIN(o.ed) FILTER (WHERE o.open_amt > 0.005)
  FROM suppliers s
  LEFT JOIN open_docs o ON o.sid = s.id
  GROUP BY s.id, s.name
  HAVING COALESCE(SUM(o.open_amt), 0) > 0.005
  ORDER BY 3 DESC;
$$;

-- ------------------------------------------------------- AP statement RPC
-- Chronological AP ledger for one supplier with a running balance —
-- backs the printable statement on the supplier profile.
CREATE OR REPLACE FUNCTION get_supplier_ap_statement(p_supplier_id uuid)
RETURNS TABLE (
  entry_date date,
  entry_number text,
  doc_type text,
  description text,
  debit numeric,
  credit numeric,
  balance numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH attributed AS (
    SELECT je.id AS jid, je.entry_number AS en, je.entry_date AS ed,
           je.reference_type AS rt, je.description AS descr,
           jl.debit AS dr, jl.credit AS cr
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN accounts a ON a.id = jl.account_id AND a.code = '2000'
    WHERE je.is_posted = TRUE AND je.supplier_id = p_supplier_id
    UNION ALL
    SELECT je.id, je.entry_number, je.entry_date, je.reference_type, je.description,
           jl.debit, jl.credit
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN accounts a ON a.id = jl.account_id AND a.code = '2000'
    JOIN goods_receipt_notes g ON g.id = je.reference_id
    WHERE je.is_posted = TRUE AND je.reference_type = 'grn' AND je.supplier_id IS NULL
      AND g.supplier_id = p_supplier_id
  )
  SELECT ed, en,
         CASE rt
           WHEN 'grn' THEN 'Goods Received'
           WHEN 'payable' THEN 'Payable'
           WHEN 'payment' THEN 'Payment'
           WHEN 'purchase_return' THEN 'Purchase Return'
           WHEN 'purchase_cancellation' THEN 'PO Cancellation'
           ELSE rt
         END,
         descr, dr, cr,
         SUM(cr - dr) OVER (ORDER BY ed, en, jid
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
  FROM attributed
  WHERE dr <> 0 OR cr <> 0
  ORDER BY ed, en, jid;
$$;

-- ------------------------------------------------ supplier audit trail
-- Master-data changes (name, credit terms, contact...) are now logged.
-- outstanding_balance / total_purchases are EXCLUDED: they are derived,
-- trigger-maintained values that change on every AP journal line — logging
-- them would flood the trail.
CREATE TABLE IF NOT EXISTS supplier_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid NOT NULL,
  action text NOT NULL,
  changed_fields jsonb NOT NULL,
  done_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_supplier_audit_log_supplier
  ON supplier_audit_log (supplier_id, done_at DESC);

CREATE OR REPLACE FUNCTION log_supplier_changes()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_diff jsonb := '{}';
  k text;
  v_excluded text[] := ARRAY['updated_at', 'outstanding_balance', 'total_purchases'];
BEGIN
  IF TG_OP = 'UPDATE' THEN
    FOR k IN SELECT jsonb_object_keys(to_jsonb(NEW)) LOOP
      CONTINUE WHEN k = ANY(v_excluded);
      IF to_jsonb(OLD) -> k IS DISTINCT FROM to_jsonb(NEW) -> k THEN
        v_diff := v_diff || jsonb_build_object(k,
          jsonb_build_object('old', to_jsonb(OLD) -> k, 'new', to_jsonb(NEW) -> k));
      END IF;
    END LOOP;
    IF v_diff <> '{}' THEN
      INSERT INTO supplier_audit_log (supplier_id, action, changed_fields)
      VALUES (NEW.id, 'update', v_diff);
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    INSERT INTO supplier_audit_log (supplier_id, action, changed_fields)
    VALUES (NEW.id, 'insert', to_jsonb(NEW) - 'updated_at' - 'outstanding_balance' - 'total_purchases');
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_supplier_audit ON suppliers;
CREATE TRIGGER trg_supplier_audit
AFTER INSERT OR UPDATE ON suppliers
FOR EACH ROW EXECUTE FUNCTION log_supplier_changes();

-- -------------------------------------- schema aligned with the real flow
-- The atomic receive_grn RPC inserts GRNs directly as 'posted'
-- (20260901150000) and purchase returns are created 'completed'; the
-- intermediate states promised by the old CHECK constraints are unreachable
-- and no rows use them (verified: 54/54 posted, 2/2 completed). Narrow the
-- constraints so the schema stops promising states nothing can set.
ALTER TABLE goods_receipt_notes DROP CONSTRAINT goods_receipt_notes_status_check;
ALTER TABLE goods_receipt_notes
  ADD CONSTRAINT goods_receipt_notes_status_check CHECK (status = 'posted');

ALTER TABLE purchase_returns DROP CONSTRAINT purchase_returns_status_check;
ALTER TABLE purchase_returns
  ADD CONSTRAINT purchase_returns_status_check CHECK (status = 'completed');

-- ------------------------------------------------------------ verification
DO $$
DECLARE
  v_aging_total numeric;
  v_positive_balances numeric;
  v_statement_end numeric;
BEGIN
  SELECT COALESCE(SUM(total_due), 0) INTO v_aging_total FROM get_payables_aging();
  SELECT COALESCE(SUM(outstanding_balance) FILTER (WHERE outstanding_balance > 0), 0)
  INTO v_positive_balances FROM suppliers;

  IF abs(v_aging_total - v_positive_balances) > 0.01 THEN
    RAISE EXCEPTION 'Aging tie-out failed: aging % vs positive supplier balances %',
      v_aging_total, v_positive_balances;
  END IF;
  RAISE NOTICE 'Aging tie-out OK: % = %', v_aging_total, v_positive_balances;

  SELECT balance INTO v_statement_end
  FROM get_supplier_ap_statement(
    (SELECT id FROM suppliers WHERE name = 'stella /jakir'))
  ORDER BY entry_date DESC, entry_number DESC LIMIT 1;
  IF abs(v_statement_end - 116810.40) > 0.01 THEN
    RAISE EXCEPTION 'Statement tie-out failed for stella: % vs 116810.40', v_statement_end;
  END IF;
  RAISE NOTICE 'Statement tie-out OK (stella ends at %)', v_statement_end;
END $$;
