/*
# Customer Advance Refunds

1. Purpose
   When a customer no longer wants to buy and asks for their advance money back,
   we need to refund it. This creates the table to track refunds and the accounting.

2. New Table
   - `customer_advance_refunds`: records each refund of an advance to a customer
     - id, tenant_id, advance_id, customer_id, amount, refund_method,
       refund_date, reference_number, notes, created_at

3. Accounting flow
   - Refunding an advance: Dr Customer Advances (2300)  Cr Cash/Bank
   - Done in frontend via journal entry post (same pattern as applications)

4. Security
   - RLS enabled, anon+authenticated full CRUD (matching customer_advances policies)
*/

CREATE TABLE IF NOT EXISTS customer_advance_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid,
  advance_id uuid NOT NULL REFERENCES customer_advances(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  amount numeric NOT NULL DEFAULT 0,
  refund_method text NOT NULL DEFAULT 'cash',
  refund_date date NOT NULL DEFAULT CURRENT_DATE,
  reference_number text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_advance_refunds_advance ON customer_advance_refunds(advance_id);
CREATE INDEX IF NOT EXISTS idx_advance_refunds_customer ON customer_advance_refunds(customer_id);

ALTER TABLE customer_advance_refunds ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "customer_advance_refunds_select" ON customer_advance_refunds;
CREATE POLICY "customer_advance_refunds_select" ON customer_advance_refunds FOR SELECT
  TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "customer_advance_refunds_insert" ON customer_advance_refunds;
CREATE POLICY "customer_advance_refunds_insert" ON customer_advance_refunds FOR INSERT
  TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "customer_advance_refunds_update" ON customer_advance_refunds;
CREATE POLICY "customer_advance_refunds_update" ON customer_advance_refunds FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "customer_advance_refunds_delete" ON customer_advance_refunds;
CREATE POLICY "customer_advance_refunds_delete" ON customer_advance_refunds FOR DELETE
  TO anon, authenticated USING (true);
