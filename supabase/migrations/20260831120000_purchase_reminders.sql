-- Purchase Reminders: tracks products marked for purchase from quotation low stock
CREATE TABLE IF NOT EXISTS purchase_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quotation_id uuid REFERENCES quotations(id) ON DELETE SET NULL,
  quantity_needed numeric NOT NULL DEFAULT 0,
  current_stock numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fulfilled', 'cancelled')),
  notes text,
  fulfilled_at timestamptz,
  fulfilled_by_grn_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_purchase_reminders_status ON purchase_reminders(status);
CREATE INDEX IF NOT EXISTS idx_purchase_reminders_product ON purchase_reminders(product_id);
CREATE INDEX IF NOT EXISTS idx_purchase_reminders_quotation ON purchase_reminders(quotation_id);

-- Allow anon access (matching the rest of the app)
ALTER TABLE purchase_reminders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all access to purchase_reminders" ON purchase_reminders
  FOR ALL
  USING (true)
  WITH CHECK (true);
