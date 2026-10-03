-- Public share links for quotations and invoices.
--
-- Each document can carry a random share_token. Anyone holding
-- /share/<token> can view a read-only print view of that single document
-- without logging in. Tokens are the capability: no token, no access.
--
-- RLS on quotations/invoices is authenticated-only, so the public page reads
-- through this SECURITY DEFINER RPC, which returns exactly one document for
-- an exact token match — anon callers never get table-level access, so they
-- cannot enumerate shared documents.
--
-- Revoke = set share_token back to NULL. The partial unique indexes keep
-- tokens unique among themselves while allowing unlimited NULLs.
-- Idempotent throughout.

ALTER TABLE quotations ADD COLUMN IF NOT EXISTS share_token text;
ALTER TABLE invoices  ADD COLUMN IF NOT EXISTS share_token text;

CREATE UNIQUE INDEX IF NOT EXISTS quotations_share_token_uidx
  ON quotations(share_token) WHERE share_token IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS invoices_share_token_uidx
  ON invoices(share_token) WHERE share_token IS NOT NULL;

CREATE OR REPLACE FUNCTION get_shared_document(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_q        quotations;
  v_i        invoices;
  v_company  jsonb;
  v_customer jsonb;
  v_items    jsonb;
BEGIN
  -- Tokens are url-safe base64; require a sane minimum length so the RPC
  -- cannot be probed with short/guessable values.
  IF p_token IS NULL OR length(p_token) < 20 OR p_token !~ '^[A-Za-z0-9_-]+$' THEN
    RETURN NULL;
  END IF;

  SELECT setting_value INTO v_company FROM app_settings WHERE setting_key = 'company';

  SELECT * INTO v_q FROM quotations WHERE share_token = p_token;
  IF FOUND THEN
    SELECT jsonb_build_object('name', c.name, 'code', c.code, 'phone', c.phone, 'address', c.address)
      INTO v_customer
      FROM customers c
      WHERE c.id = v_q.customer_id;

    SELECT jsonb_agg(jsonb_build_object(
             'product_name',     COALESCE(NULLIF(trim(pr.name), ''), 'Item'),
             'product_sku',      pr.sku,
             'quantity',         qi.quantity,
             'unit_price',       qi.unit_price,
             'discount_percent', qi.discount_percent,
             'subtotal',         qi.subtotal
           ) ORDER BY qi.sort_order, qi.id)
      INTO v_items
      FROM quotation_items qi
      LEFT JOIN products pr ON pr.id = qi.product_id
      WHERE qi.quotation_id = v_q.id;

    RETURN jsonb_build_object(
      'type',     'QUOTATION',
      'document', to_jsonb(v_q) - 'share_token',
      'customer', v_customer,
      'items',    COALESCE(v_items, '[]'::jsonb),
      'company',  v_company
    );
  END IF;

  SELECT * INTO v_i FROM invoices WHERE share_token = p_token;
  IF FOUND THEN
    SELECT jsonb_build_object('name', c.name, 'code', c.code, 'phone', c.phone, 'address', c.address)
      INTO v_customer
      FROM customers c
      WHERE c.id = v_i.customer_id;

    SELECT jsonb_agg(jsonb_build_object(
             'product_name',     COALESCE(NULLIF(trim(pr.name), ''), 'Item'),
             'product_sku',      pr.sku,
             'quantity',         ii.quantity,
             'unit_price',       ii.unit_price,
             'discount_percent', ii.discount_percent,
             'subtotal',         ii.subtotal
           ) ORDER BY ii.sort_order, ii.id)
      INTO v_items
      FROM invoice_items ii
      LEFT JOIN products pr ON pr.id = ii.product_id
      WHERE ii.invoice_id = v_i.id;

    RETURN jsonb_build_object(
      'type',     'INVOICE',
      'document', to_jsonb(v_i) - 'share_token',
      'customer', v_customer,
      'items',    COALESCE(v_items, '[]'::jsonb),
      'company',  v_company
    );
  END IF;

  RETURN NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION get_shared_document(text) TO anon, authenticated;
