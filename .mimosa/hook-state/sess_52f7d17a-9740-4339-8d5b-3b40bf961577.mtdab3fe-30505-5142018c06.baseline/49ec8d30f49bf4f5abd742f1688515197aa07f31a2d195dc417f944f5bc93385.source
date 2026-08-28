'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/format';
import { toast } from '@/hooks/use-toast';
import { Plus, Pencil, Trash2, Banknote, Building2, CreditCard, Smartphone, FileText, MoveHorizontal as MoreHorizontal, ChevronUp, ChevronDown, X } from 'lucide-react';

interface PaymentMethod {
  id: string;
  name: string;
  code: string;
  is_active: boolean;
  is_cash: boolean;
  is_bank: boolean;
  account_id?: string;
  sort_order: number;
  icon_name?: string;
  description?: string;
  accounts?: { id: string; code: string; name: string };
}

interface Account {
  id: string;
  code: string;
  name: string;
  account_type: string;
}

const iconMap: Record<string, React.ElementType> = {
  'banknote': Banknote,
  'building-2': Building2,
  'credit-card': CreditCard,
  'smartphone': Smartphone,
  'file-text': FileText,
  'more-horizontal': MoreHorizontal,
};

export default function PaymentMethodsPage() {
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingMethod, setEditingMethod] = useState<PaymentMethod | null>(null);
  const [deletingMethod, setDeletingMethod] = useState<PaymentMethod | null>(null);

  useEffect(() => { loadMethods(); }, []);

  async function loadMethods() {
    setLoading(true);
    const { data } = await supabase.from('payment_methods').select('*, accounts(id, code, name)').order('sort_order');
    setMethods(data || []);
    setLoading(false);
  }

  async function toggleActive(method: PaymentMethod) {
    const { error } = await supabase
      .from('payment_methods')
      .update({ is_active: !method.is_active, updated_at: new Date().toISOString() })
      .eq('id', method.id);

    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    } else {
      loadMethods();
    }
  }

  async function moveOrder(method: PaymentMethod, direction: 'up' | 'down') {
    const currentIndex = methods.findIndex(m => m.id === method.id);
    const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= methods.length) return;

    const targetMethod = methods[targetIndex];

    await Promise.all([
      supabase.from('payment_methods').update({ sort_order: method.sort_order }).eq('id', targetMethod.id),
      supabase.from('payment_methods').update({ sort_order: targetMethod.sort_order }).eq('id', method.id),
    ]);

    loadMethods();
  }

  async function handleDelete() {
    if (!deletingMethod) return;
    const { error } = await supabase.from('payment_methods').delete().eq('id', deletingMethod.id);
    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    } else {
      toast({ title: 'Deleted', description: 'Payment method removed' });
      loadMethods();
    }
    setDeletingMethod(null);
  }

  const activeMethods = methods.filter(m => m.is_active);
  const inactiveMethods = methods.filter(m => !m.is_active);

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Payment Methods</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Manage payment options for sales and purchases</p>
        </div>
        <button
          onClick={() => { setEditingMethod(null); setShowModal(true); }}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition"
        >
          <Plus className="w-4 h-4" /> Add Method
        </button>
      </div>

      <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-border bg-muted/40">
          <h3 className="text-sm font-semibold text-foreground">Active Payment Methods</h3>
          <p className="text-xs text-muted-foreground mt-0.5">These are available when creating invoices and recording payments</p>
        </div>
        <div className="divide-y divide-border">
          {loading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="px-4 py-3 flex items-center gap-3">
                <div className="h-4 w-full bg-muted rounded animate-pulse" />
              </div>
            ))
          ) : activeMethods.length === 0 ? (
            <div className="px-4 py-8 text-center text-muted-foreground text-sm">No active payment methods</div>
          ) : (
            activeMethods.map((method, idx) => {
              const Icon = iconMap[method.icon_name || 'more-horizontal'] || MoreHorizontal;
              return (
                <div key={method.id} className="px-4 py-3 flex items-center gap-3 hover:bg-muted/20 transition-colors group">
                  <div className="flex flex-col gap-0.5">
                    <button
                      onClick={() => moveOrder(method, 'up')}
                      disabled={idx === 0}
                      className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                    >
                      <ChevronUp className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => moveOrder(method, 'down')}
                      disabled={idx === activeMethods.length - 1}
                      className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                    >
                      <ChevronDown className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${method.is_cash ? 'bg-green-100 text-green-600' : method.is_bank ? 'bg-blue-100 text-blue-600' : 'bg-gray-100 text-gray-600'}`}>
                    <Icon className="w-5 h-5" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-foreground">{method.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {method.code}
                      {method.accounts && ` → ${method.accounts.code} ${method.accounts.name}`}
                      {method.description && ` - ${method.description}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => toggleActive(method)}
                      className="text-xs px-2 py-1 rounded bg-green-100 text-green-700 hover:bg-red-100 hover:text-red-700 transition"
                    >
                      Active
                    </button>
                    <button
                      onClick={() => { setEditingMethod(method); setShowModal(true); }}
                      className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-blue-50 text-muted-foreground hover:text-blue-600 transition"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => setDeletingMethod(method)}
                      className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-red-50 text-muted-foreground hover:text-red-600 transition"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {inactiveMethods.length > 0 && (
        <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden opacity-70">
          <div className="px-4 py-3 border-b border-border bg-muted/40">
            <h3 className="text-sm font-semibold text-muted-foreground">Inactive Methods</h3>
          </div>
          <div className="divide-y divide-border">
            {inactiveMethods.map(method => {
              const Icon = iconMap[method.icon_name || 'more-horizontal'] || MoreHorizontal;
              return (
                <div key={method.id} className="px-4 py-3 flex items-center gap-3 hover:bg-muted/20 transition-colors">
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center bg-gray-100 text-gray-400`}>
                    <Icon className="w-5 h-5" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-muted-foreground">{method.name}</p>
                    <p className="text-xs text-muted-foreground">{method.code}</p>
                  </div>
                  <button
                    onClick={() => toggleActive(method)}
                    className="text-xs px-2 py-1 rounded bg-gray-100 text-gray-500 hover:bg-green-100 hover:text-green-700 transition"
                  >
                    Inactive
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {showModal && (
        <PaymentMethodModal
          method={editingMethod}
          onClose={() => { setShowModal(false); setEditingMethod(null); }}
          onSaved={() => { setShowModal(false); setEditingMethod(null); loadMethods(); }}
        />
      )}

      {deletingMethod && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl p-6">
            <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <Trash2 className="w-6 h-6 text-red-600" />
            </div>
            <h2 className="text-lg font-bold text-center mb-2">Delete Payment Method?</h2>
            <p className="text-sm text-muted-foreground text-center mb-6">
              Are you sure you want to delete <strong className="text-foreground">{deletingMethod.name}</strong>?
            </p>
            <div className="flex gap-3">
              <button onClick={() => setDeletingMethod(null)} className="flex-1 px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Cancel</button>
              <button onClick={handleDelete} className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-semibold transition">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PaymentMethodModal({ method, onClose, onSaved }: { method: PaymentMethod | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: method?.name || '',
    code: method?.code || '',
    is_cash: method?.is_cash || false,
    is_bank: method?.is_bank || false,
    description: method?.description || '',
    icon_name: method?.icon_name || 'more-horizontal',
    account_id: method?.account_id || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [accounts, setAccounts] = useState<Account[]>([]);

  useEffect(() => {
    supabase.from('accounts').select('id, code, name, account_type').eq('account_type', 'asset').order('code').then(({ data }) => {
      setAccounts(data || []);
    });
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name || !form.code) {
      setError('Name and Code are required');
      return;
    }

    setSaving(true);
    setError('');

    const data = {
      name: form.name,
      code: form.code.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
      is_cash: form.is_cash,
      is_bank: form.is_bank,
      description: form.description || null,
      icon_name: form.icon_name,
      account_id: form.account_id || null,
      sort_order: method?.sort_order || 100,
    };

    try {
      if (method) {
        const { error } = await supabase.from('payment_methods').update(data).eq('id', method.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('payment_methods').insert(data);
        if (error) throw error;
      }
      toast({ title: 'Success', description: method ? 'Payment method updated' : 'Payment method created' });
      onSaved();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-base font-bold">{method ? 'Edit Payment Method' : 'Add Payment Method'}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>}

          <div>
            <label className="block text-xs font-medium mb-1">Name *</label>
            <input
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Cash, Bank Transfer"
              className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Code *</label>
            <input
              value={form.code}
              onChange={e => setForm({ ...form, code: e.target.value })}
              placeholder="e.g. cash, bank_transfer"
              className="w-full border border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
            <p className="text-xs text-muted-foreground mt-1">Used internally, lowercase with underscores</p>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Icon</label>
            <select
              value={form.icon_name}
              onChange={e => setForm({ ...form, icon_name: e.target.value })}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none"
            >
              <option value="banknote">Banknote (Cash)</option>
              <option value="building-2">Building (Bank)</option>
              <option value="credit-card">Credit Card</option>
              <option value="smartphone">Smartphone (Mobile)</option>
              <option value="file-text">File Text (Cheque)</option>
              <option value="more-horizontal">More (Other)</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Description</label>
            <input
              value={form.description}
              onChange={e => setForm({ ...form, description: e.target.value })}
              placeholder="Optional description"
              className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
          </div>

          <div className="flex gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.is_cash}
                onChange={e => setForm({ ...form, is_cash: e.target.checked, is_bank: e.target.checked ? false : form.is_bank })}
                className="rounded"
              />
              <span className="text-sm">Is Cash</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.is_bank}
                onChange={e => setForm({ ...form, is_bank: e.target.checked, is_cash: e.target.checked ? false : form.is_cash })}
                className="rounded"
              />
              <span className="text-sm">Is Bank</span>
            </label>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Linked Account</label>
            <select
              value={form.account_id}
              onChange={e => setForm({ ...form, account_id: e.target.value })}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none"
            >
              <option value="">-- Select Account --</option>
              {accounts.map(acc => (
                <option key={acc.id} value={acc.id}>{acc.code} - {acc.name}</option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground mt-1">Payments made with this method will be recorded to this account</p>
          </div>

          <div className="flex items-center justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Cancel</button>
            <button type="submit" disabled={saving} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-60">
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
