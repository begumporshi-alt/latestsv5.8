/**
 * Balance adjustment planning.
 *
 * A balance adjustment is a two-line correcting journal entry: the target
 * account moves by the adjustment, and an offsetting equity account absorbs
 * the other side.
 *
 * The UI expresses the movement as "increase" / "decrease", never as a signed
 * number. A sign is a second, silent way to get the entry backwards, and a
 * backwards entry still balances — so nothing catches it until reconciliation.
 *
 * The live preview and the submit handler both read the plan produced here,
 * so what the user is shown and what actually gets posted cannot drift apart.
 */

export type AdjustmentDirection = 'increase' | 'decrease';
export type AdjustmentMode = 'by' | 'to';

export interface AdjustmentPlan {
  /** Signed change applied to the account balance. */
  delta: number;
  /** Absolute delta — the amount that appears on both journal lines. */
  magnitude: number;
  /** Balance the account will hold once the entry is posted. */
  newBalance: number;
  /** null when the adjustment is a no-op. */
  direction: AdjustmentDirection | null;
  targetDebit: number;
  targetCredit: number;
  offsetDebit: number;
  offsetCredit: number;
}

export interface AdjustmentInput {
  accountType: string;
  currentBalance: number;
  mode: AdjustmentMode;
  /** Ignored in 'to' mode, where the direction is derived from the target. */
  direction: AdjustmentDirection;
  /** Magnitude in 'by' mode; the desired closing balance in 'to' mode. */
  amount: number;
}

/**
 * Asset and expense accounts carry a debit balance; the rest carry a credit.
 *
 * This is derived from `account_type` alone, which is also how the
 * `accounts.balance` trigger accumulates (asset/expense = debit - credit,
 * everything else = credit - debit). A contra account — accumulated
 * depreciation, a returns allowance — breaks the assumption, because its
 * economic balance runs opposite to its type.
 *
 * No contra account exists in this chart today: 38 active accounts, and the
 * returns account 4050 is typed `expense`, so it is already debit-normal and
 * handled correctly. The one negative balance belongs to an overdrawn bank
 * account, which is not a contra account.
 *
 * Fixing this properly means a per-account normal side (`normal_balance`, or an
 * `is_contra` flag) plus a control on the account form to set it. The reports
 * are already safe — they sum the signed `accounts.balance` and let a credit
 * balance net its section — so such a column would be sufficient on its own;
 * it is deferred only because nothing in the chart needs it yet, and a column
 * with no UI to set it is dead weight.
 *
 * Until then the panel flags any account carrying a negative balance, which is
 * the state a contra account always lands in under this convention.
 */
export function isDebitNormalAccount(accountType: string): boolean {
  return accountType === 'asset' || accountType === 'expense';
}

/** Money is stored to 2dp; float arithmetic must not leak 0.30000000000004. */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Resolve the signed delta.
 *
 * 'by'  — the user knows the movement: increase 500 / decrease 500.
 * 'to'  — the user knows the destination (typically a figure read off a bank
 *         statement or reconciliation report), so the delta is derived.
 *         Forcing them to subtract in their head is a direct source of
 *         arithmetic error, which is exactly what this panel exists to fix.
 */
export function resolveDelta(
  mode: AdjustmentMode,
  direction: AdjustmentDirection,
  amount: number,
  currentBalance: number
): number {
  const value = Number.isFinite(amount) ? amount : 0;
  const opening = Number.isFinite(currentBalance) ? currentBalance : 0;
  if (mode === 'to') return round2(value - opening);
  return round2(direction === 'increase' ? value : -value);
}

export function buildAdjustmentPlan(input: AdjustmentInput): AdjustmentPlan {
  const { accountType, currentBalance, mode, direction, amount } = input;
  const opening = Number.isFinite(currentBalance) ? currentBalance : 0;

  const delta = resolveDelta(mode, direction, amount, opening);
  const magnitude = Math.abs(delta);
  const newBalance = round2(opening + delta);

  let targetDebit = 0;
  let targetCredit = 0;
  let offsetDebit = 0;
  let offsetCredit = 0;

  if (delta !== 0) {
    const debitNormal = isDebitNormalAccount(accountType);
    // Moving a debit-normal account up debits it; moving it down credits it.
    // Credit-normal accounts are the mirror image.
    const targetIsDebit = delta > 0 === debitNormal;

    if (targetIsDebit) {
      targetDebit = magnitude;
      offsetCredit = magnitude;
    } else {
      targetCredit = magnitude;
      offsetDebit = magnitude;
    }
  }

  return {
    delta,
    magnitude,
    newBalance,
    direction: delta > 0 ? 'increase' : delta < 0 ? 'decrease' : null,
    targetDebit,
    targetCredit,
    offsetDebit,
    offsetCredit,
  };
}
