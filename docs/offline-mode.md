# Offline Mode — Architecture & Operations

SI Building Solutions ERP works offline end to end: **every page keeps its
last-known data**, page-to-page navigation never dead-ends, POS sales and the
other write flows queue encrypted, and everything synchronizes automatically
the moment connectivity returns.

**Status:** shipped 2026-09-10; offline coverage made independent of
page-visit history 2026-09-11 (replica query engine + report pre-warm).
End-to-end test report: [offline-test-report.md](offline-test-report.md).

---

## 1. What works offline

| Area | Offline capability |
|---|---|
| POS | Full checkout: product search over the whole catalog, cart, discounts, VAT, shipping, payment terms, store credit. Orders get a temporary `OFF-…` number and are queued encrypted. |
| Inventory / Products | View stock and stats; create and edit products (fields, variants, opening stock, per-warehouse adjustments) — queued for sync. |
| Customers | Full CRUD; quick-add from the POS is immediately sellable (offline-created customers get a client UUID the server honors). |
| Employees | Full CRUD, including termination. |
| Attendance | Mark status, edit check-in/out times and notes per day. |
| **Every other page** | Dashboard, sales, purchases, quotations, accounting, reports, settings, CRM details … table reads are answered from the **local database** by a query engine, so pages work offline even if never opened on this device; server-computed report views (P&L, trial balance, aging, balance sheet, cash flow, accounting overview) show their **pre-warmed default view**. Changing a period/filter offline still needs one online visit of that view — shown as an explicit notice, never a blank screen. |
| Navigation | Every route's shell is precached, so clicking through the app offline always lands on a working page (client-side navigation falls back to a full page load served from the cache). |
| Sync Center | Queue review, conflict resolution, retry/discard, local database status, offline-report preparation. |

**No page visits are required.** Signing in once while online is enough: the
replicator downloads complete copies of every read table and the background
warm list saves the default report views — after that every page works
offline, even ones never opened on this device. Write actions for the
server-computed modules (accounting, purchasing) remain online-only — see §4.

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

### 2.1 Reads — six layers, always local-first

1. **The app-wide read fallback** (`lib/offline/read-fallback.ts`): the
   Supabase client every page imports is wrapped so a read behaves like this —
   *online*: exactly as before (live result, nothing served stale), with the
   result cached under a key derived from the table and the exact filter
   chain; *offline or network failure*: the last result for that same query is
   served instantly instead of an error. Writes (`insert/update/delete/
   upsert`) and non-read RPCs (`create_*`, `post_*`, `sync_apply`, …) are
   never cached, never faked — they always go to the network or fail loudly.
   Results are sealed per user, pruned LRU-style (kept ≤ 400 queries), and a
   query with no cached copy falls through to layer 2 before raising the
   "not available offline" notice.
2. **The replica query engine** (`lib/offline/replica-query.ts`): when a
   `.from(table)` read has no cached copy, the recorded postgrest method chain
   is replayed against the local database — filters (`eq/neq/gt/gte/lt/lte/
   in/ilike/is`, `.or()` expressions incl. nested `and(...)` and `in.(…)`
   lists), ordering, `limit`/`range`, `single`/`maybeSingle`,
   `{count:'exact', head:true}`, and relation embeds
   (`customer:customers(name)`, `items:invoice_items(*)`, `!inner`), including
   filters on embedded parents (`journal_entries.entry_date` on a
   journal-lines query) — all resolved through the schema's foreign keys.
   **Anything it cannot interpret returns "unsupported"**, and the caller
   falls back to the notice: it can never return wrong data, only decline.
   This is what makes offline coverage independent of page-visit history.
3. **Page caches** (`lib/offline/cache.ts`): the curated datasets the
   offline-capable pages load (POS catalog, CRM list, inventory aggregate,
   attendance per day, …) with a TTL; online a fresh cache is served instantly
   and refreshed in the background. Offline with no page cache, `cachedQuery`
   runs the fetcher anyway — the fetcher's reads go through the wrapped
   client, so the replica query engine answers them; only a non-empty result
   is cached, so a failed read can't poison the key.
4. **The local database** (`lib/offline/replica.ts`): complete, encrypted
   copies of **every table the pages read** (48 tables: products, stock
   counters, units, customers, invoices + items, payments, sales returns +
   items, employees, attendance, warehouses, brands, categories, payment
   methods, suppliers, app settings, store credits, FIFO batches, accounts,
   journal entries + lines, stock movements, quotations + items, purchase
   orders + items, reminders, returns, GRNs, deliveries + items, advances +
   refunds + applications, customer notes, store-credit redemptions, cost
   price history, product sizes/colors, unit types, projects, activity logs,
   profiles, online orders, bank reconciliation items, reconciliation log).
   Refreshed fully on login, on reconnection and every 15 minutes while
   online. Each table's clear+rewrite is a single transaction, so concurrent
   readers always see the old or the new rows, never an empty store; a run
   that completed within the last minute is skipped unless forced (the app
   start fires several triggers).
