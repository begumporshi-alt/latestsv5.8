-- 2026-09-03: Inventory Audit page RPCs.
--
-- Backing store for /inventory/audit — the owner-facing page to SEE inventory
-- health (live reconciliation checks, negative-layer detail with per-pair
-- context, account-balance-cache drift, nightly snapshot history) and to ACT
-- (repair the balance cache; purge legacy negative layers once physical counts
-- confirm the stock is really there). Every mutation is audited and runs in a
-- single transaction.
--
-- Purge semantics: removing a negative layer re-states inventory the ledger
-- was carrying as an IOU marker — batch value and GL 1200 both rise by the
-- purged amount via one journal entry (Dr 1200 / Cr 3900, the same equity
-- pairing as the FIFO cutover baseline JE-964716), and the affected
-- inventory_items counters are rebuilt from batch sums so all three records
-- stay tied. Correct when the physical stock is on the shelf; that decision
-- belongs to the owner, on the page, after counting.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) get_negative_inventory_layers() — one row per negative batch layer with
--    the context the purge decision needs (positive stock at the same
--    product+warehouse pair, net, counter). Includes layers with NULL
--    batch_number (unnamed test-era rows the dashboard's count misses);
--    excludes zeroed FIFO-FALLBACK clutter rows.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_negative_inventory_layers()
RETURNS TABLE (
  layer_id uuid,
  batch_number text,
  product_id uuid,
  product_name text,
  product_sku text,
  warehouse text,
  kind text,
  quantity_remaining numeric,
  unit_cost numeric,
  value numeric,
  created_at timestamptz,
  pair_positive_qty numeric,
  pair_positive_value numeric,
  pair_net_qty numeric,
  counter_qty numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH neg AS (
    SELECT b.id, b.batch_number, b.product_id, b.warehouse_id,
           b.quantity_remaining, b.unit_cost,
           b.quantity_remaining * b.unit_cost AS val,
           b.created_at,
           CASE
             WHEN b.batch_number IS NULL THEN 'UNNAMED'
             WHEN b.batch_number ILIKE 'FIFO-SHORTFALL%' THEN 'IOU'
             WHEN b.batch_number ILIKE 'ADJ%' THEN 'ADJ'
             WHEN b.batch_number ILIKE 'REDUCE%' THEN 'REDUCE'
             ELSE 'OTHER'
           END AS kind
    FROM inventory_batches b
    WHERE b.quantity_remaining < 0
      AND (b.batch_number IS NULL OR b.batch_number NOT LIKE 'FIFO-FALLBACK%')
  ),
  pair AS (
    SELECT b.product_id, b.warehouse_id,
           SUM(b.quantity_remaining) AS net_qty,
           SUM(CASE WHEN b.quantity_remaining > 0 THEN b.quantity_remaining ELSE 0 END) AS pos_qty,
           SUM(CASE WHEN b.quantity_remaining > 0 THEN b.quantity_remaining * b.unit_cost ELSE 0 END) AS pos_value
    FROM inventory_batches b
    GROUP BY b.product_id, b.warehouse_id
  ),
  ctr AS (
    SELECT ii.product_id, ii.warehouse_id, SUM(ii.quantity_on_hand) AS counter_qty
    FROM inventory_items ii
    GROUP BY ii.product_id, ii.warehouse_id
  )
  SELECT n.id, n.batch_number, n.product_id, p.name, COALESCE(p.sku, ''), w.name,
         n.kind, n.quantity_remaining, n.unit_cost, n.val, n.created_at,
         pr.pos_qty, pr.pos_value, pr.net_qty, COALESCE(c.counter_qty, 0)
  FROM neg n
  JOIN products p ON p.id = n.product_id
  LEFT JOIN warehouses w ON w.id = n.warehouse_id
  JOIN pair pr ON pr.product_id = n.product_id AND pr.warehouse_id = n.warehouse_id
  LEFT JOIN ctr c ON c.product_id = n.product_id AND c.warehouse_id = n.warehouse_id
  ORDER BY n.val ASC, n.created_at;
$$;

GRANT EXECUTE ON FUNCTION get_negative_inventory_layers() TO authenticated;

-- ---------------------------------------------------------------------------
-- 2) get_account_balance_drift() — accounts whose cached balance no longer
--    matches the natural balance of their journal lines (same sign
--    convention and ৳0.01 threshold as get_inventory_reconciliation's
--    check 4).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_account_balance_drift()
RETURNS TABLE (
  account_id uuid,
  code text,
  name text,
  account_type text,
  cached_balance numeric,
  lines_balance numeric,
  gap numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT a.id, a.code, a.name, a.account_type, a.balance,
         x.lines_balance,
         a.balance - x.lines_balance AS gap
  FROM accounts a
  JOIN (
    SELECT jl.account_id,
           SUM(CASE WHEN a2.account_type IN ('liability', 'equity', 'revenue')
                    THEN COALESCE(jl.credit, 0) - COALESCE(jl.debit, 0)
                    ELSE COALESCE(jl.debit, 0) - COALESCE(jl.credit, 0) END) AS lines_balance
    FROM journal_lines jl
    JOIN accounts a2 ON a2.id = jl.account_id
    GROUP BY jl.account_id
  ) x ON x.account_id = a.id
  WHERE ABS(a.balance - x.lines_balance) > 0.01
  ORDER BY ABS(a.balance - x.lines_balance) DESC;
$$;

GRANT EXECUTE ON FUNCTION get_account_balance_drift() TO authenticated;

-- ---------------------------------------------------------------------------
-- 3) recompute_account_balances(p_username) — the audited balance-cache
--    repair as a callable RPC, so the page can clear any FUTURE drift the
--    same way migration 20260903110000 cleared the ৳545,806.80 residue.
-- ---------------------------------------------------------------------------
ALTER TABLE account_balance_recompute_audit
  ADD COLUMN IF NOT EXISTS done_by text;

CREATE OR REPLACE FUNCTION recompute_account_balances(p_username text DEFAULT 'inventory-audit')
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  r record;
  v_derived numeric;
  v_changed int := 0;
  v_results jsonb := '[]'::jsonb;
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
        (account_id, code, name, old_balance, new_balance, delta, done_by)
      VALUES
        (r.id, r.code, r.name, r.balance, v_derived, v_derived - r.balance, p_username);
      UPDATE accounts SET balance = v_derived WHERE id = r.id;
      v_changed := v_changed + 1;
      v_results := v_results || jsonb_build_object(
        'code', r.code, 'name', r.name, 'old', r.balance, 'new', v_derived,
        'delta', v_derived - r.balance);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'changed', v_changed,
                            'accounts', v_results, 'by', p_username);
