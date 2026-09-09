// Shared credit-control gate: compare the receivable a sale would create
// against the customer's credit limit before submit. Warn-and-confirm only —
// the same policy as the oversell gate (deliberate: no hard block).
//
// Used by the POS checkout and the CreateInvoiceModal on the sales page so
// both paths warn identically before pushing a customer past their limit.
// Customers with credit_limit = 0 (the default) are never gated — the field
// only means something once the business sets it.

import { supabase } from '@/lib/supabase';
import { cacheGet, isNetworkError } from '@/lib/offline/cache';
import { CACHE_KEYS } from '@/lib/offline/keys';

export interface CreditCheck {
  limit: number;
  outstanding: number;
  newReceivable: number;
  afterSale: number;
  shortfall: number;
  /** true when computed from the offline customer snapshot, not a live read */
  stale?: boolean;
}

// newReceivable = the part of this sale the customer will owe after whatever
// is collected now (cash) and whatever store credit absorbs. Sale total
// minus cash paid minus store credit — NOT the sale total: a fully-paid
// sale creates no receivable and must never warn.
export function newReceivableFor(
  total: number,
  cashPaidNow: number,
  storeCreditApplied: number
): number {
  return Math.max(0, total - cashPaidNow - storeCreditApplied);
}

// Fetches the customer's credit fields fresh at gate time (the list-loaded
// outstanding_balance can be stale). Offline, falls back to the cached
// customer snapshot and marks the result stale. Returns null when there is
// no data either way, so callers fail open with a notice — the gate is
// advisory and the DB allows the sale either way.
export async function checkCreditLimit(
  customerId: string,
  newReceivable: number
): Promise<CreditCheck | null> {
  if (!customerId) return null;
  const { data, error } = await supabase
    .from('customers')
    .select('credit_limit, outstanding_balance')
    .eq('id', customerId)
    .single();

  let limit: number;
  let outstanding: number;
  let stale = false;

  if (error || !data) {
    if (!isNetworkError(error)) return null;
    const cachedList = await cacheGet<Array<Record<string, unknown>>>(CACHE_KEYS.customers);
    const cached = cachedList?.find((c) => c.id === customerId);
    if (!cached) return null;
    limit = Number(cached.credit_limit) || 0;
    outstanding = Number(cached.outstanding_balance) || 0;
    stale = true;
  } else {
    limit = Number(data.credit_limit) || 0;
    outstanding = Number(data.outstanding_balance) || 0;
  }

  if (limit <= 0) return null; // no limit set — nothing to enforce

  const afterSale = outstanding + newReceivable;
  if (afterSale <= limit + 0.01) return null; // within limit — no warning

  return {
    limit,
    outstanding,
    newReceivable,
    afterSale,
    shortfall: afterSale - limit,
    stale,
  };
}
