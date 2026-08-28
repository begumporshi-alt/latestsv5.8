'use client';

import { useEffect, useState, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/format';
import { toast } from '@/hooks/use-toast';
import { Users, Plus, Search, CreditCard as Edit, Trash2, Phone, Mail, X, HardHat, Building2, Star, Palette, Eye, RotateCcw, Filter, ChevronDown, HandCoins, ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import type { Customer, CustomerType } from '@/lib/types';
import CollectPaymentModal from '@/components/CollectPaymentModal';
import RecordButton from '@/components/RecordButton';

const typeConfig: Record<CustomerType, { label: string; color: string; icon: React.ElementType }> = {
  retail: { label: 'Retail', color: 'bg-gray-100 text-gray-700', icon: Users },
  contractor: { label: 'Contractor', color: 'bg-blue-100 text-blue-700', icon: HardHat },
  builder: { label: 'Builder', color: 'bg-orange-100 text-orange-700', icon: Building2 },
  architect: { label: 'Architect', color: 'bg-purple-100 text-purple-700', icon: Star },
  interior_designer: { label: 'Interior Designer', color: 'bg-pink-100 text-pink-700', icon: Palette },
  corporate: { label: 'Corporate', color: 'bg-green-100 text-green-700', icon: Building2 },
  government: { label: 'Government', color: 'bg-teal-100 text-teal-700', icon: Building2 },
};

type CustomerWithOutstanding = Customer & {
  invoice_outstanding: number;
  manual_outstanding: number;
  return_count: number;
  return_total: number;
  total_purchases_calc: number;
};

const PERIODS = [
  { value: '', label: 'All Time' },
  { value: '7', label: 'Last 7 Days' },
  { value: '30', label: 'Last 30 Days' },
  { value: '90', label: 'Last 90 Days' },
  { value: '365', label: 'This Year' },
];

export default function CRMPage() {
  const [customers, setCustomers] = useState<CustomerWithOutstanding[]>([]);
  const [loading, setLoading] = useState(true);
  const [showFilters, setShowFilters] = useState(false);

  // Filter state
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState('');
  const [filterCity, setFilterCity] = useState('');
  const [filterPeriod, setFilterPeriod] = useState('');
  const [filterOutstandingType, setFilterOutstandingType] = useState<'' | 'invoice' | 'manual'>('');
  const [outstandingMin, setOutstandingMin] = useState('');
  const [outstandingMax, setOutstandingMax] = useState('');
  const [creditMin, setCreditMin] = useState('');
  const [creditMax, setCreditMax] = useState('');

  const [showAddModal, setShowAddModal] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [deletingCustomer, setDeletingCustomer] = useState<Customer | null>(null);
  const [collectingCustomer, setCollectingCustomer] = useState<CustomerWithOutstanding | null>(null);
  const [stats, setStats] = useState({ total: 0, totalRevenue: 0, outstanding: 0, active: 0, totalRefunds: 0, invoiceOutstanding: 0, manualOutstanding: 0 });
  const [currentPage, setCurrentPage] = useState(1);
  const PAGE_SIZE = 25;

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);
    const [{ data: custData }, { data: invoiceData }, { data: returnsData }] = await Promise.all([
      supabase.from('customers').select('*').order('name'),
      supabase.from('invoices')
        .select('customer_id, total_amount, balance_due, status, invoice_date')
        .neq('status', 'cancelled'),
      supabase.from('sales_returns').select('customer_id, total_refund_amount, created_at'),
    ]);

    // Build invoice outstanding map (unpaid balance from invoices)
    const invoiceOutstandingMap: Record<string, number> = {};
    const purchasesMap: Record<string, number> = {};
    (invoiceData || []).forEach((inv: any) => {
      if (!inv.customer_id) return;
      purchasesMap[inv.customer_id] = (purchasesMap[inv.customer_id] || 0) + Number(inv.total_amount);
      if (['sent', 'partially_paid'].includes(inv.status)) {
        invoiceOutstandingMap[inv.customer_id] = (invoiceOutstandingMap[inv.customer_id] || 0) + Number(inv.balance_due || 0);
      }
    });

    // Returns map
    const returnsMap: Record<string, { count: number; total: number }> = {};
    (returnsData || []).forEach((r: any) => {
      if (!r.customer_id) return;
      if (!returnsMap[r.customer_id]) returnsMap[r.customer_id] = { count: 0, total: 0 };
      returnsMap[r.customer_id].count++;
      returnsMap[r.customer_id].total += Number(r.total_refund_amount) || 0;
    });

    const enriched: CustomerWithOutstanding[] = (custData || []).map((c: Customer) => {
      const invOut = invoiceOutstandingMap[c.id] || 0;
      const totalOut = Number(c.outstanding_balance) || 0;
      const manualOut = Math.max(0, totalOut - invOut);
      return {
        ...c,
        invoice_outstanding: invOut,
        manual_outstanding: manualOut,
        return_count: returnsMap[c.id]?.count || 0,
        return_total: returnsMap[c.id]?.total || 0,
        total_purchases_calc: purchasesMap[c.id] || 0,
      };
    });

    setCustomers(enriched);

    const totalRev = Object.values(purchasesMap).reduce((s, v) => s + v, 0);
    const totalOut = (custData || []).reduce((s: number, c: Customer) => s + Number(c.outstanding_balance), 0);
    const totalRef = Object.values(returnsMap).reduce((s, v) => s + v.total, 0);
    const totalInvOut = Object.values(invoiceOutstandingMap).reduce((s, v) => s + v, 0);
    const totalManualOut = Math.max(0, totalOut - totalInvOut);
    setStats({
      total: custData?.length || 0,
      totalRevenue: totalRev,
      outstanding: totalOut,
      active: (custData || []).filter((c: Customer) => c.is_active).length,
      totalRefunds: totalRef,
      invoiceOutstanding: totalInvOut,
      manualOutstanding: totalManualOut,
    });
    setLoading(false);
  }

  // Unique cities for filter dropdown
  const cities = useMemo(() => {
    const set = new Set(customers.map(c => c.city).filter(Boolean) as string[]);
    return Array.from(set).sort();
  }, [customers]);

  // Period cutoff date
  const periodCutoff = useMemo(() => {
    if (!filterPeriod) return null;
    const d = new Date();
    d.setDate(d.getDate() - Number(filterPeriod));
    return d.toISOString();
  }, [filterPeriod]);

  const filtered = useMemo(() => {
    return customers.filter(c => {
      // Text search: name, phone, email, city, code
      if (search) {
        const s = search.toLowerCase();
        const matches = c.name.toLowerCase().includes(s) ||
          (c.phone || '').includes(s) ||
          (c.email || '').toLowerCase().includes(s) ||
          (c.city || '').toLowerCase().includes(s) ||
          (c.code || '').toLowerCase().includes(s);
        if (!matches) return false;
      }
      if (filterType && c.type !== filterType) return false;
      if (filterCity && c.city !== filterCity) return false;

      // Outstanding type filter
      const outstandingVal = filterOutstandingType === 'invoice'
        ? c.invoice_outstanding
        : filterOutstandingType === 'manual'
          ? c.manual_outstanding
          : Number(c.outstanding_balance);
      if (outstandingMin && outstandingVal < Number(outstandingMin)) return false;
      if (outstandingMax && outstandingVal > Number(outstandingMax)) return false;

      // Credit limit range
      if (creditMin && Number(c.credit_limit) < Number(creditMin)) return false;
      if (creditMax && Number(c.credit_limit) > Number(creditMax)) return false;

      return true;
    });
  }, [customers, search, filterType, filterCity, filterOutstandingType, outstandingMin, outstandingMax, creditMin, creditMax, periodCutoff]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  useEffect(() => { setCurrentPage(1); }, [search, filterType, filterCity, filterOutstandingType, outstandingMin, outstandingMax, creditMin, creditMax, filterPeriod]);

  const activeFilterCount = [filterType, filterCity, filterPeriod, filterOutstandingType, outstandingMin, outstandingMax, creditMin, creditMax].filter(Boolean).length;

  async function handleDelete() {
    if (!deletingCustomer) return;
    const { error } = await supabase.from('customers').update({ is_active: false }).eq('id', deletingCustomer.id);
    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    } else {
      toast({ title: 'Success', description: 'Customer deactivated successfully' });
      loadData();
    }
    setDeletingCustomer(null);
  }

  function clearFilters() {
    setFilterType(''); setFilterCity(''); setFilterPeriod('');
    setFilterOutstandingType(''); setOutstandingMin(''); setOutstandingMax('');
    setCreditMin(''); setCreditMax('');
  }

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">CRM - Customers</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Manage customer relationships</p>
        </div>
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
          <RecordButton variant="receivable" onSaved={loadData} />
          <button onClick={() => setShowAddModal(true)} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition whitespace-nowrap">
            <Plus className="w-4 h-4" />Add Customer
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-4">
        {[
          { label: 'Total Customers', value: stats.total, color: 'text-blue-500' },
          { label: 'Active', value: stats.active, color: 'text-green-500' },
          { label: 'Total Revenue', value: formatCurrency(stats.totalRevenue), color: 'text-slate-600' },
          { label: 'Invoice Outstanding', value: formatCurrency(stats.invoiceOutstanding), color: 'text-amber-600' },
          { label: 'Manual Outstanding', value: formatCurrency(stats.manualOutstanding), color: 'text-purple-600' },
          { label: 'Total Outstanding', value: formatCurrency(stats.outstanding), color: 'text-red-500' },
          { label: 'Total Refunds', value: formatCurrency(stats.totalRefunds), color: 'text-orange-500' },
        ].map(s => (
          <div key={s.label} className="stat-card">
            <p className="text-xs text-muted-foreground">{s.label}</p>
            <p className={`text-xl font-bold mt-1 ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Search + Filter Bar */}
      <div className="bg-white rounded-xl border border-border shadow-sm">
        <div className="flex flex-wrap gap-3 p-4 border-b border-border">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by name, phone, email, city, code..."
              className="w-full pl-8 pr-4 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
          </div>
          <select value={filterType} onChange={e => setFilterType(e.target.value)} className="border border-border rounded-lg px-3 py-2 text-sm focus:outline-none min-w-[130px]">
            <option value="">All Types</option>
            {Object.entries(typeConfig).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <button
            onClick={() => setShowFilters(f => !f)}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm border transition ${showFilters || activeFilterCount > 0 ? 'bg-blue-600 text-white border-blue-600' : 'border-border hover:bg-muted'}`}
          >
            <Filter className="w-3.5 h-3.5" />
            Advanced Filters
            {activeFilterCount > 0 && <span className="bg-white text-blue-600 rounded-full w-5 h-5 text-xs flex items-center justify-center font-bold">{activeFilterCount}</span>}
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showFilters ? 'rotate-180' : ''}`} />
          </button>
          {activeFilterCount > 0 && (
            <button onClick={clearFilters} className="text-xs text-red-500 hover:text-red-700 flex items-center gap-1">
              <X className="w-3 h-3" />Clear filters
            </button>
          )}
        </div>

        {/* Advanced Filters Panel */}
        {showFilters && (
          <div className="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 bg-gray-50 border-b border-border">
            {/* City */}
            <div>
              <label className="block text-xs font-semibold text-muted-foreground mb-1.5">City</label>
              <select value={filterCity} onChange={e => setFilterCity(e.target.value)} className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none">
                <option value="">All Cities</option>
                {cities.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>

            {/* Period */}
            <div>
              <label className="block text-xs font-semibold text-muted-foreground mb-1.5">Customer Since</label>
              <select value={filterPeriod} onChange={e => setFilterPeriod(e.target.value)} className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none">
                {PERIODS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>

            {/* Outstanding Type */}
            <div>
              <label className="block text-xs font-semibold text-muted-foreground mb-1.5">Outstanding Type</label>
              <select value={filterOutstandingType} onChange={e => setFilterOutstandingType(e.target.value as '' | 'invoice' | 'manual')} className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none">
                <option value="">Total Outstanding</option>
                <option value="invoice">Invoice Outstanding</option>
                <option value="manual">Manual Outstanding</option>
              </select>
            </div>

            {/* Outstanding Range */}
            <div>
              <label className="block text-xs font-semibold text-muted-foreground mb-1.5">
                Outstanding Range{filterOutstandingType === 'invoice' ? ' (Invoice)' : filterOutstandingType === 'manual' ? ' (Manual)' : ''}
              </label>
              <div className="flex gap-2">
                <input
                  type="number" min="0" value={outstandingMin}
                  onChange={e => setOutstandingMin(e.target.value)}
                  placeholder="Min"
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none"
                />
                <input
                  type="number" min="0" value={outstandingMax}
                  onChange={e => setOutstandingMax(e.target.value)}
                  placeholder="Max"
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none"
                />
              </div>
            </div>

            {/* Credit Limit Range */}
            <div>
              <label className="block text-xs font-semibold text-muted-foreground mb-1.5">Credit Limit Range</label>
              <div className="flex gap-2">
                <input
                  type="number" min="0" value={creditMin}
                  onChange={e => setCreditMin(e.target.value)}
                  placeholder="Min"
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none"
                />
                <input
                  type="number" min="0" value={creditMax}
                  onChange={e => setCreditMax(e.target.value)}
                  placeholder="Max"
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Table */}
      <div className="table-wrapper">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-muted/40 border-b border-border">
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Customer</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Type</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Contact</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">City</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Total Purchases</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Returns</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Invoice Due</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Manual Due</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Total Outstanding</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Credit Limit</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading ? Array.from({ length: 6 }).map((_, i) => (
                <tr key={i}>{Array.from({ length: 11 }).map((_, j) => <td key={j} className="px-4 py-3"><div className="h-4 bg-muted rounded animate-pulse" /></td>)}</tr>
              )) : filtered.length === 0 ? (
                <tr><td colSpan={11} className="px-4 py-12 text-center text-muted-foreground text-sm">No customers found</td></tr>
              ) : paginated.map(c => {
                const cfg = typeConfig[c.type] || typeConfig.retail;
                return (
                  <tr key={c.id} className={`hover:bg-muted/30 transition-colors ${!c.is_active ? 'opacity-50' : ''}`}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center text-blue-700 text-sm font-bold">{c.name[0]}</div>
                        <div>
                          <p className="text-sm font-semibold text-foreground">{c.name}</p>
                          <p className="text-xs text-muted-foreground">{c.code}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3"><span className={`badge-status ${cfg.color}`}>{cfg.label}</span></td>
                    <td className="px-4 py-3">
                      <div className="text-xs text-muted-foreground space-y-0.5">
                        {c.phone && <div className="flex items-center gap-1"><Phone className="w-3 h-3" />{c.phone}</div>}
                        {c.email && <div className="flex items-center gap-1"><Mail className="w-3 h-3" />{c.email}</div>}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-foreground">{c.city || '-'}</td>
                    <td className="px-4 py-3 text-right text-sm font-semibold text-foreground">{formatCurrency(c.total_purchases_calc)}</td>
                    <td className="px-4 py-3 text-right">
                      {c.return_count > 0 ? (
                        <div className="flex items-center justify-end gap-1">
                          <RotateCcw className="w-3 h-3 text-orange-500" />
                          <span className="text-xs text-orange-600">{c.return_count}</span>
                          <span className="text-xs text-muted-foreground">({formatCurrency(c.return_total)})</span>
                        </div>
                      ) : <span className="text-xs text-muted-foreground">-</span>}
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-medium text-amber-600">
                      {c.invoice_outstanding > 0 ? formatCurrency(c.invoice_outstanding) : '-'}
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-medium text-purple-600">
                      {c.manual_outstanding > 0 ? formatCurrency(c.manual_outstanding) : '-'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {Number(c.outstanding_balance) > 0 ? (
                        <span className="text-sm font-bold text-red-600">{formatCurrency(Number(c.outstanding_balance))}</span>
                      ) : <span className="text-xs text-muted-foreground">-</span>}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-muted-foreground">{formatCurrency(c.credit_limit)}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Link href={`/crm/${c.id}`} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-blue-50 text-muted-foreground hover:text-blue-600 transition" title="View Details"><Eye className="w-3.5 h-3.5" /></Link>
                        {Number(c.outstanding_balance) > 0 && (
                          <button onClick={() => setCollectingCustomer(c)} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-green-50 text-muted-foreground hover:text-green-600 transition" title="Collect Payment"><HandCoins className="w-3.5 h-3.5" /></button>
                        )}
                        <button onClick={() => setEditingCustomer(c)} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-blue-50 text-muted-foreground hover:text-blue-600 transition" title="Edit"><Edit className="w-3.5 h-3.5" /></button>
                        <button onClick={() => setDeletingCustomer(c)} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-red-50 text-muted-foreground hover:text-red-600 transition" title="Deactivate"><Trash2 className="w-3.5 h-3.5" /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-3 border-t border-border flex items-center justify-between flex-wrap gap-2">
          <p className="text-xs text-muted-foreground">{filtered.length} of {customers.length} customers</p>
          {totalPages > 1 && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="w-8 h-8 flex items-center justify-center rounded-lg border border-border hover:bg-muted transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-xs font-medium text-muted-foreground">
                Page {currentPage} of {totalPages}
              </span>
              <button
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                className="w-8 h-8 flex items-center justify-center rounded-lg border border-border hover:bg-muted transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      </div>

      {showAddModal && <CustomerModal onClose={() => setShowAddModal(false)} onSaved={loadData} />}
      {editingCustomer && <CustomerModal customer={editingCustomer} onClose={() => setEditingCustomer(null)} onSaved={loadData} />}
      {deletingCustomer && (
        <DeleteConfirmModal
          name={deletingCustomer.name}
          onClose={() => setDeletingCustomer(null)}
          onConfirm={handleDelete}
        />
      )}
      {collectingCustomer && (
        <CollectPaymentModal
          customerId={collectingCustomer.id}
          customerName={collectingCustomer.name}
          totalOutstanding={Number(collectingCustomer.outstanding_balance) || 0}
          invoiceOutstanding={collectingCustomer.invoice_outstanding}
          manualOutstanding={collectingCustomer.manual_outstanding}
          onClose={() => setCollectingCustomer(null)}
          onSaved={loadData}
        />
      )}
    </div>
  );
}

function CustomerModal({ customer, onClose, onSaved }: { customer?: Customer | null; onClose: () => void; onSaved: () => void }) {
  const isEdit = !!customer;
  const [form, setForm] = useState({
    name: customer?.name || '',
    code: customer?.code || '',
    type: customer?.type || 'retail',
    phone: customer?.phone || '',
    email: customer?.email || '',
    city: customer?.city || '',
    address: customer?.address || '',
    credit_limit: customer?.credit_limit?.toString() || '0',
    credit_days: customer?.credit_days?.toString() || '30',
    is_active: customer?.is_active ?? true,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isEdit && !form.code) {
      supabase.rpc('generate_customer_code').then(({ data }) => {
        if (data) setForm(f => ({ ...f, code: data as string }));
      });
    }
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');

    const data = {
      name: form.name,
      code: form.code,
      type: form.type as CustomerType,
      phone: form.phone || null,
      email: form.email || null,
      city: form.city || null,
      address: form.address || null,
      credit_limit: Number(form.credit_limit),
      credit_days: Number(form.credit_days),
      is_active: form.is_active,
      country: (customer?.country || 'Bangladesh'),
      loyalty_points: customer?.loyalty_points || 0,
      discount_percent: customer?.discount_percent || 0,
      total_purchases: customer?.total_purchases || 0,
      outstanding_balance: customer?.outstanding_balance || 0,
    };

    const { error } = isEdit
      ? await supabase.from('customers').update(data).eq('id', customer!.id)
      : await supabase.from('customers').insert(data);

    if (error) { setError(error.message); setSaving(false); return; }

    toast({ title: 'Success', description: isEdit ? 'Customer updated successfully' : 'Customer created successfully' });
    onSaved();
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-white">
          <h2 className="text-base font-bold">{isEdit ? 'Edit Customer' : 'Add New Customer'}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={handleSave} className="p-6 space-y-4">
          {error && <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>}
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-xs font-medium mb-1">Customer Name *</label><input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" /></div>
            <div>
              <label className="block text-xs font-medium mb-1">Customer Code</label>
              <input
                value={form.code}
                readOnly={!isEdit}
                onChange={e => isEdit && setForm({ ...form, code: e.target.value })}
                placeholder="Auto-generated..."
                className={`w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none ${!isEdit ? 'bg-gray-50 text-gray-500 cursor-default' : 'focus:ring-2 focus:ring-blue-500/20'}`}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">Type</label>
              <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value as CustomerType })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none">
                {Object.entries(typeConfig).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </div>
            <div><label className="block text-xs font-medium mb-1">Phone</label><input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" /></div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-xs font-medium mb-1">Email</label><input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" /></div>
            <div><label className="block text-xs font-medium mb-1">City</label><input value={form.city} onChange={e => setForm({ ...form, city: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" /></div>
          </div>
          <div><label className="block text-xs font-medium mb-1">Address</label><textarea value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} rows={2} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" /></div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-xs font-medium mb-1">Credit Limit</label><input type="number" min="0" value={form.credit_limit} onChange={e => setForm({ ...form, credit_limit: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" /></div>
            <div><label className="block text-xs font-medium mb-1">Credit Days</label><input type="number" min="0" value={form.credit_days} onChange={e => setForm({ ...form, credit_days: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" /></div>
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
              {saving ? 'Saving...' : isEdit ? 'Update Customer' : 'Save Customer'}
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
          <h2 className="text-lg font-bold text-center mb-2">Deactivate Customer?</h2>
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
