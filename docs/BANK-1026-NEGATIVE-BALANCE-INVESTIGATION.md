# Investigation: Account 1026 — Al-Arafah Islami Bank shows ৳-7,96,504.38

**Date:** 2026-10-31
**Account:** `1026` / Al-arafah islami bank / `45d731e2-7132-44e3-82db-ca198fa8c587`
**Environment:** Production Supabase project `vkvurkuzahclerqnsqbz`
**Status:** Root cause identified. No data was modified.

---

## 1. Executive summary

The negative figure is **not a display or caching defect**. The `accounts.balance` value
reconciles to the general ledger to the paisa, and the ledger itself is net credit.

| Metric | Amount (BDT) |
|---|---|
| Total debits (money in) | 564,758.94 |
| Total credits (money out) | 1,361,263.32 |
| **Net balance** | **-796,504.38** |
| Journal lines | 69 (22 debit, 47 credit) |
| Period covered | 2026-07-18 → 2026-10-18 |
| First date the running balance went negative | **2026-10-11** |

The balance is negative because of four compounding causes, in order of materiality:

1. **No opening balance was ever posted** for this bank account (primary cause).
2. **All generic bank transfers are hard-wired to account 1026** — the payment layer has
   no per-payment bank selection, so every "Bank Transfer" lands here regardless of the
   bank actually used.
3. **No cash-to-bank deposits are recorded** anywhere in the system, so money collected
   in cash never reaches the bank ledger.
4. **Duplicate / excess supplier payments** charged ~৳73,112.98 to this account.

---

## 2. Verification that the number is real

The `accounts.balance` column is maintained incrementally by `post_journal_entry()`:

```sql
SET balance = CASE
  WHEN account_type IN ('asset','expense') THEN balance + v_debit - v_credit
  WHEN account_type IN ('liability','equity','revenue') THEN balance + v_credit - v_debit
  ...
```

Every cash and bank account reconciles exactly:

| Code | Account | Cached balance | Ledger net | Difference |
|---|---|---|---|---|
| 1001 | Cash in Hand | 2,814,063.71 | 2,814,063.71 | 0.00 |
| 1020 | City Bank | 40,100.00 | 40,100.00 | 0.00 |
| 1021 | Card Payments | 19,670.00 | 19,670.00 | 0.00 |
| 1022 | bKash | 42,800.00 | 42,800.00 | 0.00 |
| **1026** | **Al-Arafah Islami Bank** | **-796,504.38** | **-796,504.38** | **0.00** |
| 1027 | Pubali Bank | 90,404.42 | 90,404.42 | 0.00 |
| 1028 | Islami Bank | 103,700.00 | 103,700.00 | 0.00 |

Conclusion: the ledger is internally consistent. The problem is *what was posted*, not
*how it was totalled*.

---

## 3. Monthly movement

| Month | Lines | Debits (in) | Credits (out) | Net | Running |
|---|---|---|---|---|---|
| 2026-07 | 3 | 31,191.00 | 0.00 | +31,191.00 | 31,191.00 |
| 2026-08 | 17 | 377,404.61 | 872.00 | +376,532.61 | 407,723.61 |
| 2026-09 | 23 | 156,163.33 | 105,801.97 | +50,361.36 | 458,084.97 |
| **2026-10** | **26** | **0.00** | **1,254,589.35** | **-1,254,589.35** | **-796,504.38** |

October is the anomaly: **26 payments out, zero receipts in**. The account crossed into
negative on **2026-10-11**, driven by two entries on that date:

- `JE-968240` — ৳387,100.00 — PO-000176
- `JE-968242` — ৳167,798.68 — PO-000177

---

## 4. Root causes

### 4.1 No opening balance (primary)

`reference_type = 'opening_balance'` and `'cutover_adjustment'` entries exist, but none
touch account 1026. The only opening balances posted were:

| Entry | Date | Account | Amount |
|---|---|---|---|
| OPENING-INV-1200 | 2026-06-01 | 1200 Inventory Asset | 19,239,266.48 |
| JE-964716 | 2026-08-08 | 1200 Inventory Asset | 7,890,782.43 |
| JE-959872 | 2026-07-24 | 1020 City Bank | 100.00 |

The account was created on 2026-07-18 with a zero balance and immediately began
recording outflows. Any account that only pays out will go negative; 1026 was never
seeded with the real bank balance as at go-live.

**Implication:** the ledger asserts the bank started at ৳0. For the ending balance to be
non-negative, a minimum opening debit of **৳796,504.38** is implied (more if the
unposted items in §5 are also corrected).

### 4.2 Single-account funnel for all bank transfers (structural)

The live `payment_accounting_trigger()` resolves the money account from the
**payment method**, not from the payment row:

