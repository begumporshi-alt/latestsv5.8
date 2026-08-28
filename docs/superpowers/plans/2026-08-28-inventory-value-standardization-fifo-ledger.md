# Inventory Value Standardization + FIFO Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every operational "Inventory Value" number come from one shared FIFO-based helper, and add a read-only FIFO ledger page.

**Architecture:** A single TypeScript helper (`lib/inventory-value.ts`) wraps the existing `get_fifo_inventory_value` RPC with a fallback for products that have stock but no remaining batches. Four existing call sites (dashboard, reports, inventory, reports/inventory) switch to it. A new `app/(erp)/inventory/fifo/page.tsx` shows the batch ledger grouped by product.

**Tech Stack:** Next.js 13.5 (App Router), `@supabase/supabase-js` v2, existing `get_fifo_inventory_value` SQL RPC.

**Spec:** `docs/superpowers/specs/2026-08-28-inventory-value-standardization-fifo-ledger-design.md`

## Global Constraints

- The FIFO page is read-only. No create/edit/delete of batches.
- The accounting pages (Total Assets, account 1200) stay GL-based — do not touch.
- The individual product page `app/(erp)/inventory/[id]/page.tsx` stays as-is (out of scope).
- Follow the existing code style: client components with `'use client'`, `supabase` singleton from `@/lib/supabase`, `formatCurrency` from `@/lib/format`, shadcn-style `stat-card` markup.
- Supabase caps queries at 1000 rows — paginate any `inventory_batches` / `inventory_items` fetch.
- Do not commit `.mimosa/` runtime state files.

---

### Task 1: Shared inventory-value helper

**Files:**
- Create: `lib/inventory-value.ts`
- Test: `lib/__tests__/inventory-value.test.ts`

**Interfaces:**
- Consumes: `supabase` client (type `SupabaseClient`), the existing `get_fifo_inventory_value` RPC.
- Produces:
  ```ts
  export interface InventoryValueResult {
    total: number;
    source: 'fifo' | 'fifo_with_fallback' | 'fallback_simple' | 'error';
    productsWithoutBatches: number;
    productCount: number;
  }
  export async function getInventoryValue(supabase: SupabaseClient): Promise<InventoryValueResult>
  ```

- [ ] **Step 1: Write the failing test**

`lib/__tests__/inventory-value.test.ts`:

```ts
import { getInventoryValue } from '../inventory-value';

// Minimal mock that mimics the supabase-js call chain used by the helper.
// The helper makes three kinds of calls:
//   rpc('get_fifo_inventory_value') -> { data, error }
//   from('inventory_items').select(...).gt(...) -> { data, error }
//   from('inventory_batches').select(...).gt(...) -> { data, error }
function mockSupabase(opts: {
  fifoValue: number | null;
  invItems: any[];        // rows from inventory_items
  batchKeys: string[];    // product_id|warehouse_id pairs with remaining batches
  rpcThrows?: boolean;
}) {
  const rpc = opts.rpcThrows
    ? jest.fn().mockRejectedValue(new Error('boom'))
    : jest.fn().mockResolvedValue({ data: opts.fifoValue, error: null });
  const from = jest.fn().mockImplementation((table: string) => {
    if (table === 'inventory_items') {
      return {
        select: jest.fn().mockReturnThis(),
        gt: jest.fn().mockResolvedValue({ data: opts.invItems, error: null }),
      };
    }
    if (table === 'inventory_batches') {
      return {
        select: jest.fn().mockReturnThis(),
        gt: jest.fn().mockResolvedValue({
          data: opts.batchKeys.map((k) => {
            const [product_id, warehouse_id] = k.split('|');
            return { product_id, warehouse_id };
          }),
          error: null,
        }),
      };
    }
    return { select: jest.fn().mockResolvedValue({ data: [], error: null }) };
  });
  return { rpc, from };
}

describe('getInventoryValue', () => {
  it('returns FIFO total when no products lack batches', async () => {
    const m = mockSupabase({ fifoValue: 500, invItems: [], batchKeys: [] });
    const result = await getInventoryValue({ rpc: m.rpc, from: m.from } as any);
    expect(result.total).toBe(500);
    expect(result.source).toBe('fifo');
    expect(result.productsWithoutBatches).toBe(0);
  });

  it('adds fallback qty*cost_price for products with stock but no batches', async () => {
    const m = mockSupabase({
      fifoValue: 500,
      invItems: [
        { product_id: 'p1', warehouse_id: 'w1', quantity_on_hand: 10, product: { id: 'p1', cost_price: 20 } },
      ],
      batchKeys: [], // p1|w1 has no remaining batch
    });
    const result = await getInventoryValue({ rpc: m.rpc, from: m.from } as any);
    expect(result.total).toBe(700); // 500 + 10*20
    expect(result.source).toBe('fifo_with_fallback');
    expect(result.productsWithoutBatches).toBe(1);
  });

  it('does not double-count a product that has a remaining batch', async () => {
    const m = mockSupabase({
      fifoValue: 500,
      invItems: [
        { product_id: 'p1', warehouse_id: 'w1', quantity_on_hand: 10, product: { id: 'p1', cost_price: 20 } },
      ],
      batchKeys: ['p1|w1'], // p1|w1 already counted by FIFO
    });
    const result = await getInventoryValue({ rpc: m.rpc, from: m.from } as any);
    expect(result.total).toBe(500);
    expect(result.source).toBe('fifo');
  });

  it('falls back to simple sum when the RPC throws', async () => {
    const m = mockSupabase({
      fifoValue: null,
      invItems: [{ product_id: 'p1', warehouse_id: 'w1', quantity_on_hand: 10, product: { id: 'p1', cost_price: 20 } }],
      batchKeys: [],
      rpcThrows: true,
    });
    const result = await getInventoryValue({ rpc: m.rpc, from: m.from } as any);
    expect(result.source).toBe('fallback_simple');
    expect(result.total).toBe(200);
  });

  it('returns error result on hard failure without throwing', async () => {
    const rpc = jest.fn().mockRejectedValue(new Error('boom'));
    const from = jest.fn().mockImplementation(() => ({
      select: jest.fn().mockReturnThis(),
      gt: jest.fn().mockRejectedValue(new Error('boom')),
    }));
    const result = await getInventoryValue({ rpc, from } as any);
    expect(result.source).toBe('error');
    expect(result.total).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest lib/__tests__/inventory-value.test.ts`
