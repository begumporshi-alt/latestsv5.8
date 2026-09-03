-- Fix cancel_invoice (3rd stale-schema statement found while cancelling
-- INV-940649, a paid invoice): the payment-reversal loop runs
--   UPDATE payments SET is_reversed = true, updated_at = now()
-- but payments has no updated_at column, so every cancellation of an
-- invoice with a non-reversed payment aborts with
--   column "updated_at" of relation "payments" does not exist
-- (single-transaction function → clean rollback, no partial state).
-- The earlier INV-940647 cancellation passed only because that husk had
-- no payments to loop over.
--
-- Fix: add the column rather than re-declaring the 200-line function.
-- payments is genuinely mutated (is_reversed flips on cancellation), and
-- invoices / customers / customer_advances all carry updated_at already;
-- this brings payments in line and records when a payment was reversed.
-- Existing rows backfill with the default (their creation-era timestamp).

BEGIN;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN public.payments.updated_at IS
  'Last modification (e.g. is_reversed flip by cancel_invoice); defaults to creation time';

COMMIT;
