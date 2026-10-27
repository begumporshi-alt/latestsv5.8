# How the Local Database Stays in Sync with Supabase (Online & Offline)

**Date:** 2026-10-26 · Branch `customer-search-improvements`
This is a brief architectural summary of the device-local replica that powers
offline mode and the new low-egress behaviour, with code evidence for every claim.

---

## 1. The two stores

Every browser keeps two IndexedDB databases:

| Database | Contents | Access |
|---|---|---|
| `sisolution-offline` | the replica (~55 tables), page caches, meta cursors, and the **outbox** (queued offline mutations) — all rows AES-GCM sealed per user | Dexie (`lib/offline/db.ts`) |
| `sisolution-egress` | the API-usage tracker log | raw IndexedDB (`lib/telemetry/egress-tracker.ts`) |

Nothing here talks to the server on its own — syncing happens through two
engines, one per direction.

## 2. Server → device (downstream): the replicator

`lib/offline/replica.ts` holds a spec list of **55 tables** (`REPLICA_TABLES`),
each with a full fetch and a **delta query** keyed on a timestamp cursor:

- **Mutable tables** use `updated_at` with a strict-greater-than cursor:
  `.gt('updated_at', afterCursor).order('updated_at').order('id')`
  (e.g. products, inventory_items, customers, invoices, payments, inventory_batches).
  `updated_at` is maintained by the shared `touch_updated_at` trigger on tables
  that lacked it — migration `supabase/migrations/20261027120000_replica_updated_at_delta_phase3.sql`.
- **Append-only tables** (journal_entries, journal_lines, stock_movements,
  delivery_items, return items, cost_price_history, activity_logs…) delta on `created_at`.

**Why this matters for egress:** a delta tick transfers only rows that changed
since the last cursor, not the whole table. With no changes, the tick costs one
head count probe (a few bytes), not a re-download.

### When it runs

1. On app start and when the network comes back.
2. Every **10 minutes**, POS targets the tables that matter for selling:
   `refreshReplicaTables(['Products', 'Stock counters', 'Product units', 'Customers'])`
   (`app/(erp)/sales/pos/page.tsx:667-669`, `POS_REPLICA_REFRESH_MS = 10 * 60_000`).
3. After every applied outbox change (see §3), so the device converges on its own writes immediately.
4. Manual "Sync now" from the Sync Center.

### The convergence guarantees (`replicateOne`, lib/offline/replica.ts:175)

- **Delta path:** pull rows with `timestamp > cursor`, `bulkPut` them (upsert —
  an update replaces its row in place), **then** run a **count probe**
  (`select('id', { count: 'exact', head: true })`) comparing server vs local count.
  A mismatch means rows were deleted server-side — the one change a timestamp
  cursor cannot see — and falls through to a full replace. So deletions converge
  within one refresh cycle, not just inserts/updates.
