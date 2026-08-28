# Inventory Value Standardization + FIFO Ledger Page — Design Spec

Date: 2026-08-28
Status: Approved in principle (pending written-spec review)

## Problem

Inventory value is currently computed independently in at least six UI areas, with
three different formulas and two data-cap bugs. The same business number disagrees
depending on which page you look at.

### Current call sites (all computed client-side)

| # | Page | Label | File:Line | Formula | Notes |
|---|------|-------|-----------|---------|-------|
| 1 | Dashboard KPI | "Inventory Value" | `app/(erp)/dashboard/page.tsx:204` | `quantity_on_hand × cost_price` (paginated) | Paginated beyond 1000 rows |
| 2 | Inventory page stat | "Inventory Value" | `app/(erp)/inventory/page.tsx:401` | FIFO batches, fallback `total_stock × cost_price` | Correct, but duplicated inline |
| 3 | Inventory page filtered bar | "Filtered value" | `app/(erp)/inventory/page.tsx:507` | Same FIFO method, filtered subset | Needs row-level data, keep local |
| 4 | Reports overview stat | "Inventory Value" | `app/(erp)/reports/page.tsx:378` | `quantity_on_hand × cost_price` | **Capped at 1000 rows — under-reports** |
| 5 | Reports / Inventory stat | "Stock Value" | `app/(erp)/reports/inventory/page.tsx:111` | FIFO batches, fallback `quantity × cost_price` | Correct, duplicated inline |
| 6 | Individual product page | "Stock Value" | `app/(erp)/inventory/[id]/page.tsx:244` | `totalStock × cost_price` (single product, no FIFO) | Out of scope for this change (single-product scoped) |
| 7 | Accounting overview | "Total Assets" (includes account 1200) | `app/(erp)/accounting/page.tsx:531` | GL: `period_net_debit(1200)` | Audited number; keep GL-based |
| 8 | Accounting Chart of Accounts row | "Inventory Asset" | `app/(erp)/accounting/page.tsx:597` | GL: same as #7 | Audited number; keep GL-based |

### Three competing sources of truth

- **A. Simple product-level:** `inventory_items.quantity_on_hand × products.cost_price`.
  Re-prices all stock at today's cost; ignores actual purchase cost. Used by pages 1, 4, 6.
- **B. FIFO batches:** `Σ(inventory_batches.quantity_remaining × unit_cost)` where
  `quantity_remaining > 0`. Matches GAAP COGS; matches the ledger when journal entries
  are healthy. Used by pages 2, 3, 5.
- **C. GL account 1200:** `period_net_debit('1200')`. The balance-sheet/audit truth.
  Used by pages 7, 8. Recent migration `88f4594` posted the opening balance to 1200 to
  tie it to its subsidiary ledger (the batch table).

### Decision

**B (FIFO batches) is the single source of truth for "Inventory Value" in the
operational pages (1–5).** C (GL 1200) remains the source for accounting pages (7–8).
The two are expected to agree now that `88f4594` tied 1200 to its batch ledger; if they
diverge in the future that is a GL/journal bug, not a display inconsistency.

## Scope

1. Add a shared helper `lib/inventory-value.ts` that wraps the existing
   `get_fifo_inventory_value()` RPC with a TypeScript fallback for products that have
   stock but no remaining batches.
2. Replace the four operational call sites (pages 1, 2, 4, 5) with the helper.
   Keep page 3's row-level FIFO map (needs per-row data) and page 6 out of scope.
3. Add a new read-only **FIFO Ledger** page at `app/(erp)/inventory/fifo/page.tsx`,
   master-detail layout (product list on left, batch table on right), linked from the
   Sidebar Inventory section.
4. No reconciliation/drift panel on the FIFO page (pure ledger). No batch editing.

## Design

### 1. Shared helper — `lib/inventory-value.ts`

```ts
export interface InventoryValueResult {
  total: number;                 // the single number every operational page shows
  source: 'fifo' | 'fifo_with_fallback' | 'fallback_simple' | 'error';
  productsWithoutBatches: number; // count of products using the fallback
  productCount: number;           // total products contributing to the value
}

export async function getInventoryValue(
  supabase: SupabaseClient
): Promise<InventoryValueResult>
```

Logic:

1. `supabase.rpc('get_fifo_inventory_value')` (no warehouse arg → all warehouses).
   This is `Σ(quantity_remaining × unit_cost)` over remaining batches.