Expected: FAIL — `Cannot find module '../inventory-value'`

- [ ] **Step 3: Write the implementation**

`lib/inventory-value.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js';

export interface InventoryValueResult {
  total: number;
  source: 'fifo' | 'fifo_with_fallback' | 'fallback_simple' | 'error';
  productsWithoutBatches: number;
  productCount: number;
}

export async function getInventoryValue(
  supabase: SupabaseClient
): Promise<InventoryValueResult> {
  // Primary path: the existing FIFO RPC sums remaining batch qty * unit_cost.
  try {
    const { data: fifoValue, error: rpcError } = await supabase.rpc('get_fifo_inventory_value');
    const fifoTotal = Number(fifoValue || 0);
    if (rpcError) throw rpcError;

    // Find products that have stock but no remaining batches for that
    // product+warehouse. Those need the fallback qty * cost_price.
    // Fetch the set of (product_id, warehouse_id) that DO have a remaining
    // batch, then classify in memory to avoid an N+1 query.
    let missing: any[] = [];
    let batchKeys = new Set<string>();
    try {
      const [invRes, batchRes] = await Promise.all([
        supabase
          .from('inventory_items')
          .select('product_id, warehouse_id, quantity_on_hand, product:products(id, cost_price)')
          .gt('quantity_on_hand', 0),
        supabase
          .from('inventory_batches')
          .select('product_id, warehouse_id')
          .gt('quantity_remaining', 0),
      ]);
      missing = invRes.data || [];
      batchKeys = new Set((batchRes.data || []).map((b: any) => `${b.product_id}|${b.warehouse_id}`));
    } catch {
      missing = [];
    }

    const missingProducts = new Set<string>();
    let fallbackValue = 0;
    let productCount = 0;
    for (const item of missing) {
      const key = `${item.product_id}|${item.warehouse_id}`;
      productCount++;
      if (item.product?.id) missingProducts.add(item.product.id);
      if (!batchKeys.has(key)) {
        fallbackValue += Number(item.quantity_on_hand) * Number(item.product?.cost_price || 0);
      }
    }

    return {
      total: fifoTotal + fallbackValue,
      source: fallbackValue > 0 ? 'fifo_with_fallback' : 'fifo',
      productsWithoutBatches: fallbackValue > 0 ? missingProducts.size : 0,
      productCount,
    };
  } catch {
    // RPC failed — fall back to a simple quantity * cost_price sum.
    try {
      let total = 0;
      let count = 0;
      let pg = 0;
      while (true) {
        const { data: pageData } = await supabase
          .from('inventory_items')
          .select('quantity_on_hand, product:products(cost_price)')
          .range(pg * 1000, (pg + 1) * 1000 - 1);
        const page = pageData || [];
        for (const item of page) {
          total += Number(item.quantity_on_hand) * Number(item.product?.cost_price || 0);
          count++;
        }
        if (page.length < 1000) break;
        pg++;
      }
      return { total, source: 'fallback_simple', productsWithoutBatches: 0, productCount: count };
    } catch {
      return { total: 0, source: 'error', productsWithoutBatches: 0, productCount: 0 };
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest lib/__tests__/inventory-value.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/inventory-value.ts lib/__tests__/inventory-value.test.ts
git commit -m "feat: add shared FIFO inventory value helper with fallback"
```

