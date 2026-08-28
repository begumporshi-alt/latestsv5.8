---
name: pagination-search-bug
description: Diagnose and fix items missing from a list/search UI. Use when a user reports an item not appearing in a search, filter, or dropdown — especially after an edit or new record creation. Triggers on reports like "item X doesn't show up", "search returns nothing", "dropdown is missing options", "can't find the record I just created". Always check the pattern described here before assuming a display bug or permission issue.
---

# Pagination-Search Bug Hunter

## Classic symptom

A record **exists in the database** but is **not found** in a search or dropdown UI. The user can see it elsewhere (e.g. a detail page, a report, a different module) but searching in a specific UI field returns nothing. All other records in the same list appear fine.

## The root cause (most common)

**Client-side filter over a capped, unordered initial load.** The UI fetches only the first N rows with `.limit(N)` (often 50 or 100) and no `ORDER BY`, then filters those rows in JavaScript. Items beyond the limit are silently absent. This is especially likely when:
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

Query the database directly with `psql`. The connection string for this project is:
```
postgresql://postgres.qdnbefqmcxjvddlabeww:ooDwacL1abHedqXa@aws-1-ap-southeast-2.pooler.supabase.com:6543/postgres
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

To sweep the codebase:
```
grep -rn "\.limit(" --include="*.tsx" --include="*.ts" . | grep -v node_modules | grep -v ".d.ts"
grep -rn "\.ilike(" --include="*.tsx" --include="*.ts" . | grep -v node_modules
```

For each result, check if there's a `.filter()` on the same data downstream. If so, apply the checklist above.

## What this is NOT

- This is NOT a permission/RLS issue — those would prevent the record from loading at all (empty result, not "missing specific item")
- This is NOT a timezone/date filter bug — those would affect all records on a date, not a specific one
- This is NOT a null-handling issue in the display — the record simply isn't in the loaded set

## This Project's Known Patterns

| Entity | File | Bug | Fix | Status |
|--------|------|-----|-----|--------|
| Customers (POS dropdown) | `app/(erp)/sales/pos/page.tsx:217-224` | `.limit(100)` without `ORDER BY` — record at row 103+ invisible | `.order('name')` (removed limit) | Fixed |
| Customer search (advances) | `app/(erp)/sales/advances/page.tsx:477` | `.ilike('name', ...)` only — code/phone search returns nothing | `.or('name/code/phone.ilike...')` | Fixed |
| Global header search | `components/layout/Header.tsx:112` | `.ilike(src.labelCol, ...)` only — customer code and product SKU search broken | Added `searchCols[]` + `.or()` | Fixed |
| Products (POS) | `app/(erp)/sales/pos/page.tsx:200-203` | Server-side search with `.or()` and `ORDER BY name` — correct | None | OK |
| Products | `components/ui/ProductFilterDropdown.tsx:39` | Server-side search with `.or()` — correct | None | OK |
| Products | `components/ui/ProductSearchInput.tsx:86` | Server-side search with `.or()` — correct | None | OK |
| Customers (CRM) | `app/(erp)/crm/page.tsx:68` | Loads all rows — correct | None | OK |
| Customers | `components/ui/CustomerSearchInput.tsx:51` | Server-side search with `.or()` — correct | None | OK |
| Suppliers | `app/(erp)/suppliers/page.tsx:25` | Loads all rows — correct | None | OK |
| Suppliers | `components/ui/SupplierSearchInput.tsx:53` | Server-side search with `.or()` — correct | None | OK |
| Expenses (journal) | `app/(erp)/expenses/page.tsx:86` | `.limit(500)` + client-side filter on `reference_type=manual` | Verify count of manual entries < 500 | Needs check |
| Invoices (sales) | `app/(erp)/sales/page.tsx:138` | `.limit(500)`, 387 non-cancelled invoices total — safe for now | Add `ORDER BY invoice_date DESC` | Low risk |
