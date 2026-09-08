-- Atomic quotation → invoice conversion.
--
-- The page previously performed 5 sequential writes (invoice header, items,
-- cost-price history, payment, quotation status). When the invoice_items
-- insert was rejected — e.g. by check_invoice_item_cost_scale, because the
-- page sent products.cost_price (BASE-unit cost) next to sale-unit
-- unit_price for multi-unit products — the already-committed header survived
-- as a husk with its trigger-posted AR journal entry (INV-940697, plus 19
-- manually-cancelled husks from QT-000038 between Sep 3 and Sep 8).
--
-- This RPC runs the whole conversion in one transaction and derives the
-- sale-unit cost server-side: product_units.cost_price for the item's unit
-- when present, else products.cost_price × the item's own conversion factor
-- — the same rule POS, the invoice modal and EditInvoiceModal already follow.

CREATE OR REPLACE FUNCTION convert_quotation_to_invoice(
  p_quotation_id uuid,
  p_options jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_quote quotations%ROWTYPE;
  v_invoice_id uuid;
  v_invoice_number text;
  v_invoice_date date := COALESCE(NULLIF(p_options->>'invoice_date', '')::date, CURRENT_DATE);
  v_payment_type text := COALESCE(NULLIF(p_options->>'payment_type', ''), 'credit');
  v_payment_method text := COALESCE(NULLIF(p_options->>'payment_method', ''), 'cash');
  v_amount_paid numeric;
  v_invoice_status text;
  v_pay_num text;
  v_item RECORD;
  v_cf numeric;
  v_cost numeric;
  v_shortfall_notes jsonb := COALESCE(p_options->'shortfall_notes', '{}'::jsonb);
  v_items_count int := 0;
BEGIN
  IF v_payment_type NOT IN ('credit', 'partial', 'full') THEN
    RAISE EXCEPTION 'Invalid payment type "%" (expected credit, partial or full)', v_payment_type;
  END IF;

  -- Lock the quotation so two tabs cannot double-convert concurrently.
  SELECT * INTO v_quote FROM quotations WHERE id = p_quotation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quotation not found';
  END IF;
  IF v_quote.status = 'converted' THEN
    RAISE EXCEPTION 'Quotation % is already converted', v_quote.quote_number;
  END IF;

  SELECT count(*) INTO v_items_count FROM quotation_items WHERE quotation_id = p_quotation_id;
  IF v_items_count = 0 THEN
    RAISE EXCEPTION 'Quotation % has no items to convert', v_quote.quote_number;
  END IF;

  -- Payment amount and resulting invoice status (same rules the modal had).
  v_amount_paid := CASE v_payment_type
    WHEN 'full'   THEN v_quote.total_amount
    WHEN 'credit' THEN 0
    ELSE COALESCE(NULLIF(p_options->>'amount_paid', '')::numeric, 0)
  END;
  IF v_payment_type = 'partial'
     AND (v_amount_paid <= 0 OR v_amount_paid >= v_quote.total_amount) THEN
    RAISE EXCEPTION 'Partial payment amount must be greater than 0 and less than the total amount (%)', v_quote.total_amount;
  END IF;
  v_invoice_status := CASE
    WHEN v_payment_type = 'full' THEN 'paid'
    WHEN v_payment_type = 'partial' AND v_amount_paid > 0 THEN 'partially_paid'
    WHEN v_payment_type = 'credit' THEN 'sent'
    ELSE 'draft'
  END;

  v_invoice_number := 'INV-' || LPAD(nextval('invoice_seq')::TEXT, 6, '0');

  INSERT INTO invoices (
    invoice_number, customer_id, quotation_id, invoice_date,
    subtotal, discount_amount, tax_amount, total_amount, amount_paid,
    status, is_pos, reference
  ) VALUES (
    v_invoice_number, v_quote.customer_id, p_quotation_id, v_invoice_date,
    v_quote.subtotal, v_quote.discount_amount, v_quote.tax_amount, v_quote.total_amount, v_amount_paid,
    v_invoice_status, false, v_quote.reference
  ) RETURNING id INTO v_invoice_id;

  -- Items go through the normal triggers (scale guard, consume_fifo, COGS
  -- journal). Cost is derived per item on the SALE-unit scale:
  -- product_units.cost_price is already per that unit; products.cost_price
  -- is per BASE unit and must be scaled by the item's own conversion factor
  -- (unit_conversion_factor, falling back to base_quantity / quantity for
  -- legacy rows that never stored one).
  FOR v_item IN
    SELECT qi.*,
           p.name AS p_name,
           p.cost_price AS p_cost,
           pu.cost_price AS pu_cost
      FROM quotation_items qi
      JOIN products p ON p.id = qi.product_id
      LEFT JOIN product_units pu
             ON pu.product_id = qi.product_id
            AND pu.is_sale_unit
            AND pu.unit_name = qi.unit_name
     WHERE qi.quotation_id = p_quotation_id
     ORDER BY qi.sort_order NULLS LAST, qi.id
  LOOP
    v_cf := COALESCE(
      NULLIF(v_item.unit_conversion_factor, 0),
      CASE WHEN COALESCE(v_item.quantity, 0) > 0 THEN v_item.base_quantity / v_item.quantity END,
      1);
    v_cost := COALESCE(
      NULLIF(v_item.pu_cost, 0),
      NULLIF(v_item.p_cost, 0) * v_cf,
      0);

    INSERT INTO invoice_items (
      invoice_id, product_id, quantity, unit_price, cost_price,
      discount_percent, tax_rate, subtotal,
      unit_name, unit_conversion_factor, base_quantity, description
    ) VALUES (
      v_invoice_id, v_item.product_id, v_item.quantity, v_item.unit_price, v_cost,
      COALESCE(v_item.discount_percent, 0), COALESCE(v_item.tax_rate, 0), v_item.subtotal,
      v_item.unit_name, v_item.unit_conversion_factor, COALESCE(v_item.base_quantity, v_item.quantity),
      v_shortfall_notes ->> (v_item.product_id::text)
    );

    INSERT INTO cost_price_history (
      product_id, product_name, product_sku, invoice_id,
      unit, quantity, unit_price,
      cost_price_per_qty, cost_price_for_added_qty,
      total_cost_price_single, total_cost_price_added
    ) VALUES (
      v_item.product_id, v_item.p_name, '', v_invoice_id,
      COALESCE(v_item.unit_name, 'pcs'), v_item.quantity, v_item.unit_price,
      v_cost, v_cost * v_item.quantity,
      v_cost, v_cost * v_item.quantity
    );
  END LOOP;

  IF v_amount_paid > 0 THEN
    SELECT 'PAY-' || LPAD((COALESCE(MAX(CAST(SUBSTRING(payment_number FROM 5) AS INTEGER)), 0) + 1)::TEXT, 6, '0')
      INTO v_pay_num
      FROM payments WHERE payment_number LIKE 'PAY-%';

    INSERT INTO payments (
      payment_number, payment_type, reference_type, reference_id, customer_id,
      amount, payment_method, payment_date, reference_number, notes, payment_for
    ) VALUES (
      v_pay_num, 'received', 'invoice', v_invoice_id, v_quote.customer_id,
      v_amount_paid, v_payment_method, v_invoice_date,
      NULLIF(p_options->>'reference_number', ''),
      COALESCE(NULLIF(p_options->>'notes', ''),
               CASE WHEN v_payment_type = 'full'
                    THEN 'Full payment at invoice conversion'
                    ELSE 'Partial payment at invoice conversion' END),
      'paid_invoice_pay'
    );
  END IF;

  UPDATE quotations
     SET status = 'converted',
         converted_to = v_invoice_id,
         updated_at = now()
   WHERE id = p_quotation_id;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_id', v_invoice_id,
    'invoice_number', v_invoice_number,
    'invoice_status', v_invoice_status,
    'amount_paid', v_amount_paid
  );
END $$;

GRANT EXECUTE ON FUNCTION convert_quotation_to_invoice(uuid, jsonb) TO authenticated;
