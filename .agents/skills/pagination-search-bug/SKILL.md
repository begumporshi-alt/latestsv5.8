---
name: pagination-search-bug
description: Diagnose and fix items missing from a list/search UI, and stats/totals that are silently wrong. Use when a user reports an item not appearing in a search, filter, or dropdown — especially after an edit or new record creation — OR when a total/sum on a page (Total Sales, counts, dashboard cards) is understated versus another report or SQL. Triggers on "item X doesn't show up", "search returns nothing", "dropdown is missing options", "can't find the record I just created", "total is wrong", "the two pages show different totals". Always check the pattern described here before assuming a display bug, permission issue, or calculation error.
---

# Pagination-Search Bug Hunter

## Classic symptom

A record **exists in the database** but is **not found** in a search or dropdown UI. The user can see it elsewhere (e.g. a detail page, a report, a different module) but searching in a specific UI field returns nothing. All other records in the same list appear fine.

Real case: a barcode-label printing page loaded products with **no `.limit()` at all** (PostgREST still caps every response at 1,000 rows by default) on a 2,541-product catalog, then filtered client-side — 60% of the catalog was unfindable in label search. The same page capped invoices at `.limit(500)` while the table had 602 rows.

## Second symptom: silently wrong totals

A stat card, count, or sum on a page is **understated** because it is computed
client-side over a capped fetch (`.limit(N)`, or Supabase's implicit 1,000-row
default when no limit is set). Nothing looks broken in the UI — the number is
just quietly missing rows. Indicators:

