-- Store credit → cash refund: settle a customer's store-credit balance by
-- paying them out in cash/bank/bKash instead of waiting for a POS redemption.
--
-- Accounting: the liability was credited to 2200 (Customer Refund Payable)
-- when the credit was issued (sales-return refund or manual issue). Cashing
-- out relieves it: Dr 2200 / Cr the chosen cash/bank asset account, posted
-- through the canonical post_journal_entry (maintains accounts.balance).
-- The balance/status side is handled by inserting a store_credit_redemptions
-- row — trg_update_credit_balance already decrements balance and flips
-- status to 'redeemed' at zero.
--
-- reference_type 'store_credit_cash_out' with reference_id = the CREDIT id
-- (same document the issue JE points at, so the journal page can resolve
-- SC-numbers through DOC_SOURCES).
--
-- Ships as: (1) online RPC cash_out_store_credit, (2) offline wrapper
-- sync_store_credit_cash_out, (3) full re-create of the live sync_apply
-- dispatcher + the store_credit.cash_out branch.

BEGIN;

-- 1. Core RPC — atomic: lock, validate, redeem, journal.
create or replace function public.cash_out_store_credit(
  p_credit_id uuid,
  p_amount numeric,
  p_payment_account_id uuid,
  p_notes text default null,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_credit customer_store_credits%rowtype;
  v_pay_account accounts%rowtype;
  v_acc_2200 uuid;
  v_redemption_id uuid;
  v_je_id uuid;
  v_entry_number text;
  v_new_balance numeric;
  v_notes text;
begin
  select * into v_credit from customer_store_credits
    where id = p_credit_id for update;
  if not found then
    raise exception 'cash_out_store_credit: store credit not found';
  end if;

  if v_credit.status <> 'active' then
    raise exception 'cash_out_store_credit: credit % is % — only active credits can be refunded in cash',
      v_credit.credit_number, v_credit.status;
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'cash_out_store_credit: amount must be greater than 0';
  end if;

  if p_amount > v_credit.balance then
    raise exception 'cash_out_store_credit: amount % exceeds the remaining balance %',
      p_amount, v_credit.balance;
  end if;

  -- Offline sync passes the updated_at the device last saw; a mismatch means
  -- the credit changed server-side since (same guard as store_credit.expire).
  if p_expected_updated_at is not null
     and v_credit.updated_at <> p_expected_updated_at then
    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'Store credit changed on the server since this device last saw it',
      'server_row', to_jsonb(v_credit));
  end if;

  select * into v_pay_account from accounts where id = p_payment_account_id;
  if not found then
    raise exception 'cash_out_store_credit: payment account not found';
  end if;
  if v_pay_account.account_type <> 'asset' or not v_pay_account.is_active then
    raise exception 'cash_out_store_credit: % (%) is not an active cash/bank account',
      v_pay_account.name, v_pay_account.code;
  end if;

  select id into v_acc_2200 from accounts where code = '2200' limit 1;
  if v_acc_2200 is null then
    raise exception 'cash_out_store_credit: Customer Refund Payable account (2200) not found';
  end if;

  v_notes := nullif(trim(coalesce(p_notes, '') || case when coalesce(p_notes, '') <> '' then ' — ' end
    || 'Cash refund via ' || v_pay_account.code || ' ' || v_pay_account.name), '');

  -- Redemption row: trg_update_credit_balance decrements balance and flips
  -- status to 'redeemed' when it reaches zero.
  insert into store_credit_redemptions (store_credit_id, customer_id, invoice_id, amount, notes)
  values (v_credit.id, v_credit.customer_id, null, p_amount, v_notes)
  returning id into v_redemption_id;

  -- Settle the liability: Dr 2200 / Cr the account the money left.
  select public.post_journal_entry(
    'Store credit cash refund ' || v_credit.credit_number || ' — via ' || v_pay_account.name,
    current_date,
    'store_credit_cash_out',
    v_credit.id,
    json_build_array(
      json_build_object('account_id', v_acc_2200, 'debit', p_amount, 'credit', 0,
        'description', 'Store credit settled in cash — ' || v_credit.credit_number),
      json_build_object('account_id', p_payment_account_id, 'debit', 0, 'credit', p_amount,
        'description', 'Cash refund to customer — ' || v_credit.credit_number)
    )::json,
    v_credit.customer_id
  ) into v_je_id;

  select entry_number into v_entry_number from journal_entries where id = v_je_id;
  select balance into v_new_balance from customer_store_credits where id = v_credit.id;

  return jsonb_build_object(
    'status', 'synced',
    'credit_id', v_credit.id,
    'credit_number', v_credit.credit_number,
    'redemption_id', v_redemption_id,
    'journal_entry_id', v_je_id,
    'entry_number', v_entry_number,
    'new_balance', v_new_balance);
end;
$$;

-- 2. Offline wrapper — same pattern as sync_transfer_create.
create or replace function public.sync_store_credit_cash_out(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res jsonb;
begin
  v_res := public.cash_out_store_credit(
    (p_payload->>'credit_id')::uuid,
    (p_payload->>'amount')::numeric,
    (p_payload->>'payment_account_id')::uuid,
    nullif(p_payload->>'notes', ''),
    nullif(p_payload->>'expected_updated_at', '')::timestamptz
  );
  return v_res;
end;
$$;

-- 3. Dispatcher: full re-create of the live (20260914130000) version + the
--    store_credit.cash_out branch.
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
  elsif p_op = 'store_credit.cash_out' then
    v_result := public.sync_store_credit_cash_out(p_payload);
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

revoke all on function public.sync_store_credit_cash_out(jsonb) from public, anon, authenticated;
grant execute on function public.cash_out_store_credit(uuid, numeric, uuid, text, timestamptz) to authenticated;

DO $$
BEGIN
  RAISE NOTICE 'store_credit_cash_out: applied — cash_out_store_credit RPC + store_credit.cash_out offline op';
END $$;

COMMIT;
