-- ============================================================
-- NOTIFICATIONS
-- In-app notification feed for the header bell.
-- Rows are created only by SECURITY DEFINER trigger functions;
-- users see notifications addressed to them, to their role,
-- or broadcast to everyone (both targets NULL).
-- ============================================================

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  type text NOT NULL CHECK (type IN ('low_stock','new_order','payment_received','delivery_update','po_approval')),
  title text NOT NULL,
  body text,
  entity_type text,
  entity_id uuid,
  href text,
  target_role text,
  target_user_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notif_created ON notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS notif_target_user ON notifications(target_user_id) WHERE target_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS notif_target_role ON notifications(target_role) WHERE target_role IS NOT NULL;

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "notif_select" ON notifications;
CREATE POLICY "notif_select" ON notifications FOR SELECT TO authenticated USING (
  target_user_id = auth.uid()
  OR (target_role IS NOT NULL AND target_role IN (SELECT role FROM profiles WHERE id = auth.uid()))
  OR (target_user_id IS NULL AND target_role IS NULL)
);
-- No insert/update/delete policies: writes come from the SECURITY DEFINER
-- functions below, which run as the table owner and bypass RLS.

-- Per-user read state: one notification can reach several people and each
-- marks it read independently.
CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, user_id)
);

ALTER TABLE notification_reads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "nread_select" ON notification_reads;
CREATE POLICY "nread_select" ON notification_reads FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS "nread_insert" ON notification_reads;
CREATE POLICY "nread_insert" ON notification_reads FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "nread_delete" ON notification_reads;
CREATE POLICY "nread_delete" ON notification_reads FOR DELETE TO authenticated USING (user_id = auth.uid());

-- ============================================================
-- HELPERS
-- ============================================================

-- Reads a camelCase toggle from app_settings.notifications.
-- Missing row or missing key means enabled, so the feature works
-- before the user ever opens Settings.
CREATE OR REPLACE FUNCTION notification_enabled(p_key text)
RETURNS boolean
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT coalesce(
    (SELECT (setting_value ->> p_key)::boolean
     FROM app_settings WHERE setting_key = 'notifications'),
    true
  );
$$;

