'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCurrency, formatDate } from '@/lib/format';
import { toast } from '@/hooks/use-toast';
import { networkMonitor } from '@/lib/offline/network';
import { enqueueOp } from '@/lib/offline/outbox';
import { ArrowRight, ArrowDownToLine, ArrowUpFromLine, ArrowRightLeft, Search, Wallet } from 'lucide-react';
import type { Account } from '@/lib/types';
import AppPagination from '@/components/ui/AppPagination';

interface TransferLine {
  account_id: string;
  debit: number;
  credit: number;
  account: { id: string; code: string; name: string; is_cash: boolean; is_bank: boolean };
}

interface TransferEntry {
  id: string;
  entry_number: string;
  entry_date: string;
  description: string;
  total_debit: number;
  created_at: string;
  __pending?: boolean;
  lines: TransferLine[];
}

type Period = 'today' | 'last7' | 'last30' | 'all' | 'custom';
type TransferKind = 'withdraw' | 'deposit' | 'transfer';

const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'last7', label: 'Last 7 Days' },
  { value: 'last30', label: 'Last 30 Days' },
  { value: 'all', label: 'All Time' },
  { value: 'custom', label: 'Custom' },
];

const KIND_PRESETS: { value: TransferKind; label: string; description: string; icon: typeof ArrowDownToLine }[] = [
  { value: 'withdraw', label: 'Withdraw', description: 'Bank → Cash', icon: ArrowDownToLine },
  { value: 'deposit', label: 'Deposit', description: 'Cash → Bank', icon: ArrowUpFromLine },
  { value: 'transfer', label: 'Transfer', description: 'Any → Any', icon: ArrowRightLeft },
];

