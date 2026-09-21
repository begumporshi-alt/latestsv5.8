---
name: search-feature-robustness
description: Build, review, or debug any search / filter / autocomplete / picker UI in this project. Use when adding a new search box, when a user reports "search doesn't find X", "can't find a product by barcode", "search returns nothing", "typing a comma/parenthesis breaks search", "results flicker or show the wrong list while typing", or when reviewing an existing search implementation. Covers PostgREST filter grammar safety, multi-word token matching, which columns to search, request race conditions, and offline/online parity. Pair with the pagination-search-bug skill — this one makes a search correct, that one makes it complete.
---

# Search Feature Robustness

A search box that "kind of works" is a support ticket waiting to happen. This
skill is the checklist + canonical implementation for every search, filter,
autocomplete and picker in the ERP.

Real case that produced this skill: the POS product grid search looked fine in
demos on a small catalog, but operators reported it "not robust to find
products". Four independent defects were stacked in one 60-line function —
missing barcode matching, a PostgREST grammar injection that silently voided
the whole search on a comma, order-dependent multi-word matching, and a
response race that let a slow older query overwrite the newest results.

## The five failure modes

### 1. The column users actually type isn't searched

Barcode is the obvious one: operators scan or type a barcode, the query only
matched `name` and `sku`, so nothing came back unless the SKU happened to
equal the barcode. Generalise: **a search must match every identifier a user
can read off the product/customer/document** — name, SKU, barcode, code,
phone, email, document number, reference.

Check: `grep -n "\.or(" <file>` and look at the columns listed. If the table
has a `barcode`, `code`, `phone` or `reference` column and it is absent, that
is a bug.

### 2. PostgREST `.or()` grammar injection (the silent killer)

`supabase-js` builds a filter *string*. PostgREST's grammar treats these as
syntax:

```
,   separates conditions
( ) grouping / and(...) / in(...)
%   wildcard inside ilike
_   single-char wildcard
\   escape
```

So the natural-looking code

```ts
// BROKEN — user input interpolated raw into filter grammar
query = query.or(`name.ilike.%${q.trim()}%,sku.ilike.%${q.trim()}%`);
```

returns **nothing** (or a 400) for perfectly ordinary searches:
`"cable, 3mm"`, `"board (12mm)"`, `"50% cotton"`, `"item_1"`. The whole grid
goes blank with no error shown, which is exactly why this survives testing.

Fix: strip the grammar characters before interpolating (see the canonical
implementation below). Nothing else is needed — the term is still matched as
substring text.

### 3. Multi-word queries are order- and adjacency-dependent

`"gypsum 12mm"` must find `"12mm Gypsum Board"`. A single
`.or(name.ilike.%whole string%)` cannot do that.

Fix: split into tokens, then **one `.or()` per token** — PostgREST ANDs
top-level filters together, while each `.or()` is an OR across columns:

```ts
tokens.forEach(t => {
  query = query.or(`name.ilike.%${t}%,sku.ilike.%${t}%,barcode.ilike.%${t}%`);
});
```

### 4. Out-of-order responses (the "flicker" bug)

Debouncing alone does not make a search correct. Two keystrokes can be in
flight at once; the slower (older) response resolves last and repaints the
grid with results for a query the user has already moved past.

Fix: a monotonic sequence guard — every load takes a ticket, and only the
newest ticket is allowed to write state (applies to the loading flag too, so a
stale response cannot clear the spinner early):

```ts
const seq = ++searchSeqRef.current;
const { data } = await query;
if (seq !== searchSeqRef.current) return;   // superseded — drop it
setProducts(data);
```

### 5. Online and offline search disagree

This app runs offline-first. Every online search path has an offline twin
(cached snapshot → local replica → notice). If the offline branch filters
differently — fewer columns, different token rules, no `track_inventory`
filter — the same query returns different results depending on network state,
which users experience as "search is flaky".

Rule: **the predicate must be shared**. Build one `matches*` predicate and use
it in the online filter *and* every fallback branch. Keep the offline snapshot
query's `select()` column list identical to the online one (plus any
`track_inventory`-style flags needed to filter identically), and give it a
deterministic `.order('id')` tiebreaker so `fetchAll` pagination is stable.

## Canonical implementation

