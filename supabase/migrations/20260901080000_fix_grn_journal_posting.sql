-- ============================================================
-- Migration: Fix GRN journal posting (part 1 — infrastructure)
-- Date: 2026-09-01
--
-- VERIFIED PROBLEM (live DB audit 2026-09-01):
--   trg_grn_accounting on goods_receipt_notes is live — re-created by
--   20260830020000_deploy_fifo_system.sql one day AFTER 20260829210000
--   deliberately removed it (batch creation had been moved to the
--   frontend GRN handler for reliability).
--
--   The trigger is structurally broken for the frontend flow:
--     1. It fires at GRN header INSERT, BEFORE the frontend updates
--        purchase_order_items.received_quantity — so the FIRST GRN on a
--        PO sees all quantities at 0 and posts nothing, while any SECOND
--        GRN on the same PO re-reads CUMULATIVE quantities and would
--        double-create batches and double-post the journal.
--     2. It builds journal lines with 'account_code' keys, but the live
--        post_journal_entry only reads 'account_id' — if it fired today
--        it would insert journal lines with NULL accounts.
--     3. It passes NEW.tenant_id as the 6th positional argument, which
--        now lands on p_customer_id.
--
--   Historical damage already in the data (repaired in part 2):
--     - 32 GRNs have TWO identical journals each (৳617,557.82 duplicated
--       Dr 1200 / Cr 2000) from the double-trigger era of 2026-08-28/29.
--     - 16 GRNs (৳19,707.48) have batches but no journal at all.
--     - 1 orphan journal for deleted test GRN "GRN-TEST-FINAL" (৳1.80).
--     - GRN-TEST-4 (manual test row) injected a phantom duplicate batch
--       for PO-000048/test5 plus two phantom journals.
--
-- THIS MIGRATION:
--   1. Drops the trigger + function for good.
--   2. Creates post_grn_journal(p_grn_id): the correct, idempotent way to
--      post a GRN's journal — amount derived from THIS GRN's
--      inventory_batches (never cumulative PO quantities), one journal
--      per GRN, called by the frontend after batch creation. Follows the
--      create_opening_batch pattern (account_id-keyed json lines).
--   3. Creates grn_journal_cleanup_audit for the repair trail.
--   4. Creates delete_grn_journal(p_je_id, p_reason): audit-logged GRN
--      journal deletion that also reverses the denormalized
--      accounts.balance (post_journal_entry updates it on post, so
--      deletion must mirror it). Execute revoked from anon/authenticated
--      because only migrations/admin should delete journals.
--
-- Part 2 (20260901090000) performs the actual data repair.
-- ============================================================

-- 1. Remove the broken trigger (both historical names, defensively)
DROP TRIGGER IF EXISTS trg_grn_accounting ON goods_receipt_notes;
DROP TRIGGER IF EXISTS grn_accounting_trigger ON goods_receipt_notes;
DROP FUNCTION IF EXISTS grn_accounting_trigger();

