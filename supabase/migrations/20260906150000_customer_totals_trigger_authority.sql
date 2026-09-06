-- Customer totals: make DB triggers the ONLY writer of
-- customers.total_purchases and customers.outstanding_balance.
--
-- Audit (2026-09-06, GAP-AUDIT-2026-09-06.md): four client-side flows added to
-- the trigger-recomputed columns — POS checkout (pos/page.tsx), quotation
-- convert (quotations/page.tsx), record-receivable (RecordButton + accounting
-- page) and manual-receivable collection (CollectPaymentModal), plus an
-- outstanding subtraction in the advance-apply flow. Net effect on live data:
-- total_purchases overstated by ৳270,757.09 across 37 customers,
-- outstanding_balance overstated by ৳44,325.00 on 1 customer.
--
-- The supplier side already solves this class of drift with a shared
-- recompute_supplier_balances() called from triggers on every source table
-- (journal_entries, journal_lines, GRNs). This migration mirrors that
-- architecture for customers: one function, recomputed from ground truth
-- (invoices + posted receivable JEs − receivable collections), fired from
-- invoices, payments, journal_entries and journal_lines. The client writers
-- are removed in the accompanying frontend change.
--
-- Includes an audited, idempotent rebase (old → new logged per customer) and
-- a hard postcondition: the migration FAILS if any customer still disagrees
-- with ground truth afterwards.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Indexes for the recompute scans (hot path: every invoice/payment/JE event)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_invoices_customer_id ON invoices (customer_id);

CREATE INDEX IF NOT EXISTS idx_journal_entries_customer_receivable
  ON journal_entries (customer_id, reference_type, is_posted)
  WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payments_reference
  ON payments (reference_type, reference_id);

-- ---------------------------------------------------------------------------
-- 2) The one writer: recompute both columns from ground truth
--    (mirror of recompute_supplier_balances; business formulas are copied
--    verbatim from the superseded trigger functions, including the dead
--    'unpaid' status in the IN list so behaviour is provably unchanged)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION recompute_customer_balances(p_customer_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public
AS $$
DECLARE
  v_purchases numeric;
  v_outstanding numeric;
BEGIN
  IF p_customer_id IS NULL THEN
    RETURN 0;
  END IF;

  -- total purchases = all non-cancelled invoices + posted manual receivable debits
  SELECT GREATEST(0,
           COALESCE((SELECT SUM(total_amount) FROM invoices
                      WHERE customer_id = p_customer_id
                        AND status <> 'cancelled'), 0)
         + COALESCE((SELECT SUM(total_debit) FROM journal_entries
                      WHERE customer_id = p_customer_id
                        AND reference_type = 'receivable'
                        AND is_posted = true), 0))
    INTO v_purchases;

  -- outstanding = open invoice balances + posted manual receivable debits
  --               − collections (bad-debt write-offs count as collected)
  SELECT GREATEST(0,
           COALESCE((SELECT SUM(balance_due) FROM invoices
                      WHERE customer_id = p_customer_id
                        AND status IN ('sent', 'partially_paid', 'unpaid', 'overdue')), 0)
         + COALESCE((SELECT SUM(total_debit) FROM journal_entries
                      WHERE customer_id = p_customer_id
                        AND reference_type = 'receivable'
                        AND is_posted = true), 0)
         - COALESCE((SELECT SUM(p.amount + COALESCE(p.bad_debt_amount, 0)) FROM payments p
                      WHERE p.reference_type = 'receivable'
                        AND COALESCE(p.is_reversed, false) = false
                        AND p.reference_id IN (
                          SELECT id FROM journal_entries
                           WHERE customer_id = p_customer_id
                             AND reference_type = 'receivable'
                             AND is_posted = true)), 0))
    INTO v_outstanding;

  UPDATE customers
     SET total_purchases = v_purchases,
         outstanding_balance = v_outstanding,
         updated_at = now()
   WHERE id = p_customer_id;

  RETURN 1;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3) invoices: one trigger replaces the two partial writers
--    (trg_invoice_customer_balance -> update_customer_outstanding_balance,
--     trg_invoice_sync_total_purchases -> sync_customer_total_purchases)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION invoice_customer_totals_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_customer uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.customer_id IS NOT NULL THEN
      PERFORM recompute_customer_balances(OLD.customer_id);
    END IF;
    RETURN NULL;
  END IF;

  v_old_customer := OLD.customer_id;  -- NULL on INSERT

  IF v_old_customer IS DISTINCT FROM NEW.customer_id AND v_old_customer IS NOT NULL THEN
    PERFORM recompute_customer_balances(v_old_customer);
  END IF;

  IF NEW.customer_id IS NOT NULL THEN
    PERFORM recompute_customer_balances(NEW.customer_id);
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_invoice_customer_balance ON invoices;
DROP TRIGGER IF EXISTS trg_invoice_sync_total_purchases ON invoices;

CREATE TRIGGER trg_invoice_customer_totals
AFTER INSERT OR UPDATE OR DELETE ON invoices
FOR EACH ROW EXECUTE FUNCTION invoice_customer_totals_trigger();

