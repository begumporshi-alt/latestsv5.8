# Gap Audit — Accounting & Reports · 2026-09-06

Scope: the **accounting module** (7 routes under `app/(erp)/accounting/`), the **reports module** (6 routes under `app/(erp)/reports/`), `/expenses` (a GL-writing surface), and the GL/reporting chain that feeds them (triggers, RPCs, chart of accounts). Grounded in the owner's confirmed real-world practices (Phase 0 answers):

- Period-end: **annual close only** (no monthly lock needed)
- Tax: **VAT on sales** + **withholding tax on purchases**
- Bank: **monthly bank statement reconciliation** wanted
- Statements the business runs on, beyond today's set: **balance sheet, cash flow statement, VAT/tax return report**

Ledger health at audit time (live DB): trial balance Dr = Cr = ৳27,567,846 (proven by `get_trial_balance`), and `get_account_balance_drift()` returns **0 rows** — every cached `accounts.balance` matches its journal-line sum. The journal itself is healthy; the gaps below are about coverage and write-path safety, not existing corruption.

---

## 1. Executive summary

**22 gaps: 4 × P0, 10 × P1, 8 × P2.**

The three worst, in plain language:

1. **You charge VAT on sales, but the app cannot record a single taka of it.** No invoice, POS, or quotation form has a tax field (grep across all components: zero tax inputs); `tax_amount` is 0 on every invoice, PO, and quotation ever created; the VAT Payable account (2100) has **zero journal lines in its history**; and the invoice trigger books the full invoice total into Sales Revenue (4000). Every revenue figure in the P&L is therefore VAT-inclusive, and nothing can be filed from the app.
2. **Withholding on purchases has no support at all** — no WHT account in the chart of accounts, no UI on supplier payments, and the payment trigger posts the full amount as Dr AP / Cr Cash. The ledger overstates cash paid out by whatever you deduct as WHT in reality, and WHT credits are untracked.
3. **The balance sheet and cash flow statement do not exist anywhere** — the business runs on them (owner-confirmed) and neither has a page, RPC, or link. The balance sheet is nearly free to build: the trial-balance RPC already proves Dr=Cr, so it is one grouped query + one page away. One blocker to fix first: account **4001 (৳836,883) is typed `equity` instead of `revenue`**, so manual-receivable revenue would land on the wrong statement and is already invisible to the P&L today.

One near-miss worth knowing: **five different UIs still maintain `accounts.balance` with non-atomic frontend math** (read-balance → compute → write-back). Live drift is zero today, but this is the exact class of code that caused the ৳544,356 edit-invoice balance corruption fixed on 2026-09-03. It's a loaded gun, not a firing one.

---

## 2. Coverage matrix

Verdicts cite the page that provides the capability. MISSING = proven absent (full page reads + greps, see §4).

