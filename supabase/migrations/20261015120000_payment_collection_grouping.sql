-- ============================================================================
-- Payment collection grouping (customer statement shows one row per collection)
-- ----------------------------------------------------------------------------
-- collect_customer_payment and the offline payment.create replay each insert
-- one payments row PER INVOICE, so a single collection of e.g. ৳5,000 spread
-- over 3 invoices printed as three separate "Payment" rows in the customer
-- statement. This adds payments.collection_id: one uuid per physical
-- collection, stamped on every payment row of that collection. The statement
-- groups payments by coalesce(collection_id, id) and prints ONE row with the
-- combined total ("Payment (3 invoices)" / "Against INV-…, INV-…, INV-…").
--
-- Historical rows keep collection_id NULL and stay as separate rows (grouping
-- them retroactively would guess which same-day payments were one collection).
--
--   1. ALTER TABLE payments ADD collection_id
--   2. collect_customer_payment — stamp one collection_id per call
--   3. sync_payment_create — persist payload collection_id (offline ops)
--   4. get_customer_period_statement — group payment docs by collection_id
-- ============================================================================

alter table public.payments add column if not exists collection_id uuid;

-- ---------------------------------------------------------------------------
-- 2. Multi-invoice collection RPC with one shared collection_id per call.
--    The LIVE signature is the 9-arg one (p_collected_with_invoice_id added by
--    the POS due-collection migration) — replacing that overload. The older
--    8-arg overload is dropped first: leaving both would make the app's
--    named-argument RPC call ambiguous ("function is not unique").
-- ---------------------------------------------------------------------------
drop function if exists public.collect_customer_payment(
  uuid, date, text, text, text, jsonb, numeric, boolean);

