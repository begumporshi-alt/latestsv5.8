ALTER TABLE purchase_order_items
  ADD COLUMN IF NOT EXISTS warehouse_id UUID REFERENCES warehouses(id);
