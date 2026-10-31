-- Replica delta support for purchase_order_items.
--
-- Problem: the phase-2 migration (20261018150000) classified this table as
-- append-only — "replicates by created_at and needs no schema change". That
-- was wrong twice over:
--
--   1. The table has NO created_at column at all. The replica's delta query
--      (gt('created_at', cursor)) could therefore never succeed, so no cursor
--      was ever stored and every refresh re-downloaded the whole table.
--   2. The rows are not append-only either. purchase_order_items is UPDATEd by
--      receive_grn (received_quantity += qty), purchase returns
--      (received_quantity -= qty), IOU absorption, po_item_sale_price and
--      force_cost_update. Even with a created_at cursor those edits would have
--      been invisible: no new row, unchanged row count, so the count probe saw
--      a "consistent" table and the delta path was accepted. Offline, a
--      received PO kept showing received_quantity = 0 until the 24h full
--      replace.
--
-- Fix: give the table the updated_at contract every other mutable replica
-- table has — column, index, touch trigger — and switch the replica spec
-- (lib/offline/replica.ts) to the updated_at cursor.
--
-- No backfill from created_at is possible (the column does not exist). The
-- DEFAULT now() stamped by the ADD COLUMN is the correct starting cursor: the
-- first refresh after this migration takes the full-replace path anyway
-- because no cursor has been stored, and every subsequent edit is stamped by
-- the trigger.
--
-- Idempotent: IF NOT EXISTS / DROP TRIGGER IF EXISTS throughout.

ALTER TABLE purchase_order_items
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_purchase_order_items_updated_at
  ON purchase_order_items(updated_at);

DROP TRIGGER IF EXISTS trg_touch_purchase_order_items ON purchase_order_items;
CREATE TRIGGER trg_touch_purchase_order_items
  BEFORE UPDATE ON purchase_order_items
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

COMMENT ON COLUMN purchase_order_items.updated_at IS
  'Replica delta cursor. Maintained by trg_touch_purchase_order_items; the offline replica replicates this table by updated_at because GRNs and returns edit received_quantity in place.';