END;
$function$;

GRANT EXECUTE ON FUNCTION recompute_account_balances(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4) purge_negative_inventory_layers(p_layer_ids, p_reason, p_username) —
--    the owner's decision tool. Archives each layer's pre-zero state, ZEROES
--    the negative balance, posts ONE lump Dr 1200 / Cr 3900 journal entry for
--    the neutralized value, and rebuilds the affected inventory_items
--    counters from batch sums. Requires a reason for the audit trail.
--
--    Layers are zeroed, NOT deleted: historical sale consumption rows point
--    at many of them (51 of 65 live layers are referenced — the old oversell
--    flow wrote consumption records against the shortfall layers it minted),
--    and a zeroed layer still receives return/cancel restorations correctly
--    while contributing no negative value.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory_layer_purge_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  layer_id uuid NOT NULL,
  batch_number text,
  product_id uuid NOT NULL,
  product_name text,
  warehouse_id uuid,
  warehouse_name text,
  quantity_removed numeric NOT NULL,
  unit_cost numeric NOT NULL,
  value_removed numeric NOT NULL,
  reason text NOT NULL,
  purged_by text NOT NULL,
  journal_entry_number text,
  purged_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE inventory_layer_purge_audit ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE tablename = 'inventory_layer_purge_audit'
                   AND policyname = 'read_layer_purge_audit') THEN
    CREATE POLICY read_layer_purge_audit ON inventory_layer_purge_audit
      FOR SELECT TO authenticated USING (true);
  END IF;
END $$;
GRANT SELECT ON inventory_layer_purge_audit TO authenticated;

