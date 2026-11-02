-- products.unit must always equal the base unit declared in product_units.
--
-- trg_normalize_product_unit (20260827001000) already enforces this, but only
-- on a write to products: it reads product_units as they were at that instant.
-- That makes the invariant order-dependent. The product form wrote the product
-- row first and the unit rows afterwards, so:
--
--   * on create  the trigger found no units and left products.unit at the
--     previously selected unit ('pcs') while base_unit became 'box';
--   * on edit    the trigger copied the PREVIOUS base unit back over the new
--     one in the same statement that set base_unit = 'box'.
--
-- The app now writes the unit rows first, but the invariant belongs in the
-- data layer: any other writer (import, RPC, repair script) must not be able
-- to split the two columns. This trigger closes the gap from the other side —
-- whenever the declared base row changes, products is corrected.

BEGIN;

CREATE OR REPLACE FUNCTION public.sync_product_unit_from_base_unit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_product_id uuid;
  v_base       text;
BEGIN
  v_product_id := COALESCE(NEW.product_id, OLD.product_id);

  -- Lowest conversion factor wins if a product ever ends up with two base
  -- rows; matches normalize_product_unit_to_base().
  SELECT pu.unit_name INTO v_base
  FROM product_units pu
  WHERE pu.product_id = v_product_id
    AND pu.is_base_unit
  ORDER BY pu.conversion_factor
  LIMIT 1;

  -- No declared base (all rows deleted, or a rewrite in progress) — leave
  -- products alone rather than blanking the unit.
  IF v_base IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE products p
     SET unit      = v_base,
         base_unit = v_base
   WHERE p.id = v_product_id
     AND p.enable_multi_unit
     AND (
       public.normalize_unit_name(p.unit) IS DISTINCT FROM public.normalize_unit_name(v_base)
       OR p.base_unit IS DISTINCT FROM v_base
     );

  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_sync_product_unit ON public.product_units;
CREATE TRIGGER trg_sync_product_unit
  AFTER INSERT OR UPDATE OR DELETE ON public.product_units
  FOR EACH ROW EXECUTE FUNCTION public.sync_product_unit_from_base_unit();

-- Backfill: any row that drifted before the form and the trigger were fixed.
UPDATE products p
   SET unit      = b.unit_name,
       base_unit = b.unit_name
  FROM product_units b
 WHERE b.product_id = p.id
   AND b.is_base_unit
   AND p.enable_multi_unit
   AND (
     public.normalize_unit_name(p.unit) IS DISTINCT FROM public.normalize_unit_name(b.unit_name)
     OR p.base_unit IS DISTINCT FROM b.unit_name
   );

COMMIT;
