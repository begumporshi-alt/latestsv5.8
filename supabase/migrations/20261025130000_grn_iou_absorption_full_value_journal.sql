-- 2026-10-25: GRN journal must post the FULL received value when the receipt
-- absorbs oversell IOU, and the FIFO batch must record gross quantity_received.
--
-- Problem (2026-10-25 audit): receive_grn absorbs negative IOU batches into the
-- receipt and inserts the new batch at the NET quantity (received 2, owed 3 →
-- batch of 0). post_grn_journal then values the GRN from
-- SUM(quantity_received * unit_cost) — i.e. the net. Two defects:
--   1. Receive exactly what is owed → net batch is 0 → journal amount 0 →
--      post_grn_journal skips ("no inventory batches") → NO journal entry at
--      all. The supplier must still be paid, so AP is never credited.
--   2. Partial absorption → AP credited net only (receive 5, owed 3, cost 3 →
--      AP 6 instead of 15). The batch also records quantity_received = 2 even
--      though 5 units physically arrived, so the FIFO ledger understates
--      receipts. And the oversell-time credit to Inventory (Cr 1200 by the IOU
--      value) is never reversed on the books.
--
-- Fix:
--   receive_grn: insert the new batch with quantity_received = GROSS and
--     quantity_remaining = net; accumulate, per receipt, the absorbed value at
--     the IOU batches' own cost (A) and at the receipt cost (R = absorbed x
--     unit_cost) and hand both to post_grn_journal.
--   post_grn_journal(p_grn_id, p_absorbed_value DEFAULT 0,
--                    p_absorbed_receipt_value DEFAULT 0):
--     G  = SUM(quantity_received * unit_cost)            -- gross received value
--     Dr 1200 (G - R + A)   -- ledger valuation gain: net receipt value + IOU reversal
--     Dr 3900 (R - A)       -- cost-basis correction when replenishing costed
--                             differently than the IOU was expensed (credit if negative)
--     Cr 2000 G             -- full supplier liability
--     When no IOU was absorbed (A = R = 0) this collapses to the classic
--     Dr 1200 G / Cr 2000 G, so plain receipts are unchanged.
--   receive_grn also honours the warehouse each PO line was raised for
--     ("Receive Into" on the PO form stamps purchase_order_items.warehouse_id):
--     the line's stock lands there instead of the GRN's default warehouse, so
--     a PO raised against a warehouse with an IOU actually heals that IOU.
--     The GRN header keeps the default warehouse unless every line landed in
--     the same one.
--   The purchase stock movement of an absorbing receipt carries the marker
--     "absorbed N base unit(s) of OVERSOLD IOU (net M added to stock)" — the
--     mirror of the sale-side "OVERSOLD by N" note; the movements page tooltip
--     already surfaces any note containing OVERSOLD.
--
-- No backfill needed: the only real GRN without a journal (GRN-261010042803218287)
-- received units at unit_cost 0, so skipping it was correct; IOU absorption only
-- shipped 2026-10-23 and its absorption tests ran in rolled-back transactions.

