-- Supplier balance recompute + repair (2026-09-04)
--
-- Problem: suppliers.outstanding_balance / total_purchases were only ever
-- written by scattered client-side read-modify-write code whose main path
-- (PO creation) only ran when a payment was made at order time. POs without
-- an upfront payment never incremented the balance and later payments
-- subtracted from 0 through a Math.max(0, ...) clamp, pinning every supplier
-- at ৳0 while real payables were ~৳686K. No DB trigger maintained the columns
-- (customers have one; suppliers did not).
--
-- Fix: the GL is the source of truth. The payable for a supplier is exactly
-- the net credit on account 2000 attributable to them:
--   * any posted JE that carries supplier_id (payment, payable,
--     purchase_return, purchase_cancellation, ...)
--   * GRN JEs (which do not carry supplier_id) attributed via the GRN row
-- total_purchases = GRN booked value (goods actually received, at cost).
--
-- A trigger on journal_lines (only for AP-account lines) recomputes the
-- affected supplier on every insert/update/delete, so the columns stay
-- correct no matter which flow posts the JE. Client-side writers are being
-- removed from the frontend in this same change set.
--
-- One-time repair: 3 test-era payments (৳1 + ৳2 + ৳5, 2026-07-26) existed as
-- payment rows without journal entries, so GL 2000 overstated payables by ৳8.
-- They are backfilled with proper JEs, then all balances are recomputed.

-- ---------------------------------------------------------------- audit log
CREATE TABLE IF NOT EXISTS supplier_balance_repair_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL,
  je_id uuid,
  entry_number text,
  description text,
  amount numeric,
  reason text,
  done_at timestamptz DEFAULT now()
);

-- ---------------------------------------------------------------- indexes
-- Attribution lookups in the recompute filter by these columns.
CREATE INDEX IF NOT EXISTS idx_journal_entries_supplier
  ON journal_entries (supplier_id) WHERE supplier_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_journal_lines_account
  ON journal_lines (account_id);

