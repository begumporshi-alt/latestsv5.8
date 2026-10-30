# Sisolution Standby — Implementation and Recovery Plan

Status: Phase 1 local setup started by user instruction; full recovery gate remains open. No remote repository creation or publishing has been authorized.
Date: 2026-10-27
Target: Tauri 2 desktop application for macOS arm64, macOS x64, and Windows x64.

## 1. Objective and decision

Keep the business operating when its Supabase project or internet connection becomes unavailable, using a locally installed, independently recoverable ERP stack.

Retain PostgreSQL, PostgREST, and Supabase Auth (GoTrue) so existing SQL business logic and RLS remain the authority. Bundle native services without Docker or administrative OS services. Tauri supervises the services and exposes a narrowly scoped recovery interface.

This is disaster recovery from a snapshot, not continuous replication or a promise of zero data loss. A desktop package is not ready for business use until both activation and failback have passed a real-data rehearsal.

### Fixed boundaries

- New, separate repository: `begumporshi-alt/sisolution-standby`; not a fork.
- ERP source: pinned git submodule to `begumporshi-alt/latestsv5.8`.
- No untracked edits or silent patches inside the submodule.
- Necessary ERP compatibility changes land in the ERP repository, then the standby pin advances explicitly.
- No Docker dependency on users' machines.
- No automatic cloud/local failover, bidirectional replication, or automatic merging.
- One designated standby writer; other installations remain passive.
- No LAN access in v1.
- Manual updates in v1; never overwrite business data during installation or upgrades.
- Owner accepts unsigned distribution and its support burden; platform launch feasibility must still be demonstrated.

### Success definition

A prepared non-technical operator can install and activate a verified backup without developer tools or internet access, sell and print receipts locally, close/reopen the app without loss, and export a recovery artifact that can be restored and verified on a replacement target.

Target activation time: under 10 minutes from opening an already downloaded installer, with the backup available locally. Measure this separately from downloading, discovering missing prerequisites, and reconciling transactions newer than the snapshot.

## 2. Evidence and unresolved assumptions

The repository review establishes these constraints; it does not establish that the proposed embedded stack already works.

