# Offline Mode — Architecture & Operations

SI Building Solutions ERP works fully offline for its core modules — POS sales,
inventory/product management, customers, employees and attendance — using a
complete local database plus an encrypted write queue, and synchronizes
automatically the moment connectivity returns.

**Status:** shipped 2026-09-10. End-to-end test report: [offline-test-report.md](offline-test-report.md).

---

## 1. What works offline

| Area | Offline capability |
|---|---|
| POS | Full checkout: product search over the whole catalog, cart, discounts, VAT, shipping, payment terms, store credit. Orders get a temporary `OFF-…` number and are queued encrypted. |
| Inventory / Products | View stock and stats; create and edit products (fields, variants, opening stock, per-warehouse adjustments) — queued for sync. |
| Customers | Full CRUD; quick-add from the POS is immediately sellable (offline-created customers get a client UUID the server honors). |
| Employees | Full CRUD, including termination. |
| Attendance | Mark status, edit check-in/out times and notes per day. |
| Sales list | Review invoices (cached per period window). |
| Sync Center | Queue review, conflict resolution, retry/discard, local database status. |

Accounting reads (journal, P&L, balance sheet, reports) and purchase-side
modules remain online-only by design — see §4.

## 2. Architecture

```
┌────────────────────────── Browser ──────────────────────────┐
│  Pages (POS, inventory, CRM, HR, sales)                     │
│     │ reads                        │ writes                 │
│  cachedQuery()                  enqueueOp()                 │
│     │ stale-while-revalidate        │ seals payload          │
│  ┌──▼──────────────┐   ┌───────────▼─────────┐   ┌────────┐ │
│  │ Page caches     │   │ Outbox (queue)      │   │ Local  │ │
│  │ (per dataset,   │   │ ordered by time,    │   │ DB:    │ │
│  │  TTL, encrypted)│   │ status lifecycle    │   │ full   │ │
│  └─────────────────┘   └───────────┬─────────┘   │ table  │ │
│  ┌──────────────────────────────────▼──────────  │ replica│ │
│  │ Sync engine: drain when online (event + 30s)  │ (encr.)│ │
│  │ supabase.rpc('sync_apply', item_id, op, data) └────────┘ │
│  └──────────────────────────┬──────────────────  Replicator│
│  Network monitor: events +  │/api/ping probe     (15 min)   │
└─────────────────────────────┼───────────────────────────────┘
                              │ HTTPS (TLS), authenticated
┌─────────────────────────────▼───────────────────────────────┐
│  Postgres: sync_apply(p_item_id, p_op, p_payload)           │
│  • atomic claim in sync_applied_items (idempotency)         │
│  • per-op handlers replicate the page flows exactly         │
│  • triggers fire as usual: FIFO, COGS/AR journals, balances │
│  • version mismatch → {status:'conflict', server_row}       │
└─────────────────────────────────────────────────────────────┘
```

### 2.1 Reads — three layers, always local-first

1. **Page caches** (`lib/offline/cache.ts`): each dataset a page loads is
   sealed (AES-GCM) into IndexedDB with a TTL. Online, a fresh-enough cache is
   served instantly and refreshed in the background; offline, the last copy is
   served with a stale banner.
2. **The local database** (`lib/offline/replica.ts`): complete, encrypted
   copies of 15 core tables (8,000+ rows: products, stock counters, product
   units, customers, invoices, invoice items, payments, sales returns,
   employees, attendance, warehouses, brands, categories, payment methods,
   suppliers). Refreshed fully on login, on reconnection, and every 15 minutes
   while online. This is what makes offline coverage independent of which
   pages were visited while online — the POS builds its catalog from the
   replica when no page cache exists yet.
3. **Service worker** (`public/sw.js`, production builds): caches the app
   shell so the application itself loads offline. Navigations are
   network-first (fresh while online, cached copy when offline); immutable
   `_next/static` assets are cache-first. In dev it is not registered —
   Next dev serves non-hashed chunk URLs and a cache-first SW would serve
   stale code.

### 2.2 Writes — the outbox pattern

Every offline mutation is queued as an item in the encrypted outbox
(`lib/offline/outbox.ts`) with a client-generated UUID. The sync engine
(`lib/offline/sync.ts`) replays items **in creation order** when online
(connectivity regained, every 30 s, or manual "Sync now").

- **Idempotency**: the item UUID is claimed in `sync_applied_items` in the
  same transaction as the operation. A redelivery returns the original result
  as `{status:'duplicate'}` — a replayed sync can never double-apply.