-- ============================================================
-- 2. post_grn_journal: idempotent GRN journal poster
-- ============================================================
CREATE OR REPLACE FUNCTION post_grn_journal(p_grn_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_grn       goods_receipt_notes%ROWTYPE;
  v_total     numeric(15,2);
  v_inv_acct  uuid;
  v_ap_acct   uuid;
  v_po_number text;
  v_je_id     uuid;
BEGIN
  SELECT * INTO v_grn FROM goods_receipt_notes WHERE id = p_grn_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('posted', false, 'reason', 'GRN not found');
  END IF;

  IF v_grn.status <> 'posted' THEN
    RETURN jsonb_build_object('posted', false, 'reason', 'GRN not posted');
  END IF;

  -- Idempotency: exactly one journal per GRN
  IF EXISTS (SELECT 1 FROM journal_entries
             WHERE reference_type = 'grn' AND reference_id = p_grn_id) THEN
    RETURN jsonb_build_object('posted', false, 'reason', 'journal already exists');
  END IF;

  -- Inventory value received in THIS GRN, from its own FIFO batches —
  -- never from cumulative PO received quantities.
  SELECT COALESCE(SUM(quantity_received * unit_cost), 0)
    INTO v_total
  FROM inventory_batches
  WHERE reference_type = 'grn' AND reference_id = p_grn_id;

  IF v_total <= 0 THEN
    RETURN jsonb_build_object('posted', false, 'reason', 'no inventory batches for this GRN');
  END IF;

  SELECT id INTO v_inv_acct FROM accounts WHERE code = '1200' LIMIT 1;
  SELECT id INTO v_ap_acct   FROM accounts WHERE code = '2000' LIMIT 1;
  IF v_inv_acct IS NULL OR v_ap_acct IS NULL THEN
    RETURN jsonb_build_object('posted', false, 'reason', 'accounts 1200/2000 not found');
  END IF;

  SELECT po_number INTO v_po_number
  FROM purchase_orders WHERE id = v_grn.purchase_order_id;

  v_je_id := post_journal_entry(
    p_description    := 'Goods Received - GRN #' || v_grn.grn_number
                        || COALESCE(' / PO #' || v_po_number, ''),
    p_entry_date     := COALESCE(v_grn.received_date, CURRENT_DATE),
    p_reference_type := 'grn',
    p_reference_id   := v_grn.id,
    p_lines          := json_build_array(
      json_build_object('account_id', v_inv_acct, 'debit',  v_total,
                        'description', 'Inventory received'),
      json_build_object('account_id', v_ap_acct, 'credit', v_total,
                        'description', 'Accounts Payable - goods received')
    ),
    p_supplier_id    := v_grn.supplier_id
  );

  RETURN jsonb_build_object('posted', true, 'amount', v_total, 'je_id', v_je_id);
END;
$$;

-- ============================================================
-- 3. Audit trail (used by delete_grn_journal and the part-2 repair)
-- ============================================================
CREATE TABLE IF NOT EXISTS grn_journal_cleanup_audit (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action        text NOT NULL,   -- delete_journal | delete_phantom_batch | delete_phantom_grn | backfill_journal
  grn_id        uuid,
  grn_number    text,
  je_id         uuid,
  entry_number  text,
  description   text,
  amount        numeric,
  batch_id      uuid,
  reason        text,
  done_at       timestamptz DEFAULT now()
);

-- ============================================================
-- 4. delete_grn_journal: audit-logged deletion with balance reversal
-- ============================================================
CREATE OR REPLACE FUNCTION delete_grn_journal(p_je_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_je        journal_entries%ROWTYPE;
  v_line      journal_lines%ROWTYPE;
  v_grn_number text;
  v_amount     numeric;
BEGIN
  SELECT * INTO v_je FROM journal_entries WHERE id = p_je_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('deleted', false, 'reason', 'journal entry not found');
  END IF;

  IF v_je.reference_type <> 'grn' THEN
    RAISE EXCEPTION 'refusing to delete non-GRN journal entry %', p_je_id;
  END IF;

  SELECT grn_number INTO v_grn_number
  FROM goods_receipt_notes WHERE id = v_je.reference_id;

  -- Reverse the denormalized accounts.balance exactly as
  -- post_journal_entry applied it (asset/expense: debit-credit;
  -- liability/equity/revenue: credit-debit).
  FOR v_line IN SELECT * FROM journal_lines WHERE journal_entry_id = p_je_id LOOP
    UPDATE accounts
    SET balance = CASE
      WHEN account_type IN ('liability', 'equity', 'revenue')
        THEN balance - (v_line.credit - v_line.debit)
      ELSE balance - (v_line.debit - v_line.credit)
    END
    WHERE id = v_line.account_id;
  END LOOP;

  v_amount := GREATEST(COALESCE(v_je.total_debit, 0), COALESCE(v_je.total_credit, 0));

  INSERT INTO grn_journal_cleanup_audit
    (action, grn_id, grn_number, je_id, entry_number, description, amount, reason)
  VALUES
    ('delete_journal', v_je.reference_id, v_grn_number, v_je.id, v_je.entry_number,
     v_je.description, v_amount, p_reason);

  DELETE FROM journal_lines WHERE journal_entry_id = p_je_id;
  DELETE FROM journal_entries WHERE id = p_je_id;

  RETURN jsonb_build_object('deleted', true, 'amount', v_amount);
END;
$$;

-- Only migrations / service role should ever delete journals.
REVOKE EXECUTE ON FUNCTION delete_grn_journal(uuid, text) FROM anon, authenticated;
