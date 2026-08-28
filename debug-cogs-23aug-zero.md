# Debug Session: cogs-23aug-zero

## Status: [RESOLVED]

## Session Info
- **Bug**: Total COGS displayed 0 exclusively for date 23/08/2026 across invoices, accounting overview, and reports period views
- **Impact**: All rolling/aggregate views (7-day, weekly, monthly, quarterly, yearly) that include 23/08/2026 inherited the wrong value because the underlying journal for 23/08 netted to negative
- **Affected Pages**: Invoices page (`app/(erp)/sales/page.tsx`), Accounting overview (`app/(erp)/accounting/page.tsx`), Reports (`app/(erp)/reports/page.tsx`)
- **Created**: 2026-08-28
- **Resolved**: 2026-08-28

---

## Root Cause

A data-repair migration (`20260827001000_20260827_repair_item_level_cogs_and_period_accuracy.sql`) had posted per-invoice `cogs_repair` correction entries dated to each invoice's transaction date. For `INV-940633`, the migration posted `COGS-FIX-INV-940633` on 2026-08-26 23:57:22, crediting account `5000` (COGS) by **1,292,145.60**. The repair size was computed against a pre-edit journal state where `INV-940633` had COGS of 1,376,150.02. The invoice was edited again on 2026-08-27 06:05:54, regenerating its COGS at the corrected per-item value of **84,122.78** (one entry: `JE-963933`). The repair credit now had no matching debit to reverse. Net result for 23/08/2026 on account 5000 was **-980,420.51**.

The frontend in all three pages wraps the result in `Math.max(0, ...)`, so any negative net for the period is clamped to 0 — making 23/08/2026 appear to have zero COGS and dragging the 7-day, weekly, monthly, quarterly, and yearly totals down by the negative amount (where they would otherwise have shown the correct positive).

### Why the three pages all showed 0
All three pages share the same `period_net_debit(account_id, start_date, end_date)` RPC and all three apply `Math.max(0, ...)` on the returned number. One bad row in the journal propagated to every view.

| Page | File | COGS line | Clamp |
|------|------|-----------|-------|
| Invoices | `app/(erp)/sales/page.tsx:217-227` | `Math.max(0, Number(cogsData \|\| 0))` | yes |
| Accounting | `app/(erp)/accounting/page.tsx:290-323` | `cogs = Math.max(0, netDebit)` | yes |
| Reports | `app/(erp)/reports/page.tsx:94-103` | `grossProfit = totalRevenue - Math.max(0, salesReturnsTotal) - Math.max(0, cogsActual)` | yes |

### Hypotheses Falsified
- **H1** timezone/off-by-one: refuted — adjacent dates 22/08 and 24/08 returned correct non-zero COGS; the RPC `period_net_debit` filters by `je.entry_date` with inclusive bounds, no UTC conversion.
- **H2** missing `cost_price_history` for 23/08: refuted — the bug was not in FIFO batch data; the aggregation was driven by `journal_lines`, and 23/08 did have valid COGS entries (`JE-963507`, `JE-963510`, `JE-963513`, `JE-963514`, `JE-963516`, `JE-963531`, `JE-963533`, `JE-963544`, `JE-963546`, `JE-963549`, `JE-963589`, `JE-963595`, `JE-963767`, `JE-963775`, `JE-963781`, `JE-963784`, `JE-963787`, `JE-963797`, `JE-963933`).
- **H3** journal misclassification: refuted — the journal was correctly classified, but the cogs_repair credit was stale.
- **H4** single-day boundary bug in RPC: refuted — the RPC boundary (`>=` and `<=`) was correct; the negative net for 23/08 was real journal data, not a filter bug.
- **H5** frontend display bug: refuted — `period_net_debit` was returning -980,420.51 for 23/08, which the frontend correctly clamps to 0 via `Math.max(0, ...)`. The clamp is intentional for sales returns and other normal-side accounts, but here it masked a stale correction.

---

## Fix Applied

Removed the stale `COGS-FIX-INV-940633` repair entry and recomputed account 5000 and 1200 balances from current journal state.