- **Atomicity**: each handler (`sync_invoice_create`, `sync_product_*`,
  `sync_customer_*`, `sync_employee_*`, `sync_attendance_*`) replicates the
  corresponding page flow server-side in one transaction. Any failure rolls
  the claim back, so retries are safe.
- **Conflicts**: updates carry `expected_updated_at` (the version the client
  last saw). A mismatch returns the server row; the Sync Center shows both
  versions side by side and the user chooses *Keep server* (discard) or
  *Overwrite server* (forced retry). New records cannot conflict; the server
  assigns real numbers (POS-…, CUST-…) at sync time.
- **Errors**: server errors are retried with backoff, then parked as *failed*
  with the server's message visible in the Sync Center (Retry / Discard).
- **Offline gates**: the oversell and credit-limit gates fall back to the
  cached/replica snapshots (marked *stale*); with a stale snapshot the hard
  "no stock record" block degrades to an explicit warn-and-confirm, matching
  the advisory policy of the online gates. The server re-derives everything
  (FIFO, redemptions) from live data at sync time.
- **Optimistic local effects**: an offline sale immediately decrements the
  cached stock and ledger snapshots; offline product edits patch the
  inventory list and POS catalog so the session stays coherent. All local
  effects are overwritten by the next online refresh.

### 2.3 Network detection

`navigator.onLine` lies (captive portals, dead routes), so the monitor
(`lib/offline/network.ts`) also probes `GET /api/ping` (never cached by the
SW — it is the connectivity truth source) on the `online` event, on tab
visibility, and every 30 s. Transport failures anywhere in the app mark the
app offline and re-arm probing.

## 3. Security model

- **At rest**: every byte in IndexedDB — local database rows, page caches,
  outbox payloads, server results — is sealed with **AES-256-GCM** using a
  per-user, **non-extractable** `CryptoKey` stored only in IndexedDB (it can
  never be exported, even by script in the page). Fresh random IV per record.
  Honest scope: this protects the persisted files against offline extraction;
  no browser-local scheme can protect against code running in the same
  unlocked profile.
- **In transit**: all sync traffic uses the same authenticated HTTPS (TLS)
  channel as the rest of the app. Payloads are unsealed only in memory for
  the duration of a sync call. *Note on "end-to-end" encryption: literal E2E
  (client-only encryption the server cannot read) is impossible here by
  design — the server must read the payload to run the accounting logic
  (FIFO, journals). TLS transport encryption + at-rest encryption is the
  strongest model compatible with server-side accounting integrity.*
- **Sign-out wipes everything**: logging out clears the local database, all
  caches, the queued changes and the encryption key from the device.
- **Server side**: `sync_apply` is `SECURITY DEFINER`, revoked from `anon`,
  granted to `authenticated` only; per-op handlers are owner-only; the
  idempotency ledger has RLS (own rows).

## 4. Why writes are a queue, not a local database you write to

In this ERP the database *is* the business logic: FIFO batch consumption,
COGS/AR journal entries, customer and account balances are computed by
Postgres triggers/RPCs at write time. Writing directly into a local database
and syncing table changes would require a second implementation of that
accounting logic in the browser — two sources of financial truth that drift,
which is precisely the class of corruption this codebase has had to repair
before. The outbox keeps a single accounting authority (the server) while
giving full offline capability; the verification in the test report shows a
synced offline sale is indistinguishable from an online one (balanced
journals, correct FIFO batch, payment, idempotency).

## 5. Operations

- **Sync Center** (`/sync`, also linked from Settings in the sidebar):
  connectivity + queue + conflicts + failed items + recently synced results
  (e.g. the real POS number assigned to an offline order) + local database
  per-table counts and refresh.
- **Header pill**: Online / Offline (n queued) / Syncing… / Sync issues —
  click to open the Sync Center. A slim banner appears under the header
  whenever offline or when attention is needed.
- **First-use**: open the app once while online — the local database and
  page caches build automatically (a minute for the full catalog). Until
  then offline pages show a "no cached copy" notice.
- **Known behavior**: the local database is a point-in-time snapshot; rows
  created on the server after the last refresh appear after the next
  refresh (≤ 15 min online, or on reconnection). Sessions survive offline
  until the access token needs refreshing; a hard-expired session requires
  one online visit to re-authenticate before queued changes can sync.