- A list page shows a LOWER total than a statement/report page (statements
  usually aggregate in SQL over a separate unfiltered query, so they're right)
- The gap equals exactly the value of the dropped rows (verify in SQL —
  see the "Attributing a totals gap" section below)
- The table looks complete because the cap is high (e.g. 500) and the user
  rarely scrolls past it

Real cases of the totals variant:
- Invoices page `.limit(500)` with 580 invoices → "Total Sales" understated
  by exactly the 34 oldest invoices' value (35.09L shown vs 41.43L true)
- Products query with no explicit limit → Supabase returned only 1,000 of
  2,528 active products; the invoice product picker was blind to half the catalog
- Payments query (625 rows, no limit) heading toward the same 1,000-row cliff

Once you find ONE capped query on a page, sweep the page's OTHER queries —
the same author usually capped siblings (payments, returns, deliveries,
lookup tables feeding pickers).

## The root cause (most common)

**Client-side filter over a capped, unordered initial load.** The UI fetches only the first N rows with `.limit(N)` (often 50 or 100) and no `ORDER BY`, then filters those rows in JavaScript. Items beyond the limit are silently absent. **A query with no `.limit()` is still capped** — Supabase/PostgREST returns at most 1,000 rows per response by default, so "no limit" just means "invisible cap at 1,000". This is especially likely when:
- The user reports the item existed before (it was created earlier)
- The item has a name/code near the end of alphabetical order
- The list has grown past the `.limit()` cap since deployment

## Step-by-step diagnosis

### Step 1: Find the query in the UI code

Use `grep` or `glob` across the codebase to find where the entity is loaded:

```
grep -rn "limit(100)\|limit(50)\|limit(200)" --include="*.tsx" --include="*.ts" .
grep -rn "supabase.*select\|supabase.*from" --include="*.tsx" --include="*.ts" . | grep -i "<entity_name>"
```

Common patterns that load a list:
- `.from('customers').select(...).limit(100)` — customer lists
- `.from('products').select(...).limit(50)` — product searches
- `.from('accounts').select(...).limit(100)` — chart of accounts
- `.from('invoices').select(...).limit(100)` — invoice lists

Also look for the **client-side filter** that operates on the loaded data:
```
grep -rn "filter(c =>\|.filter(\|includes(.*toLowerCase)" --include="*.tsx" .
```

### Step 2: Check if the record exists in the database

Query the database directly with `psql`. The connection string is
`NEXT_PUBLIC_SUPABASE_DB_URL` in `.env`:

```
DB_URL=$(grep -oP '^NEXT_PUBLIC_SUPABASE_DB_URL=\K.*' .env) && psql "$DB_URL" -c "..."
```

For a missing item by code/name:
```sql
-- Check if the record exists and what its sort position is
WITH ordered_rows AS (
  SELECT row_number() OVER (ORDER BY name) AS rn, *
  FROM <table>
  WHERE <filter conditions matching the query> (e.g., is_active = true)
  ORDER BY name
)
SELECT * FROM ordered_rows WHERE <key_column> = '<value>';

-- Count total matching rows
SELECT count(*) FROM <table> WHERE <filter conditions>;
```

For a missing customer:
```sql
SELECT id, code, name, phone, is_active, tenant_id
FROM customers
WHERE code = '<CODE>'
   OR name ILIKE '%<partial_name>%';
```

### Step 3: Check if the record's position exceeds the limit

```sql
-- Find the row number of the missing record in the load order
SELECT rn FROM (
  SELECT row_number() OVER (ORDER BY name) AS rn, *
  FROM <table>
  WHERE <filter conditions>
  ORDER BY name
) sub
WHERE <key_column> = '<value>';
```

If the row number is **greater than the limit** (e.g., row 103 but limit is 100), the record was never loaded.

### Step 4: Verify the filter conditions match

The client-side filter and the initial query must use identical conditions. Common mismatches:
- The query filters by `is_active = true` but the DB record has `is_active = false`
- The query filters by `tenant_id` but the record has the wrong tenant
- The query uses a different date filter than expected
- The search uses `.eq()` but the record has a `null` value for that field

```sql
-- Show all records matching the search term regardless of filters
SELECT * FROM <table>
WHERE <search_column> ILIKE '%<search_term>%'
  OR <code_column> ILIKE '%<search_term>%'
  OR <phone_column> ILIKE '%<search_term>%';
```

## The fix (the right way)

**Remove the arbitrary limit and add deterministic ordering.** Fetch all matching rows with `ORDER BY`:

```typescript
// BEFORE (broken)
const { data } = await supabase
  .from('customers')
  .select('id, name, code, phone, outstanding_balance')
  .eq('is_active', true)
  .limit(100);  // ← arbitrary cap, no order = non-deterministic

// AFTER (correct)
const { data } = await supabase
  .from('customers')
  .select('id, name, code, phone, outstanding_balance')
  .eq('is_active', true)
  .order('name');  // deterministic, removes need for limit
```

**Why remove the limit?** For small-to-medium tables (under ~5,000 rows), loading all rows at once is faster and simpler than implementing server-side search. The `.limit(N)` pattern was almost always a placeholder for future pagination that never arrived. If the table is large (>10,000 rows), implement **server-side search instead**:

```typescript
// Server-side search (for large tables)
const search = customerSearch.trim();
let query = supabase
  .from('customers')
  .select('id, name, code, phone, outstanding_balance')
  .eq('is_active', true)
  .order('name');

if (search) {
  query = query.or(
    `name.ilike.%${search}%,code.ilike.%${search}%,phone.ilike.%${search}%`
  );
}

const { data } = await query.limit(50);
```

**Also fix the "No results" check** if it filters on fewer fields than the actual filter:
```typescript
// BEFORE (broken — checks only name, misses code/phone matches)
{customerSearch.trim() && customers.filter(c =>
  c.name.toLowerCase().includes(customerSearch.trim().toLowerCase())
).length === 0 && (
  <NoResults />
)}

// AFTER (correct — mirrors the actual filter logic)
{customerSearch.trim() && customers.filter(c =>
  c.name.toLowerCase().includes(customerSearch.trim().toLowerCase()) ||
  (c.code || '').toLowerCase().includes(customerSearch.trim().toLowerCase()) ||
  (c.phone || '').includes(customerSearch.trim())
).length === 0 && (
  <NoResults />
)}
```

## Pattern checklist (for sweeping the codebase)

When sweeping for similar bugs, check every `.limit(N)` call paired with a client-side `.filter()`. Flag these as potential issues:

1. **`.limit(N)` without `.order()`** — result order is non-deterministic, making it unclear which rows are dropped
2. **Client-side filter without server-side search** — filtering only the loaded subset, so out-of-limit rows are invisible
3. **Mismatched filter conditions** — the search input filter checks different fields than the initial query filters
4. **"No results" check that checks fewer fields than the actual filter** — gives false "not found" for partial matches
5. **`.limit()` cap close to total row count** — likely to silently exclude records as data grows
6. **`.ilike('name', ...)` without `.or('code.ilike...')`** — common in form-side helpers (sales advances, header global search). Typing a customer code (e.g. `167982`) or product SKU returns nothing because only `name` is searched. Fix by adding a `searchCols` array and using `.or()` with each column.
7. **Query with no `.limit()` at all** — PostgREST still caps the response at 1,000 rows; check the table's real row count in SQL. A missing limit is NOT an unlimited query.

To sweep the codebase:
```
grep -rn "\.limit(" --include="*.tsx" --include="*.ts" . | grep -v node_modules | grep -v ".d.ts"
grep -rn "\.ilike(" --include="*.tsx" --include="*.ts" . | grep -v node_modules
```

For each result, check if there's a `.filter()` on the same data downstream. If so, apply the checklist above.

## The fix for capped fetches: paginate past the row cap

For queries whose completeness matters (stats, pickers, attach-to-parent maps),
fetch ALL rows by paging. Supabase/postgrest-js builders mutate in place, so
give the loop a **factory** that builds a fresh query per page:

```typescript
async function fetchAll<T = any>(build: () => any, pageSize = 1000): Promise<T[]> {
  const rows: T[] = [];
  let pg = 0;
  while (true) {
    const { data, error } = await build().range(pg * pageSize, (pg + 1) * pageSize - 1);
    if (error) throw error;
    const page = (data || []) as T[];
    rows.push(...page);
    if (page.length < pageSize) break;
    pg++;
  }
  return rows;
}

// usage inside loadData — the factory re-applies filters per page
const invoices = await fetchAll(() => {
  let q = supabase.from('invoices')
    .select('*, customer:customers(name)').order('created_at', { ascending: false });
  if (from) q = q.gte('invoice_date', from);
  if (to) q = q.lte('invoice_date', to);
  return q;
});
```

**In this project the helper already exists: `lib/fetch-all.ts` (added
2026-09-03).** Import it — never copy-paste the implementation into a page;
the copies drift.

Apply to every query on the page whose rows must be complete: the main list,
any per-record attachments (payments, returns, deliveries), lookup tables
feeding pickers (products, customers). Small tables (payment methods,
warehouses) are fine unpaged but cost nothing to page.

**The paginated query MUST have a deterministic ORDER BY.** If the sort column
isn't unique, tied rows can swap places between `.range()` pages — you'll get
duplicates and omissions at page boundaries even after "fixing" the cap. Add a
unique tiebreaker column (id works) whenever the visible sort column can repeat:

```typescript
// 152 of 2,541 products shared a name — .order('name') alone let rows shift
// between pages. Tiebreaker makes page boundaries stable:
.order('name').order('id')
```

Check for duplicate sort keys before paginating:
```sql
SELECT count(*) FROM (SELECT <sort_col> FROM <table>
  WHERE <filters> GROUP BY <sort_col> HAVING count(*) > 1) d;
```

## Verify the fix

Two cheap checks against the live page:

1. **Row-count parity** — count rendered rows in the browser
   (`document.querySelectorAll('table tbody tr').length`, valid when the table
   renders all rows without virtualization) and compare with `SELECT count(*)`
   under the same filters. 2,541 in the DOM = 2,541 in the DB.
2. **Boundary-row search** — pick rows just past the old cap, in the query's
   own order, and search for them in the UI:

```sql
WITH ordered AS (
  SELECT row_number() OVER (ORDER BY name, id) AS rn, name, sku
  FROM products WHERE is_active = true
)
SELECT rn, name, sku FROM ordered WHERE rn >= 1000 ORDER BY rn LIMIT 3;
```

Rows at rn 1001+ were invisible before the fix; finding them in the UI's
search proves the pagination works. Clear the search box before counting rows
(leftover filter text silently shrinks the list).

## Attributing a totals gap (prove it before fixing)

Reproduce BOTH disagreeing numbers in SQL, including the cap, and check the
dropped rows equal the gap:

```sql
WITH ranked AS (
  SELECT total_amount, status,
         ROW_NUMBER() OVER (ORDER BY created_at DESC) AS rn
  FROM invoices
)
SELECT
  (SELECT SUM(total_amount) FROM ranked WHERE status NOT IN ('cancelled','draft')) AS true_total,
  (SELECT SUM(total_amount) FROM ranked WHERE rn <= 500 AND status NOT IN ('cancelled','draft')) AS capped_total,
  (SELECT SUM(total_amount) FROM ranked WHERE rn > 500 AND status NOT IN ('cancelled','draft')) AS dropped_rows;
-- dropped_rows = true_total − capped_total → cap fully explains the gap
```

If it doesn't reconcile exactly, another axis is in play (status filters,
date semantics, gross-vs-net) — see the report-total-discrepancy-triage skill
for the full decomposition checklist.

