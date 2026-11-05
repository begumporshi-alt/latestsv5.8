\set ON_ERROR_STOP on
BEGIN;
\i supabase/migrations/20261105150000_receive_grn_selected_unit_prices.sql

CREATE FUNCTION pg_temp.test_grn_unit_price(
  p_case text,
  p_purchase_unit text,
  p_conv numeric,
  p_initial_cost numeric,
  p_initial_sale numeric,
  p_po_cost numeric,
  p_discount numeric,
  p_po_sale numeric,
  p_force_cost boolean,
  p_expected_base_cost numeric,
  p_expected_base_sale numeric,
  p_expected_coil_cost numeric,
  p_expected_coil_sale numeric
) RETURNS void LANGUAGE plpgsql AS $test$
DECLARE
  v_product uuid;
  v_po uuid;
  v_po_item uuid;
  v_warehouse uuid;
  v_result json;
  v_batch record;
BEGIN
  SELECT id INTO v_warehouse FROM warehouses WHERE is_default AND is_active LIMIT 1;
  IF v_warehouse IS NULL THEN
    RAISE EXCEPTION 'No active default warehouse available for GRN test';
  END IF;

  INSERT INTO products (name, sku, unit, base_unit, enable_multi_unit, cost_price, sale_price)
  VALUES ('GRN unit price test ' || p_case, 'GRN-UNIT-' || p_case, 'Meter', 'Meter', true, p_initial_cost, p_initial_sale)
  RETURNING id INTO v_product;

  INSERT INTO product_units (product_id, unit_name, conversion_factor, is_base_unit, is_sale_unit, price, cost_price, sort_order, is_active)
  VALUES
    (v_product, 'Meter', 1, true, false, p_initial_sale, p_initial_cost, 0, true),
    (v_product, 'coil', 100, false, true, p_initial_sale * 100, p_initial_cost * 100, 1, true);

  INSERT INTO purchase_orders (po_number, supplier_id, order_date, status, total_amount)
  VALUES ('GRN-UNIT-' || p_case, (SELECT id FROM suppliers LIMIT 1), CURRENT_DATE, 'approved', p_po_cost)
  RETURNING id INTO v_po;

  INSERT INTO purchase_order_items (
    purchase_order_id, product_id, quantity, unit_cost, discount_percent,
    unit_name, unit_conversion_factor, base_quantity, sale_price, force_cost_update
  ) VALUES (
    v_po, v_product, 1, p_po_cost, p_discount,
    p_purchase_unit, p_conv, p_conv, p_po_sale, p_force_cost
  ) RETURNING id INTO v_po_item;

  SELECT receive_grn(
    p_supplier_id := (SELECT supplier_id FROM purchase_orders WHERE id = v_po),
    p_purchase_order_id := v_po,
    p_warehouse_id := v_warehouse,
    p_items := json_build_array(json_build_object(
      'po_item_id', v_po_item::text,
      'product_id', v_product::text,
      'quantity', 1,
      'unit_cost', p_po_cost,
      'unit_name', p_purchase_unit
    ))
  ) INTO v_result;

  IF (SELECT cost_price FROM products WHERE id = v_product) IS DISTINCT FROM p_expected_base_cost THEN
    RAISE EXCEPTION '%: wrong master cost; expected %', p_case, p_expected_base_cost;
  END IF;
  IF (SELECT sale_price FROM products WHERE id = v_product) IS DISTINCT FROM p_expected_base_sale THEN
    RAISE EXCEPTION '%: wrong master sale; expected %', p_case, p_expected_base_sale;
  END IF;
  IF (SELECT cost_price FROM product_units WHERE product_id = v_product AND is_base_unit) IS DISTINCT FROM p_expected_base_cost
     OR (SELECT price FROM product_units WHERE product_id = v_product AND is_base_unit) IS DISTINCT FROM p_expected_base_sale THEN
    RAISE EXCEPTION '%: base unit row does not mirror the master', p_case;
  END IF;
  IF (SELECT cost_price FROM product_units WHERE product_id = v_product AND unit_name = 'coil') IS DISTINCT FROM p_expected_coil_cost
     OR (SELECT price FROM product_units WHERE product_id = v_product AND unit_name = 'coil') IS DISTINCT FROM p_expected_coil_sale THEN
    RAISE EXCEPTION '%: wrong coil prices; expected cost % and sale %', p_case, p_expected_coil_cost, p_expected_coil_sale;
  END IF;

  SELECT quantity_received, unit_cost INTO v_batch
  FROM inventory_batches
  WHERE reference_id = (v_result->>'grn_id')::uuid AND product_id = v_product;
  IF v_batch.quantity_received IS DISTINCT FROM p_conv
     OR v_batch.unit_cost IS DISTINCT FROM ROUND(p_po_cost * (1 - p_discount / 100) / p_conv, 2) THEN
    RAISE EXCEPTION '%: batch was not normalized to base units', p_case;
  END IF;

  RAISE NOTICE 'PASS %: master %/%, coil %/%, batch qty % cost %',
    p_case, p_expected_base_cost, p_expected_base_sale,
    p_expected_coil_cost, p_expected_coil_sale, v_batch.quantity_received, v_batch.unit_cost;
END;
$test$;

DO $$
BEGIN
  -- 1 coil = 100 Meter: entered prices stay on coil and convert onto Meter.
  PERFORM pg_temp.test_grn_unit_price('HIGH', 'coil', 100, 4, 5, 500, 0, 600, false, 5, 6, 500, 600);

  -- The discounted coil cost is 495; the sale price remains 600 per coil.
  PERFORM pg_temp.test_grn_unit_price('DISCOUNT', 'coil', 100, 4, 5, 550, 10, 600, false, 4.95, 6, 495, 600);

  -- A cheaper receipt changes sale prices but not cost without Cost Upd.
  PERFORM pg_temp.test_grn_unit_price('LOWER-UNFORCED', 'coil', 100, 5, 6, 400, 0, 550, false, 5, 5.5, 500, 550);

  -- Cost Upd allows the cheaper receipt to replace both cost rows.
  PERFORM pg_temp.test_grn_unit_price('LOWER-FORCED', 'coil', 100, 5, 6, 400, 0, 550, true, 4, 5.5, 400, 550);

  -- Base-unit purchases retain their previous behavior.
  PERFORM pg_temp.test_grn_unit_price('BASE', 'Meter', 1, 4, 5, 5, 0, 6, false, 5, 6, 500, 600);
END;
$$;

ROLLBACK;
