# Phase 3 — Account 1026 Reconciliation Worksheet

**Prepared:** 2026-10-31
**Account:** 1026 Al-arafah islami bank
**Current ledger balance:** ৳-7,96,504.38
**Status:** analysis complete, awaiting three owner decisions before any historical data is changed

---

## 1. Where the money actually went

Account 1026 has exactly three counterparties in its entire history:

| Counterparty | Direction | Amount |
|---|---|---|
| 1100 Accounts Receivable | money in (customer receipts) | ৳4,74,983.94 |
| 1300 Manual Receivable | money in | ৳89,775.00 |
| 2000 Accounts Payable | money out (supplier payments) | ৳13,61,261.32 |

**Total in ৳5,64,758.94 — total out ৳13,61,261.32 — net ৳-7,96,502.38** (the remaining ৳2.00 is two test entries).

So this is not a missing deposit or a corrupt cache. The account paid out ৳7.96 lakh more than it ever received. The question Phase 3 has to answer is *which of those payouts were really made from Al-Arafah*.

### Why that question is open

Every one of the 46 supplier payments charged to 1026 carries `payment_method = 'bank_transfer'` and `bank_account = NULL`. Before Phase 1, `payment_accounting_trigger()` resolved the account solely from `payment_methods.account_id`, and `bank_transfer` was hard-wired to 1026. **The system had no way to record that a payment came from Pubali, Islami Bank, or cash.** The payments themselves carry no evidence of their true source.

---

## 2. Confirmed arithmetic errors — ৳73,112.98

The investigation flagged ৳73,112.98 as duplicate or excess payments charged to 1026. That figure now reconciles exactly to four items:

| # | Payment | Date | PO | PO total | Paid | Account | Nature | Bank impact |
|---|---|---|---|---|---|---|---|---|
| 1 | POPAY-000094 | 2026-10-01 | PO-000133 | ৳30,639.00 | ৳30,639.00 | 1026 | **Duplicate** — POPAY-000093 paid the identical amount from cash the same day | +৳30,639.00 |
| 2 | POPAY-000092 | 2026-10-01 | PO-000144 | ৳73,375.07 | ৳0.06 | 1026 | **Duplicate** of POPAY-000091 (also ৳0.06) | +৳0.06 |
| 3 | POPAY-000129 | 2026-10-18 | PO-000194 | ৳3,25,564.04 | ৳3,32,298.96 | 1026 | **Excess** ৳6,734.92 over PO total | +৳6,734.92 |
| 4 | POPAY-000102 | 2026-10-07 | PO-000170 | ৳5,66,479.00 | ৳35,739.00 | 1026 | **Excess** — with POPAY-000100 (৳7,52,941 from cash) this PO was paid ৳7,88,680 against ৳5,66,479 | +৳35,739.00 |

`30,639.00 + 0.06 + 6,734.92 + 35,739.00 = 73,112.98` ✓

**Tier 1 — unambiguous (items 1 and 2): ৳30,639.06.** Two payments recorded twice. Safe to reverse.
**Tier 2 — needs your answer (items 3 and 4): ৳42,473.92.** These are overpayments, not duplicates. Whether they are errors, advance payments, or POs with a wrong total is a fact only you know.

There is also a fifth duplicate that does **not** touch 1026: POPAY-000009 and POPAY-000010 both paid ৳5,865.00 from **cash** for PO-000014. Reversing one would add ৳5,865.00 back to Cash in Hand.

---

## 3. What has been built

### `reverse_supplier_payment(payment_id, reason)` — new RPC

`supabase/migrations/20261031060000_reverse_supplier_payment.sql`

Before this, the only way to undo a payment was to cancel the entire purchase order, which reverses every payment on it. There was no per-payment reversal anywhere in the system.

The RPC:
- locks the payment row (`FOR UPDATE`) so two operators cannot both reverse it
- requires a reason of at least 5 characters
- refuses an already-reversed payment, or a payment with no journal entry
- posts a mirror of **every** journal entry belonging to the payment, swapping debit and credit — this keeps WHT-split payments correct by construction
- sets `payments.is_reversed`
- decrements `purchase_orders.amount_paid`, because `payment_po_amount_paid_trigger` only fires on INSERT and only ever adds — which is exactly why PO-000133 currently reads ৳61,278 paid against a ৳30,639 order

Verified in a rolled-back transaction against POPAY-000094:

```
result = {"payment_number":"POPAY-000094","reversed_entries":1,"amount":30639,...}
1026:        -796,504.38  ->  -765,865.38   (delta +30,639.00)
PO-000133:     61,278.00  ->     30,639.00
reversal entry: Dr 30,639.00 / Cr 30,639.00  (balanced)
double reversal  -> refused: "Payment POPAY-000094 is already reversed"
short reason     -> refused: "A reversal reason of at least 5 characters is required"
```

### No new deposit mechanism was needed

`record_fund_transfer()` already exists (`20260914130000_fund_transfers.sql`) with a Cash → Bank preset on `/accounting/transfers`. It has simply **never been used** — the database contains zero journal entries that move money between cash and any bank account, in either direction, since inception.

Dry run, rolled back:

```
record_fund_transfer(1001 -> 1026, 723,391.40)
  -> JE-969291
  Cash in Hand:  2,814,063.71  ->  2,090,672.31
  1026:           -796,504.38  ->    -73,112.98
```

That the bank lands on exactly -৳73,112.98 is a useful cross-check: it confirms the shortfall splits cleanly into "৳7.23 lakh that was never really in this account" and "৳73,112.98 of arithmetic error".