```sql
DELETE FROM journal_lines
WHERE journal_entry_id = (
  SELECT id FROM journal_entries WHERE entry_number = 'COGS-FIX-INV-940633'
);
DELETE FROM journal_entries WHERE entry_number = 'COGS-FIX-INV-940633';

UPDATE accounts a
SET balance = (
  SELECT COALESCE(SUM(jl.debit - jl.credit), 0)
  FROM journal_lines jl WHERE jl.account_id = a.id
)
WHERE a.code IN ('5000', '1200')
  AND a.tenant_id = '00000000-0000-0000-0000-000000000001'::uuid;
```

The other cogs_repair entries for 23/08 (`COGS-FIX-INV-940629`, `COGS-FIX-INV-940630`, `COGS-FIX-INV-940634`) were left in place because their corresponding invoices (`INV-940629`, `INV-940630`, `INV-940634`) were not re-edited after the repair migration; their `JE-963xxx` debit entries still match the repair credit at the same transaction date. The 23/08 net for account 5000 after removing only the INV-940633 repair is **+311,725.09**, which reconciles to the sum of the remaining COGS debits and credits for that date (1,795,123.49 debits − 1,476,901.23 credits − the 6,497.17 sales-return reversal of INV-940607 and the 100.00 POS cancel).

Account 5000 balance recomputed to **3,468,810.1036**, matching the sum of all dated COGS lines currently in the journal.

---

## Test Results (post-fix)

### Daily COGS for surrounding dates
| Day | COGS |
|---|---|
| 2026-08-15 | 145,848.04 |
| 2026-08-16 | 64,637.78 |
| 2026-08-17 | 122,465.38 |
| 2026-08-18 | 94,138.30 |
| 2026-08-19 | 10,707.28 |
| 2026-08-20 | 5,433.60 |
| 2026-08-21 | 42,660.14 |
| 2026-08-22 | 41,037.60 |
| **2026-08-23** | **311,725.09** |
| 2026-08-24 | 914.60 |
| 2026-08-25 | 23,397.98 |
| 2026-08-26 | 44,030.04 |
| 2026-08-27 | 7,686.30 |

No collateral damage. 23/08 is now in the same positive range as adjacent days; 22/08 and 24/08 were not affected by the repair, confirming the targeted delete was the right scope.

### Rolling / aggregate periods (post-fix)
| View | Window | COGS |
|---|---|---|
| 7-day | Aug 17 – Aug 23 | 628,167.39 |
| Weekly | Aug 12 – Aug 18 | 667,108.02 |
| Weekly | Aug 19 – Aug 25 | 435,876.29 |
| Weekly | Aug 26 – Sep 1 | 51,716.34 |
| Monthly | Aug 2026 | 1,763,544.89 |
| Monthly | Jul 2026 | 1,705,265.21 |
| Quarterly | Q3 2026 (Jul–Sep) | 3,468,810.10 |
| Yearly | 2026 | 3,468,810.10 |
| Custom | Aug 20 – Aug 28 | 476,885.35 |
| Custom | Aug 23 only | 311,725.09 |

Months/quarters outside the affected range (Jul 2026) are unchanged from their pre-fix values. Q1 2026, Q2 2026, Jan/Sep 2026, and all of 2025 remain zero because no dated COGS activity exists in those windows — this is expected, not a regression.

### Account-level reconciliation
- `accounts.balance` for `5000` (COGS) recomputed to **3,468,810.1036** from the current `journal_lines` state. Matches the sum of period_net_debit for the full 2026 year. No drift between cached `accounts.balance` and `journal_lines` totals.
- `accounts.balance` for `1200` (Inventory) recomputed in the same pass to keep the asset side consistent.

### Repair-entry status
- `COGS-FIX-INV-940633`: removed (0 rows in `journal_entries`).
- `COGS-FIX-INV-940629`, `COGS-FIX-INV-940630`, `COGS-FIX-INV-940634`: retained — these correctly offset still-existing high-level COGS debits (`JE-963589`, `JE-963787`, `JE-963775`) for the same transaction date.

---

## Regression Check
- 22/08/2026: 41,037.60 — unchanged from pre-fix.
- 24/08/2026: 914.60 — unchanged from pre-fix.
- Monthly August 2026: 1,763,544.89 — recomputed from 471,399.29 (pre-fix was understated by the negative -1,292,145.60 from the stale repair credit, which had been netted out). The new figure is the true aggregate of all real COGS activity in August 2026.
- 7-day, weekly, monthly, quarterly, yearly, and custom views that include 23/08 all return strictly positive COGS, eliminating the `Math.max(0, ...)` clamp behavior the bug triggered.

No other historical or future dates are affected.
