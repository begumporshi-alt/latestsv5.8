-- Repair the 8 MISMATCH invoices on the COGS audit page.
--
-- Root causes found per invoice (line-level comparison of JEs vs items vs FIFO):
--   * INV-940540, INV-940629, INV-940634: JE lines posted at COIL price instead
--     of METER price (multi-unit conversion bug, e.g. 34m x 8,501 instead of
--     34m x 85.01; one line in INV-940540 is 1,973,400 vs correct 19,734).
--     INV-940634's JE also reflects PRE-EDIT items (has lines matching no
--     current item and misses current items) — the COGS JE was never reposted
--     after the invoice was edited.
--   * POS-00590024: stale pre-edit JE (31,116.62 vs current items 36,524.00).
--   * POS-00590005, POS-00589964: lump + per-item double postings where the
--     per-item set is incomplete/over-costed (589964's per-item set sums to
--     expected minus one item that never got its JE).
--   * POS-00590047: lump posted one item at FIFO batch cost (350) instead of
--     cost_price (210), plus a duplicate per-item JE.
--   * POS-00590064: remaining lump after earlier partial cleanup is 438 short
--     of current items.
--
-- Repair (uniform): delete every original COGS JE of the invoice via
-- delete_duplicate_cogs_je (rows captured in cogs_deletion_audit), then repost
-- ONE clean lump JE — Dr 5000 / Cr 1200 — at SUM(items.quantity * cost_price),
-- dated at the invoice date so period COGS stays correct.
--
-- Target rationale: items x cost_price is the audit's source of truth
-- (Source A) and equals cost_price_history (Source B) for all 8 invoices.

DO $$
DECLARE
  v_inv        RECORD;
  v_item_count integer;
  v_target     numeric;
  v_je         RECORD;
  v_res        jsonb;
  v_cogs       uuid;
  v_inventory  uuid;
  v_new_je     uuid;
  v_deleted    integer := 0;
  v_fixed      integer := 0;
BEGIN
  SELECT id INTO v_cogs      FROM accounts WHERE code = '5000' LIMIT 1;
  SELECT id INTO v_inventory FROM accounts WHERE code = '1200' LIMIT 1;
  IF v_cogs IS NULL OR v_inventory IS NULL THEN
    RAISE EXCEPTION 'Accounts 5000/1200 not found';
  END IF;

  FOR v_inv IN
    SELECT i.id, i.invoice_number, i.invoice_date, i.customer_id
    FROM invoices i
    WHERE i.invoice_number IN (
      'INV-940540','INV-940629','INV-940634','POS-00590024',
      'POS-00590005','POS-00590064','POS-00590047','POS-00589964'
    )
    ORDER BY i.invoice_number
  LOOP
    -- Target = current items x cost_price (audit Source A = Source B)
    SELECT COALESCE(SUM(quantity * cost_price), 0), COUNT(*)
    INTO v_target, v_item_count
    FROM invoice_items
    WHERE invoice_id = v_inv.id AND quantity > 0;

    -- 1. Remove every original COGS JE (audit-logged per JE)
    FOR v_je IN
      SELECT je.id
      FROM journal_entries je
      WHERE je.reference_type IN ('invoice', 'invoice_edit')
        AND je.reference_id = v_inv.id
        AND je.description ~* '^COGS'
        AND je.is_posted = true
      ORDER BY je.entry_date, je.id
    LOOP
      v_res := delete_duplicate_cogs_je(
        v_je.id,
        'COGS mismatch repair: removed stale/incorrect COGS posting (wrong unit price, pre-edit items, or duplicate per-item set); reposted at items x cost_price',
        'cogs-mismatch-repair'
      );
      IF NOT (v_res->>'success')::boolean THEN
        RAISE EXCEPTION 'Delete failed for % (JE %): %',
          v_inv.invoice_number, v_je.id, v_res->>'error';
      END IF;
      v_deleted := v_deleted + 1;
    END LOOP;

    -- 2. Repost one clean lump JE at the invoice date
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

    RAISE NOTICE 'Repaired %: deleted old JEs, reposted % at %',
      v_inv.invoice_number, v_new_je, ROUND(v_target, 2);
    v_fixed := v_fixed + 1;
  END LOOP;

  RAISE NOTICE 'Done: % invoices repaired, % JEs deleted', v_fixed, v_deleted;
END $$;
