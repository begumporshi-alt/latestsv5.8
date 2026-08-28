'use client';

import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/format';
import { toast } from '@/hooks/use-toast';
import { Plus, ChevronDown, Receipt, User, Building2, X, Search } from 'lucide-react';
import CustomerSearchInput, { type CustomerResult } from '@/components/ui/CustomerSearchInput';
import SupplierSearchInput, { type SupplierResult } from '@/components/ui/SupplierSearchInput';

interface Account {
  id: string;
  code: string;
  name: string;
  account_type: string;
  is_cash?: boolean;
  is_bank?: boolean;
}

type ModalType = 'expense' | 'receivable' | 'payable' | null;

export default function RecordButton({ onSaved, variant = 'full' }: { onSaved?: () => void; variant?: 'full' | 'receivable' | 'payable' }) {
  const [modalType, setModalType] = useState<ModalType>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);

  useEffect(() => {
    supabase.from('accounts').select('id, code, name, account_type, is_cash, is_bank').order('code')
      .then(({ data }) => { if (data) setAccounts(data); });
  }, []);

  const options = [
    ...(variant === 'full' || variant === 'receivable'
      ? [{ label: 'Record Receivable', desc: 'Money owed by a customer', icon: User, color: 'text-green-600 bg-green-50', onClick: () => setModalType('receivable') }]
      : []),
    ...(variant === 'full' || variant === 'payable'
      ? [{ label: 'Record Payable', desc: 'Money owed to a supplier', icon: Building2, color: 'text-amber-600 bg-amber-50', onClick: () => setModalType('payable') }]
      : []),
    ...(variant === 'full'
      ? [{ label: 'Record Expense', desc: 'Rent, salary, utility, etc.', icon: Receipt, color: 'text-blue-600 bg-blue-50', onClick: () => setModalType('expense') }]
      : []),
  ];

  return (
    <>
      <RecordDropdown options={options} />
      {modalType === 'expense' && <QuickExpenseModal accounts={accounts} onSaved={onSaved} onClose={() => setModalType(null)} />}
      {modalType === 'receivable' && <RecordReceivableModal accounts={accounts} onSaved={onSaved} onClose={() => setModalType(null)} />}
      {modalType === 'payable' && <RecordPayableModal accounts={accounts} onSaved={onSaved} onClose={() => setModalType(null)} />}
    </>
  );
}

