/**
 * Pre-warms the offline query cache for the RPC-driven views.
 *
 * Pages that read through `.from()` are served offline by the replica query
 * engine (lib/offline/replica-query.ts), but the reporting pages compute
 * through SQL functions (get_trial_balance, period_net_*, get_*_aging, …)
 * whose results cannot be derived locally. This module runs those RPCs in
 * the background with the exact default arguments the pages compute on first
 * load — through the wrapped client, so each result lands in the same
 * `q:rpc:*` cache key the page will look up offline.
 *
 * Triggered automatically after a successful replica refresh (throttled to
 * once per 6 hours, plus a re-run whenever the local day changes so
 * date-based defaults stay current), or manually from the Sync Center.
 * Changing a period/filter offline still needs one online visit of that view
 * — only default views are pre-warmed.
 */

import { supabase } from '../supabase'
import { supabaseRaw } from '../supabase-raw'
import { getMeta, setMeta } from './db'
import { networkMonitor } from './network'
import { REPLICA, replicaRows, subscribeReplica } from './replica'
import { isNetworkError } from './cache'

const WARM_THROTTLE_MS = 6 * 60 * 60_000
const CONCURRENCY = 4

/** Page-local date format (not UTC — same lesson as the pages' "Today" bug). */
function ymdLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

interface WarmCall {
  fn: string
  args?: Record<string, unknown>
}

/**
 * The default views of every RPC-driven page. Argument values must match the
 * pages' own computations EXACTLY (the cache key is derived from them):
 *  - aging / balance-sheet use the local date; accounting overview and the
 *    sales/reports pages use the UTC ISO date.
 *  - trial-balance/cash-flow "this_month" runs month-start → today;
 *    the P&L "this_month" runs month-start → month-end.
 *
 * Returns null when the replica has no accounts yet (fresh device, or the
 * warm raced ahead of the first replication) — the caller then skips the run
 * without recording it, so the next completed refresh retries.
 */
