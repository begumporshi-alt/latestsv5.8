-- Ledger-wide COGS rebase: true-up every invoice's net COGS on GL 5000.
--
-- History of the damage (all layers):
--   1. 20260827 repair posted 'COGS reconciliation' CREDIT JEs to neutralize
--      duplicate COGS postings (instead of deleting the duplicates), and
--      'cogs_repair' restatement JEs — leaving the bad originals in place.
--   2. The 2026-08-31 duplicate cleanup then DELETED the bad/duplicate
--      originals — orphaning those correction credits. For ~100 invoices
--      the cleanup kept the reconciliation CREDIT as the "keeper"
--      (its total_debit matches expected exactly) and deleted the REAL
--      COGS JE, leaving those invoices with net COGS of MINUS their target.
--   3. 20260901020000 + 20260901030000 fixed the 8 mismatches and removed
--      the 26 orphaned cogs_repair JEs, but the reconciliation strays and
--      'REVERSAL - COGS' edit-reversal strays remained.
--
-- Result found by verification: 109 active invoices have net COGS on GL
-- 5000 different from items x cost_price (most mirrored at exactly minus
-- their target), understating total COGS by ~2.27M net.
--
-- This migration:
--   A. extends delete_duplicate_cogs_je to also accept 'REVERSAL - COGS%'
--      descriptions (edit-reversal strays; they are COGS entries)
--   B. for EVERY non-draft invoice whose net COGS (JEs on account 5000 with
--      COGS-family descriptions, ref invoice/invoice_edit/invoice_cancel)
--      differs from its target by more than 1.00:
--        target = 0 for cancelled invoices, else SUM(items x cost_price)
--        - delete all its COGS-family JEs (audit-logged)
--        - repost ONE clean lump JE (Dr 5000 / Cr 1200) at the target,
--          dated at the invoice date
--      Invoices already correct are left untouched. Sales-return JEs are
--      legitimate business events and are neither counted nor touched.

-- ─────────────────────────────────────────────────────────────
-- A. delete_duplicate_cogs_je: accept 'REVERSAL - COGS%' too
--    (same body as 20260831160000 part 3, one guard line extended)
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
REVERSAL-COGS edit strays). Reverse-COGS entries deletable only for cancelled invoices.';

-- ─────────────────────────────────────────────────────────────
-- B. Rebase every invoice whose net COGS on GL 5000 misses its target
-- ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_inv        RECORD;
  v_je         RECORD;
  v_res        jsonb;
  v_target     numeric;
  v_item_count integer;
  v_net        numeric;
  v_cogs       uuid;
  v_inventory  uuid;
  v_new_je     uuid;
  v_repaired   integer := 0;
  v_deleted    integer := 0;
BEGIN
  SELECT id INTO v_cogs      FROM accounts WHERE code = '5000' LIMIT 1;
  SELECT id INTO v_inventory FROM accounts WHERE code = '1200' LIMIT 1;
  IF v_cogs IS NULL OR v_inventory IS NULL THEN
    RAISE EXCEPTION 'Accounts 5000/1200 not found';
  END IF;

  FOR v_inv IN
    SELECT i.id, i.invoice_number, i.invoice_date, i.customer_id, i.status,
           (i.status = 'cancelled') AS is_cancelled
    FROM invoices i
    WHERE i.status <> 'draft'
    ORDER BY i.invoice_number
  LOOP
    -- Target: current items x cost_price; zero for cancelled invoices
    SELECT COALESCE(SUM(quantity * cost_price), 0), COUNT(*)
    INTO v_target, v_item_count
    FROM invoice_items
    WHERE invoice_id = v_inv.id AND quantity > 0;
    IF v_inv.is_cancelled THEN
      v_target := 0;
    END IF;

    -- Current net COGS on GL 5000 (COGS-family JEs only; sales returns excluded)
    SELECT COALESCE(SUM(jl.debit - jl.credit), 0)
    INTO v_net
    FROM journal_entries je
    JOIN journal_lines jl ON jl.journal_entry_id = je.id
    JOIN accounts a ON a.id = jl.account_id AND a.code = '5000'
    WHERE je.reference_id = v_inv.id
      AND je.reference_type IN ('invoice', 'invoice_edit', 'invoice_cancel')
      AND (je.description ~* '^COGS' OR je.description ~* '^Reverse COGS'
           OR je.description ~* '^REVERSAL - COGS');

    IF ABS(v_net - v_target) <= 1.00 THEN
      CONTINUE;  -- already correct — leave untouched
    END IF;

    -- Remove all COGS-family JEs for this invoice (audit-logged)
    FOR v_je IN
      SELECT je.id
      FROM journal_entries je
      WHERE je.reference_type IN ('invoice', 'invoice_edit', 'invoice_cancel')
        AND je.reference_id = v_inv.id
        AND (je.description ~* '^COGS' OR je.description ~* '^Reverse COGS'
             OR je.description ~* '^REVERSAL - COGS')
        AND je.is_posted = true
      ORDER BY je.entry_date, je.id
    LOOP
      v_res := delete_duplicate_cogs_je(
        v_je.id,
        'COGS ledger rebase: net COGS on GL 5000 was ' || ROUND(v_net, 2) ||
        ' vs target ' || ROUND(v_target, 2) || ' — removed stale/stray COGS entries and reposted correctly',
        'cogs-ledger-rebase'
      );
      IF NOT (v_res->>'success')::boolean THEN
        RAISE EXCEPTION 'Delete failed for % (JE %): %',
          v_inv.invoice_number, v_je.id, v_res->>'error';
      END IF;
      v_deleted := v_deleted + 1;
    END LOOP;

    -- Repost one clean lump JE at the target, dated at the invoice date
    IF v_target > 0 THEN
      v_new_je := post_journal_entry(
        'COGS - ' || v_inv.invoice_number || ' (' || v_item_count || ' items, total: ' || ROUND(v_target, 2) || ')',
        v_inv.invoice_date,
        'invoice',
        v_inv.id,
        json_build_array(
          json_build_object('account_id', v_cogs, 'debit', v_target, 'credit', 0,
            'description', 'COGS for ' || v_inv.invoice_number),
          json_build_object('account_id', v_inventory, 'debit', 0, 'credit', v_target,
            'description', 'Inventory consumed for ' || v_inv.invoice_number)
        )::json,
        v_inv.customer_id
      );
    END IF;

    RAISE NOTICE 'Rebased % (%, %): net % -> target %',
      v_inv.invoice_number, v_inv.status, v_inv.invoice_date, ROUND(v_net, 2), ROUND(v_target, 2);
    v_repaired := v_repaired + 1;
  END LOOP;

  RAISE NOTICE 'Rebase done: % invoices repaired, % JEs deleted', v_repaired, v_deleted;
END $$;
