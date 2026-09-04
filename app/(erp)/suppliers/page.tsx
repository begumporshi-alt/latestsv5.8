'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/format';
import { toast } from '@/hooks/use-toast';
import { Truck, Plus, Search, CreditCard as Edit, Trash2, Phone, Mail, Star, X, Eye, Building2, DollarSign, FileDown, CircleAlert as AlertCircle } from 'lucide-react';
import Link from 'next/link';
import type { Supplier } from '@/lib/types';
import RecordButton from '@/components/RecordButton';

export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'inactive'>('all');
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);
  const [deletingSupplier, setDeletingSupplier] = useState<Supplier | null>(null);

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);
    const { data, error } = await supabase.from('suppliers').select('*').order('name');
    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    }
    setSuppliers(data || []);
    setLoading(false);

    // Deep-link from the supplier profile's Edit button: /suppliers?edit=<id>
    const editId = new URLSearchParams(window.location.search).get('edit');
    if (editId) {
      const target = (data || []).find(s => s.id === editId);
      if (target) setEditingSupplier(target);
      // Strip the param so a refresh doesn't reopen the modal
      window.history.replaceState({}, '', '/suppliers');
    }
  }

  const filtered = suppliers.filter(s =>
    (!search ||
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.code.toLowerCase().includes(search.toLowerCase()) ||
      (s.phone || '').toLowerCase().includes(search.toLowerCase()) ||
      (s.email || '').toLowerCase().includes(search.toLowerCase()) ||
      (s.city || '').toLowerCase().includes(search.toLowerCase())
    ) &&
    (filterStatus === 'all' || (filterStatus === 'active' && s.is_active) || (filterStatus === 'inactive' && !s.is_active))
  );

  const activeSuppliers = suppliers.filter(s => s.is_active);
  const inactiveCount = suppliers.filter(s => !s.is_active).length;
  // Money cards include inactive suppliers too — deactivating an account
  // doesn't forgive what's still owed.
  const totalOutstanding = suppliers.reduce((sum, s) => sum + s.outstanding_balance, 0);
  const totalPurchases = suppliers.reduce((sum, s) => sum + s.total_purchases, 0);

  async function handleDelete() {
    if (!deletingSupplier) return;
    const { error } = await supabase.from('suppliers').update({ is_active: false }).eq('id', deletingSupplier.id);
    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    } else {
      toast({ title: 'Success', description: 'Supplier deactivated successfully' });
      loadData();
    }
    setDeletingSupplier(null);
  }

  function exportCsv() {
    const header = ['Name', 'Code', 'Company', 'Phone', 'Email', 'City', 'Credit Limit', 'Total Purchases', 'Outstanding', 'Active'];
    const escape = (v: any) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [
      header.join(','),
      ...filtered.map(s => [
        escape(s.name), escape(s.code), escape(s.company_name), escape(s.phone), escape(s.email), escape(s.city),
        s.credit_limit ?? 0, s.total_purchases ?? 0, s.outstanding_balance ?? 0, s.is_active ? 'yes' : 'no',
      ].join(',')),
    ];
    const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `suppliers-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: 'Exported', description: `${filtered.length} supplier(s) exported to CSV` });
  }

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Suppliers</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Manage supplier accounts and relationships</p>
        </div>
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
          <RecordButton variant="payable" onSaved={loadData} />
          <button onClick={() => setShowAddModal(true)} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition whitespace-nowrap">
            <Plus className="w-4 h-4" />Add Supplier
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Active Suppliers', value: activeSuppliers.length, icon: Building2, color: 'text-blue-500 bg-blue-50' },
          { label: 'Inactive', value: inactiveCount, icon: AlertCircle, color: 'text-gray-500 bg-gray-50' },
          { label: 'Total Purchases', value: formatCurrency(totalPurchases), icon: DollarSign, color: 'text-green-500 bg-green-50' },
          { label: 'Outstanding Payables', value: formatCurrency(totalOutstanding), icon: AlertCircle, color: 'text-red-500 bg-red-50' },
        ].map(s => (
          <div key={s.label} className="stat-card flex items-center gap-3">
            <div className={`w-10 h-10 rounded-full flex items-center justify-center ${s.color} shrink-0`}><s.icon className="w-5 h-5" /></div>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground whitespace-nowrap">{s.label}</p>
              <p className="text-lg font-bold text-foreground whitespace-nowrap">{s.value}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-border p-4 shadow-sm flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name, code, phone, email, or city..." className="w-full pl-8 pr-4 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
        </div>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value as any)} className="border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20">
          <option value="all">All Suppliers</option>
          <option value="active">Active Only</option>
          <option value="inactive">Inactive Only</option>
        </select>
        <button onClick={exportCsv} disabled={filtered.length === 0}
          className="flex items-center gap-2 px-3 py-2 border border-border rounded-lg text-sm hover:bg-muted transition disabled:opacity-50">
          <FileDown className="w-4 h-4" />Export CSV
        </button>
      </div>

      <div className="table-wrapper">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-muted/40 border-b border-border">
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Supplier</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Contact</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">City</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Credit Limit</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Total Purchases</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Outstanding</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Rating</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading ? Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>{Array.from({ length: 8 }).map((_, j) => <td key={j} className="px-4 py-3"><div className="h-4 bg-muted rounded animate-pulse" /></td>)}</tr>
              )) : filtered.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-12 text-center text-muted-foreground text-sm">No suppliers found</td></tr>
              ) : filtered.map((s) => (
                <tr key={s.id} className={`hover:bg-muted/30 transition-colors ${!s.is_active ? 'opacity-50' : ''}`}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 bg-orange-100 rounded-full flex items-center justify-center text-orange-700 text-sm font-bold">{s.name[0]}</div>
                      <div>
                        <p className="text-sm font-semibold text-foreground">{s.name}</p>
                        <p className="text-xs text-muted-foreground">{s.code}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-xs text-muted-foreground space-y-0.5">
                      {s.phone && <div className="flex items-center gap-1"><Phone className="w-3 h-3" />{s.phone}</div>}
                      {s.email && <div className="flex items-center gap-1"><Mail className="w-3 h-3" />{s.email}</div>}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-foreground">{s.city || '-'}</td>
                  <td className="px-4 py-3 text-right text-sm text-foreground">{formatCurrency(s.credit_limit)}</td>
                  <td className="px-4 py-3 text-right text-sm font-semibold text-foreground">{formatCurrency(s.total_purchases)}</td>
                  <td className="px-4 py-3 text-right text-sm font-bold">
                    {s.outstanding_balance > 0 ? (
                      <span className="text-red-600">{formatCurrency(s.outstanding_balance)}</span>
                    ) : s.outstanding_balance < 0 ? (
                      <span className="text-green-600" title="We overpaid — supplier holds an advance">{formatCurrency(-s.outstanding_balance)} adv</span>
                    ) : '-'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-0.5">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Star key={i} className={`w-3 h-3 ${i < (s.rating || 0) ? 'text-amber-400 fill-amber-400' : 'text-muted-foreground'}`} />
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Link href={`/suppliers/${s.id}`} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-blue-50 text-muted-foreground hover:text-blue-600 transition" title="View Details"><Eye className="w-3.5 h-3.5" /></Link>
                      <button onClick={() => setEditingSupplier(s)} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-blue-50 text-muted-foreground hover:text-blue-600 transition" title="Edit"><Edit className="w-3.5 h-3.5" /></button>
                      <button onClick={() => setDeletingSupplier(s)} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-red-50 text-muted-foreground hover:text-red-600 transition" title="Deactivate"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showAddModal && <SupplierModal onClose={() => setShowAddModal(false)} onSaved={loadData} />}
      {editingSupplier && <SupplierModal supplier={editingSupplier} onClose={() => setEditingSupplier(null)} onSaved={loadData} />}
      {deletingSupplier && (
        <DeleteConfirmModal name={deletingSupplier.name} onClose={() => setDeletingSupplier(null)} onConfirm={handleDelete} />
      )}
    </div>
  );
}

function SupplierModal({ supplier, onClose, onSaved }: { supplier?: Supplier | null; onClose: () => void; onSaved: () => void }) {
  const isEdit = !!supplier;
  const [form, setForm] = useState({
    name: supplier?.name || '',
    code: supplier?.code || '',
    company_name: supplier?.company_name || '',
    phone: supplier?.phone || '',
    email: supplier?.email || '',
    mobile: supplier?.mobile || '',
    city: supplier?.city || '',
    address: supplier?.address || '',
    credit_limit: supplier?.credit_limit?.toString() || '0',
    credit_days: supplier?.credit_days?.toString() || '30',
    rating: supplier?.rating?.toString() || '0',
    is_active: supplier?.is_active ?? true,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Set when a same-name/same-phone supplier already exists — shown as a
  // warning the user can override, not a hard block.
  const [dupWarning, setDupWarning] = useState<string | null>(null);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSaving(true);

    // Duplicate check on create only: same name (case-insensitive) or phone
    if (!isEdit && !dupWarning) {
      const { data: existing } = await supabase
        .from('suppliers')
        .select('name, phone, is_active')
        .ilike('name', form.name.trim());
      const dupByName = (existing || []).filter(s => s.name.trim().toLowerCase() === form.name.trim().toLowerCase());
      const dupByPhone = form.phone
        ? await supabase.from('suppliers').select('name').eq('phone', form.phone.trim())
        : { data: [] as any[] };
      const phoneDups = (dupByPhone.data || []).filter((s: any) => s.name.trim().toLowerCase() !== form.name.trim().toLowerCase());
      if (dupByName.length > 0 || phoneDups.length > 0) {
        const names = new Set([...dupByName.map(s => s.name), ...phoneDups.map((s: any) => s.name)]);
        setDupWarning(`A supplier already exists with this ${dupByName.length > 0 ? 'name' : 'phone number'}: ${Array.from(names).join(', ')}. Save anyway if they are really different.`);
        setSaving(false);
        return;
      }
    }

    const data = {
      name: form.name,
      code: form.code,
      company_name: form.company_name || null,
      phone: form.phone || null,
      email: form.email || null,
      mobile: form.mobile || null,
      city: form.city || null,
      address: form.address || null,
      credit_limit: Number(form.credit_limit),
      credit_days: Number(form.credit_days),
      rating: Number(form.rating),
      is_active: form.is_active,
      country: supplier?.country || 'Bangladesh',
    };

    const { error } = isEdit
      ? await supabase.from('suppliers').update(data).eq('id', supplier!.id)
      : await supabase.from('suppliers').insert(data);

    if (error) { setError(error.message); setSaving(false); return; }

    toast({ title: 'Success', description: isEdit ? 'Supplier updated successfully' : 'Supplier created successfully' });
    onSaved();
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-white">
          <h2 className="text-base font-bold">{isEdit ? 'Edit Supplier' : 'Add New Supplier'}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={handleSave} className="p-6 space-y-4">
          {error && <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>}
          {dupWarning && (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700">
              {dupWarning}
              <button type="button" onClick={() => setDupWarning(null)} className="ml-2 underline">Dismiss</button>
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-xs font-medium mb-1">Supplier Name *</label><input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" /></div>
            <div><label className="block text-xs font-medium mb-1">Code *</label><input required value={form.code} onChange={e => setForm({ ...form, code: e.target.value })} placeholder="SUP-XXX" className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" /></div>
          </div>
          <div><label className="block text-xs font-medium mb-1">Company Name</label><input value={form.company_name} onChange={e => setForm({ ...form, company_name: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" /></div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-xs font-medium mb-1">Phone</label><input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" /></div>
            <div><label className="block text-xs font-medium mb-1">Mobile</label><input value={form.mobile} onChange={e => setForm({ ...form, mobile: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" /></div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-xs font-medium mb-1">Email</label><input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" /></div>
            <div><label className="block text-xs font-medium mb-1">City</label><input value={form.city} onChange={e => setForm({ ...form, city: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" /></div>
          </div>
          <div><label className="block text-xs font-medium mb-1">Address</label><textarea value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} rows={2} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" /></div>
          <div className="grid grid-cols-3 gap-4">
            <div><label className="block text-xs font-medium mb-1">Credit Limit</label><input type="number" min="0" value={form.credit_limit} onChange={e => setForm({ ...form, credit_limit: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" /></div>
            <div><label className="block text-xs font-medium mb-1">Credit Days</label><input type="number" min="0" value={form.credit_days} onChange={e => setForm({ ...form, credit_days: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" /></div>
            <div><label className="block text-xs font-medium mb-1">Rating (1-5)</label><input type="number" min="0" max="5" value={form.rating} onChange={e => setForm({ ...form, rating: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" /></div>
          </div>
          {isEdit && (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={form.is_active} onChange={e => setForm({ ...form, is_active: e.target.checked })} className="rounded" />
              <span className="text-sm">Active</span>
            </label>
          )}
          <div className="flex items-center justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Cancel</button>
            <button type="submit" disabled={saving} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-60">
              {saving ? 'Saving...' : !isEdit && dupWarning ? 'Save Anyway' : isEdit ? 'Update Supplier' : 'Save Supplier'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function DeleteConfirmModal({ name, onClose, onConfirm }: { name: string; onClose: () => void; onConfirm: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl">
        <div className="p-6">
          <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <Trash2 className="w-6 h-6 text-red-600" />
          </div>
          <h2 className="text-lg font-bold text-center mb-2">Deactivate Supplier?</h2>
          <p className="text-sm text-muted-foreground text-center mb-6">
            Are you sure you want to deactivate <span className="font-semibold text-foreground">{name}</span>?
          </p>
          <div className="flex gap-3">
            <button onClick={onClose} className="flex-1 px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Cancel</button>
            <button onClick={onConfirm} className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-semibold transition">Deactivate</button>
          </div>
        </div>
      </div>
    </div>
  );
}