async function collectWarmCalls(): Promise<WarmCall[] | null> {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  const todayLocal = ymdLocal(now)
  const todayIso = now.toISOString().split('T')[0]
  const monthStart = ymdLocal(new Date(y, m, 1))
  const monthEnd = ymdLocal(new Date(y, m + 1, 0))

  const calls: WarmCall[] = [
    // no-argument reports
    { fn: 'get_unbalanced_journal_entries' },
    { fn: 'get_inventory_reconciliation' },
    { fn: 'get_negative_inventory_layers' },
    { fn: 'get_account_balance_drift' },
    { fn: 'get_payables_aging' }, // dashboard form (no p_as_of)
    { fn: 'get_fifo_inventory_value' }, // reports page inventory value card
    // today-anchored reports
    { fn: 'get_payables_aging', args: { p_as_of: todayLocal } },
    { fn: 'get_receivables_aging', args: { p_as_of: todayLocal } },
    { fn: 'get_balance_sheet', args: { p_as_of: todayLocal } },
    { fn: 'get_balance_sheet', args: { p_as_of: todayIso } }, // accounting overview (all_time)
    { fn: 'get_trial_balance', args: { p_from: monthStart, p_to: todayLocal } },
    { fn: 'get_cash_flow', args: { p_from: monthStart, p_to: todayLocal } },
    { fn: 'get_cogs_history_gap_breakdown', args: { p_start_date: todayIso, p_end_date: todayIso } }, // sales page (today)
  ]

  // Per-account period nets — the account ids come from the local replica.
  const accounts = await replicaRows<any>(REPLICA['Accounts'])
  if (accounts.length === 0) return null
  const cogsAccount = accounts.find((a) => a.code === '5000') ?? null
  for (const a of accounts) {
    // P&L (this_month default)
    calls.push({ fn: 'period_net_debit', args: { p_account_id: a.id, p_start_date: monthStart, p_end_date: monthEnd } })
    calls.push({ fn: 'period_net_credit', args: { p_account_id: a.id, p_start_date: monthStart, p_end_date: monthEnd } })
    // accounting overview (all_time default)
    calls.push({ fn: 'period_net_debit', args: { p_account_id: a.id, p_start_date: '2000-01-01', p_end_date: todayIso } })
  }
  // reports page monthly COGS chart — one period per elapsed month of this
  // year, with the page's exact date computation (local midnight → UTC ISO,
  // which shifts the day in UTC+offset timezones).
  if (cogsAccount) {
    for (let i = 0; i <= m; i++) {
      const start = new Date(y, i, 1).toISOString().split('T')[0]
      const end = new Date(y, i + 1, 0).toISOString().split('T')[0]
      calls.push({ fn: 'period_net_debit', args: { p_account_id: cogsAccount.id, p_start_date: start, p_end_date: end } })
    }
  }
  // sales + reports pages (today default) — COGS, sales returns and opex
  const opex = accounts.filter(
    (a) =>
      a.account_type === 'expense' &&
      !['5000', '4050', '4200'].includes(a.code) &&
      !String(a.name || '').toLowerCase().includes('cost of goods') &&
      !String(a.name || '').toLowerCase().includes('sales return'),
  )
  for (const a of accounts.filter((x) => ['5000', '4050'].includes(x.code)).concat(opex)) {
    calls.push({ fn: 'period_net_debit', args: { p_account_id: a.id, p_start_date: todayIso, p_end_date: todayIso } })
  }

  // De-duplicate (e.g. COGS today is wanted by both sales and reports pages).
  const seen = new Set<string>()
  return calls.filter((c) => {
    const k = `${c.fn}:${JSON.stringify(c.args ?? null)}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

let warming = false

export function isWarming(): boolean {
  return warming
}

export interface WarmStatus {
  running: boolean
  lastRun: number | null
  calls: number | null
  failures: number | null
}

export async function getWarmStatus(): Promise<WarmStatus> {
  return {
    running: warming,
    lastRun: (await getMeta<number>('warm:last-run')) ?? null,
    calls: (await getMeta<number>('warm:calls')) ?? null,
    failures: (await getMeta<number>('warm:failures')) ?? null,
  }
}

/**
 * Run the warm list now. `force` bypasses the throttle (Sync Center button);
 * automatic runs pass it. Requires connectivity and a live session — offline
 * there is nothing to warm.
 */
export async function runWarm(force = false): Promise<WarmStatus> {
  if (warming) return getWarmStatus()
  if (!networkMonitor.getState().online) return getWarmStatus()

  const lastRun = (await getMeta<number>('warm:last-run')) ?? null
  const dayChanged = lastRun === null || new Date(lastRun).toDateString() !== new Date().toDateString()
  if (!force && lastRun !== null && Date.now() - lastRun < WARM_THROTTLE_MS && !dayChanged) {
    return getWarmStatus()
  }

  const session = await supabaseRaw.auth.getSession()
  if (!session.data?.session) return getWarmStatus()

  warming = true
  let calls = 0
  let failures = 0
  try {
    const list = await collectWarmCalls()
    // null = the replica is not populated yet — skip without recording a
    // run, so the next completed refresh retries the full list.
    if (list !== null) {
      for (let i = 0; i < list.length; i += CONCURRENCY) {
        if (!networkMonitor.getState().online) break
        const batch = list.slice(i, i + CONCURRENCY)
        await Promise.all(
          batch.map(async (c) => {
            calls += 1
            try {
              const { error } = await supabase.rpc(c.fn, c.args)
              if (error && !isNetworkError(error)) failures += 1
            } catch {
              failures += 1
            }
          }),
        )
      }
      await setMeta('warm:last-run', Date.now())
      await setMeta('warm:calls', calls)
      await setMeta('warm:failures', failures)
    }
  } finally {
    warming = false
  }
  return getWarmStatus()
}

let started = false

/**
 * Mount once from the OfflineProvider: after every completed replica refresh,
 * warm the RPC views if the throttle / day-change rules say so.
 */
export function startWarming(): void {
  if (started || typeof window === 'undefined') return
  started = true

  let lastFullSync = -1
  const check = () => {
    void (async () => {
      const last = (await getMeta<number>('replica:last_full_sync')) ?? null
      if (last === null) return
      if (last === lastFullSync) return
      lastFullSync = last
      void runWarm(false)
    })()
  }
  check()
  subscribeReplica(check)
}
