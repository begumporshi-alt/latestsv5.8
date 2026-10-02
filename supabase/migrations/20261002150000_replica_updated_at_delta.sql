-- Replica delta support: maintain updated_at on the editable tables.
--
-- The offline replica (lib/offline/replica.ts) keeps a full local copy of the
-- core tables and re-downloaded them completely on every refresh (~19 MB per
-- run). Insert-only tables now replicate by a created_at cursor; the editable
-- tables need an updated_at column that is current no matter which code path
-- writes the row, so the replica can fetch only rows changed since its last
-- refresh.
--
-- - updated_at added to invoice_items and payments (products, invoices and
--   inventory_items already have it), with a DEFAULT now() for inserts.
-- - Backfill: existing invoice_items rows take their parent invoice's
--   created_at, payments rows take their own created_at — so the first delta
--   run after this migration does not surface the whole table as "changed".
-- - touch_updated_at() + a BEFORE UPDATE trigger on each of the five tables,
--   so ANY update (app code, RPC function, repair script) refreshes the
--   timestamp. This also fixes paths that previously forgot to set
--   updated_at manually.
-- - Index on updated_at so the replica's `updated_at > cursor` scans stay
--   cheap.
--
-- The BEFORE UPDATE trigger does not interfere with the app's
-- expected_updated_at optimistic-locking checks: those compare the stored
-- value before the UPDATE fires, and the trigger only rewrites NEW inside it.
-- New columns have defaults, so existing INSERT column lists are unaffected.
-- Idempotent: IF NOT EXISTS / DROP TRIGGER IF EXISTS throughout.

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE payments ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE invoice_items ii SET updated_at = i.created_at FROM invoices i WHERE ii.invoice_id = i.id;
UPDATE payments SET updated_at = created_at;

CREATE INDEX IF NOT EXISTS idx_products_updated_at ON products(updated_at);
CREATE INDEX IF NOT EXISTS idx_invoices_updated_at ON invoices(updated_at);
CREATE INDEX IF NOT EXISTS idx_invoice_items_updated_at ON invoice_items(updated_at);
CREATE INDEX IF NOT EXISTS idx_payments_updated_at ON payments(updated_at);
CREATE INDEX IF NOT EXISTS idx_inventory_items_updated_at ON inventory_items(updated_at);

DROP TRIGGER IF EXISTS trg_touch_products ON products;
CREATE TRIGGER trg_touch_products BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_invoices ON invoices;
CREATE TRIGGER trg_touch_invoices BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_invoice_items ON invoice_items;
CREATE TRIGGER trg_touch_invoice_items BEFORE UPDATE ON invoice_items FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_payments ON payments;
CREATE TRIGGER trg_touch_payments BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_inventory_items ON inventory_items;
CREATE TRIGGER trg_touch_inventory_items BEFORE UPDATE ON inventory_items FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
