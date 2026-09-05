-- Journal system hardening (2026-09-06 audit, Phase 2).
--
--   1. payment_accounting_trigger gains an idempotency guard: it posted a JE
--      on every payments INSERT with no existing-JE check (the double-payment
--      era and the supplier JE backfill both came from this gap).
--   2. get_next_journal_number takes an advisory lock — MAX+1 with no lock
--      lets two concurrent posts compute the same number. The lock covers
--      same-transaction callers (post_journal_entry, every trigger); client
--      code that inserts separately is backstopped by (3).
--   3. entry_number gets the unique index it never had (7 entries shared
--      JE-000001 before the 20260906100000 repair; duplicates are now
--      impossible and a racing insert fails loudly instead of silently).
--   4. journal_entries edit/delete audit-log trigger — every UPDATE of the
--      meaningful columns and every DELETE writes an activity_logs row
--      (entity_type 'journal_entry'), which is exactly what the account
--      statement's Audit Trail tab already queries but nothing produced.
--      Totals-only updates (post_journal_entry finishing an entry) are
--      deliberately not in the column list to avoid noise on every auto-post.
--      created_by stays NULL by design: its FK targets profiles(id), an
--      empty table — writing auth.uid() would abort every post (the same
--      trap the payments.created_by fix removed in 20260903100200). The
--      actor is captured in the audit metadata instead.
--   5. RLS: journal tables drop their anon policies — the app is an
--      authenticated ERP; anon never legitimately touches the GL.
--   6. get_related_accounts: the account statement has called this RPC since
--      it was written, but no migration ever defined it — the page always
--      silently fell back to its manual query.

BEGIN;

-- ── 1. Payment trigger idempotency ──
CREATE OR REPLACE FUNCTION public.payment_accounting_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_ar_account uuid;
  v_ap_account uuid;
  v_cash_account uuid;
  v_payment_account uuid;
  v_bad_debt_account uuid;
  v_invoice_record RECORD;
  v_po_record RECORD;
  v_amount numeric;
  v_bad_debt numeric;