-- ---------------------------------------------------------------- functions
-- Which supplier a journal entry belongs to: explicit supplier_id wins;
-- GRN JEs (no supplier_id) are attributed through the GRN row.
CREATE OR REPLACE FUNCTION journal_entry_supplier(p_je_id uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(
    je.supplier_id,
    (SELECT g.supplier_id FROM goods_receipt_notes g
      WHERE g.id = je.reference_id AND je.reference_type = 'grn')
  )
  FROM journal_entries je
  WHERE je.id = p_je_id;
$$;

-- Recompute outstanding_balance and total_purchases from the GL.
-- With p_supplier_id: recompute just that supplier (trigger hot path).
-- Without: set-based recompute of every supplier.
CREATE OR REPLACE FUNCTION recompute_supplier_balances(p_supplier_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_ap uuid;
  v_outstanding numeric;
  v_purchases numeric;
BEGIN
  SELECT id INTO v_ap FROM accounts WHERE code = '2000' LIMIT 1;
  IF v_ap IS NULL THEN
    RAISE EXCEPTION 'Accounts Payable account (2000) not found';
  END IF;

  IF p_supplier_id IS NOT NULL THEN
    SELECT
      COALESCE(SUM(jl.credit - jl.debit), 0),
      COALESCE(SUM(jl.credit) FILTER (WHERE je.reference_type = 'grn'), 0)
    INTO v_outstanding, v_purchases
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    WHERE jl.account_id = v_ap
      AND je.is_posted = TRUE
      AND (je.supplier_id = p_supplier_id
           OR (je.reference_type = 'grn' AND EXISTS (
                SELECT 1 FROM goods_receipt_notes g
                WHERE g.id = je.reference_id
                  AND g.supplier_id = p_supplier_id)));

    UPDATE suppliers
    SET outstanding_balance = v_outstanding,
        total_purchases = v_purchases,
        updated_at = now()
    WHERE id = p_supplier_id;
    RETURN 1;
  END IF;

  WITH attributed AS (
    -- AP lines on JEs that carry the supplier directly
    SELECT je.supplier_id AS sid, je.reference_type, jl.credit, jl.debit
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    WHERE jl.account_id = v_ap
      AND je.is_posted = TRUE
      AND je.supplier_id IS NOT NULL
    UNION ALL
    -- AP lines on GRN JEs, attributed via the GRN row
    -- (supplier_id IS NOT NULL excluded above so no JE is counted twice)
    SELECT g.supplier_id, je.reference_type, jl.credit, jl.debit
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN goods_receipt_notes g ON g.id = je.reference_id
    WHERE jl.account_id = v_ap
      AND je.is_posted = TRUE
      AND je.reference_type = 'grn'
      AND je.supplier_id IS NULL
  ),
  per_supplier AS (
    SELECT sid,
           COALESCE(SUM(credit - debit), 0) AS outstanding,
           COALESCE(SUM(credit) FILTER (WHERE reference_type = 'grn'), 0) AS purchases
    FROM attributed
    GROUP BY sid
  )
  UPDATE suppliers s
  SET outstanding_balance = COALESCE(ps.outstanding, 0),
      total_purchases = COALESCE(ps.purchases, 0),
      updated_at = now()
  FROM per_supplier ps
  WHERE s.id = ps.sid;

  UPDATE suppliers s
  SET outstanding_balance = 0,
      total_purchases = 0,
      updated_at = now()
  WHERE NOT EXISTS (
    SELECT 1 FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    WHERE jl.account_id = v_ap
      AND je.is_posted = TRUE
      AND (je.supplier_id = s.id
           OR (je.reference_type = 'grn' AND EXISTS (
                SELECT 1 FROM goods_receipt_notes g
                WHERE g.id = je.reference_id AND g.supplier_id = s.id))));

  RETURN (SELECT count(*) FROM suppliers);
END;
$$;

-- ---------------------------------------------------------------- triggers
-- Only AP-account lines can change supplier balances, so the row-level
-- trigger filters on the account and skips everything else (sales, COGS,
-- inventory journals never pay this cost).
CREATE OR REPLACE FUNCTION supplier_balance_on_journal_line()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_ap uuid;
  v_supplier uuid;
BEGIN
  SELECT id INTO v_ap FROM accounts WHERE code = '2000' LIMIT 1;
  IF v_ap IS NULL THEN RETURN NULL; END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.account_id = v_ap THEN
      v_supplier := journal_entry_supplier(NEW.journal_entry_id);
      IF v_supplier IS NOT NULL THEN
        PERFORM recompute_supplier_balances(v_supplier);
      END IF;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.account_id = v_ap OR OLD.account_id = v_ap THEN
      v_supplier := journal_entry_supplier(NEW.journal_entry_id);
      IF v_supplier IS NOT NULL THEN
        PERFORM recompute_supplier_balances(v_supplier);
      END IF;
      IF OLD.journal_entry_id IS DISTINCT FROM NEW.journal_entry_id THEN
        v_supplier := journal_entry_supplier(OLD.journal_entry_id);
        IF v_supplier IS NOT NULL THEN
          PERFORM recompute_supplier_balances(v_supplier);
        END IF;
      END IF;
    END IF;
  ELSE -- DELETE
    IF OLD.account_id = v_ap THEN
      v_supplier := journal_entry_supplier(OLD.journal_entry_id);
      IF v_supplier IS NOT NULL THEN
        PERFORM recompute_supplier_balances(v_supplier);
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_journal_line_supplier_balance ON journal_lines;
CREATE TRIGGER trg_journal_line_supplier_balance
AFTER INSERT OR UPDATE OR DELETE ON journal_lines
FOR EACH ROW EXECUTE FUNCTION supplier_balance_on_journal_line();

-- Recompute when a JE's attribution itself changes (supplier_id edited,
-- re-pointed at another GRN, posted/unposted). Attribution must be derived
-- from the OLD/NEW records — the table already holds NEW by the time this runs.
CREATE OR REPLACE FUNCTION supplier_balance_on_journal_entry()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_old uuid;
  v_new uuid;
BEGIN
  v_old := COALESCE(OLD.supplier_id,
    (SELECT g.supplier_id FROM goods_receipt_notes g
      WHERE g.id = OLD.reference_id AND OLD.reference_type = 'grn'));
  IF TG_OP = 'DELETE' THEN
    IF v_old IS NOT NULL THEN
      PERFORM recompute_supplier_balances(v_old);
    END IF;
    RETURN NULL;
  END IF;
  v_new := COALESCE(NEW.supplier_id,
    (SELECT g.supplier_id FROM goods_receipt_notes g
      WHERE g.id = NEW.reference_id AND NEW.reference_type = 'grn'));
  IF v_old IS DISTINCT FROM v_new
     OR OLD.is_posted IS DISTINCT FROM NEW.is_posted THEN
    IF v_old IS NOT NULL THEN
      PERFORM recompute_supplier_balances(v_old);
    END IF;
    IF v_new IS NOT NULL AND v_new IS DISTINCT FROM v_old THEN
      PERFORM recompute_supplier_balances(v_new);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_journal_entry_supplier_balance ON journal_entries;
CREATE TRIGGER trg_journal_entry_supplier_balance
AFTER UPDATE OR DELETE ON journal_entries
FOR EACH ROW EXECUTE FUNCTION supplier_balance_on_journal_entry();

-- A GRN re-pointed at another supplier moves its whole booked value.
CREATE OR REPLACE FUNCTION supplier_balance_on_grn()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF OLD.supplier_id IS NOT NULL THEN
    PERFORM recompute_supplier_balances(OLD.supplier_id);
  END IF;
  IF NEW.supplier_id IS NOT NULL AND NEW.supplier_id IS DISTINCT FROM OLD.supplier_id THEN
    PERFORM recompute_supplier_balances(NEW.supplier_id);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_grn_supplier_balance ON goods_receipt_notes;
CREATE TRIGGER trg_grn_supplier_balance
AFTER UPDATE OF supplier_id ON goods_receipt_notes
FOR EACH ROW EXECUTE FUNCTION supplier_balance_on_grn();

-- ------------------------------------------------- one-time repair (৳8)
-- Payments that exist as rows but never got their journal entry, so GL 2000
-- (and the cash account) overstated the payable side. Backfill proper JEs.
DO $$
DECLARE
  v_ap uuid;
  v_cash uuid;
  v_num text;
  v_je uuid;
  r record;
BEGIN
  SELECT id INTO v_ap FROM accounts WHERE code = '2000' LIMIT 1;
  IF v_ap IS NULL THEN
    RAISE EXCEPTION 'Accounts Payable account (2000) not found';
  END IF;

  FOR r IN
    SELECT p.id, p.amount, p.payment_date, p.payment_number, p.supplier_id, p.payment_method
    FROM payments p
    WHERE p.payment_type = 'made'
      AND NOT EXISTS (
        SELECT 1 FROM journal_entries je
        WHERE je.reference_type = 'payment' AND je.reference_id = p.id)
  LOOP
    SELECT pm.account_id INTO v_cash
    FROM payment_methods pm
    WHERE pm.code = r.payment_method AND pm.is_active = TRUE
    LIMIT 1;
    IF v_cash IS NULL THEN
      SELECT id INTO v_cash FROM accounts WHERE code = '1001' LIMIT 1;
    END IF;
    IF v_cash IS NULL THEN
      RAISE EXCEPTION 'Cannot backfill payment %: no cash account', coalesce(r.payment_number, r.id::text);
    END IF;

    v_num := get_next_journal_number();
    IF v_num IS NULL THEN
      v_num := 'JE-BF-' || substr(r.id::text, 1, 8);
    END IF;

    INSERT INTO journal_entries
      (entry_number, entry_date, description, reference_type, reference_id,
       total_debit, total_credit, is_posted, supplier_id)
    VALUES
      (v_num, r.payment_date,
       'Payment Made - ' || coalesce(r.payment_number, r.id::text) || ' (backfill)',
       'payment', r.id, r.amount, r.amount, TRUE, r.supplier_id)
    RETURNING id INTO v_je;

    INSERT INTO journal_lines
      (journal_entry_id, account_id, description, debit, credit, sort_order)
    VALUES
      (v_je, v_ap,   'Accounts Payable', r.amount, 0, 0),
      (v_je, v_cash, 'Cash/Bank',        0, r.amount, 1);

    INSERT INTO supplier_balance_repair_audit (action, je_id, entry_number, description, amount, reason)
    VALUES ('backfill_payment_je', v_je, v_num,
            'Payment Made - ' || coalesce(r.payment_number, ''), r.amount,
            'payment row existed without a journal entry; GL 2000 and the cash account were overstated until now');
  END LOOP;
END $$;

-- True up account balances (the backfill moved 2000 and cash), then the
-- supplier columns themselves.
SELECT recompute_account_balances('supplier-balance-repair');
SELECT recompute_supplier_balances();

-- ------------------------------------------------- verification: tie-out
-- Every 2000 line must be attributable (verified 2026-09-04: zero unposted
-- 2000 lines, zero dangling GRN references), so the per-supplier sum must
-- equal the GL 2000 net credit exactly.
DO $$
DECLARE
  v_gl numeric;
  v_suppliers numeric;
  v_diff numeric;
BEGIN
  SELECT COALESCE(SUM(jl.credit - jl.debit), 0) INTO v_gl
  FROM journal_lines jl
  JOIN accounts a ON a.id = jl.account_id
  WHERE a.code = '2000';

  SELECT COALESCE(SUM(outstanding_balance), 0) INTO v_suppliers
  FROM suppliers;

  v_diff := v_gl - v_suppliers;
  RAISE NOTICE 'Tie-out: GL 2000 net = %, sum(suppliers.outstanding_balance) = %, diff = %',
    v_gl, v_suppliers, v_diff;
  IF abs(v_diff) > 0.01 THEN
    RAISE EXCEPTION 'Supplier balance tie-out failed: GL 2000 % vs suppliers % (diff %)',
      v_gl, v_suppliers, v_diff;
  END IF;
END $$;