Copy this shape for any search that hits the server. (`PRODUCT`-specific
columns are marked; swap for the entity you're searching.)

```ts
/**
 * Search robustness helpers.
 *  - PostgREST's .or() grammar treats , ( ) % _ \ as syntax, so an
 *    unsanitised term like "cable, 3mm" produced a malformed filter and the
 *    whole search silently returned nothing.
 *  - Tokens are AND-ed so word order doesn't matter ("gypsum 12mm" finds
 *    "12mm Gypsum Board"); each token matches name, SKU or barcode.
 */
function tokenizeSearch(q: string): string[] {
  return q
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/[,()%_\\'"]/g, ''))   // strip filter grammar
    .filter(Boolean)
    .slice(0, 5)                                  // cap the filter size
    .map((t) => t.toLowerCase());
}

function matchesSearch(row: ProductData, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const hay = [row.name, row.sku, row.barcode].map((v) => String(v || '').toLowerCase());
  return tokens.every((t) => hay.some((h) => h.includes(t)));
}
```

```ts
// --- online query ---
const tokens = tokenizeSearch(q);
let query = supabase
  .from('products')
  .select(`id, name, sku, barcode, ...`, { count: 'exact' })   // include every searched column
  .eq('is_active', true)
  .order('name');

tokens.forEach((t) => {
  query = query.or(`name.ilike.%${t}%,sku.ilike.%${t}%,barcode.ilike.%${t}%`);
});

const { data, error } = await query.limit(60);

// --- offline / network-drop fallback: the SAME predicate ---
let list = cached.filter((p) => matchesSearch(p, tokens));
```

```ts
// --- race guard, around the whole load ---
const seq = ++searchSeqRef.current;
...
if (seq === searchSeqRef.current) setProducts(list);
```

### Escape hatch: RPC / SQL
When a search needs ranking, fuzzy matching, or many columns, stop fighting
the grammar and move it into an RPC (`search_*` / `list_*` names are treated
as read-only RPCs by the offline read fallback). Pass the term as a
**parameter**, never as filter text — SQL injection is handled by the driver,
and `ILIKE` on tokenised terms can stay in SQL. See
`lib/offline/read-fallback.ts` for the RPC allowlist.

## Checklist for a new search feature

- [ ] Every user-readable identifier is searched: name, SKU, **barcode**, code, phone, reference
- [ ] Search text is tokenised and **sanitised** before touching `.or()`
- [ ] Multiple tokens are AND-ed with one `.or()` per token
- [ ] Empty/whitespace query returns the default list (not "everything" from `%%`)
- [ ] A monotonic sequence guard drops superseded responses (state *and* spinner)
- [ ] Debounce ~250 ms on typing; filters (brand/category) reuse the same load path
- [ ] The offline fallback uses the shared predicate and the same columns
- [ ] `select()` includes every column the predicate reads (a missing column makes the offline filter stricter than online)
- [ ] Server search is paginated/limited, and any client-side "load everything" path uses `fetchAll` + `.order('id')` (see the **pagination-search-bug** skill)
- [ ] Placeholder text states what can be searched ("name, SKU or barcode")
- [ ] Tested with: bare word · barcode · two words reversed · `,` and `(`/`)` in the term · rapid typing · offline

## This project's known patterns

The canonical helpers live in **`lib/search.ts`** (`tokenizeSearch`,
`buildIlikeOrFilters`, `applyIlikeTokens`, `matchesTokens`) with unit tests in
`lib/__tests__/search.test.ts`. New searches should import from there, not
re-implement.

Status after the migration (commit with `feat(search): shared sanitised
tokenised search helpers`):

| Search site | Notes | Status |
|---|---|---|
| POS product grid | name + SKU + barcode, tokenised, race-guarded, offline parity | **Fixed** `6ae008e`, migrated to `lib/search.ts` |
| Quotation product gallery | client-side over the full catalog; matches name/SKU/barcode, but single-substring (no tokenising) | Tokenising advisable |
| `components/ui/ProductSearchInput.tsx` | migrated: barcode added, sanitised tokens, race guard | **Fixed** |
| `components/ui/CustomerSearchInput.tsx` | migrated: sanitised tokens, race guard | **Fixed** |
| `components/ui/SupplierSearchInput.tsx` | migrated: sanitised tokens, race guard | **Fixed** |
| `components/ui/ProductFilterDropdown.tsx` | migrated: barcode added, sanitised tokens | **Fixed** |
| `components/layout/Header.tsx` global search | migrated: per-token filters across all `searchCols` | **Fixed** |
| `app/(erp)/sales/advances/page.tsx` | migrated: sanitised tokens | **Fixed** |
| `app/(erp)/inventory/movements/page.tsx` | migrated (product pre-search + reference/notes `.or()` chains) | **Fixed** |
| `app/(erp)/reports/activity/page.tsx` | migrated: sanitised tokens | **Fixed** |

Any new search site should reuse `lib/search.ts` and add itself here.

## Tests to add

Pure predicate functions (`tokenizeSearch`, `matchesSearch`) are the cheapest
thing to unit-test — put them beside the existing suites (`lib/offline/__tests__`,
`__tests__/`) and cover:

```ts
tokenizeSearch('cable, 3mm')      // → ['cable', '3mm']  (comma stripped)
matchesSearch(row, tokenizeSearch('gypsum 12mm'))  // both orders match
matchesSearch(row, tokenizeSearch('   '))          // → true (default list)
tokenizeSearch('a b c d e f g')                    // → 5 tokens max
// barcode hit:
matchesSearch({ name: 'X', sku: 'Y', barcode: '123' }, ['123'])  // → true
```

For the race guard, assert observable behaviour instead of implementation:
fire two loads with a controlled-resolution promise, then verify the state
matches the newest query.

## Relationship to the other search skill

| Skill | Question it answers |
|---|---|
| **search-feature-robustness** (this one) | Does this search *find the right rows for the typed query*? |
| **pagination-search-bug** | Does this search *see the whole table at all*? |

Both are needed: a perfectly sanitised query over capped data still hides
records, and a complete dataset behind a grammar-broken filter still returns
nothing.