| Evidence | Consequence |
|---|---|
| `lib/supabase-raw.ts:14–21` uses `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Browser settings are build-injected by Next.js; startup environment changes alone are not a runtime mode-switch mechanism. |
| `lib/admin-auth.ts:7–25` creates the server-side administrative client | Browser and server configuration must select the same deployment; service-role credentials remain server-only. |
| `app/api/admin/db/route.ts:19–20` calls `/functions/v1/db-backup` or `/functions/v1/db-restore` | Edge Functions are not wholly unused; these controls need an explicit standby replacement or disabled state. |
| `lib/offline/db.ts:58–65` uses one `sisolution-offline` IndexedDB database | Sessions, caches, replica cursors, encryption keys, and outbox items need deployment isolation. |
| `lib/offline/read-fallback.ts:226–233` skips live reads when marked offline; `lib/offline/network.ts:56` handles OS offline events | Internet disconnection must not cause a healthy localhost database to be bypassed. |
| `docs/restore-runbook.md:87–94` records a successful table/count/accounting restore | This proves a data recovery drill, not working GoTrue, API grants, RLS, or application behavior. |
| `docs/restore-runbook.md:98–107` records off-site, storage-object, and scheduling gaps | Backup availability and external assets must be handled explicitly. |

The proposed RPC/policy counts, exact API-route count, binary sizes, complete migration replay, and per-platform binary availability are inventory inputs to verify, not acceptance criteria.

## 3. Runtime architecture

```text
Tauri desktop shell
  ├─ local lifecycle/recovery controller
  ├─ local API gateway
  │    /rest/v1/* → PostgREST
  │    /auth/v1/* → GoTrue
  ├─ PostgreSQL cluster
  ├─ PostgREST
  ├─ GoTrue
  └─ Node.js + Next.js standalone ERP server
       └─ WebView loads the local ERP origin
```

All listeners bind explicitly to loopback. PostgreSQL and private sidecars must not bind to all interfaces. Assign separate ports to every listening service; 54321, 54322, and 54323 cover only the gateway, database, and UI, not the full stack.

Preferred ports may be used, but collisions must be detected before startup. Never attach to, stop, or assume ownership of an unrelated process. A single-instance lock protects the data directory. Runtime configuration carries the selected ports.

### Service supervision

- Start PostgreSQL; verify database readiness and schema compatibility.
- Start GoTrue and PostgREST with restricted database roles and explicit configuration.
- Verify service-specific health and authenticated API behavior.
- Start gateway and Next server, then expose the ERP.
- Keep the ERP unavailable for writes during import, cutover, or incompatible schema states.
- Shut down in reverse dependency order with bounded graceful termination.
- Track actual PostgreSQL process ownership: `pg_ctl` can exit after starting the server, so supervising its launcher alone is insufficient.
- Handle app crashes, stale PID files, sleep/wake, full disks, occupied ports, and interrupted startup without initializing over existing data.
- Never delete or reinitialize an existing cluster to resolve a startup error.

### Gateway contract

Treat the gateway as a tested compatibility boundary, not a line-count estimate.

Preserve authorization, API-key, content/profile, preference, range, and response headers required by Supabase clients; preserve status codes and query strings. Implement correct prefix rewriting, OPTIONS/CORS behavior, request-size limits, timeouts, and streaming where needed. Allow only intended upstreams; it must not be a general proxy.

Reject unexpected Host and Origin values where appropriate. CORS alone is not authorization. Keep restore/export/import operations behind Tauri commands with narrow capabilities and role/operator checks; do not expose unauthenticated destructive localhost endpoints.

Do not grant cloud pages access to privileged Tauri commands. Open external links outside the privileged WebView. Audit navigation, CSP, and command permissions before packaging.

## 4. ERP integration and modes

### Recommended v1 scope

The ordinary web ERP remains the cloud application. The desktop app is local-only in v1, with passive preparation and explicit standby activation. A link may open the cloud ERP in the system browser.

This removes the riskiest source of accidental cross-backend writes while preserving the core disaster-recovery objective. An integrated desktop cloud mode is deferred, not silently included.

### Minimal upstream compatibility work

Use one explicit deployment configuration contract for browser and server clients. Browser configuration contains only public endpoint/key data; administrative credentials stay server-side. Load configuration before creating clients, and do not initialize privileged services during build.

Allow normal web deployment to retain its established configuration behavior. The desktop wrapper supplies local runtime configuration without rewriting generated JavaScript or editing the submodule at launch.

Inventory and adapt:

- Every Supabase client constructor and server-side administrative route.
- Offline reachability: probe the selected backend; OS internet state alone must not disable localhost reads or queue healthy local writes.
- Session persistence, outbox, replica, cache, encryption-key, and cursor namespaces.
- Service workers and cached application versions, if present.
- Backup/restore controls currently using Edge Functions.
- Realtime subscriptions: explicit polling/manual-refresh behavior for affected screens, not silent failure.
- Logo/storage URLs, remote fonts, scripts, assets, printing, PDF generation, downloads, clipboard, and sharing.

Use a deployment identifier plus a restore-generation identifier for browser persistence. Replacing the database must not reuse replica cursors from its predecessor. Pending operations must never be silently deleted or replayed against another database; quarantine and surface them for reconciliation.

If integrated cloud mode is later required, use separate WebView data profiles/origins and separate server contexts, require reauthentication, stop background workers before switching, and prove outbox isolation. Switching a gateway upstream underneath an existing session is prohibited.

## 5. Database and authentication compatibility

### Compatibility manifest

For each release, pin and record:

- ERP commit and expected application schema/migration revision.
- PostgreSQL major/minor and required extensions.
- PostgREST and GoTrue versions.
- Node runtime and Tauri/toolchain versions.
- Backup format and schema compatibility rules.
- Platform/architecture binary checksums and provenance.

Reject unsupported combinations with an actionable error. Do not infer compatibility solely from a dump's filename or size. A newer backup must not be opened by an older incompatible ERP build.

### Bootstrap and restore are different paths

Create the required cluster roles, role memberships, schemas, extensions, and Auth prerequisites deliberately. GoTrue's schema/migration requirements must be tested against the restored Auth schema; choose and document the initialization order during the spike.

A clean installation is not assumed to support replaying application migrations directly into vanilla PostgreSQL. The no-dump path must first provision the compatibility baseline, then replay and validate application migrations. Keep demo/test data separate from recoverable production data and label it clearly.

Prioritize real-dump recovery before the empty/demo bootstrap.

### Roles, permissions, and function ownership

Provision the required `anon`, `authenticated`, `service_role`, authenticator, Auth administration, and object-owner roles with reviewed memberships and permissions. PostgREST must not connect as a superuser or table owner that bypasses the intended RLS behavior.

Restoring with `--no-owner --no-privileges` does not recreate the application privilege model. Apply an explicit, versioned ownership/grant/default-privilege baseline, and review security-definer function owners, search paths, and execute permissions.

Validate required Auth SQL helpers, JWT claims, RLS policies, triggers, RPCs, sequences, extensions, and schema-cache reload behavior.

### Restore errors

The historical approximately 231 errors are not an acceptable success rule for an operational standby. Missing application policies, grants, or roles are release blockers.

Use a versioned restore selection or precise exclusion list for genuinely unsupported platform objects. Fail on unexpected errors. Report exclusions by object identity and reason, not just by error count or broad text patterns.

### Auth and secrets

Generate a cryptographically random, persistent secret per installation; do not ship one shared signing secret. Generate local keys from the selected supported Auth/PostgREST configuration and keep privileged keys out of browser bundles, logs, and exports intended for routine sharing.

Use restrictive filesystem permissions and an OS credential store where appropriate. Loopback is a boundary, not protection from a compromised local account. Document this threat limit.

Preserved password hashes make password login plausible, not proven. Verify real users' email/password login, user IDs, profile links, disabled-user behavior, token refresh, logout, and role restrictions with the pinned GoTrue version. Existing cloud tokens are not local sessions.

Test admin user listing, creation, and updates. Define behavior for email confirmation, invitations, password resets, magic links, MFA, and external providers without internet; unsupported flows must be visibly disabled or documented. Do not weaken authentication automatically to make an import pass.

## 6. Safe import pipeline

Never drop the active database before validating its replacement.

1. Select a locally available backup; show timestamp, source identity, checksum, and declared compatibility.
2. Verify the backup is complete, readable, trusted, and compatible; check free space for the existing database, candidate, logs, and rollback copy.
3. Treat dumps as trusted executable database input, not harmless data files; do not accept arbitrary third-party archives.
4. Create an isolated candidate database or cluster without exposing its API to the ERP.
5. Restore using the compatibility baseline and explicit platform-object exclusions.
6. Apply reviewed ownership/grants and validate Auth/schema compatibility.
7. Validate business invariants and authenticated API behavior against the candidate.
8. Quiesce application activity and connections; ensure no standby writes have occurred since replacement was authorized.
9. Perform a controlled, recoverable cutover; restart dependent services and rotate the restore-generation namespace.
10. Preserve the previous database until post-cutover verification and retention requirements are satisfied.
11. Record a durable import report and show the result, source snapshot time, and remaining data-loss window.

A failure at any step leaves the previous working database intact and selectable. Interrupted cutovers must be detectable and recoverable on restart.

Watch-folder support is optional and late: ingest only completed files, verify checksums, and validate candidates while passive. Never replace an active writer automatically. Cloud-synced placeholder files must be downloaded before an outage; the app shows whether the backup is actually available locally.

## 7. Recovery state machine and write authority

| State | Business writes | Import replacement | Meaning |
|---|---|---|---|
| Unprepared | Blocked | Allowed | No verified usable database. |
| Passive / ready | Blocked | Allowed after validation | A verified snapshot is ready for activation. |
| Activating | Blocked | Blocked | Operator checks freshness, other writers, and pending work. |
| Active standby | Allowed locally | Blocked | This installation is the designated writer. |
| Exporting / failback frozen | Blocked | Blocked | Final export and target verification underway. |
| Retired / archived | Blocked | Explicit recovery only | Target has taken over; local history is retained. |

Persist state transitions and recovery history. Display a persistent local-mode indicator, snapshot time, activation time, and backup status—not only a tray icon.

### Activation checklist

- Confirm the chosen backup's age and local availability.
- Identify the designated writer and outage scope.
- Stop cloud writes and other standby writers where reachable.
- Record any devices or integrations that cannot be stopped.
- Inventory pending offline outboxes and transactions after the snapshot.
- Acknowledge the known recovery-point gap before enabling writes.

No local app can guarantee global fencing during a network partition. If the former cloud writer cannot be fenced, activation is an explicit emergency decision with a recorded conflict risk; never claim split-brain has been technically prevented.

For v1, other devices do not each activate their own independent writable copy.

## 8. Business verification gates

Counts and global Dr=Cr are necessary but insufficient: missing or duplicated balanced transactions can still pass.

### Candidate validation

- Compare key table counts and selected aggregates to a backup-time manifest when available.
- Verify required tables, functions, policies, grants, triggers, and sequences against the release contract.
- Check per-posted-entry journal balance and expected document-to-journal links.
- Check invoice lines/totals, payment allocations, customer/supplier balances, batch/warehouse stock, and applicable stock-ledger invariants using existing domain rules.
- Do not impose a blanket nonnegative-stock invariant where the configured oversell policy permits negatives.
- Verify representative privileged and restricted users through the API, including denied operations.

### End-to-end drill

Run with external internet unavailable and cached browser data absent:

1. Log in with a restored account and load catalog/stock.
2. Create a sale with payment; verify invoice, inventory allocation, balances, and the exact expected journal effects.
3. Repeat submission/retry and verify idempotency where the application promises it.
4. Exercise cancellation/return and a stock-in workflow such as GRN receipt.
5. Test at least one multi-warehouse and one oversell-policy case if present in the pinned ERP.
6. Print a receipt/invoice and generate a PDF using the packaged WebView.
7. Restart the app and machine; confirm committed data survives and no transaction is replayed incorrectly.
8. Export, restore to a disposable replacement target, and verify the same business records and permission checks.

Use an isolated rehearsal copy, never create test sales in the actual recovery database intended for activation.

## 9. Backups and recovery point

Protection is required before active standby is released, not postponed to a later hardening phase.

- Run a backup immediately after activation and on a defined schedule while accepting writes.
- Default to hourly active-standby snapshots, subject to a measured performance gate; retain configurable daily snapshots as well.
- Make a final backup before failback and before schema-changing upgrades.
- Write to temporary files, verify completion/readability, then atomically publish completed artifacts.
- Record checksum, source/deployment identity, snapshot timing, schema/ERP versions, and verification outcome.
- Keep the last known-good backup when a new backup fails.
- Back up on the next safe opportunity after a missed schedule; disclose that a closed desktop app cannot run in-process backups.
- Show persistent backup failures, backup age, destination availability, and low-space warnings.
- Keep a second copy on separate storage; a backup on the same failed disk is not disaster recovery.
- Encrypt off-device backups and protect recovery keys separately; test restoration with those keys.

A daily source schedule gives a nominal recovery-point objective of up to 24 hours only when backups succeed and arrive locally. The actual loss window is measured from the selected snapshot; missed runs can make it longer. Device replicas and outboxes are reconciliation inputs, not a proven substitute for a full database backup.

## 10. Failback procedure

Failback is replacement of the authoritative database, not a merge.

1. Freeze standby writes and stop sync workers; record the last committed business operation.
2. Resolve or quarantine pending device operations and identify cloud writes after the source snapshot.
3. Back up both sides before any replacement.
4. Export and verify the final standby backup and manifest.
5. Restore into a disposable target first using a destination-specific recipe.
6. Validate Auth version/schema compatibility, ownership, grants, extensions, application records, and role restrictions.
7. Rehearse restoration into a fresh Supabase project separately from restoration into vanilla PostgreSQL: managed Auth/platform schemas already exist and may conflict with a full local dump.
8. Provision destination secrets, Auth/provider configuration, assets, and any required Edge Functions separately from database data.
9. Point the ERP to the verified target; invalidate old sessions and reinitialize deployment-scoped client state as required.
10. Enable target writes, verify a controlled business transaction, and mark the standby retired/read-only.

If either side has accepted divergent writes, stop the replacement workflow and reconcile explicitly. Preserve both databases. Do not overwrite cloud history under the assumption that switching devices is enough.

Once the target accepts new writes, returning to the old local copy requires a new recovery decision; it is no longer a simple rollback.

## 11. Packaging and supply chain

### Repository structure

```text
sisolution-standby/
  src-tauri/          lifecycle manager, gateway, recovery commands
  erp/                pinned ERP git submodule
  binaries/           ignored, locally fetched/built native artifacts
  scripts/            fetch, verification, development, packaging, drills
  compatibility/      versioned bootstrap, grants, restore selection, checks
  tests/              lifecycle, gateway, recovery, packaged smoke tests
  docs/               operator and maintainer runbooks
  binaries.lock.json  exact versions, provenance, checksums, licenses
  .github/workflows/  reviewed platform build and test matrix
```

Large binaries and production dumps must not be committed. Build outputs must not contain production credentials or customer data.

### Native artifacts

Verify actual supported sources for PostgreSQL, PostgREST, GoTrue, and Node per platform; do not assume official standalone PostgreSQL macOS archives or ready-made GoTrue Windows releases exist. If a source build is needed, pin the source commit, toolchain, dependencies, and reproducible procedure.

PostgreSQL packaging must retain required shared libraries, extension files, timezone data, locale support, and auxiliary executables. Include `createdb`/`dropdb` only if scripts actually invoke them, otherwise use reviewed SQL operations. Trim only after clean-machine testing.

Verify hashes before execution and include redistribution notices. Keep native architecture and minimum OS compatibility explicit.

### Platform gates

- macOS arm64 and x64: quarantined download/install/launch tests on clean supported machines; establish any required ad-hoc signing of nested executables even when Developer ID signing/notarization is out of scope.
- Windows x64: clean standard-user installation without Node/PostgreSQL/Go/Rust; verify WebView2 and native runtime prerequisites can be installed or bundled for offline use.
- Test spaces, non-ASCII user names, long paths, restricted folders, and antivirus interaction; `%APPDATA%` is not guaranteed to be ASCII.
- Do not require broad inbound firewall access for a loopback-only application.
- Verify installer upgrade/uninstall behavior preserves database and backups by default, with explicit confirmation for any data removal.

## 12. Phases and exit gates

### Phase 0 — compatibility inventory and decision freeze

Deliver the dependency/runtime inventory, supported platform table, proposed upstream ERP integration scope, backup compatibility contract, and explicit exclusions.

Gate: every required cloud capability has a supported local implementation, visible degraded behavior, or a blocking issue; binary provenance and Windows test access are established.

### Phase 1 — real-dump recovery spike

On a disposable local stack, provision roles/Auth baseline, restore a current trusted dump, start PostgREST/GoTrue/gateway/ERP, and implement only the upstream compatibility changes required for this experiment.

Gate: disconnected password login, permitted and denied API operations, a sale with correct stock/payment/journal effects, token refresh, and restart persistence pass. Unexpected restore errors are zero. No Tauri installer work is required to prove this gate.

### Phase 2 — recovery controller and data safety

Implement lifecycle supervision, candidate imports, durable recovery states, browser-state isolation, self-backup, final export, and failback rehearsal. Add the no-dump bootstrap only after real-dump recovery is proven.

Gate: failed/interrupted imports preserve the prior working data; active writers reject replacement imports; backup failure is visible; interrupted cutover recovers; a final export restores correctly into a disposable destination. Complete a separate fresh-Supabase failback rehearsal before claiming Supabase recovery support.

### Phase 3 — desktop packaging and operator experience

Bundle Tauri, native services, Node, Next standalone output, static assets, and required offline prerequisites. Add tray/status, logs, operator activation flow, and manual recovery controls.

Gate: clean-machine tests on all supported architectures; real Windows execution, not merely cross-compilation; operator achieves prepared installer-to-working-ERP target; print/PDF, crash/restart, Unicode paths, occupied ports, and no-internet tests pass.

### Phase 4 — release readiness

Add the reviewed CI matrix, artifact checksums, dependency/license inventory, operator runbook, incident recovery instructions, compatibility tests, and optional passive watch-folder ingestion.

Gate: rehearsed activation and failback reports, verified off-device backup recovery, no secrets/customer data in artifacts, documented limitations, and explicit release approval.

### Deferred work

Integrated desktop cloud mode, LAN clients, continuous replication, automatic reconciliation, Realtime service emulation, and signed/notarized distribution remain separately scoped projects.

## 13. Test strategy and evidence

Use targeted tests before broad suites:

- Gateway contract tests for auth headers, prefix routing, status/error propagation, ranges, CORS, and unauthorized local access.
- SQL/API tests for baseline permissions, RLS, critical RPCs, and Auth claims.
- Lifecycle tests for startup ordering, single-instance behavior, graceful shutdown, stale process state, and port conflicts.
- Recovery tests for corrupt/truncated/incompatible dumps, insufficient space, unexpected restore errors, interrupted candidate import/cutover, and rollback selection.
- Persistence isolation tests proving outbox items cannot cross deployments or restored generations.
- Packaged end-to-end tests on supported real OS environments.

CI uses synthetic fixtures, not production backups. A controlled real-data rehearsal produces a redacted report including exact versions, snapshot timestamp, counts/aggregates, permission results, elapsed timings, failures, and restore/failback outcomes.

Do not label a build business-ready because it compiles, a port opens, table counts match, or total debits equal credits.

## 14. Operations and maintenance

Store data, configuration, logs, and backups separately from replaceable application resources. Rotate logs and redact passwords, JWTs, service keys, connection strings, and personal data. A diagnostic export must be inspectable and exclude dumps/secrets by default.

Show app version, ERP pin, database schema version, service versions, current recovery state, active source identity, snapshot age, and latest backup result.

Define supported upgrade paths. PostgreSQL major upgrades require a separately rehearsed migration; never start an incompatible server binary against an existing data directory. App downgrades must reject newer unsupported schemas. Preserve a verified recovery path before upgrading.

Maintain the pinned version set on a deliberate security-update cadence and repeat compatibility/recovery tests after Auth, PostgreSQL, or ERP schema changes.

## 15. Next action and approval boundary

The user authorized starting Phase 1 setup. An independent local sibling repository has been created without publishing or creating a GitHub repository. Obtain explicit authorization before remote creation or publishing; no ERP source edits or commits have been made in this setup pass.

The next implementation target is the reviewed role/ownership baseline and real-dump spike—not an installer or a cosmetic desktop shell. Revisit scope only using the spike's evidence; do not replace failed compatibility assumptions with silent privilege bypasses, shared secrets, ignored restore errors, or destructive recovery shortcuts.

## 16. Phase 1 setup checkpoint — 2026-10-27

### Completed and verified

- Local independent repository: `../sisolution-standby`, branch `main`, no commits or remote.
- ERP git submodule pinned to `365f0eb1fafa1bf560397bf9e5e45a28deb2b14f`; clean checkout, no environment file copied.
- Existing PostgreSQL 17.11 installation verified; no system installation changes.
- Official PostgREST 16.5 and Auth 2.197.0 darwin-arm64 assets downloaded with SHA-256 pins from their GitHub release metadata, checked before extraction, and version commands executed successfully.
- Node 24.19.0 selected from the existing nvm installation and recorded in `.nvmrc`; the default shell's Node 18.12.1 fails the prerequisite check rather than being silently accepted.
- Dependency-free setup scripts: `doctor`, `fetch:binaries`, and `init:spike` through npm.
- Isolated PostgreSQL cluster initialized under the new repository's ignored `.runtime/`, with loopback-only configuration, SCRAM authentication, and separate proposed ports 55431–55435. Ports have not yet been reserved or checked for service startup.
- Random local credentials generated with private filesystem permissions; no production secrets used.
- Six unit tests passed under Node 24.19.0; additional checks passed for repeat-initialization refusal, unchanged secrets, private file/directory permissions, PostgreSQL major version, ignored runtime/binary paths, and absence of a running cluster PID file.
- Repeat binary fetch verified existing executable checksums without replacing artifacts.

### Running the setup commands

In the new repository, use the installed nvm runtime before npm:

```sh
nvm use
npm test
npm run doctor
npm run fetch:binaries
```

`npm run init:spike` is first-run only and has already been executed here. It deliberately refuses an existing `.runtime/`; do not remove that directory simply to rerun initialization.

### Not yet done

No database server or API service has been started. No dump has been imported. No roles/grants baseline, gateway, Tauri shell, ERP runtime adaptation, Auth migration compatibility, password login, RLS/API checks, offline sale, or failback has been validated. macOS x64 and Windows remain unsupported by the current fetch lock and fail explicitly rather than using the wrong binary.

Auth 2.197.0 is a spike candidate, not a confirmed match to the backup's Auth schema. The installed PostgreSQL and Node are developer prerequisites, not redistributable packaged artifacts. The native artifact lock is therefore marked `phase-1-local-spike-not-distributable`.

The live database and source backups were not modified. Phase 1 is started, not complete.

## 17. Roles/grants and real-dump restore checkpoint — 2026-10-27

This checkpoint supersedes section 16's not-yet-restored status; its setup history remains accurate for that earlier point.

### Implemented

- `compatibility/roles.sql` creates explicit nonsuperuser owner roles, an isolated Auth owner/login, and a non-inheriting PostgREST authenticator that can assume only `anon`, `authenticated`, and `service_role`.
- `compatibility/restore-contract.json` binds this spike to the reviewed source dump SHA-256 and ERP commit; a different dump requires a reviewed contract update.
- Nineteen exact TOC entries are excluded: unavailable cron/vault extensions and their dependent data/comments/sequences, cloud event triggers, and inactive Realtime publications/memberships. Application notification data is retained. Unexpected platform/ACL entries fail selection rather than being silently dropped.
- Original object ownership is restored using pre-created roles. The Auth schema is owned by `supabase_auth_admin`; Auth tables/sequences retain that owner, and public application objects retain the nonsuperuser `postgres` owner.
- The dump contains zero ACL entries because the backup process omits privileges. The new baseline is explicitly read-only and restrictive; it is not a claim of cloud ACL parity.
- Anonymous application/Auth data access is denied. Authenticated and service roles receive SELECT only on public RLS-protected tables, with no application DML or unreviewed RPC grants. The `has_role` read helper and Auth claim helpers have explicit grants. Auth's dedicated owner retains its schema rights for the later migration/login test.
- The restored `exec_sql(text)` SECURITY DEFINER function remains inaccessible to application roles, including `service_role`; possession of a privileged API key does not enable that SQL executor under this baseline.
- Candidate restore uses `pg_restore --exit-on-error --single-transaction` into a newly named database. Existing candidates are retained; no active database is dropped or replaced.
- Local-only connection parameters, operation locking, port checks, cluster identity checks, explicit locale, private logs, and graceful stop protect the isolated operation. PostgreSQL is stopped after each restore/verification command.

### Verified evidence

The successful candidate is `candidate_c4397a9035024c6691aa302d839cbfb8`; its private report is under the standby repository's ignored `.runtime/<candidate>/report.json`.

- Source: `sisolution-20261027-0641.dump`, SHA-256 `b727c65f6e22f5be969d9a86200cd2fecf477780f7597092214fadcfe37afb8b`; source checksum unchanged after restore.
- Strict restore exit code: **0**. Excluded objects: **19**, explicitly identified in the contract and report.
- Counts match the previous drill: products **2,939**, invoices **1,265**, customers **242**, invoice items **3,816**, journal entries **6,474**, journal lines **16,130**, inventory batches **2,882**, payments **1,919**, Auth users **8**.
- Raw debit and credit totals are exactly equal: `170837087.303294999877228488000000000000000000`; the earlier runbook's `170837087.30` is the rounded display value, not the full stored precision.
- Unbalanced posted entries: **0**. Posted journal-header versus line-total mismatches: **0**.
- Public functions preserved: **186**. Policies preserved: **222**. Public RLS tables: **61**. These measured counts replace unverified estimates, not the separate question of which functions are application RPC entry points.
- Auth migration history preserved: **82** entries, latest `20260831180000`; compatibility with the pinned GoTrue executable remains untested.
- Auth/public ownership checks pass; authenticator cannot assume the application owner or Auth administrator.
- Authenticated invoice reads and Auth-owner user reads pass. SQL claim-to-`auth.uid()` behavior passes; this does not yet verify JWT signature handling.
- Five real permission denials pass: anonymous invoice read, authenticated profile update, authenticated SQL executor, service-role SQL executor, and authenticated direct Auth-users read.
- Restart/reverification passes with unchanged recorded data, ownership, RLS and privilege metrics. The cluster is stopped afterward.
- Twelve setup/restore unit tests pass. Failed attempts were preserved: the first encountered a macOS locale startup error; the second exposed the rounded-total assertion mistake. Neither was promoted, and no business data was altered to make verification pass.

### Repeatable commands

In `../sisolution-standby` with `nvm use`:

```sh
npm test
npm run verify:spike
```

`npm run verify:spike` restarts and verifies the recorded candidate, then stops the cluster. It does not reimport the dump.

For an intentionally new candidate using the same reviewed dump:

```sh
npm run restore:spike -- "$HOME/Backups/sisolution/sisolution-20261027-0641.dump"
```

The restore command preserves prior candidates and produces a separate report. No remote repository, commits, or pushes were created.

### Remaining Phase 1 gates

Next: validate GoTrue schema/version compatibility and actual password login, then PostgREST plus gateway behavior. Review the minimum required RPC/DML grants and role-specific authorization before enabling any business writes. The restrictive read-only baseline cannot yet support a sale.

At this checkpoint, GoTrue migrations/login/token refresh/admin APIs, JWT verification, application-role permission parity, the gateway, ERP local-runtime adaptation, offline sale/stock/payment behavior, packaged UI, and failback were unverified. Section 18 supersedes the native Auth/API and controlled-write portions. The live database and original source backup remain untouched.

## 18. Native Auth/API and isolated write checkpoint — 2026-10-27

### Verified evidence

Fresh execution of `doctor`, all 17 Node tests, `validate:native`, and `verify:spike` passed. The successful private aggregate report is `../sisolution-standby/.runtime/rehearsal_9d3d9655b9c54f128e6ac7510d03b01c/report.json`.

- A fresh rehearsal database was cloned from the verified read-only candidate; its setup and baseline metrics remained unchanged.
- Explicit GoTrue migration completed with the same 82 migration records before and after.
- Generated local accounts passed creation, wrong-password rejection, password login/update, user lookup, token refresh, ban/unban login enforcement, and logout refresh rejection. Original restored password hashes were unchanged; no existing user's password was reset.
- Native PostgREST authenticated reads passed. Anonymous access, malformed/expired/wrong-secret tokens, Auth schema access, direct writes, `exec_sql`, and raw sync RPCs were denied.
- A validation-only `standby_validate_sale` wrapper permits active sales roles and only `invoice.create`; raw dispatcher and internal-handler permissions remain denied. Wrong-role/inactive callers and conflicting intent ownership/operation/legacy claims were rejected.
- A synthetic paid sale of 100 produced one invoice and payment, stock and batch quantity 5 to 4, FIFO cost 40, customer balance zero, and three balanced journals totaling 240 debit and 240 credit.
- Repeated and concurrent retries produced no duplicate effects. Insufficient stock rejected the transaction without additional business, journal, sync-ledger, or intent records.
- Native children and PostgreSQL were stopped after validation. No production database access, ERP application edits, commits, pushes, or remote repository creation occurred.

### Repeatable command

In `../sisolution-standby`, after `nvm use`, run `npm run validate:native`. Each run preserves a separate rehearsal database and private report; it does not promote that database or enable writes on the verified candidate. Service output is discarded in favor of redacted byte counts, so logs intentionally omit detailed diagnostics.

### Remaining boundaries

This is a test-only RPC, not the ERP's normal API contract or full authorization parity. The restored `sync_apply` dispatcher still lacks business-role enforcement; it must not be broadly exposed without review. Native GoTrue logout/ban does not establish immediate revocation of already-issued stateless PostgREST access tokens.

Real restored-user password login, login persistence across a new backup/restore, gateway routing, Next.js local configuration, ERP browser sale/offline flows, full role-specific permissions, failback, and desktop packaging remain unverified. Phase 1 is not complete. The setup and baseline verifier disclaimers describe their own scope; this separate rehearsal supplies the native Auth/API evidence.

## 19. Normal ERP and browser UI checkpoint — 2026-10-27

### Verified evidence

A fresh run of `npm run validate:erp` passed (22/22 tests, `validate:native` and `verify:spike` also green), then an interactive browser session was driven against a persistent rehearsal stack.

- `scripts/gateway.mjs` fronts the native services on loopback 55431 exactly like the Supabase platform edge: `/rest/v1/*` to PostgREST, `/auth/v1/*` to GoTrue, everything else refused. It terminates CORS preflights and reflects local origins — GoTrue's own rs/cors allows no origins, so this platform-edge role is required for the unmodified ERP to log in.
- `compatibility/grants-parity.sql` restores the effective cloud ACL surface (DML for authenticated/service_role on public tables; anon denied) with an explicit deny block for `exec_sql` and all `sync_*` handlers; `grants-parity-sync.sql` grants exactly `sync_apply` to authenticated. The cloud's restored RLS policies (222, including the 2026-10-19 role tightening) then enforce what the cloud enforced. Rehearsal clones only — never the baseline candidate.
- The unmodified ERP submodule (`erp/`, pinned commit) boots via `next dev` on 127.0.0.1:55433 with only local env overrides (`NEXT_PUBLIC_SUPABASE_URL` to the gateway, locally derived anon/service keys); its `.env` is never read. The ERP's server route `/api/admin/users` also works through the gateway.
- Real Chrome (CDP, 1600x900, dedicated profile): the login page rendered, password sign-in of a synthetic sales account succeeded, and the dashboard rendered live restored data (revenue, receivables, charts, inventory value). The POS gallery, header search, and product search found the synthetic fixture product.
- A complete POS sale was executed through the UI: add to cart, Pay, Checkout, cash, Charge. The UI showed "Order Complete!" with invoice POS-00590772 and the stock badge dropping 5 to 4. Database verification through the gateway confirmed: one paid invoice (100/100, balance 0), one invoice item, one ৳100 cash payment, stock 5→4, FIFO consumption, and three balanced journal entries (AR 100/100, COGS 40/40, payment received 100/100) — identical to the native rehearsal. The invoice rendered correctly on the Sales & Invoices page with matching stat cards.
- Everything was torn down afterward: no listeners on 55431–55435, no postmaster.pid, original restored-user password hashes unchanged, baseline metrics unchanged (fresh `verify:spike` pass), ERP submodule unedited, no commits or pushes. Chrome profile and helper scripts were removed.

### Session tooling

`scripts/erp-session.mjs up|down` boots/tears down the full persistent stack (PG + rehearsal clone + gateway + auth + PostgREST + ERP dev server) and stores synthetic credentials in a 0600 state file; `down` stops everything and refuses to leave occupied ports. Screenshots of the verified session remain in `/tmp/erp-*.png` (ephemeral).

### Remaining boundaries

Realtime (`/realtime/v1`) is not proxied, so live notifications will not stream. Stateless PostgREST tokens stay valid after logout until expiry. This is `next dev`, not the packaged production build, and the offline IndexedDB replica was exercised only incidentally by the browser — its full offline sale/replay behavior is still untested. Real restored-user password login and failback remain unverified. Phase 1 is not complete.

## 20. ERP re-pin to c148f2a and migration catch-up — 2026-10-28

Two commits landed on `customer-search-improvements` after the 365f0eb pin: `1239b4c` (online saves converge the replica — the POS-gallery staleness fix, committed) and `c148f2a` (customer_advances delta support, adding migration `20261028100000_replica_delta_customer_advances.sql`). The 2026-10-27 dump predates that migration; I verified the restored schema had neither its index nor its trigger.

Actions taken and verified:

- The `erp/` submodule was moved to `c148f2a98b8b870f5de5e81ddd5b9e14006a4ca3` (clean checkout); `binaries.lock.json`, `.runtime/setup.json`, and `compatibility/restore-contract.json` now pin the same commit. The contract also gained a `postRestoreMigrations` list, and `scripts/restore-spike.mjs` applies it after future re-restores.
- `scripts/apply-migration.mjs` applies a reviewed, additive ERP migration to the verified baseline candidate inside one transaction, re-checks `compatibility/verify.sql` metrics, records the name in `setup.json`, and is idempotent. `20261028100000_replica_delta_customer_advances.sql` is applied and recorded; the index and trigger were confirmed present. (The first run left the cluster running due to a missing stop on success — fixed; the migration itself committed correctly.)
- Rehearsal clones inherit the migration because they template from the candidate. The full chain was re-run fresh on the new pin: 22/22 tests, `validate:native`, `validate:erp`, and `verify:spike` all pass.

Nothing was committed or pushed in either repository; the standby working tree carries these changes uncommitted, and the ERP submodule records the pin as a modified gitlink.

## 21. Rendered browser test of replica convergence and offline replay — 2026-10-28

The two behaviors that existed only as unit tests and code reading — the write-refresh hook from `1239b4c`, and the offline sale/outbox replay — were exercised in real Chrome against a persistent rehearsal stack (`erp-session up`, clone `rehearsal_83f5569e13d24beb9a964a7d3820e504`, ERP on 55433, gateway on 55431). The synthetic login profile was elevated to `super_admin` inside that clone so the Inventory module was reachable; the baseline was not touched.

### Write-refresh convergence (verified)

A new product ("Convergence Probe Widget", SKU `CONV-PROBE-1`, cost 25, sale 60, 7 units in Main Warehouse) was created through the real Add Product modal. The save committed at 19:05:35Z; the POS gallery returned the product — price, cost, profit and stock badge — at 19:05:53Z, about 18 seconds later, having navigated to `/sales/pos` and searched the gallery in between. That is the `lib/offline/write-refresh.ts` path, not the 10-minute POS snapshot TTL or the hourly replica cycle: the record was visible far inside both windows. The open follow-up from the staleness fix (live add-product → POS check, previously verified by typecheck and tests only) is now closed with rendered evidence.

### Offline sale and outbox replay (verified)

CDP `Network.emulateNetworkConditions` turned out to be unusable as an offline switch for this app: page-level requests from the ERP are not blocked by it (the PWA service worker passes `/api/*` and app traffic straight to the network, and Chrome exempts that path from page emulation), while `Runtime.evaluate` fetches are. The first "offline" sale therefore completed online, and the header pill correctly stayed `Online` because its `/api/ping` probe kept succeeding. That run is kept as an ordinary online-sale confirmation: invoice `POS-00590772`, one item, one ৳60 cash payment, batch 7→6, three balanced journals (AR 60/60, COGS 25/25, payment received 60/60), all written exactly once.

The real outage was then produced by stopping the gateway process itself, so every platform call fails fast with a refused connection while the ERP origin stays up:

- Gateway killed at 19:25:10Z. The app detected it on its own — the pill turned amber `Offline` and the offline banner appeared ("this page works from cached data…", with an Open Sync Center link), driven by sync-engine transport failures rather than any injected signal.
- The sale was completed entirely from the replica: cart, payment method, and confirmation screens all rendered from cached data, and the UI finished with "Order Complete! `OFF-29182010`" — a local offline receipt id, not a cloud `POS-` number — with the pill reading `Offline · 1 queued`. The gateway log line count was unchanged across the whole sale window: nothing reached the platform.
- The gateway was relaunched with the same command and environment at 19:26:52Z. Six seconds later a single `sync_apply` POST (1152 bytes) appears in the gateway log, and `sync_intent_keys` holds exactly one row: `op invoice.create`, `result.status "synced"`, `invoice_number POS-00590773`, applied 19:26:58Z. The pill returned to green `Online` with an empty queue and the gallery badge settled at 5.
- Database verification through the gateway confirmed the replayed sale wrote each fact once: invoice count 1266→1267, one invoice item (1 @ ৳60), one ৳60 cash payment (`PAY-997849`), one `-1` sale stock movement, batch 6→5, and three balanced journal entries (`JE-969053` AR, `JE-969054` COGS, `JE-969055` payment received; debits 145 = credits 145). One POST, one intent row, one of each business record — the replay is idempotent at the observed granularity.

### Teardown and boundaries

`erp-session down` released all ports and the replacement gateway process was stopped separately; a fresh `verify:spike` pass confirmed the baseline candidate's data, ownership, RLS and privilege metrics are unchanged. What this session does not cover: `OFF-` to `POS-` receipt-id reconciliation in the printed receipt, conflict and failed-item paths of the outbox (only the clean happy path was driven), the 10-minute POS timers as a cross-device safety net (kept deliberately, not exercised here), Realtime streaming, and the packaged production build — this is still `next dev`. Phase 1 remains open on real restored-user login and failback.

## 22. Restored-user login and failback rehearsal — 2026-10-28

The last two Phase 1 gates were closed against the real restored dump, using two new guarded scripts (`scripts/restored-login-probe.mjs` via `npm run verify:login`, and `scripts/failback-rehearsal.mjs` via `npm run failback:rehearse freeze|restore|retire`). All artifacts are 0600 under `.runtime/`; users are referenced by id prefix and role only.

### Part A — restored-user login (verified)

Census of the restored clone (`rehearsal_6574005ad965…`): 8 restored auth identities plus the synthetic user; all hashes are `$2a$` bcrypt, all confirmed, 1 banned. A hash-consumption differential proved the server actually checks the stored bcrypt hash: a wrong password on a known restored email and a login for an unknown email return HTTP 400 with the identical modern error code (`invalid_credentials`, "Invalid login credentials") — no user-enumeration leak. One restored user (id prefix `7f88a1f3…`, role sales_executive) had its password reset through the Auth admin API **inside the clone only**; with the new password a real login succeeded, the issued JWT's signature verified against the cluster secret with `aud`/`role` = `authenticated` and `sub` matching the user id, and PostgREST through the gateway enforced RLS: the caller could read its own profile and invoices, but `exec_sql` returned 404. The ERP's own admin endpoint `/api/admin/users` correctly denied the same caller with 403 (app-layer role check works on the native stack). A rendered browser login with those credentials landed on `/dashboard` with the correct role chip and restored data. Not provable by design: whether the users' original cloud passwords still work — that cannot be known without plaintext, which is never available.

### Part B — failback rehearsal (verified, plan §10 end to end)

The source clone accepted one controlled online sale (`POS-00590772`) as the last committed operation, then `freeze` stopped every service, recorded the full `compatibility/verify.sql` metric set plus a sha256 fingerprint of `auth.users` (id:hash lines), and proved with a negative control that the metrics detect an inserted row (insert visible, rolled back, metrics unchanged) before dumping: 6.8 MiB custom-format `pg_dump` with sha256 and a frozen manifest. `restore` created a disposable target (`rehearsal_801dae707daa…`), restored with `pg_restore --exit-on-error --single-transaction` (exit 0; post-restore `GRANT CONNECT` was needed for `authenticator`/`supabase_auth_admin` — database-scoped grants are not in a dump), and the verifier's metrics **exactly equal** the frozen manifest with the auth fingerprint matching. The target got a fresh JWT secret; restored `auth.sessions` and `auth.refresh_tokens` were deleted, and invalidation was proven at the API level: the pre-cutover access token gets 401, the pre-cutover refresh token gets 400, the new service key gets 200. In the browser on the target, UI sign-out works, re-login as the restored identity works, and a controlled sale landed as `POS-00590773` — the invoice sequence continues exactly where the freeze left off. `retire` then confirmed the source is unchanged since freeze and set `default_transaction_read_only = on` on it: a write attempt now fails with SQLSTATE 25006. One write-accepting stack at a time, enforced by the database itself. Report: `.runtime/failback_3c06a0af834c…/report.json`.

### Findings

1. **Hollow fail-open dashboard on stale sessions.** After the JWT-secret rotation invalidated the browser's old token, the ERP did not force re-login: `use-profile.ts` deliberately fails open ("a null role must be treated as no restriction") and `Header.tsx` falls back to "Admin User / Super Admin", so the stale tab renders a dashboard-shaped page with ৳0 metrics while every server call is rejected by RLS. SessionGate only acts on `is_active === false`, which this isn't. Operationally harmless (the server still blocks everything) but confusing for a stand-by operator — a `401 → sign-out` UX guard is worth a follow-up in the ERP.
2. **4 of 8 restored users have no `public.profiles` row.** They can authenticate at the Auth layer but have no app role; the fail-open profile handling means they would enter with default (unrestricted-looking) UI while RLS blocks role-gated queries. A profiles backfill belongs in the failback runbook.
3. **Silent service deaths mid-rehearsal.** GoTrue and the ERP dev server each died without a captured cause (logging is deliberately redacted to byte counts); both were recovered by respawn and the rehearsal continued. Treat service liveness probes as a packaging requirement for the real product.
4. **Screenshot PII.** One UI screenshot captured a restored user's real email and was deleted immediately; the remaining evidence avoids filled login forms. The no-PII-in-artifacts rule needs the same discipline for screenshots.

### Not proven (explicit)

A fresh Supabase destination (the target here is a local restore into a disposable clone, not a new cloud project); remote network drift during cutover; live concurrent cloud writes racing the freeze (none existed — one operator); original user passwords. Teardown: `erp-session down` released all ports, `verify:spike` re-passed (baseline unchanged), CDP Chrome closed.

## 23. Packaging first slice — Tauri shell + packaged supervisor — 2026-10-28

Phase 3's first working slice: an unsigned macOS arm64 `.app` that boots the whole proven stack and opens the ERP. New pieces: `scripts/packaged-supervisor.mjs` (`npm run package:start|stop|status`) and `src-tauri/` (Tauri v2, lifecycle commands start/stop/status/open). All 22 existing unit tests still pass; the gateway's rehearsal guard was extended so that, and only when, `STANDBY_DATA_DIR` is set, the gateway log must live in the packaged data directory (rehearsal behavior unchanged).

### What was built and verified on this machine

- **ERP production build.** `next build` + service-worker routes succeed in the pinned submodule (no edits) once `NEXT_PUBLIC_SUPABASE_URL`/`ANON_KEY` are provided at build time — the client bundle inlines them, so build-time and runtime values must match (see the fixed-identity decision below).
- **Packaged supervisor.** `initdb` (scram-sha-256, loopback-only, standby_owner superuser) into the operator data dir; role provisioning from `compatibility/roles.sql`; activation by dump import: `pg_restore --exit-on-error --single-transaction` (NO `--no-owner` — it strips `supabase_auth_admin`'s ownership of `auth` and breaks GoTrue and the grants), then `GRANT CONNECT`, then the proven baseline grant sequence `grants.sql → grants-parity.sql → grants-parity-sync.sql` (the dump already carries the clone's sync grants, which would otherwise trip grants-parity's deny-list self-check), then gateway/GoTrue/PostgREST/ERP-production readiness. Status JSON (0600) drives the app UI. Start/stop/restart and failure cleanup (children terminated, PG stopped, no orphans) are verified.
- **Activation with the real failback dump.** The Phase 1 failback dump imported into `~/Library/Application Support/sisolution-standby` in ~3 s: 9 users, restored-user login (sales_executive, id prefix 7f88a1f3) returns 200 through the gateway, ERP production server serves `/login` 200.
- **Packaged app.** `cargo tauri build` produces `SI Solution Standby.app` (1.3 GB resources: scripts, compatibility, checksummed binaries, ERP build + node_modules; ad-hoc signature only — no Developer ID). Launching the app binary with `STANDBY_AUTO_OPEN=1`: the app itself spawned the supervisor from its own Resources, the stack reached `running` with 9 users, and the auto-open path navigated the WebView to the ERP.
- **WebView render verified (2026-10-28).** With Screen Recording granted, `screencapture -l <windowid>` captured the packaged window: the WKWebView renders the ERP login page fully (logo, styled form, sign-in button — no placeholder blocks), and the screenshot contains no PII (empty form only). Evidence: `/tmp/standby-app-window.png` (transient, not an artifact).
- **Rendered login on the packaged stack (2026-10-28).** After the two fixes and rebuild, the restored sales-executive credentials (from the Phase 1 rehearsal state file, never printed) logged in through the rendered UI in a CDP browser against the packaged stack's ERP: gateway token grant 200 with `role`/`aud` = `authenticated` and `sub` matching the user id, form submit landed on `/dashboard` with restored KPI data (monthly revenue, inventory value, receivables), charts, and the `Sales Executive` role chip in the header. Transient screenshot deleted after verification; credentials stayed inside the 0600 state file.
- **Two packaging bugs found and fixed during visual verification.** (1) The status page was stuck at "Checking…": Tauri v2 needs `app.withGlobalTauri: true`, and even then `invoke` lives at `window.__TAURI__.core.invoke`, not `window.__TAURI__.invoke` — the page now resolves `tauri.core?.invoke ?? tauri.invoke`. (2) Closing the app killed gateway/auth/postgrest while ERP+PG survived: non-detached supervisor children stay in the app's process group and die with it — `spawnChild` now defaults to `detached = true`; verified by quitting the app and re-probing all ports (gateway health 200, `status` still `running`). All 22 unit tests pass after both fixes.
- **Fixed packaged identity (deliberate slice-1 decision).** Because the client bundle inlines the Supabase URL and anon key at build time, this slice uses one fixed local identity (`.runtime/packaged-identity.json`, 0600, never committed) shared by build and runtime. Acceptable for loopback-only local use; per-install identities or runtime config injection are required before distribution.

- **Re-pin to 1086b9a and rebuild (2026-10-29).** The ERP submodule was advanced from c148f2a to `1086b9a` (8 new commits: POS cart UX, per-unit net price, quotation cost/margin — all frontend-only, no migrations, no dependency changes). ERP production bundle rebuilt with the fixed packaged identity (verified: 2 client chunks inline `127.0.0.1:55431`, no cloud URL) and the `.app` rebuilt. Rendered login re-verified on the new bundle: form submit lands on `/dashboard` with the full sidebar; transient screenshot deleted after verification. The relaunched packaged app was also visually confirmed serving the new bundle's dashboard (window capture deleted after checking; no PII kept).
- **Silent GoTrue death and supervision gap (2026-10-29, found and fixed).** GoTrue exited silently ~5 minutes after the previous stack start (last log line a normal 200; no stderr). Nothing noticed: `status()` only probed gateway health, the app skips `start` whenever status says `running`, and `start` refuses to run while surviving services hold ports — so every login 502'd until the stack was manually restarted. Fixes: `status()` now probes all four HTTP services and reports `state: "degraded"` plus per-service health and the degraded list; a `restart` command (stop → start) reclaims recorded pids and ports; the app's launch path runs `restart` on `degraded` and `start` otherwise. Verified by killing GoTrue: status flipped to `degraded ['auth']` immediately, and `restart` brought the full stack back (auth health 200, users=9). All 22 unit tests pass after the fix.
- **Login re-verification lesson.** An expired Supabase session left in the automation browser's localStorage blocks the rendered login flow silently (the app bounces to `/login`); clearing `sb-*` keys before driving the form is now part of the verification recipe.

- **PostgreSQL 17 and Node bundled into the binary set (2026-10-29).** New `scripts/bundle-native.mjs` stages the Homebrew PG 17.11 prefix layout (bin, lib, share — 75 MB) into `binaries/darwin-arm64/postgres/`, collects the external dylib closure (18 dylibs: ICU incl. data, gettext, zstd, lz4, openssl, krb5, readline — plus PG's own libpq), rewrites every absolute `/opt/homebrew` install name to `@executable_path`-relative, and ad-hoc re-signs the 68 modified Mach-O files (Homebrew dylibs reference each other via `@loader_path` — ICU's `libicudata` is invisible to a pure `/opt/homebrew` scan, so the collector resolves loader-relative deps against the source directory and stages them under the referenced basename). The official Node dist binary (v24.19.0, 116 MB, system deps only) is copied verbatim into `binaries/darwin-arm64/node/bin/node` and re-signed. `postgresBin()` now prefers the staged tree (env override still wins), and the Tauri launch resolves the bundled node before falling back to nvm. Proven end to end in a disposable data dir with every process rooted in the staged tree: initdb → roles → failback-dump activation (9 users) → gateway/GoTrue/PostgREST/ERP healthy → password login through the gateway returned 200 with `role`/`aud` = `authenticated`. `binaries.lock.json` records the staged paths and node sha256; `redistributionVerified` stays `false` until the Phase 4 license inventory covers all carried dylibs. All 22 unit tests pass.

- **Supervisor `start` now exits (2026-10-29, found via the packaged app).** The children's piped stdio kept the supervisor's event loop alive, so `start`/`restart` never returned while the stack ran — every CLI `package:start` hung (its "completion" only fired when a later `stop` killed the children), and the Tauri app's launch thread blocked forever on `Command::output()`, leaving the window stuck on the status page instead of opening the ERP. Fix: children spawn with their log file fd directly (`stdio: ['ignore', fd, fd]` — logs continue with no resident collector; the byte-count redaction of child output is replaced by the 0700 data-dir permission boundary), and `start` writes its final line synchronously and calls `process.exit(0)`. Verified: CLI start returns in ~2 s, and the packaged app launched with the stack stopped boots it from its own Resources and lands on the ERP dashboard (window capture deleted after verification).
- **Bundler permission trap (2026-10-29).** Homebrew ships PG files mode 0555; Rust's `fs::copy` preserves that, so the first bundle build succeeded but every rebuild failed with a bare "Permission denied (os error 13)" from tauri-build's resource copy. `bundle-native.mjs` now `chmod -R u+w`s the staged tree, and the fix is applied to the existing staging.
- **node_modules trim via standalone Next output (2026-10-29).** The bundle carried the full `erp/node_modules` (596 MB) plus the complete `.next` (592 MB). New `scripts/build-erp-standalone.mjs` builds the ERP with `NEXT_PRIVATE_STANDALONE=1` (Next 13.5 honors the env var, so the pinned submodule's `next.config` is untouched — zero ERP edits), copies `.next/static` and `public/` into the standalone tree, overlays the FULL `next` package over the traced one (output tracing misses `next/dist/server/next.js`, the dynamic entry `server.js` requires), and boot-tests the result from an isolated shadow directory — no parent `node_modules` to accidentally resolve from — copying in every module the boot reports missing (the trace also missed `watchpack`, `graceful-fs`, `glob-to-regexp`; dev-machine directory proximity had masked all of them). The supervisor now spawns the standalone `server.js` (`PORT`/`HOSTNAME` env) with a layout-aware entry path (repo `erp/.next/standalone` vs bundle `Resources/app/erp/standalone`). Bundle: **1.5 GB → 458 MB**. Verified: all major routes 200 from the isolated tree; CLI start healthy (gateway 200, GoTrue rejects bad credentials with 400, ERP served by the tracked child); packaged app relaunched from a fully stopped stack, auto-started from its own Resources, and landed on the dashboard with the retained Super Admin session (ERP listener cwd confirmed inside the bundle's standalone tree; window capture deleted after verification). All 22 unit tests pass.
- **Supervisor hardening from the trim verification (2026-10-29).** Three real failures surfaced and were fixed: (1) `ready()` could pass on a stale port holder — an orphaned `next-router-worker` from days earlier satisfied the probe while the real ERP child died with EADDRINUSE; the probe now settles 800 ms and confirms the child is still alive before declaring readiness. (2) A start that crashed mid-way left `supervisor.json` without the new children's pids, so a later `stop` could not reclaim them; the pids are now written before the readiness waits. (3) A crashed start left `supervisor.lock` behind with no owner recorded — the lock now records its owner pid and `start` self-heals a lock whose owner is no longer running (empty/garbage locks are treated as stale).

### Explicit gaps (Phase 3 gate not claimed)

Windows x64 untested. Clean-machine/quarantine tests, installer upgrade/uninstall behavior, tray/status polish, non-ASCII paths, and occupied-port UX are all untested. The ERP runtime is a standalone Next build (90 MB) assembled by `scripts/build-erp-standalone.mjs`; a future ERP submodule change is only needed if runtime-config injection for per-install identities is adopted. Redistribution licensing of the carried PG/ICU/gettext/openssl/krb5 dylibs is inventoried in Phase 4. The packaged app was subsequently relaunched with the stack stopped and auto-started entirely from its own Resources (bundled PostgreSQL 17 and Node), landing on the ERP dashboard.





## 24. Runtime connection config and connection UI — planned 2026-10-29

Goal: one install can be pointed at the local stack, the user's hosted Supabase, or a LAN host — the unlocker for cloud mode, LAN clients, and later hybrid sync. User direction (2026-10-29): skip the Phase 4 license inventory; prioritize this online/offline preparation instead.

### Why the refactor surface is small

Only three ERP places read the connection at runtime: `lib/supabase-raw.ts` (module-level `createClient`), `lib/offline/session.ts` (derives the `sb-<ref>-auth-token` localStorage key from the URL host), and `lib/telemetry/egress-tracker.ts` (host for telemetry). All 83 other files import the finished client from `lib/supabase` / `lib/supabase-raw`, so client creation is deferred in one place and no import site changes.

### Part A — ERP submodule (small, additive, one branch commit)

1. New `lib/runtime-config.ts` — `getSupabaseConfig(): { url, anonKey }`, resolution order: (1) `window.__SUPABASE_CONFIG__` injected per page load by the server, (2) localStorage cache, (3) build-time `NEXT_PUBLIC_*` (today's behavior, unchanged fallback).
2. `lib/supabase-raw.ts` — lazy singleton behind a forwarding `Proxy` so `supabaseRaw` and the wrapped `supabase` keep working as value exports at all import sites; `createClient` runs on first access with `getSupabaseConfig()`. Fallback if the Proxy misbehaves with supabase-js internals: export `getSupabaseRaw()` and codemod the 8 raw importers.
3. `app/layout.tsx` — inject `window.__SUPABASE_CONFIG__` via a `beforeInteractive` script from `process.env` read server-side at request time — the standalone server's runtime env becomes the client's config source.
4. Update `offline/session.ts` and `egress-tracker.ts` to take the host from `getSupabaseConfig()`. `admin-auth.ts` stays env-based (server side; service key already arrives via supervisor env).
5. Tests: precedence order, localStorage cache, unchanged behavior when nothing is injected; existing offline suite as regression.

### Part B — standby shell (config plumbing)

6. `connection.json` in the data dir (0600): `{ mode: 'local' | 'cloud', url, anonKey, serviceRoleKey? }`, default `{ "mode": "local" }`. Never committed.
7. Supervisor ERP-spawn env switches on mode: `local` → current values; `cloud` → user-supplied URL/anon key (+ service key for server-side admin ops). The local stack still boots in `cloud` mode (keeps switching back instant; optimization deferred).
8. Connection card in the Tauri status window (`src-ui/index.html`, no ERP change): mode selector, masked URL/anon-key fields, Test connection (real `GET <url>/auth/v1/health` with the anon key), Save & restart (writes connection.json 0600, restarts the supervisor so the ERP re-reads env). Status card gains active mode + target URL.
9. Realtime: nothing to build yet — the same client talks to hosted Supabase Realtime once the URL points there; the local stack already serves LISTEN/NOTIFY via PostgREST.

### Out of scope for this slice

`hybrid` mode (local PG as the offline working set + cloud replication) needs an explicit sync-policy spec (outbox-up tables, delta-fetch-down tables, conflict rules) and gets its own slice after this plumbing exists.

### Verification

- Unit tests in both repos.
- Regression-critical: local-mode login still works end to end after the Proxy refactor (rendered check in the packaged app).
- Cloud mode without production access: point the ERP's "cloud" config at a second local stack (disposable data dir, different ports) — the gateway speaks the Supabase protocol, so login must then hit the second stack's GoTrue.
- PII rules as usual: screenshots verified then deleted.

### Sequence

A (ERP lib + tests) → submodule commit on `customer-search-improvements` + push + re-pin → B (supervisor + shell UI) → cross-verification → evidence recorded here → commit/push both repos.

### Implemented and verified — 2026-10-29

**Part A (ERP submodule).** `lib/runtime-config.ts` resolves the Supabase target as injected → localStorage cache → build-time; `lib/supabase-raw.ts` builds its client lazily behind a forwarding `Proxy` (every `lib/supabase` consumer unchanged); the session-key derivation and the egress host read the same config. Five new tests; 120/120 jest pass. Pushed as `4c60f47` on `customer-search-improvements`; the standby submodule was re-pinned.

**Part B (standby shell).** `connection.json` (0600) in the data dir, written by `save_connection` (empty key fields mean "keep the stored key"; keys are only ever shown masked as `••••last4`); the supervisor spawns the ERP with `STANDBY_SUPABASE_URL` / `STANDBY_SUPABASE_ANON_KEY` resolved from `mode` and records `connection { mode, url }` in `status.json` (never keys); the status page gained a Connection card (mode select, URL, masked keys, Test connection → `GET <url>/auth/v1/health` with the anon key, Save & restart). Ports are env-overridable (`STANDBY_*_PORT`) so a second stack can run beside the packaged one. Six Rust unit tests cover the save/read/mask/keep-key/reject-local/curl-error behavior.

### Three build-time traps found during cross-verification

1. **Prerendered HTML froze the injected config.** Next 13.5 pre-rendered every page at build time, so `window.__SUPABASE_CONFIG__` always carried the build-time URL no matter the runtime env. Fixed with `export const dynamic = 'force-dynamic'` in the ERP root layout (a follow-up ERP commit on the same branch).
2. **webpack inlines `NEXT_PUBLIC_*` into server bundles too.** Even force-dynamic, `process.env.NEXT_PUBLIC_SUPABASE_URL` in the layout was replaced with a literal at compile time. Fixed by injecting from runtime-only names (`STANDBY_SUPABASE_URL` / `STANDBY_SUPABASE_ANON_KEY` in the supervisor spawn; `NEXT_PUBLIC_*` remains the build-time fallback).
3. **Status carried a stale error.** `writeStatus` merges patches, so a failed start's `error` survived a later successful start; the running status now clears it.

### Cross-verification (real processes, no production access)

- **Local regression.** Main stack restarted under the new supervisor; ERP HTML injects `http://127.0.0.1:55431`; CDP password login against the rebuilt standalone reached `/dashboard`.
- **Cloud mode.** A second full stack was booted from a disposable data dir with overridden ports (gateway 55441, PG 55442, ERP 55444, REST 55445, GoTrue 55446) from the failback dump (9 users), then the main stack's `connection.json` was set to `{ mode: "cloud", url: "http://127.0.0.1:55441", anonKey: <cloud-sim key> }` and restarted — the ERP (still at 55433) injected 55441, and a CDP login landed on `/dashboard` while the cloud-sim GoTrue logged the `/token` grant (its services log grew 23 → 35 lines). That is a genuinely different backend, not a URL alias.
- **Health probe semantics.** `GET /auth/v1/health` with the anon key: 200 on both stacks, curl exit 7 (surfaced as an error in the UI) on a closed port.
- Packaged `.app` rebuilt: 457 MB, bundled standalone chunk carries `STANDBY_SUPABASE_URL`; the status page renders the Connection card with "Active: local → built-in local stack" (get_connection round-trip proven by the rendered values). Screenshots were verified and deleted; no keys or PII kept.
- Unit tests: 22 standby node tests, 120 ERP jest tests, 6 Rust tests.

### Not covered / next

The Connection card's Test/Save buttons were verified through their command logic and the `get_connection` IPC round-trip, but not by scripted clicks inside the WKWebView. `hybrid` mode (outbox-up / delta-fetch-down sync policy) stays its own slice. Service keys typed into the cloud form are stored in `connection.json` (0600), as the plan specified.

## 25. Hybrid sync policy — spec — drafted 2026-10-29

> **Supersession (2026-10-29):** §25.3 (cloud sole writer authority), §25.4 (split planes), §25.6 (shared outbox as the only write path), §25.7 (delta mirror) and §25.5's tombstones are replaced by **§26 — deterministic op-log replication**, after user direction that the standalone app must execute every operation locally, online and offline, with order-based convergence provable by a state hash. Still valid from §25: the mode matrix (25.1), current-state inventory (25.2), identity/RLS parity and auth snapshot (25.9), egress awareness (25.11), and the test approach (25.14).

Goal: one desktop install keeps working with **every operation, online and offline**, while a hosted Supabase project remains the book of record. Hybrid adds continuous replication to the mode switch shipped in §24: the local PostgreSQL stack becomes the shared working set (also for LAN clients), and a sync agent keeps it converged with the cloud.

### 25.1 The three modes

| mode | reads / auth | writes | offline means |
|---|---|---|---|
| `local` | local stack | local stack | irrelevant (nothing remote) |
| `cloud` | cloud (browser Dexie replica for offline reads) | cloud `sync_apply` (browser outbox when offline) | cloud unreachable — per-browser queue |
| `hybrid` | local stack (LAN clients included) | shared outbox in local PG → agent → cloud `sync_apply` | cloud unreachable — queue grows in the shared outbox, no operation is lost or blocked |

Cloud remains a supported standalone mode; hybrid is additive.

### 25.2 What exists today and is reused

- `sync_apply(p_item_id, p_op, p_payload)` — one signature, 49 ops, two-layer idempotency (`sync_applied_items` claim + `sync_intent_keys`), `expected_updated_at` conflicts with `force`, conflict claims deleted so a forced retry re-executes (`20260909233000_offline_sync.sql:7-37,703-783`; final body `20260914150000_store_credit_cash_out.sql:150-317`). **Do not recreate a second signature**; the "9-arg" in project notes is `collect_customer_payment`, not `sync_apply`.
- 55 mirrored tables with `updated_at` (trigger `touch_updated_at`) or `created_at` cursors, applied by plain PostgREST `.gt(cursor)` reads (`lib/offline/replica.ts:87-141`), count probe + daily full replace for deletes (`:199-227`).
- Browser outbox state machine: UUID `item_id`, ordered drain, 2 attempts/drain, 3 s backoff, conflict parking (`lib/offline/sync.ts:113-240`, `lib/offline/outbox.ts:39-164`).
- Entity PKs are client-generated UUIDs (e.g. invoices insert `p_payload->>'id'`); the server mints only human document numbers (`20260913150000:61-75`). This is what makes replay idempotent and cross-op references stable.
- Stock: FIFO batches + `inventory_items` counters, `consume_fifo`, IOU shortfall rows, counter resync (`20261018120000`, `20261024120000`, `20261023180000`). Numbering: per-database sequences; unique `(tenant_id, invoice_number)` etc.; **payments have no unique number index** (`20260615013742_002_business_operations.sql:193,228`).
- RLS: SELECT open to `authenticated` for whole-table sync; writes role-gated on 7 high-risk tables; `service_role` is BYPASSRLS (`compatibility/roles.sql:8`).

### 25.3 Decision 1 — cloud is the single writer authority

Business operations run **only** in the cloud database. The local stack never mints document numbers, never runs FIFO/ledger side effects for cloud-replicated work, and never accepts a row diff as an update. Rationale: every invariant (numbering, FIFO, IOU healing, counter resync, RLS role checks) lives inside the `sync_*` handlers; a row-level bidirectional sync would fork those invariants and produce two ledgers that only look equal. Rejected alternative: local-authority with merge — requires conflict-free replication of ledger state, which the schema does not support.

### 25.4 Decision 2 — split planes

- **Read + auth plane:** ERP browser → local stack (as in local mode today: offline layer sees "server down" only if the desktop stack dies).
- **Write plane:** ERP browser → shared outbox RPC on the local stack → agent → cloud `sync_apply` → result back into outbox → delta pulls the row down.
- **Down plane:** agent polls cloud deltas → upserts into local PG (service role).

The browser's existing Dexie outbox stays the write path in `cloud` mode; in `hybrid` mode the outbox moves into the local database so all LAN clients share one queue and one drain.

### 25.5 Data policy matrix

| class | tables | direction | rule |
|---|---|---|---|
| A — mirror | the 55 replicated tables | cloud → local only | upsert by `id`; no local business writes outside the agent; cursors on server-side `updated_at`/`created_at` |
| B — ops | the 49-op surface (invoices, payments, returns, PO/GRN/purchase returns, quotations, deliveries, projects, products/customers/employees, warehouses, transfers, store credit, advances, expenses, quick sell) | local → cloud as ops | only through the outbox; never as row diffs |
| C — local state | `hybrid_outbox`, `hybrid_state`, sync logs, browser cache | local only | never replicated; excluded from deltas |
| D — auth snapshot | `auth.users`, `public.profiles` | cloud → local | profiles ride class A; users come from the GoTrue admin API (see 25.9) |

Deletes: class A needs tombstones — cloud hard-deletes leave no trace for a cursor read, so a migration adds `sync_tombstones(id bigint identity, table_name text, row_id uuid, tenant_id uuid, deleted_at timestamptz default now())` with delete triggers on every class-A table that hard-deletes; the agent replicates tombstones down and applies deletes locally. Retention 90 days. The count probe + weekly full replace remain as backstops, not as the primary delete mechanism.

### 25.6 Up path — shared outbox

```sql
create table public.hybrid_outbox (
  item_id uuid primary key,            -- the client idempotency key (same as today's outbox)
  user_id uuid not null,               -- acting user; replay identity
  op text not null, payload jsonb not null,
  created_at timestamptz not null default now(),
  attempts int not null default 0, status text not null default 'pending', -- pending|synced|conflict|failed
  last_error text, server_result jsonb, conflict jsonb, synced_at timestamptz
);
```
- The ERP enqueues through a local RPC (`hybrid_enqueue`) that stamps `user_id = auth.uid()`; the payload is exactly today's `sync_apply` payload (including `expected_updated_at`).
- The agent drains per user in `created_at` order — same semantics as the browser outbox — and calls a new **`sync_apply_as(p_user_id, p_item_id, p_op, p_payload)`** granted to `service_role` only, whose body is the existing `sync_apply` body with the identity taken from the argument. No user tokens are minted; replay survives token expiry.
- Results: `duplicate`/`synced` → store `server_result`, mark synced (the delta brings the canonical row incl. the real invoice number; `client_temp_number` remains the UI's provisional label until then). `conflict` → park with `server_row` for operator resolution in Sync Center (reuse the existing conflict UI patterns). Transport errors → backoff, cap at 5 attempts, then `failed` with a visible banner.
- Ordering: strict per-user FIFO; a poisoning op parks and blocks only that user's later ops (documented tradeoff, same as the browser today).

### 25.7 Down path

- One cursor per class-A table in `hybrid_state` (`replica:delta_cursor:<name>` equivalent), advanced only after a committed upsert batch.
- Cadence adapts: hot tables (invoices, invoice_items, payments, inventory_*, customers) every 2–5 s while a client is active; warm tables 30 s; cold tables 5–15 min; full replace weekly in an idle window; count probe every 20 cycles. Active = an outbox drain or a UI request in the last minute.
- Upserts run as the service role in a single transaction per table batch; failures never advance the cursor.
- **Echo guard:** the agent is the only writer of business rows locally, and up-traffic is op-based, so delta-applied rows can never be re-enqueued. Any future trigger-based capture must set `session_replication_role = replica`-style guards.
- Read-your-writes: the ERP's pending overlay (`lib/offline/pending.ts`) covers the gap between "op synced" and "row arrived"; target ≤5 s convergence with the agent running.

### 25.8 Conflict rules

| situation | rule |
|---|---|
| create replay | idempotent: `item_id` claim returns the stored result; a global `sync_intent_keys` PK collision across users still needs fixing to `(user_id, key)` (migration, see 25.12) |
| update vs update | `expected_updated_at` mismatch → park; operator chooses keep-local (retry with `force`) or take-server (discard) |
| status change vs edit | same check plus the legal-transition guard in the handler; cancel-vs-edit resolves to cancel unless forced |
| ledger appends (payments, stock movements, journal) | immutable; corrections are new ops, never updates |
| delete vs update | delete ops carry `expected_updated_at`; a tombstone for an id with a pending local update parks that op |
| delete when already deleted | treated as success (idempotent) |
| counters / stock on hand | never client-sent; the server recomputes; local counters are display data refreshed by deltas + overlay |
| two installs editing the same row | both replay into the cloud; the second gets a conflict and parks — no silent merge |

### 25.9 Identity, auth, and RLS parity

- **Shared JWT secret.** `connection.json` gains `jwtSecret` (0600, typed once in the Connection card; never sent to a browser). The local PostgREST validates cloud-issued access tokens, so `auth.uid()` and role claims are identical on both ends. Without this, local RLS would see a different identity than the cloud and every role-gated write would diverge.
- **Offline login.** Local GoTrue keeps serving; it must hold the same users. The agent snapshots `auth.users` via the cloud GoTrue admin API (service key) after each successful heartbeat. Known limits: password hashes must be present in the admin payload (verify before S4); users created in the cloud after the last snapshot cannot log in offline; offline refresh tokens are capped by their TTL.
- **Full-mirror disclosure.** The local database holds every tenant row (RLS still restricts API roles). Accepted for a single-operator desktop; anything multi-tenant needs the LAN/security slice (25.13).
- **Seeding.** Hybrid starts from an empty local database filled by the agent's first full replace plus the auth snapshot — a failback dump import stays the standby path, not the hybrid path.

### 25.10 Failure modes

| failure | behavior |
|---|---|
| cloud unreachable | reads continue; ops queue in the shared outbox; status pill shows "offline — N pending"; no op is dropped |
| agent crash | `hybrid_state` untouched (cursor advances only on commit); supervisor restarts it; single-flight lock row prevents two agents |
| partial down-batch | transaction rolls back, cursor stays; retry from the same point |
| duplicate delivery | `item_id` / `sync_intent_keys` dedupe; the second result is returned, not re-applied |
| outbox growth | disk quota check; over cap → hard banner, new ops still accepted but sync paused (never silent drop) |
| clock skew | cursors use server `updated_at`/`created_at` only; local timestamps are display data |
| target change (new project URL) | connection fingerprint in `hybrid_state`; mismatch resets cursors and forces a full replace |
| conflict storm | parked ops surface in Sync Center with counts; drain continues for unaffected users |
| replayed create with a colliding number | impossible against the cloud (authority mints); locally the temp number is cosmetic |

### 25.11 Egress budget

Down traffic dominates. Delta reads pull only changed rows but re-select all columns; mitigations: explicit column lists for the five hot tables, `Range` pagination at 1000 rows, cold-table intervals of minutes, no count probe more than every 20 cycles, weekly full replace in one idle window. The existing egress tracker learns to label both planes (`local`, `cloud`) so the budget is observable; the §24 requirement of bounded egress still applies.

### 25.12 ERP-side and shell prerequisites (additive)

1. Migration `sync_tombstones` + delete triggers (class A).
2. Migration `sync_apply_as(p_user_id, p_item_id, p_op, p_payload)` for `service_role`, delegating to the existing body.
3. Migration fixing `sync_intent_keys` PK to `(user_id, intent_key)`.
4. Optional: unique number index for payments (today duplicates pass silently).
5. Client: split read/write endpoints in hybrid mode (`lib/supabase.ts` read client → local; write client → cloud or outbox), and a thin local outbox adapter replacing Dexie's outbox in hybrid mode. This is the largest ERP change and is why hybrid ships in slices.
6. Shell: a third mode (`hybrid`) in the Connection card, a `jwtSecret` field (masked like the other keys), and the agent as a supervised child in `scripts/packaged-supervisor.mjs` with its own single-flight lock and status entry (`connection.replication`).

### 25.13 Slices and exit criteria

- **S1 — tombstones + down-sync agent.** Agent pulls cloud → local; hybrid writes blocked with a clear banner. Exit: after a cloud sale, local rows converge without a refresh; a cloud delete propagates; cursor survives an agent kill; egress measured.
- **S2 — shared outbox + up-drain for sales.** `hybrid_outbox`, `hybrid_enqueue`, `sync_apply_as`, agent drain; POS quick sell and invoice create only. Exit: offline sale queues and lands in the cloud with the cloud number after reconnect; duplicate replay is a no-op; conflict parks visibly.
- **S3 — all 49 ops, conflict UI, numbering reconciliation, delete ops.** Exit: every op either syncs or parks with an actionable reason; local temp numbers replaced by canonical ones.
- **S4 — auth snapshot + shared JWT secret.** Exit: cloud-issued tokens work against local RLS; offline login works for snapshotted users.
- **S5 — LAN clients.** Bind the gateway beyond loopback, per-client auth, and the TLS/permission decision (separate slice — currently loopback-only by design). Realtime emulation (LISTEN/NOTIFY → SSE for notifications) rides here; only `hooks/use-notifications.ts` consumes Realtime today.

### 25.14 Test plan

Two stacks (local + cloud-sim on override ports, as in §24). Scenarios: partition the cloud mid-sale and reconnect; replay the same op twice; edit the same product on both ends; delete on cloud with a pending local update; kill -9 the agent mid-batch; 200-op backlog; clock skew injection; target switch mid-queue; assert convergence with table fingerprints and outbox states, never by eyeballing UI.

### 25.15 Open decisions (recommendations inline)

1. **Auth for replay** — recommend `sync_apply_as` (service-role) over minting per-user tokens; it keeps the `auth.uid()` contract without token lifecycle.
2. **Tombstones in cloud migrations** — recommend yes; without them deletes rely on count probes and full replaces, which is both lossy and expensive.
3. **Outbox payload secrecy** — recommend plaintext under the 0700 data dir (the local DB already holds the same business data); no second encryption layer to manage.
4. **GoTrue admin snapshot** — confirm the admin API returns password hashes before S4; if it does not, offline login degrades to "last online session + refresh window" and that must be documented in the UI.

### Explicit non-goals

No cloud → local push/Realtime dependency (polling is the contract; hosted Supabase does not grant customers replication slots to rely on). No multi-tenant local mirror, no merge of two offline edits of the same invoice (park only), no mobile, no Windows, no automatic conflict resolution beyond `force`.

## 26. Hybrid, revised — deterministic op-log replication — 2026-10-29

User direction: the standalone app executes **every business operation locally** — billing, refunds, stock adjustments, customer lookups — online and offline; offline work is pushed to the cloud whenever a connection exists; devices sort ops by `(logical timestamp, device id)` and apply them in exactly that order, so the final state is identical everywhere and provable by state-hash comparison. No business operation waits in a queue.

### 26.1 The model

Every node — each device and the cloud — runs **one deterministic program** over the same op sequence. The objection to §25 ("the local database never applies business logic of its own") disappears: the local database does not run a second implementation, it runs the *same* implementation on the *same* input in the *same* order. Divergence in §25's rejected design came from two independent implementations merging row states; here there is one implementation and a total order. The cloud is the durable log, the snapshot host, and an equal replica — not an oracle that decides outcomes.

- **Op** = `{ op_id uuid, device_id, hlc (wall, counter), user_id, op, payload, schema_version, p_at }` — the existing 49-op `sync_apply` surface, with identity and time carried *inside* the op instead of read from the environment.
- **Order key** = `(hlc.wall, hlc.counter, device_id, op_id)`. Wall clocks are Hybrid Logical Clock values clamped to ±5 min of the cloud receipt time; ties break deterministically.
- **Execution** = append to the local log and apply immediately. The operation is real the moment the user presses the button. The unsynced **log tail** is durable transport state — it records what to send, but nothing is deferred: the business logic already ran, locally.
- **Sync** = push the tail to the cloud ingest RPC and pull ops after the local head. Push can be continuous or on demand ("sync now"); it is idempotent and resumable.

### 26.2 Total order, rewind, and catch-up

A device applies its own op at its current HLC, which is always later than every op it has seen — so local work never rewinds. A remote op that sorts **before** the last applied op (possible after a partition) triggers a rewind to the last checkpoint at or before that position and a replay. With HLC and a 5-minute clamp, rewinds are rare; checkpoint every 500 ops bounds the cost. While catching up the UI shows "Syncing — catching up" and marks recently created documents as provisional; with the numbering policy below, their numbers never change.

### 26.3 Determinism requirements (the real work)

A state hash can only match if the program is a pure function of `(state, op)`. The audit is concrete and bounded:

1. **No wall clock in state.** Handlers and triggers must use the op's `p_at`, not `now()` / `clock_timestamp()`. Sites today: document-number generators, GRN numbering (`clock_timestamp()` text), `created_at`/`updated_at` defaults and `touch_updated_at`, journal and activity-log timestamps.
2. **No ambient ids.** Row ids come from payloads (already true for invoices). Audit every `gen_random_uuid()` default on state tables; ids that today default server-side must move into the op.
3. **Deterministic orderings.** Every `ORDER BY` inside a handler needs a unique tie-break (`..., id`). Precedent already in the code (`20260926120000_pos_payment_application.sql:75` uses `created_at asc, id asc`); the FIFO/shortfall paths must all match.
4. **Deterministic numbering.** See 26.4.
5. **Deterministic failure.** Guards (oversell policy, legal status transitions, role checks) must decide from state alone. A rejected op is **appended to the log with its rejection reason**, so every node rejects it identically instead of each retrying into a different outcome. Today's `{status:'conflict'}` return is replaced by a log entry.
6. **No hidden state.** No reads of `request.jwt.claims` inside state-changing paths beyond the authorization envelope already recorded in the op (`user_id`, `schema_version`); no `search_path`- or setting-dependent behaviour.

### 26.4 Numbering policy (decision needed, default proposed)

| option | consequence |
|---|---|
| **Per-device series — `INV-<D3>-000123`** (recommended) | number is minted at execution and carried in the op; immutable across catch-up and replays; uniqueness is structural; format changes for new documents (legacy numbers remain valid) |
| Log-ordered global counter (`INV-000123` as today) | numbers stay uniform, but a rewind replays ops in a new position and **renumbers documents already printed/handed to customers** — rejected |

Recommendation: per-device series; the device suffix is derived once at install and stored in `connection.json`. Sequences stay in the schema for compatibility but are not used by op handlers.

### 26.5 Versioning: ops are data, handlers are code

Op replay must be identical on every node, so **all nodes in a sync group must run the same schema version**. Each op records `schema_version`; ingest rejects mismatched versions and devices block sync until upgraded. An upgrade is: drain the tail → migrate → bump the version → take a fresh snapshot. Without this gate, any handler change silently forks history.

### 26.6 Snapshots and bootstrap

State is never replayed from genesis. The log is anchored at **snapshots**: full state dump + log position + schema version + state hash. Genesis is a snapshot of the current cloud database at position 0. A new device bootstraps from the latest snapshot plus the tail; snapshots are taken every N ops or 24 h and pruned to the latest few. This replaces the 55-table delta mirror for hybrid: devices no longer fetch table deltas at all — they receive ops, which are far smaller.

### 26.7 State hash — the proof

`state_hash()` = sha256 over canonical, pk-ordered dumps of the state tables (driven by a table registry, not hand-written lists). After each checkpoint, a device reports `(position, state_hash)` to the cloud; the cloud compares it with its own hash at the same position and with other devices'. A mismatch halts relay for that device, re-delivers from the last common snapshot, replays, and reports a bug with both hashes. Hash equality at equal positions is the acceptance criterion for every slice — no "looks right" UI checks.

### 26.8 Ingestion and authorization

Devices post ops to `op_ingest` with the user's cloud JWT; the cloud authorizes the op (role/tenant/RLS-equivalent checks against its own state) *before* it enters the shared log, then appends it with the canonical order key. Rejected ops are appended with a reason, never silently dropped. The log is append-only; no node may rewrite history. The local stack validates the same checks locally, so an op that will be rejected locally is rejected before it is shown as done.

### 26.9 What §25 keeps, what it loses

- **Kept:** the mode matrix and connection UI (§24/25.1); the 49-op payload surface (now the log entry format); shared JWT secret and auth snapshot for offline login (§25.9); offline-session handling; egress awareness; the two-stack test rig.
- **Dropped for hybrid:** tombstones (deletes are ops), delta cursors and count probes (no table mirror), the shared-outbox-as-write-path (the log tail replaces it, without deferring execution), and `expected_updated_at` conflicts (order replaces check-and-retry; stale-order edits apply but are visibly ordered — see 26.10).
- **Reused as the executor:** the `sync_apply` body becomes the deterministic executor, called with `(op payload, p_at, user_id)` instead of reading `auth.uid()` and `now()`.

### 26.10 Semantics that change, and must be shown in the UI

- A late-arriving op that sorts earlier **wins** (it is earlier in the total order); the device replays and the later edit visibly reverts. Users must see "updated by another device at HH:MM" rather than silent flips.
- Business guards still reject: selling more than exists under `allow_oversell=false`, cancelling a cancelled invoice, paying a deleted one. Rejections are permanent log entries with reasons and per-device notices.
- Counters and stock are deterministic results of the op sequence, never inputs.

### 26.11 Failure modes (v2)

| failure | behaviour |
|---|---|
| offline | local execution continues; tail grows; no hash is claimed until positions match |
| cloud down | same; sync resumes idempotently |
| rewind | replay from checkpoint ≤ incoming op; provisional numbers immutable (26.4) |
| partition with divergent heads | order key resolves; both sides converge after exchange |
| rejected op | appended with reason on every node; user sees it once, from the cloud echo |
| schema drift | ingest refuses; devices block sync with an upgrade banner |
| snapshot corruption | re-request; snapshot is content-addressed by state hash |
| clock abuse | HLC clamped ±5 min against cloud receipt time; append order still total |
| rogue device | cloud authorization gates ingestion; log is append-only and auditable |

### 26.12 Slices and exit criteria

- **S0 — determinism harness.** Op-time plumbing (`p_at`), per-device numbering, tie-breaks in every handler, `state_hash()` registry, and a golden-replay test: apply a fixture log to two fresh databases → identical hashes. Exit: fixtures cover create/update/cancel/refund/adjustment/FIFO-shortfall and match.
- **S1 — single-device relay.** Log tail ↔ cloud ingest, snapshot bootstrap, on-demand and continuous push, hash report. Exit: a device works offline for a day of ops, reconnects, cloud state hash equals the device's; a second fresh device bootstraps from snapshot + tail and matches.
- **S2 — multi-device order.** HLC, rewind/replay, catch-up UX, per-device numbering in the UI. Exit: two devices execute interleaved offline work, sync in either order, hashes match; injected skew and mid-batch kills do not diverge.
- **S3 — all 49 ops + rejection UX.** Exit: every op either applies or is a logged rejection with a reason; no silent differences.
- **S4 — auth snapshot + shared JWT secret.** Exit: offline login for snapshotted users; cloud tokens satisfy local RLS.
- **S5 — LAN clients + realtime emulation** (LISTEN/NOTIFY → SSE; today only `hooks/use-notifications.ts` uses Realtime).

### 26.13 Cost and risks

The determinism audit is the bulk of the work: ~52 `sync_*` handlers, ~20 triggers, and 13 number generators touched (S0). Risks: handler changes without a version bump (mitigated by the ingest gate), rewinds under bad clocks (clamped, rare), snapshot size (compressed, pruned), and tail growth on long offline periods (disk quota banner, no silent drop). Everything else — networking, snapshots, hashing — is conventional.

### 26.14 Acceptance

Two devices go offline, each executes sales, refunds, returns, stock adjustments, and customer edits; they reconnect in an arbitrary order; after relay settles, `state_hash(position)` is equal on both devices and the cloud. Repeat with injected clock skew, a kill -9 mid-push, a rejected oversell, and a third device bootstrapping from a snapshot. Any hash mismatch fails the slice.

## 27. Isolated lab database and the replay audit — 2026-10-29

The determinism work needs a database that can be broken freely. It targets a second Supabase project (eu-west-3, PostgreSQL 17.11), never the live business project: its connection string lives in a 0600 file outside the repository, no key is written into the repo, and the tool refuses to write to any project ref that is not listed in `db-lab/targets.json`. The live project is not in that list.

### 27.1 The tool

`sisolution-standby/db-lab/` (commit `1874507`) pins the git-tracked migrations at the ERP commit (`git archive HEAD`, 330 files, sha256 manifest), applies them to the allowlisted project, and records every applied file with its hash in a git-ignored state file. Commands: `snapshot` / `snapshot --check`, `status`, `plan`, `apply --yes`, `reset --yes`, `verify`, `fingerprint`. Each file runs in its own transaction; a failure stops the run and the state is saved so the next run resumes at that file.

Lab result: 330 files applied; 76 tables, 59 with RLS, 214 policies, 193 functions; exactly one `sync_apply(p_item_id uuid, p_op text, p_payload jsonb)`; `handle_new_user` with `on_auth_user_created` on `auth.users`; fingerprint `cbcacf4b…` saved to `db-lab/baselines/lab.json`. The lab has no `replica_*` tables because the app creates those for its local mirror; migrations never do.

### 27.2 Finding: the migration chain is not replayable from an empty database

This is not a tooling nuisance; it changes what "the cloud schema" means for §26. Each class below was hit while replaying, and each is now a marker next to the pinned file, hashed into state and refused if edited later.

| class | examples |
|---|---|
| **Seed collisions** | `003_seed_data` seeds a category slug that `013_import_categories_brands` inserts again; `clear_seed_data` deletes parents before children; 6 seeded deliveries have a NULL `invoice_id` that a FK still references. |
| **Out-of-band DDL** | `purchase_returns` tables, the `grn_accounting` trigger, `purchase_returns_status_check`, and the scalar `get_fifo_inventory_value` existed only in the live database; migrations assume them. |
| **Broken files** | One file saved with literal `\n` instead of newlines (psql reads it as a meta-command); six files end without a semicolon on their last statement; one defines `restore_fifo` with `UPDATE ... ORDER BY`, which Postgres rejects at create time and which therefore never applied anywhere. |
| **Production data repairs** | Five files purge or repair specific production rows (INV-940607 …, INV-940647, the `testsup` supplier, the opening inventory balance). Each hard-codes ids and asserts on production totals, so each aborts itself on an empty database and defines no runtime schema. |

### 27.3 What this means for the op-log design

- **§26.6 genesis snapshot is not a convenience.** "Genesis is a snapshot of the current cloud database at position 0" is the only workable anchor: migrations cannot reproduce that database, so they cannot be the bootstrap path. A lab built from migrations differs from production in ways a hash would detect immediately.
- **§26.5 schema_version gating needs one canonical schema, taken from a dump.** The version a device records must identify the dumped schema, not a migration count.
- **S0 cannot assume handler parity with production.** The lab's handlers are the tracked chain's; production may carry out-of-band definitions. Before trusting a golden-replay fixture, diff the lab fingerprint against a fingerprint of a production dump; any difference is either a migration to write or a lab marker to add.
- **Add a replay gate.** `reset --yes && apply --yes && verify --baseline db-lab/baselines/lab.json` replays 330 files and compares the fingerprint. A migration that is not replayable, or that changes the schema unintentionally, fails there rather than on a customer's machine. Built and green in §27.6.
- **The dump carries ACLs, not just schema.** §27.5 shows a replayed schema that matches table-for-table and still answers every app request with `42501`, because the hosted platform's grants live outside the migration chain. A genesis snapshot taken from a dump carries both; a rebuild from migrations carries neither.

### 27.4 Exit criteria for this slice

330 files applied with every deviation recorded; `verify` holds and the baseline is saved; `snapshot --check` matches the pinned commit. Next: create one throwaway user through the app's signup path, point the app at the lab in cloud mode via the Connection card, verify login and one write, then switch back to local.

### 27.5 The lab is a working target — connection test — 2026-10-29

**User.** Created through GoTrue's admin API (`POST /auth/v1/admin/users`, `email_confirm: true`) as a dated throwaway address in the reserved `example.com` domain; the address, password and id are recorded in `~/.standby-lab-user.json`. `on_auth_user_created` fired and `handle_new_user` wrote the profile: role `sales_executive`, tenant `00000000-…-0001`. The older `20260629` definition defaulted to `store_customer`; a later migration replaces it, which is why the live chain's default is the sales role. The password lives only in `~/.standby-lab-user.json` (0600, outside the repo); rotating or deleting the user later is one admin call.

**Finding: the platform bootstrap is a second out-of-band dependency.** The lab project carries no default privileges for schema `public` (`pg_default_acl` has no row), so a replay grants the 76 replayed tables to `postgres` and nobody else: 4 of 76 tables reachable by `authenticated`. Even the service key got `42501` on `profiles`. Production never noticed because the hosted platform granted `ALL` to `anon`, `authenticated` and `service_role` when its tables were created. The family is fixed at the project level: `db-lab/bootstrap/public-grants.sql` reproduces the hosted bootstrap (grants on existing tables, sequences and routines plus the matching `ALTER DEFAULT PRIVILEGES`), exposed as `grants --yes` and run automatically at the end of `apply`. It is idempotent, and RLS — 59 tables, 214 policies — remains the thing that decides what each role can read, exactly as in production.

**API-level proof.** With the lab's anon key: password sign-in `200` (JWT issued), `profiles` read back the row above, `generate_customer_code` returned `CUST-000001`, `POST /rest/v1/customers` returned `201`, the row read back, then was deleted.

**App-level proof.** `connection.json` was backed up and rewritten in the packaged supervisor's cloud shape (`{mode:'cloud', url, anonKey, serviceRoleKey}`, 0600), the supervisor restarted, and the ERP's `/login` HTML then referenced only the lab project's `<ref>.supabase.co` — the server-injected `__SUPABASE_CONFIG__` path of §24 doing its job on a packaged build. In a fresh desktop Chrome: the real login form accepted the throwaway user and landed on `/dashboard`; CRM → Add Customer → Save produced `CUST-000002`, and the lab database holds it. The local `erp` database still has 243 customers and zero rows named `Lab UI Customer%`, so the write went to the cloud and nowhere else. The browser's session key was `sb-<lab-ref>-auth-token` and the runtime-config cache held the lab URL. Then `connection.json` was restored from the backup, the stack restarted, and status reports `mode: local` with the page referencing `http://127.0.0.1:55431` again.

**Not exercised: the Connection card itself.** The mode switch was made by writing `connection.json` in the same shape the card writes and restarting through the supervisor, because the packaged window is a WKWebView that CDP cannot drive. The card's save → validate → restart path has Rust unit tests but was not clicked in this test.

### 27.6 The replay gate — 2026-10-30

`npm run db:gate -- --yes` is the one command that answers "does the pinned chain still rebuild this schema?": it drops `public`, replays every pinned file, and compares the fingerprint with the committed baseline (`db-lab/baselines/lab.json`). It is destructive by design and takes about 20 minutes against the hosted lab.

**First run failed on the network, not the schema.** At file 5 of 330, the pooler refused two connections in a row (`timeout expired`), and the tool stopped with state saved so a rerun resumes at that file. A 20-minute destructive run should not die on one dropped connection, so `apply` now makes up to three attempts per file when the connection is lost (waiting 15 s, then 30 s) and never retries a statement timeout — a timeout means the file itself is too slow, and retrying only burns the same minutes. A retry is safe for the ordinary case, a drop mid-file, because each file runs in one transaction and the server aborts it. The one case it cannot rule out is a drop in the instant after `COMMIT`: the file would run twice, which is why each retry announces itself in the log.

**Clean run.** 330 files in 1195 s (1207 s for the whole gate, reset included); five files recorded as SKIPPED with their reasons (the fresh-database markers from §27.2); schema `76 tables, 59 with RLS, 214 policies, 193 functions`; `sync_apply(p_item_id uuid, p_op text, p_payload jsonb)` unchanged; grants `76/76`; fingerprint `cbcacf4b…` with 1718 objects, **identical to the baseline**; invariants (sync_apply, signup trigger, table count) hold.

What it proves: the commit the lab is pinned to still rebuilds the same schema from zero, and an unreplayable or accidentally schema-changing migration now fails in one command instead of on a customer's machine. What it does not prove: that this schema equals production's (a dump is still required, §27.3), or that the programs behave identically at runtime (that is §28) — and a green gate does not mean the rebuilt database can trade: the replay lands in the journal-numbering dead end documented in 28.2c, so accounting is blocked until B4. Auth users live outside `public` and survive a gate run; their `profiles` rows do not — the throwaway user's profile was re-inserted after the run. There is no CI workflow yet; the gate is run by hand before merging a migration or moving the pin.

## 28. Determinism audit: wall clock and ambient ids — 2026-10-30

§26.3 named the requirement; this section is the measurement. Every function in the pinned chain was read at its **final definition** (a later file overrides an earlier one), and the live schema was queried after a full gate replay. The result: the same op applied at a different time, or on a different server, produces different rows in seven distinct ways. None of them is a style problem — each one changes `state_hash`.

### 28.1 Method

- Source: 332 `.sql` files in `supabase/migrations`; 196 distinct function names after taking the last definition of each.
- Bodies scanned for `now()`, `clock_timestamp()`, `statement_timestamp()`, `transaction_timestamp()`, `CURRENT_DATE`, `CURRENT_TIMESTAMP`, `localtime`, `timeofday()`, `gen_random_uuid()`, `uuid_generate_v4()`, `nextval()` and `random()`.
- Triggers and column defaults cannot be seen in a function body, so those come from the live schema, not the scan (28.6). The scan is the map; the schema is the authority.
- Per-site counts in 28.2 are taken from the live `prosrc` (28.6), not from the file scan: the scanner keeps one definition per name and so cannot see a function redefined with a different argument list, and a first version of it used a `\b`-anchored token match that silently missed `now()` when followed by `,` or `;`. The file scan is used for names and files; the catalog is used for quantities.

### 28.2 What is non-deterministic today

**a. Business dates decided at replay time — 17 sites in 13 handlers.** The pattern is `coalesce(nullif(p_payload->>'payment_date',''), current_date)`: a payment replayed tomorrow is booked tomorrow. It appears in payment create, advance receive/refund/apply, expense create/update, PO create (order date twice, plus the deposit's payment date), PO payment, purchase return, supplier payable payment, quotation create (twice) and fund transfer. Two handlers write `current_date` unconditionally: `sync_advance_apply` (`20260911130000_offline_phase1_sales_payments.sql:468`) and `sync_store_credit_issue` (`…:628`). The collection form sends `payment_date` today, so the fallback is latent there — but nothing in the handler requires it, and not every caller sends one.

**b. Replay-time timestamps — `updated_at = now()` in 20 sync handlers (24 sites) and 18 other functions (39 sites).** `updated_at = now()` is written on every update the replay performs; `touch_updated_at()` (`20261002150000_replica_updated_at_delta.sql:28`) adds it again on every UPDATE of the 33 tables that carry the trigger; `sync_delivery_status` also writes `delivered_at = now()` (`20260911150000_offline_phase3_quotations_logistics.sql:387`). Counting every `now()` read rather than just that assignment: 31 sites in 23 sync handlers and 51 in 23 other functions. Replaying the same op a day later stamps different times on every row it touches.

**c. Document numbers minted on the server.** Ten replay handlers mint a document number server-side from the global sequence generators: invoice create (POS and invoice numbers, `20260913150000_offline_invoice_print.sql:65-68`), payment create (`20261015120000_payment_collection_grouping.sql:219`), store credit issue (`:603`), customer create (customer code), supplier create (supplier code), PO create (`20261013150000_po_item_force_cost_update.sql:223`, `:277`), PO payment (`20261015130000_…:157`), quotation create (`20260911150000_…:32`) and delivery create (`…:289`); purchase return adds a clock-text fallback (`20261023180000_…:1843`). Journal entries are minted one level deeper: `post_journal_entry` calls `get_next_journal_number()` (`20260703015921_20260703_fix_json_array_extract.sql:47`), and 29 live functions call it — every accounting trigger the replay fires creates a journal entry whose number depends on global numbering state. (The generator stopped using the sequence on 2026-07-03: `20260703012241_20260703_sales_stock_accounting_triggers.sql:44` replaced `nextval` with `MAX(SUBSTRING(entry_number FROM 'JE-(\d+)'))+1`, which still ignored date-shaped rows; `20260711111257_fix_pos_je_numbers_and_edit_invoice_line_total.sql:31` rewrote that as "strip every non-digit", which is what made `JE-OPENING-YYYYMMDD` poison the series, and `20260906110000_journal_hardening.sql:171` kept the scheme and added an advisory lock. Before 2026-07-03 the line read `'JE-' || nextval('journal_entry_seq')` — `20260629102914_008_accounting_automation.sql:57` — so the sequence has been idle since: at 1000 in the lab, behind the ledger in production.) The number is therefore a function of *how much other work the server has done*, not of the op: two replays disagree, and a rewind renumbers documents already printed and handed to a customer.

**The journal generator is not merely unstable between replays — it reaches a dead end.** `get_next_journal_number()` never touches `journal_entry_seq`. It takes `MAX(digits) + 1` over the existing `JE-%` numbers and formats the result with `lpad(v_count::text, 6, '0')`. `lpad` **truncates** over-long input instead of widening it, and one row in the chain carries eight date digits. On the replayed lab the sequence was:

1. `20260630022741_post_opening_inventory_accounting.sql:34` mints `'JE-OPENING-' || to_char(CURRENT_DATE, 'YYYYMMDD')` — the replay day, `JE-OPENING-20261029`. That is 28.2g and 28.2c at once: a document number that encodes when the chain was replayed.
2. Its digits parse as `20261029`, so the generator now computes `20261030` for every later call. `lpad(…, 6)` returns `JE-202610`.
3. `20260901120000_book_fifo_cutover_baseline_adjustment.sql` posts the cutover adjustment and succeeds — it stores the truncated `JE-202610`, a number meaningless against every other `JE-` row and dated `2026-08-08` while its number says October.
4. Every journal posting after that fails: the generator returns `JE-202610` again, and the insert raises `duplicate key value violates unique constraint "journal_entries_entry_number_key"`. The only escape is a number that is not what the generator returns, which no caller produces.

So the replay spends the one truncated number the generator can still produce, and once the chain finishes, no journal entry can be posted at all — until someone edits rows by hand. `journal_entry_seq` sits at 1000, unused. Two consequences beyond B4: the generator must be replaced, not merely fed an op clock; and §26.6 snapshots have to carry number state, because a snapshot that restores rows and not counters leaves the first post-restore journal entry mis-numbered.

**d. Ambient primary keys.** 49 INSERT statements in 26 handlers omit the `id` column, across 30 tables, so those rows get `DEFAULT gen_random_uuid()`. Some are alternate branches for payloads without an id; the child-row inserts are not — `invoice_items` (`20260913150000_…:115`), `quotation_items`, `delivery_items`, `purchase_order_items`, `cost_price_history`, `stock_movements` and `store_credit_redemptions` never carry an id in any definition. A replayed invoice keeps the invoice id it carries in the payload but mints fresh line ids on every replay, and those ids are what COGS, FIFO layers and the hash reference. Only `sync_purchase_return_create` names the source explicitly — `v_id := gen_random_uuid()` (`20261023180000_…:1840`) — which is equally ambient; everything else inherits the column default.

**e. Clock-dependent reads that change a decision.**
- `sync_invoice_create` only redeems store credit where `expires_at > now()` (`20260913150000_…:160`).
- `consume_fifo` only consumes batches where `expiry_date >= CURRENT_DATE` (`20261018120000_negative_stock_guards.sql:91`).
- `notify_overdue_invoices` counts invoices with `due_date < CURRENT_DATE` (`20261018230000_overdue_digest.sql:49`) — a cron job, not replayed, but it writes notifications, which are state.

The first two mean the same op can redeem a credit or consume a batch on one node and skip it on another, purely because of when it ran.

**f. Clock text inside fallback numbers.** `GRN-YYMMDDHH24MISSUS` from `clock_timestamp()` (`20261025130000_grn_iou_absorption_full_value_journal.sql:109`) and the SR/PAY/SC fallbacks from `to_char(now()|clock_timestamp(), …)` (`20261023180000_…:269`, `:419`, `:505`). Unreachable while the sequence generators return a value, but each one would put replay time into a document number.

**g. Accounting dates written by triggers the replay fires — 52 `CURRENT_DATE` sites in 28 functions outside the handlers** (plus the 17 in 28.2a). Mostly `COALESCE(<document date>, CURRENT_DATE)` in accounting/COGS code: `invoice_accounting_trigger` (`20260909100000_invoice_shipping.sql:127`), `post_grn_journal` (`20261025130000_…:413`), `record_sales_return` (`20261023180000_…:330`), `create_opening_batch` (`20261023160000_adjustment_iou_absorption.sql:58`, `:101`, `:159`), `create_stock_reduction` (`20261023180000_…:1984`, `:1986`, `:2008`), `receive_grn` (`20261025130000_…:114`), `cash_out_store_credit` (`20260914150000_store_credit_cash_out.sql:101`), `collect_customer_advance` (`20260926120000_pos_payment_application.sql:99`) and `record_fund_transfer` (`20260914130000_fund_transfers.sql:98`). When the document carries its date the fallback does not fire; when it does not, the journal is dated at replay time.

### 28.3 What is already deterministic, so the fix stays small

- 31 of the 51 dispatched handlers already take an id from the payload, so B3 extends an existing convention instead of inventing one; the other 20 act on referenced ids (`invoice_id`, `po_id`, …) and cannot mint the id of a new row deterministically today (28.2d lists the inserts).
- `consume_fifo` already orders `created_at ASC, id ASC` (`20261018120000_…:96-98`); `cancel_invoice` orders payments by `(payment_date, payment_number)` and the number is unique. Report functions have many untied `ORDER BY`s, but they do not write state.
- One Supabase RPC is one transaction, so a setting made at the top of `sync_apply` is visible to every nested function and trigger it fires. The code already relies on this: `app.edit_invoice_active` (`20260926130000_advance_application_reversal.sql:730`) is set and read the same way.
- No handler reads `request.jwt.claims`; among the sync functions, `auth.uid()` appears only in `sync_apply` (six non-handler functions — `has_role`, `is_active_user` and four audit/protection helpers — use it for authorization, not for state).

### 28.4 The mechanism: run each op under the op's own clock

```sql
-- S0 migration
create or replace function op_at() returns timestamptz
language sql stable as $$
  select coalesce(nullif(current_setting('sisolution.op_at', true), '')::timestamptz, now())
$$;

create or replace function op_date() returns date
language sql stable as $$ select op_at()::date $$;

-- first statements of sync_apply / op_ingest
perform set_config('sisolution.op_at', coalesce(p_at, now())::text, true);
```

Then rewrite every replayed path: `now()` → `op_at()`, `CURRENT_DATE` → `op_date()`, `touch_updated_at`'s assignment → `op_at()`, and state-table defaults `DEFAULT now()` → `DEFAULT op_at()`. Online writes (direct RPC, cron jobs) carry no `p_at`, so `op_at()` returns `now()` and today's behaviour is unchanged byte for byte.

Three properties make this the cheap option:

- The cloud clamps `p_at` to ±5 minutes of receipt before appending the op (§26.1), so every node executes the same value.
- A transaction-local setting reaches triggers, which is where most of the 54 `CURRENT_DATE` sites are.
- `op_at()` is STABLE, so it is legal in a column default and is evaluated once per statement, like `now()`.

### 28.5 Fix batches

| batch | scope | exit criterion |
|---|---|---|
| **B1 — envelope and clock** | `p_at` (with `device_id` and `hlc`) on `sync_apply`; `op_at()` / `op_date()`; the `set_config` line; no handler behaviour change yet | replay one op twice with `p_at` 30 days apart: identical rows except the sequence-backed ids and numbers fixed by B3/B4 |
| **B2 — timestamps** | `touch_updated_at`; the 24 sync and 39 other `updated_at = now()` sites; every remaining `now()` read (31 + 51); state-table `DEFAULT now()` → `DEFAULT op_at()` | no `now()` reachable from a replayed path outside B5 |
| **B3 — ambient ids** | the 26 handlers that insert without an id (49 inserts, 28.2d), of which 20 have no payload id branch at all (28.3): child ids carried in the payload (derived on the device from the op id) or derived server-side from `op_id`, e.g. `md5(op_id::text || ':<table>:<n>')` rendered as a uuid — not `uuid_generate_v5`, because the chain installs only `pg_cron` and `uuid-ossp` is not guaranteed on the bundled PostgreSQL | replaying the same op twice produces identical primary keys, including `invoice_items`, `quotation_items`, `payments`, `stock_movements` |
| **B4 — numbering** | §26.4 per-device series: numbers minted at execution, carried in the payload, stored verbatim; global generators remain only for direct online RPCs; journal-entry numbers follow the same rule, and `get_next_journal_number()` is replaced outright — its `MAX`-over-digits scheme cannot survive a date-bearing entry (28.2c). The dead end is closed ahead of the batch in 28.8; the deterministic per-device series remains | two devices replaying one log produce identical numbers; a rewind renumbers nothing; a fresh replay can post journal entries indefinitely |
| **B5 — clock-dependent decisions** | store-credit expiry filter, FIFO expiry filter, `delivered_at` → `op_at()`; the overdue digest stays cloud-only and outside the replayed path | replay at T and at T+30 days selects the same batches and writes the same `delivered_at` |
| **B6 — proof** | `state_hash()` over the table registry plus the §26.14 two-device rig with injected clock skew | hashes equal at equal positions under skew; mismatch halts relay |

B1 is a pure addition. B2 is mechanical and can land table by table behind the gate. B3 and B4 change payload contracts, so they must ship with the client's envelope change (S0/S1) or older clients lose their numbers. B5 needs B1. B6 is the acceptance test for all of them.

### 28.6 Live-schema cross-check

Queried against the schema the gate had just rebuilt from 330 files (§27.6), so these are what the chain actually produces, not what the text looks like.

- **69 functions read the clock (70 definitions — `post_grn_journal` is overloaded)** — 30 of the 51 dispatched handlers and 39 others. By token: 46 read `now()` (82 sites), 41 read `CURRENT_DATE` (69 sites), 2 call `clock_timestamp()` (4 sites). The static scan saw 75 names; six of them are defined and then dropped by the chain itself (`grn_accounting_trigger`, `invoice_items_cogs_trigger`, `purchase_order_accounting_trigger`, and three customer-balance helpers replaced in `20260906150000_customer_totals_trigger_authority.sql`), so the scan over-counts and the schema is the authority. Every site cited in 28.2 was read in its file.
- **170 clock/id defaults** — 104 columns default to `now()`, 66 to `gen_random_uuid()`. The 66 uuid defaults are the mechanism behind 28.2d: 66 tables mint their own row id unless the insert supplies one. There are no `nextval` defaults; numbering happens inside functions.
- **80 user triggers, 44 of them run a clock-reading function** — the 33 `touch_updated_at` triggers plus 11 accounting/stock triggers on `invoices`, `invoice_items`, `payments`, `purchase_orders` and `store_credit_redemptions`. A replay therefore touches the clock through triggers on 34 tables even if every handler were fixed (28.2b, 28.2g).
- **17 sequences** — the 12 live document series (invoice, POS, payment, delivery, PO, PO payment, sales return, customer, quotation, advance, store credit, supplier), the quick-sell SKU series, three audit/repair series, and `journal_entry_seq`, which was vestigial at the time of this measurement: nothing had called `nextval` on it since 2026-07-03, and journal numbers came from `get_next_journal_number()` (28.2c). 28.8 makes it the numbering authority again. Every other series is `nextval` inside a function.
- **`sync_apply` is still `(p_item_id, p_op, p_payload)`** — no time, device or sequence in the envelope. Its 51 dispatch targets all resolve in the live schema, so the handler surface is complete; only the envelope is missing.

One observation outside the audit's scope: `invoices` carries two enabled AFTER INSERT OR UPDATE triggers (`invoice_accounting`, `trg_invoice_accounting`) that call the same `invoice_accounting_trigger`, and `payments` does the same with `payment_accounting_trigger`. Duplicate execution is invisible while the handler is idempotent, but it doubles the clock writes and the journal numbering calls per row; the idempotency guard should be verified before S0 relies on it.

### 28.7 The same op, twice — a live demonstration

The counts above are a map. This is the terrain: on the freshly replayed lab, as the throwaway user through `sync_apply`, one `quotation.create` payload was submitted twice under different `p_item_id`s. The payload carried a customer, a product and one line — no row id, no `issue_date`, no idempotency key.

| field | run 1 | run 2 |
|---|---|---|
| quotation id | `15cde571…` | `db24df6e…` |
| quote number | `QT-000001` | `QT-000002` |
| issue date | `2026-10-29` | `2026-10-29` |
| created_at | `18:30:20.976529+00` | `18:30:23.050822+00` |
| line id | `ed036607…` | `aa69ad33…` |

Five fields, four of them different, none of them supplied by the op. That is 28.2a (`issue_date` is the server's `current_date` because the payload had none — replay it another day and the document is dated then), 28.2b, 28.2c and 28.2d in a single row: put the same log on two nodes, or replay it tomorrow, and `state_hash` disagrees at the first document. The probe rows were deleted afterwards, and the quotation series still advanced to `QT-000003` — which is the same point about global counters: nothing about them is restorable.

The journal path failed before writing anything. An `advance.receive` probe without `payment_date` returned `duplicate key value violates unique constraint "journal_entries_entry_number_key"`, `Key (entry_number)=(JE-202610) already exists`, and the stack shows exactly the chain 28.2c describes: `sync_advance_receive` inserts → `trg_advance_accounting` → `advance_receipt_accounting_trigger` → `post_journal_entry` → `get_next_journal_number()`. One RPC is one transaction, so the advance row disappeared with the failure — clean failure, but no advance either. Two probes, two different reasons to be non-deterministic, and the numbering fault fires before the clock fallback is ever reached, because the row carrying `current_date` never lands.

That failure is a finding, not a lab accident, and it is left standing: patching the number by hand would hide the condition B4 has to fix. The lab could not post a journal entry on the day of this section, which is worth knowing before anyone reads "the gate is green" as "the lab can run the business". (28.8 closes the dead end and re-runs the same probe.)

What this proves: the audit's categories reproduce on the real schema, not just in the source text. What it does not prove: anything about two devices, which remains B6's rig, and nothing here exercises the online (no-`p_at`) path, which must stay byte-identical after B1.

### 28.8 The journal-number dead end, measured and closed — 2026-10-30

28.2c described the dead end from the replay's side. Before writing the fix I checked what it means for production, without touching the database. The restored copy of the 2026-10-27 dump peaks at `JE-969048`: on the candidate, `max(regexp_replace(entry_number,'[^0-9]','','g')::numeric)` and the seed's `max` over `^JE-[0-9]{1,6}$` agree on that value, and no entry number sorts above it. The dump also carries no date-shaped opening entry. The sales of 2026-10-28 printed `JE-969053`–`969055` (§21) because that session's database had already posted entries of its own; those numbers are a property of the clone, not of the dump. The opening-balance migration returns early when inventory value is zero (`20260630022741_post_opening_inventory_accounting.sql:19`), which is what happened on production on 2026-06-30; the replayed chain has inventory by the time that file runs, so only the lab got the poison row.

Production is therefore not wedged today, but it stands on the same cliff. At `MAX = 999,999` the generator computes `1,000,000` and `lpad(…, 6, '0')` returns `JE-100000` — a number the series passed long ago — so the post fails on `journal_entries_entry_number_key`; if that row was ever deleted, the first truncated insert succeeds and the next one fails. From `969,048` the cliff is **30,951 entries** away. The numbers moved from `964,716` (cited by the 2026-09-01 inventory migration) to `969,048` at the dump, about 4,300 in eight weeks — roughly 77 posts a day, so of the order of a year, sooner with volume.

The fix is one migration, `20261030120000_journal_number_sequence.sql`, which hands numbering back to `journal_entry_seq` — the sequence `008_accounting_automation` created, which the 2026-10-27 dump no longer contains (the surviving `generate_journal_number()` wrapper still calls `nextval` on it, so that function is already broken in production; nothing calls it):

- **Seed.** `max(substring(entry_number from 4)::bigint)` over `^JE-[0-9]{1,6}$` only, applied only when it exceeds the sequence's `last_value`. A date-shaped row cannot move the series, and re-running the file is a no-op.
- **Format.** A 7-digit value is emitted as-is: `case when v_next < 1000000 then lpad(v_next::text, 6, '0') else v_next::text end`, so the millionth entry widens instead of truncating.
- **Concurrency.** `nextval` is atomic, so the 2026-09-06 advisory lock is gone. The cost is gaps: a rolled-back post burns its number. Gaps already exist (deleted entries and the 2026-09-06 repairs); a repeated number stops the ledger.
- **Ownership, not grants.** Because the dump has no such sequence, the migration creates it — and a sequence created by the migrating role is unusable by a `SECURITY DEFINER` function owned by `postgres`. The rehearsal's first paid sale failed with `permission denied for sequence journal_entry_seq` until the file also did `alter sequence public.journal_entry_seq owner to postgres`. It deliberately contains no `GRANT`: `create or replace` keeps the target's existing ACL, the hosted project's surface is restored in rehearsal by `compatibility/grants-parity.sql`, and an early explicit `grant … to anon, authenticated` broke the candidate's default-deny baseline (`anonymousPublicRpcs` and `unapprovedAuthenticatedRpcs` both 1 instead of 0) until it was removed.

`db-lab verify` now proves the behaviour rather than the policy: two consecutive inserts built from `get_next_journal_number()` inside one transaction, rolled back, and only on write-allowed targets. On the lab before the migration the first insert failed with `duplicate key … Key (entry_number)=(JE-202610) already exists` and verify exited 1; after it, verify prints `journal numbering: JE-202611, JE-202612 (two consecutive posts)` and the schema fingerprint is unchanged at `cbcacf4b…` (1718 objects). The `advance.receive` probe from 28.7, replayed through `sync_apply` after the fix, returned `synced` with `ADV-000003` and left no rows behind. Typing `setval` to 999,999 made the generator return `JE-1000000` then `JE-1000001`, the case that used to repeat one number forever; the counter was then set back to the ledger maximum.

On the restored copy the seed lands on the measured maximum: a paid sale through `standby_validate_sale` in a throwaway clone posted `JE-969049`, `JE-969050` and `JE-969051` (AR, COGS, payment received), one past `JE-969048` and no longer a `MAX` scan.

What this does not fix: numbering is still global state, so two replays still disagree and a rewind still renumbers printed documents — that is B4's per-device series, unchanged. The sequence value joins the state a snapshot must carry (§26.6).

Pinned the same day on top of `8587538`, the commit that carries the migration: `binaries.lock.json`, `compatibility/restore-contract.json` (with its `postRestoreMigrations` entry) and the submodule link all name the new HEAD, the baseline candidate carries it, `npm test` is 22/22, `verify:spike` and `validate:native` pass (the whole rehearsal, including the atomic paid sale), and `db:snapshot` pinned 331 migrations from the new commit. The lab `gate` has not re-run since; it is still the acceptance test for replaying the chain with this file, and it costs about twenty minutes.

### 28.9 The write-off migrations and the ownership invariant — 2026-10-30

Three migrations went to production the same day (`56e45fb`, merged locally as the merge on top of `58b3e29`): inactive products leave the inventory-value aggregates (`20261030160000`), and per-product stock write-off lands as `write_off_product_stock` (`20261030170000`) routed through a `5900` expense account via a re-created `create_stock_reduction` that takes `p_debit_account_code` (`20261030180000`, default `3900`, so every existing caller is unchanged).

They exposed an invariant the journal migration had already brushed: a migration that mints a `SECURITY DEFINER` function must pin two things the hosted project gives for free but a replay does not. **Owner.** On the standby candidate the migrating role creates the function, so the definer runs as the wrong owner; the file must say `ALTER FUNCTION … OWNER TO postgres`. **PUBLIC.** New functions carry `GRANT EXECUTE … TO PUBLIC` by default; the file must `REVOKE ALL … FROM PUBLIC` or the candidate's default-deny baseline breaks. The `GRANT … TO authenticated` stays — production needs it, and the standby strips it by re-applying `compatibility/grants.sql` after the post-restore migration loop (`restore-spike.mjs`, idempotent).

The dump-count check also had to move. `publicFunctionCount` was asserted against the dump TOC, but replayed migrations legitimately add functions — the write-off pair nets one (`write_off_product_stock` is new; `create_stock_reduction` trades its 8-arg body for a 9-arg default). Restore fidelity is now asserted before the migrations run and recorded as `restoreFunctionCount` in `report.json`; after them the live count must only never drop below it.

Pinned on top of the merge: the three migration files carry the ownership and PUBLIC-revoke lines, `binaries.lock.json`, `restore-contract.json` (five `postRestoreMigrations` entries) and the submodule link name the new HEAD, a fresh restore verifies clean (`candidate` rebuilt from the same 2026-10-27 dump), `verify:spike`, `validate:native` (atomic paid sale included) and `npm test` 22/22 all pass, and `db:snapshot` pinned 334 migrations. The lab gate has since re-run green: all 334 files replayed into a fresh clone in about eighteen minutes, the replay fingerprint equals the live lab's state hash `7791dde7…` (1719 objects — up from `cbcacf4b…`/1718 at 330 files, the four new functions being the only delta), `db-lab/baselines/lab.json` was saved at the new fingerprint and a second `verify --baseline` reads back identical, and the journal probe keeps posting consecutive numbers on every run (the probe's rollback still burns sequence values, as §28.8 says it must).

### 28.10 B1 — the envelope and the clock — 2026-10-30

`20261030190000_b1_op_envelope_clock.sql` ships §28.4 as written. `sync_apply` grows `p_at timestamptz`, `p_device_id text` and `p_hlc text`, all defaulted, so every existing 3-arg caller — the offline engine's `supabaseRaw.rpc('sync_apply', …)`, the validation wrapper, direct RPCs — resolves through the defaults unchanged; the 3-arg signature is dropped explicitly. The dispatcher's first statement is `perform set_config('sisolution.op_at', coalesce(p_at, now())::text, true)`: one RPC is one transaction, so every nested handler and trigger it fires sees the op's clock, and an online caller that omits `p_at` gets `now()` byte for byte. `op_at()`/`op_date()` read the setting and fall back to `now()`/`CURRENT_DATE`; nothing else calls them yet — B2 migrates the handlers. `sync_applied_items` gains `op_at`, `device_id`, `hlc` next to `applied_at`, which stays the server's receipt time. The ownership/PUBLIC invariant of §28.9 is applied to all three functions (owner pinned to `postgres`, `REVOKE … FROM PUBLIC`, `GRANT EXECUTE` to `authenticated` only).

Two probe bugs were caught by running it, not by reading it. `COMMENT ON … IS 'a' || 'b'` is a syntax error — the IS clause takes one string literal, not an expression (the restore spike caught it on the candidate before the lab ever saw it). And the probe's `customer.create` payload must carry `data.type` (`retail`), which `customers.type` requires NOT NULL.

The exit criterion ran against the live lab through `db:verify`'s new op-clock probe: two `customer.create` ops executed as `authenticated` with `p_at` 30 days apart recorded `op_at` `2026-09-30…`/`2026-11-29…`, distinct `device_id`s and per-op `hlc` on `sync_applied_items`, while the `customers.created_at` rows still carry the server clock — B2 has not been applied, and the probe asserts that honestly: if a `created_at` ever matches the op clock, it warns instead of passing silently. The probe runs in a rolled-back transaction, so it burns nothing but probe output.

The rest of the chain: fresh restore spike PASS (six `postRestoreMigrations` entries now), `verify:spike`, `validate:native` (the rehearsal's `standby_validate_sale` still drives the dispatcher through the updated `grants-parity-sync.sql` signature), ERP `npm test` 120/120 and standby 22/22, `db:snapshot` pinned 335 migrations, and the gate replayed all 335 files into a fresh clone in about eighteen minutes with the replay fingerprint equal to the live lab's state hash `300ac140…` (1724 objects, up from `7791dde7…`/1719 — the three B1 functions plus the envelope columns being the delta). The baseline was re-saved at the new fingerprint and a second verify reads back identical. Handlers still read `now()`/`CURRENT_DATE` everywhere (28.2's inventory unchanged); B2 moves them onto `op_at()`/`op_date()`.

### 28.11 B2 — the handlers read the op clock — 2026-10-30

`20261030200000_b2_op_clock_timestamps.sql` flips every clock read reachable from a replayed path onto `op_at()`/`op_date()`. Scope was computed mechanically, not by hand: a BFS over the live lab's call graph — regex function-call edges plus the trigger functions attached to tables the reachable code writes — started from `sync_apply` and the 51 `sync_%` handlers and reached 136 functions, of which 61 read a clock. The migration re-mints those 61 as 62 `CREATE OR REPLACE FUNCTION` statements (three have two overloads each) with `now()`/`current_timestamp` → `op_at()` and `current_date` → `op_date()`, roughly 132 read sites in total, plus 112 `ALTER TABLE … SET DEFAULT op_at()` statements for the public non-`sync_%` columns that defaulted to `now()`. Online callers that omit `p_at` get the `now()` fallback byte for byte, so this is invisible until an op arrives with an envelope.

Deliberate wall-clock exceptions, each with an inline comment: `consume_fifo`'s `expiry_date >= CURRENT_DATE` filter and `sync_invoice_create`'s `expires_at > now()` filter stay on the wall clock — they are stock decisions, B5's problem, not timestamp bookkeeping; the `clock_timestamp()` fallback-number sites stay for B4; and the `sync_%` tables keep their receipt-time defaults because `applied_at` is by definition when the server saw the op.

Three bugs were caught by running the chain, not by reading the file. `pg_get_functiondef` output carries no trailing semicolon, so 61 of the 62 statements silently merged into their successors — the restore spike failed with a syntax error at the first merged boundary, and the generator now terminates every body. Two of the re-minted identities (`consume_fifo`'s four-arg overload, `post_journal_entry`'s text/jsonb overload) exist in the migration chain but not in the production dump, so `CREATE OR REPLACE` created them owned by the migrating role and `verify.sql`'s `publicFunctionsWrongOwner` gate caught it — the fix pins `ALTER FUNCTION … OWNER TO postgres` for all 62 statements in the file, per §28.9. The same signature diff against the dump TOC surfaced a real finding for §27's parity work: the production dump is missing those two overloads entirely, a schema drift between the dump and the migration chain that predates B2.

The exit criterion flipped exactly as designed. The lab applied the migration in 51.8 s; the op-clock probe now asserts `customers.created_at` follows the op clock and fails if it ever drifts back: two ops 30 days apart produced `created_at` values millisecond-identical to their recorded `op_at`. The gate replayed all 336 files in about eighteen minutes with the replay fingerprint equal to the live state hash `d8957c9d…` (1724 objects, up from `300ac140…` — the delta is one migration file; object count unchanged because B2 re-mints rather than adds). Baseline re-saved; a second verify reads back identical. The chain also ran a fresh restore spike and `validate:native` rehearsal green at the final pin.
