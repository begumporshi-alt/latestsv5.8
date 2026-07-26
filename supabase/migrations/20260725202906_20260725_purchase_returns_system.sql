/*
# Purchase Returns System

Creates dedicated tables for tracking purchase returns (items returned to suppliers),
replacing the previous fragile approach of reconstructing returns from stock_movements.

## New Tables

### purchase_returns
- `id` (uuid, primary key)
- `tenant_id` (uuid, defaults to single-tenant ID)
- `return_number` (text, unique) — e.g. "PRET-000001"
- `purchase_order_id` (uuid, FK to purchase_orders) — the originating PO
- `supplier_id` (uuid, FK to suppliers) — the supplier items are returned to
- `warehouse_id` (uuid, FK to warehouses) — warehouse items are returned from
- `return_date` (date, defaults to today)
- `total_amount` (numeric) — total credit value of returned items
- `status` (text: pending, completed, cancelled)
- `notes` (text, optional)
- `journal_entry_id` (uuid, FK to journal_entries, optional)
- `created_by` (uuid, FK to profiles, optional)
- `created_at` (timestamptz)

### purchase_return_items
- `id` (uuid, primary key)
- `tenant_id` (uuid, defaults to single-tenant ID)
- `purchase_return_id` (uuid, FK to purchase_returns)
- `product_id` (uuid, FK to products)
- `quantity` (numeric) — quantity returned
- `unit_cost` (numeric) — cost per unit at time of return
- `subtotal` (numeric) — quantity * unit_cost
- `reason` (text: defective, wrong_item, quality_issue, overstock, other)
- `created_at` (timestamptz)

## Security
- RLS enabled on both tables.
- Single-tenant no-auth pattern: `TO anon, authenticated` with `USING (true)` —
  consistent with all other tables in this app (see migration 20260702175411_all_rls_policy.sql).

## Notes
1. The `purchase_returns` table stores proper supplier and PO linkage, fixing the
   previous issue where returns were inferred from stock_movements (losing supplier
   info and miscalculating totals).
2. Stock movements for purchase returns still use `movement_type = 'return_out'`
   but now reference the `purchase_return_id` via `reference_id`.
3. Supplier outstanding_balance is adjusted when a return is completed (credit note).
*/