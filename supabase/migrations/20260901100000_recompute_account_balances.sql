-- ============================================================
-- Migration: Recompute accounts.balance from the journal ledger
--             + patch delete_duplicate_cogs_je to reverse balances
-- Date: 2026-09-01
--
-- PROBLEM (verified 2026-09-01):
--   accounts.balance is a denormalized cache maintained by
--   post_journal_entry (it adds each line's debit/credit on post) and
--   read directly by the Chart of Accounts page. Journal DELETIONS must
--   reverse it symmetrically — but delete_duplicate_cogs_je (used by the
--   COGS audit page's bulk fix and the 2026-09-01 ledger rebase) deleted
--   journal rows without touching the column, as did several historical
--   debug migrations. The frontend journal/expenses pages reverse
--   correctly (via increment_account_balance / direct updates), so the
--   damage is entirely from server-side deletions.
--
--   Measured drift (stored minus journal-derived, correct sign
--   convention per account type):
--     5000 COGS              +1,625,396.22  (COGS rebase deletions)
--     1200 Inventory         -1,625,396.22  (mirror of the same JEs)
--     1001 Cash in Hand      -2,740.00      (historical deletions)
--     1100 A/R + 4000 Sales  +790.00 each   (a deleted invoice JE)
--     6331 / 1027            -500.00 / -8.00
--   The other 31 accounts match the ledger exactly. No account carries
--   a manual seed balance (the accounts page creates accounts with
--   balance 0 and posts a proper 'opening_balance' journal entry), so a
--   full recompute is safe and canonical.
--
-- THIS MIGRATION:
--   1. Patches delete_duplicate_cogs_je to reverse accounts.balance for
--      every deleted line (mirroring post_journal_entry's per-type sign
--      convention), so the COGS audit page's bulk fix can never drift
--      the column again.
--   2. Recomputes every account's balance from journal_lines, recording
--      before/after values in account_balance_recompute_audit.
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- 1. Patch delete_duplicate_cogs_je: reverse balances on delete
--    (same body as 20260901040000 part A, plus the reversal loop)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION delete_duplicate_cogs_je(
  p_je_id      uuid,
  p_reason     text,
  p_username   text DEFAULT 'system'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_je        journal_entries%ROWTYPE;
  v_invoice   invoices%ROWTYPE;
  v_result    jsonb;
  v_lines     integer := 0;
  v_invoice_is_cancelled boolean := false;
  v_line      journal_lines%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR TRIM(p_reason) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Reason is required');
  END IF;

  SELECT * INTO v_je FROM journal_entries WHERE id = p_je_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success',       true,
      'idempotent',    true,
      'message',       'Journal entry not found — already deleted or never existed',
      'je_id',         p_je_id
    );
  END IF;

  -- Guard: must be COGS entry (postings, reconciliations, edit-reversal strays,
  -- or their reversals)
  IF v_je.description NOT ILIKE 'COGS%'
     AND v_je.description NOT ILIKE 'Reverse COGS%'
     AND v_je.description NOT ILIKE 'REVERSAL - COGS%' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Only COGS journal entries can be deleted via this function');
  END IF;

  -- Guard: cannot delete draft (unposted) entries
  IF v_je.is_posted = false THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot delete draft (unposted) journal entries');
  END IF;

  -- Fetch linked invoice
  BEGIN
    SELECT * INTO v_invoice FROM invoices WHERE id = v_je.reference_id;
    v_invoice_is_cancelled := (v_invoice.status = 'cancelled');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  -- Guard: reversal entries may only be deleted when their invoice is cancelled
  -- (for active invoices, reversals are legitimate corrections — keep them)
  IF v_je.description ILIKE 'Reverse COGS%' AND NOT v_invoice_is_cancelled THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot delete a reversal entry of an active invoice');
  END IF;

  -- Audit trail before delete
  CREATE TABLE IF NOT EXISTS cogs_deletion_audit (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    je_id           uuid NOT NULL,
    invoice_id      uuid,
    invoice_number  text,
    entry_number    text,
    description     text,
    total_debit     numeric,
    total_credit    numeric,
    entry_date      date,
    deleted_by      text,
    reason          text,
    deleted_at      timestamptz DEFAULT NOW(),
    balance_impact  numeric
  );

  INSERT INTO cogs_deletion_audit
    (je_id, invoice_id, invoice_number, entry_number, description,
     total_debit, total_credit, entry_date, deleted_by, reason, balance_impact)
  VALUES
    (p_je_id, v_je.reference_id, v_invoice.invoice_number, v_je.entry_number,
     v_je.description, v_je.total_debit, v_je.total_credit,
     v_je.entry_date, p_username, p_reason,
     CASE WHEN v_je.total_debit > 0 THEN v_je.total_debit ELSE v_je.total_credit END)
  ON CONFLICT DO NOTHING;

  -- Reverse the denormalized accounts.balance for every line, mirroring
  -- how post_journal_entry applied it (asset/expense: debit-credit;
  -- liability/equity/revenue: credit-debit)
  FOR v_line IN SELECT * FROM journal_lines WHERE journal_entry_id = p_je_id LOOP
    UPDATE accounts
    SET balance = CASE
      WHEN account_type IN ('liability', 'equity', 'revenue')
        THEN balance - (v_line.credit - v_line.debit)
      ELSE balance - (v_line.debit - v_line.credit)
    END
    WHERE id = v_line.account_id;
  END LOOP;

  DELETE FROM journal_lines WHERE journal_entry_id = p_je_id;
  GET DIAGNOSTICS v_lines = ROW_COUNT;

  DELETE FROM journal_entries WHERE id = p_je_id;

  v_result := jsonb_build_object(
    'success',       true,
    'idempotent',    false,
    'je_id',         p_je_id,
    'invoice_id',    v_je.reference_id,
    'invoice_number',v_invoice.invoice_number,
    'description',   v_je.description,
    'debit_removed', v_je.total_debit,
    'lines_removed', v_lines,
    'reason',        p_reason,
    'deleted_by',    p_username,
    'deleted_at',    NOW()
  );

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION delete_duplicate_cogs_je(uuid,text,text) IS
'Safe, audit-logged deletion of COGS-family journal entries (postings, reconciliation strays,
REVERSAL-COGS edit strays). Reverse-COGS entries deletable only for cancelled invoices.
Reverses the denormalized accounts.balance for every deleted line.';

-- ─────────────────────────────────────────────────────────────
-- 2. Audit table for the recompute
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS account_balance_recompute_audit (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL,
  code         text,
  name         text,
  old_balance  numeric,
  new_balance  numeric,
  delta        numeric,
  done_at      timestamptz DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────
-- 3. Recompute every account's balance from journal_lines
-- ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  r record;
  v_derived numeric;
  v_changed integer := 0;
BEGIN
  FOR r IN
    SELECT a.id, a.code, a.name, a.account_type, a.balance
    FROM accounts a
    ORDER BY a.code
  LOOP
    SELECT CASE
             WHEN r.account_type IN ('liability', 'equity', 'revenue')
               THEN COALESCE(SUM(jl.credit - jl.debit), 0)
             ELSE COALESCE(SUM(jl.debit - jl.credit), 0)
           END
      INTO v_derived
    FROM journal_lines jl
    WHERE jl.account_id = r.id;

    IF r.balance IS DISTINCT FROM v_derived THEN
      INSERT INTO account_balance_recompute_audit
        (account_id, code, name, old_balance, new_balance, delta)
      VALUES
        (r.id, r.code, r.name, r.balance, v_derived, v_derived - r.balance);

      UPDATE accounts SET balance = v_derived WHERE id = r.id;
      v_changed := v_changed + 1;
      RAISE NOTICE 'Recomputed % %: % -> %', r.code, r.name, r.balance, v_derived;
    END IF;
  END LOOP;

  RAISE NOTICE 'Account balance recompute complete: % accounts adjusted', v_changed;
END $$;
