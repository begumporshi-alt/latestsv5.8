'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCurrency, formatDate } from '@/lib/format';
import { toast } from '@/hooks/use-toast';
import { Plus, X, Pencil, Trash2, ExternalLink, Search, AlertTriangle, ToggleLeft, ToggleRight, Info } from 'lucide-react';
import type { Account } from '@/lib/types';
import Link from 'next/link';

const typeColors: Record<string, string> = {
  asset: 'text-blue-600 bg-blue-50',
  liability: 'text-red-600 bg-red-50',
  equity: 'text-purple-600 bg-purple-50',
  revenue: 'text-green-600 bg-green-50',
  expense: 'text-orange-600 bg-orange-50',
};

const accountTypes = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [deactivatingAccount, setDeactivatingAccount] = useState<Account | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('');

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);
    const { data } = await supabase.from('accounts').select('*').order('code');
    setAccounts(data || []);
    setLoading(false);
  }

  async function handleDeactivate() {
    if (!deactivatingAccount) return;
    const { error } = await supabase.from('accounts').update({ is_active: false }).eq('id', deactivatingAccount.id);
    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    } else {
      toast({ title: 'Account deactivated', description: `${deactivatingAccount.name} is now inactive` });
      loadData();
    }
    setDeactivatingAccount(null);
  }

  async function handleReactivate(account: Account) {
    const { error } = await supabase.from('accounts').update({ is_active: true }).eq('id', account.id);
    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    } else {
      toast({ title: 'Account reactivated', description: `${account.name} is now active` });
      loadData();
    }
  }

  const activeAccounts = accounts.filter(a => a.is_active);
  const displayedAccounts = (showInactive ? accounts : activeAccounts).filter(a => {
    if (typeFilter && a.account_type !== typeFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return a.code.toLowerCase().includes(q) || a.name.toLowerCase().includes(q);
    }
    return true;
  });
  const inactiveCount = accounts.filter(a => !a.is_active).length;
  const totalAssets = activeAccounts.filter(a => a.account_type === 'asset').reduce((s, a) => s + a.balance, 0);
  const totalLiabilities = activeAccounts.filter(a => a.account_type === 'liability').reduce((s, a) => s + a.balance, 0);

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Chart of Accounts</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Manage all accounting ledger accounts</p>
        </div>
        <button onClick={() => setShowCreateModal(true)} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition">
          <Plus className="w-4 h-4" />Add Account
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Total Assets', value: formatCurrency(totalAssets), color: 'text-blue-600' },
          { label: 'Total Liabilities', value: formatCurrency(totalLiabilities), color: 'text-red-600' },
          { label: 'Active Accounts', value: activeAccounts.length, color: 'text-foreground' },
          { label: 'Cash / Bank', value: activeAccounts.filter(a => a.is_cash || a.is_bank).length, color: 'text-green-600' },
        ].map(s => (
          <div key={s.label} className="stat-card">
            <p className="text-xs text-muted-foreground">{s.label}</p>
            <p className={`text-xl font-bold mt-1 ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Search + filter bar */}
      <div className="bg-white rounded-xl border border-border p-3 shadow-sm flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 flex-1 min-w-[200px]">
          <Search className="w-4 h-4 text-muted-foreground shrink-0" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by code or name…"
            className="flex-1 text-sm focus:outline-none bg-transparent placeholder:text-muted-foreground"
          />
          {search && (
            <button onClick={() => setSearch('')} className="text-muted-foreground hover:text-foreground">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {(['', ...accountTypes] as string[]).map(t => (
            <button
              key={t}
              onClick={() => setTypeFilter(t)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition capitalize ${
                typeFilter === t ? 'bg-blue-600 text-white' : 'bg-muted/40 text-muted-foreground hover:bg-muted'
              }`}
            >
              {t === '' ? 'All Types' : t}
            </button>
          ))}
        </div>
      </div>

      <div className="table-wrapper">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <span className="text-sm font-semibold text-foreground">
            {displayedAccounts.length} {displayedAccounts.length === 1 ? 'account' : 'accounts'}
            {(search || typeFilter) && <span className="text-muted-foreground font-normal"> (filtered)</span>}
          </span>
          {inactiveCount > 0 && (
            <button
              onClick={() => setShowInactive(v => !v)}
              className={`text-xs px-3 py-1.5 rounded-lg border transition font-medium ${
                showInactive
                  ? 'bg-amber-50 text-amber-700 border-amber-200'
                  : 'bg-muted/40 text-muted-foreground border-border hover:bg-muted'
              }`}
            >
              {showInactive ? `Hide ${inactiveCount} inactive` : `Show ${inactiveCount} inactive`}
            </button>
          )}
        </div>
        <table className="w-full">
          <thead>
            <tr className="bg-muted/40 border-b border-border">
              {['Code', 'Account Name', 'Type', 'Balance', 'Cash/Bank', 'Actions'].map(h => (
                <th key={h} className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading
              ? Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>{Array.from({ length: 6 }).map((_, j) => (
                    <td key={j} className="px-4 py-3"><div className="h-4 bg-muted rounded animate-pulse" /></td>
                  ))}</tr>
                ))
              : displayedAccounts.length === 0
              ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-muted-foreground text-sm">
                    {search || typeFilter ? 'No accounts match your search.' : 'No accounts found.'}
                  </td>
                </tr>
              )
              : displayedAccounts.map(a => (
                <tr key={a.id} className={`hover:bg-muted/30 transition-colors ${!a.is_active ? 'opacity-50' : ''}`}>
                  <td className="px-4 py-3 font-mono text-sm text-muted-foreground">{a.code}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Link href={`/accounting/accounts/${a.id}`} className="text-sm font-semibold text-foreground hover:text-blue-600 transition">
                        {a.name}
                      </Link>
                      {!a.is_active && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">inactive</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`badge-status ${typeColors[a.account_type] || 'bg-gray-100 text-gray-600'} capitalize`}>
                      {a.account_type}
                    </span>
                  </td>
                  <td className={`px-4 py-3 text-sm font-bold ${
                    a.account_type === 'expense' || a.account_type === 'liability' ? 'text-red-600' : 'text-green-600'
                  }`}>
                    <Link href={`/accounting/accounts/${a.id}`} className="hover:underline">
                      {formatCurrency(a.balance)}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">
                    {a.is_cash ? 'Cash' : a.is_bank ? 'Bank' : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <Link
                        href={`/accounting/accounts/${a.id}`}
                        className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-blue-50 text-muted-foreground hover:text-blue-600 transition"
                        title="View Details"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </Link>
                      <button
                        onClick={() => setEditingAccount(a)}
                        className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-blue-50 text-muted-foreground hover:text-blue-600 transition"
                        title="Edit account"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      {a.is_active ? (
                        <button
                          onClick={() => setDeactivatingAccount(a)}
                          className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-red-50 text-muted-foreground hover:text-red-600 transition"
                          title="Deactivate account"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      ) : (
                        <button
                          onClick={() => handleReactivate(a)}
                          className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-green-50 text-muted-foreground hover:text-green-600 transition"
                          title="Reactivate account"
                        >
                          <ToggleRight className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            }
          </tbody>
        </table>
      </div>

      {showCreateModal && (
        <CreateAccountModal onClose={() => setShowCreateModal(false)} onSaved={loadData} />
      )}
      {editingAccount && (
        <EditAccountModal account={editingAccount} onClose={() => setEditingAccount(null)} onSaved={loadData} />
      )}
      {deactivatingAccount && (
        <DeactivateModal account={deactivatingAccount} onClose={() => setDeactivatingAccount(null)} onConfirm={handleDeactivate} />
      )}
    </div>
  );
}


// CREATE ACCOUNT MODAL
function CreateAccountModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    code: '',
    name: '',
    account_type: 'asset' as Account['account_type'],
    parent_id: '',
    is_cash: false,
    is_bank: false,
    bank_name: '',
    account_number: '',
    balance: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const openingBalance = parseFloat(form.balance || '0');

      const { data: newAccount, error: createError } = await supabase
        .from('accounts')
        .insert({
          code: form.code,
          name: form.name,
          account_type: form.account_type,
          parent_id: form.parent_id || null,
          is_cash: form.is_cash,
          is_bank: form.is_bank,
          bank_name: form.bank_name || null,
          account_number: form.account_number || null,
          balance: 0,
          is_active: true,
        })
        .select()
        .single();

      if (createError) throw createError;

      // If opening balance > 0, post a journal entry against Opening Balance Equity
      if (openingBalance > 0) {
        const { data: equityAccount } = await supabase
          .from('accounts')
          .select('id')
          .eq('code', '3900')
          .maybeSingle();

        if (equityAccount) {
          const { data: jeNum } = await supabase.rpc('get_next_journal_number');
          const isDebitNormal = form.account_type === 'asset' || form.account_type === 'expense';
          const debitAccountId = isDebitNormal ? newAccount.id : equityAccount.id;
          const creditAccountId = isDebitNormal ? equityAccount.id : newAccount.id;

          const { data: entry, error: entryError } = await supabase
            .from('journal_entries')
            .insert({
              entry_number: jeNum || `JE-${Date.now().toString().slice(-6)}`,
              entry_date: new Date().toISOString().split('T')[0],
              description: `Opening Balance - ${form.name}`,
              reference_type: 'opening_balance',
              total_debit: openingBalance,
              total_credit: openingBalance,
              is_posted: true,
            })
            .select()
            .single();

          if (entryError) throw entryError;

          await supabase.from('journal_lines').insert([
            {
              journal_entry_id: entry.id,
              account_id: debitAccountId,
              description: `Opening Balance - ${form.name}`,
              debit: openingBalance,
              credit: 0,
              sort_order: 0,
            },
            {
              journal_entry_id: entry.id,
              account_id: creditAccountId,
              description: `Opening Balance - ${form.name}`,
              debit: 0,
              credit: openingBalance,
              sort_order: 1,
            },
          ]);

          await supabase.rpc('increment_account_balance', {
            p_account_id: newAccount.id,
            p_delta: isDebitNormal ? openingBalance : -openingBalance,
          });
          await supabase.rpc('increment_account_balance', {
            p_account_id: equityAccount.id,
            p_delta: isDebitNormal ? -openingBalance : openingBalance,
          });
        } else {
          // Fallback: direct balance update if Opening Balance Equity doesn't exist
          await supabase
            .from('accounts')
            .update({ balance: openingBalance })
            .eq('id', newAccount.id);
        }
      }

      toast({ title: 'Success', description: `Account ${form.code} created successfully` });
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to create account');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-2xl shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-white z-10">
          <h2 className="text-base font-bold">Create Account</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">Code *</label>
              <input
                type="text"
                required
                value={form.code}
                onChange={e => setForm({ ...form, code: e.target.value })}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm"
                placeholder="e.g. 1000"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Account Type *</label>
              <select
                required
                value={form.account_type}
                onChange={e => setForm({ ...form, account_type: e.target.value as Account['account_type'] })}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm capitalize"
              >
                {accountTypes.map(t => (
                  <option key={t} value={t} className="capitalize">{t}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Account Name *</label>
            <input
              type="text"
              required
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm"
              placeholder="e.g. Cash on Hand"
            />
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Opening Balance</label>
            <input
              type="number"
              value={form.balance}
              onChange={e => setForm({ ...form, balance: e.target.value })}
              placeholder="0"
              className="w-full border border-border rounded-lg px-3 py-2 text-sm"
            />
            <p className="text-[11px] text-muted-foreground mt-1">
              A journal entry will be posted to Opening Balance Equity (3900) to record this amount.
            </p>
          </div>

          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.is_cash}
                onChange={e => setForm({ ...form, is_cash: e.target.checked, is_bank: e.target.checked ? false : form.is_bank })}
                className="w-4 h-4 rounded border-border"
              />
              <span className="text-sm">Cash Account</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.is_bank}
                onChange={e => setForm({ ...form, is_bank: e.target.checked, is_cash: e.target.checked ? false : form.is_cash })}
                className="w-4 h-4 rounded border-border"
              />
              <span className="text-sm">Bank Account</span>
            </label>
          </div>

          {form.is_bank && (
            <div className="grid grid-cols-2 gap-4 p-4 bg-muted/30 rounded-lg">
              <div>
                <label className="block text-xs font-medium mb-1">Bank Name</label>
                <input
                  type="text"
                  value={form.bank_name}
                  onChange={e => setForm({ ...form, bank_name: e.target.value })}
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm"
                  placeholder="e.g. Dhaka Bank"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Account Number</label>
                <input
                  type="text"
                  value={form.account_number}
                  onChange={e => setForm({ ...form, account_number: e.target.value })}
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm"
                  placeholder="e.g. 12345678"
                />
              </div>
            </div>
          )}

          <div className="flex items-center gap-3 pt-4 border-t border-border">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 border border-border rounded-lg text-sm font-medium hover:bg-muted/50 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-50"
            >
              {saving ? 'Creating...' : 'Create Account'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// EDIT ACCOUNT MODAL
function EditAccountModal({ account, onClose, onSaved }: { account: Account; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: account.name,
    account_type: account.account_type,
    is_cash: account.is_cash,
    is_bank: account.is_bank,
    bank_name: account.bank_name || '',
    account_number: account.account_number || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showTypeChangeWarning, setShowTypeChangeWarning] = useState(false);
  const [entryCount, setEntryCount] = useState(0);

  useEffect(() => {
    supabase.from('journal_lines')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', account.id)
      .then(({ count }) => setEntryCount(count || 0));
  }, [account.id]);

  const typeChanged = form.account_type !== account.account_type;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (typeChanged && entryCount > 0 && !showTypeChangeWarning) {
      setShowTypeChangeWarning(true);
      return;
    }
    setError('');
    setSaving(true);
    try {
      const { error: updateError } = await supabase
        .from('accounts')
        .update({
          name: form.name,
          account_type: form.account_type,
          is_cash: form.is_cash,
          is_bank: form.is_bank,
          bank_name: form.bank_name || null,
          account_number: form.account_number || null,
        })
        .eq('id', account.id);

      if (updateError) throw updateError;

      toast({ title: 'Account updated', description: `${account.code} - ${form.name} saved` });
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to update account');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-2xl shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-white z-10">
          <h2 className="text-base font-bold">Edit Account</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>}

          {/* Account Context */}
          <div className="p-4 bg-muted/30 rounded-lg space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Code</span>
              <span className="font-mono text-sm font-semibold">{account.code}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Current Balance</span>
              <span className={`text-sm font-bold ${ 
                account.account_type === 'expense' || account.account_type === 'liability' 
                  ? 'text-red-600' 
                  : 'text-green-600' 
              }`}>
                {formatCurrency(account.balance)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Journal Entries</span>
              <span className="text-sm font-semibold">{entryCount}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Created</span>
              <span className="text-sm">{formatDate(account.created_at)}</span>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Account Name *</label>
            <input
              type="text"
              required
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Account Type *</label>
            <select
              required
              value={form.account_type}
              onChange={e => setForm({ ...form, account_type: e.target.value as Account['account_type'] })}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm capitalize"
            >
              {accountTypes.map(t => (
                <option key={t} value={t} className="capitalize">{t}</option>
              ))}
            </select>
            {typeChanged && entryCount > 0 && !showTypeChangeWarning && (
              <div className="mt-2 p-2.5 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700 flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <p>
                  Changing the account type will affect how existing journal entries are interpreted. This can flip
                  the balance direction for all {entryCount} historical entries. Proceed with caution.
                </p>
              </div>
            )}
          </div>

          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.is_cash}
                onChange={e => setForm({ ...form, is_cash: e.target.checked, is_bank: e.target.checked ? false : form.is_bank })}
                className="w-4 h-4 rounded border-border"
              />
              <span className="text-sm">Cash Account</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.is_bank}
                onChange={e => setForm({ ...form, is_bank: e.target.checked, is_cash: e.target.checked ? false : form.is_cash })}
                className="w-4 h-4 rounded border-border"
              />
              <span className="text-sm">Bank Account</span>
            </label>
          </div>

          {form.is_bank && (
            <div className="grid grid-cols-2 gap-4 p-4 bg-muted/30 rounded-lg">
              <div>
                <label className="block text-xs font-medium mb-1">Bank Name</label>
                <input
                  type="text"
                  value={form.bank_name}
                  onChange={e => setForm({ ...form, bank_name: e.target.value })}
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Account Number</label>
                <input
                  type="text"
                  value={form.account_number}
                  onChange={e => setForm({ ...form, account_number: e.target.value })}
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm"
                />
              </div>
            </div>
          )}

          {showTypeChangeWarning && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-lg space-y-2">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-red-700">Type Change Confirmation</p>
                  <p className="text-xs text-red-600 mt-1">
                    This account has {entryCount} journal entries. Changing from <strong>{account.account_type}</strong> to{' '}
                    <strong>{form.account_type}</strong> will flip the balance direction for all historical entries.
                    Are you sure?
                  </p>
                </div>
              </div>
            </div>
          )}

          <div className="flex items-center gap-3 pt-4 border-t border-border">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 border border-border rounded-lg text-sm font-medium hover:bg-muted/50 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-50"
            >
              {saving ? 'Saving...' : showTypeChangeWarning ? 'Yes, Change Type' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// DEACTIVATE MODAL
function DeactivateModal({ account, onClose, onConfirm }: { account: Account; onClose: () => void; onConfirm: () => void }) {
  const hasBalance = Math.abs(account.balance) > 0.01;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-base font-bold flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600" />
            Deactivate Account
          </h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 space-y-4">
          <p className="text-sm text-muted-foreground">
            You are about to deactivate <strong>{account.code} - {account.name}</strong>.
          </p>

          {hasBalance && (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700 flex items-start gap-2">
              <Info className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">This account has a non-zero balance:</p>
                <p className="mt-1">{formatCurrency(account.balance)}</p>
                <p className="mt-2 text-xs">
                  Deactivating will hide it from most views, but the balance will remain. Consider transferring or
                  adjusting the balance first.
                </p>
              </div>
            </div>
          )}

          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2 border border-border rounded-lg text-sm font-medium hover:bg-muted/50 transition"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-semibold transition"
            >
              Deactivate
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
