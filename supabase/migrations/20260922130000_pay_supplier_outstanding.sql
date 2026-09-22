-- ============================================================================
-- Multi-PO supplier payment collection
--
-- One call pays a supplier across multiple due purchase orders. Replaces the
-- one-PO-per-dialog flow (and its client-side partial-failure cleanup) with a
-- single atomic transaction.
--
-- p_allocations: [{"po_id": "...", "amount": 100, "wht_amount": 0}, ...]
-- WHT is validated per PO (0 <= wht < amount). Overpayment is intentionally
-- not supported: the caller must allocate the full paid amount to POs
-- (supplier advances are displayed as a negative outstanding balance but
-- have no dedicated ledger — keep it that way until one is designed).
--
-- Existing triggers do the rest per payment row:
--   payment_po_amount_paid_trigger  -> purchase_orders.amount_paid
--   AP journal trigger              -> Dr 2000 (full) / Cr cash (paid) / Cr 2110 (WHT)
--   journal recompute               -> supplier outstanding_balance
-- ============================================================================

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
      amount, wht_amount, payment_method, payment_date, reference_number, notes, payment_for)
    values (
      coalesce(v_num, 'POPAY-' || to_char(now(), 'HH24MISS')),
      'made', 'purchase_order', v_po.id, p_supplier_id,
      v_amount, v_wht,
      coalesce(p_payment_method, 'cash'), p_payment_date,
      p_reference_number, p_notes, 'supplier_payment'
    );

    v_paid      := v_paid + v_amount;
    v_wht_total := v_wht_total + v_wht;
    v_payment_nums := v_payment_nums || coalesce(v_num, '');
  end loop;

  if v_paid <= 0 then
    raise exception 'pay_supplier_outstanding: total paid must be greater than 0';
  end if;

  return jsonb_build_object(
    'payment_numbers', to_jsonb(v_payment_nums),
    'paid', v_paid,
    'wht_total', v_wht_total,
    'pos_updated', jsonb_array_length(p_allocations)
  );
end;
$$;

grant execute on function public.pay_supplier_outstanding(uuid, date, text, text, text, jsonb)
  to authenticated;
