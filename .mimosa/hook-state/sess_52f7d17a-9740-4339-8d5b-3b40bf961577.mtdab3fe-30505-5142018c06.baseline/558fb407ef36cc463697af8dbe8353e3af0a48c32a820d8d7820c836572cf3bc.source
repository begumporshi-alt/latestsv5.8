'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/format';
import { toast } from '@/hooks/use-toast';
import { UserRound, Plus, Search, Edit, Users, DollarSign, Briefcase, X, Trash2 } from 'lucide-react';
import type { Employee } from '@/lib/types';

const deptColors: Record<string, string> = {
  Sales: 'bg-blue-100 text-blue-700',
  Warehouse: 'bg-orange-100 text-orange-700',
  Finance: 'bg-green-100 text-green-700',
  Logistics: 'bg-purple-100 text-purple-700',
  HR: 'bg-pink-100 text-pink-700',
  Management: 'bg-indigo-100 text-indigo-700',
};

const departments = ['Sales', 'Warehouse', 'Finance', 'Logistics', 'HR', 'Management'];
const statusOptions = ['active', 'on_leave', 'resigned', 'terminated'];

export default function EmployeesPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterDept, setFilterDept] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);
  const [deletingEmployee, setDeletingEmployee] = useState<Employee | null>(null);

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);
    const { data } = await supabase.from('employees').select('*').order('full_name');
    setEmployees(data || []);
    setLoading(false);
  }

  async function handleDelete() {
    if (!deletingEmployee) return;
    const { error } = await supabase.from('employees').update({ status: 'terminated' }).eq('id', deletingEmployee.id);
    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    } else {
      toast({ title: 'Success', description: 'Employee terminated successfully' });
      loadData();
    }
    setDeletingEmployee(null);
  }

  const filtered = employees.filter(e =>
    (!search || e.full_name.toLowerCase().includes(search.toLowerCase()) || e.employee_id.toLowerCase().includes(search.toLowerCase())) &&
    (!filterDept || e.department === filterDept)
  );

  const uniqueDepts = Array.from(new Set(employees.map(e => e.department)));
  const totalSalary = employees.filter(e => e.status === 'active').reduce((s, e) => s + e.salary, 0);

  const stats = {
    total: employees.filter(e => e.status === 'active').length,
    active: employees.filter(e => e.status === 'active').length,
    depts: uniqueDepts.length,
    payroll: totalSalary,
  };

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Employees</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Manage HR, attendance and payroll</p>
        </div>
        <button onClick={() => setShowAddModal(true)} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition">
          <Plus className="w-4 h-4" />Add Employee
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Total Staff', value: stats.total, icon: Users },
          { label: 'Active', value: stats.active, icon: UserRound },
          { label: 'Departments', value: stats.depts, icon: Briefcase },
          { label: 'Monthly Payroll', value: formatCurrency(stats.payroll), icon: DollarSign },
        ].map(s => (
          <div key={s.label} className="stat-card flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-50 rounded-full flex items-center justify-center"><s.icon className="w-5 h-5 text-blue-500" /></div>
            <div><p className="text-xs text-muted-foreground">{s.label}</p><p className="text-xl font-bold text-foreground">{s.value}</p></div>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-border p-4 shadow-sm flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search employees..." className="w-full pl-8 pr-4 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
        </div>
        <select value={filterDept} onChange={e => setFilterDept(e.target.value)} className="border border-border rounded-lg px-3 py-2 text-sm focus:outline-none">
          <option value="">All Departments</option>
          {uniqueDepts.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {loading ? Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="bg-white rounded-xl border border-border p-5 shadow-sm animate-pulse">
            <div className="w-14 h-14 bg-muted rounded-full mx-auto mb-3" />
            <div className="h-4 bg-muted rounded mb-2" />
            <div className="h-3 bg-muted rounded w-2/3 mx-auto" />
          </div>
        )) : filtered.length === 0 ? (
          <div className="col-span-full text-center py-12 text-muted-foreground">No employees found</div>
        ) : filtered.map(emp => (
          <div key={emp.id} className={`bg-white rounded-xl border border-border p-5 shadow-sm hover:shadow-md transition-shadow ${emp.status !== 'active' ? 'opacity-60' : ''}`}>
            <div className="flex items-start justify-between mb-3">
              <div className="flex-1 text-center">
                <div className="w-14 h-14 bg-gradient-to-br from-blue-400 to-blue-600 rounded-full flex items-center justify-center text-white text-xl font-bold mx-auto mb-2">
                  {emp.full_name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
                </div>
                <h3 className="text-sm font-semibold text-foreground">{emp.full_name}</h3>
                <p className="text-xs text-muted-foreground">{emp.designation}</p>
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Department</span>
                <span className={`badge-status ${deptColors[emp.department] || 'bg-gray-100 text-gray-700'}`}>{emp.department}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Salary</span>
                <span className="text-xs font-semibold text-foreground">{formatCurrency(emp.salary)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Joined</span>
                <span className="text-xs text-foreground">{emp.join_date}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Status</span>
                <span className={`badge-status ${emp.status === 'active' ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-600'}`}>{emp.status.replace('_', ' ')}</span>
              </div>
            </div>
            <div className="mt-3 pt-3 border-t border-border flex gap-2">
              <button onClick={() => setEditingEmployee(emp)} className="flex-1 text-xs border border-border rounded-lg py-1.5 hover:bg-muted transition text-center">Edit</button>
              <button onClick={() => setDeletingEmployee(emp)} className="flex-1 text-xs border border-red-200 text-red-600 rounded-lg py-1.5 hover:bg-red-50 transition text-center">Delete</button>
            </div>
          </div>
        ))}
      </div>

      {showAddModal && (
        <EmployeeModal onClose={() => setShowAddModal(false)} onSaved={loadData} />
      )}
      {editingEmployee && (
        <EmployeeModal employee={editingEmployee} onClose={() => setEditingEmployee(null)} onSaved={loadData} />
      )}
      {deletingEmployee && (
        <DeleteConfirmModal name={deletingEmployee.full_name} onClose={() => setDeletingEmployee(null)} onConfirm={handleDelete} />
      )}
    </div>
  );
}

function EmployeeModal({ employee, onClose, onSaved }: { employee?: Employee | null; onClose: () => void; onSaved: () => void }) {
  const isEdit = !!employee;
  const [form, setForm] = useState({
    full_name: employee?.full_name || '',
    employee_id: employee?.employee_id || '',
    designation: employee?.designation || '',
    department: employee?.department || 'Sales',
    email: employee?.email || '',
    phone: employee?.phone || '',
    salary: employee?.salary?.toString() || '',
    join_date: employee?.join_date || new Date().toISOString().split('T')[0],
    status: employee?.status || 'active',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');

    const empId = employee?.employee_id || `EMP-${Date.now().toString().slice(-5)}`;
    const data = {
      employee_id: empId,
      full_name: form.full_name,
      designation: form.designation,
      department: form.department,
      email: form.email || null,
      phone: form.phone || null,
      salary: Number(form.salary) || 0,
      join_date: form.join_date,
      status: form.status as Employee['status'],
    };

    const { error } = isEdit
      ? await supabase.from('employees').update(data).eq('id', employee!.id)
      : await supabase.from('employees').insert(data);

    if (error) { setError(error.message); setSaving(false); return; }

    toast({ title: 'Success', description: isEdit ? 'Employee updated successfully' : 'Employee created successfully' });
    onSaved();
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-white">
          <h2 className="text-base font-bold">{isEdit ? 'Edit Employee' : 'Add Employee'}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={handleSave} className="p-6 space-y-4">
          {error && <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">Full Name *</label>
              <input required value={form.full_name} onChange={e => setForm({ ...form, full_name: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Employee ID *</label>
              <input required value={form.employee_id} onChange={e => setForm({ ...form, employee_id: e.target.value })} placeholder="EMP-001" className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">Designation *</label>
              <input required value={form.designation} onChange={e => setForm({ ...form, designation: e.target.value })} placeholder="e.g. Sales Executive" className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Department *</label>
              <select required value={form.department} onChange={e => setForm({ ...form, department: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none">
                {departments.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">Email</label>
              <input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Phone</label>
              <input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">Salary *</label>
              <input type="number" required min="0" value={form.salary} onChange={e => setForm({ ...form, salary: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Join Date</label>
              <input type="date" value={form.join_date} onChange={e => setForm({ ...form, join_date: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
            </div>
          </div>
          {isEdit && (
            <div>
              <label className="block text-xs font-medium mb-1">Status</label>
              <select value={form.status} onChange={e => setForm({ ...form, status: e.target.value as 'active' | 'on_leave' | 'resigned' | 'terminated' })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none">
                {statusOptions.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
              </select>
            </div>
          )}
          <div className="flex items-center justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Cancel</button>
            <button type="submit" disabled={saving} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-60">
              {saving ? 'Saving...' : isEdit ? 'Update Employee' : 'Add Employee'}
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
          <h2 className="text-lg font-bold text-center mb-2">Terminate Employee?</h2>
          <p className="text-sm text-muted-foreground text-center mb-6">
            Are you sure you want to terminate <span className="font-semibold text-foreground">{name}</span>?
          </p>
          <div className="flex gap-3">
            <button onClick={onClose} className="flex-1 px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Cancel</button>
            <button onClick={onConfirm} className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-semibold transition">Terminate</button>
          </div>
        </div>
      </div>
    </div>
  );
}