BEGIN
  v_amount := COALESCE(NEW.amount, 0);
  v_bad_debt := COALESCE(NEW.bad_debt_amount, 0);

  IF v_amount <= 0 AND v_bad_debt <= 0 THEN
    RETURN NEW;
  END IF;

  -- Idempotency: if any JE already exists for this payment row (backfill,
  -- re-import, re-fire), never post a second one.
  IF EXISTS (SELECT 1 FROM journal_entries je
              WHERE je.reference_type = 'payment' AND je.reference_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  -- ============================================================
  -- Case 1: Customer payment for an invoice
  -- ============================================================
  IF NEW.payment_type = 'received' AND NEW.reference_type = 'invoice' THEN
    SELECT id INTO v_ar_account FROM accounts WHERE code = '1100' LIMIT 1;
    IF v_ar_account IS NULL THEN
      RETURN NEW;
    END IF;

    SELECT id INTO v_bad_debt_account FROM accounts WHERE code = '5600' LIMIT 1;

    SELECT pm.account_id INTO v_payment_account
      FROM payment_methods pm
     WHERE pm.code = NEW.payment_method AND pm.is_active = true
     LIMIT 1;

    IF v_payment_account IS NULL THEN
      SELECT id INTO v_cash_account FROM accounts WHERE code = '1001' LIMIT 1;
    ELSE
      v_cash_account := v_payment_account;
    END IF;

    SELECT * INTO v_invoice_record FROM invoices WHERE id = NEW.reference_id;

    -- Post payment: Debit Cash/Bank, Credit AR
    IF v_amount > 0 THEN
      IF v_cash_account IS NULL THEN
        RETURN NEW;
      END IF;

      PERFORM post_journal_entry(
        'Payment Received - ' || COALESCE(NEW.payment_number, 'invoice payment'),
        COALESCE(NEW.payment_date, CURRENT_DATE),
        'payment',
        NEW.id,
        json_build_array(
          json_build_object('account_id', v_cash_account, 'debit', v_amount, 'credit', 0, 'description', 'Cash received for ' || COALESCE(v_invoice_record.invoice_number, 'invoice')),
          json_build_object('account_id', v_ar_account, 'debit', 0, 'credit', v_amount, 'description', 'AR cleared for ' || COALESCE(v_invoice_record.invoice_number, 'invoice'))
        )::json,
        v_invoice_record.customer_id
      );
    END IF;

    -- Post bad debt: Debit Bad Debt Expense, Credit AR
    IF v_bad_debt > 0 AND v_bad_debt_account IS NOT NULL THEN
      PERFORM post_journal_entry(
        'Bad Debt Write-off - ' || COALESCE(NEW.payment_number, 'invoice payment'),
        COALESCE(NEW.payment_date, CURRENT_DATE),
        'payment',
        NEW.id,
        json_build_array(
          json_build_object('account_id', v_bad_debt_account, 'debit', v_bad_debt, 'credit', 0, 'description', 'Bad debt write-off for ' || COALESCE(v_invoice_record.invoice_number, 'invoice')),
          json_build_object('account_id', v_ar_account, 'debit', 0, 'credit', v_bad_debt, 'description', 'AR cleared (bad debt) for ' || COALESCE(v_invoice_record.invoice_number, 'invoice'))
        )::json,
        v_invoice_record.customer_id
      );
    END IF;

    RETURN NEW;
  END IF;

  -- ============================================================
  -- Case 2: Payment to supplier for a purchase order
  -- ============================================================
  IF NEW.payment_type = 'made' AND NEW.reference_type = 'purchase_order' THEN
    SELECT id INTO v_ap_account FROM accounts WHERE code = '2000' LIMIT 1;
    IF v_ap_account IS NULL THEN
      RETURN NEW;
    END IF;

    SELECT pm.account_id INTO v_payment_account
      FROM payment_methods pm
     WHERE pm.code = NEW.payment_method AND pm.is_active = true
     LIMIT 1;

    IF v_payment_account IS NULL THEN
      SELECT id INTO v_cash_account FROM accounts WHERE code = '1001' LIMIT 1;
    ELSE
      v_cash_account := v_payment_account;
    END IF;

    IF v_cash_account IS NULL THEN
      RETURN NEW;
    END IF;

    SELECT * INTO v_po_record FROM purchase_orders WHERE id = NEW.reference_id;

    -- Post payment: Debit AP, Credit Cash/Bank
    PERFORM post_journal_entry(
      'Payment Made - ' || COALESCE(NEW.payment_number, 'PO payment'),
      COALESCE(NEW.payment_date, CURRENT_DATE),
      'payment',
      NEW.id,
      json_build_array(
        json_build_object('account_id', v_ap_account, 'debit', v_amount, 'credit', 0, 'description', 'AP paid for ' || COALESCE(v_po_record.po_number, 'PO')),
        json_build_object('account_id', v_cash_account, 'debit', 0, 'credit', v_amount, 'description', 'Cash paid for ' || COALESCE(v_po_record.po_number, 'PO'))
      )::json,
      NULL,
      NEW.supplier_id
    );

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$function$;

-- ── 2. Serialize journal number generation ──
CREATE OR REPLACE FUNCTION public.get_next_journal_number()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_num text;
  v_count integer;
BEGIN
  -- Serialize MAX+1 within the calling transaction (post_journal_entry and
  -- every trigger). Client code that calls this RPC and inserts separately
  -- is protected by the unique index below instead.
  PERFORM pg_advisory_xact_lock(hashtext('journal_entry_number')::bigint);

  SELECT COALESCE(MAX(CAST(
    NULLIF(regexp_replace(entry_number, '[^0-9]', '', 'g'), '')
    AS integer
  )), 0) + 1
  INTO v_count
  FROM journal_entries
  WHERE entry_number LIKE 'JE-%';

  v_num := 'JE-' || LPAD(v_count::text, 6, '0');
  RETURN v_num;
END;
$function$;

-- ── 3. entry_number uniqueness ──
-- Duplicates were cleaned by 20260906100000 (7 entries shared JE-000001).
CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_entry_number_key
  ON public.journal_entries (entry_number);

-- ── 4. Audit-log trigger on journal entry edits and deletes ──
CREATE OR REPLACE FUNCTION public.journal_entry_audit_log()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = 'public'
AS $function$
BEGIN
  INSERT INTO activity_logs (action, entity_type, entity_id, entity_label, metadata)
  VALUES (
    'journal_entry_' || lower(TG_OP),
    'journal_entry',
    CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END,
    CASE WHEN TG_OP = 'DELETE' THEN OLD.entry_number ELSE NEW.entry_number END,
    jsonb_build_object(
      'old', CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) END,
      'new', CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(NEW) END,
      'reference_type', CASE WHEN TG_OP = 'DELETE' THEN OLD.reference_type ELSE NEW.reference_type END,
      'auth_uid', auth.uid()::text
    )
  );
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

