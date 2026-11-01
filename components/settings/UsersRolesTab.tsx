'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { toast } from '@/hooks/use-toast';
import { formatRelativeTime } from '@/lib/format';
import { Users, UserPlus, KeyRound, Power, Pencil, Copy, Check, Loader as Loader2, X, Minus, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import { roleAccessMatrix, ROLE_LIST } from '@/lib/permissions';

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

// Short column headers for the access matrix.
const ROLE_SHORT: Record<string, string> = {
  super_admin: 'Super Admin',
  manager: 'Manager',
  sales_executive: 'Sales',
  inventory_manager: 'Inventory',
  accountant: 'Accountant',
  delivery_staff: 'Delivery',
};

const MATRIX = roleAccessMatrix();

// Per-user access editor state: prefix -> allowed, null = follow the role.
type OverrideState = Record<string, boolean | null>;

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

  const [accessFor, setAccessFor] = useState<ManagedUser | null>(null);
  const [overrideState, setOverrideState] = useState<OverrideState>({});
  const [originalState, setOriginalState] = useState<OverrideState>({});
  const [accessBusy, setAccessBusy] = useState(false);
  const [usersWithOverrides, setUsersWithOverrides] = useState<Set<string>>(new Set());

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
      const { data: ov } = await supabase.from('user_module_access').select('user_id');
      setUsersWithOverrides(new Set((ov || []).map(o => o.user_id)));
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

  async function openAccessEditor(user: ManagedUser) {
    setAccessFor(user);
    setOverrideState({});
    setOriginalState({});
    setAccessBusy(true);
    const state: OverrideState = {};
    try {
      const { data } = await supabase
        .from('user_module_access')
        .select('module_prefix, allowed')
        .eq('user_id', user.id);
      for (const row of data || []) state[row.module_prefix] = row.allowed;
      setOverrideState({ ...state });
      setOriginalState({ ...state });
    } finally {
      setAccessBusy(false);
    }
  }

  async function saveAccess() {
    if (!accessFor) return;
    const uid = accessFor.id;
    const changes = MATRIX.map(m => m.prefix).filter(p => overrideState[p] !== originalState[p]);
    if (changes.length === 0) {
      setAccessFor(null);
      return;
    }
    setAccessBusy(true);
    try {
      const results = await Promise.all(changes.map(async p => {
        if (overrideState[p] === null) {
          return supabase.from('user_module_access').delete().eq('user_id', uid).eq('module_prefix', p);
        }
        return supabase.from('user_module_access').upsert({ user_id: uid, module_prefix: p, allowed: overrideState[p] as boolean });
      }));
      const failed = results.find(r => r.error);
      if (failed?.error) throw failed.error;
      toast({ title: 'Access updated', description: `${accessFor.full_name || accessFor.email}'s module access was saved. It takes effect the next time they open the app.` });
      setAccessFor(null);
      await loadUsers();
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setAccessBusy(false);
    }
  }

  async function resetAccess() {
    if (!accessFor) return;
    if (!confirm('Remove all custom overrides for this user? They will fall back to their role defaults.')) return;
    setAccessBusy(true);
    try {
      const { error } = await supabase.from('user_module_access').delete().eq('user_id', accessFor.id);
      if (error) throw error;
      toast({ title: 'Access reset', description: 'Back to role defaults.' });
      setAccessFor(null);
      await loadUsers();
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setAccessBusy(false);
    }
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
                      {usersWithOverrides.has(u.id) && (
                        <span className="inline-block ml-1.5 px-2 py-0.5 rounded-full text-xs font-semibold bg-indigo-100 text-indigo-700" title="Has custom module access overrides">
                          Custom
                        </span>
                      )}
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
                          {canManage && (
                            <button
                              onClick={() => openAccessEditor(u)}
                              disabled={busyId === u.id}
                              className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition disabled:opacity-50"
                              title="Customize module access"
                            >
                              <SlidersHorizontal className="w-3.5 h-3.5" />
                            </button>
                          )}
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
          Roles control what each person can see and do. Changing someone&apos;s role updates their sidebar,
          page access and database permissions the next time they open the app. Deactivating a user signs
          them out within a minute and blocks sign-in immediately.
        </p>

        {/* Module access matrix — mirrors lib/permissions.ts enforcement */}
        <div className="mt-6">
          <div className="flex items-center gap-2 mb-3">
            <ShieldCheck className="w-4 h-4 text-blue-600" />
            <h3 className="text-sm font-semibold">Module Access by Role</h3>
          </div>
          <div className="border border-border rounded-xl overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead>
                <tr className="bg-muted/40 text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium sticky left-0 bg-muted/40">Module</th>
                  {ROLE_LIST.map(r => (
                    <th key={r} className="px-3 py-2.5 font-medium text-center whitespace-nowrap">{ROLE_SHORT[r]}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {MATRIX.map(row => (
                  <tr key={row.prefix} className={row.allRoles ? 'bg-muted/20' : ''}>
                    <td className="px-4 py-2 whitespace-nowrap sticky left-0 bg-inherit">{row.label}</td>
                    {ROLE_LIST.map(r => (
                      <td key={r} className="px-3 py-2 text-center">
                        {row.access[r] ? (
                          <Check className="w-4 h-4 text-green-600 inline-block" />
                        ) : (
                          <Minus className="w-4 h-4 text-muted-foreground/40 inline-block" />
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            This is the live access control — the sidebar, page guards and database write rules all follow
            it. Shaded rows are open to every role. Only Super Admin can manage users here; individual
            exceptions can be set from a user row&apos;s customize action and override this table.
          </p>
        </div>
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

      {/* Per-user module access editor */}
      {accessFor && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-2xl shadow-2xl flex flex-col max-h-[85vh]">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
              <div>
                <h2 className="text-base font-bold flex items-center gap-2"><SlidersHorizontal className="w-5 h-5 text-blue-600" />Module Access</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {accessFor.full_name || accessFor.email} — defaults from {ROLE_LABELS[accessFor.role] || accessFor.role}
                </p>
              </div>
              <button onClick={() => setAccessFor(null)} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
            </div>
            <div className="overflow-y-auto p-6 pt-4">
              <p className="text-xs text-muted-foreground mb-3">
                Allow or deny modules for this person specifically. &quot;Role&quot; follows the default for {ROLE_LABELS[accessFor.role] || accessFor.role}.
              </p>
                <div className="border border-border rounded-xl overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-muted/40 text-left text-xs text-muted-foreground">
                        <th className="px-4 py-2.5 font-medium">Module</th>
                        <th className="px-4 py-2.5 font-medium text-center w-56">Access</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {MATRIX.map(row => {
                        const val = overrideState[row.prefix] ?? null;
                        const roleDefault = (row.access as Record<string, boolean>)[accessFor.role] ?? false;
                        return (
                          <tr key={row.prefix}>
                            <td className="px-4 py-2">
                              {row.label}
                              <span
                                className={`ml-2 inline-block align-middle ${roleDefault ? 'text-green-600' : 'text-muted-foreground/40'}`}
                                title={roleDefault ? 'Role default: allowed' : 'Role default: denied'}
                              >
                                {roleDefault ? <Check className="w-3.5 h-3.5" /> : <Minus className="w-3.5 h-3.5" />}
                              </span>
                            </td>
                            <td className="px-4 py-2">
                              <div className="flex justify-center">
                                <div className="inline-flex rounded-lg border border-border overflow-hidden text-xs font-semibold">
                                  <button
                                    onClick={() => setOverrideState(s => ({ ...s, [row.prefix]: null }))}
                                    className={`px-3 py-1.5 transition ${val === null ? 'bg-slate-800 text-white' : 'hover:bg-muted text-muted-foreground'}`}
                                  >
                                    Role
                                  </button>
                                  <button
                                    onClick={() => setOverrideState(s => ({ ...s, [row.prefix]: true }))}
                                    className={`px-3 py-1.5 transition ${val === true ? 'bg-green-600 text-white' : 'hover:bg-muted text-muted-foreground'}`}
                                  >
                                    Allow
                                  </button>
                                  <button
                                    onClick={() => setOverrideState(s => ({ ...s, [row.prefix]: false }))}
                                    className={`px-3 py-1.5 transition ${val === false ? 'bg-red-600 text-white' : 'hover:bg-muted text-muted-foreground'}`}
                                  >
                                    Deny
                                  </button>
                                </div>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-muted-foreground mt-3">
                  Page access changes take effect the next time this user opens the app. Database write
                  permissions on restricted modules (accounting, purchases, HR…) still follow their role.
                </p>
              </div>
            <div className="px-6 py-4 border-t border-border flex items-center justify-between shrink-0">
              <button
                onClick={resetAccess}
                disabled={accessBusy || Object.values(originalState).every(v => v === null)}
                className="px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition disabled:opacity-40"
              >
                Reset to Role Defaults
              </button>
              <div className="flex items-center gap-3">
                <button onClick={() => setAccessFor(null)} className="px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Cancel</button>
                <button
                  onClick={saveAccess}
                  disabled={accessBusy}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-60"
                >
                  {accessBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  Save Access
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
