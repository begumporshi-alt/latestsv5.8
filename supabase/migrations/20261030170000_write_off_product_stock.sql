-- 2026-10-30: Write off a product's remaining stock in one transaction.
--
-- Context: deleting a product only flips products.is_active. Its FIFO layers,
-- inventory_items counters and GL balance (1200) stay behind, so a deleted
-- product keeps carrying value that the inventory page no longer shows.
-- Deleting 31 products left BDT 59,165 of layers with no UI to clear them.
--
-- create_stock_reduction() already consumes layers oldest-first and posts the
-- layer-accurate journal entry (Dr 3900 Opening Balance Equity / Cr 1200
-- Inventory, per the 2026-09-07 owner decision), but it deliberately does NOT
-- touch inventory_items or stock_movements — every caller is expected to do
-- that itself. Doing it from the browser would mean three ungrouped writes
-- with no rollback, so it lives here instead: one function call, one
-- transaction.
--
-- WHY LAYER QTY DRIVES THE REDUCTION, NOT ON-HAND
-- The two sides of the ledger can disagree. One deleted product in this
-- database carries 300 units / 21,660 in positive layers with an on-hand
-- counter of ZERO, so a counter-driven write-off would skip it and leave the
-- value — and the GL balance — behind. Each pair therefore reduces by its
-- positive layer quantity (exactly, so create_stock_reduction never has a
-- shortfall and never fabricates a negative IOU layer), while the counter is
-- zeroed separately.
--
-- Quantity is aggregated per (product, warehouse) rather than per
-- inventory_items row, because the page's stock figures are built the same
-- way (pair_stock in get_inventory_page_aggregates). Variant rows for the same
-- pair therefore collapse into a single reduction and cannot consume the same
-- layers twice.
--
-- Re-running is a no-op: pairs with no positive counter and no positive layer
-- are skipped, so a double click or a retried request cannot write the same
-- stock off twice.

BEGIN;

CREATE OR REPLACE FUNCTION write_off_product_stock(
  p_product_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_tenant_id uuid;
  v_product_name text;
  v_product_sku text;
  v_cost_price numeric;
  v_notes text;
  v_ref_number text;
  v_pair RECORD;
  v_pair_count integer := 0;
  v_total_qty numeric := 0;
  v_total_layers numeric := 0;
  v_pairs jsonb := '[]'::jsonb;
BEGIN
  SELECT tenant_id, name, sku, COALESCE(cost_price, 0)
    INTO v_tenant_id, v_product_name, v_product_sku, v_cost_price
  FROM products
  WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product % not found', p_product_id;
  END IF;

  v_notes := 'Stock write-off'
    || CASE WHEN p_reason IS NULL OR btrim(p_reason) = '' THEN '' ELSE ' — ' || btrim(p_reason) END;
  v_ref_number := 'WO-' || to_char(CURRENT_DATE, 'YYYYMMDD') || '-' || COALESCE(v_product_sku, substring(p_product_id::text, 1, 8));

  FOR v_pair IN
    WITH onhand AS (
      SELECT warehouse_id, SUM(quantity_on_hand)::numeric AS q
      FROM inventory_items
      WHERE product_id = p_product_id
      GROUP BY warehouse_id
    ), layers AS (
      SELECT warehouse_id, SUM(quantity_remaining)::numeric AS q
      FROM inventory_batches
      WHERE product_id = p_product_id
        AND quantity_remaining > 0
      GROUP BY warehouse_id
    ), pairs AS (
      SELECT warehouse_id FROM onhand WHERE q <> 0
      UNION
      SELECT warehouse_id FROM layers WHERE q > 0
    )
    SELECT pr.warehouse_id,
           GREATEST(COALESCE(o.q, 0), 0) AS on_hand,
           COALESCE(l.q, 0) AS layer_qty
    FROM pairs pr
    LEFT JOIN onhand o ON o.warehouse_id = pr.warehouse_id
    LEFT JOIN layers l ON l.warehouse_id = pr.warehouse_id
    WHERE GREATEST(COALESCE(o.q, 0), 0) > 0 OR COALESCE(l.q, 0) > 0
    ORDER BY pr.warehouse_id
  LOOP
    -- 1. Consume the positive layers exactly and post the journal entry at
    --    their true value. No shortfall => no negative IOU batch is created.
    IF v_pair.layer_qty > 0 THEN
      PERFORM create_stock_reduction(
        p_product_id     => p_product_id,
        p_warehouse_id   => v_pair.warehouse_id,
        p_quantity       => v_pair.layer_qty,
        p_unit_cost      => v_cost_price,
        p_reference_type => 'stock_writeoff',
        p_reference_id   => p_product_id,
        p_notes          => v_notes,
        p_tenant_id      => v_tenant_id
      );
    END IF;

    -- 2. Zero the counter rows for this pair (variants included).
    UPDATE inventory_items
    SET quantity_on_hand = 0,
        updated_at = now()
    WHERE product_id = p_product_id
      AND warehouse_id = v_pair.warehouse_id
      AND quantity_on_hand <> 0;

    -- 3. Record the movement so the write-off is visible in Inventory → Movements.
    INSERT INTO stock_movements (
      tenant_id, product_id, warehouse_id, movement_type, quantity,
      unit_cost, reference_type, reference_id, reference_number, notes, created_at
    ) VALUES (
      v_tenant_id, p_product_id, v_pair.warehouse_id, 'adjustment',
      -GREATEST(v_pair.on_hand, v_pair.layer_qty),
      v_cost_price, 'stock_writeoff', p_product_id, v_ref_number, v_notes, now()
    );

    v_pair_count := v_pair_count + 1;
    v_total_qty := v_total_qty + GREATEST(v_pair.on_hand, v_pair.layer_qty);
    v_total_layers := v_total_layers + v_pair.layer_qty;
    v_pairs := v_pairs || jsonb_build_object(
      'warehouse_id', v_pair.warehouse_id,
      'on_hand', v_pair.on_hand,
      'layer_quantity', v_pair.layer_qty
    );
  END LOOP;

  RETURN jsonb_build_object(
    'product_id', p_product_id,
    'product_name', v_product_name,
    'warehouse_count', v_pair_count,
    'quantity', v_total_qty,
    'layer_quantity', v_total_layers,
    'warehouses', v_pairs
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION write_off_product_stock(uuid, text) TO authenticated;

COMMENT ON FUNCTION write_off_product_stock IS
  'Zeroes a product''s stock across warehouses: consumes positive FIFO layers via create_stock_reduction (Dr 3900 / Cr 1200), clears inventory_items and records an adjustment movement. Clears ledger drift in both directions. Idempotent.';

COMMIT;