DROP TRIGGER IF EXISTS trg_journal_entry_audit ON journal_entries;
CREATE TRIGGER trg_journal_entry_audit
AFTER DELETE OR UPDATE OF description, entry_date, reference_type, reference_id, customer_id, supplier_id, is_posted
ON public.journal_entries
FOR EACH ROW EXECUTE FUNCTION journal_entry_audit_log();

-- ── 5. RLS: authenticated only ──
DROP POLICY IF EXISTS je_delete ON journal_entries;
DROP POLICY IF EXISTS je_insert ON journal_entries;
DROP POLICY IF EXISTS je_select ON journal_entries;
DROP POLICY IF EXISTS je_update ON journal_entries;
CREATE POLICY je_select ON journal_entries FOR SELECT TO authenticated USING (true);
CREATE POLICY je_insert ON journal_entries FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY je_update ON journal_entries FOR UPDATE TO authenticated WITH CHECK (true);
CREATE POLICY je_delete ON journal_entries FOR DELETE TO authenticated USING (true);

DROP POLICY IF EXISTS jl_delete ON journal_lines;
DROP POLICY IF EXISTS jl_insert ON journal_lines;
DROP POLICY IF EXISTS jl_select ON journal_lines;
DROP POLICY IF EXISTS jl_update ON journal_lines;
CREATE POLICY jl_select ON journal_lines FOR SELECT TO authenticated USING (true);
CREATE POLICY jl_insert ON journal_lines FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY jl_update ON journal_lines FOR UPDATE TO authenticated WITH CHECK (true);
CREATE POLICY jl_delete ON journal_lines FOR DELETE TO authenticated USING (true);

-- ── 6. The missing get_related_accounts RPC ──
CREATE OR REPLACE FUNCTION public.get_related_accounts(p_account_id uuid)
RETURNS TABLE(
  id uuid,
  code text,
  name text,
  account_type text,
  total_debit numeric,
  total_credit numeric,
  interaction_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $function$
  SELECT a.id, a.code, a.name, a.account_type,
         COALESCE(SUM(sl.debit), 0) AS total_debit,
         COALESCE(SUM(sl.credit), 0) AS total_credit,
         COUNT(*) AS interaction_count
    FROM journal_lines sl
    JOIN accounts a ON a.id = sl.account_id
   WHERE sl.journal_entry_id IN (SELECT journal_entry_id FROM journal_lines WHERE account_id = p_account_id)
     AND sl.account_id <> p_account_id
   GROUP BY a.id, a.code, a.name, a.account_type
   ORDER BY COUNT(*) DESC, a.code;
$function$;

COMMIT;
