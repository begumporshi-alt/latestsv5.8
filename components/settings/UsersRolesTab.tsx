'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { toast } from '@/hooks/use-toast';
import { formatRelativeTime } from '@/lib/format';
import { Users, UserPlus, KeyRound, Power, Pencil, Copy, Check, Loader as Loader2, X } from 'lucide-react';

interface ManagedUser {
  id: string;
  email: string;
  full_name: string;
  phone: string;
  role: string;
  is_active: boolean;
  created_at: string;
  last_sign_in_at: string | null;
  invite_pending: boolean;
}

const ROLE_OPTIONS = ['super_admin', 'manager', 'sales_executive', 'inventory_manager', 'accountant', 'delivery_staff'];

const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super Admin',
  manager: 'Manager',
  sales_executive: 'Sales Executive',
  inventory_manager: 'Inventory Manager',
  accountant: 'Accountant',
  delivery_staff: 'Delivery Staff',
};

const ROLE_COLORS: Record<string, string> = {
  super_admin: 'bg-purple-100 text-purple-700',
  manager: 'bg-blue-100 text-blue-700',
  sales_executive: 'bg-green-100 text-green-700',
  inventory_manager: 'bg-amber-100 text-amber-700',
  accountant: 'bg-cyan-100 text-cyan-700',
  delivery_staff: 'bg-slate-100 text-slate-700',
};

