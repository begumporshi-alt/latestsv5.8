-- Optimize get_cogs_audit() performance: the 20260831160000 version runs a
-- reversal-lookup loop and a net-GL-5000 query for EVERY invoice, pushing the
-- RPC to ~8.9s — over the 8s statement_timeout of the `authenticated` role,
-- so the COGS Audit page failed with "canceling statement due to statement
-- timeout".
--
--   1. Gate the reversal loop + net GL query to cancelled invoices only
--      (active invoices never read those values). The net query is moved
--      into the cancelled branch so it runs only for cancelled invoices
--      that actually have COGS JEs or reversals.
--   2. Add missing indexes used by every per-invoice lookup:
--      journal_entries(reference_id, reference_type) and
--      journal_lines(journal_entry_id, account_id).
--
-- No behavior change: statuses/outputs are identical to 20260831160000.

-- ─────────────────────────────────────────────────────────────
-- Indexes (used by per-invoice JE lookups inside the RPC and by
-- delete_duplicate_cogs_je / period reports)
-- ─────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_journal_entries_reference
  ON journal_entries (reference_id, reference_type);

CREATE INDEX IF NOT EXISTS idx_journal_lines_entry_account
  ON journal_lines (journal_entry_id, account_id);

-- ─────────────────────────────────────────────────────────────
-- get_cogs_audit(): same output, cancellation-aware query plan
-- ─────────────────────────────────────────────────────────────
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
  expected_cogs_a           numeric,
  expected_cogs_b           numeric,
  journal_cogs_c            numeric,
  journal_je_count          integer,
  fifo_cogs_d               numeric,
  cogs_journal_entries      jsonb,
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
  per_item_je_ids           uuid[],
  lump_je_ids               uuid[],
  fifo_consumptions         jsonb,
  item_fifo_totals          jsonb,
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
  v_cogs_jes         jsonb := '[]'::jsonb;
  v_fifo_conset      jsonb := '[]'::jsonb;
  v_item_fifo_ttls   jsonb := '[]'::jsonb;
  v_root_cause       text := NULL;
  v_per_item_total   numeric := 0;
  v_lump_total       numeric := 0;
  v_is_cancelled     boolean := false;
  v_reversal_count   integer := 0;
  v_reversal_total   numeric := 0;
  v_net_gl5000       numeric := 0;
