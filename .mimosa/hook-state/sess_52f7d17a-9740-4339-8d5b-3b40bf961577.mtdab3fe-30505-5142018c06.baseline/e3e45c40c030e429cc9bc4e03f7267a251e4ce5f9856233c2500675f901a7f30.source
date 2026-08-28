'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { toast } from '@/hooks/use-toast';
import { Warehouse, Plus, MapPin, X, Edit, Trash2 } from 'lucide-react';
import type { Warehouse as WarehouseType } from '@/lib/types';

export default function WarehousesPage() {
  const [warehouses, setWarehouses] = useState<WarehouseType[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingWarehouse, setEditingWarehouse] = useState<WarehouseType | null>(null);
  const [deletingWarehouse, setDeletingWarehouse] = useState<WarehouseType | null>(null);

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);
    const { data } = await supabase.from('warehouses').select('*').order('name');
    setWarehouses(data || []);
    setLoading(false);
  }

  async function handleDelete() {
    if (!deletingWarehouse) return;
    const { error } = await supabase.from('warehouses').update({ is_active: false }).eq('id', deletingWarehouse.id);
    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    } else {
      toast({ title: 'Success', description: 'Warehouse deactivated successfully' });
      loadData();
    }
    setDeletingWarehouse(null);
  }

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div><h1 className="text-2xl font-bold text-foreground">Warehouses</h1><p className="text-muted-foreground text-sm mt-0.5">Manage storage locations</p></div>
        <button onClick={() => setShowCreateModal(true)} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition"><Plus className="w-4 h-4" />Add Warehouse</button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {loading ? Array.from({ length: 3 }).map((_, i) => <div key={i} className="stat-card animate-pulse h-40" />) :
          warehouses.length === 0 ? (
            <div className="col-span-full text-center py-12 text-muted-foreground">No warehouses found</div>
          ) : warehouses.map(w => (
            <div key={w.id} className={`bg-white rounded-xl border border-border p-5 shadow-sm hover:shadow-md transition-shadow ${!w.is_active ? 'opacity-50' : ''}`}>
              <div className="flex items-start justify-between mb-3">
                <div className="w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center"><Warehouse className="w-5 h-5 text-blue-600" /></div>
                <div className="flex items-center gap-1">
                  {w.is_default && <span className="badge-status bg-green-50 text-green-600 mr-2">Default</span>}
                  <button onClick={() => setEditingWarehouse(w)} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-blue-50 text-muted-foreground hover:text-blue-600 transition"><Edit className="w-3.5 h-3.5" /></button>
                  <button onClick={() => setDeletingWarehouse(w)} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-red-50 text-muted-foreground hover:text-red-600 transition"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              </div>
              <h3 className="font-bold text-foreground">{w.name}</h3>
              <p className="text-xs text-muted-foreground font-mono">{w.code}</p>
              {w.address && <div className="flex items-center gap-1 mt-2 text-xs text-muted-foreground"><MapPin className="w-3 h-3" />{w.address}</div>}
              <div className="mt-3 pt-3 border-t border-border"><p className="text-xs text-muted-foreground">City: {w.city || '-'}</p></div>
            </div>
          ))
        }
      </div>

      {showCreateModal && (
        <WarehouseModal onClose={() => setShowCreateModal(false)} onSaved={loadData} />
      )}
      {editingWarehouse && (
        <WarehouseModal warehouse={editingWarehouse} onClose={() => setEditingWarehouse(null)} onSaved={loadData} />
      )}
      {deletingWarehouse && (
        <DeleteConfirmModal name={deletingWarehouse.name} onClose={() => setDeletingWarehouse(null)} onConfirm={handleDelete} />
      )}
    </div>
  );
}

function WarehouseModal({ warehouse, onClose, onSaved }: { warehouse?: WarehouseType | null; onClose: () => void; onSaved: () => void }) {
  const isEdit = !!warehouse;
  const [form, setForm] = useState({
    name: warehouse?.name || '',
    code: warehouse?.code || '',
    address: warehouse?.address || '',
    city: warehouse?.city || '',
    is_default: warehouse?.is_default || false,
    is_active: warehouse?.is_active ?? true,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');

    const data = {
      name: form.name,
      code: form.code,
      address: form.address || null,
      city: form.city || null,
      is_default: form.is_default,
      is_active: form.is_active,
    };

    const { error } = isEdit
      ? await supabase.from('warehouses').update(data).eq('id', warehouse!.id)
      : await supabase.from('warehouses').insert(data);

    if (error) { setError(error.message); setSaving(false); return; }

    toast({ title: 'Success', description: isEdit ? 'Warehouse updated successfully' : 'Warehouse created successfully' });
    onSaved();
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-base font-bold">{isEdit ? 'Edit Warehouse' : 'Add Warehouse'}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={handleSave} className="p-6 space-y-4">
          {error && <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">Name *</label>
              <input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Code *</label>
              <input required value={form.code} onChange={e => setForm({ ...form, code: e.target.value })} placeholder="WH-001" className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Address</label>
            <input value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">City</label>
            <input value={form.city} onChange={e => setForm({ ...form, city: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
          </div>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={form.is_default} onChange={e => setForm({ ...form, is_default: e.target.checked })} className="rounded" />
              <span className="text-sm">Default Warehouse</span>
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={form.is_active} onChange={e => setForm({ ...form, is_active: e.target.checked })} className="rounded" />
              <span className="text-sm">Active</span>
            </label>
          </div>
          <div className="flex items-center justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Cancel</button>
            <button type="submit" disabled={saving} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-60">
              {saving ? 'Saving...' : isEdit ? 'Update' : 'Create'}
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
          <h2 className="text-lg font-bold text-center mb-2">Deactivate Warehouse?</h2>
          <p className="text-sm text-muted-foreground text-center mb-6">Deactivate <span className="font-semibold text-foreground">{name}</span>?</p>
          <div className="flex gap-3">
            <button onClick={onClose} className="flex-1 px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Cancel</button>
            <button onClick={onConfirm} className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-semibold transition">Deactivate</button>
          </div>
        </div>
      </div>
    </div>
  );
}