export default function TransfersPage() {
  const [transfers, setTransfers] = useState<TransferEntry[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);

  const [kind, setKind] = useState<TransferKind>('withdraw');
  const [fromAccount, setFromAccount] = useState('');
  const [toAccount, setToAccount] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [period, setPeriod] = useState<Period>('last30');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [search, setSearch] = useState('');

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  // Reactive connectivity for the submit label (the submit handler itself
  // re-checks networkMonitor at click time).
  const [online, setOnline] = useState(() => networkMonitor.getState().online);
  useEffect(() => networkMonitor.subscribe(s => setOnline(s.online)), []);

  useEffect(() => { loadData(); }, [period, customFrom, customTo]);

  function getPeriodRange() {
    const today = new Date().toISOString().split('T')[0];
    if (period === 'today') return { from: today, to: today };
    if (period === 'last7') {
      const d = new Date(); d.setDate(d.getDate() - 6);
      return { from: d.toISOString().split('T')[0], to: today };
    }
    if (period === 'last30') {
      const d = new Date(); d.setDate(d.getDate() - 29);
      return { from: d.toISOString().split('T')[0], to: today };
    }
    if (period === 'custom') return { from: customFrom || '', to: customTo || '' };
    return { from: '', to: '' };
  }

  async function loadData() {
    setLoading(true);
    const { from, to } = getPeriodRange();

    let query = supabase
      .from('journal_entries')
      .select(`
        id, entry_number, entry_date, description, total_debit, created_at,
        lines:journal_lines(account_id, debit, credit, account:accounts(id, code, name, is_cash, is_bank))
      `)
      .eq('reference_type', 'transfer')
      .order('entry_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(500);

    if (from) query = query.gte('entry_date', from);
    if (to) query = query.lte('entry_date', to);

    const [transfersRes, accountsRes] = await Promise.all([
      query,
      supabase.from('accounts').select('*').eq('is_active', true).order('code'),
    ]);

    setTransfers((transfersRes.data as unknown as TransferEntry[]) || []);
    setAccounts((accountsRes.data as unknown as Account[]) || []);
    setLoading(false);
  }

  const cashBankAccounts = accounts.filter(a => (a.is_cash || a.is_bank) && a.account_type === 'asset');
  const bankAccounts = cashBankAccounts.filter(a => a.is_bank && !a.is_cash);
  const cashAccounts = cashBankAccounts.filter(a => a.is_cash);

  const fromAcc = cashBankAccounts.find(a => a.id === fromAccount);
  const sourceBalance = fromAcc ? Number(fromAcc.balance) : 0;
  const amountNum = parseFloat(amount) || 0;
  const exceedsBalance = fromAcc && amountNum > 0 && amountNum > sourceBalance;

  // Presets only prefill the From/To defaults — every select stays free so an
  // unusual move (e.g. bKash → Nagad) never needs a new preset.
  function applyKind(k: TransferKind) {
    setKind(k);
    setError('');
    if (k === 'withdraw') {
      const bank = bankAccounts.find(b => Number(b.balance) > 0) || bankAccounts[0];
      setFromAccount(bank?.id || '');
      setToAccount(cashAccounts[0]?.id || '');
    } else if (k === 'deposit') {
      setFromAccount(cashAccounts[0]?.id || '');
      const bank = bankAccounts.find(b => Number(b.balance) > 0) || bankAccounts[0];
      setToAccount(bank?.id || '');
    }
  }

  // Wait for accounts before applying the initial preset (state starts empty)
  useEffect(() => {
    if (cashBankAccounts.length > 0 && !fromAccount && !toAccount) {
      applyKind('withdraw');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cashBankAccounts.length]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (!fromAccount || !toAccount) {
      setError('Please select both the source and destination accounts');
      return;
    }
    if (fromAccount === toAccount) {
      setError('Source and destination accounts must be different');
      return;
    }
    if (!amount || amountNum <= 0) {
      setError('Please enter an amount greater than zero');
      return;
    }
    if (exceedsBalance) {
      setError(`Insufficient balance in ${fromAcc?.code} ${fromAcc?.name}: available ${formatCurrency(sourceBalance)}`);
      return;
    }

    setSaving(true);
    try {
      // Offline: queue; sync_transfer_create replays the same atomic
      // record_fund_transfer RPC (overdraft re-validated server-side).
      if (!networkMonitor.getState().online) {
        try {
          await enqueueOp('transfer.create', {
            idempotency_key: crypto.randomUUID(),
            from_account_id: fromAccount,
            to_account_id: toAccount,
            amount: amountNum,
            date,
            notes: note || null,
          }, `Transfer ${formatCurrency(amountNum)}`);
          toast({ title: 'Transfer queued offline', description: `${formatCurrency(amountNum)} will post when you reconnect.` });
          setAmount('');
          setNote('');
          loadData();
        } catch (err: any) {
          setError(err?.message || 'Could not queue the transfer offline');
        }
        return;
      }

      const { data: result, error: rpcError } = await supabase.rpc('record_fund_transfer', {
        p_from_account_id: fromAccount,
        p_to_account_id: toAccount,
        p_amount: amountNum,
        p_transfer_date: date,
        p_notes: note || null,
      });
      if (rpcError) throw rpcError;

      toast({ title: 'Transfer posted', description: `${result?.entry_number || ''} — ${formatCurrency(amountNum)} moved` });
      setAmount('');
      setNote('');
      loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to record the transfer');
    } finally {
      setSaving(false);
    }
  }

  function getFromLine(t: TransferEntry): TransferLine | undefined {
    return t.lines?.find(l => Number(l.credit) > 0);
  }
  function getToLine(t: TransferEntry): TransferLine | undefined {
    return t.lines?.find(l => Number(l.debit) > 0);
  }
  function getKind(t: TransferEntry): TransferKind {
    const from = getFromLine(t)?.account;
    const to = getToLine(t)?.account;
    if (from?.is_bank && to?.is_cash) return 'withdraw';
    if (from?.is_cash && to?.is_bank) return 'deposit';
    return 'transfer';
  }
  function getNotes(t: TransferEntry): string {
    // Description format: "<kind>: <from> → <to> — <notes>"
    const idx = t.description?.indexOf(' — ');
    return idx >= 0 ? t.description.slice(idx + 3) : '';
  }

  let filtered = transfers;
  if (search.trim()) {
    const q = search.toLowerCase();
    filtered = filtered.filter(t =>
      t.description?.toLowerCase().includes(q) ||
      t.entry_number?.toLowerCase().includes(q) ||
      t.lines?.some(l => l.account?.name?.toLowerCase().includes(q))
    );
  }

  const totalTransferred = filtered.reduce((s, t) => s + Number(t.total_debit), 0);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedTransfers = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const kindBadge: Record<TransferKind, { label: string; className: string }> = {
    withdraw: { label: 'Withdrawal', className: 'bg-cyan-50 text-cyan-700 border-cyan-200' },
    deposit: { label: 'Deposit', className: 'bg-teal-50 text-teal-700 border-teal-200' },
    transfer: { label: 'Transfer', className: 'bg-blue-50 text-blue-700 border-blue-200' },
  };

  return (
    <div className="space-y-5 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Transfers & Withdrawals</h1>
        <p className="text-muted-foreground text-sm mt-0.5">Move money between cash and bank accounts</p>
      </div>

      {/* Quick action form */}
      <div className="bg-white rounded-2xl border border-border shadow-sm p-5 md:p-6">
        <div className="flex flex-wrap gap-2 mb-5">
          {KIND_PRESETS.map(p => {
            const Icon = p.icon;
            const active = kind === p.value;
            return (
              <button
                key={p.value}
                type="button"
                onClick={() => applyKind(p.value)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium transition ${active
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-foreground border-border hover:bg-muted'}`}
              >
                <Icon className="w-4 h-4" />
                <span>{p.label}</span>
                <span className={active ? 'text-blue-100' : 'text-muted-foreground'}>· {p.description}</span>
              </button>
            );
          })}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">From (source) *</label>
              <select
                required
                value={fromAccount}
                onChange={e => setFromAccount(e.target.value)}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm"
              >
                <option value="">Select source account</option>
                {cashBankAccounts.map(a => (
                  <option key={a.id} value={a.id}>{a.code} - {a.name}</option>
                ))}
              </select>
              {fromAcc && (
                <p className={`text-xs mt-1 ${exceedsBalance ? 'text-red-600 font-medium' : 'text-muted-foreground'}`}>
                  Available: {formatCurrency(sourceBalance)}
                </p>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">To (destination) *</label>
              <select
                required
                value={toAccount}
                onChange={e => setToAccount(e.target.value)}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm"
              >
                <option value="">Select destination account</option>
                {cashBankAccounts.filter(a => a.id !== fromAccount).map(a => (
                  <option key={a.id} value={a.id}>{a.code} - {a.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">Amount *</label>
              <input
                type="number"
                required
                min="0"
                step="0.01"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder="0"
                className="w-full border border-border rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Date</label>
              <input
                type="date"
                value={date}
                onChange={e => setDate(e.target.value)}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Note</label>
              <input
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder="e.g. ATM withdrawal, cash deposit slip #"
                className="w-full border border-border rounded-lg px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={saving || !!exceedsBalance}
              className="flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-60"
            >
              <ArrowRight className="w-4 h-4" />
              {saving ? 'Posting...' : online ? 'Post Transfer' : 'Queue Transfer'}
            </button>
          </div>
        </form>
      </div>

      {/* History */}
      <div className="bg-white rounded-2xl border border-border shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center gap-3 p-4 border-b border-border">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Wallet className="w-4 h-4 text-muted-foreground" />
            Transfer History
          </div>
          <div className="flex-1" />
          <select
            value={period}
            onChange={e => { setPage(1); setPeriod(e.target.value as Period); }}
            className="border border-border rounded-lg px-3 py-1.5 text-sm"
          >
            {PERIOD_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          {period === 'custom' && (
            <div className="flex items-center gap-2">
              <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} className="border border-border rounded-lg px-3 py-1.5 text-sm" />
              <span className="text-muted-foreground text-sm">to</span>
              <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} className="border border-border rounded-lg px-3 py-1.5 text-sm" />
            </div>
          )}
          <div className="relative">
            <Search className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={search}
              onChange={e => { setPage(1); setSearch(e.target.value); }}
              placeholder="Search entry, account…"
              className="pl-9 pr-3 py-1.5 border border-border rounded-lg text-sm w-full md:w-56"
            />
          </div>
        </div>

        {loading ? (
          <div className="p-8 text-center text-muted-foreground text-sm">Loading transfers…</div>
        ) : pagedTransfers.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground text-sm">
            No transfers yet. Use the form above to record a withdrawal, deposit, or transfer.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {pagedTransfers.map(t => {
              const from = getFromLine(t);
              const to = getToLine(t);
              const k = getKind(t);
              const badge = kindBadge[k];
              const notes = getNotes(t);
              return (
                <div key={t.id} className="p-4 flex flex-col md:flex-row md:items-center gap-3 hover:bg-muted/50 transition">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`px-2 py-0.5 rounded-full border text-xs font-medium ${badge.className}`}>{badge.label}</span>
                      <span className="text-sm font-mono font-medium">{t.entry_number}</span>
                      {t.__pending && (
                        <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 text-xs font-medium">Queued offline</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-1.5 text-sm text-foreground flex-wrap">
                      <span>{from?.account?.code} {from?.account?.name}</span>
                      <ArrowRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      <span>{to?.account?.code} {to?.account?.name}</span>
                    </div>
                    {notes && <p className="text-xs text-muted-foreground mt-1 truncate">{notes}</p>}
                  </div>
                  <div className="md:text-right shrink-0">
                    <div className="text-sm font-bold">{formatCurrency(Number(t.total_debit))}</div>
                    <div className="text-xs text-muted-foreground">{formatDate(t.entry_date)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex items-center justify-between p-4 border-t border-border text-sm">
          <div className="text-muted-foreground">
            {filtered.length} transfer{filtered.length === 1 ? '' : 's'} · Total <span className="font-semibold text-foreground">{formatCurrency(totalTransferred)}</span>
          </div>
          <AppPagination
            page={currentPage}
            pageSize={pageSize}
            total={filtered.length}
            onPageChange={setPage}
            onPageSizeChange={s => { setPageSize(s); setPage(1); }}
          />
        </div>
      </div>
    </div>
  );
}