## What this is NOT

- This is NOT a permission/RLS issue — those would prevent the record from loading at all (empty result, not "missing specific item")
- This is NOT a timezone/date filter bug — those would affect all records on a date, not a specific one
- This is NOT a null-handling issue in the display — the record simply isn't in the loaded set

## This Project's Known Patterns

Shared helper: **`lib/fetch-all.ts`** — import it instead of re-implementing.

| Entity | File | Bug | Fix | Status |
|--------|------|-----|-----|--------|
| Customers (POS dropdown) | `app/(erp)/sales/pos/page.tsx` | `.limit(100)` without `ORDER BY` — record at row 103+ invisible | `.order('name')` (removed limit) | Fixed; 129 active customers, safe under 1,000 cap |
| Customer search (advances) | `app/(erp)/sales/advances/page.tsx` | `.ilike('name', ...)` only — code/phone search returns nothing | `.or('name/code/phone.ilike...')` | Fixed |
| Global header search | `components/layout/Header.tsx` | `.ilike(src.labelCol, ...)` only — customer code and product SKU search broken | Added `searchCols[]` + `.or()` | Fixed |
| Products (POS) | `app/(erp)/sales/pos/page.tsx` | Server-side search with `.or()` and `ORDER BY name` — correct | None | OK |
| Products | `components/ui/ProductFilterDropdown.tsx` | Server-side search with `.or()` — correct | None | OK |
| Products | `components/ui/ProductSearchInput.tsx` | Server-side search with `.or()` — correct | None | OK |
| Customers (CRM) | `app/(erp)/crm/page.tsx` | Loads all rows — correct | None | OK |
| Customers | `components/ui/CustomerSearchInput.tsx` | Server-side search with `.or()` — correct | None | OK |
| Suppliers | `app/(erp)/suppliers/page.tsx` | Loads all rows — correct | None | OK |
| Suppliers | `components/ui/SupplierSearchInput.tsx` | Server-side search with `.or()` — correct | None | OK |
| Expenses (journal) | `app/(erp)/expenses/page.tsx` | `.limit(500)` + client-side filter on `reference_type=manual` | 129 manual entries as of 2026-09-03 — safe; switch to fetchAll as it approaches 500 | Verified safe |
| Invoices (sales) | `app/(erp)/sales/page.tsx` | `.limit(500)` understated Total Sales ৳6.34L | `fetchAll` pagination via `lib/fetch-all.ts` | Fixed 2026-09-01 |
| Products + invoices (barcode-print) | `app/(erp)/inventory/barcode-print/page.tsx` | products query no `.limit()` → 1,000 of 2,541 loaded (60% of catalog unfindable); invoices `.limit(500)` of 602 | `fetchAll` + `.order('id')` tiebreakers (152 duplicate product names) — commit 2500ed9 | Fixed 2026-09-03 |
| Invoice search (reference field) | sales (main + outstanding modal), dashboard receivables, returns (list + ReturnModal), refunds, edit-history, barcode-print invoice mode | Invoice searches matched invoice # + customer only — invoices grouped by site/project reference (e.g. "Gypsum Properties", 52 invoices) unfindable | Added `invoices.reference` match everywhere (join it in where the row isn't the invoice: refunds/edit-history embed `invoice:invoices(reference)`) | Fixed 2026-09-03 |
