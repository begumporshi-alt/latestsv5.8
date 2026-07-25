/*
# Customer Advances System

1. Purpose
   Customers sometimes pay money in advance before receiving goods/services.
   This creates a liability (we owe them goods or a refund) until the advance
   is applied to an invoice. This migration creates the tables, sequences,
   accounting account, and triggers to record, track, and apply advances.

2. New Tables
   - `customer_advances`: records each advance receipt (money in from customer, no invoice yet)
     - id, tenant_id, advance_number (ADV-000001), customer_id, amount, balance,
       status (active/applied/expired/refunded), payment_method, payment_date,
       reference_number, notes, created_at, updated_at
   - `customer_advance_applications`: records each application of an advance to an invoice
     - id, tenant_id, advance_id, customer_id, invoice_id, amount, notes, created_at

3. New Sequences
   - `customer_advance_seq` for ADV-###### numbers

4. New Functions
   - `generate_advance_number()` → 'ADV-000001' style numbers
   - `advance_receipt_accounting_trigger()` → posts journal entry on advance insert:
       Debit Cash/Bank (from payment method), Credit Customer Advances Payable (2300)

5. New Account
   - 2300 'Customer Advances' (liability) — where unearned customer money sits

6. Accounting flow
   - Recording an advance:  Dr Cash/Bank   Cr Customer Advances (2300)
   - Applying to an invoice: Dr Customer Advances (2300)  Cr Accounts Receivable (1100)
     (done in frontend via post_journal_entry RPC)

7. Security
   - RLS enabled on both new tables, anon+authenticated full CRUD (single-tenant ERP pattern,
     matching existing customer_store_credits policies)

8. Customer balance integration
   - When an advance is recorded, the customer's advance_balance is NOT counted as
     outstanding (it's money we owe, not money they owe). The customer's outstanding_balance
     is unaffected by advances. Advances are tracked separately and surfaced in the UI.
*/

-- ============================================================
-- Account 2300: Customer Advances (liability)
-- ============================================================
INSERT INTO accounts (code, name, account_type, balance, is_active, is_cash, is_bank)
SELECT '2300', 'Customer Advances', 'liability', 0, true, false, false
WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE code = '2300');

-- ============================================================
-- Sequence + number generator
-- ============================================================
CREATE SEQUENCE IF NOT EXISTS customer_advance_seq START 1;

CREATE OR REPLACE FUNCTION generate_advance_number()
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  next_val bigint;
BEGIN
  SELECT nextval('customer_advance_seq') INTO next_val;
  RETURN 'ADV-' || lpad(next_val::text, 6, '0');
END;
$$;

-- ============================================================
-- Table: customer_advances
-- ============================================================
CREATE TABLE IF NOT EXISTS customer_advances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid,
  advance_number text NOT NULL,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  amount numeric NOT NULL DEFAULT 0,
  balance numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  payment_method text NOT NULL DEFAULT 'cash',
  payment_date date NOT NULL DEFAULT CURRENT_DATE,
  reference_number text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_advances_customer ON customer_advances(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_advances_status ON customer_advances(status);
CREATE INDEX IF NOT EXISTS idx_customer_advances_number ON customer_advances(advance_number);

ALTER TABLE customer_advances ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "customer_advances_select" ON customer_advances;
CREATE POLICY "customer_advances_select" ON customer_advances FOR SELECT
  TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "customer_advances_insert" ON customer_advances;
CREATE POLICY "customer_advances_insert" ON customer_advances FOR INSERT
  TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "customer_advances_update" ON customer_advances;
CREATE POLICY "customer_advances_update" ON customer_advances FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "customer_advances_delete" ON customer_advances;
CREATE POLICY "customer_advances_delete" ON customer_advances FOR DELETE
  TO anon, authenticated USING (true);

-- ============================================================
-- Table: customer_advance_applications
-- ============================================================
CREATE TABLE IF NOT EXISTS customer_advance_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid,
  advance_id uuid NOT NULL REFERENCES customer_advances(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount numeric NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_advance_applications_advance ON customer_advance_applications(advance_id);
CREATE INDEX IF NOT EXISTS idx_advance_applications_invoice ON customer_advance_applications(invoice_id);
CREATE INDEX IF NOT EXISTS idx_advance_applications_customer ON customer_advance_applications(customer_id);

ALTER TABLE customer_advance_applications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "customer_advance_applications_select" ON customer_advance_applications;
CREATE POLICY "customer_advance_applications_select" ON customer_advance_applications FOR SELECT
  TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "customer_advance_applications_insert" ON customer_advance_applications;
CREATE POLICY "customer_advance_applications_insert" ON customer_advance_applications FOR INSERT
  TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "customer_advance_applications_update" ON customer_advance_applications;
CREATE POLICY "customer_advance_applications_update" ON customer_advance_applications FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "customer_advance_applications_delete" ON customer_advance_applications;
CREATE POLICY "customer_advance_applications_delete" ON customer_advance_applications FOR DELETE
  TO anon, authenticated USING (true);

-- ============================================================
-- Trigger: auto-generate advance number on insert
-- ============================================================
CREATE OR REPLACE FUNCTION set_advance_number()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.advance_number IS NULL OR NEW.advance_number = '' THEN
    NEW.advance_number := generate_advance_number();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_advance_number ON customer_advances;
CREATE TRIGGER trg_set_advance_number
  BEFORE INSERT ON customer_advances
  FOR EACH ROW EXECUTE FUNCTION set_advance_number();

-- ============================================================
-- Trigger: accounting on advance receipt
-- When an advance is recorded: Dr Cash/Bank, Cr Customer Advances (2300)
-- ============================================================
CREATE OR REPLACE FUNCTION advance_receipt_accounting_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_advance_account uuid;
  v_cash_account uuid;
  v_payment_account uuid;
BEGIN
  SELECT id INTO v_advance_account FROM accounts WHERE code = '2300' LIMIT 1;
  IF v_advance_account IS NULL THEN
    RETURN NEW;
  END IF;

  -- Find the cash/bank account linked to this payment method
  SELECT pm.account_id INTO v_payment_account
  FROM payment_methods pm
  WHERE pm.code = NEW.payment_method AND pm.is_active = true
  LIMIT 1;

  IF v_payment_account IS NULL THEN
    SELECT id INTO v_cash_account FROM accounts WHERE code = '1001' LIMIT 1;
  ELSE
    v_cash_account := v_payment_account;
  END IF;

  IF v_cash_account IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM post_journal_entry(
    'Customer Advance - ' || NEW.advance_number,
    NEW.payment_date,
    'advance',
    NEW.id,
    json_build_array(
      json_build_object('account_id', v_cash_account, 'debit', NEW.amount, 'credit', 0, 'description', 'Advance received from customer - ' || NEW.advance_number),
      json_build_object('account_id', v_advance_account, 'debit', 0, 'credit', NEW.amount, 'description', 'Customer advance liability - ' || NEW.advance_number)
    )::json,
    NEW.customer_id
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_advance_accounting ON customer_advances;
CREATE TRIGGER trg_advance_accounting
  AFTER INSERT ON customer_advances
  FOR EACH ROW EXECUTE FUNCTION advance_receipt_accounting_trigger();
