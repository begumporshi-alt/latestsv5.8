-- ============================================================================
-- Offline POS due collection
-- ----------------------------------------------------------------------------
-- POS checkout can collect a customer's previous invoice dues while OFFLINE:
-- queueOfflineOrder enqueues one payment.create op per oldest-first allocation
-- (the same shape CollectPaymentModal uses), each carrying
-- collected_with_invoice_id pointing at the queued sale's client-generated id.
-- Sync replays the outbox in strict createdAt order, so sync_invoice_create
-- lands first and the link resolves at replay; a later cancel_invoice of that
-- sale reverses the collection (20260924120000_pos_due_collection.sql).
--
-- This migration extends the EXISTING sync_payment_create handler (verbatim
-- from 20260911130000_offline_phase1_sales_payments.sql) with one addition:
-- it persists the collected_with_invoice_id link. Live-balance re-validation,
-- the overpay conflict path, and the payments/journal triggers are unchanged.
--
-- sync_apply needs no change: the op is still 'payment.create'.
-- CREATE OR REPLACE preserves the function's existing ACL (revoked from
-- public/authenticated in the phase-1 migration — only the sync_apply
-- dispatcher may call it).
-- ============================================================================

create or replace function public.sync_payment_create(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice   invoices%rowtype;
  v_amount    numeric;
  v_bad       numeric;
  v_new_bal   numeric;
  v_status    text;
  v_num       text;
  v_collected uuid;
begin
  v_amount := coalesce((p_payload->>'amount')::numeric, 0);
  v_bad    := coalesce((p_payload->>'bad_debt_amount')::numeric, 0);

  if v_amount + v_bad <= 0 then
    raise exception 'payment.create: amount or bad_debt_amount must be greater than 0';
  end if;

  -- Offline POS due collection link. The queued sale always syncs before this
  -- payment (strict outbox order), so the invoice must exist — if it does
  -- not, the outbox item was discarded manually and this op should fail
  -- loudly in the Sync Center rather than post an unlinked collection.
  v_collected := nullif(p_payload->>'collected_with_invoice_id', '')::uuid;
  if v_collected is not null and not exists (select 1 from invoices where id = v_collected) then
    raise exception 'payment.create: collected_with invoice % not found', v_collected;
  end if;

  select * into v_invoice from invoices where id = (p_payload->>'invoice_id')::uuid for update;
  if not found then
    raise exception 'payment.create: invoice not found';
  end if;
  if v_invoice.status = 'cancelled' then
    raise exception 'payment.create: invoice % is cancelled', v_invoice.invoice_number;
  end if;

  v_new_bal := v_invoice.total_amount
    - (coalesce(v_invoice.amount_paid, 0) + v_amount)
    - (coalesce(v_invoice.bad_debt_amount, 0) + v_bad);
  if v_new_bal < -0.01 and coalesce((p_payload->>'force')::boolean, false) = false then
    return jsonb_build_object(
      'status', 'conflict',
      'reason', format('Payment exceeds balance due (server balance: %s)',
        (v_invoice.total_amount - coalesce(v_invoice.amount_paid, 0) - coalesce(v_invoice.bad_debt_amount, 0))),
      'server_row', to_jsonb(v_invoice)
    );
  end if;

  v_status := case when v_new_bal <= 0.01 then 'paid' else 'partially_paid' end;

  v_num := public.generate_payment_number();
  insert into payments (payment_number, payment_type, reference_type, reference_id, customer_id,
    amount, bad_debt_amount, payment_method, payment_date, reference_number, notes, payment_for,
    collected_with_invoice_id)
  values (coalesce(v_num, 'PAY-' || to_char(now(), 'HH24MISS')),
    'received', 'invoice', v_invoice.id, v_invoice.customer_id,
    v_amount, coalesce(nullif(p_payload->>'bad_debt_amount', '')::numeric, 0),
    coalesce(p_payload->>'payment_method', 'cash'),
    coalesce(nullif(p_payload->>'payment_date', '')::date, current_date),
    nullif(p_payload->>'reference_number', ''),
    nullif(p_payload->>'notes', ''),
    coalesce(p_payload->>'payment_for', 'paid_invoice_pay'),
    v_collected);

  update invoices set
    amount_paid = coalesce(amount_paid, 0) + v_amount,
    bad_debt_amount = coalesce(bad_debt_amount, 0) + v_bad,
    status = v_status,
    updated_at = now()
  where id = v_invoice.id;

  return jsonb_build_object(
    'status', 'synced',
    'payment_number', v_num,
    'invoice_status', v_status
  );
end;
$$;
