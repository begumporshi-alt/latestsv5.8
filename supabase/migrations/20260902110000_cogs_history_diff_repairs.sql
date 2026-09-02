-- Repair RPCs for the COGS-vs-cost-history mismatch view (COGS Audit
-- "History Δ" tab, linked from the sales page's Total Cost (History) card).
--
-- Mismatch patterns this repairs (2026-09-02 audit, all-time gap ৳60,747.49):
--   * Stale cost_price_history after invoice edits (e.g. POS-00589750: JE
--     correctly reposted at items 163,444.09 on 2026-09-01, history still at
--     the pre-edit snapshot 87,100.65) → refresh_cost_price_history_from_items
--   * Journal COGS posted at the wrong amount (e.g. POS-00589859: JE ৳1.00 vs
--     items ৳18,240) → repair_invoice_cogs_to_items (delete ^COGS JEs via the
--     audited deleter, repost one lump at items × cost_price dated at
--     invoice_date — the established repair convention)
--
-- Also fixes latent bug in post_cogs_for_invoice: it passed 'account_code' in
-- journal lines, which post_journal_entry does not resolve (it only reads
-- account_id) — any call would have posted lines with NULL accounts.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) Refresh an invoice's cost_price_history rows from its CURRENT items
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cost_price_history_repair_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL,
  invoice_number text,
  action text NOT NULL,
  reason text NOT NULL,
  username text NOT NULL DEFAULT 'admin',
  old_rows integer,
  old_total numeric,
  new_rows integer,
  new_total numeric,
  snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION refresh_cost_price_history_from_items(
  p_invoice_id uuid,
  p_reason text,
  p_username text DEFAULT 'admin'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_invoice invoices%ROWTYPE;
  v_items_total numeric;
  v_old_total numeric;
  v_new_total numeric;
  v_deleted integer;
  v_inserted integer;
  v_audit_id uuid;
BEGIN
  IF COALESCE(TRIM(p_reason), '') = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Reason is required');
  END IF;

  SELECT * INTO v_invoice FROM invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invoice not found');
  END IF;

  SELECT COALESCE(SUM(quantity * cost_price), 0) INTO v_items_total
    FROM invoice_items WHERE invoice_id = p_invoice_id AND quantity > 0;
  SELECT COALESCE(SUM(cost_price_for_added_qty), 0) INTO v_old_total
    FROM cost_price_history WHERE invoice_id = p_invoice_id;

  -- Idempotency: history already equals current items — nothing to do
  IF ABS(v_old_total - v_items_total) <= 0.01 THEN
    RETURN jsonb_build_object('success', true, 'idempotent', true,
      'old_total', ROUND(v_old_total, 2), 'new_total', ROUND(v_items_total, 2));
  END IF;

  INSERT INTO cost_price_history_repair_audit
    (invoice_id, invoice_number, action, reason, username, old_rows, old_total, snapshot)
  SELECT p_invoice_id, v_invoice.invoice_number, 'refresh_from_items', p_reason, p_username,
         COUNT(*), ROUND(v_old_total, 2),
         COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.created_at), '[]'::jsonb)
  FROM cost_price_history c WHERE c.invoice_id = p_invoice_id
  RETURNING id INTO v_audit_id;

  DELETE FROM cost_price_history WHERE invoice_id = p_invoice_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  -- Same column conventions as the sale-time snapshot (sales/POS pages)
  INSERT INTO cost_price_history (
    product_id, product_name, product_sku, invoice_id, unit, quantity,
    unit_price, cost_price_per_qty, cost_price_for_added_qty,
    total_cost_price_single, total_cost_price_added
  )
  SELECT
    ii.product_id, p.name, COALESCE(p.sku, ''), ii.invoice_id,
    COALESCE(ii.unit_name, p.unit, 'pcs'), ii.quantity, ii.unit_price,
    ii.cost_price, ii.cost_price * ii.quantity,
    ii.cost_price, ii.cost_price * ii.quantity
  FROM invoice_items ii
  JOIN products p ON p.id = ii.product_id
  WHERE ii.invoice_id = p_invoice_id AND ii.quantity > 0;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  SELECT COALESCE(SUM(cost_price_for_added_qty), 0) INTO v_new_total
    FROM cost_price_history WHERE invoice_id = p_invoice_id;

  UPDATE cost_price_history_repair_audit
     SET new_rows = v_inserted, new_total = ROUND(v_new_total, 2)
   WHERE id = v_audit_id;

  -- Post-condition: history now equals current items
  IF ABS(v_new_total - v_items_total) > 0.01 THEN
    RAISE EXCEPTION 'refresh_cost_price_history: post-condition failed (% vs %)', v_new_total, v_items_total;
  END IF;

  RETURN jsonb_build_object('success', true, 'idempotent', false,
    'deleted_rows', v_deleted, 'inserted_rows', v_inserted,
    'old_total', ROUND(v_old_total, 2), 'new_total', ROUND(v_new_total, 2));