```sql
SELECT pm.account_id INTO v_payment_account
  FROM payment_methods pm
 WHERE pm.code = NEW.payment_method AND pm.is_active = true
 LIMIT 1;
```

The mapping is:

| payment_methods.code | Account | Account name |
|---|---|---|
| `bank_transfer` | **1026** | **Al-arafah islami bank** |
| `islami_bank_transfer` | 1028 | Islami Bank Transfer |
| `pubali_bank_transfer` | 1027 | Pubali Bank Transfer |
| `standard_bank_transfer` | 1025 | standard bank |
| `cash` | 1001 | Cash in Hand |

Consequences:

- `payments.bank_account` exists but is **NULL on all 2,006 payment rows** and is never
  read by the trigger. There is no way to record *which* bank a transfer used.
- `components/PaySupplierModal.tsx:55` defaults the method to `'bank_transfer'`, and the
  dropdown offers no bank-account field — only the method name.
- `app/(erp)/purchases/page.tsx:930` and `:1301` do the same on the PO "full payment"
  path, inserting directly into `payments` with `form.payment_method`.

Result: **100% of generic bank-transfer activity is attributed to Al-Arafah**, while
receipts are split across Pubali, Islami Bank, cheque and cash.

October evidence:

| Direction | Method | Count | Amount |
|---|---|---|---|
| Out | `bank_transfer` (→1026) | 26 | 1,254,589.35 |
| In | `cash` | 308 | 3,481,574.60 |
| In | `cheque` | 5 | 390,590.92 |
| In | `islami_bank_transfer` (→1028) | 1 | 103,700.00 |
| In | `pubali_bank_transfer` (→1027) | 6 | 67,682.44 |
| In | `bkash` | 1 | 1,580.00 |

Money came in through every channel *except* 1026, and went out through 1026 only.

### 4.3 No cash-to-bank deposits recorded

There is no `bank_transfers` / `deposits` table. The Transfers screen
(`app/(erp)/accounting/transfers/page.tsx`) writes manual journal entries, and **no such
entry exists for 1026** — its lines are exclusively `reference_type IN ('payment',
'invoice_cancel')`.

Meanwhile Cash in Hand carries **৳2,814,063.71**. The operational pattern is consistent:
cash is collected, suppliers are paid by bank transfer, and the cash-to-bank funding step
is never journalised.

### 4.4 Duplicate and excess supplier payments

Allocating each payment against its PO balance in posting order:

| Method | Lines with excess | Excess amount |
|---|---|---|
| cash | 4 | 242,040.00 |
| **bank_transfer (→1026)** | **4** | **73,112.98** |

Confirmed duplicate examples:

| PO | PO total | Payments | Issue |
|---|---|---|---|
| PO-000133 | 30,639 | 30,639 cash + **30,639 bank_transfer**, same day (2026-10-01) | Full duplicate; the bank leg hit 1026 |
| PO-000170 | 566,479 | 752,941 cash + **35,739 bank_transfer**, same day (2026-10-07) | Cash leg alone overpays; bank leg is entirely excess |
| PO-000194 | 325,564.04 | **332,298.96 bank_transfer** | Overpaid by 6,734.92 |
| PO-000014 | 5,865 | 5,865 cash ×2, same day | Exact duplicate (cash) |
| PO-000084 | 3,241 | 47,194 cash | 14.6× the PO value |
| PO-000086 | 640 | 6,400 cash | 10× the PO value |

Three groups are exact same-PO / same-date / same-amount duplicates totalling ৳36,504.06.

---

## 5. Secondary findings (not the cause, but they distort the ledger)

1. **Bank-transfer refunds were never journalised.** Six `payments` rows with
   `payment_type='refund'` and `payment_method='bank_transfer'` totalling **৳118,036**
   have no `journal_entries` row at all (e.g. `REV-PAY-996712`, ৳54,000, 2026-07-16).
   `payment_accounting_trigger()` only handles `received`+`invoice` and
   `made`+`purchase_order`; `refund` falls through to `RETURN NEW`. If corrected, 1026
   would be **more** negative, not less.

2. **Test-value entries.** `PAY-997127` and `PAY-997100` post ৳2 each
   (`JE-963508`, `JE-963463`), and several ৳1 rows exist on 2026-08-22. Small in value,
   but they indicate test data in the production ledger.

3. **Possible duplicate receipt.** `PAY-997164` (৳100,000, 2026-08-27) and
   `PAY-997170` (৳100,000, 2026-08-28) both reference `INV-940540`. If duplicated, this
   overstates 1026 by ৳100,000 and should be checked against the bank statement.

