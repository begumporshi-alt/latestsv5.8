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




