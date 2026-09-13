-- Quick Sell offline sync: the POS/sales Quick Sell modal queues a
-- 'quick_sell.create' outbox op when offline. The handler is a thin wrapper
-- around quick_sell_create (20260914110000) — same atomic body, same
-- idempotency_key semantics. The dispatcher gains one branch; intent-level
-- idempotency (sync_intent_keys) is already handled generically from the
-- payload's idempotency_key, which quick_sell_create also enforces on
-- invoices.idempotency_key — double protection against double-charge retries.

BEGIN;

create or replace function public.sync_quick_sell_create(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.quick_sell_create(p_payload);
end;
$$;

-- Dispatcher: full re-create of the live (20260911150000) version + the
-- quick_sell.create branch.
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

revoke all on function public.sync_quick_sell_create(jsonb) from public, anon, authenticated;

DO $$
BEGIN
  RAISE NOTICE 'quick_sell_offline_sync: applied — quick_sell.create op dispatches to quick_sell_create';
END $$;

COMMIT;