4. **`payments.bank_account` is dead schema.** The column exists, is exposed in the UI
   contract, and is never populated or consumed. This is the design gap that produced
   cause 4.2.

---

## 6. Recommended remediation

Ordered by priority. **Nothing below has been executed.**

### Step 1 — Establish the true bank balance (accounting decision, not code)

Obtain the Al-Arafah statement as at 2026-07-18 (go-live) and as at today. The difference
between the statement and the ledger is the opening balance plus unrecorded items.
Without this, any correcting entry is guesswork.

### Step 2 — Post the opening balance

Draft only — requires approval and the figure from Step 1:

```sql
-- DO NOT RUN WITHOUT APPROVAL
-- Debit 1026, Credit 3900 Opening Balance Equity
SELECT post_journal_entry(
  'Opening balance — Al-Arafah Islami Bank A/C 1821220001222 as at 2026-07-18',
  '2026-07-18', 'opening_balance', NULL,
  json_build_array(
    json_build_object('account_id','45d731e2-7132-44e3-82db-ca198fa8c587',
                      'debit', <statement_balance>, 'credit', 0,
                      'description','Opening balance per bank statement'),
    json_build_object('account_id','<3900-uuid>',
                      'debit', 0, 'credit', <statement_balance>,
                      'description','Opening balance equity')
  )::json, NULL
);
```

### Step 3 — Record the cash-to-bank deposits

Use Accounting → Transfers → **Deposit** (Cash → Bank) for each historical deposit.
This is a balance-sheet reclassification only; it does not change profit.

### Step 4 — Reverse the duplicate payments

Four bank-transfer lines totalling ৳73,112.98 exceed their PO balance. Each needs a
reversing payment or a manual journal (Dr Accounts Payable / Cr 1026), with the supplier
ledger adjusted accordingly. Start with PO-000133 (৳30,639) — an unambiguous same-day
duplicate.

### Step 5 — Fix the structural defect (code)

Three changes are required, in this order:

1. **Add a bank-account selector to the payment UI.** `PaySupplierModal.tsx` and the PO
   payment block in `purchases/page.tsx` must let the user pick the actual cash/bank
   account, and write it to `payments.bank_account` (or a new `account_id` column).
2. **Make the trigger honour it.** In `payment_accounting_trigger()`, prefer an explicit
   account on the payment row over the `payment_methods` lookup:
   `v_cash_account := COALESCE(NEW.account_id, pm.account_id, <1001 fallback>)`.
3. **Stop defaulting to `bank_transfer`.** Default to no selection and require an
   explicit choice, so a bank is never assumed.

Also add `refund` handling to the trigger (finding 5.1) and a guard that rejects a
payment whose amount exceeds the referenced PO's remaining balance (finding 4.4).

### Step 6 — Verify

Re-run the reconciliation query in §2 and confirm every cash/bank account still matches
its ledger net, then tie each account to its bank statement.

---

## 7. Reproduction queries

```sql
-- Balance vs ledger for all cash/bank accounts
SELECT a.code, a.name, a.balance AS cached,
       COALESCE(SUM(jl.debit - jl.credit), 0) AS ledger_net,
       a.balance - COALESCE(SUM(jl.debit - jl.credit), 0) AS diff
FROM accounts a
LEFT JOIN journal_lines jl ON jl.account_id = a.id
WHERE a.is_bank OR a.is_cash
GROUP BY 1,2,3 ORDER BY 1;

-- Monthly movement for 1026
SELECT to_char(je.entry_date,'YYYY-MM') AS month,
       COUNT(*) AS lines, SUM(jl.debit) AS debit, SUM(jl.credit) AS credit,
       SUM(jl.debit) - SUM(jl.credit) AS net
FROM journal_lines jl
JOIN journal_entries je ON je.id = jl.journal_entry_id
WHERE jl.account_id = '45d731e2-7132-44e3-82db-ca198fa8c587'
GROUP BY 1 ORDER BY 1;

-- Payment-method → account mapping (the funnel)
SELECT pm.code, pm.name, a.code AS account_code, a.name AS account_name
FROM payment_methods pm LEFT JOIN accounts a ON a.id = pm.account_id
ORDER BY pm.code;
```

---

## 8. Phase 1 implemented — payment account routing (2026-10-31)

Scope: stop new money from being misrouted. No historical data was altered.

### Database (applied)

| Migration | Change |
|---|---|
| `20261031040000_payment_bank_account_routing.sql` | Adds `payments.account_id` (FK, nullable, indexed); adds `resolve_payment_account()`; rewrites `payment_accounting_trigger()` to prefer the explicit account; adds `p_account_id` to `pay_supplier_outstanding()`; carries `account_id` in `sync_po_payment()` |
| `20261031041000_payment_routing_offline_po_create.sql` | `sync_po_create()` persists the chosen account for offline PO payments |

