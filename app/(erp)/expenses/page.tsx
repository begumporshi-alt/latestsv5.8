'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCurrency, formatDate } from '@/lib/format';
import { toast } from '@/hooks/use-toast';
import { Plus, X, Receipt, TrendingDown, Calendar, Filter, Pencil, Trash2, ChevronDown } from 'lucide-react';
import type { Account } from '@/lib/types';
import AppPagination from '@/components/ui/AppPagination';

interface ExpenseLine {
  account_id: string;
  debit: number;
  credit: number;
  account: { id: string; code: string; name: string; account_type: string; is_cash: boolean; is_bank: boolean };
}

interface ExpenseEntry {
  id: string;
  entry_number: string;
  entry_date: string;
  description: string;
  total_debit: number;
  created_at: string;
  lines: ExpenseLine[];
}

type Period = 'today' | 'last7' | 'last30' | 'all' | 'custom';

const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'last7', label: 'Last 7 Days' },
  { value: 'last30', label: 'Last 30 Days' },
  { value: 'all', label: 'All Time' },
  { value: 'custom', label: 'Custom' },
];

export default function ExpensesPage() {
  const [expenses, setExpenses] = useState<ExpenseEntry[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);

  const [period, setPeriod] = useState<Period>('last30');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [filterType, setFilterType] = useState('');
  const [search, setSearch] = useState('');

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [showModal, setShowModal] = useState(false);
  const [editingExpense, setEditingExpense] = useState<ExpenseEntry | null>(null);
  const [deletingExpense, setDeletingExpense] = useState<ExpenseEntry | null>(null);

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
        lines:journal_lines(account_id, debit, credit, account:accounts(id, code, name, account_type, is_cash, is_bank))
      `)
      .eq('reference_type', 'manual')
      .order('entry_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(500);

    if (from) query = query.gte('entry_date', from);
    if (to) query = query.lte('entry_date', to);

    const [expensesRes, accountsRes] = await Promise.all([
      query,
      supabase.from('accounts').select('*').eq('is_active', true).order('code'),
    ]);

    setExpenses((expensesRes.data as unknown as ExpenseEntry[]) || []);
    setAccounts(accountsRes.data || []);
    setLoading(false);
  }

  const expenseAccounts = accounts.filter(a => a.account_type === 'expense');
  const cashBankAccounts = accounts.filter(a => a.is_cash || a.is_bank || a.code === '1000' || a.code === '1010');

  // Apply type filter and search
  let filtered = expenses;
  if (filterType) {
    filtered = filtered.filter(e => e.lines?.some(l => l.account_id === filterType && Number(l.debit) > 0));
  }
  if (search.trim()) {
    const q = search.toLowerCase();
    filtered = filtered.filter(e =>
      e.description?.toLowerCase().includes(q) ||
      e.entry_number?.toLowerCase().includes(q) ||
      e.lines?.some(l => l.account?.name?.toLowerCase().includes(q))
    );
  }

  const totalExpenses = filtered.reduce((s, e) => s + Number(e.total_debit), 0);

  // Group by expense account
  const expensesByCategory = new Map<string, number>();
  filtered.forEach(e => {
    e.lines?.forEach(line => {
      if (Number(line.debit) > 0 && line.account?.account_type === 'expense') {
        const name = line.account?.name || 'Other';
        expensesByCategory.set(name, (expensesByCategory.get(name) || 0) + Number(line.debit));
      }
    });
  });

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedExpenses = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  function getExpenseAccount(e: ExpenseEntry): ExpenseLine | undefined {
    return e.lines?.find(l => Number(l.debit) > 0 && l.account?.account_type === 'expense');
  }
  function getPaidFromAccount(e: ExpenseEntry): ExpenseLine | undefined {
    return e.lines?.find(l => Number(l.credit) > 0);
  }

  async function handleDelete(expense: ExpenseEntry) {
    try {
      // Reverse account balances
      for (const line of expense.lines || []) {
        const acct = accounts.find(a => a.id === line.account_id);
        if (!acct) continue;
        const debit = Number(line.debit);
        const credit = Number(line.credit);
        // Reverse: debit was added, credit was subtracted
        await supabase.from('accounts').update({
          balance: (Number(acct.balance) || 0) - debit + credit,
        }).eq('id', line.account_id);
      }

      // Delete journal lines then entry
      await supabase.from('journal_lines').delete().eq('journal_entry_id', expense.id);
      const { error } = await supabase.from('journal_entries').delete().eq('id', expense.id);
      if (error) throw error;

      toast({ title: 'Deleted', description: `Expense ${expense.entry_number} deleted and accounts reversed` });
      setDeletingExpense(null);
      loadData();
    } catch (err: any) {
      toast({ title: 'Error', description: err.message || 'Failed to delete', variant: 'destructive' });
    }
  }

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Expenses</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Track and manage business expenses</p>
        </div>
        <button
          onClick={() => { setEditingExpense(null); setShowModal(true); }}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition"
        >
          <Plus className="w-4 h-4" />Add Expense
        </button>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="stat-card">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center">
              <TrendingDown className="w-5 h-5 text-red-600" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Total Expenses</p>
              <p className="text-lg font-bold text-red-600">{formatCurrency(totalExpenses)}</p>
            </div>
          </div>
        </div>
        <div className="stat-card">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center">
              <Receipt className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Transactions</p>
              <p className="text-lg font-bold text-foreground">{filtered.length}</p>
            </div>
          </div>
        </div>
        <div className="stat-card col-span-2">
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-muted-foreground shrink-0" />
            <div className="flex flex-wrap items-center gap-1.5">
              {PERIOD_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setPeriod(opt.value)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${period === opt.value ? 'bg-blue-600 text-white' : 'bg-muted/50 text-muted-foreground hover:bg-muted'}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {period === 'custom' && (
              <div className="flex items-center gap-1.5 ml-1">
                <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} className="border border-border rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
                <span className="text-xs text-muted-foreground">to</span>
                <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} className="border border-border rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Expenses by Category */}
      {expensesByCategory.size > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {Array.from(expensesByCategory.entries()).map(([name, total]) => (
            <div key={name} className="bg-white rounded-xl border border-border p-4">
              <p className="text-xs text-muted-foreground truncate">{name}</p>
              <p className="text-lg font-bold text-red-600">{formatCurrency(total)}</p>
            </div>
          ))}
        </div>
      )}

      {/* Filters bar */}
      <div className="bg-white rounded-xl border border-border p-4 shadow-sm">
        <div className="flex flex-wrap gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <input
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1); }}
              placeholder="Search by description, entry #, or account..."
              className="w-full px-4 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
          </div>
          <select
            value={filterType}
            onChange={e => { setFilterType(e.target.value); setPage(1); }}
            className="border border-border rounded-lg px-3 py-2 text-sm focus:outline-none"
          >
            <option value="">All Expense Types</option>
            {expenseAccounts.map(a => (
              <option key={a.id} value={a.id}>{a.code} - {a.name}</option>
            ))}
          </select>
          {(filterType || search) && (
            <button
              onClick={() => { setFilterType(''); setSearch(''); setPage(1); }}
              className="flex items-center gap-1 px-3 py-2 text-xs text-muted-foreground hover:text-red-600 border border-border rounded-lg transition"
            >
              <X className="w-3.5 h-3.5" />Clear
            </button>
          )}
        </div>
      </div>

      {/* Expenses List */}
      <div className="table-wrapper">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-muted/40 border-b border-border">
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Date</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Entry #</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Description</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Expense Type</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Paid From</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Amount</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 7 }).map((_, j) => (
                      <td key={j} className="px-4 py-3"><div className="h-4 bg-muted rounded animate-pulse" /></td>
                    ))}
                  </tr>
                ))
              ) : pagedExpenses.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground text-sm">
                    <Receipt className="w-12 h-12 mx-auto mb-3 text-muted-foreground/40" />
                    No expenses found. Click &quot;Add Expense&quot; to record your first expense.
                  </td>
                </tr>
              ) : (
                pagedExpenses.map(exp => {
                  const expAccount = getExpenseAccount(exp);
                  const paidAccount = getPaidFromAccount(exp);
                  return (
                    <tr key={exp.id} className="hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3 text-sm text-muted-foreground">{formatDate(exp.entry_date)}</td>
                      <td className="px-4 py-3 text-sm font-semibold text-blue-600">{exp.entry_number}</td>
                      <td className="px-4 py-3 text-sm text-foreground">{exp.description}</td>
                      <td className="px-4 py-3 text-sm text-foreground">
                        {expAccount ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-red-50 text-red-700 text-xs rounded-full">
                            {expAccount.account?.name || '—'}
                          </span>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {paidAccount ? `${paidAccount.account?.code} - ${paidAccount.account?.name}` : '—'}
                      </td>
                      <td className="px-4 py-3 text-sm font-bold text-red-600 text-right">{formatCurrency(exp.total_debit)}</td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => { setEditingExpense(exp); setShowModal(true); }}
                            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-amber-50 text-muted-foreground hover:text-amber-600 transition"
                            title="Edit Expense"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => setDeletingExpense(exp)}
                            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-red-50 text-muted-foreground hover:text-red-600 transition"
                            title="Delete Expense"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {!loading && filtered.length > 0 && (
          <AppPagination
            page={currentPage}
            pageSize={pageSize}
            total={filtered.length}
            onPageChange={setPage}
            onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
          />
        )}
      </div>

      {showModal && (
        <ExpenseModal
          expenseAccounts={expenseAccounts}
          cashBankAccounts={cashBankAccounts}
          editingExpense={editingExpense}
          onClose={() => { setShowModal(false); setEditingExpense(null); }}
          onSaved={() => { loadData(); setShowModal(false); setEditingExpense(null); }}
        />
      )}

      {deletingExpense && (
        <DeleteConfirmModal
          expense={deletingExpense}
          onClose={() => setDeletingExpense(null)}
          onConfirm={() => handleDelete(deletingExpense)}
        />
      )}
    </div>
  );
}

function ExpenseModal({ expenseAccounts, cashBankAccounts, editingExpense, onClose, onSaved }: {
  expenseAccounts: Account[];
  cashBankAccounts: Account[];
  editingExpense: ExpenseEntry | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const expAccount = editingExpense ? editingExpense.lines?.find(l => Number(l.debit) > 0 && l.account?.account_type === 'expense') : null;
  const paidAccount = editingExpense ? editingExpense.lines?.find(l => Number(l.credit) > 0) : null;

  const [form, setForm] = useState({
    date: editingExpense?.entry_date || new Date().toISOString().split('T')[0],
    amount: editingExpense ? String(editingExpense.total_debit) : '',
    expense_account: expAccount?.account_id || '',
    paid_from: paidAccount?.account_id || '',
    description: editingExpense?.description || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showNewAccount, setShowNewAccount] = useState(false);
  const [newAccountName, setNewAccountName] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (!form.expense_account || !form.paid_from || !form.amount || parseFloat(form.amount) <= 0) {
      setError('Please fill all required fields');
      return;
    }

    setSaving(true);

    try {
      const amount = parseFloat(form.amount);
      let expenseAccountId = form.expense_account;

      // If creating new account
      if (form.expense_account === 'create_new' && newAccountName) {
        const newCode = `6${String(Date.now()).slice(-3)}`;
        const { data: newAccount } = await supabase
          .from('accounts')
          .insert({ code: newCode, name: newAccountName, account_type: 'expense' })
          .select()
          .single();
        if (newAccount) {
          expenseAccountId = newAccount.id;
        }
      }

      if (editingExpense) {
        // EDIT: reverse old lines' account balances, delete old lines, insert new lines, apply new balances
        for (const line of editingExpense.lines || []) {
          const acct = [...expenseAccounts, ...cashBankAccounts].find(a => a.id === line.account_id);
          if (!acct) {
            const { data: fresh } = await supabase.from('accounts').select('balance').eq('id', line.account_id).maybeSingle();
            if (fresh) {
              await supabase.from('accounts').update({
                balance: (Number(fresh.balance) || 0) - Number(line.debit) + Number(line.credit),
              }).eq('id', line.account_id);
            }
          } else {
            await supabase.from('accounts').update({
              balance: (Number(acct.balance) || 0) - Number(line.debit) + Number(line.credit),
            }).eq('id', line.account_id);
          }
        }

        // Delete old lines
        await supabase.from('journal_lines').delete().eq('journal_entry_id', editingExpense.id);

        // Update entry
        await supabase.from('journal_entries').update({
          entry_date: form.date,
          description: form.description || 'Expense payment',
          total_debit: amount,
          total_credit: amount,
        }).eq('id', editingExpense.id);

        // Insert new lines
        await supabase.from('journal_lines').insert([
          { journal_entry_id: editingExpense.id, account_id: expenseAccountId, description: form.description, debit: amount, credit: 0, sort_order: 0 },
          { journal_entry_id: editingExpense.id, account_id: form.paid_from, description: form.description, debit: 0, credit: amount, sort_order: 1 },
        ]);

        // Apply new account balances (fetch fresh balances to avoid stale state)
        const { data: newExpAcct } = await supabase.from('accounts').select('balance').eq('id', expenseAccountId).maybeSingle();
        if (newExpAcct) {
          await supabase.from('accounts').update({ balance: (Number(newExpAcct.balance) || 0) + amount }).eq('id', expenseAccountId);
        }
        const { data: newCashAcct } = await supabase.from('accounts').select('balance').eq('id', form.paid_from).maybeSingle();
        if (newCashAcct) {
          await supabase.from('accounts').update({ balance: (Number(newCashAcct.balance) || 0) - amount }).eq('id', form.paid_from);
        }

        toast({ title: 'Updated', description: 'Expense updated and accounts adjusted' });
      } else {
        // CREATE: new entry
        const entryNumber = await supabase.rpc('get_next_journal_number');

        const { data: entry } = await supabase
          .from('journal_entries')
          .insert({
            entry_number: entryNumber.data || `JE-${Date.now().toString().slice(-6)}`,
            entry_date: form.date,
            description: form.description || 'Expense payment',
            reference_type: 'manual',
            total_debit: amount,
            total_credit: amount,
            is_posted: true,
          })
          .select()
          .single();

        if (!entry) throw new Error('Failed to create entry');

        await supabase.from('journal_lines').insert([
          { journal_entry_id: entry.id, account_id: expenseAccountId, description: form.description, debit: amount, credit: 0, sort_order: 0 },
          { journal_entry_id: entry.id, account_id: form.paid_from, description: form.description, debit: 0, credit: amount, sort_order: 1 },
        ]);

        // Update balances
        const expenseAccount = expenseAccounts.find(a => a.id === expenseAccountId);
        const cashAccount = cashBankAccounts.find(a => a.id === form.paid_from);

        if (expenseAccount) {
          await supabase.from('accounts').update({ balance: (expenseAccount.balance || 0) + amount }).eq('id', expenseAccountId);
        }
        if (cashAccount) {
          await supabase.from('accounts').update({ balance: (cashAccount.balance || 0) - amount }).eq('id', form.paid_from);
        }

        toast({ title: 'Success', description: 'Expense recorded successfully' });
      }

      onSaved();
    } catch (err: any) {
      setError(err.message || 'Failed to save expense');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-base font-bold">{editingExpense ? 'Edit Expense' : 'Add Expense'}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">Date</label>
              <input type="date" required value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Amount *</label>
              <input type="number" required value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} placeholder="0" className="w-full border border-border rounded-lg px-3 py-2 text-sm" />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Expense Category *</label>
            <select
              required
              value={form.expense_account}
              onChange={e => {
                setForm({ ...form, expense_account: e.target.value });
                setShowNewAccount(e.target.value === 'create_new');
              }}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm"
            >
              <option value="">Select category</option>
              {expenseAccounts.map(a => (
                <option key={a.id} value={a.id}>{a.code} - {a.name}</option>
              ))}
              <option value="create_new">+ Add New Category</option>
            </select>
            {showNewAccount && (
              <input
                value={newAccountName}
                onChange={e => setNewAccountName(e.target.value)}
                placeholder="Enter new expense category name"
                className="w-full border border-border rounded-lg px-3 py-2 text-sm mt-2"
              />
            )}
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Paid From *</label>
            <select required value={form.paid_from} onChange={e => setForm({ ...form, paid_from: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm">
              <option value="">Select payment source</option>
              {cashBankAccounts.map(a => (
                <option key={a.id} value={a.id}>{a.code} - {a.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Description</label>
            <input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="e.g. Office supplies, Electricity bill" className="w-full border border-border rounded-lg px-3 py-2 text-sm" />
          </div>

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Cancel</button>
            <button type="submit" disabled={saving} className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-60">
              {saving ? 'Saving...' : editingExpense ? 'Update Expense' : 'Save Expense'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function DeleteConfirmModal({ expense, onClose, onConfirm }: {
  expense: ExpenseEntry;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-sm shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-base font-bold text-red-600">Delete Expense</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-6 space-y-4">
          <p className="text-sm text-muted-foreground">
            Are you sure you want to delete expense <span className="font-semibold text-foreground">{expense.entry_number}</span>?
            This will reverse the journal entry and restore account balances. This cannot be undone.
          </p>
          <div className="bg-muted/40 rounded-lg p-3 space-y-1">
            <p className="text-xs text-muted-foreground">Date: {formatDate(expense.entry_date)}</p>
            <p className="text-xs text-muted-foreground">Description: {expense.description}</p>
            <p className="text-xs font-bold text-red-600">Amount: {formatCurrency(expense.total_debit)}</p>
          </div>
          <div className="flex gap-3">
            <button onClick={onClose} className="flex-1 px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Cancel</button>
            <button onClick={onConfirm} className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-semibold transition">
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
