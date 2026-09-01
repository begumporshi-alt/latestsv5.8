-- 2026-09-01: Repair invoice state left stale by the old returns page (audit fix #5b).
--
-- The old sales-returns page updated invoices with an explicit balance_due value,
-- but balance_due is a GENERATED column — the update always errored and the error
-- was swallowed, so invoice.amount_paid and status were never reduced after
-- refunds. It also tried to insert refund payments with reference_type
-- 'sales_return', which the payments check constraint rejects — payment_id is
-- NULL on all 16 returns and no refund payment rows exist for them (their
-- journal entries DO exist and are correct).
--
-- This repair fixes the 6 returns on live (non-cancelled) invoices:
-- amount_paid = GREATEST(0, amount_paid - total refunds), status recomputed by
-- the same formula the old page intended and record_sales_return() now uses.
-- Refund payment rows are deliberately NOT backfilled: the customer-balance
-- payment trigger does not guard refund types and would double-adjust.
--
-- Audited, idempotent (only rows still stale are touched).

BEGIN;

CREATE TABLE IF NOT EXISTS sales_return_invoice_repair_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL,
  amount_paid_before numeric(15,2) NOT NULL,
  amount_paid_after numeric(15,2) NOT NULL,
  status_before text NOT NULL,
  status_after text NOT NULL,
  refund_total numeric(15,2) NOT NULL,
  repaired_at timestamptz NOT NULL DEFAULT now(),
  repaired_by text NOT NULL DEFAULT 'migration_20260901170000'
);

-- Bound to returns created before record_sales_return() went live
-- (2026-09-01): the staleness predicate cannot distinguish "never netted"
-- (old page) from "already netted" (new RPC), so later re-runs must never
-- consider RPC-processed returns.
WITH refund_totals AS (
  SELECT sr.invoice_id, SUM(sr.total_refund_amount) AS refund_total
  FROM sales_returns sr
  WHERE sr.status <> 'void'
    AND sr.created_at < timestamptz '2026-09-01 15:00:00+00'
  GROUP BY sr.invoice_id
),
targets AS (
  SELECT i.id,
         i.amount_paid,
         GREATEST(i.amount_paid - rt.refund_total, 0) AS new_paid,
         i.total_amount,
         i.status,
         rt.refund_total
  FROM invoices i
  JOIN refund_totals rt ON rt.invoice_id = i.id
  WHERE i.status <> 'cancelled'
    AND i.amount_paid <> GREATEST(i.amount_paid - rt.refund_total, 0)
)
INSERT INTO sales_return_invoice_repair_audit
  (invoice_id, amount_paid_before, amount_paid_after, status_before, status_after, refund_total)
SELECT t.id, t.amount_paid, t.new_paid, t.status,
  CASE
    WHEN t.refund_total >= t.total_amount THEN 'refunded'
    WHEN t.total_amount - t.new_paid <= 0 THEN 'paid'
    WHEN t.new_paid > 0 THEN 'partially_paid'
    ELSE 'sent'
  END,
  t.refund_total
FROM targets t
WHERE NOT EXISTS (SELECT 1 FROM sales_return_invoice_repair_audit a WHERE a.invoice_id = t.id);

-- Apply exactly the audited corrections (audit rows are inserted above, in the
-- same transaction, so the UPDATE is driven by them — idempotent by design).
UPDATE invoices i
SET amount_paid = a.amount_paid_after,
    status = a.status_after,
    updated_at = now()
FROM sales_return_invoice_repair_audit a
WHERE a.invoice_id = i.id
  AND a.repaired_by = 'migration_20260901170000'
  AND (i.amount_paid <> a.amount_paid_after OR i.status <> a.status_after);

-- Post-condition: every audited invoice now carries its recorded post-repair
-- amount_paid (and re-running finds no un-audited stale invoice).
DO $$
DECLARE
  v_mismatch int;
  v_newly_stale int;
BEGIN
  SELECT COUNT(*) INTO v_mismatch
  FROM sales_return_invoice_repair_audit a
  JOIN invoices i ON i.id = a.invoice_id
  WHERE i.amount_paid <> a.amount_paid_after;

  SELECT COUNT(*) INTO v_newly_stale
  FROM invoices i
  JOIN (SELECT invoice_id, SUM(total_refund_amount) rt FROM sales_returns
        WHERE status <> 'void' AND created_at < timestamptz '2026-09-01 15:00:00+00' GROUP BY 1) r
    ON r.invoice_id = i.id
  WHERE i.status <> 'cancelled'
    AND NOT EXISTS (SELECT 1 FROM sales_return_invoice_repair_audit a WHERE a.invoice_id = i.id);

  IF v_mismatch <> 0 THEN
    RAISE EXCEPTION 'Post-condition failed: % repaired invoice(s) drifted from their audit record.', v_mismatch;
  END IF;
  RAISE NOTICE 'Invoice state repair complete: % invoice(s) corrected, % newly stale.', (SELECT COUNT(*) FROM sales_return_invoice_repair_audit), v_newly_stale;
END $$;

COMMIT;