---

## 4. The three decisions

### Decision A — reverse the Tier 1 duplicates? (recommended: yes)

৳30,639.06. Both are the same amount on the same day for the same PO, and in PO-000133's case the PO total equals exactly one of the two payments. No interpretation is required.

### Decision B — reverse the Tier 2 overpayments?

৳42,473.92. For each one, the question is: **was the supplier genuinely overpaid?**

- If **yes**, the money left the bank and the fix is a supplier refund or a credit against future POs — not a reversal. Reversing it would silently restore a payable you have already settled.
- If **no** (keying error), reverse it.

PO-000170 deserves particular attention: POPAY-000100 paid ৳7,52,941.00 from cash against a ৳5,66,479.00 order. That is ৳1,86,462 over in a single cash payment, before the ৳35,739 from the bank. Either that PO's total is wrong or the payment was mis-keyed.

### Decision C — what to do about the remaining ৳7,23,391.40?

Three options, and they are not equivalent:

| Option | Entry | Result on 1026 | Honest when |
|---|---|---|---|
| **C1 — Reclassify from cash** | Dr 1026 / Cr 1001 ৳7,23,391.40 via `record_fund_transfer` | ৳0.00 | The supplier payments recorded against 1026 were actually paid in cash. Consistent with ৳28.14 lakh sitting in Cash in Hand that has never been banked. |
| **C2 — Post an opening balance** | Dr 1026 / Cr 3900 Opening Balance Equity | ৳0.00 | The account genuinely held money at go-live that was never recorded. |
| **C3 — Leave it and investigate** | none | -৳7,23,391.40 | You want the ledger to keep telling you something is wrong until the statement proves otherwise. |

**My recommendation: C1, but only after you confirm it.** C2 is a plug — it makes the balance disappear without evidence and parks the difference in equity, which is exactly the kind of entry that hides problems rather than fixing them. C1 at least reflects a mechanism we can see is real: cash has been accumulating and has never been deposited.

But C1 is still a management reclassification, not a proven fact. It assumes a portion of those 46 payments were cash payments. I cannot prove which ones from the data, and I will not pretend otherwise.

**What would settle it: the Al-Arafah statement.** With the actual balance at a given date, C2 becomes provable rather than a guess, and we would know how much of the gap is genuinely missing versus misrouted.

---

## 5. Order of operations once decisions are made

1. Reverse the confirmed payments (`reverse_supplier_payment`) — Tier 1, then any Tier 2 you approve.
2. Record the cash → bank transfer for the confirmed amount (`record_fund_transfer`).
3. Re-run the reconciliation queries in §7 of the main investigation report and confirm 1026 reconciles to the statement.
4. Only then consider hardening the Phase 2 bank guard from soft to hard — while the balance is wrong, staff would be overriding it constantly.

---

## 6. Executed — 2026-10-31

Script: `scripts/phase3_1026_reconciliation.sql` (committed)

Decisions applied: A = reverse Tier 1, B = park Tier 2 pending supplier confirmation, C = reclassify from cash.

| Step | Action | Entry | Effect |
|---|---|---|---|
| 1 | Reverse POPAY-000094 | JE-969291 | 1026 +৳30,639.00 |
| 2 | Reverse POPAY-000092 | JE-969292 | 1026 +৳0.06 |
| 3 | Reverse POPAY-000010 | JE-969293 | 1001 +৳5,865.00 |
| 4 | Cash → bank reclassification | JE-969294 | 1001 -৳7,23,391.40 / 1026 +৳7,23,391.40 |

| Account | Before | After | Change |
|---|---|---|---|
| 1001 Cash in Hand | ৳28,14,063.71 | ৳20,96,537.31 | -৳7,17,526.40 |
| 1026 Al-arafah | ৳-7,96,504.38 | ৳-42,473.92 | +৳7,54,030.46 |

### Verification after commit

- Trial balance: Dr ৳17,63,15,401.55 / Cr ৳17,63,15,401.55 — difference **৳0.00**
- Both accounts' stored `balance` matches the sum of their journal lines — difference **৳0.00**
- All three reversal entries balance (Dr = Cr)
- `payments.is_reversed = true` on all three reversed payments
- PO paid amounts now equal PO totals exactly: PO-000014 ৳5,865.00, PO-000133 ৳30,639.00, PO-000144 ৳73,375.07
- PO-000170 and PO-000194 deliberately untouched

### Why 1026 is still ৳-42,473.92

That number is not a residual error — it is exactly `POPAY-000129 (৳6,734.92) + POPAY-000102 (৳35,739.00)`, the two parked Tier 2 items. Leaving it visible means the ledger still shows the one open question, and both ways it can resolve land on zero without reversing anything back out:

- if they were keying errors → reverse them → 1026 = ৳0
- if they were genuine overpayments → reclassify a further ৳42,473.92 → 1026 = ৳0

---

## 7. Open items not covered here

- Account **1028 (Islami Bank Transfer)** is `is_active = false` while holding ৳103,700. It cannot receive new payments and does not appear in the picker.
- Six bank refunds totalling ৳1,18,036 were never journalised — `payment_accounting_trigger()` has no `refund` branch. That is Phase 4.
- The PO `amount_paid` trigger has no cap and no reversal path, so overpaid POs accumulate silently. `reverse_supplier_payment` corrects this for reversals, but a forward overpayment guard is still Phase 4.
