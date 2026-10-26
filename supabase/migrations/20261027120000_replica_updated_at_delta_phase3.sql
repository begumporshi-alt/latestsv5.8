-- Replica delta coverage, phase 3: the last tables without a change cursor.
--
-- Every REPLICA_TABLES entry now has a delta fetch. These tables were the
-- remaining full-re-download-every-cycle set — inventory_batches (the whole
-- FIFO ledger, ~2.9k rows) being the expensive one: it was re-downloaded
-- whole on every replicateAll run, including after every applied outbox
-- change. With updated_at maintained by the shared touch_updated_at trigger
-- (20261002150000), each cycle only pulls rows changed since its cursor.
--
-- inventory_reconciliation_log is append-only, so it deltas by created_at
-- with no trigger. app_settings / bank_reconciliation_items have no
-- created_at — their backfill anchors at migration time (tiny tables).
--
-- Idempotent: IF NOT EXISTS / DROP TRIGGER IF EXISTS throughout.

ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE brands ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE categories ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE product_sizes ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE product_colors ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE unit_types ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE bank_reconciliation_items ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Anchor existing rows at their creation time so the first delta cursor
-- starts where the data started, not at migration time.
UPDATE inventory_batches SET updated_at = created_at;
UPDATE accounts SET updated_at = created_at;
UPDATE warehouses SET updated_at = created_at;
UPDATE brands SET updated_at = created_at;
UPDATE categories SET updated_at = created_at;
UPDATE product_sizes SET updated_at = created_at;
UPDATE product_colors SET updated_at = created_at;
UPDATE unit_types SET updated_at = created_at;
UPDATE app_settings SET updated_at = now();
UPDATE bank_reconciliation_items SET updated_at = now();

CREATE INDEX IF NOT EXISTS idx_inventory_batches_updated_at ON inventory_batches(updated_at);
CREATE INDEX IF NOT EXISTS idx_accounts_updated_at ON accounts(updated_at);
CREATE INDEX IF NOT EXISTS idx_warehouses_updated_at ON warehouses(updated_at);
CREATE INDEX IF NOT EXISTS idx_brands_updated_at ON brands(updated_at);
CREATE INDEX IF NOT EXISTS idx_categories_updated_at ON categories(updated_at);
CREATE INDEX IF NOT EXISTS idx_product_sizes_updated_at ON product_sizes(updated_at);
CREATE INDEX IF NOT EXISTS idx_product_colors_updated_at ON product_colors(updated_at);
CREATE INDEX IF NOT EXISTS idx_unit_types_updated_at ON unit_types(updated_at);
CREATE INDEX IF NOT EXISTS idx_bank_reconciliation_items_updated_at ON bank_reconciliation_items(updated_at);

DROP TRIGGER IF EXISTS trg_touch_inventory_batches ON inventory_batches;
CREATE TRIGGER trg_touch_inventory_batches BEFORE UPDATE ON inventory_batches FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
DROP TRIGGER IF EXISTS trg_touch_accounts ON accounts;
CREATE TRIGGER trg_touch_accounts BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
DROP TRIGGER IF EXISTS trg_touch_warehouses ON warehouses;
CREATE TRIGGER trg_touch_warehouses BEFORE UPDATE ON warehouses FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
DROP TRIGGER IF EXISTS trg_touch_brands ON brands;
CREATE TRIGGER trg_touch_brands BEFORE UPDATE ON brands FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
DROP TRIGGER IF EXISTS trg_touch_categories ON categories;
CREATE TRIGGER trg_touch_categories BEFORE UPDATE ON categories FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
DROP TRIGGER IF EXISTS trg_touch_product_sizes ON product_sizes;
CREATE TRIGGER trg_touch_product_sizes BEFORE UPDATE ON product_sizes FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
DROP TRIGGER IF EXISTS trg_touch_product_colors ON product_colors;
CREATE TRIGGER trg_touch_product_colors BEFORE UPDATE ON product_colors FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
DROP TRIGGER IF EXISTS trg_touch_unit_types ON unit_types;
CREATE TRIGGER trg_touch_unit_types BEFORE UPDATE ON unit_types FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
DROP TRIGGER IF EXISTS trg_touch_bank_reconciliation_items ON bank_reconciliation_items;
CREATE TRIGGER trg_touch_bank_reconciliation_items BEFORE UPDATE ON bank_reconciliation_items FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
DROP TRIGGER IF EXISTS trg_touch_app_settings ON app_settings;
CREATE TRIGGER trg_touch_app_settings BEFORE UPDATE ON app_settings FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
DROP TRIGGER IF EXISTS trg_touch_purchase_reminders ON purchase_reminders;
CREATE TRIGGER trg_touch_purchase_reminders BEFORE UPDATE ON purchase_reminders FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
DROP TRIGGER IF EXISTS trg_touch_payment_methods ON payment_methods;
CREATE TRIGGER trg_touch_payment_methods BEFORE UPDATE ON payment_methods FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
