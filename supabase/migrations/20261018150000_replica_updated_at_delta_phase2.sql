-- Replica delta support, phase 2: bring every mutable replica table under the
-- updated_at cursor so lib/offline/replica.ts can fetch only changed rows.
--
-- Phase 1 (20261002150000) covered products, invoices, invoice_items,
-- payments and inventory_items. The remaining replica tables fell into two
-- groups:
--
-- 1. Tables WITH an updated_at column but NO trigger — any code path that
--    forgot to set updated_at manually would go invisible to the delta
--    cursor. Gets the touch_updated_at() trigger + an index on updated_at:
--    customers, suppliers, profiles, quotations, purchase_orders, deliveries,
--    online_orders, projects, customer_store_credits.
--
-- 2. Tables with NO updated_at column at all — gets the column (backfilled
--    from created_at so the first delta run does not surface the whole table
--    as changed), the trigger, and the index:
--    employees, attendance, product_units, sales_returns, purchase_returns,
--    goods_receipt_notes.
--
-- Append-only line-item/ledger tables (quotation_items, purchase_order_items,
-- delivery_items, sales_return_items, purchase_return_items, journal_entries,
-- journal_lines, customer_notes, store_credit_redemptions,
-- customer_advance_refunds, customer_advance_applications) replicate by
-- created_at and need no schema change.
--
-- Idempotent: IF NOT EXISTS / DROP TRIGGER IF EXISTS throughout.

-- ---- Group 2: new columns -------------------------------------------------

ALTER TABLE employees ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE product_units ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE sales_returns ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE purchase_returns ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE goods_receipt_notes ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE employees SET updated_at = created_at WHERE updated_at <> created_at;
UPDATE attendance SET updated_at = created_at WHERE updated_at <> created_at;
UPDATE product_units SET updated_at = created_at WHERE updated_at <> created_at;
UPDATE sales_returns SET updated_at = created_at WHERE updated_at <> created_at;
UPDATE purchase_returns SET updated_at = created_at WHERE updated_at <> created_at;
UPDATE goods_receipt_notes SET updated_at = created_at WHERE updated_at <> created_at;

-- ---- Indexes --------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_customers_updated_at ON customers(updated_at);
CREATE INDEX IF NOT EXISTS idx_suppliers_updated_at ON suppliers(updated_at);
CREATE INDEX IF NOT EXISTS idx_profiles_updated_at ON profiles(updated_at);
CREATE INDEX IF NOT EXISTS idx_quotations_updated_at ON quotations(updated_at);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_updated_at ON purchase_orders(updated_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_updated_at ON deliveries(updated_at);
CREATE INDEX IF NOT EXISTS idx_online_orders_updated_at ON online_orders(updated_at);
CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects(updated_at);
CREATE INDEX IF NOT EXISTS idx_customer_store_credits_updated_at ON customer_store_credits(updated_at);
CREATE INDEX IF NOT EXISTS idx_employees_updated_at ON employees(updated_at);
CREATE INDEX IF NOT EXISTS idx_attendance_updated_at ON attendance(updated_at);
CREATE INDEX IF NOT EXISTS idx_product_units_updated_at ON product_units(updated_at);
CREATE INDEX IF NOT EXISTS idx_sales_returns_updated_at ON sales_returns(updated_at);
CREATE INDEX IF NOT EXISTS idx_purchase_returns_updated_at ON purchase_returns(updated_at);
CREATE INDEX IF NOT EXISTS idx_goods_receipt_notes_updated_at ON goods_receipt_notes(updated_at);

-- ---- Triggers (touch_updated_at() defined in 20261002150000) --------------

DROP TRIGGER IF EXISTS trg_touch_customers ON customers;
CREATE TRIGGER trg_touch_customers BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_suppliers ON suppliers;
CREATE TRIGGER trg_touch_suppliers BEFORE UPDATE ON suppliers FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_profiles ON profiles;
CREATE TRIGGER trg_touch_profiles BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_quotations ON quotations;
CREATE TRIGGER trg_touch_quotations BEFORE UPDATE ON quotations FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_purchase_orders ON purchase_orders;
CREATE TRIGGER trg_touch_purchase_orders BEFORE UPDATE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_deliveries ON deliveries;
CREATE TRIGGER trg_touch_deliveries BEFORE UPDATE ON deliveries FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_online_orders ON online_orders;
CREATE TRIGGER trg_touch_online_orders BEFORE UPDATE ON online_orders FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_projects ON projects;
CREATE TRIGGER trg_touch_projects BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_customer_store_credits ON customer_store_credits;
CREATE TRIGGER trg_touch_customer_store_credits BEFORE UPDATE ON customer_store_credits FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_employees ON employees;
CREATE TRIGGER trg_touch_employees BEFORE UPDATE ON employees FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_attendance ON attendance;
CREATE TRIGGER trg_touch_attendance BEFORE UPDATE ON attendance FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_product_units ON product_units;
CREATE TRIGGER trg_touch_product_units BEFORE UPDATE ON product_units FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_sales_returns ON sales_returns;
CREATE TRIGGER trg_touch_sales_returns BEFORE UPDATE ON sales_returns FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_purchase_returns ON purchase_returns;
CREATE TRIGGER trg_touch_purchase_returns BEFORE UPDATE ON purchase_returns FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_goods_receipt_notes ON goods_receipt_notes;
CREATE TRIGGER trg_touch_goods_receipt_notes BEFORE UPDATE ON goods_receipt_notes FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
