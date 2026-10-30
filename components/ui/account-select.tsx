'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/format';

export interface CashBankAccount {
  id: string;
  code: string;
  name: string;
  balance: number;
  is_cash: boolean;
  is_bank: boolean;
  /** How far below zero this account may go. Ignored for cash. */
  overdraft_limit?: number;
}

interface AccountSelectProps {
  /** Selected account id, '' when nothing chosen. */
  value: string;
  onChange: (accountId: string) => void;
  /** Notified with the full row whenever the selection changes. */
  onAccountChange?: (account: CashBankAccount | null) => void;
  /**
   * Pass already-loaded accounts to skip the internal fetch. Only used when
   * the caller has them; otherwise the component loads active cash/bank
   * asset accounts itself.
   */
  accounts?: CashBankAccount[];
  required?: boolean;
  disabled?: boolean;
  label?: string;
  placeholder?: string;
  className?: string;
  /** Show the live balance next to each option. Default true. */
  showBalance?: boolean;
  /** Hide the "current balance" hint under the field. Default false. */
  hideHint?: boolean;
  id?: string;
}

/**
 * Cash/bank account picker used by every payment surface.
 *
 * The ledger account is chosen explicitly here rather than inferred from the
 * payment method. Before this existed, `payment_methods.account_id` was the
 * only routing signal, so every generic "bank transfer" posted to whichever
 * single account that method pointed at.
 */
export function AccountSelect({
  value,
  onChange,
  onAccountChange,
  accounts,
  required = false,
  disabled = false,
  label,
  placeholder = 'Select cash/bank account',
  className = '',
  showBalance = true,
  hideHint = false,
  id,
}: AccountSelectProps) {
  const [loaded, setLoaded] = useState<CashBankAccount[]>([]);
  const [loading, setLoading] = useState(!accounts);

  useEffect(() => {
    if (accounts) return;
    let cancelled = false;
    setLoading(true);
    supabase
      .from('accounts')
      .select('id, code, name, balance, is_cash, is_bank, overdraft_limit')
      .eq('is_active', true)
      .eq('account_type', 'asset')
      .or('is_cash.eq.true,is_bank.eq.true')
      .order('code')
      .then(({ data }) => {
        if (cancelled) return;
        setLoaded((data || []) as CashBankAccount[]);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [accounts]);

  const options = useMemo(() => {
    const list = accounts || loaded;
    return [...list].sort((a, b) => a.code.localeCompare(b.code));
  }, [accounts, loaded]);

  const selected = options.find(a => a.id === value) || null;
  const isNegative = selected ? Number(selected.balance) < 0 : false;

  // Surface the full row so callers can run the funds check without refetching.
  useEffect(() => {
    onAccountChange?.(selected);
  }, [selected?.id, selected?.balance, selected?.overdraft_limit, onAccountChange]);

  return (
    <div className={className}>
      {label && (
        <label className="block text-xs font-medium mb-1">
          {label}{required && ' *'}
        </label>
      )}
      <select
        id={id}
        required={required}
        disabled={disabled || loading}
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:opacity-60"
      >
        <option value="">{loading ? 'Loading accounts…' : placeholder}</option>
        {options.map(a => (
          <option key={a.id} value={a.id}>
            {a.code} — {a.name}
            {showBalance ? ` (${formatCurrency(Number(a.balance))})` : ''}
          </option>
        ))}
      </select>
      {!hideHint && selected && (
        <p className={`text-[11px] mt-1 ${isNegative ? 'text-red-600 font-medium' : 'text-muted-foreground'}`}>
          Available: {formatCurrency(Number(selected.balance))}
          {isNegative ? ' — this account is already overdrawn' : ''}
        </p>
      )}
    </div>
  );
}

export default AccountSelect;
