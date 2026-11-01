-- ============================================================================
-- Offline delivery edit: carry the invoice link and its lines
-- ============================================================================
-- sync_delivery_update ignored invoice_id (and customer_id) entirely, and the
-- client never sent them. An offline edit that re-pointed a challan at another
-- invoice therefore replayed as a no-op on the link: the delivery stayed on the
-- old invoice, and its delivery_items kept the old invoice's lines.
--
-- The client now sends invoice_id / customer_id and, when the link changes, the
-- new invoice's lines. This function:
--   * applies customer_id and invoice_id when the payload carries them
--     (absent = leave as-is, so an older queued edit cannot unlink anything);
--   * replaces delivery_items only when the link actually changed, reading the
--     lines from invoice_items on the server (authoritative — the invoice may
--     have been edited between queueing and replay);
--   * leaves the rows alone otherwise, because edit_invoice owns them.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.sync_delivery_update(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_d deliveries%ROWTYPE;
  v_new_invoice uuid;
  v_new_customer uuid;
BEGIN
  SELECT * INTO v_d FROM deliveries WHERE id = (p_payload->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'delivery.update: delivery not found';
  END IF;

  IF COALESCE((p_payload->>'force')::boolean, false) = false
     AND p_payload ? 'expected_updated_at'
     AND p_payload->>'expected_updated_at' <> ''
     AND v_d.updated_at <> (p_payload->>'expected_updated_at')::timestamptz THEN
    RETURN jsonb_build_object(
      'status', 'conflict',
      'reason', 'Delivery changed on the server since this device last saw it',
      'server_row', to_jsonb(v_d)
    );
  END IF;

  v_new_invoice := CASE WHEN p_payload ? 'invoice_id'
                        THEN NULLIF(p_payload->>'invoice_id', '')::uuid
                        ELSE v_d.invoice_id END;
  v_new_customer := CASE WHEN p_payload ? 'customer_id'
                         THEN NULLIF(p_payload->>'customer_id', '')::uuid
                         ELSE v_d.customer_id END;

  UPDATE deliveries SET
    delivery_date    = NULLIF(p_payload->>'delivery_date', '')::date,
    delivery_address = NULLIF(p_payload->>'delivery_address', ''),
    delivery_city    = NULLIF(p_payload->>'delivery_city', ''),
    vehicle_number   = NULLIF(p_payload->>'vehicle_number', ''),
    notes            = NULLIF(p_payload->>'notes', ''),
    customer_id      = COALESCE(v_new_customer, customer_id),
    invoice_id       = v_new_invoice,
    updated_at       = now()
  WHERE id = v_d.id;

  -- Re-link: the challan follows its invoice, so its lines are the new
  -- invoice's. Replace, never append.
  IF v_new_invoice IS DISTINCT FROM v_d.invoice_id THEN
    DELETE FROM delivery_items WHERE delivery_id = v_d.id;
    IF v_new_invoice IS NOT NULL THEN
      INSERT INTO delivery_items (delivery_id, product_id, quantity, delivered_quantity, unit_name)
      SELECT v_d.id, product_id, quantity, quantity, unit_name
      FROM invoice_items WHERE invoice_id = v_new_invoice;
    END IF;
  END IF;

  RETURN jsonb_build_object('status', 'synced', 'delivery_id', v_d.id,
                            'invoice_id', v_new_invoice);
END;
$function$;