CREATE OR REPLACE FUNCTION purge_negative_inventory_layers(
  p_layer_ids uuid[],
  p_reason text,
  p_username text DEFAULT 'inventory-audit'
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  v_bad_ids text;
  v_total numeric := 0;
  v_count int := 0;
  v_entry_id uuid;
  v_entry_number text;
  v_account_1200 uuid;
  v_account_3900 uuid;
  v_pairs int := 0;
BEGIN
  IF p_layer_ids IS NULL OR array_length(p_layer_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'No layers selected');
  END IF;

  IF COALESCE(btrim(p_reason), '') = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'A reason is required (audit log)');
  END IF;

  -- Every id must be an existing negative layer
  SELECT string_agg(x.id::text, ', ') INTO v_bad_ids
  FROM unnest(p_layer_ids) AS x(id)
  WHERE NOT EXISTS (SELECT 1 FROM inventory_batches b
                    WHERE b.id = x.id AND b.quantity_remaining < 0);
  IF v_bad_ids IS NOT NULL THEN
    RETURN jsonb_build_object('success', false,
      'error', 'Not negative inventory layers: ' || v_bad_ids);
  END IF;

  SELECT COALESCE(SUM(ABS(b.quantity_remaining * b.unit_cost)), 0), COUNT(*)
    INTO v_total, v_count
  FROM inventory_batches b
  WHERE b.id = ANY(p_layer_ids);

  SELECT id INTO v_account_1200 FROM accounts WHERE code = '1200' LIMIT 1;
  SELECT id INTO v_account_3900 FROM accounts WHERE code = '3900' LIMIT 1;
  IF v_account_1200 IS NULL OR v_account_3900 IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Accounts 1200 / 3900 not found');
  END IF;

  -- 1) Archive each layer's pre-zero state, then neutralize it (set-based)
  INSERT INTO inventory_layer_purge_audit
    (layer_id, batch_number, product_id, product_name, warehouse_id, warehouse_name,
     quantity_removed, unit_cost, value_removed, reason, purged_by)
  SELECT b.id, b.batch_number, b.product_id, p.name, b.warehouse_id, w.name,
         ABS(b.quantity_remaining), b.unit_cost, ABS(b.quantity_remaining * b.unit_cost),
         p_reason, p_username
  FROM inventory_batches b
  JOIN products p ON p.id = b.product_id
  LEFT JOIN warehouses w ON w.id = b.warehouse_id
  WHERE b.id = ANY(p_layer_ids);

  UPDATE inventory_batches
     SET quantity_remaining = 0,
         notes = RTRIM(COALESCE(notes, '') || CASE WHEN COALESCE(notes, '') = '' THEN '' ELSE ' ' END
                 || 'Negative balance zeroed ' || to_char(CURRENT_DATE, 'YYYY-MM-DD') || ': ' || p_reason)
   WHERE id = ANY(p_layer_ids) AND quantity_remaining < 0;

  -- 2) One lump journal entry: Dr Inventory / Cr Opening Balance Equity
  --    (same pairing as the FIFO cutover baseline JE-964716)
  IF v_total > 0 THEN
    v_entry_id := post_journal_entry(
      'Purge ' || v_count || ' negative inventory layer(s) — ' || p_reason,
      CURRENT_DATE, 'inventory_purge', NULL,
      json_build_array(
        json_build_object('account_id', v_account_1200, 'debit', v_total, 'credit', 0,
          'description', 'Neutralize ' || v_count || ' oversell/reduction IOU layer(s) — ledger restate'),
        json_build_object('account_id', v_account_3900, 'debit', 0, 'credit', v_total,
          'description', 'Equity offset for purged negative layers')
      )::json);
    SELECT entry_number INTO v_entry_number FROM journal_entries WHERE id = v_entry_id;
    UPDATE inventory_layer_purge_audit
       SET journal_entry_number = v_entry_number
     WHERE layer_id = ANY(p_layer_ids);
  END IF;

  -- 3) Rebuild the affected counters from batch sums (no unique constraint on
  --    product+warehouse, so update-then-insert-missing)
  WITH sums AS (
    SELECT b.product_id, b.warehouse_id, COALESCE(SUM(b.quantity_remaining), 0) AS q
    FROM inventory_batches b
    WHERE (b.product_id, b.warehouse_id) IN (
      SELECT a.product_id, a.warehouse_id
      FROM inventory_layer_purge_audit a
      WHERE a.layer_id = ANY(p_layer_ids)
    )
    GROUP BY b.product_id, b.warehouse_id
  )
  UPDATE inventory_items ii
     SET quantity_on_hand = s.q, updated_at = now()
    FROM sums s
   WHERE ii.product_id = s.product_id AND ii.warehouse_id = s.warehouse_id;
  GET DIAGNOSTICS v_pairs = ROW_COUNT;

  WITH sums AS (
    SELECT b.product_id, b.warehouse_id, COALESCE(SUM(b.quantity_remaining), 0) AS q
    FROM inventory_batches b
    WHERE (b.product_id, b.warehouse_id) IN (
      SELECT a.product_id, a.warehouse_id
      FROM inventory_layer_purge_audit a
      WHERE a.layer_id = ANY(p_layer_ids)
    )
    GROUP BY b.product_id, b.warehouse_id
  )
  INSERT INTO inventory_items (tenant_id, product_id, warehouse_id, quantity_on_hand, quantity_reserved, quantity_incoming)
  SELECT '00000000-0000-0000-0000-000000000001', s.product_id, s.warehouse_id, s.q, 0, 0
  FROM sums s
  WHERE NOT EXISTS (SELECT 1 FROM inventory_items ii
                    WHERE ii.product_id = s.product_id AND ii.warehouse_id = s.warehouse_id);

  RETURN jsonb_build_object('success', true, 'purged', v_count,
                            'total_value', v_total, 'je_number', v_entry_number,
                            'counters_updated', v_pairs);
END;
$function$;

GRANT EXECUTE ON FUNCTION purge_negative_inventory_layers(uuid[], text, text) TO authenticated;

COMMIT;
