-- B1 — envelope and clock (plan §28.4, §28.5).
--
-- The replay problem: a synced op gets its timestamps from the server clock
-- at execution time, so replaying the same op on another node (or a month
-- later) writes different rows. This migration adds the envelope and the
-- clock plumbing only; handlers still read now()/CURRENT_DATE and change
-- behaviour in B2/B5.
--
--   * sync_apply grows p_at (timestamptz), p_device_id and p_hlc, all with
--     defaults, so every existing 3-arg caller — the offline engine, the
--     validation wrapper, direct RPCs — keeps working unchanged. The 3-arg
--     signature is dropped; PostgreSQL resolves a 3-arg call through the
--     defaults.
--   * The dispatcher's first statement pins the transaction clock:
--     set_config('sisolution.op_at', coalesce(p_at, now()), true). One RPC is
--     one transaction, so every nested handler and trigger sees it. Online
--     callers that omit p_at get now(), byte for byte today's behaviour.
--   * op_at()/op_date() read that setting and fall back to now()/CURRENT_DATE.
--     Handlers migrate onto them in B2; nothing in this file calls them
--     except sync_apply's own envelope write, which is the proof that the
--     clock reached the transaction.
--   * sync_applied_items records the envelope (op_at, device_id, hlc) next to
--     applied_at, which stays the server's receipt time.
--
-- The cloud clamps p_at to ±5 minutes of receipt before appending the op
-- (§26.1); enforcement lives with the relay, not here. The client starts
-- sending the envelope with the S0/S1 slice together with B3/B4.
--
-- ACL notes: this file follows the offline_sync convention — revoke PUBLIC
-- and anon, grant EXECUTE to authenticated — because production needs that
-- surface. The standby candidate re-applies compatibility/grants.sql after
-- the post-restore migration loop, which strips it again; ownership is
-- pinned to postgres because the function is SECURITY DEFINER and the
-- migrating role differs per target.

begin;

create or replace function public.op_at() returns timestamptz
language sql stable as $$
  select coalesce(nullif(current_setting('sisolution.op_at', true), '')::timestamptz, now())
$$;

create or replace function public.op_date() returns date
language sql stable as $$ select op_at()::date $$;

alter function public.op_at() owner to postgres;
alter function public.op_date() owner to postgres;
revoke all on function public.op_at() from public;
revoke all on function public.op_date() from public;

alter table public.sync_applied_items
  add column if not exists op_at timestamptz,
  add column if not exists device_id text,
  add column if not exists hlc text;

create or replace function public.sync_apply(
  p_item_id   uuid,
  p_op        text,
  p_payload   jsonb,
  p_at        timestamptz default null,
  p_device_id text        default null,
  p_hlc       text        default null
)
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
  -- Run the op under the op's own clock (§28.4). Transaction-local, so every
  -- nested handler and trigger fired below sees it; B2 migrates them onto
  -- op_at()/op_date().
  perform set_config('sisolution.op_at', coalesce(p_at, now())::text, true);

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

  insert into sync_applied_items (user_id, item_id, op, op_at, device_id, hlc)
  values (auth.uid(), p_item_id, p_op, public.op_at(), p_device_id, p_hlc)
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

-- The 3-arg signature is subsumed by the defaults above.
drop function public.sync_apply(uuid, text, jsonb);

revoke all on function public.sync_apply(uuid, text, jsonb, timestamptz, text, text) from public, anon;
grant execute on function public.sync_apply(uuid, text, jsonb, timestamptz, text, text) to authenticated;
alter function public.sync_apply(uuid, text, jsonb, timestamptz, text, text) owner to postgres;

comment on function public.sync_apply(uuid, text, jsonb, timestamptz, text, text) is
  'Offline sync dispatcher. p_at/p_device_id/p_hlc carry the op envelope (B1); '
  || 'the op runs under set_config(''sisolution.op_at'') so nested code reads '
  || 'op_at()/op_date(). Omitting p_at keeps the server clock.';

commit;
