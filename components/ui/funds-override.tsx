'use client';

import { formatCurrency } from '@/lib/format';
import type { CashBankAccount } from '@/components/ui/account-select';

/** Balance the account can commit, including any agreed overdraft. */
export function fundsAvailable(account: CashBankAccount | null | undefined): number {
  if (!account) return 0;
  return Number(account.balance || 0) + Number(account.overdraft_limit || 0);
}

/** How much the payment exceeds the available balance. 0 when it fits. */
export function fundsShortfall(
  account: CashBankAccount | null | undefined,
  amount: number,
): number {
  if (!account || !Number.isFinite(amount) || amount <= 0) return 0;
  return Math.max(0, amount - fundsAvailable(account));
}

interface FundsOverrideProps {
  account: CashBankAccount | null;
  /** Cash amount leaving the account (already net of withholding). */
  amount: number;
  allowNegative: boolean;
  onAllowNegativeChange: (value: boolean) => void;
  reason: string;
  onReasonChange: (value: string) => void;
}

/**
 * Shown when a payment would overdraw its account.
 *
 * Cash accounts are a hard stop — physical cash cannot be spent twice, so there
 * is no override. Bank accounts can be overdrawn with an explicit, recorded
 * justification, because a real overdraft or an unrecorded deposit makes a hard
 * block unsafe.
 *
 * This mirrors `assert_payment_funds()` in the database, which is the
 * authoritative check; this component only avoids a pointless round-trip.
 */
export function FundsOverride({
  account,
  amount,
  allowNegative,
  onAllowNegativeChange,
  reason,
  onReasonChange,
}: FundsOverrideProps) {
  const shortfall = fundsShortfall(account, amount);
  if (!account || shortfall <= 0.005) return null;

  const available = fundsAvailable(account);

  if (account.is_cash) {
    return (
      <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
        <p className="text-xs font-semibold text-red-700">Insufficient cash</p>
        <p className="text-xs text-red-700 mt-1">
          {account.code} — {account.name} holds {formatCurrency(available)}, but this payment
          needs {formatCurrency(amount)} (short by {formatCurrency(shortfall)}).
        </p>
        <p className="text-[11px] text-red-600 mt-1">
          Cash accounts cannot go negative. Reduce the amount, or record the missing cash
          receipt first.
        </p>
      </div>
    );
  }

  return (
    <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg space-y-2">
      <div>
        <p className="text-xs font-semibold text-amber-800">Insufficient funds</p>
        <p className="text-xs text-amber-800 mt-1">
          {account.code} — {account.name} holds {formatCurrency(available)}, but this payment
          needs {formatCurrency(amount)} (short by {formatCurrency(shortfall)}).
        </p>
      </div>

      <label className="flex items-start gap-2 text-xs text-amber-900 cursor-pointer">
        <input
          type="checkbox"
          checked={allowNegative}
          onChange={e => onAllowNegativeChange(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          Override: allow this payment to overdraw the account
          {Number(account.overdraft_limit || 0) > 0 && (
            <> (overdraft limit {formatCurrency(Number(account.overdraft_limit))} already applied)</>
          )}
        </span>
      </label>

      {allowNegative && (
        <div>
          <input
            value={reason}
            onChange={e => onReasonChange(e.target.value)}
            placeholder="Reason for the override (required, recorded on the payment)"
            className="w-full border border-amber-300 bg-white rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-amber-500/20"
          />
          <p className="text-[10px] text-amber-700 mt-1">
            Stored on the payment and visible in the audit trail.
          </p>
        </div>
      )}
    </div>
  );
}

export default FundsOverride;