2. Find products with stock but no remaining batches:
   `inventory_items` join `products`, `quantity_on_hand > 0`, `NOT EXISTS` remaining
   batch for that product+warehouse.
3. For those products, add `quantity_on_hand × products.cost_price`.
4. Return `{ total, source: 'fifo' | 'fifo_with_fallback', productsWithoutBatches }`.

Error handling:

- If the RPC throws, fall back to the simple `quantity_on_hand × cost_price`
  calculation and set `source: 'fallback_simple'`.
- If everything fails, return `{ total: 0, ... source: 'error' }` — never throw.
- Callers already guard their stat cards against `NaN`/empty.

### 2. Call-site replacements

| File | Lines | Change |
|------|-------|--------|
| `app/(erp)/dashboard/page.tsx` | 91–110, 123 | Delete pagination loop + reduce; call `getInventoryValue`; use `total` |
| `app/(erp)/reports/page.tsx` | 76–88, 138 | Same — also fixes the 1000-row cap bug |
| `app/(erp)/inventory/page.tsx` | 280–293, 401 | Total stat card uses helper; keep row-level FIFO map for filtered value (line 507) |
| `app/(erp)/reports/inventory/page.tsx` | 44–62, 111 | Total stat uses helper; keep per-product table logic |

Out of scope: `app/(erp)/inventory/[id]/page.tsx` (single-product page 6) — the honest
per-product value is `Σ(that product's batches)`; noted as optional follow-up.

### 3. New page — `app/(erp)/inventory/fifo/page.tsx`

Read-only FIFO ledger. Master-detail:

- **Left panel:** product list, one row per product with any remaining batch quantity.
  Columns: product name, SKU, product FIFO value. Client-side search by name/SKU.
  Click selects; first product selected by default.
- **Right panel:** batch table for the selected product. Columns: `#`, `Batch #`,
  `Type` (purchase/opening/adjustment/return), `Qty Received`, `Qty Remaining`,
  `Unit Cost`, `Value` (remaining × unit cost), `Date`, `Reference`.
  Sorted by `created_at` ascending (FIFO order — oldest first).
  Rows with `quantity_remaining = 0` shown dimmed/struck-through.
  Footer row: totals for Remaining and Value.
- **No edit/delete.** Read-only.

Data loading:

```ts
supabase.from('inventory_batches')
  .select('*, product:products(name, sku), warehouse:warehouses(name)')
  .gt('quantity_remaining', 0)
  .order('created_at', { ascending: true });
```

- Paginate past the 1000-row cap (same loop pattern as the dashboard).
- Group client-side by `product_id`.
- RLS `ib_select` policy already permits authenticated reads.

Sidebar link: add `{ title: 'FIFO Ledger', href: '/inventory/fifo' }` to the Inventory
section in `components/layout/Sidebar.tsx` (line ~27-31), placed immediately after
"Products" and before "Stock Movements".

### 4. Files touched

- **New:** `lib/inventory-value.ts`
- **New:** `app/(erp)/inventory/fifo/page.tsx`
- **Edit:** `app/(erp)/dashboard/page.tsx`
- **Edit:** `app/(erp)/reports/page.tsx`
- **Edit:** `app/(erp)/inventory/page.tsx`
- **Edit:** `app/(erp)/reports/inventory/page.tsx`
- **Edit:** `components/layout/Sidebar.tsx`

No new migrations required. The `get_fifo_inventory_value` RPC already exists.

## Testing

- **Helper unit test:** `lib/inventory-value.ts` — with a mocked Supabase client,
  assert: pure FIFO path returns RPC value + `source: 'fifo'`; missing-batch fallback
  adds `quantity × cost_price` for those products; RPC throw returns fallback simple;
  hard failure returns `{ total: 0, source: 'error' }`.
- **Page smoke test:** FIFO page loads, lists products with remaining batches, batch
  table shows correct per-product value, dimmed zero-remaining rows render, search
  filters the left list.
- **Regression check:** dashboard, reports, inventory, reports/inventory all show the
  same "Inventory Value" / "Stock Value" total for the same dataset. Verify reports
  page no longer under-reports on datasets > 1000 rows.

## Risks / Notes

- The reports page's cap bug is fixed implicitly by the refactor.
- Page 6 (single product) keeps its simple method for now — inconsistent with the
  standard until the follow-up; acceptable, it is explicitly scoped.
- Accounting (7–8) intentionally stays GL-based; do not change to avoid silently
  masking a future GL/journal drift.