create or replace function public.collect_customer_payment(
  p_customer_id uuid,
  p_payment_date date default current_date,
  p_payment_method text default 'cash',
  p_reference_number text default null,
  p_notes text default null,
  p_allocations jsonb default '[]'::jsonb,
  p_overpayment numeric default 0,
  p_route_overpayment boolean default false,
  p_collected_with_invoice_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_alloc        jsonb;
  v_invoice      invoices%rowtype;
  v_amount       numeric;
  v_bad          numeric;
  v_new_paid     numeric;
  v_new_bad      numeric;
  v_new_bal      numeric;
  v_status       text;
  v_num          text;
  v_allocated    numeric := 0;
  v_payment_nums text[] default '{}';
  v_advance_id   uuid;
  v_collection_id uuid := gen_random_uuid();
begin
  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array'
     or jsonb_array_length(p_allocations) = 0 then
    raise exception 'collect_customer_payment: at least one invoice allocation is required';
  end if;

  if p_overpayment < 0 then
    raise exception 'collect_customer_payment: overpayment cannot be negative';
  end if;
  if p_overpayment > 0 and p_route_overpayment = false then
    raise exception 'collect_customer_payment: % is not allocated — allocate it or route the overpayment to the customer advance', p_overpayment;
  end if;

  for v_alloc in select * from jsonb_array_elements(p_allocations) loop
    v_amount := coalesce((v_alloc->>'amount')::numeric, 0);
    v_bad    := coalesce((v_alloc->>'bad_debt_amount')::numeric, 0);

    if v_amount < 0 or v_bad < 0 or v_amount + v_bad <= 0 then
      raise exception 'collect_customer_payment: allocation amount must be greater than 0';
    end if;

    select * into v_invoice from invoices
      where id = (v_alloc->>'invoice_id')::uuid
        and customer_id = p_customer_id
      for update;
    if not found then
      raise exception 'collect_customer_payment: invoice % not found for this customer', v_alloc->>'invoice_id';
    end if;
    if v_invoice.status in ('cancelled', 'paid', 'draft', 'refunded') then
      raise exception 'collect_customer_payment: invoice % is not collectable (status: %)',
        v_invoice.invoice_number, v_invoice.status;
    end if;

    v_new_paid := coalesce(v_invoice.amount_paid, 0) + v_amount;
    v_new_bad  := coalesce(v_invoice.bad_debt_amount, 0) + v_bad;
    v_new_bal  := v_invoice.total_amount - v_new_paid - v_new_bad;
    if v_new_bal < -0.01 then
      raise exception 'collect_customer_payment: allocation exceeds balance due on invoice % (due: %)',
        v_invoice.invoice_number,
        v_invoice.total_amount - coalesce(v_invoice.amount_paid, 0) - coalesce(v_invoice.bad_debt_amount, 0);
    end if;

    v_num := public.generate_payment_number();
    insert into payments (payment_number, payment_type, reference_type, reference_id, customer_id,
      amount, bad_debt_amount, payment_method, payment_date, reference_number, notes, payment_for,
      collected_with_invoice_id, collection_id)
    values (
      coalesce(v_num, 'PAY-' || to_char(now(), 'HH24MISS')),
      'received', 'invoice', v_invoice.id, p_customer_id,
      v_amount, v_bad,
      coalesce(p_payment_method, 'cash'), p_payment_date,
      p_reference_number, p_notes, 'outstanding_invoice_pay',
      p_collected_with_invoice_id, v_collection_id
    );

    v_status := case when v_new_bal <= 0.01 then 'paid' else 'partially_paid' end;
    update invoices set
      amount_paid = v_new_paid,
      bad_debt_amount = v_new_bad,
      status = v_status,
      updated_at = now()
    where id = v_invoice.id;

    v_allocated := v_allocated + v_amount;
    v_payment_nums := v_payment_nums || coalesce(v_num, '');
  end loop;

  if v_allocated + p_overpayment <= 0 then
    raise exception 'collect_customer_payment: total received must be greater than 0';
  end if;

  if p_overpayment > 0 and p_route_overpayment then
    insert into customer_advances (customer_id, amount, balance, status, payment_method,
      payment_date, reference_number, notes)
    values (
      p_customer_id, p_overpayment, p_overpayment, 'active',
      coalesce(p_payment_method, 'cash'), p_payment_date,
      p_reference_number,
      nullif(coalesce(p_notes, '') || ' Overpayment from multi-invoice collection.', ' ')
    )
    returning id into v_advance_id;
  end if;

  return jsonb_build_object(
    'collection_id', v_collection_id,
    'payment_numbers', to_jsonb(v_payment_nums),
    'allocated', v_allocated,
    'overpayment', p_overpayment,
    'advance_id', v_advance_id,
    'invoices_updated', jsonb_array_length(p_allocations)
  );
end;
$$;

grant execute on function public.collect_customer_payment(uuid, date, text, text, text, jsonb, numeric, boolean, uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Offline payment.create replay (verbatim from 20260925120000) plus
--    persistence of the collection_id the client stamps on every op of one
--    offline multi-invoice collection.
-- ---------------------------------------------------------------------------
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
  v_collection uuid;
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
    collected_with_invoice_id, collection_id)
  values (coalesce(v_num, 'PAY-' || to_char(now(), 'HH24MISS')),
    'received', 'invoice', v_invoice.id, v_invoice.customer_id,
    v_amount, coalesce(nullif(p_payload->>'bad_debt_amount', '')::numeric, 0),
    coalesce(p_payload->>'payment_method', 'cash'),
    coalesce(nullif(p_payload->>'payment_date', '')::date, current_date),
    nullif(p_payload->>'reference_number', ''),
    nullif(p_payload->>'notes', ''),
    coalesce(p_payload->>'payment_for', 'paid_invoice_pay'),
    v_collected,
    nullif(p_payload->>'collection_id', '')::uuid);

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

-- ---------------------------------------------------------------------------
-- 4. Customer period statement (verbatim from 20260915130000 v2) with payment
--    documents grouped by collection. Payments are aggregated in pay_agg keyed
--    by coalesce(collection_id, id); single-payment collections render exactly
--    as before, multi-payment collections render as ONE row with the combined
--    total and the covered invoice numbers in the details line. Journal sums,
--    opening/closing balance, and the running balance are unchanged.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_customer_period_statement(p_customer_id uuid, p_from date, p_to date)
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH ar_lines AS (
    SELECT je.entry_number, je.entry_date, je.reference_type AS rt,
           COALESCE(pay.collection_id, je.reference_id) AS rid, je.description AS descr,
           jl.debit, jl.credit
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.journal_entry_id
      JOIN accounts a ON a.id = jl.account_id AND a.code IN ('1100', '1300')
      LEFT JOIN payments pay ON je.reference_type = 'payment' AND pay.id = je.reference_id
     WHERE je.is_posted = TRUE
       AND (je.customer_id = p_customer_id
            OR (je.customer_id IS NULL
                AND je.reference_type IN ('invoice', 'invoice_cancel')
                AND EXISTS (SELECT 1 FROM invoices i
                             WHERE i.id = je.reference_id
                               AND i.customer_id = p_customer_id)))
  ),
  pay_agg AS (
    SELECT coalesce(pay.collection_id, pay.id) AS gid,
           count(*) AS payment_count,
           bool_or(pay.payment_type = 'refund') AS is_refund,
           min(pay.payment_number) AS payment_number,
           min(pay.payment_date) AS payment_date,
           min(pay.payment_method) AS payment_method,
           min(pay.reference_number) AS reference_number,
           min(pay.notes) AS notes,
           string_agg(DISTINCT i.invoice_number, ', ' ORDER BY i.invoice_number) AS invoice_numbers
      FROM payments pay
      LEFT JOIN invoices i ON pay.reference_type = 'invoice' AND i.id = pay.reference_id
     WHERE pay.customer_id = p_customer_id
     GROUP BY 1
  ),
  opening AS (
    SELECT COALESCE(SUM(debit - credit), 0) AS bal
      FROM ar_lines
     WHERE p_from IS NOT NULL AND entry_date < p_from
  ),
  activity AS (
    SELECT
      CASE WHEN rt IN ('invoice', 'invoice_edit', 'invoice_cancel') THEN 'invoice' ELSE rt END AS kind,
      rid,
      SUM(debit - credit) AS net_amount,
      MIN(entry_date) AS first_date
    FROM ar_lines
    WHERE (p_from IS NULL OR entry_date >= p_from)
      AND (p_to IS NULL OR entry_date <= p_to)
    GROUP BY 1, 2
  ),
  doc_rows AS (
    SELECT a.kind, a.rid, a.net_amount,
           COALESCE(
             CASE WHEN a.kind = 'invoice'    THEN i.invoice_date
                  WHEN a.kind = 'payment'    THEN p.payment_date
                  WHEN a.kind = 'sales_return' THEN sr.return_date
                  WHEN a.kind = 'receivable' THEN je2.entry_date
                  WHEN a.kind IN ('advance', 'advance_refund') THEN ca.created_at::date
                  WHEN a.kind = 'store_credit_cash_out' THEN csc.created_at::date
                  ELSE a.first_date END,
             a.first_date) AS sort_date,
           CASE
             WHEN a.kind = 'invoice'    THEN i.invoice_number
             WHEN a.kind = 'payment' AND p.payment_count > 1 THEN NULL
             WHEN a.kind = 'payment'    THEN p.payment_number
             WHEN a.kind = 'sales_return' THEN sr.return_number
             WHEN a.kind IN ('advance', 'advance_refund') THEN ca.advance_number
             WHEN a.kind = 'store_credit_cash_out' THEN csc.credit_number
           END AS doc_number,
           CASE
             WHEN a.kind = 'invoice' AND i.status = 'cancelled' THEN 'Invoice (cancelled)'
             WHEN a.kind = 'invoice'    THEN 'Invoice'
             WHEN a.kind = 'payment' AND p.payment_count > 1
                                        THEN 'Payment (' || p.payment_count || ' invoices)'
             WHEN a.kind = 'payment' AND p.is_refund THEN 'Refund'
             WHEN a.kind = 'payment'    THEN 'Payment'
             WHEN a.kind = 'sales_return' THEN 'Sales return'
             WHEN a.kind = 'receivable' THEN 'Previous due'
             WHEN a.kind = 'advance'    THEN 'Advance applied'
             WHEN a.kind = 'advance_refund' THEN 'Advance refunded'
             WHEN a.kind = 'store_credit_cash_out' THEN 'Store credit cash-out'
             WHEN a.kind = 'opening_balance' THEN 'Opening balance'
             ELSE 'Adjustment'
           END AS label,
           CASE
             WHEN a.kind = 'invoice' THEN NULLIF(i.reference, '')
             WHEN a.kind = 'payment' AND p.payment_count > 1
                                     THEN concat_ws(' · ', 'Against ' || p.invoice_numbers, p.notes)
             WHEN a.kind = 'payment' THEN p.notes
             WHEN a.kind = 'sales_return' THEN sr.notes
             WHEN a.kind = 'receivable' THEN je2.description
           END AS details,
           CASE WHEN a.kind = 'payment' THEN p.payment_method END AS method,
           CASE WHEN a.kind = 'payment' THEN p.reference_number END AS reference_number,
           CASE WHEN a.kind = 'invoice' AND i.status <> 'cancelled'
                 AND EXISTS (SELECT 1 FROM journal_entries je3
                              WHERE je3.reference_type = 'invoice_edit'
                                AND je3.reference_id = a.rid
                                AND je3.is_posted = TRUE)
                THEN TRUE ELSE FALSE END AS revised
      FROM activity a
      LEFT JOIN invoices i   ON a.kind = 'invoice' AND i.id = a.rid
      LEFT JOIN pay_agg p    ON a.kind = 'payment' AND p.gid = a.rid
      LEFT JOIN sales_returns sr ON a.kind = 'sales_return' AND sr.id = a.rid
      LEFT JOIN journal_entries je2 ON a.kind = 'receivable' AND je2.id = a.rid
      LEFT JOIN customer_advances ca ON a.kind IN ('advance', 'advance_refund') AND ca.id = a.rid
      LEFT JOIN customer_store_credits csc ON a.kind = 'store_credit_cash_out' AND csc.id = a.rid
  ),
  kept AS (
    SELECT * FROM doc_rows WHERE net_amount <> 0
  ),
  ordered AS (
    SELECT d.*,
           (SELECT bal FROM opening)
         + SUM(d.net_amount) OVER (ORDER BY d.sort_date, d.doc_number NULLS LAST, d.kind, d.rid
                                          ROWS UNBOUNDED PRECEDING) AS balance
      FROM kept d
  )
  SELECT json_build_object(
    'opening_balance', (SELECT bal FROM opening),
    'closing_balance', (SELECT bal FROM opening) + COALESCE((SELECT SUM(net_amount) FROM kept), 0),
    'total_bills',     COALESCE((SELECT SUM(net_amount) FROM kept WHERE net_amount > 0), 0),
    'total_paid',      COALESCE((SELECT -SUM(net_amount) FROM kept WHERE net_amount < 0), 0),
    'store_credit_balance', (SELECT COALESCE(SUM(balance), 0) FROM customer_store_credits
                              WHERE customer_id = p_customer_id AND status = 'active'),
    'advance_balance', (SELECT COALESCE(SUM(balance), 0) FROM customer_advances
                         WHERE customer_id = p_customer_id AND status = 'active'),
    'zero_net_excluded', (SELECT count(*) FROM doc_rows WHERE net_amount = 0),
    'revised_count', (SELECT count(*) FROM kept WHERE revised),
    'rows', COALESCE((SELECT json_agg(json_build_object(
               'date', to_char(sort_date, 'YYYY-MM-DD'),
               'kind', kind,
               'doc_number', doc_number,
               'label', label,
               'details', details,
               'method', method,
               'reference_number', reference_number,
               'bill', CASE WHEN net_amount > 0 THEN net_amount ELSE 0 END,
               'paid', CASE WHEN net_amount < 0 THEN -net_amount ELSE 0 END,
               'balance', balance,
               'revised', revised
             ) ORDER BY sort_date, doc_number NULLS LAST, kind, rid) FROM ordered), '[]'::json)
  );
$$;

GRANT EXECUTE ON FUNCTION get_customer_period_statement(uuid, date, date) TO authenticated;
