-- Replica delta coverage, follow-up to phase 3: customer_advances was the one
-- REPLICA_TABLES entry still re-downloaded whole on every replicateAll run
-- (lib/offline/replica.ts). The table already carries updated_at
-- (20260725042341) and every writer sets it explicitly (apply/refund RPCs in
-- 20260911130000 / 20260926120000, the advances page), so the replica can
-- delta by it. Rows are edited in place — balance/status change on apply,
-- refund and invoice cancel — so created_at alone would miss those edits.
--
-- The shared touch_updated_at trigger (20261002150000) keeps updated_at
-- correct for any future writer that forgets to set it.
--
-- Idempotent: IF NOT EXISTS / DROP TRIGGER IF EXISTS.

CREATE INDEX IF NOT EXISTS idx_customer_advances_updated_at ON customer_advances(updated_at);

DROP TRIGGER IF EXISTS trg_touch_customer_advances ON customer_advances;
CREATE TRIGGER trg_touch_customer_advances BEFORE UPDATE ON customer_advances FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
