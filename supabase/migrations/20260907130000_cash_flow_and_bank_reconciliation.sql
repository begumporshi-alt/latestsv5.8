-- Batch 4 of the 2026-09-06 gap audit (P0-4 cash flow statement,
-- P1-6 monthly bank reconciliation).
--
-- get_cash_flow(p_from, p_to): movements on cash/bank accounts (is_cash or
-- is_bank) — per-account open/in/out/close, per-month net, and per
-- reference-type categories showing what drove the cash.
--
-- Bank reconciliation: bank_reconciliation_items records which journal lines
-- on a cash/bank account have been matched against the bank statement
-- (one row per reconciled line, unique). toggle_bank_reconciliation_item
-- marks/unmarks a line. The page derives the month's movements from the
-- ledger and overlays the reconciled flags.

CREATE OR REPLACE FUNCTION public.get_cash_flow(p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS TABLE(section text, label text, label2 text, opening numeric, inflow numeric, outflow numeric, closing numeric)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = 'public'
AS $function$
  WITH lines AS (
    SELECT a.id AS account_id, a.code, a.name, a.is_cash, a.is_bank,
           je.entry_date, je.reference_type, jl.debit, jl.credit
      FROM accounts a
      JOIN journal_lines jl ON jl.account_id = a.id
      JOIN journal_entries je ON je.id = jl.journal_entry_id AND je.is_posted = true
     WHERE (a.is_cash = true OR a.is_bank = true)
  ),
  account_totals AS (
    SELECT account_id, code, name,
           COALESCE(SUM(CASE WHEN p_from IS NULL OR entry_date < p_from THEN debit - credit ELSE 0 END), 0) AS opening,
           COALESCE(SUM(CASE WHEN (p_from IS NULL OR entry_date >= p_from)
                              AND (p_to IS NULL OR entry_date <= p_to)
                             THEN debit ELSE 0 END), 0) AS inflow,
           COALESCE(SUM(CASE WHEN (p_from IS NULL OR entry_date >= p_from)
                              AND (p_to IS NULL OR entry_date <= p_to)
                             THEN credit ELSE 0 END), 0) AS outflow
      FROM lines
     GROUP BY account_id, code, name
  )
  -- per-account summary (only accounts with any movement or balance)
  SELECT 'account', code || ' — ' || name,
         CASE WHEN is_cash THEN 'cash' ELSE 'bank' END,
         opening, inflow, outflow, opening + inflow - outflow
    FROM (
      SELECT l.account_id, l.code, l.name, l.is_cash, t.opening, t.inflow, t.outflow
        FROM account_totals t
        JOIN (SELECT DISTINCT account_id, code, name, is_cash FROM lines) l USING (account_id)
    ) s
   WHERE opening <> 0 OR inflow <> 0 OR outflow <> 0

  UNION ALL
  -- monthly net movement across all cash/bank accounts
  SELECT 'month', to_char(date_trunc('month', entry_date), 'YYYY-MM'),
         NULL::text,
         0,
         COALESCE(SUM(debit), 0),
         COALESCE(SUM(credit), 0),
         COALESCE(SUM(debit - credit), 0)
    FROM lines
   WHERE (p_from IS NULL OR entry_date >= p_from)
     AND (p_to IS NULL OR entry_date <= p_to)
     AND date_trunc('month', entry_date) IS NOT NULL
   GROUP BY 2

  UNION ALL
  -- what drove the cash, by source document type
  SELECT 'category', COALESCE(reference_type, 'manual'),
         CASE reference_type
           WHEN 'invoice' THEN 'Sales (AR)'
           WHEN 'payment' THEN 'Payments'
           WHEN 'purchase_receipt' THEN 'Purchases'
           WHEN 'grn' THEN 'Goods Receipt'
           WHEN 'manual' THEN 'Manual entries'
           WHEN 'sales_return' THEN 'Sales returns'
           WHEN 'purchase_return' THEN 'Purchase returns'
           WHEN 'receivable' THEN 'Manual receivables'
           WHEN 'payable' THEN 'Manual payables'
           WHEN 'opening_balance' THEN 'Opening balances'
           WHEN 'balance_adjustment' THEN 'Balance adjustments'
           WHEN 'stock_adjustment' THEN 'Stock adjustments'
           WHEN 'advance' THEN 'Customer advances'
           ELSE COALESCE(reference_type, 'Other')
         END,
         0,
         COALESCE(SUM(debit), 0),
         COALESCE(SUM(credit), 0),
         COALESCE(SUM(debit - credit), 0)
    FROM lines
   WHERE (p_from IS NULL OR entry_date >= p_from)
     AND (p_to IS NULL OR entry_date <= p_to)
   GROUP BY reference_type
   ORDER BY 1, 2;
$function$;

GRANT EXECUTE ON FUNCTION public.get_cash_flow(date, date) TO authenticated;

-- ── Bank reconciliation ──
CREATE TABLE IF NOT EXISTS bank_reconciliation_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_line_id uuid NOT NULL REFERENCES journal_lines(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id),
  reconciled_at timestamptz NOT NULL DEFAULT now(),
  reconciled_by uuid,
  UNIQUE (journal_line_id)
);

ALTER TABLE bank_reconciliation_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bri_select" ON bank_reconciliation_items;
CREATE POLICY "bri_select" ON bank_reconciliation_items FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "bri_insert" ON bank_reconciliation_items;
CREATE POLICY "bri_insert" ON bank_reconciliation_items FOR INSERT TO authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "bri_delete" ON bank_reconciliation_items;
CREATE POLICY "bri_delete" ON bank_reconciliation_items FOR DELETE TO authenticated USING (true);

CREATE OR REPLACE FUNCTION public.toggle_bank_reconciliation_item(p_journal_line_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_account uuid;
  v_exists uuid;
BEGIN
  SELECT account_id INTO v_account FROM journal_lines WHERE id = p_journal_line_id;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'Journal line % not found', p_journal_line_id;
  END IF;

  SELECT id INTO v_exists FROM bank_reconciliation_items WHERE journal_line_id = p_journal_line_id;
  IF v_exists IS NOT NULL THEN
    DELETE FROM bank_reconciliation_items WHERE id = v_exists;
    RETURN json_build_object('reconciled', false);
  ELSE
    INSERT INTO bank_reconciliation_items (journal_line_id, account_id, reconciled_by)
    VALUES (p_journal_line_id, v_account, auth.uid());
    RETURN json_build_object('reconciled', true);
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.toggle_bank_reconciliation_item(uuid) TO authenticated;