- **Dev mode**: the service worker intentionally does not register during
  `next dev` (stale-chunk hazard). Test offline page loads against a
  production build (`npm run build && npm start`).

## 6. Code map

| Piece | File |
|---|---|
| Crypto (AES-GCM seal/unseal, key mgmt) | `lib/offline/crypto.ts` |
| IndexedDB schema (outbox/cache/meta/keys + replica tables) | `lib/offline/db.ts` |
| Read-through cache + network-error classification | `lib/offline/cache.ts` |
| Network monitor | `lib/offline/network.ts` |
| Outbox (enqueue, resolve actions) | `lib/offline/outbox.ts` |
| Sync engine (ordered drain, retries, conflicts) | `lib/offline/sync.ts` |
| Local database replicator + table specs | `lib/offline/replica.ts` |
| Optimistic cache patches after offline writes | `lib/offline/optimistic.ts` |
| React provider + hooks | `lib/offline/provider.tsx`, `lib/offline/use-cached-query.ts` |
| Shared cache keys | `lib/offline/keys.ts` |
| Status pill / banner / SW registrar | `components/offline/*` |
| Sync Center page | `app/(erp)/sync/page.tsx` |
| Offline fallback page | `app/offline/page.tsx` |
| Service worker + manifest | `public/sw.js`, `public/manifest.json` |
| Server: sync_apply + handlers + idempotency ledger | `supabase/migrations/20260909233000_offline_sync.sql` |
| Unit tests | `lib/offline/__tests__/offline-lib.test.ts` |

## 7. PWA — installing SI ERP as an app

The offline work ships the full installability stack, so SI ERP can be
installed like a native app: its own window (no browser chrome), a
dock/desktop/home-screen icon, launch straight to `/dashboard`, and offline
start-up via the service worker.

**What was added (2026-09-10):**

- `app/layout.tsx` metadata: `themeColor`, `appleWebApp`
  (`apple-mobile-web-app-capable`, status-bar style, title), the unprefixed
  `mobile-web-app-capable` (Chrome's replacement for the deprecated
  apple-prefixed meta), and the icon set.
- `public/manifest.json`: stable `id`, `orientation: any` (POS tablets run
  landscape), **maskable icon variants** (Android crops "any"-purpose icons
  into a white circle; maskable ones fill the shape), and app **shortcuts**
  (long-press the icon → POS / Inventory / Sales / Sync Center).
- Regenerated icon set from the company logo's circular emblem
  (`icon-192/512.png` — the previous icons were a center-square crop that cut
  the wordmark's sides), plus `apple-touch-icon.png` (180×180, iOS),
  `favicon.ico` (48/32/16 — fixes a 404 `sw.js` already special-cased), and
  `icon-{192,512}-maskable.png`.
- `lib/pwa/install.ts` — `useInstallPrompt()` hook. The
  `beforeinstallprompt` listener lives at **module scope** because the event
  can fire before React mounts (it follows SW activation); the hook also
  tracks `appinstalled`, standalone display-mode (suppresses prompts when
  already installed), and a persisted dismissal.
- `components/pwa/InstallButton.tsx` — Header pill next to the offline
  status pill. Renders only on Chromium-family browsers once the browser
  actually offers the install flow.
- `components/pwa/InstallCard.tsx` — permanent "Install as app" section in
  the Sync Center (ignores the pill's dismissal): install button on
  Chromium, manual steps on iOS (Share → Add to Home Screen — Safari has no
  prompt API) and macOS Safari (File → Add to Dock…), and an
  already-installed confirmation.
- `ServiceWorkerRegistrar` shows an **"App updated — refresh"** toast when a
  new service worker takes over a running page (guarded so the very first
  control doesn't fire a false positive).

**Platform notes:**

| Browser | Install path |
|---|---|
| Chrome / Edge / Opera (desktop + Android) | Header pill or Sync Center button → native install dialog |
| Safari on iOS/iPadOS | Share → Add to Home Screen (steps shown in Sync Center) |
| Safari on macOS | File → Add to Dock… (steps shown in Sync Center) |
| Firefox | Not supported — Sync Center says so |

**Dev-mode caveat:** the service worker registers production-only (stale
dev-chunk hazard, §6 finding 4), so installability — including the install
pill — only exists in production builds (`npm run build && npx next start`).

**Code map additions:** `lib/pwa/install.ts`, `components/pwa/*`,
icon/manifest assets in `public/`.
