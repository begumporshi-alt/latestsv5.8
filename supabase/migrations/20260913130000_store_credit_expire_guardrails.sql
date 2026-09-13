-- Store credits: audit trail + repair of silently-expired credits.
--
-- Investigation 2026-09-13: every credit in customer_store_credits sits at
-- status='expired' with full balance and NULL expires_at — including the two
-- REAL credits from sales-return refunds (SC-000009 ৳7,226.40 and
-- SC-000017 ৳3,657.50), expired 28s / 50s after issuance.
--
-- There is NO automatic expiry anywhere (no trigger, no cron, no sweep —
-- every writer was enumerated). The only writer of status='expired' is the
-- "Expire" text button on /sales/store-credit: a direct UPDATE with no
-- confirmation dialog and no audit log, so an accidental click silently
-- kills the customer's money. Worse, expiring a credit with a remaining
-- balance does NOT reverse the Cr 2200 liability — the balance sheet keeps
-- owing money the POS will no longer accept (both repaired credits are live
-- proof: ~৳10,883.90 of 2200 liability unspendable).
--
-- This migration adds:
--   1. An audit trigger logging every store-credit status transition to
--      activity_logs (captures ALL writers: page, offline sync, psql).
--   2. Reactivation of the two damaged real credits. Their balance is
--      intact, nothing was redeemed, and GL 2200 still carries the
--      liability — the books say this money is owed, so the credits go
--      back to active. July test-era credits (SC-000002..000008, test
--      customers, ৳406 total) stay expired pending owner cleanup.
--
-- The confirmation dialog for the Expire button ships in the frontend.

-- 1. Audit trigger: log status transitions (and issuance) to activity_logs.
CREATE OR REPLACE FUNCTION public.log_store_credit_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO activity_logs (user_id, action, entity_type, entity_id, entity_label, metadata)
    VALUES (auth.uid(), 'store_credit.create', 'store_credit', NEW.id,
            'Store credit ' || NEW.credit_number || ' issued (' || NEW.status || ')',
            jsonb_build_object('credit_number', NEW.credit_number, 'amount', NEW.amount,
                               'status', NEW.status));
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO activity_logs (user_id, action, entity_type, entity_id, entity_label, metadata)
    VALUES (auth.uid(), 'store_credit.' || NEW.status, 'store_credit', NEW.id,
            'Store credit ' || NEW.credit_number || ': ' || OLD.status || ' → ' || NEW.status,
            jsonb_build_object('credit_number', NEW.credit_number, 'old_status', OLD.status,
                               'new_status', NEW.status, 'balance', NEW.balance, 'amount', NEW.amount));
  END IF;
  RETURN NULL;
END;
$function$;

CREATE TRIGGER trg_log_store_credit_status
AFTER INSERT OR UPDATE OF status ON public.customer_store_credits
FOR EACH ROW EXECUTE FUNCTION public.log_store_credit_status_change();

-- 2. Repair: reactivate the two real credits that were expired with full
--    balance and zero redemptions (runs after the trigger, so the repair
--    itself is audited).
UPDATE customer_store_credits
SET status = 'active', updated_at = now()
WHERE credit_number IN ('SC-000009', 'SC-000017')
  AND status = 'expired'
  AND balance = amount
  AND NOT EXISTS (
    SELECT 1 FROM store_credit_redemptions r
    WHERE r.store_credit_id = customer_store_credits.id
  );
