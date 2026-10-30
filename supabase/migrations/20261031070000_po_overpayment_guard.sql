-- Phase 4 — PO overpayment guard.
--
-- The problem this closes:
--
--   pay_supplier_outstanding() has guarded overpayment since it was written
--   (`v_bal < -0.01` -> raise). But the purchases page does not call it — it
--   inserts into `payments` directly. Those direct inserts only met
--   payment_po_amount_paid_trigger(), which was AFTER INSERT, only ever ADDED,
--   had no cap, no guard and no reversal path. That is how PO-000170 ended up
--   paid ৳7,88,680 against a ৳5,66,479 order and PO-000133 read ৳61,278 paid
--   against a ৳30,639 order.
--
-- What changes:
--
--   1. The trigger now blocks any payment that would exceed the PO's
--      outstanding balance, with a ৳1.00 tolerance so rounding noise does not
--      block legitimate payments.
--   2. amount_paid is capped at total_amount — it can no longer drift above.
--   3. The trigger now also handles UPDATE OF is_reversed and DELETE, so
--      reversing or deleting a payment returns the money to the outstanding
--      balance. reverse_supplier_payment() therefore drops its own manual
--      decrement to avoid double-counting.
--   4. `payments.allow_overpayment` gives a deliberate, reasoned override for
--      the cases where overpaying is correct (advance payment, PO total wrong).
--      It shares override_reason with the funds guard, and the check constraint
--      now demands a reason for either flag.
--
-- Offline replay: sync_po_payment / sync_po_create already set
-- app.payment_funds_bypass for the funds guard. The same flag exempts them
-- here, for the same reason — the decision was already taken offline and
-- stranding the outbox would be worse than the overpayment.
--
-- Not changed: pay_supplier_outstanding() keeps its own guard. It fires before
-- the row is written and gives a friendlier error, so the trigger is a backstop
-- for that path and the primary guard for direct inserts.

BEGIN;

-- 1. Override flag ------------------------------------------------------------
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS allow_overpayment boolean NOT NULL DEFAULT false;

-- 2. One reason field serves both overrides -----------------------------------
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_override_reason_check;
ALTER TABLE payments ADD CONSTRAINT payments_override_reason_check
  CHECK (
    (NOT allow_negative AND NOT allow_overpayment)
    OR (override_reason IS NOT NULL AND length(btrim(override_reason)) > 0)
  );

-- 3. Trigger function ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payment_po_amount_paid_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_rec         payments%ROWTYPE;
  v_po          RECORD;
  v_outstanding numeric;
  v_tolerance   CONSTANT numeric := 1.00;
  v_bypass      boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_rec := OLD;
  ELSE
    v_rec := NEW;
  END IF;

  -- Only supplier payments against a purchase order move amount_paid.
  IF v_rec.payment_type IS DISTINCT FROM 'made'
     OR v_rec.reference_type IS DISTINCT FROM 'purchase_order'
     OR v_rec.reference_id IS NULL THEN
    RETURN NULL;
  END IF;

  v_bypass := coalesce(current_setting('app.payment_funds_bypass', true), 'off') = 'on';

  -- ---------------------------------------------------------------- INSERT
  IF TG_OP = 'INSERT' THEN
    IF v_rec.is_reversed THEN
      RETURN NULL;
    END IF;

    SELECT total_amount, amount_paid, po_number
      INTO v_po
      FROM purchase_orders
     WHERE id = v_rec.reference_id
       FOR UPDATE;

    IF NOT FOUND THEN
      RETURN NULL;
    END IF;

    v_outstanding := coalesce(v_po.total_amount, 0) - coalesce(v_po.amount_paid, 0);

    IF v_rec.amount > v_outstanding + v_tolerance
       AND NOT coalesce(v_rec.allow_overpayment, false)
       AND NOT v_bypass THEN
      RAISE EXCEPTION
        'Payment % exceeds the outstanding balance on PO %: outstanding %, requested %. Record an overpayment override with a reason to proceed.',
        coalesce(v_rec.payment_number, v_rec.id::text),
        v_po.po_number,
        round(v_outstanding, 2),
        round(v_rec.amount, 2)
        USING ERRCODE = 'PF002',
              DETAIL  = 'PO total ' || round(coalesce(v_po.total_amount,0),2)
                        || ', already paid ' || round(coalesce(v_po.amount_paid,0),2);
    END IF;

    UPDATE purchase_orders
       SET amount_paid = LEAST(coalesce(total_amount, 0),
                               coalesce(amount_paid, 0) + v_rec.amount),
           updated_at  = now()
     WHERE id = v_rec.reference_id;

    RETURN NULL;
  END IF;

  -- ---------------------------------------------------------------- UPDATE
  IF TG_OP = 'UPDATE' THEN
    IF coalesce(OLD.is_reversed, false) = coalesce(NEW.is_reversed, false) THEN
      RETURN NULL;
    END IF;

    IF NEW.is_reversed THEN
      -- Reversal returns the amount to the outstanding balance.
      UPDATE purchase_orders
         SET amount_paid = GREATEST(0, coalesce(amount_paid, 0) - NEW.amount),
             updated_at  = now()
       WHERE id = NEW.reference_id;
    ELSE
      -- Un-reversing re-applies it, still capped.
      UPDATE purchase_orders
         SET amount_paid = LEAST(coalesce(total_amount, 0),
                                 coalesce(amount_paid, 0) + NEW.amount),
             updated_at  = now()
       WHERE id = NEW.reference_id;
    END IF;

    RETURN NULL;
  END IF;

  -- ---------------------------------------------------------------- DELETE
  IF TG_OP = 'DELETE' THEN
    IF NOT coalesce(OLD.is_reversed, false) THEN
      UPDATE purchase_orders
         SET amount_paid = GREATEST(0, coalesce(amount_paid, 0) - OLD.amount),
             updated_at  = now()
       WHERE id = OLD.reference_id;
    END IF;
    RETURN NULL;
  END IF;

  RETURN NULL;
END;
$$;

-- 4. Re-point the trigger at all three events --------------------------------
DROP TRIGGER IF EXISTS trg_payment_po_amount_paid ON public.payments;
CREATE TRIGGER trg_payment_po_amount_paid
  AFTER INSERT OR DELETE OR UPDATE OF is_reversed ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.payment_po_amount_paid_trigger();

-- 5. reverse_supplier_payment: drop the manual decrement ---------------------
--    The trigger now owns amount_paid for UPDATE OF is_reversed. Leaving the
--    manual update in place would decrement twice.
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

  -- Fires trg_payment_po_amount_paid (UPDATE OF is_reversed), which now owns
  -- the purchase_orders.amount_paid decrement.
  UPDATE payments
     SET is_reversed = true,
         updated_at  = now()
   WHERE id = p_payment_id;

  RETURN json_build_object(
    'payment_number',   v_payment.payment_number,
    'reversed_entries', v_count,
    'amount',           v_payment.amount,
    'reason',           v_reason
  );
END;
$$;

DO $$
BEGIN
  RAISE NOTICE 'po_overpayment_guard: applied — trigger blocks overpayment (PF002), caps amount_paid, handles reversal/delete; allow_overpayment override added';
END $$;

COMMIT;
