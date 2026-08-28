'use client';

import React, { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { toast } from '@/hooks/use-toast';
import { Settings, User, Bell, Shield, Palette, Building2, Save, Database, RefreshCw, Trash2, Download, TriangleAlert as AlertTriangle, Package, FileText, ShoppingCart, Truck, ClipboardList, BookOpen, CircleCheck as CheckCircle2, Loader as Loader2, X } from 'lucide-react';

type SettingsTab = 'general' | 'profile' | 'notifications' | 'security' | 'appearance' | 'data';

interface DeleteTarget {
  key: string;
  label: string;
  description: string;
  tables: string[];
  count?: number;
}

interface CompanySettings {
  name: string;
  license: string;
  phone: string;
  email: string;
  address: string;
  currency: string;
  dateFormat: string;
  logo_url: string;
}

interface NotificationSettings {
  lowStock: boolean;
  newOrders: boolean;
  paymentReceived: boolean;
  overdueInvoices: boolean;
  deliveryUpdates: boolean;
  poApprovals: boolean;
}

interface AppearanceSettings {
  darkMode: boolean;
  theme: string;
  interface: string;
}

interface ProfileData {
  full_name: string;
  email: string;
  phone: string;
  role: string;
}

const themes = ['#2563eb', '#0891b2', '#059669', '#d97706', '#dc2626'];

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [backupLoading, setBackupLoading] = useState(false);
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [restoreResult, setRestoreResult] = useState<{ success: boolean; stats: any; errors?: string[] } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleteCounts, setDeleteCounts] = useState<Record<string, number>>({});

  // Settings state
  const [company, setCompany] = useState<CompanySettings>({
    name: 'SI Building Solutions',
    license: '',
    phone: '',
    email: '',
    address: '',
    currency: 'BDT',
    dateFormat: 'DD/MM/YYYY',
    logo_url: '',
  });
  const [notifications, setNotifications] = useState<NotificationSettings>({
    lowStock: true,
    newOrders: true,
    paymentReceived: true,
    overdueInvoices: false,
    deliveryUpdates: true,
    poApprovals: true,
  });
  const [appearance, setAppearance] = useState<AppearanceSettings>({
    darkMode: false,
    theme: '#2563eb',
    interface: 'desktop',
  });
  const [profile, setProfile] = useState<ProfileData>({
    full_name: '',
    email: '',
    phone: '',
    role: 'manager',
  });

  // Password state
  const [passwords, setPasswords] = useState({
    current: '',
    new: '',
    confirm: '',
  });

  useEffect(() => { loadSettings(); }, []);
  useEffect(() => { if (activeTab === 'data') loadDeleteCounts(); }, [activeTab]);

  async function loadDeleteCounts() {
    const targets = [
      { key: 'products', tables: ['products'] },
      { key: 'invoices', tables: ['invoices'] },
      { key: 'quotations', tables: ['quotations'] },
      { key: 'deliveries', tables: ['deliveries'] },
      { key: 'purchases', tables: ['purchase_orders'] },
      { key: 'journal', tables: ['journal_entries'] },
    ];
    const results = await Promise.all(
      targets.map(async (t) => {
        const { count } = await supabase.from(t.tables[0] as any).select('*', { count: 'exact', head: true });
        return { key: t.key, count: count || 0 };
      })
    );
    const counts: Record<string, number> = {};
    results.forEach(r => { counts[r.key] = r.count; });
    setDeleteCounts(counts);
  }

  async function downloadBackup() {
    setBackupLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/db-backup`;
      const res = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${session?.access_token || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`,
          'apikey': process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || 'Backup failed');
      }
      const blob = await res.blob();
      const filename = `erp-backup-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
      toast({ title: 'Backup Downloaded', description: `Saved as ${filename}` });
    } catch (err: any) {
      toast({ title: 'Backup Failed', description: err.message, variant: 'destructive' });
    } finally {
      setBackupLoading(false);
    }
  }

  async function handleRestoreUpload(file: File) {
    setRestoreLoading(true);
    setRestoreResult(null);
    try {
      const text = await file.text();
      let backup: any;
      try { backup = JSON.parse(text); } catch { throw new Error('File is not valid JSON'); }
      if (!backup.data && !backup.database?.tables) throw new Error('Unrecognized backup format. Expected a backup created by this system.');
      const { data: { session } } = await supabase.auth.getSession();
      const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/db-restore`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session?.access_token || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`,
          'apikey': process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(backup),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Restore failed');
      setRestoreResult(result);
      if (result.success) {
        toast({ title: 'Restore Complete', description: `${result.stats.total_rows_inserted.toLocaleString()} rows restored across ${result.stats.tables_restored} tables` });
        await loadDeleteCounts();
      } else {
        toast({ title: 'Restore Partial', description: `${result.stats.tables_failed} tables had errors`, variant: 'destructive' });
      }
    } catch (err: any) {
      toast({ title: 'Restore Failed', description: err.message, variant: 'destructive' });
    } finally {
      setRestoreLoading(false);
    }
  }

  async function executeDelete(target: DeleteTarget) {
    const deleteMap: Record<string, string[]> = {
      products: [
        'warranty_records', 'stock_movements', 'delivery_items', 'inventory_items',
        'invoice_items', 'purchase_order_items', 'quotation_items',
        'product_variants', 'product_colors', 'product_sizes', 'product_units', 'products',
      ],
      invoices: [
        'sales_return_items', 'sales_returns', 'store_credit_redemptions',
        'payments', 'invoice_items', 'deliveries', 'invoices',
      ],
      quotations: ['quotation_items', 'quotations'],
      deliveries: ['delivery_items', 'deliveries'],
      purchases: ['goods_receipt_notes', 'purchase_order_items', 'purchase_orders'],
      journal: ['journal_lines', 'journal_entries'],
    };
    const tables = deleteMap[target.key] || target.tables;
    for (const table of tables) {
      await supabase.from(table as any).delete().neq('id', '00000000-0000-0000-0000-000000000000');
    }
    await loadDeleteCounts();
    toast({ title: 'Deleted', description: `All ${target.label} have been deleted` });
  }

  async function loadSettings() {
    setLoading(true);

    const [companyRes, notifRes, appearRes, profileRes] = await Promise.all([
      supabase.from('app_settings').select('*').eq('setting_key', 'company').single(),
      supabase.from('app_settings').select('*').eq('setting_key', 'notifications').single(),
      supabase.from('app_settings').select('*').eq('setting_key', 'appearance').single(),
      supabase.from('profiles').select('*').limit(1).single(),
    ]);

    if (companyRes.data?.setting_value) {
      setCompany({ ...company, ...companyRes.data.setting_value as CompanySettings });
    }
    if (notifRes.data?.setting_value) {
      setNotifications({ ...notifications, ...notifRes.data.setting_value as NotificationSettings });
    }
    if (appearRes.data?.setting_value) {
      setAppearance({ ...appearance, ...appearRes.data.setting_value as AppearanceSettings });
    }
    if (profileRes.data) {
      setProfile({
        full_name: profileRes.data.full_name,
        email: profileRes.data.email,
        phone: profileRes.data.phone || '',
        role: profileRes.data.role,
      });
    }

    setLoading(false);
  }

  async function saveSettings(settingsKey: string, settingsValue: object) {
    setSaving(true);

    const { error } = await supabase
      .from('app_settings')
      .upsert(
        { setting_key: settingsKey, setting_value: settingsValue, updated_at: new Date().toISOString() },
        { onConflict: 'setting_key' }
      );

    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    } else {
      toast({ title: 'Success', description: 'Settings saved successfully' });
    }

    setSaving(false);
  }

  async function saveProfile() {
    setSaving(true);

    const { error } = await supabase
      .from('profiles')
      .update({
        full_name: profile.full_name,
        phone: profile.phone,
        updated_at: new Date().toISOString(),
      })
      .eq('email', profile.email);

    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    } else {
      toast({ title: 'Success', description: 'Profile updated successfully' });
    }

    setSaving(false);
  }

  async function changePassword() {
    if (passwords.new !== passwords.confirm) {
      toast({ title: 'Error', description: 'Passwords do not match', variant: 'destructive' });
      return;
    }
    if (passwords.new.length < 6) {
      toast({ title: 'Error', description: 'Password must be at least 6 characters', variant: 'destructive' });
      return;
    }

    setSaving(true);

    const { error } = await supabase.auth.updateUser({
      password: passwords.new,
    });

    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    } else {
      toast({ title: 'Success', description: 'Password updated successfully' });
      setPasswords({ current: '', new: '', confirm: '' });
    }

    setSaving(false);
  }

  const tabs = [
    { id: 'general', label: 'General', icon: Settings },
    { id: 'profile', label: 'Profile', icon: User },
    { id: 'notifications', label: 'Notifications', icon: Bell },
    { id: 'security', label: 'Security', icon: Shield },
    { id: 'appearance', label: 'Appearance', icon: Palette },
    { id: 'data', label: 'Data', icon: Database },
  ];

  const roleLabels: Record<string, string> = {
    super_admin: 'Super Admin',
    manager: 'Manager',
    sales_executive: 'Sales Executive',
    inventory_manager: 'Inventory Manager',
    accountant: 'Accountant',
    delivery_staff: 'Delivery Staff',
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[50vh]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  return (
    <div className="space-y-5 animate-fade-in max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Settings</h1>
        <p className="text-muted-foreground text-sm mt-0.5">Configure your ERP system preferences</p>
      </div>

      {/* Mobile: horizontal scroll tabs | Desktop: sidebar + content */}
      <div className="lg:flex lg:gap-5">
        {/* Sidebar (desktop) / Tab bar (mobile) */}
        <div className="lg:w-48 lg:shrink-0">
          {/* Mobile horizontal scrollable tabs */}
          <div className="flex lg:hidden overflow-x-auto gap-1 pb-2 -mx-1 px-1 scrollbar-hide">
            {tabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as SettingsTab)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm whitespace-nowrap shrink-0 transition font-medium ${
                  activeTab === tab.id
                    ? 'bg-blue-600 text-white'
                    : 'bg-white border border-border text-muted-foreground hover:text-foreground'
                }`}
              >
                <tab.icon className="w-3.5 h-3.5" />
                {tab.label}
              </button>
            ))}
          </div>
          {/* Desktop vertical nav */}
          <nav className="hidden lg:block space-y-0.5">
            {tabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as SettingsTab)}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm text-left transition ${
                  activeTab === tab.id
                    ? 'bg-blue-50 text-blue-600 font-semibold'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                <tab.icon className="w-4 h-4" />
                {tab.label}
              </button>
            ))}
          </nav>
        </div>

        <div className="flex-1 bg-white rounded-xl border border-border shadow-sm mt-3 lg:mt-0">
          {activeTab === 'general' && (
            <div>
              <div className="px-6 py-4 border-b border-border">
                <h2 className="text-base font-bold">General Settings</h2>
                <p className="text-xs text-muted-foreground mt-0.5">Configure your business information</p>
              </div>
              <div className="p-6 space-y-5">
                <div className="flex items-center gap-4">
                  <div className="w-14 h-14 bg-blue-600 rounded-xl flex items-center justify-center">
                    <Building2 className="w-7 h-7 text-white" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-foreground">{company.name}</h3>
                    <p className="text-xs text-muted-foreground">Construction Materials & Home Improvement</p>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium mb-1">Company Name</label>
                    <input
                      value={company.name}
                      onChange={e => setCompany({ ...company, name: e.target.value })}
                      className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">Trade License #</label>
                    <input
                      value={company.license}
                      onChange={e => setCompany({ ...company, license: e.target.value })}
                      className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">Phone</label>
                    <input
                      value={company.phone}
                      onChange={e => setCompany({ ...company, phone: e.target.value })}
                      className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">Email</label>
                    <input
                      value={company.email}
                      onChange={e => setCompany({ ...company, email: e.target.value })}
                      className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs font-medium mb-1">Address</label>
                    <input
                      value={company.address}
                      onChange={e => setCompany({ ...company, address: e.target.value })}
                      className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs font-medium mb-1">Company Logo URL</label>
                    <input
                      value={company.logo_url}
                      onChange={e => setCompany({ ...company, logo_url: e.target.value })}
                      placeholder="https://example.com/logo.png"
                      className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                    />
                    {company.logo_url && (
                      <div className="mt-2 flex items-center gap-3">
                        <img src={company.logo_url} alt="Logo preview" className="h-10 w-10 object-contain rounded border border-border" />
                        <p className="text-xs text-muted-foreground">Logo preview</p>
                      </div>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium mb-1">Currency</label>
                    <select
                      value={company.currency}
                      onChange={e => setCompany({ ...company, currency: e.target.value })}
                      className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none"
                    >
                      <option value="BDT">BDT - Bangladeshi Taka</option>
                      <option value="USD">USD - US Dollar</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">Date Format</label>
                    <select
                      value={company.dateFormat}
                      onChange={e => setCompany({ ...company, dateFormat: e.target.value })}
                      className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none"
                    >
                      <option>DD/MM/YYYY</option>
                      <option>MM/DD/YYYY</option>
                      <option>YYYY-MM-DD</option>
                    </select>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'appearance' && (
            <div>
              <div className="px-6 py-4 border-b border-border">
                <h2 className="text-base font-bold">Appearance</h2>
                <p className="text-xs text-muted-foreground mt-0.5">Customize the look and feel</p>
              </div>
              <div className="p-6 space-y-5">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Dark Mode</p>
                    <p className="text-xs text-muted-foreground">Switch to dark interface theme</p>
                  </div>
                  <button
                    onClick={() => setAppearance({ ...appearance, darkMode: !appearance.darkMode })}
                    className={`relative w-12 h-6 rounded-full transition-colors ${appearance.darkMode ? 'bg-blue-600' : 'bg-muted'}`}
                  >
                    <div className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${appearance.darkMode ? 'translate-x-7' : 'translate-x-1'}`} />
                  </button>
                </div>
                <div>
                  <p className="text-sm font-medium mb-3">Interface Mode</p>
                  <div className="grid grid-cols-2 gap-3">
                    {['desktop', 'mobile'].map(mode => (
                      <button
                        key={mode}
                        onClick={() => setAppearance({ ...appearance, interface: mode })}
                        className={`p-4 rounded-xl border-2 text-center text-sm font-medium transition capitalize ${appearance.interface === mode ? 'border-blue-600 bg-blue-50 text-blue-600' : 'border-border text-muted-foreground hover:border-blue-300'}`}
                      >
                        {mode} ERP
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="text-sm font-medium mb-3">Color Theme</p>
                  <div className="flex gap-2">
                    {themes.map(color => (
                      <button
                        key={color}
                        onClick={() => setAppearance({ ...appearance, theme: color })}
                        className={`w-8 h-8 rounded-full border-2 transition-transform ${appearance.theme === color ? 'border-slate-900 scale-110' : 'border-transparent'}`}
                        style={{ backgroundColor: color }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'security' && (
            <div>
              <div className="px-6 py-4 border-b border-border">
                <h2 className="text-base font-bold">Security</h2>
                <p className="text-xs text-muted-foreground mt-0.5">Manage account security settings</p>
              </div>
              <div className="p-6 space-y-5">
                <div className="p-4 bg-green-50 border border-green-200 rounded-xl flex items-center gap-3">
                  <Shield className="w-5 h-5 text-green-600" />
                  <div>
                    <p className="text-sm font-semibold text-green-700">Your account is secure</p>
                    <p className="text-xs text-green-600">RBAC is active for all users</p>
                  </div>
                </div>
                <div>
                  <h3 className="text-sm font-semibold mb-3">Change Password</h3>
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs font-medium mb-1">New Password</label>
                      <input
                        type="password"
                        value={passwords.new}
                        onChange={e => setPasswords({ ...passwords, new: e.target.value })}
                        className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">Confirm Password</label>
                      <input
                        type="password"
                        value={passwords.confirm}
                        onChange={e => setPasswords({ ...passwords, confirm: e.target.value })}
                        className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                      />
                    </div>
                    <button
                      onClick={changePassword}
                      disabled={saving || !passwords.new || !passwords.confirm}
                      className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition disabled:opacity-60"
                    >
                      Update Password
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'notifications' && (
            <div>
              <div className="px-6 py-4 border-b border-border">
                <h2 className="text-base font-bold">Notifications</h2>
                <p className="text-xs text-muted-foreground mt-0.5">Configure alert preferences</p>
              </div>
              <div className="p-6 space-y-4">
                {[
                  { key: 'lowStock', label: 'Low stock alerts', desc: 'Get notified when products reach minimum stock level' },
                  { key: 'newOrders', label: 'New orders', desc: 'Alert for new online store orders' },
                  { key: 'paymentReceived', label: 'Payment received', desc: 'Notify when customer payment is recorded' },
                  { key: 'overdueInvoices', label: 'Overdue invoices', desc: 'Daily digest of overdue invoices' },
                  { key: 'deliveryUpdates', label: 'Delivery updates', desc: 'Status changes for deliveries' },
                  { key: 'poApprovals', label: 'Purchase order approvals', desc: 'Notify managers for PO approval' },
                ].map(n => (
                  <div key={n.key} className="flex items-center justify-between py-2">
                    <div>
                      <p className="text-sm font-medium text-foreground">{n.label}</p>
                      <p className="text-xs text-muted-foreground">{n.desc}</p>
                    </div>
                    <button
                      onClick={() => setNotifications({ ...notifications, [n.key]: !notifications[n.key as keyof NotificationSettings] })}
                      className={`relative w-10 h-5 rounded-full transition-colors ${notifications[n.key as keyof NotificationSettings] ? 'bg-blue-600' : 'bg-muted'}`}
                    >
                      <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${notifications[n.key as keyof NotificationSettings] ? 'translate-x-5' : 'translate-x-0.5'}`} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'profile' && (
            <div>
              <div className="px-6 py-4 border-b border-border">
                <h2 className="text-base font-bold">My Profile</h2>
              </div>
              <div className="p-6 space-y-4">
                <div className="flex items-center gap-4">
                  <div className="w-16 h-16 bg-blue-600 rounded-full flex items-center justify-center text-white text-xl font-bold">
                    {profile.full_name?.[0]?.toUpperCase() || 'A'}
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">JPG, PNG. Max 2MB</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium mb-1">Full Name</label>
                    <input
                      value={profile.full_name}
                      onChange={e => setProfile({ ...profile, full_name: e.target.value })}
                      className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">Phone</label>
                    <input
                      value={profile.phone}
                      onChange={e => setProfile({ ...profile, phone: e.target.value })}
                      className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">Email</label>
                    <input
                      value={profile.email}
                      readOnly
                      className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-muted/30 text-muted-foreground"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">Role</label>
                    <input
                      value={roleLabels[profile.role] || profile.role}
                      readOnly
                      className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-muted/30 text-muted-foreground"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'data' && (
            <div>
              <div className="px-6 py-4 border-b border-border">
                <h2 className="text-base font-bold">Data Management</h2>
                <p className="text-xs text-muted-foreground mt-0.5">Backup, export, and manage your ERP data</p>
              </div>
              <div className="p-6 space-y-6">

                {/* ── BACKUP SECTION ── */}
                <div className="rounded-xl border border-blue-200 bg-blue-50/50 overflow-hidden">
                  <div className="px-5 py-4 border-b border-blue-100">
                    <div className="flex items-center gap-2">
                      <Database className="w-4 h-4 text-blue-600" />
                      <h3 className="text-sm font-bold text-blue-800">Database Backup</h3>
                    </div>
                    <p className="text-xs text-blue-600 mt-1">Downloads a full JSON backup of all your data, schema column definitions, and RLS policies.</p>
                  </div>
                  <div className="px-5 py-4 space-y-3">
                    <div className="grid grid-cols-3 gap-3 text-center">
                      {[
                        { label: 'All Tables', value: '42' },
                        { label: 'Schema Info', value: 'Included' },
                        { label: 'RLS Policies', value: 'Included' },
                      ].map(s => (
                        <div key={s.label} className="bg-white rounded-lg p-3 border border-blue-100">
                          <p className="text-base font-bold text-blue-700">{s.value}</p>
                          <p className="text-[10px] text-blue-500 mt-0.5">{s.label}</p>
                        </div>
                      ))}
                    </div>
                    <div className="p-3 bg-white border border-blue-100 rounded-lg text-xs text-blue-700 space-y-1">
                      <p className="font-semibold">What is included in the backup:</p>
                      <ul className="list-disc list-inside space-y-0.5 text-blue-600">
                        <li>All rows from every table (products, invoices, customers, etc.)</li>
                        <li>Column definitions from <code className="bg-blue-100 px-1 rounded">information_schema</code></li>
                        <li>All RLS policies from <code className="bg-blue-100 px-1 rounded">pg_policies</code></li>
                        <li>Table constraints (primary keys, foreign keys)</li>
                        <li>Row counts per table</li>
                      </ul>
                      <p className="text-amber-600 font-medium mt-2">Note: Trigger functions and stored procedures require a full pg_dump for complete schema backup.</p>
                    </div>
                    <button
                      onClick={downloadBackup}
                      disabled={backupLoading}
                      className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-60 w-full justify-center"
                    >
                      {backupLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                      {backupLoading ? 'Preparing backup...' : 'Download Full Backup (.json)'}
                    </button>
                  </div>
                </div>

                {/* ── RESTORE SECTION ── */}
                <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 overflow-hidden">
                  <div className="px-5 py-4 border-b border-emerald-100">
                    <div className="flex items-center gap-2">
                      <RefreshCw className="w-4 h-4 text-emerald-600" />
                      <h3 className="text-sm font-bold text-emerald-800">Restore from Backup</h3>
                    </div>
                    <p className="text-xs text-emerald-700 mt-1">Upload a JSON backup file to restore all data. Existing data will be replaced. This cannot be undone.</p>
                  </div>
                  <div className="px-5 py-4 space-y-3">
                    <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
                      <p className="font-semibold">Before restoring:</p>
                      <ul className="list-disc list-inside mt-1 space-y-0.5">
                        <li>Download a fresh backup first in case you need to roll back</li>
                        <li>Only backups created by this system are supported</li>
                        <li>All existing data will be replaced with the backup data</li>
                      </ul>
                    </div>
                    <label className={`flex flex-col items-center justify-center gap-2 w-full border-2 border-dashed rounded-xl p-6 cursor-pointer transition ${
                      restoreLoading ? 'border-emerald-200 bg-emerald-50 cursor-not-allowed' : 'border-emerald-300 hover:bg-emerald-50 hover:border-emerald-400'
                    }`}>
                      {restoreLoading ? (
                        <><Loader2 className="w-7 h-7 text-emerald-500 animate-spin" /><p className="text-sm font-semibold text-emerald-700">Restoring data, please wait...</p></>
                      ) : (
                        <><Download className="w-7 h-7 text-emerald-400 rotate-180" /><p className="text-sm font-semibold text-emerald-700">Click to upload backup file</p><p className="text-xs text-emerald-500">.json files only</p></>
                      )}
                      <input type="file" accept=".json,application/json" className="hidden" disabled={restoreLoading}
                        onChange={e => { const f = e.target.files?.[0]; if (f) handleRestoreUpload(f); e.target.value = ''; }}
                      />
                    </label>
                    {restoreResult && (
                      <div className={`p-3 rounded-lg border text-xs space-y-1.5 ${
                        restoreResult.success ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-red-50 border-red-200 text-red-800'
                      }`}>
                        <p className="font-semibold flex items-center gap-1.5">
                          {restoreResult.success ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
                          {restoreResult.success ? 'Restore successful' : 'Restore completed with errors'}
                        </p>
                        <p>{restoreResult.stats.total_rows_inserted.toLocaleString()} rows restored &mdash; {restoreResult.stats.tables_restored} tables OK, {restoreResult.stats.tables_failed} failed</p>
                        {restoreResult.errors && restoreResult.errors.length > 0 && (
                          <ul className="list-disc list-inside space-y-0.5">{restoreResult.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* ── SELECTIVE DELETE SECTION ── */}
                <div className="rounded-xl border border-red-200 overflow-hidden">
                  <div className="px-5 py-4 bg-red-50 border-b border-red-100">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 text-red-600" />
                      <h3 className="text-sm font-bold text-red-800">Selective Data Deletion</h3>
                    </div>
                    <p className="text-xs text-red-600 mt-1">Permanently delete specific data categories. These actions cannot be undone. Download a backup first.</p>
                  </div>
                  <div className="divide-y divide-border">
                    {([
                      {
                        key: 'products',
                        label: 'All Products',
                        description: 'Deletes all products, units, variants, and inventory items. Also clears invoice/PO line items.',
                        tables: ['products'],
                        icon: Package,
                        color: 'text-orange-600',
                        bg: 'bg-orange-50',
                      },
                      {
                        key: 'invoices',
                        label: 'All Invoices & Sales',
                        description: 'Deletes all invoices (including POS), payments, sales returns, and linked deliveries.',
                        tables: ['invoices'],
                        icon: FileText,
                        color: 'text-blue-600',
                        bg: 'bg-blue-50',
                      },
                      {
                        key: 'quotations',
                        label: 'All Quotations',
                        description: 'Deletes all quotations and their line items.',
                        tables: ['quotations'],
                        icon: ClipboardList,
                        color: 'text-teal-600',
                        bg: 'bg-teal-50',
                      },
                      {
                        key: 'deliveries',
                        label: 'All Deliveries',
                        description: 'Deletes all delivery challans and delivery items.',
                        tables: ['deliveries'],
                        icon: Truck,
                        color: 'text-indigo-600',
                        bg: 'bg-indigo-50',
                      },
                      {
                        key: 'purchases',
                        label: 'All Purchases',
                        description: 'Deletes all purchase orders, GRNs, and purchase line items.',
                        tables: ['purchase_orders'],
                        icon: ShoppingCart,
                        color: 'text-amber-600',
                        bg: 'bg-amber-50',
                      },
                      {
                        key: 'journal',
                        label: 'All Journal Entries',
                        description: 'Deletes all journal entries and journal lines. Account balances will NOT be recalculated automatically.',
                        tables: ['journal_entries'],
                        icon: BookOpen,
                        color: 'text-purple-600',
                        bg: 'bg-purple-50',
                      },
                    ] as (DeleteTarget & { icon: React.ElementType; color: string; bg: string })[]).map((item) => (
                      <div key={item.key} className="flex items-center justify-between px-5 py-4 hover:bg-muted/20 transition">
                        <div className="flex items-start gap-3">
                          <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${item.bg}`}>
                            <item.icon className={`w-4 h-4 ${item.color}`} />
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-semibold text-foreground">{item.label}</p>
                              {deleteCounts[item.key] !== undefined && (
                                <span className="text-[10px] font-medium px-1.5 py-0.5 bg-muted rounded-full text-muted-foreground">
                                  {deleteCounts[item.key].toLocaleString()} records
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground mt-0.5 max-w-md">{item.description}</p>
                          </div>
                        </div>
                        <button
                          onClick={() => setDeleteTarget(item)}
                          disabled={saving || deleteCounts[item.key] === 0}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 rounded-lg text-xs font-semibold transition disabled:opacity-40 shrink-0 ml-4"
                        >
                          <Trash2 className="w-3.5 h-3.5" />Delete All
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                {/* ── OTHER ACTIONS ── */}
                <div className="rounded-xl border border-border overflow-hidden">
                  <div className="px-5 py-3 bg-muted/30 border-b border-border">
                    <h3 className="text-sm font-semibold">Other Actions</h3>
                  </div>
                  <div className="divide-y divide-border">
                    <div className="flex items-center justify-between px-5 py-4">
                      <div>
                        <p className="text-sm font-semibold text-foreground">Reset Categories &amp; Brands</p>
                        <p className="text-xs text-muted-foreground">Remove all categories and brands</p>
                      </div>
                      <button
                        onClick={async () => {
                          if (!confirm('Remove all categories and brands?')) return;
                          setSaving(true);
                          await supabase.from('products').update({ category_id: null, brand_id: null }).neq('id', '00000000-0000-0000-0000-000000000000');
                          await supabase.from('categories').delete().neq('id', '00000000-0000-0000-0000-000000000000');
                          await supabase.from('brands').delete().neq('id', '00000000-0000-0000-0000-000000000000');
                          toast({ title: 'Success', description: 'Categories and brands cleared' });
                          setSaving(false);
                        }}
                        disabled={saving}
                        className="flex items-center gap-2 px-3 py-1.5 bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-200 rounded-lg text-xs font-semibold transition disabled:opacity-60"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />Reset
                      </button>
                    </div>
                  </div>
                </div>

              </div>
            </div>
          )}

          {deleteTarget && (
            <DeleteConfirmModal
              target={deleteTarget}
              onClose={() => setDeleteTarget(null)}
              onConfirm={async () => {
                setSaving(true);
                await executeDelete(deleteTarget);
                setDeleteTarget(null);
                setSaving(false);
              }}
              saving={saving}
            />
          )}

          <div className="px-6 py-4 border-t border-border flex items-center justify-end gap-3">
            <button
              onClick={() => {
                if (activeTab === 'general') saveSettings('company', company);
                else if (activeTab === 'notifications') saveSettings('notifications', notifications);
                else if (activeTab === 'appearance') saveSettings('appearance', appearance);
                else if (activeTab === 'profile') saveProfile();
              }}
              disabled={saving}
              className="flex items-center gap-2 px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-60"
            >
              <Save className="w-4 h-4" />
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function DeleteConfirmModal({ target, onClose, onConfirm, saving }: {
  target: DeleteTarget;
  onClose: () => void;
  onConfirm: () => void;
  saving: boolean;
}) {
  const [typed, setTyped] = useState('');
  const confirmWord = 'DELETE';

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-base font-bold text-red-600 flex items-center gap-2">
            <AlertTriangle className="w-5 h-5" />Delete {target.label}
          </h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-6 space-y-4">
          <div className="p-4 bg-red-50 border border-red-200 rounded-xl">
            <p className="text-sm font-semibold text-red-700">This action is permanent and cannot be undone.</p>
            <p className="text-xs text-red-600 mt-1">{target.description}</p>
          </div>
          <div>
            <p className="text-sm text-foreground mb-2">
              Type <span className="font-mono font-bold bg-red-100 px-1.5 py-0.5 rounded text-red-700">{confirmWord}</span> to confirm:
            </p>
            <input
              type="text"
              value={typed}
              onChange={e => setTyped(e.target.value.toUpperCase())}
              placeholder={confirmWord}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500/20 font-mono"
            />
          </div>
          <div className="flex items-center justify-end gap-3 pt-1">
            <button type="button" onClick={onClose} className="px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Cancel</button>
            <button
              onClick={onConfirm}
              disabled={typed !== confirmWord || saving}
              className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-40"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
              {saving ? 'Deleting...' : `Delete All ${target.label}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