CREATE OR REPLACE FUNCTION public.receive_grn(p_supplier_id uuid, p_purchase_order_id uuid DEFAULT NULL::uuid, p_warehouse_id uuid DEFAULT NULL::uuid, p_items json DEFAULT NULL::json, p_notes text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid := '00000000-0000-0000-0000-000000000001';
  v_grn_id uuid := gen_random_uuid();
  v_grn_number text;
  v_wh uuid;
  v_item json;
  v_product_id uuid;
  v_po_item_id uuid;
  v_qty numeric;
  v_cost numeric;
  v_expiry date;
  v_item_wh uuid;
  v_poi_warehouse uuid;
  v_first_wh uuid;
  v_mixed_wh boolean := false;
  v_before_cost numeric;
  v_after_cost numeric;
  v_batch_cost numeric;
  v_force_cost boolean := false;
  v_poi_unit_cost numeric;
  v_poi_discount numeric;
  v_inv_item record;
  v_cost_updates jsonb := '[]'::jsonb;
  v_sale_updates jsonb := '[]'::jsonb;
  v_before_sale numeric;
  v_new_sale numeric;
  v_all_received boolean;
  v_some_received boolean;
  v_owed numeric;
  v_absorb_left numeric;
  v_absorbed numeric;
  v_take numeric;
  v_iou record;
  v_net_qty numeric;
  v_ledger_sum numeric;
  -- Absorption accounting (this GRN, all items):
  --   v_absorb_value          = absorbed units valued at the IOU batches' own cost
  --   v_absorb_receipt_value  = same units valued at this receipt's cost
  v_absorb_value numeric := 0;
  v_absorb_receipt_value numeric := 0;
BEGIN
  IF p_supplier_id IS NULL THEN
    RAISE EXCEPTION 'Supplier is required';
  END IF;
  IF p_items IS NULL OR json_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'At least one item with quantity > 0 is required';
  END IF;

  v_wh := COALESCE(
    p_warehouse_id,
    (SELECT id FROM warehouses WHERE is_default AND is_active LIMIT 1),
    (SELECT id FROM warehouses WHERE is_active LIMIT 1)
  );
  IF v_wh IS NULL THEN
    RAISE EXCEPTION 'No active warehouse available';
  END IF;

  v_grn_number := 'GRN-' || to_char(clock_timestamp(), 'YYMMDDHH24MISSUS');

  INSERT INTO goods_receipt_notes (id, tenant_id, grn_number, purchase_order_id, supplier_id,
                                   warehouse_id, received_date, status, notes)
  VALUES (v_grn_id, v_tenant, v_grn_number, p_purchase_order_id, p_supplier_id,
          v_wh, CURRENT_DATE, 'posted', p_notes);

  FOR v_item IN SELECT * FROM json_array_elements(p_items) LOOP
    v_qty := COALESCE((v_item->>'quantity')::numeric, 0);
    v_cost := COALESCE((v_item->>'unit_cost')::numeric, 0);
    v_expiry := (v_item->>'expiry_date')::date;
    v_product_id := (v_item->>'product_id')::uuid;
    v_po_item_id := NULLIF(v_item->>'po_item_id', '')::uuid;
    v_force_cost := false;
    IF v_qty <= 0 OR v_product_id IS NULL THEN
      CONTINUE;
    END IF;

    -- PO-based receipts cost what the PO line committed to: unit cost minus
    -- the line discount. The client sends the raw pre-discount unit_cost, so
    -- it is ignored here — otherwise batches, movements, and the cost ratchet
    -- all post at the undiscounted price.
    IF v_po_item_id IS NOT NULL THEN
      SELECT unit_cost, COALESCE(discount_percent, 0), warehouse_id
        INTO v_poi_unit_cost, v_poi_discount, v_poi_warehouse
      FROM purchase_order_items WHERE id = v_po_item_id;
      IF FOUND THEN
        v_cost := v_poi_unit_cost * (1 - v_poi_discount / 100);
      END IF;
    END IF;

    -- Each line lands in the warehouse it was raised for: explicit payload
    -- value, else the PO line's "Receive Into" warehouse, else the GRN's
    -- default. This is what makes a PO raised against a warehouse with an
    -- outstanding IOU actually heal that IOU.
    v_item_wh := COALESCE(
      NULLIF(v_item->>'warehouse_id', '')::uuid,
      v_poi_warehouse,
      v_wh
    );
    IF v_first_wh IS NULL THEN
      v_first_wh := v_item_wh;
    ELSIF v_first_wh IS DISTINCT FROM v_item_wh THEN
      v_mixed_wh := true;
    END IF;

    SELECT cost_price INTO v_before_cost FROM products WHERE id = v_product_id;

    -- Absorption math runs before the movement insert so the movement can
    -- carry the IOU marker (mirrors the sale-side "OVERSOLD by N" note).
    SELECT COALESCE(-SUM(quantity_remaining), 0) INTO v_owed
      FROM inventory_batches
     WHERE product_id = v_product_id AND warehouse_id = v_item_wh
       AND quantity_remaining < 0;
    v_absorbed := LEAST(v_owed, v_qty);
    v_net_qty := v_qty - v_absorbed;

    INSERT INTO stock_movements (tenant_id, product_id, warehouse_id, movement_type,
                                 quantity, unit_cost, reference_type, reference_id, reference_number, notes)
    VALUES (v_tenant, v_product_id, v_item_wh, 'purchase', v_qty, v_cost, 'grn', v_grn_id, v_grn_number,
            CASE WHEN v_absorbed > 0 THEN
              'Goods received — absorbed ' || trim_scale(v_absorbed) || ' base unit(s) of OVERSOLD IOU (net ' || trim_scale(v_net_qty) || ' added to stock)'
            ELSE NULL END);

    -- Absorb outstanding oversell IOU layers (negative FIFO-SHORTFALL batches)
    -- into this receipt: drive them back to 0, oldest first, and post the new
    -- batch net of what was owed. Batches and p_qty share the same base-unit
    -- convention, so the arithmetic is direct.
    IF v_absorbed > 0 THEN
      v_absorb_left := v_absorbed;
      FOR v_iou IN
        SELECT id, quantity_remaining, unit_cost
          FROM inventory_batches
         WHERE product_id = v_product_id AND warehouse_id = v_item_wh
           AND quantity_remaining < 0
         ORDER BY created_at ASC, id ASC
         FOR UPDATE
      LOOP
        EXIT WHEN v_absorb_left <= 0;
        v_take := LEAST(-v_iou.quantity_remaining, v_absorb_left);
        UPDATE inventory_batches
           SET quantity_remaining = quantity_remaining + v_take
         WHERE id = v_iou.id;
        v_absorb_value := v_absorb_value + v_take * COALESCE(v_iou.unit_cost, 0);
        v_absorb_receipt_value := v_absorb_receipt_value + v_take * v_cost;
        v_absorb_left := v_absorb_left - v_take;
      END LOOP;
    END IF;

    IF v_po_item_id IS NOT NULL THEN
      UPDATE purchase_order_items
      SET received_quantity = COALESCE(received_quantity, 0) + v_qty
      WHERE id = v_po_item_id;

      -- Push the PO line's intended sale price onto the product master.
      -- Only for PO-based receipts; direct GRNs never touch product prices.
      -- Changes are reported back so the client can confirm what was updated.
      v_new_sale := NULL;
      SELECT poi.sale_price, COALESCE(poi.force_cost_update, false)
        INTO v_new_sale, v_force_cost
      FROM purchase_order_items poi WHERE poi.id = v_po_item_id;
      IF v_new_sale IS NOT NULL THEN
        SELECT sale_price INTO v_before_sale FROM products WHERE id = v_product_id;
        UPDATE products SET sale_price = v_new_sale, updated_at = now()
        WHERE id = v_product_id AND sale_price IS DISTINCT FROM v_new_sale;
        IF FOUND THEN
          v_sale_updates := v_sale_updates || jsonb_build_object(
            'product_id', v_product_id,
            'name', (SELECT name FROM products p WHERE p.id = v_product_id),
            'before', COALESCE(v_before_sale, 0),
            'after', v_new_sale
          );
        END IF;
      END IF;
    END IF;

    -- FIFO layer with optional expiry_date. quantity_received keeps the GROSS
    -- physical receipt (what the supplier actually delivered — the FIFO page
    -- and batches modal display it); quantity_remaining carries the net after
    -- IOU absorption. RETURNING gives the batch's unit_cost after the
    -- base-unit normalization trigger ran, so the forced cost write below
    -- compares like-for-like with products.cost_price.
    INSERT INTO inventory_batches (tenant_id, product_id, variant_id, warehouse_id, batch_number,
                                   quantity_received, quantity_remaining, unit_cost, batch_type,
                                   reference_type, reference_id, reference_number, notes, expiry_date)
    VALUES (v_tenant, v_product_id, NULL, v_item_wh,
            v_grn_number || '-' || left(v_product_id::text, 8),
            v_qty, v_net_qty, v_cost, 'purchase',
            'grn', v_grn_id, v_grn_number, COALESCE(p_notes, 'Goods received via GRN'), v_expiry)
    RETURNING unit_cost INTO v_batch_cost;

    -- On-hand counter: resync from the batch ledger (source of truth) instead
    -- of blind-incrementing. This heals the floor-at-0 divergence from
    -- overselling and any legacy counter drift on every receipt.
    SELECT COALESCE(SUM(quantity_remaining), 0) INTO v_ledger_sum
      FROM inventory_batches
     WHERE product_id = v_product_id AND warehouse_id = v_item_wh;

    SELECT ii.id INTO v_inv_item
      FROM inventory_items ii
     WHERE ii.product_id = v_product_id AND ii.warehouse_id = v_item_wh
     LIMIT 1;
    IF v_inv_item.id IS NOT NULL THEN
      UPDATE inventory_items
      SET quantity_on_hand = v_ledger_sum, updated_at = now()
      WHERE id = v_inv_item.id;
    ELSE
      INSERT INTO inventory_items (tenant_id, product_id, warehouse_id, quantity_on_hand)
      VALUES (v_tenant, v_product_id, v_wh, v_ledger_sum);
    END IF;

    -- Forced cost override: set the master cost to the received cost even when
    -- it is lower than the current one (the ratchet trigger above only raises).
    IF v_force_cost THEN
      UPDATE products SET cost_price = ROUND(v_batch_cost, 2), updated_at = now()
      WHERE id = v_product_id AND cost_price IS DISTINCT FROM ROUND(v_batch_cost, 2);
    END IF;

    SELECT cost_price INTO v_after_cost FROM products WHERE id = v_product_id;
    IF v_force_cost THEN
      IF v_after_cost IS DISTINCT FROM COALESCE(v_before_cost, 0) THEN
        v_cost_updates := v_cost_updates || jsonb_build_object(
          'product_id', v_product_id,
          'name', (SELECT name FROM products p WHERE p.id = v_product_id),
          'before', COALESCE(v_before_cost, 0),
          'after', v_after_cost,
          'forced', true
        );
      END IF;
    ELSIF v_after_cost > COALESCE(v_before_cost, 0) THEN
      v_cost_updates := v_cost_updates || jsonb_build_object(
        'product_id', v_product_id,
        'name', (SELECT name FROM products p WHERE p.id = v_product_id),
        'before', COALESCE(v_before_cost, 0),
        'after', v_after_cost
      );
    END IF;
  END LOOP;

  -- Journal entry (idempotent per GRN). Absorption figures post the gross AP
  -- credit and the IOU cost-basis correction — see migration header.
  PERFORM post_grn_journal(v_grn_id, v_absorb_value, v_absorb_receipt_value);

  -- When every line landed in the same (non-default) warehouse, align the GRN
  -- header so the receipt displays where the goods actually went. Mixed-
  -- warehouse receipts keep the default warehouse on the header.
  IF NOT v_mixed_wh AND v_first_wh IS NOT NULL AND v_first_wh IS DISTINCT FROM v_wh THEN
    UPDATE goods_receipt_notes SET warehouse_id = v_first_wh WHERE id = v_grn_id;
  END IF;

  -- PO status recompute
  IF p_purchase_order_id IS NOT NULL THEN
    SELECT BOOL_AND(COALESCE(i.received_quantity, 0) >= i.quantity),
           BOOL_OR(COALESCE(i.received_quantity, 0) > 0)
      INTO v_all_received, v_some_received
    FROM purchase_order_items i
    WHERE i.purchase_order_id = p_purchase_order_id;

    UPDATE purchase_orders
    SET status = CASE
      WHEN COALESCE(v_all_received, false) THEN 'received'
      WHEN COALESCE(v_some_received, false) THEN 'partially_received'
      ELSE 'approved'
    END
    WHERE id = p_purchase_order_id;
  END IF;

  -- Auto-fulfill pending purchase reminders
  UPDATE purchase_reminders
  SET status = 'fulfilled', fulfilled_at = now(), fulfilled_by_grn_id = v_grn_id, updated_at = now()
  WHERE status = 'pending'
    AND product_id IN (SELECT (j->>'product_id')::uuid FROM json_array_elements(p_items) j);

  RETURN json_build_object('grn_id', v_grn_id, 'grn_number', v_grn_number,
                           'cost_updates', v_cost_updates, 'sale_price_updates', v_sale_updates);
END $function$;

CREATE OR REPLACE FUNCTION public.post_grn_journal(p_grn_id uuid, p_absorbed_value numeric DEFAULT 0, p_absorbed_receipt_value numeric DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_grn       goods_receipt_notes%ROWTYPE;
  v_total     numeric(15,2);
  v_net_value numeric(15,2);
  v_basis_adj numeric(15,2);
  v_inv_acct  uuid;
  v_ap_acct   uuid;
  v_equity_acct uuid;
  v_po_number text;
  v_je_id     uuid;
  v_lines     jsonb;
BEGIN
  SELECT * INTO v_grn FROM goods_receipt_notes WHERE id = p_grn_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('posted', false, 'reason', 'GRN not found');
  END IF;

  IF v_grn.status <> 'posted' THEN
    RETURN jsonb_build_object('posted', false, 'reason', 'GRN not posted');
  END IF;

  -- Idempotency: exactly one journal per GRN
  IF EXISTS (SELECT 1 FROM journal_entries
             WHERE reference_type = 'grn' AND reference_id = p_grn_id) THEN
    RETURN jsonb_build_object('posted', false, 'reason', 'journal already exists');
  END IF;

  -- Gross inventory value received in THIS GRN, from its own FIFO batches —
  -- never from cumulative PO received quantities. For IOU-absorbing receipts
  -- quantity_received is the GROSS physical receipt, so v_total is what the
  -- supplier must actually be paid.
  SELECT COALESCE(SUM(quantity_received * unit_cost), 0)
    INTO v_total
  FROM inventory_batches
  WHERE reference_type = 'grn' AND reference_id = p_grn_id;

  IF v_total <= 0 THEN
    RETURN jsonb_build_object('posted', false, 'reason', 'no inventory batches for this GRN');
  END IF;

  SELECT id INTO v_inv_acct FROM accounts WHERE code = '1200' LIMIT 1;
  SELECT id INTO v_ap_acct   FROM accounts WHERE code = '2000' LIMIT 1;
  IF v_inv_acct IS NULL OR v_ap_acct IS NULL THEN
    RETURN jsonb_build_object('posted', false, 'reason', 'accounts 1200/2000 not found');
  END IF;

  -- Absorbed oversell IOU: the receipt's Dr to Inventory is the LEDGER
  -- valuation gain (net receipt value + IOU reversal at the IOU batches' own
  -- cost), not the gross. The difference between the two cost bases lands on
  -- 3900 (equity — quantity corrections are not P&L), matching how the
  -- oversell itself was posted. With no absorption both adjustments are 0 and
  -- the entry collapses to Dr 1200 G / Cr 2000 G.
  v_net_value := v_total - p_absorbed_receipt_value + p_absorbed_value;
  v_basis_adj := p_absorbed_receipt_value - p_absorbed_value;

  IF ABS(v_basis_adj) > 0.0000001 THEN
    SELECT id INTO v_equity_acct FROM accounts WHERE code = '3900' LIMIT 1;
    IF v_equity_acct IS NULL THEN
      RETURN jsonb_build_object('posted', false, 'reason', 'account 3900 not found');
    END IF;
  END IF;

  v_lines := json_build_array(
    json_build_object('account_id', v_inv_acct, 'debit', v_net_value,
                      'description', 'Inventory received'),
    json_build_object('account_id', v_ap_acct, 'credit', v_total,
                      'description', 'Accounts Payable - goods received')
  );
  IF v_basis_adj > 0 THEN
    v_lines := v_lines || json_build_object('account_id', v_equity_acct, 'debit', v_basis_adj,
                'description', 'IOU absorption cost-basis correction')::jsonb;
  ELSIF v_basis_adj < 0 THEN
    v_lines := v_lines || json_build_object('account_id', v_equity_acct, 'credit', -v_basis_adj,
                'description', 'IOU absorption cost-basis correction')::jsonb;
  END IF;

  SELECT po_number INTO v_po_number
  FROM purchase_orders WHERE id = v_grn.purchase_order_id;

  v_je_id := post_journal_entry(
    p_description    := 'Goods Received - GRN #' || v_grn.grn_number
                        || COALESCE(' / PO #' || v_po_number, ''),
    p_entry_date     := COALESCE(v_grn.received_date, CURRENT_DATE),
    p_reference_type := 'grn',
    p_reference_id   := v_grn.id,
    p_lines          := v_lines::json,
    p_supplier_id    := v_grn.supplier_id
  );

  RETURN jsonb_build_object('posted', true, 'amount', v_total, 'je_id', v_je_id);
END;
$function$;

-- Repair pass for receipts posted BEFORE this fix: the old code set the batch
-- quantity_received to the NET, so an absorbing receipt is detectable as a
-- purchase movement whose quantity exceeds the GRN's batched received total
-- (false positives like multi-line same-product GRNs have recv >= movement and
-- are excluded). Such receipts under-credited AP by absorbed x cost — post the
-- supplemental Dr 1200 / Cr 2000 for the absorbed value and stamp the movement
-- note. Absorbed value uses the receipt cost; every real case so far had the
-- IOU batch cost equal to it, so no equity plug is needed here (the going-
-- forward RPC in this migration handles differing costs exactly).
DO $$
DECLARE
  v_mv record;
  v_grn goods_receipt_notes%ROWTYPE;
  v_recv_total numeric;
  v_absorbed numeric;
  v_cost numeric;
  v_value numeric(15,2);
  v_inv uuid; v_ap uuid;
  v_je_id uuid;
BEGIN
  SELECT id INTO v_inv FROM accounts WHERE code='1200' LIMIT 1;
  SELECT id INTO v_ap  FROM accounts WHERE code='2000' LIMIT 1;
  IF v_inv IS NULL OR v_ap IS NULL THEN RETURN; END IF;

  FOR v_mv IN
    SELECT m.*, g.grn_number, g.received_date, g.supplier_id
    FROM stock_movements m
    JOIN goods_receipt_notes g ON g.id = m.reference_id AND m.reference_type = 'grn'
    WHERE m.movement_type = 'purchase' AND m.notes IS NULL
      AND m.quantity > (
        SELECT COALESCE(SUM(b.quantity_received), 0)
        FROM inventory_batches b
        WHERE b.reference_type = 'grn' AND b.reference_id = m.reference_id AND b.product_id = m.product_id
      )
  LOOP
    SELECT COALESCE(SUM(b.quantity_received), 0) INTO v_recv_total
      FROM inventory_batches b
      WHERE b.reference_type = 'grn' AND b.reference_id = v_mv.reference_id AND b.product_id = v_mv.product_id;
    v_absorbed := v_mv.quantity - v_recv_total;
    SELECT b.unit_cost INTO v_cost
      FROM inventory_batches b
      WHERE b.reference_type = 'grn' AND b.reference_id = v_mv.reference_id
        AND b.product_id = v_mv.product_id AND b.batch_type = 'purchase'
      LIMIT 1;
    v_value := ROUND(COALESCE(v_cost, 0) * v_absorbed, 2);
    IF v_value <= 0 THEN CONTINUE; END IF;

    -- Idempotency: skip if a correction JE already exists for this movement
    IF EXISTS (SELECT 1 FROM journal_entries je
               WHERE je.reference_type = 'grn' AND je.reference_id = v_mv.reference_id
                 AND je.description LIKE '%IOU absorption AP correction%') THEN
      CONTINUE;
    END IF;

    v_je_id := post_journal_entry(
      p_description    := 'IOU absorption AP correction — GRN #' || v_mv.grn_number,
      p_entry_date     := COALESCE(v_mv.received_date, CURRENT_DATE),
      p_reference_type := 'grn',
      p_reference_id   := v_mv.reference_id,
      p_lines          := json_build_array(
        json_build_object('account_id', v_inv, 'debit', v_value, 'description', 'Inventory — absorbed oversold IOU'),
        json_build_object('account_id', v_ap, 'credit', v_value, 'description', 'Accounts Payable — absorbed oversold IOU')
      ),
      p_supplier_id    := v_mv.supplier_id
    );

    UPDATE stock_movements
      SET notes = 'Goods received — absorbed ' || trim_scale(v_absorbed) || ' base unit(s) of OVERSOLD IOU (net ' || trim_scale(v_recv_total) || ' added to stock)'
      WHERE id = v_mv.id;
  END LOOP;
END $$;