Resolution order is now: **explicit `payments.account_id` → `payment_methods.account_id` → 1001 Cash in Hand.**
Existing rows keep `account_id = NULL`, so history still resolves through the method mapping — nothing was rewritten.

The old 6-argument `pay_supplier_outstanding` overload was dropped; adding a parameter would otherwise have created an ambiguous overload.

### Application

| File | Change |
|---|---|
| `components/ui/account-select.tsx` | New reusable cash/bank picker; shows code, name and live balance, and flags an overdrawn account in red |
| `components/PaySupplierModal.tsx` | Account selector; method no longer defaults to `bank_transfer`; passes `p_account_id` |
| `app/(erp)/purchases/page.tsx` | Account selector on PO creation and on the record-payment modal; `bank_transfer` defaults removed; `account_id` sent online and offline |
| `app/(erp)/suppliers/[id]/page.tsx` | Account selector replaces the method-derived account lookup |
| `lib/types.ts` | `Payment.account_id` added; `bank_account` marked deprecated |

### Verification performed

- `tsc --noEmit` — clean.
- ESLint on all changed files — no errors (only pre-existing warnings).
- Rolled-back DB test: a payment with `account_id = 1027` and method `bank_transfer` credited **1027**; the same insert without `account_id` still credited **1026**. Both rolled back.
- Rolled-back RPC test: `pay_supplier_outstanding(..., p_account_id := 1028)` was rejected because 1028 is inactive; with 1027 it posted to **1027** and set `payments.account_id`. Rolled back.
- `next build` could not complete: the sandbox blocks Next's recursive deletion of `.next` (safe-delete guard, 50-file threshold). This is an environment limitation, not a compile error.

### Findings surfaced during implementation

- **Account 1028 (Islami Bank Transfer) is `is_active = false` but holds ৳103,700.** It will not appear in the new picker and cannot receive new payments. Either reactivate it or transfer the balance out.
- `payments.bank_account` is now formally deprecated; `account_id` is the field of record.

### Still open

1. ~~Phase 2 — balance guard~~ — completed, see §9.
2. Phase 3 — opening balance, cash-to-bank deposits, duplicate reversals.
3. Phase 4 — `refund` branch in the trigger; PO overpayment guard.
4. Customer receipts (`CollectPaymentModal`, POS) still resolve through the method mapping; `collect_customer_payment()` needs a `p_account_id` parameter.

---

## 9. Phase 2 implemented — funds guard (2026-10-31)

Scope: stop any payment surface from spending money an account does not have. No historical data was altered.

### The policy, and why it is asymmetric

The guard is **a hard block for cash, a soft block with permissioned override for banks.** That asymmetry is deliberate:

- **Cash (1001)** can never go negative in reality — you cannot hand over notes you do not hold. So it is a hard stop, with no override offered anywhere in the UI or the API.
- **Banks** can legitimately go negative through an overdraft facility, a timing difference, or a statement the ledger has not caught up with. And today **1026 is already at ৳-7,96,504.38**, so a hard block would stop every single payment from that account and halt purchasing entirely. A soft block forces the user to look at the number and justify it, without bricking the business.

The soft block is not a rubber stamp: the override requires a free-text reason that is persisted on the payment row.

### Database (applied)

| Migration | Change |
|---|---|
| `20261031050000_payment_funds_guard.sql` | `accounts.overdraft_limit`; `payments.allow_negative` + `payments.override_reason` + check constraint; `assert_payment_funds()`; guard call in `payment_accounting_trigger()`; override params on `pay_supplier_outstanding()`; bypass in `sync_po_payment()` / `sync_po_create()` |
| `20261031051000_manual_payable_funds_guard.sql` | Guard call inside `record_manual_payable_payment()`; it now also stamps `payments.account_id` (it never did); bypass in `sync_supplier_payable_payment()` |

`assert_payment_funds(p_account_id, p_amount, p_allow_negative)`:

```sql
-- 1. transaction-local bypass for offline replay
IF coalesce(current_setting('app.payment_funds_bypass', true), 'off') = 'on' THEN RETURN; END IF;

-- 2. lock the account row so concurrent payments cannot both pass
SELECT * INTO v_account FROM accounts WHERE id = p_account_id FOR UPDATE;

-- 3. cash has an absolute zero floor, no override path
IF v_account.is_cash THEN
  IF p_amount > v_account.balance THEN
    RAISE EXCEPTION 'Insufficient cash in % ...' USING ERRCODE = 'PF001';
  END IF;
END IF;

-- 4. bank compares against balance + overdraft_limit
v_available := v_account.balance + coalesce(v_account.overdraft_limit, 0);
IF p_amount <= v_available THEN RETURN; END IF;
IF p_allow_negative THEN RETURN; END IF;
RAISE EXCEPTION 'Insufficient funds in % ...' USING ERRCODE = 'PF001';
```