| Area | View | Create | Edit | Reverse / Cancel | Report | Export / Print |
|---|---|---|---|---|---|---|
| Chart of Accounts | COVERED `accounting/accounts/page.tsx` | COVERED (modal, :245-508) | PARTIAL — no parent picker (dead `parent_id`, :265/:288), code not editable | PARTIAL — deactivate/reactivate only; **no protection for system accounts** (1100/1200/2000/4000/5000/5600/1001/3900 editable/deactivatable; RLS allows all) | COVERED `accounts/[id]` statement | MISSING — no CSV/print on list **or** statement |
| Journal entries | COVERED `accounting/journal/page.tsx` | COVERED (8 quick templates + custom, :1148-1377) | COVERED w/ impact previews (:1386-1760) | PARTIAL — hard delete only; no void; auto-entry delete needs no reason (:1959-1966) | COVERED (15 type filters, supplier filter, search, grouping) | CSV (:453-479) + print |
| Manual receivables / payables | COVERED (dashboard lists, :631-712) | COVERED (dashboard modals, :946-1209) | MISSING — no edit; only collect/pay | PARTIAL — bad-debt write-off on receivables only (:1280-1305) | COVERED | MISSING |
| Payments (received/made/refund) | COVERED (journal page, collection report) | COVERED (POS / invoice / supplier / dashboard) | — | PARTIAL — `is_reversed` flag exists; cancel-invoice reverses its payments; no generic payment void | COVERED `sales/collection-report` | CSV (collection report) |
| Expenses | COVERED `/expenses` | COVERED (:482-519) | COVERED but **flattens multi-line manual JEs to 2 lines** (:455-469) | COVERED (delete with reversal, :143-168) | PARTIAL — "Total Expenses" stat counts **all** `manual` JEs incl. non-expense ones (owner withdrawal etc.), see P2-6 | MISSING |
| AR aging | COVERED `accounting/aging/page.tsx` (AR tab) | n/a | n/a | n/a | PARTIAL — no as-of date (:81), invoice-status basis, no GL (1100/1300) basis anywhere | print only; no CSV |
| AP aging | COVERED (aging page AP tab) | n/a | n/a | n/a | PARTIAL — page uses PO+30-day-invented-terms basis (:146) while a GL-based `get_payables_aging` RPC exists but is used only by the dashboard — **two divergent AP agings** | print only; no CSV |
| Trial balance | COVERED `accounting/trial-balance/page.tsx` | n/a | n/a | n/a | COVERED — period + custom range, closing Dr=Cr check, unbalanced-entry detection (:152-195) | CSV + print (cleanest page audited) |
| P&L | COVERED `/reports/pl` + hub tab | n/a | n/a | n/a | PARTIAL — **current month/quarter/year only** (:250-254, no prior/custom period); revenue basis differs from hub & dashboard (P1-6); credit-balance expense accounts silently hidden (P1-7) | CSV + print |
| Balance sheet | **MISSING** | — | — | — | **MISSING** (grep: only migration comments) | MISSING |
| Cash flow statement | **MISSING** | — | — | — | **MISSING** | MISSING |
| VAT: charge → post → report | **MISSING** | **MISSING** | — | — | **MISSING** (2100 dead, 0 lines ever) | MISSING |
| Withholding on purchases | **MISSING** | **MISSING** | — | — | **MISSING** | MISSING |
| Bank reconciliation | **MISSING** (no statement import/matching) | — | — | — | **MISSING** | MISSING |
| Year-end close | MISSING (no closing entries, no retained-earnings roll-forward) | — | — | — | PARTIAL — P&L can't show prior periods (P1-5) | — |
| Inventory value report | COVERED `reports/inventory/page.tsx` | n/a | n/a | n/a | COVERED — full pagination loops, no truncation; no totals row; Value stat vs column computed by different paths | CSV |
| COGS audit | COVERED `reports/cogs-audit/page.tsx` | PARTIAL — repair RPCs (delete-dup, repost, refresh-history) | — | — | COVERED (7 tabs, 10 timeline presets) — but MISSING fix_action CREATE_JE has **no UI** (P1-8) | CSV only; no print |
| Activity log | COVERED `reports/activity/page.tsx` | n/a | n/a | n/a | PARTIAL — search/dropdowns/“Today” stat operate on the loaded 20-row page only (:98-102, :153-161, :165-175) | MISSING |
| Edit history | COVERED `reports/edit-history/page.tsx` | n/a | n/a | n/a | PARTIAL — `.limit(500)` silent cap, no pagination (:44); change-type filter misses 3 of 5 DB values (:149-150) | CSV (lossy — 200-char snapshot slice, :69-70) |
| Journal guide | COVERED `accounting/journal-guide/page.tsx` (static) | n/a | n/a | n/a | PARTIAL — documents 4 superseded flows as current (P1-9) | n/a |

**Page-count reconciliation:** 51 `page.tsx` routes in the app; 14 in scope (7 accounting + 6 reports + expenses). All 14 appear in the matrix above, and all 14 are linked from the Sidebar (verified). Orphan-page check: `/expenses` is *not* an orphan (it reads/writes `journal_entries` where `reference_type='manual'`) — there is no `expenses` table, by design.

**Status sweep:** the DB has no business `pg_enum` types; statuses are CHECK constraints. In scope: `payments.payment_type` ∈ {received, made, refund} × 8 `reference_type` values — every live combination traced to its posting path (see §4). `journal_entries` has no status enum; the UI renders a "draft" badge with no way to create or post drafts (P2-8). Invoice statuses (7 values) were reconciled in the 2026-09-06 journal audit; 0 draft rows exist.

---

## 3. Gap list

### P0 — business-blocking (owner-confirmed practice with no support anywhere)