END
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Repost an invoice's COGS journal at its CURRENT items × cost_price
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION repair_invoice_cogs_to_items(
  p_invoice_id uuid,
  p_reason text,
  p_username text DEFAULT 'admin'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_invoice invoices%ROWTYPE;
  v_je record;
  v_res jsonb;
  v_deleted integer := 0;
  v_failed integer := 0;
  v_cogs_total numeric;
  v_account_5000 uuid;
  v_account_1200 uuid;
  v_je_id uuid;
BEGIN
  IF COALESCE(TRIM(p_reason), '') = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Reason is required');
  END IF;

  SELECT * INTO v_invoice FROM invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invoice not found');
  END IF;
  IF v_invoice.status = 'cancelled' OR v_invoice.status = 'draft' THEN
    RETURN jsonb_build_object('success', false,
      'error', 'Refusing to post COGS for a ' || v_invoice.status || ' invoice');
  END IF;

  SELECT COALESCE(SUM(quantity * cost_price), 0) INTO v_cogs_total
    FROM invoice_items WHERE invoice_id = p_invoice_id AND cost_price > 0;

  -- Delete every posted ^COGS JE (postings + edit reposts) through the
  -- audited, balance-reversing deleter. Cancel reversals stay (the deleter
  -- itself refuses reversals of active invoices).
  FOR v_je IN
    SELECT id FROM journal_entries
     WHERE reference_type IN ('invoice', 'invoice_edit')
       AND reference_id = p_invoice_id
       AND description ILIKE 'COGS%'
       AND is_posted = true
     ORDER BY entry_date, id
  LOOP
    v_res := delete_duplicate_cogs_je(v_je.id, p_reason, p_username);
    IF COALESCE((v_res->>'success')::boolean, false) THEN
      v_deleted := v_deleted + 1;
    ELSE
      v_failed := v_failed + 1;
    END IF;
  END LOOP;

  IF v_failed > 0 THEN
    RETURN jsonb_build_object('success', false,
      'error', v_failed || ' COGS journal entrie(s) could not be deleted — nothing reposted',
      'deleted_jes', v_deleted);
  END IF;

  -- Repost one lump at items × cost_price, dated at the invoice date
  IF v_cogs_total > 0 THEN
    SELECT id INTO v_account_5000 FROM accounts WHERE code = '5000' LIMIT 1;
    SELECT id INTO v_account_1200 FROM accounts WHERE code = '1200' LIMIT 1;
    IF v_account_5000 IS NULL OR v_account_1200 IS NULL THEN
      RAISE EXCEPTION 'repair_invoice_cogs_to_items: accounts 5000/1200 not found';
    END IF;

    SELECT post_journal_entry(
      p_description := 'COGS - ' || v_invoice.invoice_number ||
                       ' (' || (SELECT COUNT(*) FROM invoice_items WHERE invoice_id = p_invoice_id) ||
                       ' items, total: ' || ROUND(v_cogs_total, 2) || ')',
      p_entry_date := COALESCE(v_invoice.invoice_date, CURRENT_DATE),
      p_reference_type := 'invoice',
      p_reference_id := p_invoice_id,
      p_lines := json_build_array(
        json_build_object('account_id', v_account_5000, 'debit', ROUND(v_cogs_total, 2), 'credit', 0,
                          'description', 'COGS (FIFO) — repaired to items × cost'),
        json_build_object('account_id', v_account_1200, 'debit', 0, 'credit', ROUND(v_cogs_total, 2),
                          'description', 'Inventory released (FIFO) — repaired to items × cost')
      )
    ) INTO v_je_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'deleted_jes', v_deleted,
    'reposted_total', ROUND(v_cogs_total, 2), 'journal_entry_id', v_je_id);
END
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) Fix post_cogs_for_invoice's account_code bug (post_journal_entry only
--    resolves account_id; account_code lines would post NULL accounts)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION post_cogs_for_invoice(p_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant_id uuid;
  v_cogs_total decimal(15,2);
  v_invoice_number text;
  v_invoice_date date;
  v_account_5000 uuid;
  v_account_1200 uuid;
BEGIN
  SELECT tenant_id, invoice_number, invoice_date
    INTO v_tenant_id, v_invoice_number, v_invoice_date
    FROM invoices WHERE id = p_invoice_id;

  IF v_tenant_id IS NULL THEN RETURN; END IF;

  IF EXISTS (
    SELECT 1 FROM journal_entries
    WHERE reference_type = 'invoice'
      AND reference_id = p_invoice_id
      AND description LIKE 'COGS%'
  ) THEN
    RETURN;
  END IF;

  -- Use ii.cost_price (per-sale-unit cost) × ii.quantity (sale-unit qty)
  -- This is correct for both single-unit and multi-unit products
  SELECT COALESCE(SUM(ii.quantity * ii.cost_price), 0) INTO v_cogs_total
    FROM invoice_items ii
   WHERE ii.invoice_id = p_invoice_id
     AND ii.cost_price > 0;

  IF v_cogs_total > 0 THEN
    SELECT id INTO v_account_5000 FROM accounts WHERE code = '5000' AND tenant_id = v_tenant_id LIMIT 1;
    SELECT id INTO v_account_1200 FROM accounts WHERE code = '1200' AND tenant_id = v_tenant_id LIMIT 1;
    IF v_account_5000 IS NULL OR v_account_1200 IS NULL THEN RETURN; END IF;

    PERFORM post_journal_entry(
      p_description := 'COGS - Invoice #' || v_invoice_number,
      p_lines := json_build_array(
        json_build_object('account_id', v_account_5000, 'debit', v_cogs_total, 'credit', 0, 'description', 'Cost of Goods Sold'),
        json_build_object('account_id', v_account_1200, 'debit', 0, 'credit', v_cogs_total, 'description', 'Inventory reduced')
      ),
      p_entry_date := COALESCE(v_invoice_date, CURRENT_DATE),
      p_reference_type := 'invoice',
      p_reference_id := p_invoice_id
    );
  END IF;
END
$function$;

COMMIT;