---

### Task 2: Refactor dashboard to use the helper

**Files:**
- Modify: `app/(erp)/dashboard/page.tsx:91-110, 123`
- Test: `npx tsc --noEmit`

**Interfaces:**
- Consumes: `getInventoryValue` from Task 1.
- Produces: `stats.inventoryValue` set from `getInventoryValue(...).total`.

- [ ] **Step 1: Replace the paginated inventory_items fetch + reduce**

In `app/(erp)/dashboard/page.tsx`, replace lines 91–110 (the `allInvItems` pagination loop and the `invValue` reduce) with:

```ts
import { getInventoryValue } from '@/lib/inventory-value';
// ...inside the load() effect, replacing the invValue block:
const invResult = await getInventoryValue(supabase);
const invValue = invResult.total;
```

- [ ] **Step 2: Ensure the import is added**

Add `import { getInventoryValue } from '@/lib/inventory-value';` at the top of `dashboard/page.tsx` (after the `@/lib/supabase` import).

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add app/(erp)/dashboard/page.tsx
git commit -m "refactor: use shared inventory value helper on dashboard"
```

---

### Task 3: Refactor reports overview to use the helper

**Files:**
- Modify: `app/(erp)/reports/page.tsx:76-89, 138`
- Test: `npx tsc --noEmit`

**Interfaces:**
- Consumes: `getInventoryValue` from Task 1.
- Produces: `stats.inventoryValue` from the helper (also removes the 1000-row cap bug).

- [ ] **Step 1: Replace the paginated inventory_items block**

In `app/(erp)/reports/page.tsx`, replace the `allInvItems` pagination loop (lines ~76–89) and the `inventoryValue` reduce (line ~138) with:

```ts
import { getInventoryValue } from '@/lib/inventory-value';
// ...inside the load() effect:
const invResult = await getInventoryValue(supabase);
const inventoryValue = invResult.total;
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add app/(erp)/reports/page.tsx
git commit -m "refactor: use shared inventory value helper on reports overview"
```

---

### Task 4: Refactor inventory page total to use the helper (keep row-level FIFO map)

**Files:**
- Modify: `app/(erp)/inventory/page.tsx:280-293`
- Test: `npx tsc --noEmit`

**Interfaces:**
- Consumes: `getInventoryValue` from Task 1.
- Produces: `stats.value` from the helper. The row-level `fifoValueMap` (used by the filtered value at line 507) stays.

- [ ] **Step 1: Add the helper import**

Add `import { getInventoryValue } from '@/lib/inventory-value';` at the top of `inventory/page.tsx`.

- [ ] **Step 2: Keep the row-level map, replace the total**

In `inventory/page.tsx`, keep the existing `fMap`/`setFifoValueMap(fMap)` block (lines 280–289) — the filtered value at line 507 still needs it. Replace line 291's `value` reduce with:

```ts
const invResult = await getInventoryValue(supabase);
const value = invResult.total;
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add app/(erp)/inventory/page.tsx
git commit -m "refactor: use shared inventory value helper on inventory page"
```

---

### Task 5: Refactor reports/inventory total to use the helper (keep per-product table logic)

**Files:**
- Modify: `app/(erp)/reports/inventory/page.tsx:44-64`
- Test: `npx tsc --noEmit`

**Interfaces:**
- Consumes: `getInventoryValue` from Task 1.
- Produces: `stats.value` from the helper. The per-row `fifoValueMap` (used by the item table) stays.

- [ ] **Step 1: Add the helper import**

Add `import { getInventoryValue } from '@/lib/inventory-value';` at the top of `reports/inventory/page.tsx`.

- [ ] **Step 2: Keep the per-row map, replace the total**

Keep the `fMap`/`setFifoValueMap(fMap)` block (lines 44–53). Replace the `value` reduce (lines 58–61) with:

```ts
const invResult = await getInventoryValue(supabase);
const value = invResult.total;
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add app/(erp)/reports/inventory/page.tsx
git commit -m "refactor: use shared inventory value helper on inventory report"
```

---

### Task 6: FIFO ledger page (read-only)

**Files:**
- Create: `app/(erp)/inventory/fifo/page.tsx`
- Modify: `components/layout/Sidebar.tsx:27-31`

**Interfaces:**
- Consumes: `supabase` from `@/lib/supabase`, `formatCurrency` from `@/lib/format`.
- Produces: the `/inventory/fifo` route, linked from the Sidebar.

- [ ] **Step 1: Create the page**

`app/(erp)/inventory/fifo/page.tsx`:

```tsx
'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/format';
import { Package, Search } from 'lucide-react';