#### P0-1 · VAT on sales: charge, post, and report — all missing
- **Stage:** sales → AR → GL → statutory reporting.
- **Evidence:** no tax input in any form (grep `tax_amount|tax_rate|vat` over `app/ components/ lib/` → only false positives like "acti**vat**e"); `invoices.tax_amount` = 0 on **all** rows, same for `purchase_orders` and `quotations`; account 2100 VAT Payable has **0 journal lines ever** (`select count(*) … a.code='2100'` → 0); `invoice_accounting_trigger` posts `COALESCE(NEW.total_amount,0)` entirely to 4000 (`20260703012241…sql`).
- **Impact:** revenue overstated by the VAT portion in every P&L and hub figure; VAT collected is never owed to anyone in the books; monthly/annual VAT returns must be assembled by hand outside the app.
- **Fix sketch:** (1) settings for VAT rate + registration; (2) compute + expose `tax_amount` in POS/invoice/quotation totals; (3) change the invoice/return triggers to split Dr AR total / Cr 4000 net / Cr 2100 VAT; (4) VAT summary report per period (output VAT, input VAT on purchases if later added, net payable). Trigger work belongs in one migration with an idempotency guard like the journal-hardening one. Routing: [[frontend-flow-to-atomic-rpc]] for the form→RPC chain; keep all JE posting server-side.

#### P0-2 · Withholding tax on supplier payments — missing
- **Stage:** AP → payment → GL.
- **Evidence:** no WHT account in the chart (2000-series is only 2000 AP, 2100 VAT, 2200 refund, 2300 advances); no WHT field in any supplier payment UI (same grep as P0-1); `payment_accounting_trigger` Case 2 posts full amount Dr 2000 / Cr cash (`20260906110000_journal_hardening.sql:126-165`).
- **Impact:** the AP ledger says you paid suppliers more cash than you actually did (by the WHT deducted); WHT credit (deducted-at-source tax you can offset) is untracked.
- **Fix sketch:** WHT Payable account (e.g. 2110), optional WHT amount field on supplier payment forms, payment trigger split (Dr 2000 full / Cr cash net / Cr 2110 WHT), and a WHT summary in the VAT/tax report from P0-1. Same migration discipline.

#### P0-3 · Balance sheet — missing
- **Stage:** reporting (owner-confirmed statement the business runs on).
- **Evidence:** grep `balance sheet|balance_sheet|cash flow|cashflow` over app/components/lib/migrations → only prose comments in two migrations; reports hub tabs are overview/sales/inventory/customers/pl (`reports/page.tsx:16`); sidebar (extracted links) has no such route.
- **Impact:** no assets/liabilities/equity view; combined with P0-1/P0-2 the equity section can't be trusted anyway until posting is fixed.
- **Fix sketch:** one RPC (`get_balance_sheet(p_as_of)`) grouping `get_trial_balance`-style period sums ≤ as-of date by account type, page styled like `/reports/pl`, CSV + print. **Prerequisite data fixes:** retype 4001 equity→revenue (its ৳836,883 credit is revenue, currently invisible to the P&L and would misstate equity); resolve the 5900 Inventory Adjustment −৳7,268,841.85 net credit (entirely from `stock_adjustment` JEs — see P1-7) so the expense section doesn't hide it.

