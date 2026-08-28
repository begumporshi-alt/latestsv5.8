'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCurrency, formatDate } from '@/lib/format';
import { toast } from '@/hooks/use-toast';
import { Plus, Search, List, LayoutGrid, X, Trash2, Edit, MapPin } from 'lucide-react';
import type { Project, ProjectStatus, Customer } from '@/lib/types';

const statusConfig: Record<ProjectStatus, { label: string; color: string; bg: string }> = {
  planning: { label: 'Planning', color: 'text-blue-600', bg: 'bg-blue-100' },
  active: { label: 'Active', color: 'text-green-600', bg: 'bg-green-100' },
  on_hold: { label: 'On Hold', color: 'text-amber-600', bg: 'bg-amber-100' },
  completed: { label: 'Completed', color: 'text-teal-600', bg: 'bg-teal-100' },
  cancelled: { label: 'Cancelled', color: 'text-red-600', bg: 'bg-red-100' },
};

const priorityColors: Record<string, string> = {
  low: 'bg-gray-100 text-gray-700',
  medium: 'bg-blue-100 text-blue-700',
  high: 'bg-orange-100 text-orange-700',
  urgent: 'bg-red-100 text-red-700',
};

interface ProjectWithCustomer extends Omit<Project, 'customer'> {
  customer?: { name: string };
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectWithCustomer[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingProject, setEditingProject] = useState<ProjectWithCustomer | null>(null);
  const [deletingProject, setDeletingProject] = useState<ProjectWithCustomer | null>(null);

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);
    const [projRes, custRes] = await Promise.all([
      supabase.from('projects').select('*, customer:customers(name)').order('created_at', { ascending: false }),
      supabase.from('customers').select('*').eq('is_active', true).order('name'),
    ]);
    setProjects(projRes.data || []);
    setCustomers(custRes.data || []);
    setLoading(false);
  }

  async function handleDelete() {
    if (!deletingProject) return;
    const { error } = await supabase.from('projects').delete().eq('id', deletingProject.id);
    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    } else {
      toast({ title: 'Success', description: 'Project deleted successfully' });
      loadData();
    }
    setDeletingProject(null);
  }

  const filtered = projects.filter(p =>
    (!search || p.name.toLowerCase().includes(search.toLowerCase())) &&
    (!filterStatus || p.status === filterStatus)
  );

  const stats = {
    total: projects.length,
    active: projects.filter(p => p.status === 'active').length,
    completed: projects.filter(p => p.status === 'completed').length,
    totalBudget: projects.reduce((s, p) => s + (Number(p.estimated_budget) || 0), 0),
  };

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Projects</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Track project progress and profitability</p>
        </div>
        <button onClick={() => setShowCreateModal(true)} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition">
          <Plus className="w-4 h-4" />New Project
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Total Projects', value: stats.total },
          { label: 'Active', value: stats.active },
          { label: 'Completed', value: stats.completed },
          { label: 'Total Budget', value: formatCurrency(stats.totalBudget) },
        ].map(s => (
          <div key={s.label} className="stat-card">
            <p className="text-xs text-muted-foreground">{s.label}</p>
            <p className="text-xl font-bold text-foreground mt-1">{s.value}</p>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-border p-4 shadow-sm flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search projects..." className="w-full pl-8 pr-4 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
        </div>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="border border-border rounded-lg px-3 py-2 text-sm focus:outline-none">
          <option value="">All Status</option>
          {Object.entries(statusConfig).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <div className="flex border border-border rounded-lg overflow-hidden">
          <button onClick={() => setViewMode('grid')} className={`px-3 py-2 text-sm transition ${viewMode === 'grid' ? 'bg-blue-600 text-white' : 'hover:bg-muted text-muted-foreground'}`}><LayoutGrid className="w-4 h-4" /></button>
          <button onClick={() => setViewMode('list')} className={`px-3 py-2 text-sm transition ${viewMode === 'list' ? 'bg-blue-600 text-white' : 'hover:bg-muted text-muted-foreground'}`}><List className="w-4 h-4" /></button>
        </div>
      </div>

      {viewMode === 'grid' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {loading ? Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-white rounded-xl border border-border p-5 shadow-sm animate-pulse">
              <div className="h-32 bg-muted rounded-lg mb-4" />
              <div className="h-4 bg-muted rounded mb-2" />
              <div className="h-3 bg-muted rounded w-2/3" />
            </div>
          )) : filtered.length === 0 ? (
            <div className="col-span-full text-center py-12 text-muted-foreground">No projects found</div>
          ) : filtered.map((p) => {
            const cfg = statusConfig[p.status as ProjectStatus] || statusConfig.planning;
            const progressColor = p.progress_percent === 100 ? 'bg-green-500' : p.progress_percent >= 70 ? 'bg-blue-500' : p.progress_percent >= 40 ? 'bg-amber-500' : 'bg-gray-400';
            return (
              <div key={p.id} className="bg-white rounded-xl border border-border shadow-sm overflow-hidden hover:shadow-md transition-shadow">
                {p.image_url && (
                  <div className="h-36 overflow-hidden">
                    <img src={p.image_url} alt={p.name} className="w-full h-full object-cover" />
                  </div>
                )}
                <div className="p-4">
                  <div className="flex items-start justify-between mb-2">
                    <h3 className="text-sm font-semibold text-foreground flex-1">{p.name}</h3>
                    <span className={`badge-status ${cfg.bg} ${cfg.color} ml-2 shrink-0`}>{cfg.label}</span>
                  </div>
                  {p.customer && <p className="text-xs text-muted-foreground mb-1">{p.customer.name}</p>}
                  {p.location && (
                    <div className="flex items-center gap-1 text-xs text-muted-foreground mb-3">
                      <MapPin className="w-3 h-3" />{p.location}
                    </div>
                  )}
                  <div className="flex items-center justify-between text-xs text-muted-foreground mb-2">
                    <span>Progress</span>
                    <span className="font-semibold text-foreground">{p.progress_percent}%</span>
                  </div>
                  <div className="h-2 bg-muted rounded-full overflow-hidden mb-3">
                    <div className={`h-full rounded-full ${progressColor} transition-all`} style={{ width: `${p.progress_percent}%` }} />
                  </div>
                  <div className="flex items-center justify-between">
                    {p.estimated_budget && <div className="text-xs"><p className="text-muted-foreground">Budget</p><p className="font-semibold text-foreground">{formatCurrency(p.estimated_budget)}</p></div>}
                    <div className="flex gap-1">
                      <button onClick={() => setEditingProject(p)} className="p-1.5 rounded-lg hover:bg-blue-50 text-muted-foreground hover:text-blue-600 transition"><Edit className="w-4 h-4" /></button>
                      <button onClick={() => setDeletingProject(p)} className="p-1.5 rounded-lg hover:bg-red-50 text-muted-foreground hover:text-red-600 transition"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="table-wrapper">
          <table className="w-full">
            <thead><tr className="bg-muted/40 border-b border-border">
              {['Project', 'Customer', 'Status', 'Progress', 'Budget', 'Actions'].map(h => (
                <th key={h} className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">{h}</th>
              ))}
            </tr></thead>
            <tbody className="divide-y divide-border">
              {filtered.map((p) => {
                const cfg = statusConfig[p.status as ProjectStatus] || statusConfig.planning;
                return (
                  <tr key={p.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3">
                      <p className="text-sm font-semibold text-foreground">{p.name}</p>
                      <p className="text-xs text-muted-foreground">{p.project_number}</p>
                    </td>
                    <td className="px-4 py-3 text-sm text-foreground">{p.customer?.name || '-'}</td>
                    <td className="px-4 py-3"><span className={`badge-status ${cfg.bg} ${cfg.color}`}>{cfg.label}</span></td>
                    <td className="px-4 py-3 w-32">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                          <div className={`h-full ${p.progress_percent >= 70 ? 'bg-green-500' : p.progress_percent >= 40 ? 'bg-blue-500' : 'bg-gray-400'}`} style={{ width: `${p.progress_percent}%` }} />
                        </div>
                        <span className="text-xs font-semibold text-foreground w-8">{p.progress_percent}%</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm font-semibold text-foreground">{p.estimated_budget ? formatCurrency(p.estimated_budget) : '-'}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <button onClick={() => setEditingProject(p)} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-blue-50 text-muted-foreground hover:text-blue-600 transition"><Edit className="w-3.5 h-3.5" /></button>
                        <button onClick={() => setDeletingProject(p)} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-red-50 text-muted-foreground hover:text-red-600 transition"><Trash2 className="w-3.5 h-3.5" /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showCreateModal && (
        <ProjectModal customers={customers} onClose={() => setShowCreateModal(false)} onSaved={loadData} />
      )}
      {editingProject && (
        <ProjectModal customers={customers} project={editingProject} onClose={() => setEditingProject(null)} onSaved={loadData} />
      )}
      {deletingProject && (
        <DeleteConfirmModal name={deletingProject.name} onClose={() => setDeletingProject(null)} onConfirm={handleDelete} />
      )}
    </div>
  );
}

function ProjectModal({ customers, project, onClose, onSaved }: {
  customers: Customer[];
  project?: ProjectWithCustomer | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!project;
  const [form, setForm] = useState({
    name: project?.name || '',
    customer_id: project?.customer_id || '',
    status: project?.status || 'planning' as ProjectStatus,
    priority: project?.priority || 'medium',
    start_date: project?.start_date || '',
    end_date: project?.end_date || '',
    estimated_budget: project?.estimated_budget?.toString() || '',
    actual_cost: project?.actual_cost?.toString() || '0',
    progress_percent: project?.progress_percent?.toString() || '0',
    location: project?.location || '',
    description: project?.description || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');

    const projectNumber = project?.project_number || `PRJ-${Date.now().toString().slice(-6)}`;
    const data = {
      name: form.name,
      project_number: projectNumber,
      customer_id: form.customer_id || null,
      status: form.status as 'planning' | 'active' | 'on_hold' | 'completed' | 'cancelled',
      priority: form.priority as 'low' | 'medium' | 'high' | 'urgent',
      start_date: form.start_date || null,
      end_date: form.end_date || null,
      estimated_budget: form.estimated_budget ? Number(form.estimated_budget) : null,
      actual_cost: Number(form.actual_cost) || 0,
      revenue: 0,
      progress_percent: Number(form.progress_percent) || 0,
      location: form.location || null,
      description: form.description || null,
    };

    const { error } = isEdit
      ? await supabase.from('projects').update(data).eq('id', project!.id)
      : await supabase.from('projects').insert(data);

    if (error) { setError(error.message); setSaving(false); return; }

    toast({ title: 'Success', description: isEdit ? 'Project updated successfully' : 'Project created successfully' });
    onSaved();
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-white">
          <h2 className="text-base font-bold">{isEdit ? 'Edit Project' : 'Create Project'}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={handleSave} className="p-6 space-y-4">
          {error && <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>}

          <div>
            <label className="block text-xs font-medium mb-1">Project Name *</label>
            <input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">Customer</label>
              <select value={form.customer_id} onChange={e => setForm({ ...form, customer_id: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none">
                <option value="">Select customer</option>
                {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Status</label>
              <select value={form.status} onChange={e => setForm({ ...form, status: e.target.value as 'planning' | 'active' | 'on_hold' | 'completed' | 'cancelled' })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none">
                {Object.entries(statusConfig).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">Priority</label>
              <select value={form.priority} onChange={e => setForm({ ...form, priority: e.target.value as 'low' | 'medium' | 'high' | 'urgent' })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none">
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Progress %</label>
              <input type="number" min="0" max="100" value={form.progress_percent} onChange={e => setForm({ ...form, progress_percent: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">Start Date</label>
              <input type="date" value={form.start_date} onChange={e => setForm({ ...form, start_date: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">End Date</label>
              <input type="date" value={form.end_date} onChange={e => setForm({ ...form, end_date: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">Budget</label>
              <input type="number" min="0" value={form.estimated_budget} onChange={e => setForm({ ...form, estimated_budget: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Location</label>
              <input value={form.location} onChange={e => setForm({ ...form, location: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Description</label>
            <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} rows={2} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
          </div>

          <div className="flex items-center justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Cancel</button>
            <button type="submit" disabled={saving} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-60">
              {saving ? 'Saving...' : isEdit ? 'Update Project' : 'Create Project'}
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
          <h2 className="text-lg font-bold text-center mb-2">Delete Project?</h2>
          <p className="text-sm text-muted-foreground text-center mb-6">
            Are you sure you want to delete <span className="font-semibold text-foreground">{name}</span>? This action cannot be undone.
          </p>
          <div className="flex gap-3">
            <button onClick={onClose} className="flex-1 px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Cancel</button>
            <button onClick={onConfirm} className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-semibold transition">Delete</button>
          </div>
        </div>
      </div>
    </div>
  );
}
