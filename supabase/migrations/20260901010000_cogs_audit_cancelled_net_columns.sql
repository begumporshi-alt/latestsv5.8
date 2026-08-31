-- Journal (C) / FIFO (D) columns for CANCELLED invoices now show the net
-- COGS effect instead of gross, matching how Expected (A) and History (B)
-- are already zeroed for cancelled invoices.
--
-- Symptom (reported on 2026-08-31): 25 invoices, all Consistent, but the
-- view totals showed Journal (C) = ৳14,349.60 vs Expected (A) = ৳9,530.50.
-- The ৳4,819.10 gap was the GROSS original COGS postings of 6 fully-reversed
-- cancelled invoices (INV-940646 ৳4,531 + POS-00590114 ৳168.10 +
-- POS-00590121 ৳120) — each nets to zero on GL 5000 after its cancel
-- reversal, but the column summed the pre-reversal postings.
--
-- Changes (only the two column expressions; everything else identical to
-- 20260901000000):
--   * journal_cogs_c for cancelled invoices = net GL 5000 of postings +
--     cancel reversals (0 when fully reversed; the orphan amount when
--     CANCELLED_ORPHAN)
--   * fifo_cogs_d for cancelled invoices = 0 (stock is restored on cancel;
--     currently no cancelled invoice has FIFO consumption anyway)
--
-- Active invoices are unchanged: Journal (C) keeps showing the gross sum of
-- their original COGS postings, which equals the keeper total for
-- consistent rows.

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
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH inv AS (
  SELECT i.id AS inv_id, i.invoice_number, i.invoice_date, i.status AS invoice_status,
         i.total_amount AS invoice_total,
         c.name AS customer_name, w.name AS warehouse_name,
         (i.status = 'cancelled') AS is_cancelled
  FROM invoices i
  LEFT JOIN customers c ON c.id = i.customer_id
  LEFT JOIN warehouses w ON w.id = i.warehouse_id
  WHERE i.status <> 'draft'
),
src_a AS (  -- Source A: items x cost_price (quantity > 0 only)
  SELECT invoice_id, SUM(quantity * cost_price) AS expected_a, COUNT(*) AS item_cnt
  FROM invoice_items
  WHERE quantity > 0
  GROUP BY invoice_id
),
src_b AS (  -- Source B: cost_price_history
  SELECT invoice_id, SUM(quantity * cost_price_per_qty) AS expected_b
  FROM cost_price_history
  GROUP BY invoice_id
),
base AS (
  SELECT inv.*,
         CASE WHEN inv.is_cancelled THEN 0 ELSE COALESCE(a.expected_a, 0) END AS expected_a,
         CASE WHEN inv.is_cancelled THEN 0 ELSE COALESCE(b.expected_b, 0) END AS expected_b,
         COALESCE(a.item_cnt, 0)::integer AS item_count
  FROM inv
  LEFT JOIN src_a a ON a.invoice_id = inv.inv_id
  LEFT JOIN src_b b ON b.invoice_id = inv.inv_id
),
orig AS (  -- original COGS postings (invoice / invoice_edit)
  SELECT je.reference_id AS inv_id, je.id AS je_id, je.entry_number, je.entry_date,
         je.description, je.total_debit,
         (je.description ~ ' - .+ - Item ') AS is_per_item
  FROM journal_entries je
  WHERE je.reference_type IN ('invoice', 'invoice_edit')
    AND je.description ~* '^COGS'
    AND je.is_posted = true
),
orig_agg AS (
  SELECT o.inv_id,
         COUNT(*)::integer AS je_count,
         SUM(o.total_debit) AS journal_cogs,
         COALESCE(bool_or(o.is_per_item), false) AS has_per_item,
         COALESCE(bool_or(NOT o.is_per_item), false) AS has_lump,
         COALESCE(array_agg(o.je_id ORDER BY o.entry_date, o.je_id) FILTER (WHERE o.is_per_item), '{}'::uuid[]) AS per_item_ids,
         COALESCE(array_agg(o.je_id ORDER BY o.entry_date, o.je_id) FILTER (WHERE NOT o.is_per_item), '{}'::uuid[]) AS lump_ids,
         COALESCE(jsonb_agg(jsonb_build_object(
                    'id', o.je_id,
                    'entry_number', o.entry_number,
                    'entry_date', o.entry_date,
                    'description', o.description,
                    'total_debit', o.total_debit,
                    'is_per_item', o.is_per_item,
                    'diff_from_expected', ROUND(o.total_debit - b.expected_a, 2)
                  ) ORDER BY o.entry_date, o.je_id), '[]'::jsonb) AS jes_json
  FROM orig o
  JOIN base b ON b.inv_id = o.inv_id
  GROUP BY o.inv_id
),
keeper AS (  -- keeper JE: lowest |total - expected|, tie-break oldest
  SELECT k.inv_id, k.je_id AS keeper_je_id, k.total_debit AS keeper_total, k.keeper_diff
  FROM (
    SELECT o.inv_id, o.je_id, o.total_debit,
           ABS(o.total_debit - b.expected_a) AS keeper_diff,
           ROW_NUMBER() OVER (PARTITION BY o.inv_id
                              ORDER BY ABS(o.total_debit - b.expected_a) ASC,
                                       o.entry_date ASC, o.je_id ASC) AS rn
    FROM orig o
    JOIN base b ON b.inv_id = o.inv_id
  ) k
  WHERE k.rn = 1
),
rev AS (  -- cancel reversals, only exist for cancelled invoices
  SELECT je.reference_id AS inv_id, je.id AS je_id, je.entry_number, je.entry_date,
         je.description, je.total_debit
  FROM journal_entries je
  JOIN base b ON b.inv_id = je.reference_id AND b.is_cancelled
  WHERE je.reference_type = 'invoice_cancel'
    AND je.description ~* '^Reverse COGS'
    AND je.is_posted = true
),
rev_agg AS (
  SELECT r.inv_id,
         COUNT(*)::integer AS rev_count,
         COALESCE(jsonb_agg(jsonb_build_object(
                    'id', r.je_id,
                    'entry_number', r.entry_number,
                    'entry_date', r.entry_date,
                    'description', r.description,
                    'total_debit', r.total_debit,
                    'is_per_item', false,
                    'is_reversal', true,
                    'diff_from_expected', 0
                  ) ORDER BY r.entry_date, r.je_id), '[]'::jsonb) AS rev_json
  FROM rev r
  GROUP BY r.inv_id
),
net5000 AS (  -- net GL 5000 impact of postings + reversals per invoice
  SELECT je.reference_id AS inv_id, SUM(jl.debit - jl.credit) AS net_gl5000
  FROM journal_lines jl
  JOIN journal_entries je ON je.id = jl.journal_entry_id
  JOIN accounts a ON a.id = jl.account_id
  WHERE je.reference_type IN ('invoice', 'invoice_edit', 'invoice_cancel')
    AND (je.description ~* '^COGS' OR je.description ~* '^Reverse COGS')
    AND je.is_posted = true
    AND a.code = '5000'
  GROUP BY je.reference_id
),
fifo AS (  -- Source D: FIFO batch consumption with per-item batch sequence
  SELECT ii.invoice_id AS inv_id, iic.invoice_item_id,
         iic.id AS consumption_id, iic.batch_id, ib.batch_number,
         p.name AS product_name, p.sku AS product_sku,
         ROW_NUMBER() OVER (PARTITION BY iic.invoice_item_id ORDER BY ib.created_at ASC, iic.id ASC) AS batch_seq,
         iic.quantity_consumed AS consume_qty, iic.unit_cost AS cost_per_unit,
         iic.cogs_amount AS total_cost,
         ii.quantity AS item_qty, ii.cost_price AS item_cost_price
  FROM invoice_item_batch_consumption iic
  JOIN invoice_items ii ON ii.id = iic.invoice_item_id
  JOIN products p ON p.id = ii.product_id
  JOIN inventory_batches ib ON ib.id = iic.batch_id
),
fifo_agg AS (
  SELECT f.inv_id,
         SUM(f.total_cost) AS fifo_cogs,
         COALESCE(jsonb_agg(jsonb_build_object(
                    'consumption_id', f.consumption_id,
                    'invoice_item_id', f.invoice_item_id,
                    'batch_id', f.batch_id,
                    'batch_number', f.batch_number,
                    'product_name', f.product_name,
                    'sku', f.product_sku,
                    'batch_seq', f.batch_seq,
                    'consume_qty', f.consume_qty,
                    'cost_per_unit', f.cost_per_unit,
                    'total_cost', f.total_cost,
                    'item_qty', f.item_qty,
                    'item_cost_price', f.item_cost_price
                  ) ORDER BY f.invoice_item_id, f.batch_seq), '[]'::jsonb) AS fifo_json
  FROM fifo f
  GROUP BY f.inv_id
),
item_fifo AS (  -- per-item FIFO totals (invoice_id kept out of the JSON)
  SELECT t.invoice_id AS inv_id,
         jsonb_agg(jsonb_build_object(
                    'invoice_item_id', t.invoice_item_id,
                    'product_name', t.product_name,
                    'sku', t.sku,
                    'item_qty', t.item_qty,
                    'item_cost_price', t.item_cost_price,
                    'fifo_total', t.fifo_total,
                    'batch_count', t.batch_count,
                    'fifo_vs_cost', t.fifo_vs_cost
                  ) ORDER BY t.invoice_item_id) AS item_json
  FROM (
    SELECT ii2.invoice_id, ii2.id AS invoice_item_id,
           p2.name AS product_name, p2.sku,
           ii2.quantity AS item_qty, ii2.cost_price AS item_cost_price,
           COALESCE(SUM(iibc.cogs_amount), 0) AS fifo_total,
           COUNT(iibc.id) AS batch_count,
           CASE WHEN ABS(COALESCE(SUM(iibc.cogs_amount), 0) - (ii2.quantity * ii2.cost_price)) < 0.01
                THEN 'EXACT' ELSE 'DRIFT' END AS fifo_vs_cost
    FROM invoice_items ii2
    JOIN products p2 ON p2.id = ii2.product_id
    LEFT JOIN invoice_item_batch_consumption iibc ON iibc.invoice_item_id = ii2.id
    GROUP BY ii2.id, ii2.invoice_id, p2.name, p2.sku, ii2.quantity, ii2.cost_price
  ) t
  GROUP BY t.invoice_id
),
calc AS (
  SELECT b.inv_id,
         b.invoice_number, b.invoice_date, b.invoice_status, b.invoice_total,
         b.customer_name, b.warehouse_name, b.item_count, b.is_cancelled,
         b.expected_a, b.expected_b,
         COALESCE(oa.je_count, 0) AS je_cnt,
         COALESCE(ra.rev_count, 0) AS rev_cnt,
         oa.journal_cogs,
         COALESCE(oa.jes_json, '[]'::jsonb) || COALESCE(ra.rev_json, '[]'::jsonb) AS cogs_journal_entries,
         oa.has_per_item, oa.has_lump,
         COALESCE(oa.per_item_ids, '{}'::uuid[]) AS per_item_je_ids,
         COALESCE(oa.lump_ids, '{}'::uuid[]) AS lump_je_ids,
         k.keeper_je_id, k.keeper_total, k.keeper_diff,
         COALESCE(n.net_gl5000, 0) AS net_gl5000,
         fa.fifo_cogs,
         COALESCE(fa.fifo_json, '[]'::jsonb) AS fifo_consumptions,
         ift.item_json AS item_fifo_totals,
         -- status helpers mirroring the previous PL/pgSQL branch logic
         ABS(COALESCE(n.net_gl5000, 0)) > 1.00 AS is_orphan,
         ( NOT b.is_cancelled AND COALESCE(oa.je_count, 0) >= 1
           AND ( COALESCE(k.keeper_diff, 999999999) <= 1.00
                 OR (b.expected_a > 0 AND COALESCE(k.keeper_diff, 999999999) <= b.expected_a * 0.01 + 10)
                 OR (b.expected_a = 0 AND COALESCE(k.keeper_diff, 999999999) = 0) ) ) AS keeper_ok
  FROM base b
  LEFT JOIN orig_agg oa ON oa.inv_id = b.inv_id
  LEFT JOIN rev_agg ra ON ra.inv_id = b.inv_id
  LEFT JOIN keeper k ON k.inv_id = b.inv_id
  LEFT JOIN net5000 n ON n.inv_id = b.inv_id
  LEFT JOIN fifo_agg fa ON fa.inv_id = b.inv_id
  LEFT JOIN item_fifo ift ON ift.inv_id = b.inv_id
)
SELECT
  c.inv_id                                                                 AS aud_invoice_id,
  c.invoice_number, c.invoice_date, c.invoice_status, c.invoice_total,
  c.customer_name, c.warehouse_name, c.item_count,
  ROUND(c.expected_a, 2)                                                   AS expected_cogs_a,
  ROUND(c.expected_b, 2)                                                   AS expected_cogs_b,
  -- Cancelled invoices: net GL 5000 of postings + reversals (0 when fully
  -- reversed, orphan amount when not) — comparable with Expected (A) = 0.
  CASE WHEN c.is_cancelled THEN ROUND(c.net_gl5000, 2)
       ELSE ROUND(COALESCE(c.journal_cogs, 0), 2) END                      AS journal_cogs_c,
  c.je_cnt                                                                 AS journal_je_count,
  -- Cancelled invoices: stock is restored on cancel, so no FIFO COGS sticks.
  CASE WHEN c.is_cancelled THEN 0
       ELSE ROUND(COALESCE(c.fifo_cogs, 0), 2) END                         AS fifo_cogs_d,
  c.cogs_journal_entries,
  CASE WHEN NOT c.is_cancelled AND c.je_cnt >= 1 THEN c.keeper_je_id END    AS keeper_je_id,
  CASE WHEN NOT c.is_cancelled AND c.je_cnt >= 1
       THEN ROUND(c.keeper_total, 2) ELSE 0 END                             AS keeper_je_total,
  CASE
    WHEN c.is_cancelled AND c.is_orphan THEN 0
    WHEN c.is_cancelled THEN 999999999
    WHEN c.je_cnt = 0 THEN 999999999
    ELSE ROUND(c.keeper_diff, 2)
  END                                                                      AS keeper_je_diff,
  0::numeric                                                               AS all_je_diff,
  CASE
    WHEN c.je_cnt = 0 AND c.rev_cnt = 0 THEN CASE WHEN c.is_cancelled THEN 'EXACT' ELSE 'MISSING' END
    WHEN c.is_cancelled THEN CASE WHEN c.is_orphan THEN 'CANCELLED_ORPHAN' ELSE 'EXACT' END
    WHEN c.keeper_ok THEN CASE WHEN c.je_cnt = 1 THEN 'EXACT' ELSE 'DUPLICATE_COGS' END
    ELSE 'MISMATCH'
  END                                                                      AS issue_type,
  CASE
    WHEN c.je_cnt = 0 AND c.rev_cnt = 0 THEN CASE WHEN c.is_cancelled THEN 'NONE' ELSE 'CREATE_JE' END
    WHEN c.is_cancelled THEN CASE WHEN c.is_orphan THEN 'DELETE_ALL_COGS' ELSE 'NONE' END
    WHEN c.keeper_ok THEN CASE WHEN c.je_cnt = 1 THEN 'NONE' ELSE 'DELETE_DUPLICATES' END
    ELSE 'REVIEW_MANUALLY'
  END                                                                      AS fix_action,
  CASE
    WHEN c.is_cancelled AND c.is_orphan THEN ROUND(c.net_gl5000, 2)
    WHEN NOT c.is_cancelled AND c.je_cnt >= 1
      THEN ROUND(COALESCE(c.journal_cogs, 0) - COALESCE(c.keeper_total, 0), 2)
    ELSE 0
  END                                                                      AS balance_impact,
  CASE
    WHEN c.je_cnt = 0 AND c.rev_cnt = 0 THEN CASE WHEN c.is_cancelled THEN 'CONSISTENT' ELSE 'MISSING' END
    WHEN c.is_cancelled THEN CASE WHEN c.is_orphan THEN 'CANCELLED_ORPHAN' ELSE 'CONSISTENT' END
    WHEN c.keeper_ok THEN CASE WHEN c.je_cnt = 1 THEN 'CONSISTENT' ELSE 'DUPLICATE_COGS' END
    ELSE 'MISMATCH'
  END                                                                      AS audit_status,
  COALESCE(c.has_per_item, false)                                          AS has_per_item_je,
  COALESCE(c.has_lump, false)                                              AS has_lump_je,
  c.per_item_je_ids, c.lump_je_ids,
  c.fifo_consumptions, c.item_fifo_totals,
  CASE
    WHEN c.je_cnt = 0 AND c.rev_cnt = 0 THEN CASE WHEN c.is_cancelled THEN NULL ELSE 'NO_COGS_JE' END
    WHEN c.is_cancelled THEN CASE WHEN c.is_orphan
                                    THEN CASE WHEN c.net_gl5000 > 0 THEN 'CANCELLED_NOT_FULLY_REVERSED'
                                              ELSE 'CANCELLED_STRAY_REVERSAL' END
                                    ELSE 'CANCELLED_FULLY_REVERSED' END
    WHEN c.keeper_ok THEN CASE WHEN c.je_cnt = 1 THEN NULL
                               ELSE CASE WHEN COALESCE(c.has_per_item, false) AND COALESCE(c.has_lump, false)
                                         THEN 'DOUBLE_TRIGGER' ELSE 'MULTIPLE_JES' END END
    ELSE 'KEEPER_OUTSIDE_TOLERANCE'
  END                                                                      AS root_cause
FROM calc c
ORDER BY c.invoice_date ASC, c.invoice_number ASC;
$$;

COMMENT ON FUNCTION get_cogs_audit() IS
'Set-based per-invoice COGS audit: 4-source comparison (items / cost_price_history /
journal / FIFO), keeper auto-detection, cancelled-invoice orphan detection (net GL
5000 of postings + reversals). For cancelled invoices all four sources show the net
COGS effect (zero once fully reversed). Fixed-cost query.';
