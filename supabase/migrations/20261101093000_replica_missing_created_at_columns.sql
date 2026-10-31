-- Replica delta support for the remaining line tables whose delta cursor
-- points at a column that does not exist.
--
-- Found by auditing every replica spec against the live schema on 2026-11-01.
-- Four tables declare `delta: gt('created_at', cursor)` but have no created_at
-- column, so the delta query can never run, no cursor is ever stored, and
-- every refresh falls back to a full replace:
--
--   journal_lines                 16,931 rows
--   quotation_items                1,486 rows
--   delivery_items                   756 rows
--   inventory_reconciliation_log      62 rows
--
-- journal_lines is the expensive one: every online write schedules a refresh,
-- and that refresh re-downloads and re-encrypts all 16,931 rows instead of the
-- two lines the write actually added.
--
-- Two of the four are not append-only, so created_at would be the wrong cursor
-- even once it exists:
--   * delivery_items.delivered_quantity is UPDATEd in place by the delivery
--     flow -> updated_at + touch trigger, and the replica spec switches to it.
--   * quotation_items are edited by delete+reinsert (the pending overlay has a
--     replaceParent effect for them), so created_at is correct there.
--
-- Backfills use the parent document's timestamp so the first delta run starts
-- at the real history instead of treating the whole table as new.
--
-- Idempotent: IF NOT EXISTS / DROP TRIGGER IF EXISTS throughout.

-- ---- journal_lines: append-only, created_at from the journal entry --------
ALTER TABLE journal_lines ADD COLUMN IF NOT EXISTS created_at timestamptz;
UPDATE journal_lines jl
   SET created_at = je.created_at
  FROM journal_entries je
 WHERE je.id = jl.journal_entry_id
   AND jl.created_at IS NULL;
UPDATE journal_lines SET created_at = now() WHERE created_at IS NULL;
ALTER TABLE journal_lines ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE journal_lines ALTER COLUMN created_at SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_journal_lines_created_at ON journal_lines(created_at);

-- ---- quotation_items: delete+reinsert on edit, created_at from quotation --
ALTER TABLE quotation_items ADD COLUMN IF NOT EXISTS created_at timestamptz;
UPDATE quotation_items qi
   SET created_at = q.created_at
  FROM quotations q
 WHERE q.id = qi.quotation_id
   AND qi.created_at IS NULL;
UPDATE quotation_items SET created_at = now() WHERE created_at IS NULL;
ALTER TABLE quotation_items ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE quotation_items ALTER COLUMN created_at SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_quotation_items_created_at ON quotation_items(created_at);

-- ---- delivery_items: delivered_quantity is updated in place ---------------
ALTER TABLE delivery_items ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_delivery_items_updated_at ON delivery_items(updated_at);
DROP TRIGGER IF EXISTS trg_touch_delivery_items ON delivery_items;
CREATE TRIGGER trg_touch_delivery_items
  BEFORE UPDATE ON delivery_items
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---- inventory_reconciliation_log: append-only, own checked_at ------------
ALTER TABLE inventory_reconciliation_log ADD COLUMN IF NOT EXISTS created_at timestamptz;
UPDATE inventory_reconciliation_log SET created_at = checked_at WHERE created_at IS NULL;
UPDATE inventory_reconciliation_log SET created_at = now() WHERE created_at IS NULL;
ALTER TABLE inventory_reconciliation_log ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE inventory_reconciliation_log ALTER COLUMN created_at SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inventory_reconciliation_log_created_at
  ON inventory_reconciliation_log(created_at);