CREATE OR REPLACE FUNCTION push_notification(
  p_type text,           -- notifications.type value
  p_settings_key text,   -- matching camelCase key in app_settings.notifications
  p_title text,
  p_body text,
  p_entity_type text DEFAULT NULL,
  p_entity_id uuid DEFAULT NULL,
  p_href text DEFAULT NULL,
  p_roles text[] DEFAULT NULL,
  p_user_id uuid DEFAULT NULL,
  p_dedupe_hours integer DEFAULT 0
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role text;
BEGIN
  IF NOT notification_enabled(p_settings_key) THEN
    RETURN;
  END IF;

  -- Suppress repeats of the same alert about the same entity inside the
  -- dedupe window (used by low stock, where every movement re-crosses).
  IF p_dedupe_hours > 0 AND EXISTS (
    SELECT 1 FROM notifications
    WHERE type = p_type
      AND entity_id IS NOT DISTINCT FROM p_entity_id
      AND created_at > now() - make_interval(hours => p_dedupe_hours)
  ) THEN
    RETURN;
  END IF;

  IF p_user_id IS NOT NULL THEN
    INSERT INTO notifications (type, title, body, entity_type, entity_id, href, target_user_id)
    VALUES (p_type, p_title, p_body, p_entity_type, p_entity_id, p_href, p_user_id);
  END IF;

  IF p_roles IS NOT NULL THEN
    FOREACH v_role IN ARRAY p_roles LOOP
      INSERT INTO notifications (type, title, body, entity_type, entity_id, href, target_role)
      VALUES (p_type, p_title, p_body, p_entity_type, p_entity_id, p_href, v_role);
    END LOOP;
  END IF;
END;
$$;

-- ============================================================
-- EVENT TRIGGERS
-- ============================================================

-- Payment received (against an invoice) -> accountants + managers
CREATE OR REPLACE FUNCTION notify_payment_received()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_invoice_number text;
  v_customer_name text;
BEGIN
  IF NEW.payment_type <> 'received' OR NEW.reference_type <> 'invoice' THEN
    RETURN NEW;
  END IF;

  SELECT i.invoice_number, c.name
    INTO v_invoice_number, v_customer_name
  FROM invoices i
  LEFT JOIN customers c ON c.id = i.customer_id
  WHERE i.id = NEW.reference_id;

  PERFORM push_notification(
    'payment_received',
    'paymentReceived',
    'Payment received: ৳' || to_char(NEW.amount, 'FM999,999,990.00'),
    coalesce(v_customer_name, 'Customer') || ' — invoice ' || coalesce(v_invoice_number, NEW.reference_id::text),
    'payment', NEW.id, '/sales',
    ARRAY['accountant','manager','super_admin']
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_payment_received ON payments;
CREATE TRIGGER trg_notify_payment_received
  AFTER INSERT ON payments
  FOR EACH ROW EXECUTE FUNCTION notify_payment_received();

-- PO submitted for approval -> managers + super admin
CREATE OR REPLACE FUNCTION notify_po_pending_approval()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_supplier_name text;
BEGIN
  IF NEW.status <> 'pending_approval' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  SELECT name INTO v_supplier_name FROM suppliers WHERE id = NEW.supplier_id;

  PERFORM push_notification(
    'po_approval',
    'poApprovals',
    'PO ' || NEW.po_number || ' awaiting approval',
    'Supplier: ' || coalesce(v_supplier_name, '—') || ' · total ৳' || to_char(NEW.total_amount, 'FM999,999,990.00'),
    'purchase_order', NEW.id, '/purchases',
    ARRAY['manager','super_admin']
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_po_pending ON purchase_orders;
CREATE TRIGGER trg_notify_po_pending
  AFTER INSERT OR UPDATE OF status ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION notify_po_pending_approval();

-- Delivery outcome -> managers + super admin (deliveries.created_by is
-- NULL for all existing rows, so personal targeting would never fire)
CREATE OR REPLACE FUNCTION notify_delivery_status()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;
  IF NEW.status NOT IN ('delivered','failed','returned') THEN
    RETURN NEW;
  END IF;

  PERFORM push_notification(
    'delivery_update',
    'deliveryUpdates',
    'Delivery ' || NEW.delivery_number || ' ' || NEW.status,
    'Status: ' || NEW.status || coalesce(' · ' || NEW.delivery_address, ''),
    'delivery', NEW.id, '/delivery',
    ARRAY['manager','super_admin']
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_delivery_status ON deliveries;
CREATE TRIGGER trg_notify_delivery_status
  AFTER INSERT OR UPDATE OF status ON deliveries
  FOR EACH ROW EXECUTE FUNCTION notify_delivery_status();

-- New online store order -> managers + super admin
CREATE OR REPLACE FUNCTION notify_new_online_order()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM push_notification(
    'new_order',
    'newOrders',
    'New online order ' || NEW.order_number,
    NEW.customer_name || ' · ৳' || to_char(NEW.total_amount, 'FM999,999,990.00') || ' · ' || NEW.payment_method,
    'online_order', NEW.id, '/online-store',
    ARRAY['manager','super_admin']
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_new_online_order ON online_orders;
CREATE TRIGGER trg_notify_new_online_order
  AFTER INSERT ON online_orders
  FOR EACH ROW EXECUTE FUNCTION notify_new_online_order();

-- Low stock: every stock-writing path (POS deduction, GRN receipt, invoice
-- edit/cancel, transfers, corrections) updates inventory_items directly, so
-- that table is the single choke point where a level actually changes.
-- Compare total on hand across all warehouses against products.min_stock_level.
CREATE OR REPLACE FUNCTION notify_low_stock()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_min integer;
  v_total numeric;
  v_name text;
  v_sku text;
BEGIN
  SELECT min_stock_level, name, sku
    INTO v_min, v_name, v_sku
  FROM products WHERE id = NEW.product_id;

  IF v_min IS NULL OR v_min <= 0 THEN
    RETURN NEW;
  END IF;

  SELECT coalesce(sum(quantity_on_hand), 0) INTO v_total
  FROM inventory_items WHERE product_id = NEW.product_id;

  IF v_total <= v_min THEN
    PERFORM push_notification(
      'low_stock',
      'lowStock',
      'Low stock: ' || v_name,
      v_sku || ' — ' ||
      CASE WHEN v_total = floor(v_total)
           THEN floor(v_total)::integer::text
           ELSE round(v_total, 2)::text END ||
      ' on hand (minimum ' || v_min || ')',
      'product', NEW.product_id,
      '/inventory/' || NEW.product_id,
      ARRAY['inventory_manager','manager'],
      NULL,
      24
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_low_stock ON inventory_items;
CREATE TRIGGER trg_notify_low_stock
  AFTER INSERT OR UPDATE OF quantity_on_hand ON inventory_items
  FOR EACH ROW EXECUTE FUNCTION notify_low_stock();

-- ============================================================
-- REALTIME
-- Allow the browser clients to subscribe to new notifications.
-- ============================================================
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE notifications;
EXCEPTION
  WHEN duplicate_object THEN NULL;  -- already in the publication
END $$;