BEGIN
  FOR v_invoice IN
    SELECT i.id, i.invoice_number, i.invoice_date, i.status,
           i.total_amount, i.customer_id, i.warehouse_id,
           c.name AS customer_name, w.name AS warehouse_name
    FROM   invoices i
    LEFT   JOIN customers c ON c.id = i.customer_id
    LEFT   JOIN warehouses w ON w.id = i.warehouse_id
    WHERE  i.status != 'draft'
    ORDER  BY i.invoice_date ASC, i.invoice_number ASC
  LOOP
    v_is_cancelled := (v_invoice.status = 'cancelled');

    -- ── Source A: SUM(items.quantity * cost_price) ──────────
    SELECT COALESCE(SUM(quantity * cost_price), 0), COUNT(*)
    INTO   v_expected_a, v_item_cnt
    FROM   invoice_items
    WHERE  invoice_id = v_invoice.id AND quantity > 0;

    -- Cancelled invoices have zero expected COGS
    IF v_is_cancelled THEN
      v_expected_a := 0;
    END IF;

    -- ── Source B: cost_price_history ────────────────────────
    SELECT COALESCE(SUM(quantity * cost_price_per_qty), 0)
    INTO   v_expected_b
    FROM   cost_price_history
    WHERE  invoice_id = v_invoice.id;
    IF v_is_cancelled THEN v_expected_b := 0; END IF;

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
    v_reversal_count := 0;
    v_reversal_total := 0;
    v_net_gl5000 := 0;

    FOR v_je IN
      SELECT je.id, je.entry_date, je.description, je.total_debit,
             je.reference_type, je.reference_id, je.is_posted,
             je.entry_number
      FROM   journal_entries je
      WHERE  je.reference_type IN ('invoice', 'invoice_edit')
        AND  je.reference_id   = v_invoice.id
        AND  je.description ~* '^COGS'
        AND  je.is_posted = true
      ORDER  BY je.entry_date ASC, je.id ASC
    LOOP
      v_je_count := v_je_count + 1;
      v_journal_cogs := v_journal_cogs + v_je.total_debit;

      BEGIN
        v_is_per_item := (v_je.description ~ ' - .+ - Item ');
        v_has_per_item := v_has_per_item OR v_is_per_item;
        v_has_lump := v_has_lump OR NOT v_is_per_item;

        IF v_is_per_item THEN
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

    -- Cancel reversals (invoice_cancel): include them in the JE list so the
    -- fix flow removes originals AND reversals together (GL-neutral cleanup).
    -- Only cancelled invoices can have cancel reversals — skip the lookup
    -- for active invoices (perf: this runs once per invoice).
    IF v_is_cancelled THEN
      FOR v_je IN
        SELECT je.id, je.entry_date, je.description, je.total_debit,
               je.reference_type, je.reference_id, je.is_posted,
               je.entry_number
        FROM   journal_entries je
        WHERE  je.reference_type = 'invoice_cancel'
          AND  je.reference_id   = v_invoice.id
          AND  je.description ~* '^Reverse COGS'
          AND  je.is_posted = true
        ORDER  BY je.entry_date ASC, je.id ASC
      LOOP
        v_reversal_count := v_reversal_count + 1;
        v_reversal_total := v_reversal_total + v_je.total_debit;
        v_cogs_jes := v_cogs_jes || jsonb_build_array(jsonb_build_object(
          'id',            v_je.id,
          'entry_number',  v_je.entry_number,
          'entry_date',    v_je.entry_date,
          'description',   v_je.description,
          'total_debit',   v_je.total_debit,
          'is_per_item',   false,
          'is_reversal',   true,
          'diff_from_expected', 0
        ));
      END LOOP;
    END IF;

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
                    THEN 'EXACT' ELSE 'DRIFT' END AS fifo_vs_cost
        FROM   invoice_items ii2
        JOIN   products p2 ON p2.id = ii2.product_id
        LEFT   JOIN invoice_item_batch_consumption iibc ON iibc.invoice_item_id = ii2.id
        WHERE  ii2.invoice_id = v_invoice.id
        GROUP  BY ii2.id, p2.name, p2.sku, ii2.quantity, ii2.cost_price
        ORDER  BY ii2.id
      ) t
    );

    -- ── Auto-detect keeper JE ──────────────────────────────
    v_keeper_je_id   := NULL;
    v_keeper_total   := 0;
    v_keeper_diff    := 999999999;
    v_balance_impact := 0;

    IF v_je_count = 0 AND v_reversal_count = 0 THEN
      IF v_is_cancelled THEN
        -- Cancelled with no COGS JEs = clean
        v_audit_status := 'CONSISTENT';
        v_issue_type   := 'EXACT';
        v_fix_action   := 'NONE';
        v_root_cause   := NULL;
      ELSE
        v_audit_status := 'MISSING';
        v_issue_type   := 'MISSING';
        v_fix_action   := 'CREATE_JE';
        v_root_cause   := 'NO_COGS_JE';
      END IF;

    ELSIF v_is_cancelled THEN
      -- ── Cancelled invoice with COGS postings/reversals ──
      -- Correct end state: net GL 5000 impact of zero. Flag only when the
      -- postings and reversals do NOT cancel out (true orphan amount).
      -- Net GL 5000 impact across ALL COGS postings + reversals
      -- (perf: computed here, only for cancelled invoices that have any).
      SELECT COALESCE(SUM(jl.debit - jl.credit), 0)
      INTO   v_net_gl5000
      FROM   journal_lines jl
      JOIN   journal_entries je ON je.id = jl.journal_entry_id
      JOIN   accounts a ON a.id = jl.account_id
      WHERE  je.reference_type IN ('invoice', 'invoice_edit', 'invoice_cancel')
        AND  je.reference_id   = v_invoice.id
        AND  (je.description ~* '^COGS' OR je.description ~* '^Reverse COGS')
        AND  je.is_posted = true
        AND  a.code = '5000';

      IF ABS(v_net_gl5000) > 1.00 THEN
        v_keeper_je_id := NULL;
        v_keeper_total := 0;
        v_keeper_diff  := 0;
        v_audit_status := 'CANCELLED_ORPHAN';
        v_issue_type   := 'CANCELLED_ORPHAN';
        v_fix_action   := 'DELETE_ALL_COGS';
        v_root_cause   := CASE
                            WHEN v_net_gl5000 > 0 THEN 'CANCELLED_NOT_FULLY_REVERSED'
                            ELSE 'CANCELLED_STRAY_REVERSAL'
                          END;
        v_balance_impact := v_net_gl5000;  -- signed orphan net on GL 5000
      ELSE
        v_audit_status := 'CONSISTENT';
        v_issue_type   := 'EXACT';
        v_fix_action   := 'NONE';
        v_root_cause   := 'CANCELLED_FULLY_REVERSED';
      END IF;

    ELSIF v_je_count >= 1 THEN
      FOR v_je IN
        SELECT je.id, je.total_debit,
               ABS(je.total_debit - v_expected_a) AS diff
        FROM   journal_entries je
        WHERE  je.reference_type IN ('invoice', 'invoice_edit')
          AND  je.reference_id   = v_invoice.id
          AND  je.description ~* '^COGS'
          AND  je.is_posted = true
        ORDER  BY ABS(je.total_debit - v_expected_a) ASC, je.entry_date ASC
      LOOP
        IF v_keeper_je_id IS NULL THEN
          v_keeper_je_id  := v_je.id;
          v_keeper_total  := v_je.total_debit;
          v_keeper_diff   := v_je.diff;
        ELSE
          v_balance_impact := v_balance_impact + v_je.total_debit;
        END IF;
      END LOOP;

      IF v_keeper_diff <= 1.00
         OR (v_expected_a > 0 AND v_keeper_diff <= v_expected_a * 0.01 + 10)
         OR (v_expected_a = 0 AND v_keeper_diff = 0) THEN
        IF v_je_count = 1 THEN
          v_audit_status := 'CONSISTENT';
          v_issue_type   := 'EXACT';
          v_fix_action   := 'NONE';
          v_root_cause   := NULL;
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