5. **Report pre-warm** (`lib/offline/warm.ts`): pages that compute through SQL
   functions (P&L, trial balance, aging, balance sheet, cash flow, accounting
   overview, dashboard cards, sales/reports COGS) can't be derived locally —
   so their **default-view RPCs** run in the background with the exact
   arguments the pages compute on first load (through the wrapped client, so
   each result lands in the very cache key the page will look up offline).
   Triggered after each completed replication, throttled to once per 6 h plus
   a re-run whenever the local day changes; also a "Prepare now" button in
   the Sync Center. Changing a period or filter offline still needs one
   online visit of that view.
6. **Service worker** (`public/sw.js`, production builds): precaches each
   deploy — every route's HTML **and every build asset** (App Router loads
   route chunks dynamically, so route HTML alone would leave never-visited
   routes unable to render) — and serves navigations network-first with the
   cached shell as fallback. Generations are stamped with the build id: a
   deploy builds the new generation beside the old one and switches over, so
   pages open during a deploy never mix old HTML with new chunks. In dev the
   SW is not registered — Next dev serves non-hashed chunk URLs and a
   cache-first SW would serve stale code.

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
- **Backups** (§8): the whole local database can be exported to a
  passphrase-encrypted `.sibak` file. The file holds all business data in
  plaintext *inside* its AES-256-GCM envelope (PBKDF2-SHA256, 600k
  iterations) — treat it like a `pg_dump`: it is only as safe as the
  passphrase and wherever you keep it. The device's non-extractable key
  never leaves IndexedDB; import re-seals everything with the importing
  device's own key.
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
  per-table counts and refresh + offline-report preparation status +
  storage persistence/quota status and encrypted backup export/restore (§8).
- **Header pill**: Online / Offline (n queued) / Syncing… / Sync issues —
  click to open the Sync Center. A slim banner appears under the header
  whenever offline or when attention is needed.
- **First-use**: sign in once while online — the local database (all read
  tables), the default report views and the offline shell build automatically
  (about two minutes for the full catalog on a cold device). After that every
  page works offline, including pages never opened on this device. The only
  offline gaps are non-default report periods/filters (one online visit of
  that view saves it) — shown as an explicit notice, never a blank page.
- **Offline sessions**: the app remembers the last signed-in user, so an
  expired access token does not lock the device out — it opens with a
  "Working offline as …" banner and full local data access. Queued changes
  sync once the token is refreshed (reconnect or one online visit). A real
  sign-out wipes the local database and the remembered user.
- **Known behavior**: the local database is a point-in-time snapshot; rows
  created on the server after the last refresh appear after the next refresh
  (≤ 15 min online, or on reconnection). Pre-warmed report views re-run when
  the day changes (date-based defaults move with the calendar).
- **Deploys**: `npm run build` generates `public/precache-manifest.json`
  (route list + build id + the full asset list) and the service worker warms
  the new generation on the next app load (checked every few minutes while
  online). Because the SW's own bytes do not change per deploy, a client picks
  the new build up via that manifest version check — no reinstall needed.
- **Dev mode**: the service worker intentionally does not register during
  `next dev` (stale-chunk hazard). Test offline page loads against a
  production build (`npm run build && npm start`).

## 6. Code map