interface Batch {
  id: string;
  product_id: string;
  warehouse_id: string;
  batch_number: string | null;
  batch_type: string;
  quantity_received: number;
  quantity_remaining: number;
  unit_cost: number;
  created_at: string;
  reference_number: string | null;
  notes: string | null;
  product?: { name: string; sku: string } | null;
  warehouse?: { name: string } | null;
}

export default function FifoLedgerPage() {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedProduct, setSelectedProduct] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      let all: Batch[] = [];
      let pg = 0;
      while (true) {
        const { data: pageData } = await supabase
          .from('inventory_batches')
          .select('*, product:products(name, sku), warehouse:warehouses(name)')
          .order('created_at', { ascending: true })
          .range(pg * 1000, (pg + 1) * 1000 - 1);
        all = all.concat((pageData || []) as Batch[]);
        if (!pageData || pageData.length < 1000) break;
        pg++;
      }
      setBatches(all);
      setLoading(false);
    }
    load();
  }, []);

  // Group by product; only products with remaining qty appear.
  const products = useMemo(() => {
    const map = new Map<string, { product: Batch['product']; value: number; remaining: number }>();
    for (const b of batches) {
      const key = b.product_id as unknown as string;
      if (!key) continue;
      const cur = map.get(key) || { product: b.product, value: 0, remaining: 0 };
      cur.remaining += Number(b.quantity_remaining);
      cur.value += Number(b.quantity_remaining) * Number(b.unit_cost);
      map.set(key, cur);
    }
    return Array.from(map.entries())
      .filter(([, v]) => v.remaining > 0)
      .sort((a, b) => (a[1].product?.name || '').localeCompare(b[1].product?.name || ''));
  }, [batches]);

  const filteredProducts = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return products;
    return products.filter(([, v]) =>
      (v.product?.name || '').toLowerCase().includes(q) ||
      (v.product?.sku || '').toLowerCase().includes(q)
    );
  }, [products, search]);

  const selectedBatches = useMemo(() => {
    return batches
      .filter((b) => b.product_id === selectedProduct)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  }, [batches, selectedProduct]);

  useEffect(() => {
    if (!selectedProduct && filteredProducts.length > 0) {
      setSelectedProduct(filteredProducts[0][0]);
    }
  }, [filteredProducts, selectedProduct]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="w-10 h-10 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-slate-400 text-sm">Loading FIFO ledger...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">FIFO Inventory Ledger</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Read-only view of stock batches ordered oldest-first (FIFO).
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[320px_1fr] gap-6">
        {/* Left: product list */}
        <div className="rounded-xl border border-border overflow-hidden">
          <div className="p-3 border-b border-border">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search products..."
                className="w-full pl-9 pr-3 py-2 text-sm border border-input rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
          <div className="divide-y divide-border max-h-[70vh] overflow-y-auto">
            {filteredProducts.map(([id, v]) => (
              <button
                key={id}
                onClick={() => setSelectedProduct(id)}
                className={`w-full flex items-center justify-between px-4 py-3 text-left transition hover:bg-muted/40 ${selectedProduct === id ? 'bg-blue-50' : ''}`}
              >
                <div>
                  <p className="text-sm font-semibold text-foreground">{v.product?.name || 'Unknown'}</p>
                  <p className="text-xs text-muted-foreground">{v.product?.sku}</p>
                </div>
                <p className="text-sm font-semibold text-foreground">{formatCurrency(v.value)}</p>
              </button>
            ))}
            {filteredProducts.length === 0 && (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                No products with remaining stock.
              </div>
            )}
          </div>
        </div>

        {/* Right: batch table for selected product */}
        <div className="rounded-xl border border-border overflow-hidden">
          <div className="px-5 py-4 border-b border-border flex items-center justify-between">
            <div>
              <h2 className="text-base font-bold">
                {selectedBatches[0]?.product?.name || 'Select a product'}
              </h2>
              <p className="text-xs text-muted-foreground">
                {selectedBatches[0]?.warehouse?.name || '—'} &middot;{' '}
                {selectedBatches.length} batch{selectedBatches.length === 1 ? '' : 'es'}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs text-muted-foreground">Remaining</p>
              <p className="text-lg font-bold">
                {formatCurrency(selectedBatches.reduce((s, b) => s + Number(b.quantity_remaining) * Number(b.unit_cost), 0))}
              </p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-muted-foreground text-xs">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">#</th>
                  <th className="px-4 py-2 text-left font-medium">Batch</th>
                  <th className="px-4 py-2 text-left font-medium">Type</th>
                  <th className="px-4 py-2 text-right font-medium">Received</th>
                  <th className="px-4 py-2 text-right font-medium">Remaining</th>
                  <th className="px-4 py-2 text-right font-medium">Unit Cost</th>
                  <th className="px-4 py-2 text-right font-medium">Value</th>
                  <th className="px-4 py-2 text-left font-medium">Date</th>
                  <th className="px-4 py-2 text-left font-medium">Reference</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {selectedBatches.map((b, i) => {
                  const exhausted = Number(b.quantity_remaining) === 0;
                  return (
                    <tr key={b.id} className={exhausted ? 'opacity-50' : ''}>
                      <td className="px-4 py-2 text-muted-foreground">{i + 1}</td>
                      <td className="px-4 py-2 font-mono text-xs">{b.batch_number || '—'}</td>
                      <td className="px-4 py-2 capitalize">{b.batch_type}</td>
                      <td className="px-4 py-2 text-right">{Number(b.quantity_received).toLocaleString()}</td>
                      <td className="px-4 py-2 text-right">{Number(b.quantity_remaining).toLocaleString()}</td>
                      <td className="px-4 py-2 text-right">{formatCurrency(Number(b.unit_cost))}</td>
                      <td className="px-4 py-2 text-right font-semibold">
                        {formatCurrency(Number(b.quantity_remaining) * Number(b.unit_cost))}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {new Date(b.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">{b.reference_number || b.notes || '—'}</td>
                    </tr>
                  );
                })}
                {selectedBatches.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-4 py-8 text-center text-muted-foreground">
                      No batches for this product.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add the Sidebar link**

In `components/layout/Sidebar.tsx`, inside the Inventory `children` array (lines 27–31), add after `Products`:

```ts
{ title: 'FIFO Ledger', href: '/inventory/fifo' },
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add app/(erp)/inventory/fifo/page.tsx components/layout/Sidebar.tsx
git commit -m "feat: add read-only FIFO inventory ledger page"
```

---

### Task 7: End-to-end verification

**Files:**
- Test: manual + `npx tsc --noEmit`

**Interfaces:**
- Consumes: all prior tasks.

- [ ] **Step 1: Typecheck the whole project**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 2: Run the helper unit tests**

Run: `npx jest lib/__tests__/inventory-value.test.ts`
Expected: PASS

- [ ] **Step 3: Manual smoke check**

Start the dev server (`npm run dev`), then:
- Visit `/dashboard` — "Inventory Value" stat matches the FIFO total.
- Visit `/reports` — same number.
- Visit `/inventory` — "Inventory Value" stat matches; "Filtered value" still works per-row.
- Visit `/reports/inventory` — "Stock Value" stat matches.
- Visit `/inventory/fifo` — left list shows products with remaining stock; clicking one shows its batches oldest-first; exhausted batches are dimmed; search filters the list.

- [ ] **Step 4: Confirm accounting pages unchanged**

Visit `/accounting` — "Total Assets" still GL-based (unchanged).

- [ ] **Step 5: Commit any leftover doc note**

```bash
git add -A
git commit -m "docs: note FIFO standardization verification"
```

(Only if there is something to commit; otherwise skip.)

---

## Self-Review Notes

- **Spec coverage:** helper (Task 1) ✓, dashboard (Task 2) ✓, reports (Task 3) ✓, inventory (Task 4) ✓, reports/inventory (Task 5) ✓, FIFO page + sidebar (Task 6) ✓, verification (Task 7) ✓. Accounting and single-product page intentionally untouched per spec.
- **Placeholder scan:** no TBD/TODO; every code step has full code.
- **Type consistency:** `InventoryValueResult` and `getInventoryValue(supabase)` used identically in Tasks 1–5. `Batch` interface defined in Task 6 only.
