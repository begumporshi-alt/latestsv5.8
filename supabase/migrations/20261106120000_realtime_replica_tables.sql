-- Realtime for the tables the offline replica mirrors.
--
-- The client has subscribed to Postgres changes for these tables since
-- lib/offline/realtime.ts was written, but only `notifications` was ever added
-- to the `supabase_realtime` publication (20261018210000_notifications.sql).
-- Postgres streams WAL changes only for publication members, so every one of
-- those subscriptions was dead: a sale, a GRN or a price change on one terminal
-- reached the others through the replica cycle alone — the POS's own ten-minute
-- refresh, or an hourly full pass. That is the "new sale price takes ten
-- minutes" behaviour.
--
-- Payloads are never read by the client: the handler takes the table name and
-- re-pulls the rows itself (so nothing depends on REPLICA IDENTITY or on row
-- width), which is why the default replica identity is sufficient here.
--
-- The list must stay in step with WATCHED_TABLES in lib/offline/realtime.ts.
-- Adding a table there without adding it here is silent: the subscription is
-- accepted and simply never fires. Removing one here only costs latency, never
-- correctness, because the replica cycle still converges every table.

DO $$
DECLARE
  t text;
BEGIN
  -- A bare Postgres (a scratch database, a CI container) has no Supabase
  -- Realtime publication. Skip rather than fail the migration there.
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RAISE NOTICE 'supabase_realtime publication not present — skipping';
    RETURN;
  END IF;

  FOREACH t IN ARRAY ARRAY[
    -- Goods receipt and its downstream effects
    'goods_receipt_notes',
    'stock_movements',
    'inventory_items',
    'inventory_batches',
    'purchase_order_items',
    'purchase_orders',
    'purchase_reminders',
    -- GL
    'journal_entries',
    'journal_lines',
    'accounts',
    -- Catalog and pricing (cost ratchet, sale-price push-down to the units)
    'products',
    'product_units',
    -- Sales path: keeps the POS catalogue and the oversell gate honest
    'invoices',
    'invoice_items',
    'payments',
    'customers',
    'suppliers',
    -- Advance wallets the POS spends from in "advance balance first" mode
    'customer_advances'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END
$$;