Notes on the design:

- **`FOR UPDATE`** matters. Without it two simultaneous payments can each read the same balance, each decide they fit, and together overdraw the account.
- **Custom SQLSTATE `PF001`** lets the UI distinguish "not enough money" from any other database error, instead of string-matching an error message.
- **`overdraft_limit` defaults to 0**, so the default behaviour is "cannot go below zero" — a facility has to be granted explicitly per account.
- **The check constraint** `payments_override_reason_check` enforces at the storage layer that `allow_negative = true` cannot be saved without a non-empty `override_reason`. A caller that skips the UI still cannot create an unexplained override.
- **The bypass is transaction-local** (`set_config(..., true)`), not session-level, so it cannot leak into a later statement on a pooled connection.
- **`record_manual_payable_payment()` needed its own guard** because it posts journals directly and never touches `payment_accounting_trigger()` — the trigger-level guard alone would have left that surface wide open. It was also silently failing to record which account was paid from; that is now fixed.

### Application

| File | Change |
|---|---|
| `components/ui/funds-override.tsx` | New. Exports `fundsAvailable()`, `fundsShortfall()` and `FundsOverride`. Cash → red hard-stop panel with no override control. Bank → amber panel with override checkbox plus mandatory reason field. Renders nothing when the payment fits. |
| `components/ui/account-select.tsx` | Selects `overdraft_limit`; adds an `onAccountChange` callback so the caller can run the funds check without a refetch |
| `components/PaySupplierModal.tsx` | `FundsOverride` wired; `p_allow_negative` / `p_override_reason` sent to the RPC, `allow_negative` / `override_reason` sent in the offline payload |
| `app/(erp)/purchases/page.tsx` | `FundsOverride` in both `CreatePOModal` and `RecordPOPaymentModal`; override flags added to all four payload sites |
| `app/(erp)/suppliers/[id]/page.tsx` | `FundsOverride` wired; override flags passed to `record_manual_payable_payment()` |

The guard amount is **net of withholding tax** (`amount - wht`), because the WHT portion is never actually paid out — only the net leaves the bank.

### Verification performed

All tests below were run against the live database inside rolled-back transactions.

| # | Test | Result |
|---|---|---|
| 1 | Bank overdraw, no override | Blocked — `Insufficient funds in Al-arafah islami bank — -796504.38 available, 1000.00 requested.` |
| 2 | Cash overdraw | Blocked — `Insufficient cash in Cash in Hand — 2814063.71 available, 99999999.00 requested. Cash accounts cannot go negative.` |
| 3 | Bank overdraw with override + reason | Allowed |
| 4 | Override with no reason | Rejected by `payments_override_reason_check` |
| 5 | Offline replay through `sync_po_payment` → 1026 | `{"status": "synced"}` — bypass works, outbox does not deadlock |
| 6 | `pay_supplier_outstanding(..., p_allow_negative := true, p_override_reason := ...)` | Paid |

Static checks:

- `assert_payment_funds`, `pay_supplier_outstanding`, `record_manual_payable_payment` each exist exactly once — no overloads left behind.
- `payment_accounting_trigger` source contains the `assert_payment_funds` call.
- `sync_po_payment`, `sync_po_create`, `sync_supplier_payable_payment` all contain the bypass.
- `tsc --noEmit` — clean.
- ESLint on changed files — no errors.

### Behaviour staff will notice

- Payment forms no longer pre-select `bank_transfer`; the account must be chosen deliberately.
- Choosing an overdrawn bank account shows an amber warning with the exact shortfall and requires a written reason before the pay button works.
- Choosing Cash in Hand with insufficient funds is a red stop with no way past it.
- Offline payments are queued as before and are not blocked by the guard on replay — the check happened when the user was online and made the decision.

### Still open after Phase 2

1. ~~Phase 3 — reconcile and adjust~~ — completed, see §10.
2. **Phase 4 — `refund` branch in `payment_accounting_trigger()`.** Six bank refunds totalling ৳118,036 were never journalised.
3. **PO overpayment guard.** `payment_po_amount_paid_trigger` fires only on INSERT, only ever adds, and has no cap — so overpaid POs accumulate silently.
4. **Customer receipts.** `CollectPaymentModal` and POS still resolve through the method mapping; `collect_customer_payment()` needs a `p_account_id` parameter and the same guard.
5. **Account 1028** — still deactivated while holding ৳103,700.
6. **Deploy.** Phases 1 and 2 are in the database but the UI changes are not yet deployed; staff will see the old forms until they are.
7. **Consider hardening the bank guard** from soft to hard once the balances are trustworthy.