function RecordDropdown({ options }: { options: { label: string; desc: string; icon: React.ElementType; color: string; onClick: () => void }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-3 sm:px-4 py-2 rounded-lg text-sm font-semibold transition whitespace-nowrap">
        <Plus className="w-4 h-4 shrink-0" /><span className="hidden sm:inline">Record</span>
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-white border border-border rounded-xl shadow-lg z-50 w-64 overflow-hidden">
          {options.map((opt, i) => (
            <button key={i} onClick={() => { opt.onClick(); setOpen(false); }} className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/50 transition text-left border-b border-border/50 last:border-0">
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${opt.color}`}>
                <opt.icon className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">{opt.label}</p>
                <p className="text-xs text-muted-foreground truncate">{opt.desc}</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function QuickExpenseModal({ accounts, onSaved, onClose }: { accounts: Account[]; onSaved?: () => void; onClose: () => void }) {
  const [form, setForm] = useState({ date: new Date().toISOString().split('T')[0], amount: '', expense_account: '', paid_from: '', description: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const expenseAccounts = accounts.filter(a => a.account_type === 'expense' && !['5000', '4050', '4100', '4200'].includes(a.code));
  const cashBankAccounts = accounts.filter(a => a.is_cash || a.is_bank);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!form.expense_account || !form.paid_from || !form.amount || parseFloat(form.amount) <= 0) { setError('Please fill all required fields'); return; }
    setSaving(true);
    try {
      const amount = parseFloat(form.amount);
      const { data: jeNum } = await supabase.rpc('get_next_journal_number');
      const { data: entry, error: entryError } = await supabase.from('journal_entries').insert({
        entry_number: jeNum || `JE-${Date.now().toString().slice(-6)}`,
        entry_date: form.date, description: form.description || 'Expense payment',
        reference_type: 'manual', total_debit: amount, total_credit: amount, is_posted: true,
      }).select().single();
      if (entryError) throw entryError;
      await supabase.from('journal_lines').insert([
        { journal_entry_id: entry.id, account_id: form.expense_account, description: form.description, debit: amount, credit: 0, sort_order: 0 },
        { journal_entry_id: entry.id, account_id: form.paid_from, description: form.description, debit: 0, credit: amount, sort_order: 1 },
      ]);
      await supabase.rpc('increment_account_balance', { p_account_id: form.expense_account, p_delta: amount });
      await supabase.rpc('increment_account_balance', { p_account_id: form.paid_from, p_delta: -amount });
      toast({ title: 'Success', description: 'Expense recorded successfully' });
      onSaved?.(); onClose();
    } catch (err: any) { setError(err.message || 'Failed to record expense'); }
    finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-base font-bold">Quick Expense Entry</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>}
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-xs font-medium mb-1">Date</label><input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm" /></div>
            <div><label className="block text-xs font-medium mb-1">Amount *</label><input type="number" required value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} placeholder="0" className="w-full border border-border rounded-lg px-3 py-2 text-sm" /></div>
          </div>
          <div><label className="block text-xs font-medium mb-1">Expense Type *</label><select required value={form.expense_account} onChange={e => setForm({ ...form, expense_account: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm"><option value="">Select expense category</option>{expenseAccounts.map(a => <option key={a.id} value={a.id}>{a.code} - {a.name}</option>)}</select></div>
          <div><label className="block text-xs font-medium mb-1">Paid From *</label><select required value={form.paid_from} onChange={e => setForm({ ...form, paid_from: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm"><option value="">Select cash/bank account</option>{cashBankAccounts.map(a => <option key={a.id} value={a.id}>{a.code} - {a.name}</option>)}</select></div>
          <div><label className="block text-xs font-medium mb-1">Description</label><input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="e.g. Office supplies, Rent payment" className="w-full border border-border rounded-lg px-3 py-2 text-sm" /></div>
          <div className="flex gap-3 pt-2"><button type="button" onClick={onClose} className="flex-1 px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Cancel</button><button type="submit" disabled={saving} className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-60">{saving ? 'Saving...' : 'Record Expense'}</button></div>
        </form>
      </div>
    </div>
  );
}

function RecordReceivableModal({ accounts, onSaved, onClose }: { accounts: Account[]; onSaved?: () => void; onClose: () => void }) {
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerResult | null>(null);
  const [form, setForm] = useState({ amount: '', description: '', date: new Date().toISOString().split('T')[0], offset_account_id: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const manualReceivableAccount = accounts.find(a => a.code === '1300');
  const offsetAccounts = accounts.filter(a => ['revenue', 'equity', 'liability'].includes(a.account_type));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!selectedCustomer || !form.amount || parseFloat(form.amount) <= 0) { setError('Please select a customer and enter an amount'); return; }
    if (!form.offset_account_id) { setError('Please select an offset account'); return; }
    setSaving(true);
    try {
      const amount = parseFloat(form.amount);
      const offsetAcc = accounts.find(a => a.id === form.offset_account_id);
      const desc = form.description || `Receivable from ${selectedCustomer.name}`;
      const { data: jeNum } = await supabase.rpc('get_next_journal_number');
      const { data: entry, error: entryError } = await supabase.from('journal_entries').insert({
        entry_number: jeNum || `JE-${Date.now().toString().slice(-6)}`,
        entry_date: form.date, description: desc, reference_type: 'receivable',
        total_debit: amount, total_credit: amount, is_posted: true, customer_id: selectedCustomer.id,
      }).select().single();
      if (entryError) throw entryError;
      if (!manualReceivableAccount || !offsetAcc) throw new Error('Required accounts not found');
      await supabase.from('journal_lines').insert([
        { journal_entry_id: entry.id, account_id: manualReceivableAccount.id, description: desc, debit: amount, credit: 0, sort_order: 0 },
        { journal_entry_id: entry.id, account_id: offsetAcc.id, description: desc, debit: 0, credit: amount, sort_order: 1 },
      ]);
      await supabase.rpc('increment_account_balance', { p_account_id: manualReceivableAccount.id, p_delta: amount });
      await supabase.rpc('increment_account_balance', { p_account_id: offsetAcc.id, p_delta: amount });
      // Fetch fresh customer balance to avoid stale state
      const { data: currentCust } = await supabase.from('customers').select('outstanding_balance, total_purchases').eq('id', selectedCustomer.id).maybeSingle();
      if (currentCust) {
        await supabase.from('customers').update({
          outstanding_balance: (currentCust.outstanding_balance || 0) + amount,
          total_purchases: (currentCust.total_purchases || 0) + amount,
        }).eq('id', selectedCustomer.id);
      }
      toast({ title: 'Success', description: `Receivable of ${formatCurrency(amount)} recorded` });
      onSaved?.(); onClose();
    } catch (err: any) { setError(err.message || 'Failed to record receivable'); }
    finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-base font-bold flex items-center gap-2"><User className="w-4 h-4" />Record Receivable</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>}
          <div>
            <label className="block text-xs font-medium mb-1">Customer *</label>
            {selectedCustomer ? (
              <div className="flex items-center justify-between border border-blue-300 bg-blue-50 rounded-lg px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground truncate">{selectedCustomer.name}</p>
                  <p className="text-xs text-muted-foreground">{selectedCustomer.code || ''}{selectedCustomer.code && selectedCustomer.phone ? ' · ' : ''}{selectedCustomer.phone || ''}</p>
                </div>
                <button type="button" onClick={() => setSelectedCustomer(null)} className="text-muted-foreground hover:text-red-500 shrink-0 ml-2"><X className="w-4 h-4" /></button>
              </div>
            ) : (
              <CustomerSearchInput onSelect={(c) => setSelectedCustomer(c)} placeholder="Search customer by name, code, or phone..." />
            )}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-xs font-medium mb-1">Amount *</label><input type="number" required min="0.01" step="0.01" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} placeholder="0.00" className="w-full border border-border rounded-lg px-3 py-2 text-sm" /></div>
            <div><label className="block text-xs font-medium mb-1">Date</label><input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm" /></div>
          </div>
          <div><label className="block text-xs font-medium mb-1">Offset Account (Credit) *</label><select required value={form.offset_account_id} onChange={e => setForm({ ...form, offset_account_id: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm"><option value="">Select offset account</option>{offsetAccounts.map(a => <option key={a.id} value={a.id}>{a.code} - {a.name}</option>)}</select><p className="text-[11px] text-muted-foreground mt-1">Choose where the credit goes: Sales Revenue for credit sales, Service Revenue for services, Opening Balance Equity for opening balances, Other Income for miscellaneous.</p></div>
          <div className="bg-muted/30 rounded-lg p-3 text-xs text-muted-foreground">Dr. Manual Receivable ({manualReceivableAccount?.code || '1300'}) &rarr; Cr. {accounts.find(a => a.id === form.offset_account_id) ? `${accounts.find(a => a.id === form.offset_account_id)!.code} - ${accounts.find(a => a.id === form.offset_account_id)!.name}` : 'Select offset account'}</div>
          <div><label className="block text-xs font-medium mb-1">Description</label><input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="e.g. Credit sale, Service billed, Opening balance..." className="w-full border border-border rounded-lg px-3 py-2 text-sm" /></div>
          <div className="flex gap-3 pt-2"><button type="button" onClick={onClose} className="flex-1 px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Cancel</button><button type="submit" disabled={saving} className="flex-1 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-60">{saving ? 'Saving...' : 'Record'}</button></div>
        </form>
      </div>
    </div>
  );
}

function RecordPayableModal({ accounts, onSaved, onClose }: { accounts: Account[]; onSaved?: () => void; onClose: () => void }) {
  const [selectedSupplier, setSelectedSupplier] = useState<SupplierResult | null>(null);
  const [form, setForm] = useState({ amount: '', description: '', date: new Date().toISOString().split('T')[0], debit_account_id: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const apAccount = accounts.find(a => a.code === '2000');
  const debitAccounts = accounts.filter(a => (a.account_type === 'asset' || a.account_type === 'expense') && !a.is_cash && !a.is_bank);

  useEffect(() => {
    const invAccount = accounts.find(a => a.code === '1200');
    if (invAccount) setForm(f => ({ ...f, debit_account_id: invAccount.id }));
  }, [accounts]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!selectedSupplier || !form.amount || parseFloat(form.amount) <= 0) { setError('Please select a supplier and enter an amount'); return; }
    if (!form.debit_account_id) { setError('Please select a debit account'); return; }
    setSaving(true);
    try {
      const amount = parseFloat(form.amount);
      const desc = form.description || `Payable to ${selectedSupplier.name}`;
      const { data: jeNum } = await supabase.rpc('get_next_journal_number');
      const { data: entry, error: entryError } = await supabase.from('journal_entries').insert({
        entry_number: jeNum || `JE-${Date.now().toString().slice(-6)}`,
        entry_date: form.date, description: desc, reference_type: 'payable',
        total_debit: amount, total_credit: amount, is_posted: true, supplier_id: selectedSupplier.id,
      }).select().single();
      if (entryError) throw entryError;
      if (!apAccount) throw new Error('Accounts Payable account (2000) not found');
      await supabase.from('journal_lines').insert([
        { journal_entry_id: entry.id, account_id: form.debit_account_id, description: desc, debit: amount, credit: 0, sort_order: 0 },
        { journal_entry_id: entry.id, account_id: apAccount.id, description: desc, debit: 0, credit: amount, sort_order: 1 },
      ]);
      const debitAcc = accounts.find(a => a.id === form.debit_account_id);
      const debitDelta = (debitAcc?.account_type === 'asset' || debitAcc?.account_type === 'expense') ? amount : -amount;
      await supabase.rpc('increment_account_balance', { p_account_id: form.debit_account_id, p_delta: debitDelta });
      await supabase.rpc('increment_account_balance', { p_account_id: apAccount.id, p_delta: amount });
      const { data: current } = await supabase.from('suppliers').select('outstanding_balance').eq('id', selectedSupplier.id).maybeSingle();
      await supabase.from('suppliers').update({ outstanding_balance: (current?.outstanding_balance || 0) + amount }).eq('id', selectedSupplier.id);
      toast({ title: 'Success', description: `Payable of ${formatCurrency(amount)} recorded` });
      onSaved?.(); onClose();
    } catch (err: any) { setError(err.message || 'Failed to record payable'); }
    finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-base font-bold flex items-center gap-2"><Building2 className="w-4 h-4" />Record Payable</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>}
          <div>
            <label className="block text-xs font-medium mb-1">Supplier *</label>
            {selectedSupplier ? (
              <div className="flex items-center justify-between border border-orange-300 bg-orange-50 rounded-lg px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground truncate">{selectedSupplier.name}</p>
                  <p className="text-xs text-muted-foreground">{selectedSupplier.code || ''}{selectedSupplier.code && selectedSupplier.phone ? ' · ' : ''}{selectedSupplier.phone || ''}</p>
                </div>
                <button type="button" onClick={() => setSelectedSupplier(null)} className="text-muted-foreground hover:text-red-500 shrink-0 ml-2"><X className="w-4 h-4" /></button>
              </div>
            ) : (
              <SupplierSearchInput onSelect={(s) => setSelectedSupplier(s)} placeholder="Search supplier by name, code, or phone..." />
            )}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-xs font-medium mb-1">Amount *</label><input type="number" required min="0.01" step="0.01" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} placeholder="0.00" className="w-full border border-border rounded-lg px-3 py-2 text-sm" /></div>
            <div><label className="block text-xs font-medium mb-1">Date</label><input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm" /></div>
          </div>
          <div><label className="block text-xs font-medium mb-1">Debit Account (What you received) *</label><select required value={form.debit_account_id} onChange={e => setForm({ ...form, debit_account_id: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm"><option value="">Select account</option>{debitAccounts.map(a => <option key={a.id} value={a.id}>{a.code} - {a.name}</option>)}</select><p className="text-[11px] text-muted-foreground mt-1">Inventory (1200) for goods, or an expense account for services like rent, repairs, etc.</p></div>
          <div className="bg-muted/30 rounded-lg p-3 text-xs text-muted-foreground">Dr. {accounts.find(a => a.id === form.debit_account_id) ? `${accounts.find(a => a.id === form.debit_account_id)!.code} - ${accounts.find(a => a.id === form.debit_account_id)!.name}` : 'Select debit account'} &rarr; Cr. Accounts Payable ({apAccount?.code || '2000'})</div>
          <div><label className="block text-xs font-medium mb-1">Description</label><input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="e.g. Goods received on credit, Service invoice..." className="w-full border border-border rounded-lg px-3 py-2 text-sm" /></div>
          <div className="flex gap-3 pt-2"><button type="button" onClick={onClose} className="flex-1 px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Cancel</button><button type="submit" disabled={saving} className="flex-1 px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-60">{saving ? 'Saving...' : 'Record'}</button></div>
        </form>
      </div>
    </div>
  );
}
