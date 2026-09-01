-- ============================================================
-- Migration: Fix GRN journal posting (part 2 — data repair)
-- Date: 2026-09-01
--
-- Repairs the historical damage left by the GRN accounting trigger
-- family (see 20260901080000 for the full audit):
--
--   A. DEDUPE — 32 GRNs each carry TWO identical journals (same
--      description, date, amounts, even the same created_at microsecond;
--      journal debit is exactly 2x the GRN's batch value on every one).
--      Keep a single copy per GRN, delete the rest via
--      delete_grn_journal (audit-logged, reverses accounts.balance).
--      Overstatement removed: ৳617,557.82 on each of GL 1200 and 2000.
--
--   B. PHANTOM TEST DATA — GRN-TEST-4 is a manual test row against
--      PO-000048 (product test5, total received qty 1.0). Its trigger
--      fire created a SECOND batch for stock that only ever existed
--      once (FIFO shows 2.0 units vs PO received 1.0 and
--      inventory_items 1.0) plus two phantom journals. The batch has
--      zero invoice_item_batch_consumption references (verified), so it
--      is deleted along with both journals and the GRN row itself.
--
--   C. ORPHAN JOURNAL — one journal references GRN-TEST-FINAL, a GRN
--      row that no longer exists (৳1.80). Deleted.
--
--   D. BACKFILL — 16 posted GRNs (৳19,708.48) have inventory batches
--      but no journal. Each gets exactly one journal via the new
--      idempotent post_grn_journal, dated at the GRN's received_date.
--
-- Expected net effect on GL 1200 and GL 2000 (both move together):
--   -617,557.82 (dedupe) - 1.50 (TEST-4 kept journal) - 1.80 (orphan)
--   + 19,708.48 (backfill) = -597,852.64
--
-- Safe to re-run: every step is guarded and idempotent.
-- ============================================================

DO $$
DECLARE
  v_grn_id     uuid;
  v_je_id      uuid;
  v_keep_id    uuid;
  v_cnt        integer;
  v_test4_id   uuid;
  v_result     jsonb;
  v_deleted    integer := 0;
  v_backfilled integer := 0;
BEGIN
  -- ----------------------------------------------------------
  -- A. Dedupe: exactly one journal per GRN
  -- ----------------------------------------------------------
  FOR v_grn_id, v_cnt IN
    SELECT je.reference_id, COUNT(*)
    FROM journal_entries je
    WHERE je.reference_type = 'grn'
    GROUP BY je.reference_id
    HAVING COUNT(*) > 1
  LOOP
    -- keep the earliest entry deterministically
    SELECT id INTO v_keep_id
    FROM journal_entries
    WHERE reference_type = 'grn' AND reference_id = v_grn_id
    ORDER BY created_at, id
    LIMIT 1;

    FOR v_je_id IN
      SELECT id FROM journal_entries
      WHERE reference_type = 'grn' AND reference_id = v_grn_id
        AND id <> v_keep_id
      ORDER BY created_at, id
    LOOP
      PERFORM delete_grn_journal(v_je_id,
        'dedupe: identical duplicate from the double-trigger era (2026-08-28/29)');
      v_deleted := v_deleted + 1;
    END LOOP;
  END LOOP;

  -- ----------------------------------------------------------
  -- B. Purge phantom GRN-TEST-4 (journals + batch + row)
  -- ----------------------------------------------------------
  SELECT id INTO v_test4_id FROM goods_receipt_notes WHERE grn_number = 'GRN-TEST-4';
  IF v_test4_id IS NOT NULL THEN
    FOR v_je_id IN
      SELECT id FROM journal_entries
      WHERE reference_type = 'grn' AND reference_id = v_test4_id
    LOOP
      PERFORM delete_grn_journal(v_je_id, 'phantom test GRN: receipt never happened');
      v_deleted := v_deleted + 1;
    END LOOP;

    INSERT INTO grn_journal_cleanup_audit
      (action, grn_id, grn_number, batch_id, amount, reason)
    SELECT 'delete_phantom_batch', b.reference_id, 'GRN-TEST-4', b.id,
           ROUND(b.quantity_received * b.unit_cost, 2),
           'phantom duplicate batch (stock double-count for PO-000048/test5; unconsumed)'
    FROM inventory_batches b
    WHERE b.reference_type = 'grn' AND b.reference_id = v_test4_id;

    DELETE FROM inventory_batches
    WHERE reference_type = 'grn' AND reference_id = v_test4_id;

    INSERT INTO grn_journal_cleanup_audit
      (action, grn_id, grn_number, reason)
    VALUES ('delete_phantom_grn', v_test4_id, 'GRN-TEST-4',
            'manual test GRN removed together with its phantom effects');

    DELETE FROM goods_receipt_notes WHERE id = v_test4_id;
  END IF;

  -- ----------------------------------------------------------
  -- C. Orphan journals whose GRN row no longer exists
  -- ----------------------------------------------------------
  FOR v_je_id IN
    SELECT je.id
    FROM journal_entries je
    WHERE je.reference_type = 'grn'
      AND NOT EXISTS (SELECT 1 FROM goods_receipt_notes g WHERE g.id = je.reference_id)
  LOOP
    PERFORM delete_grn_journal(v_je_id, 'orphan journal: GRN row no longer exists');
    v_deleted := v_deleted + 1;
  END LOOP;

  -- ----------------------------------------------------------
  -- D. Backfill: posted GRNs with batches but no journal
  -- ----------------------------------------------------------
  FOR v_grn_id IN
    SELECT g.id
    FROM goods_receipt_notes g
    WHERE g.status = 'posted'
      AND EXISTS (SELECT 1 FROM inventory_batches b
                  WHERE b.reference_type = 'grn' AND b.reference_id = g.id)
      AND NOT EXISTS (SELECT 1 FROM journal_entries je
                      WHERE je.reference_type = 'grn' AND je.reference_id = g.id)
    ORDER BY g.created_at
  LOOP
    v_result := post_grn_journal(v_grn_id);
    IF (v_result ->> 'posted')::boolean THEN
      INSERT INTO grn_journal_cleanup_audit
        (action, grn_id, grn_number, je_id, amount, reason)
      VALUES ('backfill_journal', v_grn_id,
              (SELECT grn_number FROM goods_receipt_notes WHERE id = v_grn_id),
              (v_result ->> 'je_id')::uuid,
              (v_result ->> 'amount')::numeric,
              'backfill: GRN had inventory batches but no journal');
      v_backfilled := v_backfilled + 1;
    END IF;
  END LOOP;

  RAISE NOTICE 'GRN journal repair complete: % journals deleted, % journals backfilled',
    v_deleted, v_backfilled;
END $$;
