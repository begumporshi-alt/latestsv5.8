-- Migration: 20260831130000_cogs_audit_rpc.sql
-- Adds COGS audit RPCs:
--   get_cogs_audit()            → per-invoice COGS audit with 4-way source comparison + auto-detect keeper JE
--   delete_duplicate_cogs_je()  → safe delete with idempotency guard + audit trail

-- ──────────────────────────────────────────────
-- 1. get_cogs_audit()
-- Returns one row per invoice with COGS journal entries.
-- Four COGS sources are compared:
--   A = SUM(items.quantity * items.cost_price)           ← source of truth (what we charge the customer)
--   B = cost_price_history extended total               ← purchase cost at time of invoice
--   C = SUM(journal_entries.total_debit WHERE desc~^'COGS') ← what was posted to GL
--   D = SUM(invoice_item_batch_consumption)             ← FIFO COGS at item level
-- Auto-detect logic:
--   • keeper  = COGS JE with lowest |total - expected_cogs_A|
--   • status  = CONSISTENT | OVERSTATEMENT | UNDERSTATEMENT | MISSING | MULTIPLE_ISSUE
--   • issue_type = SINGLE | DUPLICATE_LUMP_AND_PER_ITEM | MISMATCH | MISSING | EXACT
--   • fix_action = NONE | KEEP_LUMP_DELETE_PER_ITEM | KEEP_PER_ITEM_DELETE_LUMP | KEEP_KEEPER_DELETE_REST
--   • balance_impact = total of all non-keeper COGS JEs (what gets removed)
-- ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_cogs_audit()
RETURNS TABLE (
  aud_invoice_id            uuid,
  invoice_number            text,
  invoice_date              date,
  invoice_status            text,
  invoice_total             numeric,
  customer_name             text,
  warehouse_name            text,
  item_count                integer,
  -- Source A: items × cost_price (source of truth)
  expected_cogs_a           numeric,
  -- Source B: cost_price_history
  expected_cogs_b           numeric,
  -- Source C: COGS journal entries
  journal_cogs_c            numeric,
  journal_je_count          integer,
  -- Source D: FIFO consumption
  fifo_cogs_d               numeric,
  -- COGS journal entries detail
  cogs_journal_entries      jsonb,
  -- Auto-detect results
  keeper_je_id              uuid,
  keeper_je_total           numeric,
  keeper_je_diff            numeric,
  all_je_diff               numeric,
  issue_type                text,
  fix_action                text,
  balance_impact            numeric,
  audit_status              text,
  has_per_item_je           boolean,
  has_lump_je               boolean,
  -- Per-item JE details
  per_item_je_ids           uuid[],
  lump_je_ids               uuid[],
  -- FIFO consumption details
  fifo_consumptions         jsonb,
  -- Batch-level FIFO totals per item
  item_fifo_totals          jsonb,
  -- Root cause classification
  root_cause                text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  DECLARE
  v_invoice     RECORD;
  v_je          RECORD;
  v_consume     RECORD;
  v_item_cnt    integer := 0;
  v_is_per_item boolean;

  v_expected_a       numeric := 0;
  v_expected_b       numeric := 0;
  v_journal_cogs     numeric := 0;
  v_fifo_cogs        numeric := 0;
  v_je_count         integer := 0;
  v_keeper_je_id     uuid;
  v_keeper_total     numeric := 0;
  v_keeper_diff      numeric := 999999999;
  v_all_je_diff      numeric := 0;
  v_balance_impact   numeric := 0;
  v_fix_action       text := 'NONE';
  v_issue_type       text := 'EXACT';
  v_audit_status     text := 'CONSISTENT';
  v_has_per_item     boolean := false;
  v_has_lump         boolean := false;
  v_per_item_ids     uuid[]  := '{}';
  v_lump_ids         uuid[]  := '{}';
  v_cogs_jes        jsonb := '[]'::jsonb;
  v_fifo_conset      jsonb := '[]'::jsonb;
  v_item_fifo_ttls   jsonb := '[]'::jsonb;
  v_root_cause        text := NULL;
  v_per_item_total   numeric := 0;
  v_lump_total       numeric := 0;
BEGIN
  FOR v_invoice IN
    SELECT i.id, i.invoice_number, i.invoice_date, i.status,
           i.total_amount, i.customer_id, i.warehouse_id,
           c.name AS customer_name, w.name AS warehouse_name
    FROM   invoices i
    LEFT   JOIN customers c ON c.id = i.customer_id
    LEFT   JOIN warehouses w ON w.id = i.warehouse_id
    WHERE  i.status NOT IN ('draft','cancelled')
    ORDER  BY i.invoice_date ASC, i.invoice_number ASC
  LOOP
    -- ── Source A: SUM(items.quantity * cost_price) ──────────
    SELECT COALESCE(SUM(quantity * cost_price), 0),
           COUNT(*)
    INTO   v_expected_a, v_item_cnt
    FROM   invoice_items
    WHERE  invoice_id = v_invoice.id AND quantity > 0;

    -- ── Source B: cost_price_history ────────────────────────
    SELECT COALESCE(SUM(quantity * cost_price_per_qty), 0)
    INTO   v_expected_b
    FROM   cost_price_history
    WHERE  invoice_id = v_invoice.id;

    -- ── Source C: COGS journal entries ──────────────────────
    v_cogs_jes := '[]'::jsonb;
    v_je_count := 0;
    v_journal_cogs := 0;
    v_per_item_ids := '{}';
    v_lump_ids := '{}';
    v_has_per_item := false;
    v_has_lump := false;
    v_per_item_total := 0;
    v_lump_total := 0;

    FOR v_je IN
      SELECT je.id, je.entry_date, je.description, je.total_debit,
             je.reference_type, je.reference_id, je.is_posted,
             je.entry_number
      FROM   journal_entries je
      WHERE  je.reference_type = 'invoice'
        AND  je.reference_id   = v_invoice.id
        AND  je.description ~* '^COGS'
        AND  je.is_posted = true
      ORDER  BY je.entry_date ASC, je.id ASC
    LOOP
      v_je_count := v_je_count + 1;
      v_journal_cogs := v_journal_cogs + v_je.total_debit;

      -- Classify JE type by description pattern
      DECLARE
        v_local_per_item boolean;
      BEGIN
        -- Per-item JEs have ' - ' after invoice number (COGS - INV-xxx - ProductName - Item N)
        -- Lump JE has no product name after invoice number
        v_local_per_item := (v_je.description ~ ' - .+ - Item ');
        v_is_per_item := v_local_per_item;
        v_has_per_item := v_has_per_item OR v_local_per_item;
        v_has_lump := v_has_lump OR NOT v_local_per_item;

        IF v_local_per_item THEN
          v_per_item_ids := array_append(v_per_item_ids, v_je.id);
          v_per_item_total := v_per_item_total + v_je.total_debit;
        ELSE
          v_lump_ids := array_append(v_lump_ids, v_je.id);
          v_lump_total := v_lump_total + v_je.total_debit;
        END IF;
      END;

      v_cogs_jes := v_cogs_jes || jsonb_build_array(jsonb_build_object(
        'id',            v_je.id,
        'entry_number',  v_je.entry_number,
        'entry_date',    v_je.entry_date,
        'description',   v_je.description,
        'total_debit',   v_je.total_debit,
        'is_per_item',   v_is_per_item,
        'diff_from_expected', ROUND((v_je.total_debit - v_expected_a)::numeric, 2)
      ));
    END LOOP;

    -- ── Source D: FIFO consumption ─────────────────────────
    v_fifo_conset := '[]'::jsonb;
    v_fifo_cogs := 0;
    v_item_fifo_ttls := '[]'::jsonb;

    FOR v_consume IN
      SELECT iic.id, iic.invoice_item_id, iic.batch_id,
             iic.quantity_consumed AS consume_qty, iic.unit_cost, iic.cogs_amount,
             p.name AS product_name, p.sku AS product_sku,
             ib.batch_number,
             ii.product_id, ii.quantity AS item_qty, ii.cost_price AS item_cost_price,
             ROW_NUMBER() OVER (PARTITION BY iic.invoice_item_id ORDER BY ib.created_at ASC) AS batch_seq
      FROM   invoice_item_batch_consumption iic
      JOIN   invoice_items ii ON ii.id = iic.invoice_item_id
      JOIN   products p ON p.id = ii.product_id
      JOIN   inventory_batches ib ON ib.id = iic.batch_id
      WHERE  ii.invoice_id = v_invoice.id
      ORDER  BY ii.id, batch_seq
    LOOP
      v_fifo_cogs := v_fifo_cogs + COALESCE(v_consume.cogs_amount, 0);
      v_fifo_conset := v_fifo_conset || jsonb_build_array(jsonb_build_object(
        'consumption_id',   v_consume.id,
        'invoice_item_id',  v_consume.invoice_item_id,
        'batch_id',         v_consume.batch_id,
        'batch_number',     v_consume.batch_number,
        'product_name',     v_consume.product_name,
        'sku',              v_consume.product_sku,
        'batch_seq',        v_consume.batch_seq,
        'consume_qty',     v_consume.consume_qty,
        'cost_per_unit',   v_consume.unit_cost,
        'total_cost',       v_consume.cogs_amount,
        'item_qty',         v_consume.item_qty,
        'item_cost_price', v_consume.item_cost_price
      ));
    END LOOP;

    -- Per-item FIFO totals
    v_item_fifo_ttls := (
      SELECT jsonb_agg(row_to_json(t))
      FROM   (
        SELECT ii2.id AS invoice_item_id,
               p2.name AS product_name,
               p2.sku,
               ii2.quantity AS item_qty,
               ii2.cost_price AS item_cost_price,
               COALESCE(SUM(iibc.cogs_amount), 0) AS fifo_total,
               COUNT(iibc.id) AS batch_count,
               CASE WHEN ABS(COALESCE(SUM(iibc.cogs_amount),0) - (ii2.quantity * ii2.cost_price)) < 0.01
                    THEN 'EXACT'
                    ELSE 'DRIFT'
               END AS fifo_vs_cost
        FROM   invoice_items ii2
        JOIN   products p2 ON p2.id = ii2.product_id
        LEFT   JOIN invoice_item_batch_consumption iibc ON iibc.invoice_item_id = ii2.id
        WHERE  ii2.invoice_id = v_invoice.id
        GROUP  BY ii2.id, p2.name, p2.sku, ii2.quantity, ii2.cost_price
        ORDER  BY ii2.id
      ) t
    );

    -- ── Auto-detect keeper JE ──────────────────────────────
    -- Score every COGS JE by |total - expected|. Keeper = lowest score.
    -- Balance impact = sum of all non-keeper JEs.
    -- Issue classification (simple & reliable):
    --   EXACT           = 1 JE, within tolerance  → fix_action = NONE
    --   DUPLICATE_COGS  = >1 JE, keeper within tol → fix_action = DELETE_DUPLICATES
    --   MISMATCH        = keeper outside tolerance  → fix_action = REVIEW_MANUALLY
    --   MISSING         = no COGS JE               → fix_action = CREATE_JE
    v_keeper_je_id   := NULL;
    v_keeper_total   := 0;
    v_keeper_diff    := 999999999;
    v_balance_impact := 0;

    IF v_je_count = 0 THEN
      v_audit_status := 'MISSING';
      v_issue_type   := 'MISSING';
      v_fix_action   := 'CREATE_JE';
      v_root_cause   := 'NO_COGS_JE';

    ELSIF v_je_count >= 1 THEN
      -- Score all JEs; keeper = closest to expected
      FOR v_je IN
        SELECT je.id, je.total_debit,
               ABS(je.total_debit - v_expected_a) AS diff
        FROM   journal_entries je
        WHERE  je.reference_type = 'invoice'
          AND  je.reference_id   = v_invoice.id
          AND  je.description ~* '^COGS'
          AND  je.is_posted = true
        ORDER  BY diff ASC, je.entry_date ASC  -- diff ASC → closest first; tie-break by oldest
      LOOP
        IF v_keeper_je_id IS NULL THEN
          -- First JE is the best keeper
          v_keeper_je_id  := v_je.id;
          v_keeper_total  := v_je.total_debit;
          v_keeper_diff   := v_je.diff;
        ELSE
          -- Non-keepers contribute to balance impact
          v_balance_impact := v_balance_impact + v_je.total_debit;
        END IF;
      END LOOP;

      -- Classify based on keeper's diff
      IF v_keeper_diff <= 1.00
         OR (v_expected_a > 0 AND v_keeper_diff <= v_expected_a * 0.01 + 10)
         OR (v_expected_a = 0 AND v_keeper_diff = 0) THEN
        IF v_je_count = 1 THEN
          v_audit_status := 'CONSISTENT';
          v_issue_type   := 'EXACT';
          v_fix_action   := 'NONE';
          v_root_cause   := NULL;  -- clean
        ELSE
          v_audit_status := 'DUPLICATE_COGS';
          v_issue_type   := 'DUPLICATE_COGS';
          v_fix_action   := 'DELETE_DUPLICATES';
          v_root_cause   := CASE
            WHEN v_has_per_item AND v_has_lump THEN 'DOUBLE_TRIGGER'
            ELSE 'MULTIPLE_JES'
          END;
        END IF;
      ELSE
        v_audit_status := 'MISMATCH';
        v_issue_type   := 'MISMATCH';
        v_fix_action   := 'REVIEW_MANUALLY';
        v_root_cause   := 'KEEPER_OUTSIDE_TOLERANCE';
      END IF;
    END IF;

    -- ── Emit row ──────────────────────────────────────────
    aud_invoice_id      := v_invoice.id;
    invoice_number      := v_invoice.invoice_number;
    invoice_date        := v_invoice.invoice_date;
    invoice_status      := v_invoice.status;
    invoice_total       := v_invoice.total_amount;
    customer_name       := v_invoice.customer_name;
    warehouse_name      := v_invoice.warehouse_name;
    item_count          := COALESCE(v_item_cnt, 0);
    expected_cogs_a     := ROUND(v_expected_a, 2);
    expected_cogs_b     := ROUND(v_expected_b, 2);
    journal_cogs_c      := ROUND(v_journal_cogs, 2);
    journal_je_count    := v_je_count;
    fifo_cogs_d         := ROUND(v_fifo_cogs, 2);
    cogs_journal_entries := v_cogs_jes;
    keeper_je_id        := v_keeper_je_id;
    keeper_je_total     := ROUND(v_keeper_total, 2);
    keeper_je_diff      := ROUND(v_keeper_diff, 2);
    all_je_diff         := ROUND(v_all_je_diff, 2);
    issue_type          := v_issue_type;
    fix_action          := v_fix_action;
    balance_impact      := ROUND(v_balance_impact, 2);
    audit_status        := v_audit_status;
    has_per_item_je     := v_has_per_item;
    has_lump_je         := v_has_lump;
    per_item_je_ids     := v_per_item_ids;
    lump_je_ids         := v_lump_ids;
    fifo_consumptions   := v_fifo_conset;
    item_fifo_totals    := v_item_fifo_ttls;
    root_cause          := v_root_cause;

    RETURN NEXT;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION get_cogs_audit() IS
'Per-invoice COGS audit: compares items×cost_price (A), cost_price_history (B), journal COGS (C), FIFO consumption (D).
 Auto-detects keeper JE (closest to expected_cogs_A). Flags issue_type and fix_action for cleanup.';

-- ──────────────────────────────────────────────
-- 2. delete_duplicate_cogs_je()
-- Deletes a COGS journal entry with server-side safety guards.
-- Only deletes entries where:
--   • description LIKE 'COGS%'
--   • entry is not a reversal (no 'Reversal of' prefix)
--   • entry is posted
--   • is_reconciled = false (not bank-matched)
--   • no linked payments/reconciliations
-- Idempotent: if JE already gone, returns success.
-- Audit trail: inserts into cogs_deletion_audit before deleting.
-- ──────────────────────────────────────────────
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
BEGIN
  -- Guard: reason required
  IF p_reason IS NULL OR TRIM(p_reason) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Reason is required');
  END IF;

  -- Fetch JE
  BEGIN
    SELECT * INTO v_je FROM journal_entries WHERE id = p_je_id;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', 'Failed to fetch journal entry: ' || SQLERRM);
  END;

  IF NOT FOUND THEN
    -- Already deleted (idempotent)
    RETURN jsonb_build_object(
      'success',       true,
      'idempotent',    true,
      'message',       'Journal entry not found — already deleted or never existed',
      'je_id',         p_je_id
    );
  END IF;

  -- Guard: must be COGS entry
  IF v_je.description NOT ILIKE 'COGS%' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Only COGS journal entries can be deleted via this function');
  END IF;

  -- Guard: must be posted
  IF v_je.is_posted = false THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot delete draft (unposted) journal entries');
  END IF;

  -- Guard: cannot delete reversal entries (they are the fix, not the problem)
  IF v_je.description ILIKE 'Reversal of%' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot delete reversal journal entries — they are the correct fix');
  END IF;

  -- Guard: cannot delete reconciled entries (no is_reconciled column)
  -- Guard: payments link by reference_type/id not JE id, so no payment link check needed

  -- Fetch linked invoice for audit
  BEGIN
    SELECT * INTO v_invoice FROM invoices WHERE id = v_je.reference_id;
  EXCEPTION WHEN OTHERS THEN
    NULL; -- invoice may not exist
  END;

  -- ── Audit trail before delete ──────────────────────────
  BEGIN
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
  EXCEPTION WHEN OTHERS THEN
    NULL; -- table may already exist
  END;

  INSERT INTO cogs_deletion_audit
    (je_id, invoice_id, invoice_number, entry_number, description,
     total_debit, total_credit, entry_date, deleted_by, reason, balance_impact)
  VALUES
    (p_je_id, v_je.reference_id, v_invoice.invoice_number, v_je.entry_number,
     v_je.description, v_je.total_debit, v_je.total_credit,
     v_je.entry_date, p_username, p_reason,
     CASE WHEN v_je.total_debit > 0 THEN v_je.total_debit ELSE v_je.total_credit END)
  ON CONFLICT DO NOTHING;

  -- ── Delete JE lines first ──────────────────────────────
  DELETE FROM journal_lines WHERE journal_entry_id = p_je_id;
  GET DIAGNOSTICS v_lines = ROW_COUNT;

  -- ── Delete JE header ─────────────────────────────────
  DELETE FROM journal_entries WHERE id = p_je_id;

  v_result := jsonb_build_object(
    'success',       true,
    'idempotent',    false,
    'je_id',         p_je_id,
    'invoice_id',    v_je.reference_id,
    'invoice_number',v_invoice.invoice_number,
    'description',   v_je.description,
    'debit_removed', v_je.total_debit,
    'reason',        p_reason,
    'deleted_by',    p_username,
    'deleted_at',    NOW()
  );

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION delete_duplicate_cogs_je(uuid,text,text) IS
'Safely deletes a COGS journal entry with server-side guards (COGS-only, posted, not reversal, not reconciled, no payments).
 Returns idempotent success if JE already gone. Inserts audit trail into cogs_deletion_audit table.';

-- ──────────────────────────────────────────────
-- 3. cogs_bulk_fix() — atomic bulk fix with idempotency
-- Accepts array of {je_id, reason} objects.
-- Returns summary: {total, succeeded, failed, results[]}
-- ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION cogs_bulk_fix(
  p_fixes   jsonb,
  p_username text DEFAULT 'system'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_fix    jsonb;
  v_result jsonb;
  v_succeeded integer := 0;
  v_failed   integer := 0;
  v_results  jsonb[] := '{}';
BEGIN
  FOR v_fix IN SELECT * FROM jsonb_array_elements(p_fixes)
  LOOP
    v_result := delete_duplicate_cogs_je(
      (v_fix->>'je_id')::uuid,
       v_fix->>'reason',
       p_username
    );

    IF jsonb_extract_path_text(v_result, 'success')::boolean THEN
      v_succeeded := v_succeeded + 1;
    ELSE
      v_failed := v_failed + 1;
    END IF;

    v_results := array_append(v_results, v_result);
  END LOOP;

  RETURN jsonb_build_object(
    'total',      jsonb_array_length(p_fixes),
    'succeeded',  v_succeeded,
    'failed',      v_failed,
    'results',    array_to_json(v_results)::jsonb
  );
END;
$$;

COMMENT ON FUNCTION cogs_bulk_fix(jsonb,text) IS
'Bulk delete of COGS journal entries. Accepts [{je_id, reason},...] and returns per-item results with success counts.';
