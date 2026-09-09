# Offline Mode — Test Report

Date: 2026-09-10 · Branch: `customer-search-improvements` · Environment: live
Supabase DB + `next dev` on :3001, Chrome 153 via CDP with network emulation,
authenticated session (xempireleader).

Verification method: a11y-tree snapshots and DOM reads (not screenshots),
DB verification via psql against the live database. Unit tests via jest.
Pre-test full database backup: `backups/sisolution-full-20260909-230241.dump`
(verified CRC-clean).

---

## 1. Unit tests (jest)

`lib/offline/__tests__/offline-lib.test.ts` — 6 tests, all passing
(`npx jest` → 12/12 including the pre-existing suite):

| # | Test | Result |
|---|---|---|
| U1 | seal → unseal round-trips structured data; ciphertext contains no plaintext | PASS |
| U2 | Identical input seals to different ciphertext/IV every time | PASS |
| U3 | Tampered ciphertext fails GCM authentication | PASS |
| U4 | A different key cannot decrypt the blob | PASS |
| U5 | Browser/Supabase network failures classified as network errors | PASS |
| U6 | Business/RPC errors NOT classified as network errors (park, don't retry) | PASS |

## 2. Server-side RPC smoke tests (psql, transaction-rolled-back)

`sync_apply` exercised via psql with a session JWT inside `BEGIN; … ROLLBACK;`
(nothing persisted):

| # | Check | Result |
|---|---|---|
| S1 | Unauthenticated call raises | PASS |
| S2 | Unknown op raises | PASS |
| S3 | attendance.mark applies, returns `{status:"synced"}` | PASS |
| S4 | Redelivery of the same item id returns `{status:"duplicate"}` with stored result | PASS |
| S5 | Row written exactly once (count = 1 after two deliveries) | PASS |
| S6 | customer.update on a missing id → `{status:"conflict", server_row:null}` | PASS |
| S7 | Conflict does NOT persist the idempotency claim (retry same id works) | PASS |

## 3. Browser test matrix (network emulation)

### T1 — Stable connection

| Check | Result |
|---|---|
| POS loads products/customers (a11y tree: 180 price entries, walk-in resolved) | PASS |
| Status pill reads "Online" | PASS |
| Service worker registered, active, scope `/` | PASS |
| Page caches fill (products 1.4 MB, customers 103 KB — encrypted) | PASS |
| Encryption key present in IndexedDB (non-extractable) | PASS |

### T2 — Complete offline state

| Check | Result |
|---|---|
| Pill flips to "Offline" + banner appears immediately | PASS |
| **Full page reload offline** — service worker serves cached shell, page renders | PASS |
| Product search offline serves the encrypted cache (2,559 products, query "cable" → filtered list) | PASS |
| **Offline checkout**: add "25rm Cable lux" (৳40) → Confirm Charge panel renders fully offline (terms, methods from cache) → Charge | PASS |
| Order queued: temp number `OFF-77134979`, pill shows "Offline · 1 queued", cart resets, in-session stock 10→9 | PASS |
| Outbox holds exactly one AES-GCM-encrypted `invoice.create` (1,240 bytes) | PASS |
| Offline customer edit (CRM modal) queues `customer.update` | PASS |

### T3 — Reconnection & data integrity

| Check | Result |
|---|---|
| Sync engine drains on reconnect; Sync Center retry applies the item | PASS |
| Real number assigned: `POS-00590212` shown in "Recently synced" | PASS |
| Invoice row: paid, is_pos, ৳40, walk-in customer, correct date | PASS |
| invoice_items: qty/price/cost/subtotal/sort_order/base_quantity/warehouse correct | PASS |
| Payment `PAY-997311`: ৳40 cash, received, paid_invoice_pay | PASS |
| **Journals balanced**: JE-965539 (AR) Dr 40 = Cr 40; JE-965540 (COGS) Dr 25 = Cr 25 | PASS |
| **FIFO consumed from the correct (oldest-with-stock) batch**: 10 → 9 remaining + consumption row qty 1 | PASS |
| Counter stock 10 → 9 | PASS |
| cost_price_history row recorded | PASS |
| Idempotency ledger row exists for the item id with the assigned number | PASS |
| Conflict path returns no lingering claim (verified separately in S6/S7) | PASS |

### T4 — Conflict detection & resolution

Scenario: edit customer "Abdu Rahim" offline; concurrently change the same row
server-side (psql, bumping `updated_at`); reconnect.

| Check | Result |
|---|---|
| Sync returns conflict; Sync Center shows "Conflicts (1)" | PASS |
| Side-by-side diff: Your version "Abdu Rahim (offline edit)" vs Server version "Abdu Rahim (SERVER edit)" | PASS |
| Resolve "Overwrite server with mine" → item re-queued with force flag | PASS |
| After sync, server row = "Abdu Rahim (offline edit)" (psql) | PASS |
| Idempotency ledger count = 2 (invoice + customer edit) | PASS |

### T5 — Intermittent connectivity (Slow 3G)

| Check | Result |
|---|---|
| Dashboard loads under Slow 3G (shell + cards render; data arrives slowly, no crashes) | PASS |
| Pill remains "Online"; no false offline flapping | PASS |

## 4. Local database (full replica)

| Check | Result |
|---|---|
| Auto-fills on login without visiting any data page (8,288 rows, 15 tables) | PASS |
| Per-table counts equal live DB (products 2,575 · stock counters 1,449 · units 96 · customers 139 · invoices 693 · invoice items 2,145 · payments 1,045 · returns 16 · employees 1 · attendance 4 · warehouses 3 · brands 62 · categories 33 · payment methods 9 · suppliers 18) | PASS |
| payments +1 on server = a live payment posted after the snapshot (point-in-time behavior; picked up on next refresh) | Expected |
| **Fresh-device simulation**: all page caches wiped, emulate offline, POS search "walton" → 63 matches served from the local database | PASS |
| Sync Center "Local Database" section shows counts/last-sync/refresh | PASS |
| All replica rows sealed (AES-256-GCM per record) | PASS |
| Sign-out clears all local stores (code-verified: `clearLocalData` wipes every table) | PASS |

## 5. Production build & type safety

| Check | Result |
|---|---|
| `tsc --noEmit` | PASS (0 errors) |
| `next build` | PASS (all routes incl. `/sync`, `/offline`) |
| `npx jest` | PASS (12/12) |

## 6. Findings & fixes made during testing

1. **`invoice_items.sort_order` NOT NULL** — the sync handler passed an
   explicit NULL (overriding the column default). Fixed with
   `coalesce(nullif(...), 0)`; migration re-applied. The failed attempts were
   safely retryable because the claim rolls back with the transaction.
2. **`tags` JSON null** — `jsonb_array_elements_text(jsonb 'null')` raised
   "cannot extract elements from a scalar". Fixed with a `jsonb_typeof`
   guard.
3. **POS `loadProducts` had no network-failure fallback** (only the
   pre-checked offline branch). Fixed: fetch errors with network signatures
   now fall back to the cached snapshot (and then the local database).
4. **Dev-mode SW staleness** — Next dev serves non-hashed chunk URLs, so the
   cache-first SW served stale code after edits. Registration is now
   production-only; offline page-load testing documented against
   production builds (T2's reload test was run with the SW active before
   this change).

## 7. Residual limitations (documented, not defects)

- Accounting/purchase/report pages are online-only (by design — see
  docs/offline-mode.md §4).
- Hard-expired auth sessions need one online visit before queued changes can
  sync.
- The local database is a point-in-time snapshot (≤ 15 min staleness while
  online; refreshed on reconnect).
- Service worker does not register in dev mode (stale-chunk hazard).