#### P0-4 · Cash flow statement — missing
- **Stage:** reporting (owner-confirmed).
- **Evidence:** same grep as P0-3.
- **Fix sketch:** after balance sheet: cash flow from `is_cash OR is_bank` account movements (operating/investing/financing split initially optional — a simple "cash in / cash out by month, per bank account" table + chart answers the owner's monthly question). Data hooks already exist: every payment carries `payment_method` mapped to its own GL account (verified live: cash→1001, card→1021, bkash→1022, bank_transfer→1026, islami→1028, pubali→1027 — only unused `other` is unmapped).

### P1 — workaround exists / integrity risk

#### P1-1 · Five UIs maintain `accounts.balance` with non-atomic frontend math
- **Evidence (all render-proven):**
  - `accounting/journal/page.tsx` create/edit/delete: JS-computed sign deltas applied via `increment_account_balance` in sequential awaits, no transaction (:1088-1124, :1500-1543, :1843-1855).
  - `expenses/page.tsx`: raw read-modify-write `accounts.update({balance})`, and the **edit path reverses using stale in-memory balances** (:448-450) while the create path fetches fresh (:472-478) — a race loses concurrent updates; delete reverses balances then deletes JE (:143-159) with no rollback if a step fails.
  - `accounting/accounts/page.tsx` opening balance: sign convention for the 3900 offset **inverted vs `post_journal_entry`** (:350-357), and a fallback that writes `balance` directly with **no JE at all** when 3900 is missing (:358-364) — a Dr=Cr break.
  - `accounting/accounts/[id]/page.tsx` adjustment panel: offset equity delta uses raw Dr−Cr instead of the credit-normal flip (:1051-1054).
  - `accounting/page.tsx` dashboard modals: JE + lines + two balance RPCs as separate awaits (:866-884, :989-1009, :1241-1305).
- **Live status:** `get_account_balance_drift()` = 0 rows — no current damage. This is a loaded gun, not a firing one (the same class caused the ৳544,356 edit-invoice corruption fixed 2026-09-03).
- **Fix sketch:** one `post_manual_journal_entry(p_entry jsonb)` SECURITY DEFINER RPC that writes entry + lines + balances in a single transaction (reusing `post_journal_entry`'s sign logic), then replace all five call sites. Routing: [[denormalized-balance-drift]], [[frontend-flow-to-atomic-rpc]], [[unreliable-db-trigger-fix]].

#### P1-2 · Revenue basis differs across the three P&L renderings
- **Evidence:** hub P&L tab = invoices `total_amount` excluding cancelled but **including drafts** (`reports/page.tsx:67`); `/reports/pl` = invoices excluding cancelled+draft + GL service revenue (`pl/page.tsx:77, 114-119`); accounting dashboard = **GL revenue accounts only** (`accounting/page.tsx:315-316`) — which excludes 4001 because it's typed equity (৳836,883 invisible), while the dashboard's own monthly chart *does* include 4001 (`accounting/page.tsx:373`). Three different "revenue" numbers for the same period.
- **Fix sketch:** pick one basis (GL revenue accounts, after retyping 4001) and derive all three from it; or keep invoice-basis everywhere and exclude drafts everywhere. Routing: [[report-total-discrepancy-triage]].

#### P1-3 · P&L hides credit-balance accounts instead of netting them
- **Evidence:** `/reports/pl` keeps an expense account only `if (netDebit > 0)` (`pl/page.tsx:132-137`); hub does `Math.max(0, netDebit)` per account (`reports/page.tsx:113-121`); dashboard same (`accounting/page.tsx:318-330`). Account 5900 Inventory Adjustment holds a **−৳7,268,841.85 net credit** (100% from `stock_adjustment` JEs — stock reduction flows credit it), so the P&L's OPEX simply doesn't see it; a credit that should *reduce* net expenses vanishes instead of netting. (Cousin of the direction-blind `journal_c` metric found in the COGS audit.)
- **Fix sketch:** net per-account (allow negatives, display as contra), and separately investigate whether the 5900 postings from `create_stock_reduction` are even directionally right — a permanent ৳7.27M credit in an expense account is not a normal steady state. Routing: [[gl-vs-fifo-reconciliation]].

#### P1-4 · P&L cannot show any prior period
- **Evidence:** only This Month / This Quarter / This Year (`pl/page.tsx:250-254`); no last-month/last-year/custom — while the accounting dashboard *has* those presets (`accounting/page.tsx:44, 477-485`). For an annual-close business, "This Year" is also calendar-year, not a June-30 fiscal year.
- **Fix sketch:** add the dashboard's preset set + custom range to `/reports/pl`; later add a fiscal-year-end setting.

#### P1-5 · AR/AP aging: no as-of date, no CSV, two AP bases, no GL-based AR
- **Evidence:** `aging/page.tsx` hardcodes `today` (:81, :138); AP aging invents a 30-day term from `order_date` (:146) on a PO/`amount_paid` basis while the GL-based `get_payables_aging` RPC (`20260904160000_supplier_gap_fixes.sql:13-68`) is used only by the dashboard — two AP agings that can disagree; no `receivables_aging` RPC exists anywhere (grep); invoice/PO numbers are plain text, no drill-through (:368, :452); no CSV export.
- **Fix sketch:** add `get_receivables_aging` (mirror the AP RPC off 1100+1300), switch the page to both RPCs, add as-of date + CSV + drill links. Routing: [[supabase-rpc-timeout-set-based]] (set-based, time it).

#### P1-6 · Bank reconciliation — missing (owner wants monthly)
- **Evidence:** no `bank_statement`/matching anything (grep); payments carry `reference_number` + `payment_method`→account mapping (the data hooks), but nothing matches a statement against them.
- **Fix sketch (start small):** per-bank-account month view listing all cash-account journal movements with a `reconciled` flag + running statement-balance input; statement import/matching later. Natural follow-up to P0-4.

#### P1-7 · COGS audit: `fix_action = CREATE_JE` (missing COGS) has no UI
- **Evidence:** the Action column renders badges NONE/DELETE_DUPLICATES/REVIEW_MANUALLY/CREATE_JE/DELETE_ALL_COGS (`cogs-audit/page.tsx:1186-1199`) but no button implements CREATE_JE, DELETE_ALL_COGS, or REVIEW_MANUALLY; MISSING rows are expandable and checkbox-selectable yet have zero COGS JEs so the bulk-delete path does nothing for them. Also: invoice numbers are non-clickable plain text (:1141), no print, `p_username` hardcoded 'admin' (:384, :411, :470).
- **Fix sketch:** wire "Create missing COGS JE" to `repair_invoice_cogs_to_items` (already exists for MISMATCH); make stat cards switch tabs; link rows to `/sales?highlight=`.

#### P1-8 · Journal page filter/void gaps
- **Evidence:** date filter = 4 presets only, no custom range (:549-563); no customer filter (supplier only, :584-591); search doesn't match party names (:394-399); no void/reverse action (edit+delete only); deleting an auto-posted entry requires no reason (:1959-1966) while cogs-audit deletions do.
- **Fix sketch:** add custom range + customer filter + optional reason capture on auto-entry delete.

#### P1-9 · Journal guide documents superseded flows as current
- **Evidence:** GRN "save handler calls post_grn_journal after batches" — actually atomic `receive_grn` RPC now (`journal-guide/page.tsx:313` vs `purchases/grn/page.tsx:442`); sales returns "handled by triggers" — actually `record_sales_return` RPC (:280 vs `sales/returns/page.tsx:514`); COGS described as qty × cost_price — actually FIFO/FEFO batch consumption (:108-121); "stock always deducted from default warehouse" — actually multi-warehouse (:141, :152, :270).
- **Fix sketch:** update the four scenarios; cheaper than letting the guide teach wrong mental models.

#### P1-10 · Dashboard "Total Assets / Total Liabilities" cards show period movement, not balances
- **Evidence:** both cards sum `period_net_debit` movements of asset/liability accounts for the selected period (`accounting/page.tsx:299-313`) — labeled "Total Assets," for This Month it shows the month's *change* in assets. Misleading at a glance; silently meaningful only on All Time.
- **Fix sketch:** compute balances (all-time net) as of period end — comes free with the balance-sheet RPC (P0-3).

### P2 — friction / polish

- **P2-1 · Reports hub contaminated slices:** "Revenue by Category" and "Top Selling Products" include cancelled-invoice items (no status filter, `reports/page.tsx:71, 227-233`) while the revenue stat excludes them (:67); "Top Customers" shows all-time `total_purchases` regardless of the selected period (:72, :153-157); monthly trend chart is hard-wired to the current calendar year (:199-201). Routing: [[filter-scope-total-mismatch]].
- **P2-2 · Activity report page-scoped logic:** search only filters the loaded 20 rows (:153-161); action dropdown built from the loaded page (:98-102); "Today" stat computed from the loaded page (:165-175); "This Week/Month" are rolling 7/30 days (:127-131); no export; UTC/local boundary quirk (:119-126). Routing: [[pagination-search-bug]].
- **P2-3 · Edit history `.limit(500)`** silent cap with no count/pagination (`edit-history/page.tsx:44`); change-type filter offers 2 of 5 DB values (:149-150 vs migration `20260710103054:12`); CSV truncates snapshot to 200 chars (:69-70).
- **P2-4 · Account statement gaps:** no export/print anywhere in 1188 lines; no per-row running balance (chart only); dead "View receivable" link → generic `/accounting` (`accounts/[id]/page.tsx:742-744`); header shows denormalized Current Balance alongside journal-derived Closing Balance with no tie-out warning.
- **P2-5 · Chart of accounts structure:** parent/child unreachable (no picker UI; flat list) — `accounts/page.tsx:265/:288` vs render :386-504; system accounts unprotected (frontend renders edit/deactivate for every row :212-235; RLS `acc_update`/`acc_delete` allow all authenticated; no `is_system` column).
- **P2-6 · Payment-method delete/deactivate silently re-routes:** removing/deactivating a method (or editing its code) makes `payment_accounting_trigger` fall back to Cash 1001 with no usage warning in the UI (`payment-methods/page.tsx:224-240` vs `20260906110000:74-79, 133-138`). Show payment counts before delete; block code edits when payments exist.
- **P2-7 · Expenses page cross-contamination:** shows *every* `reference_type='manual'` JE (`.limit(500)`, :83-86), which includes journal-page custom entries (owner withdrawal, bank deposit…), so the "Total Expenses" stat and category cards overstate; editing any multi-line manual JE from here flattens it to 2 lines (:455-469); inline new-category code `6${Date.now().slice(-3)}` collision-prone (:425).
- **P2-8 · Journal "draft" dead-end:** a draft badge renders (:850-852) but entries are always created posted (:1097) and no UI posts/unposts. Either remove the badge or add the state machine.
- **P2-9 · Accounting dashboard default load:** All Time default fetches all 2,993 entries + 7,550 lines in 30 sequential batches for the before/after balances feature (`accounting/page.tsx:130-161`) — seconds of load; move that computation into one set-based RPC or default the period to This Month.
- **P2-10 · Year-end close has no support:** no closing entries, no retained-earnings roll-forward, no fiscal-year setting. With annual-close-only practice this is tolerable today; becomes real at the first year-end (P1-4 blocks pulling the prior-year P&L for it).
- **P2-11 · COGS audit polish:** no print button; raw enum labels leak (`REVIEW_MANUALLY`, `DOUBLE_TRIGGER` — :1195, :1197-1199); per-row repair success log disappears when the run ends (log only rendered while `fixing`, :835 vs :422).

---

## 4. Verification (audit of the audit)

- **Page inventory complete:** `find app -name page.tsx` → 51 routes; the 14 in-scope surfaces all appear in the matrix and all are Sidebar-linked. No in-scope orphan pages (the suspected `/expenses` orphan resolved: it operates on `journal_entries`, no `expenses` table exists by design).
- **Absence claims are render-proven, not grep-only:** reports hub, P&L, accounting dashboard, and expenses read in full by the auditor; journal, cogs-audit, accounts ×2, aging, trial-balance, payment-methods, inventory/activity/edit-history reports, and journal-guide read in full by three read-only explorer agents, each returning line-level citations. VAT/balance-sheet/cash-flow/AR-aging-RPC absences additionally proven by repo-wide greps returning nothing.
- **Live-record walks (SQL):** all 12 live `payment_method × payment_type` combinations traced — every method code in use maps to its own GL account (only unused `other` falls back to 1001); received+invoice and made+purchase_order post via the hardened trigger (idempotency guard verified, `20260906110000:47-52`); receivable/payable payments post via the dashboard modals' manual JEs — **no double-posting** (trigger falls through for other reference types), but those modal JEs carry `reference_type:'payment'` with **no `reference_id`**, so they're unlinked from their payment rows (`accounting/page.tsx:1260-1268`).
- **Ledger health probes:** `get_account_balance_drift()` → 0 rows; `get_trial_balance` Dr=Cr ৳27,567,846 (2026-09-06 audit); VAT 2100 → 0 journal lines; `tax_amount` → 0 across invoices/POs/quotations; 5900 net credit −৳7,268,841.85 (100% `stock_adjustment`); 4001 net credit ৳836,883 typed `equity`.
- **Status sweep:** no business `pg_enum` types exist (Supabase internals only); CHECK-constraint statuses enumerated for all in-scope tables; invoice statuses reconciled in the prior journal audit; 0 draft invoices.

---

## 5. Suggested fix order (not part of this audit's scope)

1. **P1-1** (atomic manual-JE RPC) first — every later posting change builds on it.
2. **P0-1 + P0-2** (VAT + WHT posting) in one migration — they touch the same triggers.
3. **P0-3 balance sheet** after retyping 4001 and resolving 5900 — cheap once posting is right.
4. **P0-4 cash flow + P1-6 bank reco** together — same cash-account movement query.
5. Then P1-2/3/4 (one P&L basis, netting, prior periods) and the P2 batch.

*This audit reports; it does not fix. Fixes belong to follow-up sessions.*