- **Cursor hygiene:** the cursor advances to the newest timestamp *seen*, and rows
  sharing a timestamp (one transaction's batch) were all fetched together, so the
  strict `>` never skips them. Pagination ordering has an `id` tiebreaker because
  rows can share timestamps.
- **Full-refresh safety net:** every table fully re-replaces itself at least once
  per **24 h** (`REPLICA_FULL_REFRESH_MS`), so any logic hole (delete+reinsert that
  keeps counts equal, manual DB edit) is bounded by a day.
- **Atomic swap:** the clear + bulkPut happens in **one Dexie transaction** — a
  concurrent reader (POS fallback, replica query engine) sees old rows or new
  rows, never an empty store.
- **Failure isolation:** a network drop marks the app offline and stops; a single
  broken table is skipped (`console.warn`) without blocking the other 54.

## 3. Device → server (upstream): the outbox

`lib/offline/outbox.ts` + `lib/offline/sync.ts`. While offline, every mutation is
enqueued locally (`enqueueOp`) as an encrypted payload holding the exact arguments
of the same server-side RPC/insert the online path would call. When connectivity
returns, the sync engine replays the queue:

- **Triggers:** connectivity regained (actively probed), a **30 s interval** while
  online, manual "Sync now", and app startup (`DRAIN_INTERVAL_MS = 30_000`).
- **Ordering:** strictly by `createdAt` — a queued product.create lands before the
  invoice that uses it.
- **Idempotency:** the server recognises a re-delivered item id and answers
  `duplicate` instead of applying it twice — safe under retry.
- **Conflicts** (server row changed since the read) are parked, not lost; the Sync
  Center offers "Overwrite server" / "Keep server".
- **Backoff:** RPC errors retry with exponential backoff (3 s base), max 5 total
  attempts, then park as `failed` with the server's error message. Network errors
  just stop the drain and wait for the next window.
- **Recovery:** items stuck in `syncing` (e.g. a tab killed mid-call) are reset to
  `pending` on the next engine run.

After a drain succeeds, the engine calls `replicateAll()`, which is what makes the
device's own writes appear in its replica immediately — it doesn't wait for the
next 10-minute tick.

## 4. How POS reads stay correct in both modes

This is the layer that ties §2 and §3 together (`app/(erp)/sales/pos/page.tsx`):

- The product grid **always filters a local snapshot** (`applySnapshotPage`),
  built from the replica when available (`buildPosSnapshotFromReplica()`), so
  search/typing never hits the network. Online, the page cache
  (`CACHE_KEYS.products`, 10-minute `PRODUCT_SNAPSHOT_TTL`) is rebuilt **from the
  replica** — not re-downloaded — on TTL expiry.
- Every completed sale calls `applySaleToSnapshot(cart)` (lines 1745, 1914), which
  **patches the cached stock locally** in both modes, so the next keystroke
  reflects the sale without any fetch. The authoritative check stays live at
  checkout through the oversell gate (`lib/oversell-gate.ts`), which always asks
  the server (or the replica + outbox overlay while offline).
- Mutations that change master data (e.g. quick-sell creating a product) delete
  the page cache when online so the next load rebuilds it from the refreshed
  replica; offline the cache is kept and the outbox overlay fills the gap
  (`lib/offline/pending.ts`).

## 5. The expert framing: why this design, and its known limits

**What it is:** a pull-based, timestamp-cursor replica with a write-ahead queue.
This is the same shape commercial offline-first stacks use (PowerSync /
ElectricSQL use post-commit WAL tails; this system uses trigger-maintained
`updated_at` as its change log). The trade-offs are deliberate:

- **Eventual consistency, bounded.** Writes are durable locally first (sealed
  IndexedDB), so an offline sale can't be lost by a crash; server application is
  retried idempotently. Reads converge within one refresh cycle (≤10 min for POS
  tables) plus a 24 h hard reset.
- **Egress is now proportional to *change*, not to *attention*.** Delta cursors
  mean a day where nothing changed costs a handful of head-count probes instead of
  megabytes of re-downloads — this was the point of the egress project.
- **No real-time push.** There is no Supabase Realtime subscription; a record
  another user created lands on this device within the next tick (≤10 min for POS
  tables, ≤30 s for outbox-triggered convergence after your own writes). The
  oversell gate and credit gate still verify live at the moment of checkout, which
  is where staleness would actually cost money.
- **Known blind spot, self-healing:** a server-side row edit that deletes and
  re-inserts the row with a *new* id keeps the count equal, so its ghost row can
  linger until the daily full replace. Documented in `replicateOne`'s comment —
  this is why the 24 h refresh exists.
- **Two devices, no peer sync.** Device B sees device A's sale when B's next
  delta tick runs (up to 10 min), or instantly after B makes its own write.
  Conflict resolution is last-writer-wins at the server with `sync_apply`
  conflict parking for the cases it detects.

## 6. Quick reference

| Concern | Where | Key constant |
|---|---|---|
| Table specs + delta queries | `lib/offline/replica.ts` (`REPLICA_TABLES`) | 55 tables |
| Per-table sync, count probe, cursor | `replicateOne()` in `replica.ts` | — |
| POS targeted refresh | `refreshReplicaTables()` called from POS page | 10 min |
| Full replace safety net | `replica.ts` | 24 h |
| Outbox queue + replay | `lib/offline/outbox.ts`, `lib/offline/sync.ts` | drain 30 s, 5 retries |
| Local snapshot patching after sale | `applySaleToSnapshot` in POS page | — |
| `updated_at` triggers | `20261027120000_replica_updated_at_delta_phase3.sql` | 12 tables |
