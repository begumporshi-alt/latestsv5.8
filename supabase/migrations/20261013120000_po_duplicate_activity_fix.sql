-- Fix duplicate "Purchase order PO-X status: approved" activity entries.
--
-- log_activity() logged EVERY update on purchase_orders and embedded the
-- row's current status in the label, so (a) editing an already-approved
-- order re-logged "status: approved" and (b) setting a status the row
-- already had (double-click / replayed sync op) logged a second approval.
--
-- 1. Skip rows where nothing changed.
-- 2. Mention the status in the label only when it actually changed.
-- 3. Make sync_po_status a no-op when the status is already applied.
-- 4. Collapse existing duplicate log rows created within the same minute.

CREATE OR REPLACE FUNCTION log_activity()
RETURNS TRIGGER AS $$
DECLARE
  v_label TEXT;
  v_entity_type TEXT;
  v_action TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;

  v_action := CASE TG_OP
    WHEN 'INSERT' THEN 'create'
    WHEN 'UPDATE' THEN 'update'
    WHEN 'DELETE' THEN 'delete'
    ELSE TG_OP
  END;

  IF TG_TABLE_NAME = 'invoices' THEN
    v_entity_type := 'invoice';
    v_label := CASE
      WHEN TG_OP = 'INSERT' THEN 'Invoice ' || NEW.invoice_number || ' created'
      WHEN TG_OP = 'UPDATE' AND NEW.status = 'cancelled' THEN 'Invoice ' || NEW.invoice_number || ' cancelled'
      WHEN TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN 'Invoice ' || NEW.invoice_number || ' updated (' || NEW.status || ')'
      WHEN TG_OP = 'UPDATE' THEN 'Invoice ' || NEW.invoice_number || ' updated'
      ELSE 'Invoice deleted'
    END;
    v_action := CASE
      WHEN TG_OP = 'INSERT' THEN 'sale'
      WHEN TG_OP = 'UPDATE' AND NEW.status = 'cancelled' THEN 'cancel'
      ELSE 'update'
    END;
  ELSIF TG_TABLE_NAME = 'quotations' THEN
    v_entity_type := 'quotation';
    v_label := CASE
      WHEN TG_OP = 'INSERT' THEN 'Quotation ' || NEW.quote_number || ' created'
      WHEN TG_OP = 'UPDATE' AND NEW.status = 'converted' THEN 'Quotation ' || NEW.quote_number || ' converted to invoice'
      WHEN TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN 'Quotation ' || NEW.quote_number || ' status: ' || NEW.status
      WHEN TG_OP = 'UPDATE' THEN 'Quotation ' || NEW.quote_number || ' updated'
      ELSE 'Quotation deleted'
    END;
  ELSIF TG_TABLE_NAME = 'payments' THEN
    v_entity_type := CASE WHEN NEW.payment_type = 'received' THEN 'payment_received' ELSE 'purchase_order' END;
    v_label := 'Payment ' || NEW.payment_number || ' of ' || ROUND(NEW.amount::numeric, 2)::text || ' recorded';
    v_action := 'payment';
  ELSIF TG_TABLE_NAME = 'purchase_orders' THEN
    v_entity_type := 'purchase_order';
    v_label := CASE
      WHEN TG_OP = 'INSERT' THEN 'Purchase order ' || NEW.po_number || ' created'
      WHEN TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN 'Purchase order ' || NEW.po_number || ' status: ' || NEW.status
      WHEN TG_OP = 'UPDATE' THEN 'Purchase order ' || NEW.po_number || ' updated'
      ELSE 'Purchase order deleted'
    END;
    v_action := CASE WHEN TG_OP = 'INSERT' THEN 'purchase' ELSE 'update' END;
  ELSIF TG_TABLE_NAME = 'deliveries' THEN
    v_entity_type := 'delivery';
    v_label := CASE
      WHEN TG_OP = 'INSERT' THEN 'Delivery ' || NEW.delivery_number || ' created'
      WHEN TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN 'Delivery ' || NEW.delivery_number || ' status: ' || NEW.status
      WHEN TG_OP = 'UPDATE' THEN 'Delivery ' || NEW.delivery_number || ' updated'
      ELSE 'Delivery deleted'
    END;
    v_action := 'delivery';
  ELSIF TG_TABLE_NAME = 'customers' THEN
    v_entity_type := 'customer';
    v_label := CASE
      WHEN TG_OP = 'INSERT' THEN 'New customer: ' || NEW.name
      WHEN TG_OP = 'UPDATE' THEN 'Customer ' || NEW.name || ' updated'
      ELSE 'Customer deleted'
    END;
    v_action := CASE WHEN TG_OP = 'INSERT' THEN 'customer' ELSE 'update' END;
  ELSIF TG_TABLE_NAME = 'online_orders' THEN
    v_entity_type := 'online_order';
    v_label := CASE
      WHEN TG_OP = 'INSERT' THEN 'Online order ' || NEW.order_number || ' received'
      WHEN TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN 'Online order ' || NEW.order_number || ' status: ' || NEW.status
      WHEN TG_OP = 'UPDATE' THEN 'Online order ' || NEW.order_number || ' updated'
      ELSE 'Online order deleted'
    END;
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO activity_logs (tenant_id, action, entity_type, entity_id, entity_label)
  VALUES (
    '00000000-0000-0000-0000-000000000001',
    v_action,
    v_entity_type,
    CASE TG_OP WHEN 'DELETE' THEN OLD.id ELSE NEW.id END,
    v_label
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- sync_po_status: replays / duplicates of an already-applied status must not
-- touch the row (which would re-log activity and churn updated_at).
CREATE OR REPLACE FUNCTION public.sync_po_status(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_po     purchase_orders%rowtype;
  v_status text := p_payload->>'status';
BEGIN
  IF v_status IN ('received', 'partially_received') THEN
    RAISE EXCEPTION 'po.status: receiving stock must go through the GRN flow (it maintains FIFO batches and journals)';
  END IF;

  SELECT * INTO v_po FROM purchase_orders WHERE id = (p_payload->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'po.status: purchase order not found';
  END IF;

  IF v_po.status = v_status THEN
    RETURN jsonb_build_object('status', 'synced', 'po_id', v_po.id, 'po_status', v_status);
  END IF;

  IF COALESCE((p_payload->>'force')::boolean, false) = false
     AND p_payload ? 'expected_updated_at'
     AND p_payload->>'expected_updated_at' <> ''
     AND v_po.updated_at <> (p_payload->>'expected_updated_at')::timestamptz THEN
    RETURN jsonb_build_object(
      'status', 'conflict',
      'reason', 'Purchase order changed on the server since this device last saw it',
      'server_row', to_jsonb(v_po)
    );
  END IF;

  UPDATE purchase_orders SET status = v_status, updated_at = now() WHERE id = v_po.id;

  RETURN jsonb_build_object('status', 'synced', 'po_id', v_po.id, 'po_status', v_status);
END;
$$;

-- Collapse duplicates that already exist: identical action + label for the
-- same entity logged within one minute (keeps the earliest).
DELETE FROM activity_logs a
WHERE EXISTS (
  SELECT 1 FROM activity_logs b
  WHERE b.id <> a.id
    AND b.tenant_id = a.tenant_id
    AND b.entity_type = a.entity_type
    AND b.entity_id IS NOT DISTINCT FROM a.entity_id
    AND b.action = a.action
    AND b.entity_label IS NOT DISTINCT FROM a.entity_label
    AND (b.created_at, b.id) < (a.created_at, a.id)
    AND a.created_at - b.created_at < interval '1 minute'
);