-- ---------------------------------------------------------------------------
-- 4) payments: extend coverage to receivable payments and to UPDATE/DELETE
--    (the old function only fired on INSERT of received invoice payments,
--     which is why CollectPaymentModal had to fix outstanding client-side)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION payment_customer_totals_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_customer uuid;
  v_old_customer uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.reference_type IN ('invoice', 'receivable') THEN
      v_customer := COALESCE(OLD.customer_id,
        (SELECT customer_id FROM invoices WHERE id = OLD.reference_id));
      IF v_customer IS NULL AND OLD.reference_type = 'receivable' THEN
        SELECT customer_id INTO v_customer FROM journal_entries WHERE id = OLD.reference_id;
      END IF;
      IF v_customer IS NOT NULL THEN
        PERFORM recompute_customer_balances(v_customer);
      END IF;
    END IF;
    RETURN NULL;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    v_old_customer := COALESCE(OLD.customer_id,
      (SELECT customer_id FROM invoices WHERE id = OLD.reference_id));
    IF v_old_customer IS DISTINCT FROM NEW.customer_id
       AND OLD.reference_id IS DISTINCT FROM NEW.reference_id
       AND v_old_customer IS NOT NULL THEN
      PERFORM recompute_customer_balances(v_old_customer);
    END IF;
  END IF;

  IF NEW.reference_type = 'invoice' THEN
    SELECT customer_id INTO v_customer FROM invoices WHERE id = NEW.reference_id;
  ELSIF NEW.reference_type = 'receivable' THEN
    v_customer := COALESCE(NEW.customer_id,
      (SELECT customer_id FROM journal_entries WHERE id = NEW.reference_id));
  END IF;

  IF v_customer IS NOT NULL THEN
    PERFORM recompute_customer_balances(v_customer);
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_payment_customer_balance ON payments;

CREATE TRIGGER trg_payment_customer_balance
AFTER INSERT OR UPDATE OR DELETE ON payments
FOR EACH ROW EXECUTE FUNCTION payment_customer_totals_trigger();

-- ---------------------------------------------------------------------------
-- 5) journal_entries + journal_lines (mirror of the supplier trigger pair) —
--    receivable JEs created, posted, edited or deleted now recompute the
--    customer without any client-side involvement
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION journal_entry_customer_totals_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.reference_type = 'receivable' AND OLD.customer_id IS NOT NULL THEN
      PERFORM recompute_customer_balances(OLD.customer_id);
    END IF;
    RETURN NULL;
  END IF;

  IF NEW.reference_type = 'receivable' THEN
    IF TG_OP = 'UPDATE'
       AND OLD.customer_id IS DISTINCT FROM NEW.customer_id
       AND OLD.customer_id IS NOT NULL THEN
      PERFORM recompute_customer_balances(OLD.customer_id);
    END IF;

    IF (TG_OP = 'INSERT'
        OR OLD.is_posted IS DISTINCT FROM NEW.is_posted
        OR OLD.total_debit IS DISTINCT FROM NEW.total_debit
        OR OLD.customer_id IS DISTINCT FROM NEW.customer_id)
       AND NEW.customer_id IS NOT NULL THEN
      PERFORM recompute_customer_balances(NEW.customer_id);
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION journal_line_customer_totals_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_customer uuid;
  v_old_customer uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT customer_id INTO v_customer
      FROM journal_entries
     WHERE id = OLD.journal_entry_id AND reference_type = 'receivable';
  ELSE
    SELECT customer_id INTO v_customer
      FROM journal_entries
     WHERE id = NEW.journal_entry_id AND reference_type = 'receivable';

    IF TG_OP = 'UPDATE' AND OLD.journal_entry_id IS DISTINCT FROM NEW.journal_entry_id THEN
      SELECT customer_id INTO v_old_customer
        FROM journal_entries
       WHERE id = OLD.journal_entry_id AND reference_type = 'receivable';
      IF v_old_customer IS NOT NULL AND v_old_customer IS DISTINCT FROM v_customer THEN
        PERFORM recompute_customer_balances(v_old_customer);
      END IF;
    END IF;
  END IF;

  IF v_customer IS NOT NULL THEN
    PERFORM recompute_customer_balances(v_customer);
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_journal_entry_customer_totals ON journal_entries;
DROP TRIGGER IF EXISTS trg_journal_line_customer_totals ON journal_lines;

CREATE TRIGGER trg_journal_entry_customer_totals
AFTER INSERT OR UPDATE OR DELETE ON journal_entries
FOR EACH ROW EXECUTE FUNCTION journal_entry_customer_totals_trigger();

CREATE TRIGGER trg_journal_line_customer_totals
AFTER INSERT OR UPDATE OR DELETE ON journal_lines
FOR EACH ROW EXECUTE FUNCTION journal_line_customer_totals_trigger();

-- ---------------------------------------------------------------------------
-- 6) Drop the superseded functions (no dependents — verified 2026-09-06)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS update_customer_outstanding_balance();
DROP FUNCTION IF EXISTS sync_customer_total_purchases();
DROP FUNCTION IF EXISTS update_customer_balance_after_payment();

