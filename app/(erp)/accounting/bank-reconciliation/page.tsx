'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCurrency, formatDate } from '@/lib/format';
import { RefreshCw, CircleCheck as CheckCircle2, Circle as CheckCircle, Banknote, BadgeCheck, TriangleAlert as AlertTriangle, Download } from 'lucide-react';

interface AccountOption {
  id: string;
  code: string;
  name: string;
}

interface RecoLine {
  id: string;
  entry_number: string;
  entry_date: string;
  description: string | null;
  reference_type: string | null;
  debit: number;
  credit: number;
  reconciled: boolean;
}

export default function BankReconciliationPage() {
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [accountId, setAccountId] = useState('');
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });
  const [lines, setLines] = useState<RecoLine[]>([]);
  const [opening, setOpening] = useState(0);
  const [closing, setClosing] = useState(0);
  const [statementBalance, setStatementBalance] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase.from('accounts')
      .select('id, code, name')
      .or('is_cash.eq.true,is_bank.eq.true')
      .eq('is_active', true)
      .order('code')
      .then(({ data }) => {
        const opts = (data || []) as AccountOption[];
        setAccounts(opts);
        if (opts.length > 0) setAccountId(prev => prev || opts[0].id);
      });
  }, []);

  useEffect(() => { if (accountId) load(); }, [accountId, month]);

  function monthBounds(m: string) {
    const [y, mo] = m.split('-').map(Number);
    const from = `${y}-${String(mo).padStart(2, '0')}-01`;
    const last = new Date(y, mo, 0).getDate();
    const to = `${y}-${String(mo).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
    return { from, to };
  }

  async function load() {
    setLoading(true);
    setError(null);
    const { from, to } = monthBounds(month);
    const [linesRes, openRes, marksRes, sdRes] = await Promise.all([
      supabase.from('journal_lines')
        .select(`id, debit, credit, description, journal_entry:journal_entries!inner(entry_number, entry_date, reference_type, created_at)`)
        .eq('account_id', accountId)
        .gte('journal_entries.entry_date', from)
        .lte('journal_entries.entry_date', to),
      supabase.from('journal_lines')
        .select('debit, credit, journal_entry:journal_entries!inner(entry_date)')
        .eq('account_id', accountId)
        .lt('journal_entries.entry_date', from),
      supabase.from('bank_reconciliation_items').select('journal_line_id').eq('account_id', accountId),
      supabase.from('app_settings').select('setting_value').eq('setting_key', `bank-reco:${accountId}:${month}`).maybeSingle(),
    ]);
    if (linesRes.error) { setError(linesRes.error.message); setLoading(false); return; }

    const marked = new Set<string>();
    ((marksRes.data || []) as any[]).forEach(m => marked.add(m.journal_line_id));

    const openingBal = (openRes.data || []).reduce((s: number, l: any) => s + Number(l.debit) - Number(l.credit), 0);
    setOpening(openingBal);

    const rows: RecoLine[] = (linesRes.data || [])
      .map((l: any) => ({
      id: l.id,
      entry_number: l.journal_entry?.entry_number || '',
      entry_date: l.journal_entry?.entry_date || '',
      description: l.description,
      reference_type: l.journal_entry?.reference_type || null,
      debit: Number(l.debit),
      credit: Number(l.credit),
      reconciled: marked.has(l.id),
      _ts: l.journal_entry?.created_at || '',
    }))
      .sort((a: any, b: any) => (a.entry_date === b.entry_date ? (a._ts < b._ts ? -1 : 1) : (a.entry_date < b.entry_date ? -1 : 1)))
      .map(({ _ts, ...r }: any) => r);
    setLines(rows);
    setClosing(openingBal + rows.reduce((s, r) => s + r.debit - r.credit, 0));

    setStatementBalance(sdRes.data?.setting_value?.balance != null ? String(sdRes.data.setting_value.balance) : '');
    setLoading(false);
  }

  async function toggleLine(line: RecoLine) {
    setLines(prev => prev.map(l => l.id === line.id ? { ...l, reconciled: !l.reconciled } : l));
    const { error: rpcError } = await supabase.rpc('toggle_bank_reconciliation_item', { p_journal_line_id: line.id });
    if (rpcError) {
      setLines(prev => prev.map(l => l.id === line.id ? { ...l, reconciled: !l.reconciled } : l));
      setError(rpcError.message);
    }
  }

  async function saveStatementBalance() {
    const key = `bank-reco:${accountId}:${month}`;
    const value = { balance: statementBalance === '' ? null : parseFloat(statementBalance) };
    const { error: upErr } = await supabase.from('app_settings').upsert(
      { setting_key: key, setting_value: value, updated_at: new Date().toISOString() },
      { onConflict: 'setting_key' }
    );
    if (upErr) setError(upErr.message);
  }

  const statement = parseFloat(statementBalance);
  const difference = isNaN(statement) ? null : statement - closing;
  const reconciledCount = lines.filter(l => l.reconciled).length;
  const unreconciled = lines.length - reconciledCount;

  // running balance across the month
  let running = opening;
  const rowsWithRunning = lines.map(l => {
    running += l.debit - l.credit;
    return { ...l, running };
  });

  function exportCsv() {
    const lines2: string[] = [
      `BANK RECONCILIATION — ${accounts.find(a => a.id === accountId)?.code} ${accounts.find(a => a.id === accountId)?.name}`,
      `Month: ${month}`,
      `Opening balance (app),${opening.toFixed(2)}`,
      `Closing balance (app),${closing.toFixed(2)}`,
      `Statement balance,${isNaN(statement) ? '' : statement.toFixed(2)}`,
      `Difference,${difference === null ? '' : difference.toFixed(2)}`,
      '',
      'Date,Entry #,Description,In,Out,Running,Reconciled',
      ...rowsWithRunning.map(r => `${r.entry_date},${r.entry_number},"${(r.description || '').replace(/"/g, '""')}",${r.debit.toFixed(2)},${r.credit.toFixed(2)},${r.running.toFixed(2)},${r.reconciled ? 'yes' : 'no'}`),
    ];
    const csv = '\uFEFF' + lines2.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bank_reconciliation_${month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-5 animate-fade-in print-modal">
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-5 print:hidden">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center flex-shrink-0 mt-0.5">
            <Banknote className="w-4 h-4 text-white" />
          </div>
          <div className="text-xs text-blue-800 space-y-1">
            <p className="text-sm font-bold text-blue-900">Monthly Bank Reconciliation</p>
            <p>Pick an account and a month, tick each movement as you match it against the bank statement, then enter the statement&apos;s closing balance. When everything is ticked and the difference is zero, the account is reconciled for the month.</p>
            <p>Movements come straight from the journal — the same entries the Cash Flow and Balance Sheet use.</p>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between flex-wrap gap-3 print:hidden">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Bank Reconciliation</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Match the bank statement against the app</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select value={accountId} onChange={e => setAccountId(e.target.value)} className="border border-border rounded-lg px-3 py-2 text-sm bg-white">
            {accounts.map(a => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
          </select>
          <input type="month" value={month} onChange={e => setMonth(e.target.value)} className="border border-border rounded-lg px-3 py-2 text-sm bg-white" />
          <button onClick={load} className="flex items-center gap-1.5 border border-border px-3 py-2 rounded-lg text-sm hover:bg-muted transition">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button onClick={exportCsv} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition">
            <Download className="w-4 h-4" />Export
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700 print:hidden">{error}</div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="stat-card">
          <p className="text-xs text-muted-foreground mb-1">Opening (app)</p>
          <p className="text-xl font-bold text-foreground tabular-nums">{formatCurrency(opening)}</p>
        </div>
        <div className="stat-card">
          <p className="text-xs text-muted-foreground mb-1">Closing (app)</p>
          <p className="text-xl font-bold text-foreground tabular-nums">{formatCurrency(closing)}</p>
        </div>
        <div className="stat-card">
          <p className="text-xs text-muted-foreground mb-1">Statement balance</p>
          <div className="flex items-center gap-2">
            <input
              type="number" step="0.01"
              value={statementBalance}
              onChange={e => setStatementBalance(e.target.value)}
              onBlur={saveStatementBalance}
              placeholder="from statement"
              className="w-full border border-border rounded-lg px-2 py-1 text-sm"
            />
          </div>
        </div>
        <div className="stat-card">
          <p className="text-xs text-muted-foreground mb-1">Difference</p>
          {difference === null ? (
            <p className="text-xl font-bold text-muted-foreground">—</p>
          ) : Math.abs(difference) < 0.01 ? (
            <p className="text-xl font-bold text-green-600 flex items-center gap-1"><BadgeCheck className="w-5 h-5" />Matched</p>
          ) : (
            <p className="text-xl font-bold text-red-600 tabular-nums">{formatCurrency(difference)}</p>
          )}
        </div>
      </div>

      {difference !== null && Math.abs(difference) >= 0.01 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-center gap-2 text-sm text-amber-800 print:hidden">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          The bank statement and the app disagree by {formatCurrency(Math.abs(difference))}. Tick everything that appears on the statement — unticked items are movements the bank hasn&apos;t seen yet (or entries the app made without a bank transaction).
        </div>
      )}

      <div className="table-wrapper">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">
            Movements in {month}
            <span className="text-xs text-muted-foreground font-normal ml-2">
              {reconciledCount} of {lines.length} reconciled{unreconciled > 0 ? ` · ${unreconciled} unticked` : ' · all matched'}
            </span>
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-muted/40 border-b border-border">
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3 w-10">✓</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Date</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Entry #</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Description</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">In</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Out</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Running</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground text-sm">Loading movements…</td></tr>
              ) : rowsWithRunning.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground text-sm">No movements on this account in {month}.</td></tr>
              ) : rowsWithRunning.map(r => (
                <tr key={r.id} className={`transition-colors ${r.reconciled ? 'bg-green-50/40' : 'hover:bg-muted/30'}`}>
                  <td className="px-4 py-2.5">
                    <button
                      onClick={() => toggleLine(r)}
                      title={r.reconciled ? 'Mark as unreconciled' : 'Mark as reconciled'}
                      className="text-muted-foreground hover:text-green-600 transition"
                    >
                      {r.reconciled ? <CheckCircle2 className="w-5 h-5 text-green-600" /> : <CheckCircle className="w-5 h-5" />}
                    </button>
                  </td>
                  <td className="px-4 py-2.5 text-sm text-muted-foreground">{formatDate(r.entry_date)}</td>
                  <td className="px-4 py-2.5 text-sm font-mono text-xs text-muted-foreground">{r.entry_number}</td>
                  <td className="px-4 py-2.5 text-sm text-foreground max-w-xs truncate">{r.description || r.reference_type || '—'}</td>
                  <td className="px-4 py-2.5 text-right text-sm text-green-600 tabular-nums">{r.debit > 0 ? formatCurrency(r.debit) : '—'}</td>
                  <td className="px-4 py-2.5 text-right text-sm text-red-600 tabular-nums">{r.credit > 0 ? formatCurrency(r.credit) : '—'}</td>
                  <td className="px-4 py-2.5 text-right text-sm font-medium text-foreground tabular-nums">{formatCurrency(r.running)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
