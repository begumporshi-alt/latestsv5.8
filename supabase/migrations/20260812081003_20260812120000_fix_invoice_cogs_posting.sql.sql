/*
# Restore COGS posting for invoice items

1. Purpose
- Ensures every non-draft invoice item with a positive cost price creates its COGS and inventory journal lines immediately after insertion.
- Repairs invoices that were already created without COGS journal entries.

2. Modified database objects
- Replaces `invoice_items_cogs_trigger()` with an idempotent per-item implementation.
- Recreates the `trg_invoice_items_cogs` trigger on `invoice_items`.

3. Data repair
- Backfills missing COGS entries for existing sent, partially paid, and paid invoices.
- Recalculates the Cost of Goods Sold and Inventory account balances.

4. Security
- No new tables, columns, permissions, or RLS policies are introduced.
- Journal entries remain created by the database trigger using the existing accounting function.

5. Safety notes
- Existing COGS entries are detected by invoice and product description before posting, preventing duplicates.
- No existing rows or columns are deleted or changed.
*/

CREATE OR REPLACE FUNCTION public.invoice_items_cogs_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_invoice invoices%ROWTYPE;
  v_product products%ROWTYPE;
  v_cogs_account uuid;
  v_inventory_account uuid;
  v_amount numeric;
  v_description text;
BEGIN
  SELECT * INTO v_invoice FROM public.invoices WHERE id = NEW.invoice_id;
  IF NOT FOUND OR v_invoice.status NOT IN ('sent', 'partially_paid', 'paid') THEN RETURN NEW; END IF;

  v_amount := COALESCE(NEW.quantity, 0) * COALESCE(NEW.cost_price, 0);
  IF v_amount <= 0 THEN RETURN NEW; END IF;

  SELECT id INTO v_cogs_account FROM public.accounts WHERE code = '5000' LIMIT 1;
  SELECT id INTO v_inventory_account FROM public.accounts WHERE code = '1200' LIMIT 1;
  IF v_cogs_account IS NULL OR v_inventory_account IS NULL THEN RETURN NEW; END IF;

  SELECT * INTO v_product FROM public.products WHERE id = NEW.product_id;
  v_description := 'COGS - ' || v_invoice.invoice_number || ' - ' || COALESCE(v_product.name, 'Unknown');

  IF EXISTS (
    SELECT 1 FROM public.journal_entries je
    WHERE je.reference_type = 'invoice' AND je.reference_id = NEW.invoice_id AND je.description = v_description
  ) THEN RETURN NEW; END IF;

  PERFORM public.post_journal_entry(
    v_description,
    COALESCE(v_invoice.invoice_date, CURRENT_DATE),
    'invoice',
    NEW.invoice_id,
    json_build_array(
      json_build_object('account_id', v_cogs_account, 'debit', v_amount, 'credit', 0, 'description', 'Cost of ' || COALESCE(v_product.name, 'Unknown') || ' sold'),
      json_build_object('account_id', v_inventory_account, 'debit', 0, 'credit', v_amount, 'description', 'Inventory released for ' || v_invoice.invoice_number)
    )::json,
    v_invoice.customer_id
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_invoice_items_cogs ON public.invoice_items;
CREATE TRIGGER trg_invoice_items_cogs AFTER INSERT ON public.invoice_items FOR EACH ROW EXECUTE FUNCTION public.invoice_items_cogs_trigger();

DO $$
DECLARE
  v_invoice RECORD;
  v_item RECORD;
  v_product RECORD;
  v_cogs_account uuid;
  v_inventory_account uuid;
  v_amount numeric;
  v_description text;
BEGIN
  SELECT id INTO v_cogs_account FROM public.accounts WHERE code = '5000' LIMIT 1;
  SELECT id INTO v_inventory_account FROM public.accounts WHERE code = '1200' LIMIT 1;

  FOR v_invoice IN
    SELECT i.id, i.invoice_number, i.invoice_date, i.customer_id
    FROM public.invoices i
    WHERE i.status IN ('sent', 'partially_paid', 'paid')
      AND EXISTS (SELECT 1 FROM public.invoice_items ii WHERE ii.invoice_id = i.id AND COALESCE(ii.cost_price, 0) > 0)
  LOOP
    FOR v_item IN SELECT ii.* FROM public.invoice_items ii WHERE ii.invoice_id = v_invoice.id ORDER BY ii.sort_order, ii.id LOOP
      v_amount := COALESCE(v_item.quantity, 0) * COALESCE(v_item.cost_price, 0);
      IF v_amount <= 0 THEN CONTINUE; END IF;
      SELECT * INTO v_product FROM public.products WHERE id = v_item.product_id;
      v_description := 'COGS - ' || v_invoice.invoice_number || ' - ' || COALESCE(v_product.name, 'Unknown');
      IF NOT EXISTS (SELECT 1 FROM public.journal_entries je WHERE je.reference_type = 'invoice' AND je.reference_id = v_invoice.id AND je.description = v_description) THEN
        PERFORM public.post_journal_entry(
          v_description, COALESCE(v_invoice.invoice_date, CURRENT_DATE), 'invoice', v_invoice.id,
          json_build_array(
            json_build_object('account_id', v_cogs_account, 'debit', v_amount, 'credit', 0, 'description', 'Cost of ' || COALESCE(v_product.name, 'Unknown') || ' sold'),
            json_build_object('account_id', v_inventory_account, 'debit', 0, 'credit', v_amount, 'description', 'Inventory released for ' || v_invoice.invoice_number)
          )::json,
          v_invoice.customer_id
        );
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

DO $$
DECLARE
  v_account RECORD;
  v_balance numeric;
BEGIN
  FOR v_account IN SELECT id, account_type FROM public.accounts WHERE code IN ('5000', '1200') AND is_active = true LOOP
    SELECT COALESCE(SUM(jl.debit - jl.credit), 0) INTO v_balance FROM public.journal_lines jl WHERE jl.account_id = v_account.id;
    IF v_account.account_type IN ('liability', 'equity', 'revenue') THEN v_balance := -v_balance; END IF;
    UPDATE public.accounts SET balance = v_balance WHERE id = v_account.id;
  END LOOP;
END;
$$;