export default function UsersRolesTab({ canManage }: { canManage: boolean }) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [showInvite, setShowInvite] = useState(false);
  const [invite, setInvite] = useState({ full_name: '', email: '', role: 'sales_executive' });
  const [inviteBusy, setInviteBusy] = useState(false);

  const [editing, setEditing] = useState<ManagedUser | null>(null);
  const [editBusy, setEditBusy] = useState(false);

  const [resetResult, setResetResult] = useState<{ email: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function authHeaders(): Promise<Record<string, string>> {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Not signed in');
    return { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json' };
  }

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const headers = await authHeaders();
      const res = await fetch('/api/admin/users', { headers });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to load users');
      setUsers(data.users);
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadUsers(); }, [loadUsers]);

  async function sendInvite() {
    if (!invite.full_name.trim() || !invite.email.trim()) {
      toast({ title: 'Missing details', description: 'Name and email are required', variant: 'destructive' });
      return;
    }
    setInviteBusy(true);
    try {
      const headers = await authHeaders();
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: 'invite', ...invite }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Invite failed');
      toast({ title: 'Invitation sent', description: `${invite.email} will receive an email with a link to set their password` });
      setShowInvite(false);
      setInvite({ full_name: '', email: '', role: 'sales_executive' });
      await loadUsers();
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setInviteBusy(false);
    }
  }

  async function patchUser(id: string, updates: Record<string, unknown>) {
    setBusyId(id);
    try {
      const headers = await authHeaders();
      const res = await fetch('/api/admin/users', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ id, ...updates }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Update failed');
      await loadUsers();
      return true;
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
      return false;
    } finally {
      setBusyId(null);
    }
  }

  async function resetPassword(user: ManagedUser) {
    if (!confirm(`Set a temporary password for ${user.full_name || user.email}? They should change it after signing in.`)) return;
    setBusyId(user.id);
    try {
      const headers = await authHeaders();
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: 'reset_password', id: user.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Reset failed');
      setCopied(false);
      setResetResult({ email: user.email, password: data.temporary_password });
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setBusyId(null);
    }
  }

  async function saveEdit() {
    if (!editing) return;
    if (!editing.full_name.trim()) {
      toast({ title: 'Name required', variant: 'destructive' });
      return;
    }
    setEditBusy(true);
    const ok = await patchUser(editing.id, {
      full_name: editing.full_name,
      phone: editing.phone,
      role: editing.role,
    });
    setEditBusy(false);
    if (ok) setEditing(null);
  }

  return (
    <div>
      <div className="px-6 py-4 border-b border-border flex items-center justify-between">
        <div>
          <h2 className="text-base font-bold">Users &amp; Roles</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Manage who can access the ERP and what they can do</p>
        </div>
        {canManage && (
          <button
            onClick={() => setShowInvite(true)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition"
          >
            <UserPlus className="w-4 h-4" />Invite User
          </button>
        )}
      </div>

      <div className="p-6">
        {loading ? (
          <div className="flex items-center justify-center h-40">
            <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
          </div>
        ) : (
          <div className="border border-border rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/40 text-left text-xs text-muted-foreground">
                  <th className="px-4 py-3 font-medium">User</th>
                  <th className="px-4 py-3 font-medium">Role</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Last sign-in</th>
                  {canManage && <th className="px-4 py-3 font-medium text-right">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {users.map(u => (
                  <tr key={u.id} className={u.is_active ? '' : 'opacity-60'}>
                    <td className="px-4 py-3">
                      <p className="font-medium text-foreground">{u.full_name || '—'}</p>
                      <p className="text-xs text-muted-foreground">{u.email}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${ROLE_COLORS[u.role] || 'bg-slate-100 text-slate-700'}`}>
                        {ROLE_LABELS[u.role] || u.role}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {u.invite_pending ? (
                        <span className="text-xs font-medium text-amber-600">Invitation pending</span>
                      ) : u.is_active ? (
                        <span className="text-xs font-medium text-green-600">Active</span>
                      ) : (
                        <span className="text-xs font-medium text-red-600">Inactive</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {u.last_sign_in_at ? formatRelativeTime(u.last_sign_in_at) : 'Never'}
                    </td>
                    {canManage && (
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => { setEditing({ ...u }); }}
                            disabled={busyId === u.id}
                            className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition disabled:opacity-50"
                            title="Edit user"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => resetPassword(u)}
                            disabled={busyId === u.id}
                            className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition disabled:opacity-50"
                            title="Set temporary password"
                          >
                            <KeyRound className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => patchUser(u.id, { is_active: !u.is_active })}
                            disabled={busyId === u.id}
                            className={`p-1.5 rounded-lg hover:bg-muted transition disabled:opacity-50 ${u.is_active ? 'text-red-500 hover:text-red-600' : 'text-green-600 hover:text-green-700'}`}
                            title={u.is_active ? 'Deactivate' : 'Reactivate'}
                          >
                            {busyId === u.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Power className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-muted-foreground mt-4">
          Roles control what each person can see and do. Fine-grained access enforcement per module is coming in the next update — for now, treat role changes as a staffing record.
        </p>
      </div>

      {/* Invite dialog */}
      {showInvite && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <h2 className="text-base font-bold flex items-center gap-2"><UserPlus className="w-5 h-5 text-blue-600" />Invite User</h2>
              <button onClick={() => setShowInvite(false)} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-6 space-y-4">
              <p className="text-xs text-muted-foreground">
                They will receive an email with a link to set their password and sign in.
              </p>
              <div>
                <label className="block text-xs font-medium mb-1">Full Name</label>
                <input
                  value={invite.full_name}
                  onChange={e => setInvite({ ...invite, full_name: e.target.value })}
                  placeholder="e.g. Rahim Uddin"
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Email</label>
                <input
                  type="email"
                  value={invite.email}
                  onChange={e => setInvite({ ...invite, email: e.target.value })}
                  placeholder="name@company.com"
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Role</label>
                <select
                  value={invite.role}
                  onChange={e => setInvite({ ...invite, role: e.target.value })}
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none"
                >
                  {ROLE_OPTIONS.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                </select>
              </div>
              <div className="flex items-center justify-end gap-3 pt-1">
                <button onClick={() => setShowInvite(false)} className="px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Cancel</button>
                <button
                  onClick={sendInvite}
                  disabled={inviteBusy}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-60"
                >
                  {inviteBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
                  {inviteBusy ? 'Sending...' : 'Send Invitation'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit dialog */}
      {editing && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <h2 className="text-base font-bold flex items-center gap-2"><Users className="w-5 h-5 text-blue-600" />Edit User</h2>
              <button onClick={() => setEditing(null)} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-6 space-y-4">
              <p className="text-xs text-muted-foreground">{editing.email}</p>
              <div>
                <label className="block text-xs font-medium mb-1">Full Name</label>
                <input
                  value={editing.full_name}
                  onChange={e => setEditing({ ...editing, full_name: e.target.value })}
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Phone</label>
                <input
                  value={editing.phone}
                  onChange={e => setEditing({ ...editing, phone: e.target.value })}
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Role</label>
                <select
                  value={editing.role}
                  onChange={e => setEditing({ ...editing, role: e.target.value })}
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none"
                >
                  {ROLE_OPTIONS.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                </select>
              </div>
              <div className="flex items-center justify-end gap-3 pt-1">
                <button onClick={() => setEditing(null)} className="px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Cancel</button>
                <button
                  onClick={saveEdit}
                  disabled={editBusy}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-60"
                >
                  {editBusy && <Loader2 className="w-4 h-4 animate-spin" />}
                  Save Changes
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Temporary password result */}
      {resetResult && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <h2 className="text-base font-bold flex items-center gap-2"><KeyRound className="w-5 h-5 text-blue-600" />Temporary Password</h2>
              <button onClick={() => setResetResult(null)} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-6 space-y-4">
              <p className="text-sm text-foreground">
                Password for <span className="font-semibold">{resetResult.email}</span> has been reset to:
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 bg-muted rounded-lg px-4 py-3 font-mono text-base tracking-wide select-all">{resetResult.password}</code>
                <button
                  onClick={async () => {
                    try { await navigator.clipboard.writeText(resetResult.password); } catch { /* clipboard unavailable */ }
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                  className="p-2.5 border border-border rounded-lg hover:bg-muted transition"
                  title="Copy"
                >
                  {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">
                Share it over a trusted channel and ask them to change it from Settings → Security after signing in. This is shown only once.
              </p>
              <div className="flex justify-end">
                <button onClick={() => setResetResult(null)} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition">Done</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