| Piece | File |
|---|---|
| Crypto (AES-GCM seal/unseal, key mgmt) | `lib/offline/crypto.ts` |
| IndexedDB schema (outbox/cache/meta/keys + replica tables) | `lib/offline/db.ts` |
| Persistent-storage request + quota status | `lib/offline/persistence.ts` |
| Encrypted backup export/import (.sibak) | `lib/offline/backup.ts` |
| Read-through cache + network-error classification | `lib/offline/cache.ts` |
| **App-wide read fallback (wraps the Supabase client)** | `lib/offline/read-fallback.ts`, `lib/supabase.ts`, `lib/supabase-raw.ts` |
| **Replica query engine (answers any page's `.from()` read offline)** | `lib/offline/replica-query.ts` |
| **Report pre-warm (default-view RPCs saved for offline)** | `lib/offline/warm.ts` |
| **Offline session continuity (last-known user)** | `lib/offline/session.ts` |
| Read-result unwrapping (prevents caching empty lists over good data) | `lib/offline/read-result.ts` |
| Network monitor | `lib/offline/network.ts` |
| Outbox (enqueue, resolve actions) | `lib/offline/outbox.ts` |
| Sync engine (ordered drain, retries, conflicts) | `lib/offline/sync.ts` |
| Local database replicator + table specs | `lib/offline/replica.ts` |
| Optimistic cache patches after offline writes | `lib/offline/optimistic.ts` |
| React provider + hooks | `lib/offline/provider.tsx`, `lib/offline/use-cached-query.ts` |
| Shared cache keys | `lib/offline/keys.ts` |
| Status pill / banner / "no offline copy" notice / SW registrar | `components/offline/*` |
| Storage & backup card (Sync Center) | `components/offline/StorageBackupCard.tsx` |
| Sync Center page | `app/(erp)/sync/page.tsx` |
| Offline fallback page | `app/offline/page.tsx` |
| **Error boundaries (offline-aware, no more white screens)** | `app/global-error.tsx`, `app/(erp)/error.tsx` |
| Service worker + manifest | `public/sw.js`, `public/manifest.json` |
| **Precache manifest build step** | `scripts/build-sw-routes.mjs` (runs from `npm run build`) |
| Server: sync_apply + handlers + idempotency ledger | `supabase/migrations/20260909233000_offline_sync.sql` |
| Unit tests | `lib/offline/__tests__/*.test.ts` |

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

## 8. Storage persistence & encrypted backups (2026-09-10)

Two durability gaps were closed on top of the shipped offline layer — the
store was fully **evictable** (no `navigator.storage.persist()` was ever
requested) and there was **no export path** (a dead browser profile meant the
local database and its key were gone, with pending offline writes).

### Persistence

`lib/offline/persistence.ts` requests persistent storage once per mount
(the grant is remembered by the browser; the request shows no prompt). The
Sync Center's *Local storage & backup* card shows the honest state and a
retry button, plus usage vs quota from `navigator.storage.estimate()`.

| Browser | Behavior |
|---|---|
| Chrome / Edge / Opera | Grants `persist()` for installed PWAs and regularly-used sites; storage then survives disk pressure and "clear browsing data" unless the user targets site data explicitly |
| Safari (iOS/iPadOS/macOS) | Does not honor `persist()` — storage is best-effort; the card says so and points at backup files instead |
| Firefox | Supports `persist()`; grants by quota/usage heuristics |

### The .sibak backup file

*Export* (Sync Center → *Export encrypted backup*) unseals the entire local
database in memory — all 15 replica tables, page caches, replica bookkeeping
meta and the outbox with every queued change — and seals the bundle with a
key derived from a **passphrase** (PBKDF2-SHA256, 600 000 iterations,
random 16-byte salt, AES-256-GCM). The device's non-extractable key cannot
travel with the file, which is exactly why the passphrase exists: a `.sibak`
opens on any device, including this one after a browser-profile wipe.

File format (JSON, `.sibak`):

```
{ format: 'sisolution-offline-backup', version: 1, createdAt, userId,
  kdf:    { algo: 'PBKDF2-SHA256', iterations: 600000, salt },
  cipher: { algo: 'AES-GCM-256', iv, ct } }   // ct = bundle JSON
```

*Restore* semantics (`importBackup`):

- Replica stores are **replaced wholesale**, re-sealed with this device's key;
  a background replication runs immediately after (the server stays the
  source of truth).
- Outbox items are **merged, never overwritten**: ids already present are
  skipped, resolved items (synced/discarded) are not carried over, and items
  that were mid-flight in the backup return to `pending`. Importing another
  device's pending items is safe — the server's idempotency ledger is keyed
  by `(user, item id)`.
- Only the same user gets a full restore (cache + queued changes). A backup
  from a different account restores the **read-only replica only**, after an
  explicit confirm — a foreign outbox would apply under the wrong account.
- Wrong passphrase → GCM authentication failure → a clean error, nothing
  written.

The export saves as a plain download to the Downloads folder (works
identically in every browser, including Safari). There is deliberately no
File System Access save picker: Chrome rejects it with the same AbortError
whether the user cancelled the dialog or the picker is unavailable
(headless/kiosk/webview), and the two cases are only distinguishable by
rejection timing — flaky. Move the file anywhere you like afterwards.

### Appendix A — Desktop container (Electron + SQLite): deferred design

Evaluated 2026-09-10 and deliberately **not built**. The question was
whether the local database should live in a native desktop app (SQLite file
on disk) instead of browser storage. Findings that shaped the decision:

- The durable gaps above (eviction, backup) are fixed in the PWA itself at
  a fraction of the cost; the data volume (~8k rows, a few MB) is nowhere
  near browser quotas.
- **Direct-write SQLite is architecturally off the table**: all accounting
  (FIFO, COGS/AR journals, VAT) lives in Postgres triggers and `sync_apply`
  handlers (§4). A desktop container could only replace the *cache/outbox
  store*, never the queue-based sync model.
- POS tablets and phones just got PWA support; the web app must keep
  working regardless, so a desktop app is an **additive second surface** —
  build, code-signing and auto-update forever — for marginal gain over a
  hardened PWA.

If it is ever built, the constraints discovered:

- The swap seam is contained in five modules — `db.ts`, `cache.ts`,
  `outbox.ts`, `replica.ts`, `crypto.ts`; pages only consume
  `useCachedQuery` / `enqueueOp` / `replicaRows`. No Dexie usage exists
  outside `lib/offline/`.
- Electron fits this codebase (100 % client components; only two trivial
  API routes — a ping and a super-admin backup proxy); it can run
  `next start` internally. Tauri would need a static export plus reworking
  both routes.
- The non-extractable WebCrypto key must be replaced by OS-keychain storage
  (Electron `safeStorage`); `sync_apply` stays the only write path.
- Better-sqlite3 in the main process, database at e.g.
  `~/Library/Application Support/SI ERP/sisolution.db`; renderer picks the
  SQLite adapter when running inside the shell, Dexie in the browser.
