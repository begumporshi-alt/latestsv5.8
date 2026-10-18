-- ============================================================
-- OVERDUE INVOICE DAILY DIGEST
-- pg_cron job that runs at 02:00 UTC (08:00 Asia/Dhaka) and
-- posts one digest notification when unpaid invoices are past
-- due. Mirrors isInvoiceOverdue() in lib/format.ts: statuses
-- sent/partially_paid/overdue with due_date < today. Invoice
-- statuses are NOT flipped — the app computes overdue on the
-- fly and never stores 'overdue'.
-- ============================================================

-- Allow the new notification type
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('low_stock','new_order','payment_received','delivery_update','po_approval','overdue_digest'));

-- Seed app_settings with the exact defaults the Settings UI shows,
-- so the DB-side gate (missing key = enabled) never contradicts the
-- UI's overdueInvoices = false default. User-saved values win later.
INSERT INTO app_settings (setting_key, setting_value)
VALUES ('notifications', jsonb_build_object(
  'lowStock', true,
  'newOrders', true,
  'paymentReceived', true,
  'overdueInvoices', false,
  'deliveryUpdates', true,
  'poApprovals', true
))
ON CONFLICT (setting_key) DO NOTHING;

CREATE OR REPLACE FUNCTION notify_overdue_invoices()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count integer;
  v_unpaid numeric;
  v_oldest_days integer;
BEGIN
  IF NOT notification_enabled('overdueInvoices') THEN
    RETURN;
  END IF;

  SELECT count(*),
         coalesce(sum(i.total_amount - i.amount_paid), 0),
         coalesce(max(CURRENT_DATE - i.due_date), 0)
    INTO v_count, v_unpaid, v_oldest_days
  FROM invoices i
  WHERE i.status IN ('sent','partially_paid','overdue')
    AND i.due_date IS NOT NULL
    AND i.due_date < CURRENT_DATE;

  IF v_count = 0 THEN
    RETURN;
  END IF;

  PERFORM push_notification(
    'overdue_digest',
    'overdueInvoices',
    v_count || ' invoice' || CASE WHEN v_count > 1 THEN 's' ELSE '' END || ' overdue',
    '৳' || to_char(v_unpaid, 'FM999,999,990.00') || ' unpaid · oldest ' ||
    v_oldest_days || ' day' || CASE WHEN v_oldest_days > 1 THEN 's' ELSE '' END || ' past due',
    'report', NULL, '/accounting/aging',
    ARRAY['accountant','manager','super_admin'],
    NULL,
    20
  );
END;
$$;

-- Replace any previous schedule so re-applying is idempotent
SELECT cron.unschedule('overdue-invoice-digest')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'overdue-invoice-digest');

SELECT cron.schedule('overdue-invoice-digest', '0 2 * * *', $$SELECT notify_overdue_invoices()$$);
