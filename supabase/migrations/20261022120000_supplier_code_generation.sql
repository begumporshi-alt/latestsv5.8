-- ============================================================================
-- Auto-generated supplier codes (SUP-000001, ...)
-- ----------------------------------------------------------------------------
-- Mirror of the customer pattern (20260712115412): a dedicated sequence plus
-- a SECURITY DEFINER generator callable as an RPC. Existing supplier codes
-- are freeform text (00999, sup001, 878, ...), so the SUP-000001 format
-- cannot collide and the sequence starts at 1 without syncing.
-- ============================================================================

CREATE SEQUENCE IF NOT EXISTS supplier_seq START 1;

CREATE OR REPLACE FUNCTION generate_supplier_code()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN 'SUP-' || LPAD(nextval('supplier_seq')::TEXT, 6, '0');
END;
$$;
