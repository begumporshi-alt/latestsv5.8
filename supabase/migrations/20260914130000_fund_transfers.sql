-- Fund transfers & withdrawals: withdraw from a bank to cash, deposit cash
-- into a bank, or move money between any two cash/bank accounts (including
-- bKash/Nagad/Card method accounts).
--
-- Before this, the only path was the journal page's bank_deposit /
-- bank_withdrawal client templates: hardcoded to accounts 1001/1002, posted
-- as generic reference_type='manual' JEs, online-only, and invisible to any
-- transfer history. This gives the movement a first-class RPC + a distinct
-- reference_type ('transfer') so the new /accounting/transfers page (and any
-- future reporting) can find them.
--
-- Invariants enforced here:
--   * both ends are active asset accounts flagged is_cash/is_bank
--   * from ≠ to, amount > 0
--   * overdraft blocked: source accounts.balance must cover the amount
--   * posts through the canonical poster post_journal_entry (Dr destination /
--     Cr source — the poster's sign convention updates both asset balances)
--   * offline: sync_transfer_create wraps this RPC so 'transfer.create'
--     outbox items replay identically; intent idempotency comes from the
--     generic sync_intent_keys preamble in sync_apply

BEGIN;

-- 1. The atomic transfer writer.
CREATE OR REPLACE FUNCTION public.record_fund_transfer(
  p_from_account_id uuid,
  p_to_account_id uuid,
  p_amount numeric,
  p_transfer_date date DEFAULT CURRENT_DATE,
  p_notes text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_from record;
  v_to record;
  v_description text;
  v_entry_id uuid;
  v_entry_number text;
  v_from_balance numeric;
  v_to_balance numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Transfer amount must be greater than zero';
  END IF;
  IF p_from_account_id IS NULL OR p_to_account_id IS NULL THEN
    RAISE EXCEPTION 'Source and destination accounts are required';
  END IF;
  IF p_from_account_id = p_to_account_id THEN
    RAISE EXCEPTION 'Source and destination accounts must be different';
  END IF;

  SELECT * INTO v_from FROM accounts WHERE id = p_from_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Source account % not found', p_from_account_id;
  END IF;
  SELECT * INTO v_to FROM accounts WHERE id = p_to_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Destination account % not found', p_to_account_id;
  END IF;

  IF NOT v_from.is_active OR NOT v_to.is_active THEN
    RAISE EXCEPTION 'Both accounts must be active';
  END IF;
  IF v_from.account_type <> 'asset' OR NOT (COALESCE(v_from.is_cash, false) OR COALESCE(v_from.is_bank, false)) THEN
    RAISE EXCEPTION 'Source must be a cash or bank account (% %)', v_from.code, v_from.name;
  END IF;
  IF v_to.account_type <> 'asset' OR NOT (COALESCE(v_to.is_cash, false) OR COALESCE(v_to.is_bank, false)) THEN
    RAISE EXCEPTION 'Destination must be a cash or bank account (% %)', v_to.code, v_to.name;
  END IF;

  -- Overdraft guard (owner decision 2026-09-14): a transfer can never drive
  -- the source account negative. accounts.balance is poster-maintained and
  -- reconcilable via recompute_account_balances if it ever drifts.
  IF COALESCE(v_from.balance, 0) < p_amount THEN
    RAISE EXCEPTION 'Insufficient balance in % %: available %, tried to move %',
      v_from.code, v_from.name, COALESCE(v_from.balance, 0), p_amount;
  END IF;

  IF COALESCE(v_from.is_bank, false) AND COALESCE(v_to.is_cash, false) THEN
    v_description := 'Bank Withdrawal';
  ELSIF COALESCE(v_from.is_cash, false) AND COALESCE(v_to.is_bank, false) THEN
    v_description := 'Bank Deposit';
  ELSE
    v_description := 'Fund Transfer';
  END IF;
  v_description := v_description || ': ' || v_from.code || ' ' || v_from.name
    || ' → ' || v_to.code || ' ' || v_to.name;
  IF NULLIF(TRIM(COALESCE(p_notes, '')), '') IS NOT NULL THEN
    v_description := v_description || ' — ' || TRIM(p_notes);
  END IF;

  v_entry_id := public.post_journal_entry(
    v_description,
    COALESCE(p_transfer_date, CURRENT_DATE),
    'transfer',
    NULL,
    json_build_array(
      json_build_object('account_id', p_to_account_id, 'debit', p_amount, 'credit', 0, 'description', v_description),
      json_build_object('account_id', p_from_account_id, 'debit', 0, 'credit', p_amount, 'description', v_description)
    ),
    NULL,
    NULL
  );

  SELECT entry_number INTO v_entry_number FROM journal_entries WHERE id = v_entry_id;
  SELECT balance INTO v_from_balance FROM accounts WHERE id = p_from_account_id;
  SELECT balance INTO v_to_balance FROM accounts WHERE id = p_to_account_id;

  RETURN json_build_object(
    'id', v_entry_id,
    'entry_number', v_entry_number,
    'from_balance', v_from_balance,
    'to_balance', v_to_balance
  );
END;
$$;

-- 2. Offline handler — thin wrapper, same pattern as sync_supplier_payable_payment.
create or replace function public.sync_transfer_create(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res json;
begin
  v_res := public.record_fund_transfer(
    (p_payload->>'from_account_id')::uuid,
    (p_payload->>'to_account_id')::uuid,
    (p_payload->>'amount')::numeric,
    coalesce(nullif(p_payload->>'date', '')::date, current_date),
    nullif(p_payload->>'notes', '')
  );

  return to_jsonb(v_res) || jsonb_build_object('status', 'synced');
end;
$$;

-- 3. Dispatcher: full re-create of the live (20260914120000) version + the
--    transfer.create branch.
create or replace function public.sync_apply(p_item_id uuid, p_op text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed boolean;
  v_result  jsonb;
  v_intent  text;
  v_intent_claimed boolean := false;
begin
  if auth.uid() is null then
    raise exception 'sync_apply requires an authenticated session';
  end if;

  v_intent := nullif(p_payload->>'idempotency_key', '');
  if v_intent is not null then
    insert into sync_intent_keys (intent_key, user_id, op)
    values (v_intent, auth.uid(), p_op)
    on conflict (intent_key) do nothing
    returning true into v_intent_claimed;

    if not coalesce(v_intent_claimed, false) then
      select result into v_result
      from sync_intent_keys
      where intent_key = v_intent;
      return coalesce(v_result, '{}'::jsonb) || '{"status":"duplicate"}'::jsonb;
    end if;
  end if;

  insert into sync_applied_items (user_id, item_id, op)
  values (auth.uid(), p_item_id, p_op)
  on conflict (user_id, item_id) do nothing
  returning true into v_claimed;

  if not coalesce(v_claimed, false) then
    select result into v_result
    from sync_applied_items
    where user_id = auth.uid() and item_id = p_item_id;
    return coalesce(v_result, '{}'::jsonb) || '{"status":"duplicate"}'::jsonb;
  end if;

  if p_op = 'invoice.create' then
    v_result := public.sync_invoice_create(p_payload);
  elsif p_op = 'payment.create' then
    v_result := public.sync_payment_create(p_payload);
  elsif p_op = 'invoice.status' then
    v_result := public.sync_invoice_status(p_payload);
  elsif p_op = 'invoice.cancel' then
    v_result := public.sync_invoice_cancel(p_payload);
  elsif p_op = 'sales_return.create' then
    v_result := public.sync_sales_return_create(p_payload);
  elsif p_op = 'advance.receive' then
    v_result := public.sync_advance_receive(p_payload);
  elsif p_op = 'advance.apply' then
    v_result := public.sync_advance_apply(p_payload);
  elsif p_op = 'advance.refund' then
    v_result := public.sync_advance_refund(p_payload);
  elsif p_op = 'store_credit.issue' then
    v_result := public.sync_store_credit_issue(p_payload);
  elsif p_op = 'store_credit.expire' then
    v_result := public.sync_store_credit_expire(p_payload);
  elsif p_op = 'expense.create' then
    v_result := public.sync_expense_create(p_payload);
  elsif p_op = 'expense.update' then
    v_result := public.sync_expense_update(p_payload);
  elsif p_op = 'expense.delete' then
    v_result := public.sync_expense_delete(p_payload);
  elsif p_op = 'supplier.create' then
    v_result := public.sync_supplier_create(p_payload);
  elsif p_op = 'supplier.update' then
    v_result := public.sync_supplier_update(p_payload);
  elsif p_op = 'po.create' then
    v_result := public.sync_po_create(p_payload);
  elsif p_op = 'po.update' then
    v_result := public.sync_po_update(p_payload);
  elsif p_op = 'po.status' then
    v_result := public.sync_po_status(p_payload);
  elsif p_op = 'po.cancel' then
    v_result := public.sync_po_cancel(p_payload);
  elsif p_op = 'po.payment' then
    v_result := public.sync_po_payment(p_payload);
  elsif p_op = 'grn.receive' then
    v_result := public.sync_grn_receive(p_payload);
  elsif p_op = 'purchase_return.create' then
    v_result := public.sync_purchase_return_create(p_payload);
  elsif p_op = 'supplier.payable_payment' then
    v_result := public.sync_supplier_payable_payment(p_payload);
  elsif p_op = 'quotation.create' then
    v_result := public.sync_quotation_create(p_payload);
  elsif p_op = 'quotation.update' then
    v_result := public.sync_quotation_update(p_payload);
  elsif p_op = 'quotation.status' then
    v_result := public.sync_quotation_status(p_payload);
  elsif p_op = 'quotation.delete' then
    v_result := public.sync_quotation_delete(p_payload);
  elsif p_op = 'quotation.convert' then
    v_result := public.sync_quotation_convert(p_payload);
  elsif p_op = 'delivery.create' then
    v_result := public.sync_delivery_create(p_payload);
  elsif p_op = 'delivery.update' then
    v_result := public.sync_delivery_update(p_payload);
  elsif p_op = 'delivery.status' then
    v_result := public.sync_delivery_status(p_payload);
  elsif p_op = 'project.create' then
    v_result := public.sync_project_create(p_payload);
  elsif p_op = 'project.update' then
    v_result := public.sync_project_update(p_payload);
  elsif p_op = 'project.delete' then
    v_result := public.sync_project_delete(p_payload);
  elsif p_op = 'warehouse.create' then
    v_result := public.sync_warehouse_create(p_payload);
  elsif p_op = 'warehouse.update' then
    v_result := public.sync_warehouse_update(p_payload);
  elsif p_op = 'stock_transfer.create' then
    v_result := public.sync_stock_transfer_create(p_payload);
  elsif p_op = 'product.status' then
    v_result := public.sync_product_status(p_payload);
  elsif p_op = 'customer_note.create' then
    v_result := public.sync_customer_note_create(p_payload);
  elsif p_op = 'customer_note.delete' then
    v_result := public.sync_customer_note_delete(p_payload);
  elsif p_op = 'product.create' then
    v_result := public.sync_product_create(p_payload);
  elsif p_op = 'product.update' then
    v_result := public.sync_product_update(p_payload);
  elsif p_op = 'customer.create' then
    v_result := public.sync_customer_create(p_payload);
  elsif p_op = 'customer.update' then
    v_result := public.sync_customer_update(p_payload);
  elsif p_op = 'employee.create' then
    v_result := public.sync_employee_create(p_payload);
  elsif p_op = 'employee.update' then
    v_result := public.sync_employee_update(p_payload);
  elsif p_op = 'attendance.mark' then
    v_result := public.sync_attendance_mark(p_payload);
  elsif p_op = 'attendance.details' then
    v_result := public.sync_attendance_details(p_payload);
  elsif p_op = 'quick_sell.create' then
    v_result := public.sync_quick_sell_create(p_payload);
  elsif p_op = 'transfer.create' then
    v_result := public.sync_transfer_create(p_payload);
  else
    raise exception 'Unknown sync op: %', p_op;
  end if;

  if v_result->>'status' = 'conflict' then
    delete from sync_applied_items
    where user_id = auth.uid() and item_id = p_item_id;
    if v_intent_claimed then
      delete from sync_intent_keys where intent_key = v_intent;
    end if;
    return v_result;
  end if;

  update sync_applied_items set result = v_result
  where user_id = auth.uid() and item_id = p_item_id;
  if v_intent_claimed then
    update sync_intent_keys set result = v_result
    where intent_key = v_intent;
  end if;

  return v_result;
end;
$$;

revoke all on function public.sync_transfer_create(jsonb) from public, anon, authenticated;
grant execute on function public.record_fund_transfer(uuid, uuid, numeric, date, text) to authenticated;

DO $$
BEGIN
  RAISE NOTICE 'fund_transfers: applied — record_fund_transfer RPC + transfer.create offline op';
END $$;

COMMIT;