---

## 10. Phase 3 executed — reconciliation and adjustment (2026-10-31)

Full worksheet: `docs/BANK-1026-PHASE3-RECONCILIATION.md`
Execution script: `scripts/phase3_1026_reconciliation.sql`
New RPC: `20261031060000_reverse_supplier_payment.sql`

### What the ৳73,112.98 actually was

It reconciles exactly to four payments, not an estimate:

| Payment | PO | On 1026 | Nature |
|---|---|---|---|
| POPAY-000094 | PO-000133 | ৳30,639.00 | Duplicate of POPAY-000093, which paid the same amount from cash the same day |
| POPAY-000092 | PO-000144 | ৳0.06 | Duplicate of POPAY-000091 |
| POPAY-000129 | PO-000194 | ৳6,734.92 | Paid ৳6,734.92 over the PO total |
| POPAY-000102 | PO-000170 | ৳35,739.00 | PO paid ৳7,88,680 against ৳5,66,479 |

### New capability: `reverse_supplier_payment(payment_id, reason)`

Until now a payment could only be undone by cancelling the whole purchase order. The RPC locks the payment row, requires a written reason, mirrors **every** journal entry of the payment line-for-line (debit ↔ credit, so WHT-split payments stay correct by construction), sets `is_reversed`, and decrements `purchase_orders.amount_paid` — which nothing previously did, which is why PO-000133 read ৳61,278 paid against a ৳30,639 order.

### Applied

| Step | Entry | Effect |
|---|---|---|
| Reverse POPAY-000094 | JE-969291 | 1026 +৳30,639.00 |
| Reverse POPAY-000092 | JE-969292 | 1026 +৳0.06 |
| Reverse POPAY-000010 | JE-969293 | 1001 +৳5,865.00 |
| Cash → bank reclassification | JE-969294 | 1001 -৳7,23,391.40 / 1026 +৳7,23,391.40 |

| Account | Before | After |
|---|---|---|
| 1001 Cash in Hand | ৳28,14,063.71 | ৳20,96,537.31 |
| 1026 Al-arafah | ৳-7,96,504.38 | ৳-42,473.92 |

Post-commit checks: trial balance Dr = Cr = ৳17,63,15,401.55 with ৳0.00 difference; both accounts' stored balance matches their journal lines with ৳0.00 difference; all reversal entries balance; PO paid amounts now equal PO totals.

### Two things worth stating plainly

- **The reclassification is a management judgement, not a proof.** ৳7,23,391.40 was moved from cash to bank on the basis that supplier payments recorded against 1026 were actually funded from cash — consistent with ৳28.14 lakh sitting unbanked in Cash in Hand and with the hardcoded `bank_transfer → 1026` mapping. The payments themselves carry no evidence of their true source (`bank_account` is NULL on all of them). The Al-Arafah statement would turn this into a provable number.
- **The deposit mechanism was never missing.** `record_fund_transfer()` and the `/accounting/transfers` page with a Cash → Bank preset already existed. The database had **zero** entries moving money between cash and any bank since inception — the feature was simply never used.

---

## 11. Phase 4 — refund branch rejected, PO overpayment guard shipped (2026-10-31)

Migration: `20261031070000_po_overpayment_guard.sql`

### 11.1 The refund branch was **not** implemented, and should not be

§5 of this report claimed "six bank-transfer refunds (৳118,036) were never journalised — the trigger has no `refund` branch". That finding was a **false positive**, and implementing it would have made the accounts materially worse. The evidence:

`payment_accounting_trigger()` handles exactly two cases — `received`+`invoice` and `made`+`purchase_order`. Every other combination falls through to `RETURN NEW` and posts nothing. Looking only at `payments` rows with no matching journal entry, the refund rows look like unposted money movement. They are not, because **the parent operation already posted it**:

| Refund path | Who posts the cash movement | Evidence |
|---|---|---|
| Sales-return refund (`reference_type='refund'`) | `record_sales_return()` | JE-965750 for SR-883384 credits **Cash in Hand ৳490** — exactly the amount of refund row PAY-997351 |
| Invoice cancellation (`reference_type='invoice_cancel'`) | `cancel_invoice()` | JE-964953 "Reverse Payment — Cancelled POS-00589775" debits AR ৳198 / credits **Cash in Hand ৳198** |
| Invoice edit (`reference_type='invoice_edit'`) | the re-applied `EDIT-` receipt row | REV-PAY-997249 / REV-EDIT-POS-00590142 (both ৳32,016) are bookkeeping markers; the net ৳32,016 was posted once by JE-964861 on the surviving `EDIT-` row |