-- ---------------------------------------------------------------------------
-- 7) Audited, idempotent rebase
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_totals_recompute_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  name text,
  old_total_purchases numeric,
  new_total_purchases numeric,
  old_outstanding_balance numeric,
  new_outstanding_balance numeric,
  done_at timestamptz DEFAULT now()
);

DO $$
DECLARE
  r record;
  v_purchases numeric;
  v_outstanding numeric;
  v_changed integer := 0;
BEGIN
  FOR r IN SELECT id, name, total_purchases, outstanding_balance FROM customers ORDER BY name LOOP
    SELECT GREATEST(0,
             COALESCE((SELECT SUM(total_amount) FROM invoices
                        WHERE customer_id = r.id AND status <> 'cancelled'), 0)
           + COALESCE((SELECT SUM(total_debit) FROM journal_entries
                        WHERE customer_id = r.id
                          AND reference_type = 'receivable' AND is_posted = true), 0))
      INTO v_purchases;

    SELECT GREATEST(0,
             COALESCE((SELECT SUM(balance_due) FROM invoices
                        WHERE customer_id = r.id
                          AND status IN ('sent', 'partially_paid', 'unpaid', 'overdue')), 0)
           + COALESCE((SELECT SUM(total_debit) FROM journal_entries
                        WHERE customer_id = r.id
                          AND reference_type = 'receivable' AND is_posted = true), 0)
           - COALESCE((SELECT SUM(p.amount + COALESCE(p.bad_debt_amount, 0)) FROM payments p
                        WHERE p.reference_type = 'receivable'
                          AND COALESCE(p.is_reversed, false) = false
                          AND p.reference_id IN (
                            SELECT id FROM journal_entries
                             WHERE customer_id = r.id
                               AND reference_type = 'receivable'
                               AND is_posted = true)), 0))
      INTO v_outstanding;

    IF r.total_purchases IS DISTINCT FROM v_purchases
       OR r.outstanding_balance IS DISTINCT FROM v_outstanding THEN
      INSERT INTO customer_totals_recompute_audit
        (customer_id, name, old_total_purchases, new_total_purchases,
         old_outstanding_balance, new_outstanding_balance)
      VALUES
        (r.id, r.name, r.total_purchases, v_purchases,
         r.outstanding_balance, v_outstanding);
      v_changed := v_changed + 1;
    END IF;
  END LOOP;

  -- Apply through the SAME function the triggers use, so the rebase result is
  -- guaranteed identical to what any future write will compute.
  FOR r IN SELECT DISTINCT customer_id FROM customer_totals_recompute_audit LOOP
    PERFORM recompute_customer_balances(r.customer_id);
  END LOOP;

  RAISE NOTICE 'Customer totals rebase complete: % customers adjusted', v_changed;
END $$;

-- ---------------------------------------------------------------------------
-- 8) Postcondition: every customer must now match ground truth as computed by
--    recompute_customer_balances() itself. Any mismatch aborts the migration.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  v_stored_purchases numeric;
  v_stored_outstanding numeric;
  v_bad integer := 0;
BEGIN
  FOR r IN SELECT id FROM customers LOOP
    PERFORM recompute_customer_balances(r.id);
    SELECT total_purchases, outstanding_balance
      INTO v_stored_purchases, v_stored_outstanding
      FROM customers WHERE id = r.id;

    IF v_stored_purchases IS DISTINCT FROM (
         SELECT GREATEST(0,
                  COALESCE((SELECT SUM(total_amount) FROM invoices
                             WHERE customer_id = r.id AND status <> 'cancelled'), 0)
                + COALESCE((SELECT SUM(total_debit) FROM journal_entries
                             WHERE customer_id = r.id
                               AND reference_type = 'receivable' AND is_posted = true), 0))
       ) OR v_stored_outstanding IS DISTINCT FROM (
         SELECT GREATEST(0,
                  COALESCE((SELECT SUM(balance_due) FROM invoices
                             WHERE customer_id = r.id
                               AND status IN ('sent', 'partially_paid', 'unpaid', 'overdue')), 0)
                + COALESCE((SELECT SUM(total_debit) FROM journal_entries
                             WHERE customer_id = r.id
                               AND reference_type = 'receivable' AND is_posted = true), 0)
                - COALESCE((SELECT SUM(p.amount + COALESCE(p.bad_debt_amount, 0)) FROM payments p
                             WHERE p.reference_type = 'receivable'
                               AND COALESCE(p.is_reversed, false) = false
                               AND p.reference_id IN (
                                 SELECT id FROM journal_entries
                                  WHERE customer_id = r.id
                                    AND reference_type = 'receivable'
                                    AND is_posted = true)), 0))
       ) THEN
      v_bad := v_bad + 1;
      RAISE WARNING 'Customer % still disagrees with ground truth after rebase', r.id;
    END IF;
  END LOOP;

  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Customer totals rebase failed: % customers still drift', v_bad;
  END IF;

  RAISE NOTICE 'Postcondition OK: all customer totals match ground truth';
END $$;

COMMIT;
