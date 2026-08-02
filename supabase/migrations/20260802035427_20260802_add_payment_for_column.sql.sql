/*
# Add payment_for column to payments table

1. New Columns
- `payments.payment_for` (text, nullable) — Categorizes what a payment is for.
  Values: 'invoice_payment', 'advance', 'bad_debt', 'manual_receivable', 'supplier_payment', 'other'.
  This helps track collected amount breakdowns in the Invoices page and Collection Report page.

2. Backfill
- Existing payments get a sensible default based on their current `reference_type` and `bad_debt_amount`:
  - reference_type = 'invoice' and bad_debt_amount > 0 → 'invoice_payment' (the payment portion; bad debt is tracked separately)
  - reference_type = 'receivable' → 'manual_receivable'
  - reference_type = 'purchase_order' or 'grn' → 'supplier_payment'
  - everything else → 'other'

3. Security
- No RLS policy changes. The column is covered by existing payment policies.

4. Important Notes
- The column is nullable so old code that doesn't set it still works.
- New payments should set this field for better reporting.
*/

ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_for text;

-- Backfill existing rows
UPDATE payments SET payment_for = 'invoice_payment'
WHERE payment_for IS NULL AND reference_type = 'invoice';

UPDATE payments SET payment_for = 'manual_receivable'
WHERE payment_for IS NULL AND reference_type = 'receivable';

UPDATE payments SET payment_for = 'supplier_payment'
WHERE payment_for IS NULL AND reference_type IN ('purchase_order', 'grn');

UPDATE payments SET payment_for = 'other'
WHERE payment_for IS NULL;