Of the six "unjournalised bank refunds" totalling ৳118,036: **one (REV-PAY-996712, ৳54,000) is already `is_reversed = true`**, and the other five are invoice-edit bookkeeping rows.

**Had a blanket refund branch been added, it would have posted phantom outflows on every unreversed refund row — ৳58,93,228.00 in total**, including ৳52,01,064.21 of cash refunds that `record_sales_return` and `cancel_invoice` had already correctly accounted for. The bank would have gone straight back to a large negative balance, this time with no economic event behind it.

**Conclusion: no refund branch belongs in this trigger.** Refunds are posted by the operation that causes them. The trigger's silent fall-through is the real defect, but it cannot simply be turned into an exception either — the `edit_invoice` reversal rows depend on it.

### 11.2 PO overpayment guard — shipped

The root cause was not a missing guard, it was a **bypassed** one:

- `pay_supplier_outstanding()` has guarded overpayment since it was written (`v_bal < -0.01` → raise).
- The purchases page does **not** call it. `RecordPOPaymentModal` inserts into `payments` directly, and the client-side check (`form.amount > balance`) only protects that one screen.
- Direct inserts met `payment_po_amount_paid_trigger()`, which was `AFTER INSERT`, only ever **added**, had no cap, no guard and no reversal path.

That is how PO-000170 reached ৳7,88,680 paid against ৳5,66,479, and PO-000133 read ৳61,278 against ৳30,639.

Changes:

| Change | Detail |
|---|---|
| Overpayment block | Trigger raises SQLSTATE `PF002` when `amount > outstanding + ৳1.00`, naming the PO, outstanding and requested amount |
| Cap | `amount_paid = LEAST(total_amount, amount_paid + amount)` — it can no longer drift above the PO total |
| Reversal path | Trigger now fires on `UPDATE OF is_reversed` and `DELETE`, returning the amount to the outstanding balance |
| `reverse_supplier_payment()` | Drops its own manual decrement — the trigger owns it now, otherwise it would decrement twice |
| Override | New `payments.allow_overpayment`; `payments_override_reason_check` extended so a reason is mandatory for either override flag |
| Offline replay | Reuses `app.payment_funds_bypass`, for the same reason as the funds guard: the decision was already taken offline and stranding the outbox is worse |

The ৳1.00 tolerance is deliberate — PO-000144 had a ৳0.06 rounding overpayment, and blocking payments over six paise would be friction with no benefit.

### 11.3 Verification

All tests run against the live database inside rolled-back transactions.

| # | Test | Result |
|---|---|---|
| 1 | Overpayment beyond outstanding | Blocked — `Payment TEST-OVP-1 exceeds the outstanding balance on PO PO-000081: outstanding 890000.00, requested 895000.00` |
| 2 | Overpayment with `allow_overpayment` + reason | Accepted |
| 3 | `allow_overpayment` with no reason | Rejected by `payments_override_reason_check` |
| 4 | `amount_paid` after an overpayment | Capped at the PO total |
| 5 | Payment inside the outstanding balance | Accepted; `amount_paid` 0 → 1,000 |
| 6 | Reversing that payment | `amount_paid` 1,000 → 0 — decremented **once**, not twice |
| 7 | Offline replay with bypass set | Accepted |

Post-migration integrity: 1026 ৳-42,473.92 and 1001 ৳20,96,537.31 unchanged; trial balance difference ৳0.00; 2,006 payments; **zero** POs with `amount_paid > total_amount`.

### 11.4 New finding — six cash receipts that genuinely never posted

Not part of the refund question, but surfaced while auditing. Six July POS receipts are `received`, not reversed, and have no journal entry, while their invoices still carry the AR debit:

| Payment | Invoice | Amount |
|---|---|---|
| PAY-996660 | POS-00589653 | ৳2.00 |
| PAY-996676 | POS-00589657 | ৳546.00 |
| EDIT-PAY-3dc28824 | POS-00589658 | ৳600.00 |
| PAY-996679 | POS-00589660 | ৳2,100.00 |
| PAY-996680 | POS-00589661 | ৳110.00 |
| PAY-996709 | POS-00589691 | ৳200.03 |

Total **৳3,558.03**. Invoice POS-00589660 shows the pattern: JE-803874 debits AR ৳2,100, no entry ever credits it back, so AR is overstated and Cash in Hand understated by the same amount. These date from the first week of July, before the trigger was reliable. Not corrected — it is a rounding-level amount and posting it needs confirmation that cash was not already captured elsewhere.

---

## 12. Why the transfer was invisible on the account page (2026-10-31)

Reported: the ৳7,23,391.40 cash → bank transfer did not appear in the Transactions tab of the Cash in Hand profile page.

