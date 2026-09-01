-- ============================================================
-- Migration: Cost price ratchet on purchases
-- Date: 2026-09-01
-- Purpose:
--   Replace the weighted-average cost_price policy with a
--   "ratchet up" policy: products.cost_price updates ONLY when the
--   incoming batch unit cost is HIGHER than the current cost price,
--   and it becomes exactly that unit cost. The cost price therefore
--   tracks the highest purchase price ever paid and never decreases.
--
--   Previous behaviour (20260829120000): every INSERT into
--   inventory_batches overwrote cost_price with the weighted average
--   of all open batches (SUM(unit_cost * qty_remaining) / SUM(qty_remaining)).
--
--   Rules:
--     - Fires on INSERT into inventory_batches only (same trigger as before).
--     - Skips audit rows (quantity_remaining <= 0, e.g. stock reductions).
--     - Skips sales-return restocks (batch_type = 'return'): returned stock
--       comes back at its original batch cost and must not raise the cost
--       basis — a return is not a purchase.
--     - Opening/adjustment batches follow the same rule; the UI flows behind
--       them (product form, CSV import) write the same form cost into
--       products first, so there the gate is a no-op.
--     - unit_cost is guaranteed to be in BASE units by the BEFORE INSERT
--       trigger trg_check_batch_unit_cost (check_batch_unit_cost_is_base_unit),
--       so the comparison against products.cost_price is like-for-like.
--     - Manual cost edits on the products page keep working and persist
--       until a higher-priced purchase arrives.
--
--   Deliberately NOT done:
--     - No backfill: this is a forward-looking policy change ("from now
--       on"); existing cost prices stay exactly as they are.
--     - Function name/signature intentionally unchanged (CREATE OR REPLACE,
--       same OID) so the existing trigger and any out-of-band references
--       keep working. The name is historical — it no longer computes a
--       weighted average.
-- ============================================================

CREATE OR REPLACE FUNCTION update_weighted_average_cost()
RETURNS TRIGGER AS $$
DECLARE
  v_current_cost numeric(15,2);
BEGIN
  -- Audit rows from stock reductions insert negative quantity_remaining.
  IF NEW.quantity_remaining IS NULL OR NEW.quantity_remaining <= 0 THEN
    RETURN NEW;
  END IF;

  -- Sales-return restocks: never raise the cost basis.
  IF NEW.batch_type = 'return' THEN
    RETURN NEW;
  END IF;

  SELECT p.cost_price
  INTO v_current_cost
  FROM products p
  WHERE p.id = NEW.product_id;

  -- Ratchet: only a strictly higher incoming unit cost updates the product
  -- cost, and it becomes exactly that cost. Equal or cheaper stock leaves
  -- the current cost price untouched.
  IF COALESCE(NEW.unit_cost, 0) > COALESCE(v_current_cost, 0) THEN
    UPDATE products
    SET cost_price = ROUND(NEW.unit_cost, 2)
    WHERE id = NEW.product_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_update_weighted_average_cost ON inventory_batches;
CREATE TRIGGER trg_update_weighted_average_cost
  AFTER INSERT ON inventory_batches
  FOR EACH ROW
  EXECUTE FUNCTION update_weighted_average_cost();
