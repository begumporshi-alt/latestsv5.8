-- ============================================================================
-- Supplier payment collection grouping (AP statement shows one row per payment)
-- ----------------------------------------------------------------------------
-- pay_supplier_outstanding and the offline po.payment replay each insert one
-- payments row PER PURCHASE ORDER, so a single payment spread over several POs
-- printed as multiple "Payment" rows in the supplier's AP statement. This
-- stamps payments.collection_id (column added in 20261015120000) on every
-- payment row of one supplier payment and groups them in the statement —
-- one combined "Payment (N POs)" row with the covered PO numbers in the
-- description. Historical rows keep collection_id NULL and stay separate.
--
--   1. pay_supplier_outstanding — stamp one collection_id per call
--   2. sync_po_payment — persist payload collection_id (offline ops)
--   3. get_supplier_ap_statement — group payment journals by collection_id
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Multi-PO supplier payment RPC (verbatim from 20260922130000) with one
--    shared collection_id per call.
-- ---------------------------------------------------------------------------
create or replace function public.pay_supplier_outstanding(
  p_supplier_id uuid,
  p_payment_date date default current_date,
  p_payment_method text default 'cash',
  p_reference_number text default null,
  p_notes text default null,
  p_allocations jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_alloc        jsonb;
  v_po           purchase_orders%rowtype;
  v_amount       numeric;
  v_wht          numeric;
  v_new_paid     numeric;
  v_bal          numeric;
  v_num          text;
  v_paid         numeric := 0;
  v_wht_total    numeric := 0;
  v_payment_nums text[] default '{}';
  v_collection_id uuid := gen_random_uuid();
begin
  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array'
     or jsonb_array_length(p_allocations) = 0 then
    raise exception 'pay_supplier_outstanding: at least one PO allocation is required';
  end if;

  for v_alloc in select * from jsonb_array_elements(p_allocations) loop
    v_amount := coalesce((v_alloc->>'amount')::numeric, 0);
    v_wht    := coalesce((v_alloc->>'wht_amount')::numeric, 0);

    if v_amount <= 0 then
      raise exception 'pay_supplier_outstanding: allocation amount must be greater than 0';
    end if;
    if v_wht < 0 or v_wht >= v_amount then
      raise exception 'pay_supplier_outstanding: withholding must be >= 0 and less than the payment amount';
    end if;

    select * into v_po from purchase_orders
      where id = (v_alloc->>'po_id')::uuid
        and supplier_id = p_supplier_id
      for update;
    if not found then
      raise exception 'pay_supplier_outstanding: purchase order % not found for this supplier', v_alloc->>'po_id';
    end if;
    if v_po.status = 'cancelled' then
      raise exception 'pay_supplier_outstanding: purchase order % is cancelled', v_po.po_number;
    end if;

    v_new_paid := coalesce(v_po.amount_paid, 0) + v_amount;
    v_bal      := v_po.total_amount - v_new_paid;
    if v_bal < -0.01 then
      raise exception 'pay_supplier_outstanding: allocation exceeds balance due on PO % (due: %)',
        v_po.po_number, v_po.total_amount - coalesce(v_po.amount_paid, 0);
    end if;

    v_num := public.generate_purchase_payment_number();
    insert into payments (payment_number, payment_type, reference_type, reference_id, supplier_id,
      amount, wht_amount, payment_method, payment_date, reference_number, notes, payment_for,
      collection_id)
    values (
      coalesce(v_num, 'POPAY-' || to_char(now(), 'HH24MISS')),
      'made', 'purchase_order', v_po.id, p_supplier_id,
      v_amount, v_wht,
      coalesce(p_payment_method, 'cash'), p_payment_date,
      p_reference_number, p_notes, 'supplier_payment',
      v_collection_id
    );

    v_paid      := v_paid + v_amount;
    v_wht_total := v_wht_total + v_wht;
    v_payment_nums := v_payment_nums || coalesce(v_num, '');
  end loop;

  if v_paid <= 0 then
    raise exception 'pay_supplier_outstanding: total paid must be greater than 0';
  end if;

  return jsonb_build_object(
    'collection_id', v_collection_id,
    'payment_numbers', to_jsonb(v_payment_nums),
    'paid', v_paid,
    'wht_total', v_wht_total,
    'pos_updated', jsonb_array_length(p_allocations)
  );
end;
$$;

grant execute on function public.pay_supplier_outstanding(uuid, date, text, text, text, jsonb)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Offline po.payment replay (verbatim from 20260911140000) plus
--    persistence of the collection_id the client stamps on every op of one
--    offline multi-PO payment.
-- ---------------------------------------------------------------------------
create or replace function public.sync_po_payment(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_po    purchase_orders%rowtype;
  v_amount numeric;
  v_wht   numeric;
  v_bal   numeric;
  v_num   text;
begin
  v_amount := coalesce((p_payload->>'amount')::numeric, 0);
  v_wht    := coalesce(nullif(p_payload->>'wht_amount', '')::numeric, 0);
  if v_amount <= 0 then
    raise exception 'po.payment: amount must be greater than 0';
  end if;

  select * into v_po from purchase_orders where id = (p_payload->>'po_id')::uuid for update;
  if not found then
    raise exception 'po.payment: purchase order not found';
  end if;
  if v_po.status = 'cancelled' then
    raise exception 'po.payment: purchase order % is cancelled', v_po.po_number;
  end if;

  v_bal := v_po.total_amount - coalesce(v_po.amount_paid, 0);
  if v_amount > v_bal + 0.01 and coalesce((p_payload->>'force')::boolean, false) = false then
    return jsonb_build_object(
      'status', 'conflict',
      'reason', format('Payment exceeds the outstanding balance (server balance: %s)', v_bal),
      'server_row', to_jsonb(v_po)
    );
  end if;

  v_num := public.generate_purchase_payment_number();
  insert into payments (payment_number, payment_type, reference_type, reference_id, supplier_id,
    amount, wht_amount, payment_method, payment_date, reference_number, notes, payment_for,
    collection_id)
  values (coalesce(v_num, 'POPAY-' || to_char(now(), 'HH24MISS')),
    'made', 'purchase_order', v_po.id, v_po.supplier_id,
    v_amount, v_wht,
    coalesce(p_payload->>'payment_method', 'cash'),
    coalesce(nullif(p_payload->>'payment_date', '')::date, current_date),
    nullif(p_payload->>'reference_number', ''),
    nullif(p_payload->>'notes', ''),
    'supplier_payment',
    nullif(p_payload->>'collection_id', '')::uuid);

  return jsonb_build_object('status', 'synced', 'payment_number', v_num);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Supplier AP statement (verbatim from 20260904160000) with payment
--    journals grouped by collection. Journal lines on account 2000 sharing a
--    payments.collection_id collapse into ONE row (combined debit, PO numbers
--    in the description); everything else renders exactly as before. The
--    running balance is unchanged.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_supplier_ap_statement(p_supplier_id uuid)
RETURNS TABLE (
  entry_date date,
  entry_number text,
  doc_type text,
  description text,
  debit numeric,
  credit numeric,
  balance numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH attributed AS (
    SELECT je.id AS jid, je.entry_number AS en, je.entry_date AS ed,
           je.reference_type AS rt, je.description AS descr,
           jl.debit AS dr, jl.credit AS cr,
           COALESCE(pay.collection_id, je.id) AS gid,
           po.po_number AS po_number
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN accounts a ON a.id = jl.account_id AND a.code = '2000'
    LEFT JOIN payments pay ON je.reference_type = 'payment' AND pay.id = je.reference_id
    LEFT JOIN purchase_orders po ON je.reference_type = 'payment' AND po.id = pay.reference_id
    WHERE je.is_posted = TRUE AND je.supplier_id = p_supplier_id
    UNION ALL
    SELECT je.id, je.entry_number, je.entry_date, je.reference_type, je.description,
           jl.debit, jl.credit, je.id, NULL
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN accounts a ON a.id = jl.account_id AND a.code = '2000'
    JOIN goods_receipt_notes g ON g.id = je.reference_id
    WHERE je.is_posted = TRUE AND je.reference_type = 'grn' AND je.supplier_id IS NULL
      AND g.supplier_id = p_supplier_id
  ),
  grouped AS (
    SELECT gid, rt,
           min(ed) AS ed,
           min(en) AS en,
           max(descr) AS descr,
           count(DISTINCT jid) FILTER (WHERE rt = 'payment') AS payment_count,
           string_agg(DISTINCT po_number, ', ' ORDER BY po_number) AS po_numbers,
           sum(dr) AS dr, sum(cr) AS cr
    FROM attributed
    GROUP BY gid, rt
  )
  SELECT g.ed, g.en,
         CASE g.rt
           WHEN 'grn' THEN 'Goods Received'
           WHEN 'payable' THEN 'Payable'
           WHEN 'payment' THEN CASE WHEN g.payment_count > 1
                                    THEN 'Payment (' || g.payment_count || ' POs)'
                                    ELSE 'Payment' END
           WHEN 'purchase_return' THEN 'Purchase Return'
           WHEN 'purchase_cancellation' THEN 'PO Cancellation'
           ELSE g.rt
         END,
         CASE WHEN g.rt = 'payment' AND g.payment_count > 1
              THEN coalesce(nullif('Against ' || g.po_numbers, 'Against '), g.descr)
              ELSE g.descr END,
         g.dr, g.cr,
         SUM(g.cr - g.dr) OVER (ORDER BY g.ed, g.en, g.gid
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
  FROM grouped g
  WHERE g.dr <> 0 OR g.cr <> 0
  ORDER BY g.ed, g.en, g.gid;
$$;