**Cause: PostgREST's 1,000-row response cap.** `loadTransactions()` in `app/(erp)/accounting/accounts/[id]/page.tsx` queried `journal_lines` with `.eq('account_id', id)` and no `.limit()` and no `.order()`. PostgREST returns at most 1,000 rows per request, and without an ORDER BY those are the first 1,000 in physical order — i.e. the *oldest*.

Cash in Hand has **1,596** journal lines. The transfer (JE-969294) is line **1,596 of 1,596** — the very last one. It could never have been returned. The same was true of JE-969293, the cash duplicate reversal.

The balance itself was never wrong: the stored `accounts.balance` is ৳20,96,537.31 and the ledger agrees (Dr ৳72,38,105.11 − Cr ৳51,41,567.80 = ৳20,96,537.31). Only the *list* was truncated — but that also silently corrupted the page's "Period Total" footer and the period Debit/Credit summary, because those are computed from the truncated array.

### Fixed

`lib/fetch-all.ts` already existed in the repo for exactly this — the account page simply did not use it. Three queries in that file now paginate:

| Query | Was | Now |
|---|---|---|
| `loadTransactions` | 1,000 rows, unordered | `fetchAll` + `.order('id')` |
| `loadPartyBreakdown` | 1,000 rows | `fetchAll` + `.order('id')` |
| `loadRelatedAccounts` fallback | 1,000 rows | `fetchAll` + `.order('id')` |

`.order('id')` is required by `fetchAll`'s contract — without a deterministic sort, rows can shift between pages and be duplicated or skipped.

Also fixed a pre-existing `react/no-unescaped-entities` error at line 1160 that would have failed `next build`.

### Accounts still affected by the same pattern elsewhere

The cap is a property of every unbounded query, and several other screens have it. Measured line counts that exceed 1,000:

| Account | Journal lines |
|---|---|
| 1200 Inventory Asset | 3,958 |
| 1100 Accounts Receivable | 3,851 |
| 5000 Cost of Goods Sold | 2,963 |
| 4000 Sales Revenue | 2,579 |
| 1001 Cash in Hand | 1,596 |

`app/(erp)/accounting/page.tsx` built its monthly income/expense chart from unbounded `journal_lines` queries over the selected date range. A full-year range on revenue or expense accounts exceeds 1,000 rows and understated the chart. **Fixed** — three queries now paginate via `fetchAll` + `.order('id')`: the per-batch journal-lines load in the running-balance calculation (~line 151), and the monthly revenue (~line 398) and expense (~line 422) queries.

### Second issue — entry dates are UTC, not local

All four Phase 3 entries were created at **04:36 Asia/Dhaka on 31 Oct** but carry `entry_date = 2026-10-30`:

```
JE-969291..969294 | entry_date 2026-10-30 | created 2026-10-31 04:36 Dhaka
server current_date = 2026-10-30
```

Postgres `current_date` resolves in UTC, and `record_fund_transfer` / `reverse_supplier_payment` both default to it. The transfers page compounds this by sending `new Date().toISOString().split('T')[0]`, which is also UTC.

**Effect:** anything posted between 00:00 and 05:59 Dhaka time is stamped with the previous day's date. Monthly totals are unaffected (same month), but daily reports and the Date column are off by one for that window.

**Corrected.** Migration `20261031080000_dhaka_business_date.sql` makes `record_fund_transfer()` and `reverse_supplier_payment()` resolve the business date as `(now() AT TIME ZONE 'Asia/Dhaka')::date` instead of `CURRENT_DATE`. Verified: a transfer with no explicit date now posts 2026-10-31 while `current_date` still reads 2026-10-30.

`scripts/phase3b_fix_entry_dates.sql` moved JE-969291..969294 from 2026-10-30 to 2026-10-31. Debits and credits were untouched — cash ৳20,96,537.31 and bank ৳-42,473.92 are unchanged, trial balance difference ৳0.00, and `trg_journal_entry_audit` logged all four changes.

Frontend: `localDateISO()` added to `lib/format.ts` (local YYYY-MM-DD, unlike `toISOString()`). The transfers page now uses it both for the form's default date and for the Today / Last 7 / Last 30 period filters — the UTC "today" was excluding today's transfers from the list entirely.

**Still open — same class of bug elsewhere.** `todayStr()` in `lib/batch-allocation.ts` is also `toISOString()`-based and feeds batch-expiry comparisons. Left alone deliberately: changing it shifts expiry semantics across the inventory module and deserves its own review. `pay_supplier_outstanding()` and the other payment RPCs also still default to `CURRENT_DATE`; their callers pass an explicit form date, so the default rarely applies.
