-- Purchase return accounting trigger
-- Fires AFTER INSERT on purchase_returns when status = 'completed'
-- Posts journal entry: Dr. Accounts Payable / Cr. Inventory Asset
-- Uses post_journal_entry which correctly handles account-type sign conventions

CREATE OR REPLACE FUNCTION purchase_return_accounting_trigger()
RETURNS TRIGGER AS $$
DECLARE
  v_inventory_account uuid;
  v_ap_account uuid;
  v_total_cost numeric;
  v_je_id uuid;
BEGIN
  -- Only fire on completed returns
  IF NEW.status != 'completed' THEN
    RETURN NEW;
  END IF;

  -- Get inventory and AP accounts
  SELECT id INTO v_inventory_account FROM accounts WHERE code = '1200' LIMIT 1;
  SELECT id INTO v_ap_account FROM accounts WHERE code = '2000' LIMIT 1;

  IF v_inventory_account IS NULL OR v_ap_account IS NULL THEN
    RETURN NEW;
  END IF;

  v_total_cost := NEW.total_amount;

  IF v_total_cost <= 0 THEN
    RETURN NEW;
  END IF;

  -- Post journal entry: Dr. AP / Cr. Inventory (reverses the purchase receipt)
  -- post_journal_entry handles account-type sign conventions internally
  v_je_id := post_journal_entry(
    'Purchase Return - ' || COALESCE(NEW.return_number, 'PRET'),
    NEW.return_date,
    'purchase_return',
    NEW.id,
    json_build_array(
      json_build_object('account_id', v_ap_account, 'debit', v_total_cost, 'credit', 0, 'description', 'AP reduced for return - ' || COALESCE(NEW.return_number, 'PRET')),
      json_build_object('account_id', v_inventory_account, 'debit', 0, 'credit', v_total_cost, 'description', 'Inventory returned to supplier - ' || COALESCE(NEW.return_number, 'PRET'))
    )::json,
    NULL,
    NEW.supplier_id
  );

  -- Link the journal entry back to the purchase return
  IF v_je_id IS NOT NULL THEN
    UPDATE purchase_returns SET journal_entry_id = v_je_id WHERE id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing trigger if present, then create
DROP TRIGGER IF EXISTS trg_purchase_return_accounting ON purchase_returns;
CREATE TRIGGER trg_purchase_return_accounting
  AFTER INSERT ON purchase_returns
  FOR EACH ROW
  EXECUTE FUNCTION purchase_return_accounting_trigger();
