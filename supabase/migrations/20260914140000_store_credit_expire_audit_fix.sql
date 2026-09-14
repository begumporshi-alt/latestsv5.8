-- Fix: the store-credit audit trigger (20260913130000) wrote auth.uid() into
-- activity_logs.user_id, whose FK targets profiles(id) — an empty table.
-- Every authenticated status change (Expire button online, queued
-- store_credit.expire at sync time, credit issuance) aborted with:
--   insert or update on table "activity_logs" violates foreign key
--   constraint "activity_logs_user_id_fkey"
-- Migration-time writes only ever worked because psql runs as postgres
-- (no JWT → auth.uid() is NULL → FK passes with NULL).
--
-- Same precedent as journal_hardening (20260906110000: journal_entries
-- .created_by stays NULL by design) and the payments.created_by fix
-- (20260903100200): keep the FK column NULL, carry the actor in metadata.
--
-- The deeper enabler — profiles has no rows and auth.users has no
-- handle_new_user trigger — is left as an owner decision, because backfill
-- means assigning roles (permissions) to the two existing accounts.

CREATE OR REPLACE FUNCTION public.log_store_credit_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO activity_logs (user_id, action, entity_type, entity_id, entity_label, metadata)
    VALUES (NULL, 'store_credit.create', 'store_credit', NEW.id,
            'Store credit ' || NEW.credit_number || ' issued (' || NEW.status || ')',
            jsonb_build_object('credit_number', NEW.credit_number, 'amount', NEW.amount,
                               'status', NEW.status, 'auth_uid', auth.uid()::text));
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO activity_logs (user_id, action, entity_type, entity_id, entity_label, metadata)
    VALUES (NULL, 'store_credit.' || NEW.status, 'store_credit', NEW.id,
            'Store credit ' || NEW.credit_number || ': ' || OLD.status || ' → ' || NEW.status,
            jsonb_build_object('credit_number', NEW.credit_number, 'old_status', OLD.status,
                               'new_status', NEW.status, 'balance', NEW.balance, 'amount', NEW.amount,
                               'auth_uid', auth.uid()::text));
  END IF;
  RETURN NULL;
END;
$function$;

DO $$
BEGIN
  RAISE NOTICE 'store_credit_expire_audit_fix: trigger now writes NULL user_id + auth_uid in metadata';
END $$;
