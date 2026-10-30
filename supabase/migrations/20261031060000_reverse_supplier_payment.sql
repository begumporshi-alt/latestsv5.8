-- Phase 3 prerequisite: reverse a SINGLE supplier payment.
--
-- Until now the only reversal path was cancelling an entire purchase order,
-- which reverses every payment on it at once (purchases/page.tsx). There was
-- no way to undo one duplicated or mis-keyed payment, which is exactly what
-- Phase 3 needs in order to clean up the ৳73,112.98 wrongly charged to
-- account 1026.
--
-- Why a dedicated RPC rather than an UPDATE:
--   * payments.is_reversed alone changes nothing in the ledger. The GL has to
--     be reversed too, or the balance keeps the error while the row claims to
--     be reversed.
--   * payment_po_amount_paid_trigger only fires on INSERT and only ever ADDS.
--     It has no update/delete path, so reversing a payment must decrement
--     purchase_orders.amount_paid explicitly. That is why PO-000133 currently
--     shows 61,278.00 paid against a 30,639.00 order.
--
-- The reversal mirrors the original entry line-for-line (debit <-> credit)
-- rather than recomputing the posting. That keeps WHT-split payments and any
-- future change to the posting logic correct by construction.
--
-- Guard interaction: the funds guard lives in payment_accounting_trigger,
-- which fires on INSERT into payments. A reversal posts journal lines only,
-- so it is never blocked — correct, because returning money to an account can
-- only improve its balance.

BEGIN;

CREATE OR REPLACE FUNCTION public.reverse_supplier_payment(
  p_payment_id uuid,
  p_reason     text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_payment   record;
  v_je        record;
  v_lines     json;
  v_entry_id  uuid;
  v_count     int := 0;
  v_reason    text;
BEGIN
  IF p_payment_id IS NULL THEN
    RAISE EXCEPTION 'Payment id is required';
  END IF;

  v_reason := NULLIF(TRIM(COALESCE(p_reason, '')), '');
  IF v_reason IS NULL OR length(v_reason) < 5 THEN
    RAISE EXCEPTION 'A reversal reason of at least 5 characters is required';
  END IF;

  -- Lock the row so two operators cannot both reverse the same payment.
  SELECT * INTO v_payment FROM payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment % not found', p_payment_id;
  END IF;

  IF v_payment.payment_type <> 'made' THEN
    RAISE EXCEPTION 'Only supplier payments (payment_type = made) can be reversed here; % is %',
      v_payment.payment_number, v_payment.payment_type;
  END IF;

  IF v_payment.is_reversed THEN
    RAISE EXCEPTION 'Payment % is already reversed', v_payment.payment_number;
  END IF;

  IF EXISTS (
    SELECT 1 FROM journal_entries
     WHERE reference_type = 'payment_reversal' AND reference_id = p_payment_id
  ) THEN
    RAISE EXCEPTION 'A reversal entry already exists for payment %', v_payment.payment_number;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM journal_entries
     WHERE reference_type = 'payment' AND reference_id = p_payment_id
  ) THEN
    RAISE EXCEPTION 'Payment % has no journal entry to reverse', v_payment.payment_number;
  END IF;

  -- Reverse every journal entry belonging to this payment, mirroring each line.
  FOR v_je IN
    SELECT id
      FROM journal_entries
     WHERE reference_type = 'payment' AND reference_id = p_payment_id
     ORDER BY created_at, id
  LOOP
    SELECT json_agg(
             json_build_object(
               'account_id',  jl.account_id,
               'debit',       jl.credit,
               'credit',      jl.debit,
               'description', 'Reversal: ' || COALESCE(jl.description, '')
             )
           )
      INTO v_lines
      FROM journal_lines jl
     WHERE jl.journal_entry_id = v_je.id
       AND (jl.debit <> 0 OR jl.credit <> 0);

    CONTINUE WHEN v_lines IS NULL;

    v_entry_id := public.post_journal_entry(
      'Reversal of ' || COALESCE(v_payment.payment_number, 'payment') || ' — ' || v_reason,
      CURRENT_DATE,
      'payment_reversal',
      p_payment_id,
      v_lines,
      NULL,
      v_payment.supplier_id
    );

    v_count := v_count + 1;
  END LOOP;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'Nothing was reversed for payment %', v_payment.payment_number;
  END IF;

  UPDATE payments
     SET is_reversed = true,
         updated_at  = now()
   WHERE id = p_payment_id;

  -- Undo the PO's accumulated paid amount; the trigger has no reversal path.
  IF v_payment.reference_type = 'purchase_order' AND v_payment.reference_id IS NOT NULL THEN
    UPDATE purchase_orders
       SET amount_paid = GREATEST(0, COALESCE(amount_paid, 0) - v_payment.amount),
           updated_at  = now()
     WHERE id = v_payment.reference_id;
  END IF;

  RETURN json_build_object(
    'payment_number',   v_payment.payment_number,
    'reversed_entries', v_count,
    'amount',           v_payment.amount,
    'reason',           v_reason
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reverse_supplier_payment(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_supplier_payment(uuid, text) TO authenticated;

DO $$
BEGIN
  RAISE NOTICE 'reverse_supplier_payment: applied — single-payment reversal with GL mirror + PO amount_paid rollback';
END $$;

COMMIT;
