'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/format';
import { useToast } from '@/hooks/use-toast';
import { Search, Wallet, CircleArrowDown as ArrowDownCircle, CircleArrowUp as ArrowUpCircle, Eye, X, Plus, TrendingUp, Clock, CircleCheck as CheckCircle2, CircleAlert as AlertCircle, HandCoins, ArrowRightLeft, RotateCcw } from 'lucide-react';

interface Advance {
  id: string;
  advance_number: string;
  customer_id: string;
  customer_name: string;
  customer_code: string;
  amount: number;
  balance: number;
  status: string;
  payment_method: string;
  payment_date: string;
  reference_number: string | null;
  notes: string;
  created_at: string;
}

interface Application {
  id: string;
  advance_id: string;
  advance_number: string;
  customer_id: string;
  customer_name: string;
  invoice_id: string | null;
  invoice_number: string | null;
  amount: number;
  notes: string;
  created_at: string;
}

interface PaymentMethod { code: string; name: string; }
interface Customer { id: string; name: string; code: string; }

export default function CustomerAdvancesPage() {
  const { toast } = useToast();
  const [advances, setAdvances] = useState<Advance[]>([]);
  const [applications, setApplications] = useState<Application[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'advances' | 'applications'>('advances');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [stats, setStats] = useState({ totalReceived: 0, totalApplied: 0, activeBalance: 0, activeCount: 0 });
  const [detailAdvance, setDetailAdvance] = useState<Advance | null>(null);
  const [detailApplications, setDetailApplications] = useState<Application[]>([]);
  const [showRecord, setShowRecord] = useState(false);
  const [showApply, setShowApply] = useState<Advance | null>(null);
  const [showRefund, setShowRefund] = useState<Advance | null>(null);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);

    const { data: pmData } = await supabase.from('payment_methods').select('code, name').eq('is_active', true).order('name');
    setPaymentMethods(pmData || []);

    const { data: advData } = await supabase
      .from('customer_advances')
      .select(`
        id, advance_number, customer_id, amount, balance, status, payment_method,
        payment_date, reference_number, notes, created_at,
        customer:customers!inner(name, code)
      `)
      .order('created_at', { ascending: false });

    const advancesTyped: Advance[] = (advData || []).map((a: any) => ({
      id: a.id,
      advance_number: a.advance_number,
      customer_id: a.customer_id,
      customer_name: a.customer?.name || 'Unknown',
      customer_code: a.customer?.code || '',
      amount: Number(a.amount),
      balance: Number(a.balance),
      status: a.status,
      payment_method: a.payment_method,
      payment_date: a.payment_date,
      reference_number: a.reference_number,
      notes: a.notes || '',
      created_at: a.created_at,
    }));
    setAdvances(advancesTyped);

    const { data: appData } = await supabase
      .from('customer_advance_applications')
      .select(`
        id, advance_id, customer_id, amount, notes, created_at,
        advance:customer_advances(advance_number),
        customer:customers!inner(name),
        invoice:invoices(invoice_number)
      `)
      .order('created_at', { ascending: false });

    const appsTyped: Application[] = (appData || []).map((r: any) => ({
      id: r.id,
      advance_id: r.advance_id,
      advance_number: r.advance?.advance_number || '',
      customer_id: r.customer_id,
      customer_name: r.customer?.name || 'Unknown',
      invoice_id: r.invoice_id || null,
      invoice_number: r.invoice?.invoice_number || null,
      amount: Number(r.amount),
      notes: r.notes || '',
      created_at: r.created_at,
    }));
    setApplications(appsTyped);

    const totalReceived = advancesTyped.reduce((s, a) => s + a.amount, 0);
    const totalApplied = appsTyped.reduce((s, a) => s + a.amount, 0);
    const activeBalance = advancesTyped.filter(a => a.status === 'active').reduce((s, a) => s + a.balance, 0);
    const activeCount = advancesTyped.filter(a => a.status === 'active').length;
    setStats({ totalReceived, totalApplied, activeBalance, activeCount });

    setLoading(false);
  }

  async function viewDetail(advance: Advance) {
    setDetailAdvance(advance);
    const { data } = await supabase
      .from('customer_advance_applications')
      .select(`
        id, amount, notes, created_at,
        invoice:invoices(invoice_number)
      `)
      .eq('advance_id', advance.id)
      .order('created_at', { ascending: false });
    setDetailApplications((data || []).map((r: any) => ({
      id: r.id,
      advance_id: advance.id,
      advance_number: advance.advance_number,
      customer_id: advance.customer_id,
      customer_name: advance.customer_name,
      invoice_id: null,
      invoice_number: r.invoice?.invoice_number || null,
      amount: Number(r.amount),
      notes: r.notes || '',
      created_at: r.created_at,
    })));
  }

  const filteredAdvances = advances.filter(a => {
    const matchesSearch = !search.trim()
      || a.advance_number.toLowerCase().includes(search.trim().toLowerCase())
      || a.customer_name.toLowerCase().includes(search.trim().toLowerCase())
      || a.customer_code.toLowerCase().includes(search.trim().toLowerCase());
    const matchesStatus = statusFilter === 'all' || a.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const filteredApplications = applications.filter(a => {
    if (!search.trim()) return true;
    return a.advance_number.toLowerCase().includes(search.trim().toLowerCase())
      || a.customer_name.toLowerCase().includes(search.trim().toLowerCase())
      || (a.invoice_number || '').toLowerCase().includes(search.trim().toLowerCase());
  });

  const paymentMethodLabels: Record<string, string> = {
    cash: 'Cash', bank_transfer: 'Bank Transfer', card: 'Card',
    mobile_banking: 'Mobile Banking', cheque: 'Cheque', other: 'Other', store_credit: 'Store Credit',
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Customer Advances</h1>
          <p className="text-sm text-muted-foreground mt-1">Record advance payments from customers and apply them to invoices</p>
        </div>
        <button
          onClick={() => setShowRecord(true)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition"
        >
          <Plus className="w-4 h-4" /> Record Advance
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Total Received', value: formatCurrency(stats.totalReceived), icon: ArrowDownCircle, color: 'text-blue-500 bg-blue-50' },
          { label: 'Total Applied', value: formatCurrency(stats.totalApplied), icon: ArrowUpCircle, color: 'text-green-500 bg-green-50' },
          { label: 'Active Balance', value: formatCurrency(stats.activeBalance), icon: Wallet, color: 'text-amber-500 bg-amber-50' },
          { label: 'Active Advances', value: stats.activeCount, icon: HandCoins, color: 'text-purple-500 bg-purple-50' },
        ].map(s => (
          <div key={s.label} className="stat-card flex items-center gap-3">
            <div className={`w-10 h-10 rounded-full flex items-center justify-center ${s.color}`}><s.icon className="w-5 h-5" /></div>
            <div><p className="text-xs text-muted-foreground">{s.label}</p><p className="text-lg font-bold text-foreground">{s.value}</p></div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-1 border-b border-border">
        <button
          onClick={() => setTab('advances')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition ${tab === 'advances' ? 'border-blue-500 text-blue-600' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
        >
          Advances
        </button>
        <button
          onClick={() => setTab('applications')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition ${tab === 'applications' ? 'border-blue-500 text-blue-600' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
        >
          Applications
        </button>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={tab === 'advances' ? 'Search by advance number, customer name or code...' : 'Search by advance number, customer, or invoice...'}
            className="w-full pl-10 pr-4 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 bg-white"
          />
        </div>
        {tab === 'advances' && (
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          >
            <option value="all">All Statuses</option>
            <option value="active">Active</option>
            <option value="applied">Fully Applied</option>
            <option value="refunded">Refunded</option>
          </select>
        )}
      </div>

      {loading ? (
        <div className="text-center py-12 text-muted-foreground">Loading...</div>
      ) : tab === 'advances' ? (
        <div className="border border-border rounded-xl overflow-hidden bg-white">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">Advance #</th>
                  <th className="px-4 py-3 text-left font-medium">Customer</th>
                  <th className="px-4 py-3 text-left font-medium">Method</th>
                  <th className="px-4 py-3 text-right font-medium">Amount</th>
                  <th className="px-4 py-3 text-right font-medium">Balance</th>
                  <th className="px-4 py-3 text-center font-medium">Status</th>
                  <th className="px-4 py-3 text-left font-medium">Date</th>
                  <th className="px-4 py-3 text-center font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredAdvances.length === 0 ? (
                  <tr><td colSpan={8} className="px-4 py-8 text-center text-sm text-muted-foreground">No customer advances found</td></tr>
                ) : filteredAdvances.map(a => (
                  <tr key={a.id} className="hover:bg-muted/20 transition">
                    <td className="px-4 py-3 text-sm font-medium text-blue-600">{a.advance_number}</td>
                    <td className="px-4 py-3 text-sm">
                      <p className="font-medium text-foreground">{a.customer_name}</p>
                      <p className="text-xs text-muted-foreground">{a.customer_code}</p>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{paymentMethodLabels[a.payment_method] || a.payment_method}</td>
                    <td className="px-4 py-3 text-sm text-right font-medium">{formatCurrency(a.amount)}</td>
                    <td className="px-4 py-3 text-sm text-right font-bold text-amber-600">{formatCurrency(a.balance)}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                        a.status === 'active' ? 'bg-green-50 text-green-700' :
                        a.status === 'applied' ? 'bg-blue-50 text-blue-700' :
                        a.status === 'refunded' ? 'bg-red-50 text-red-700' :
                        'bg-gray-50 text-gray-700'
                      }`}>
                        {a.status === 'active' && <CheckCircle2 className="w-3 h-3" />}
                        {a.status === 'applied' && <CheckCircle2 className="w-3 h-3" />}
                        {a.status === 'refunded' && <RotateCcw className="w-3 h-3" />}
                        {a.status.charAt(0).toUpperCase() + a.status.slice(1)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{new Date(a.payment_date).toLocaleDateString()}</td>
                    <td className="px-4 py-3 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <button onClick={() => viewDetail(a)} className="p-1.5 hover:bg-blue-50 rounded text-blue-600" title="View details">
                          <Eye className="w-3.5 h-3.5" />
                        </button>
                        {a.status === 'active' && a.balance > 0 && (
                          <button
                            onClick={() => setShowApply(a)}
                            className="p-1.5 hover:bg-green-50 rounded text-green-600"
                            title="Apply to invoice"
                          >
                            <ArrowRightLeft className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {a.status === 'active' && a.balance > 0 && (
                          <button
                            onClick={() => setShowRefund(a)}
                            className="p-1.5 hover:bg-red-50 rounded text-red-600"
                            title="Refund advance"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="border border-border rounded-xl overflow-hidden bg-white">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">Advance #</th>
                  <th className="px-4 py-3 text-left font-medium">Customer</th>
                  <th className="px-4 py-3 text-left font-medium">Invoice</th>
                  <th className="px-4 py-3 text-right font-medium">Amount Applied</th>
                  <th className="px-4 py-3 text-left font-medium">Date</th>
                  <th className="px-4 py-3 text-left font-medium">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredApplications.length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">No applications found</td></tr>
                ) : filteredApplications.map(a => (
                  <tr key={a.id} className="hover:bg-muted/20 transition">
                    <td className="px-4 py-3 text-sm font-medium text-blue-600">{a.advance_number}</td>
                    <td className="px-4 py-3 text-sm text-foreground">{a.customer_name}</td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{a.invoice_number || '-'}</td>
                    <td className="px-4 py-3 text-sm text-right font-bold text-green-600">{formatCurrency(a.amount)}</td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{new Date(a.created_at).toLocaleDateString()}</td>
                    <td className="px-4 py-3 text-sm text-muted-foreground max-w-xs truncate">{a.notes || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Detail Modal */}
      {detailAdvance && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setDetailAdvance(null)}>
          <div className="bg-white rounded-xl shadow-xl max-w-lg w-full max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-border">
              <div>
                <h3 className="font-bold text-foreground">{detailAdvance.advance_number}</h3>
                <p className="text-sm text-muted-foreground">{detailAdvance.customer_name} ({detailAdvance.customer_code})</p>
              </div>
              <button onClick={() => setDetailAdvance(null)} className="p-1 hover:bg-muted rounded"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <div className="p-3 bg-blue-50 rounded-lg">
                  <p className="text-xs text-muted-foreground">Amount Received</p>
                  <p className="text-lg font-bold text-blue-600">{formatCurrency(detailAdvance.amount)}</p>
                </div>
                <div className="p-3 bg-amber-50 rounded-lg">
                  <p className="text-xs text-muted-foreground">Balance</p>
                  <p className="text-lg font-bold text-amber-600">{formatCurrency(detailAdvance.balance)}</p>
                </div>
                <div className="p-3 bg-green-50 rounded-lg">
                  <p className="text-xs text-muted-foreground">Applied</p>
                  <p className="text-lg font-bold text-green-600">{formatCurrency(detailAdvance.amount - detailAdvance.balance)}</p>
                </div>
              </div>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Status</span><span className="font-medium capitalize">{detailAdvance.status}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Payment Method</span><span className="font-medium">{paymentMethodLabels[detailAdvance.payment_method] || detailAdvance.payment_method}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Reference</span><span className="font-medium">{detailAdvance.reference_number || '-'}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Date</span><span className="font-medium">{new Date(detailAdvance.payment_date).toLocaleDateString()}</span></div>
              </div>
              {detailAdvance.notes && (
                <div className="p-3 bg-muted/30 rounded-lg">
                  <p className="text-xs text-muted-foreground mb-1">Notes</p>
                  <p className="text-sm text-foreground">{detailAdvance.notes}</p>
                </div>
              )}
              {detailApplications.length > 0 && (
                <div>
                  <p className="text-sm font-medium text-foreground mb-2">Application History</p>
                  <div className="space-y-2">
                    {detailApplications.map(a => (
                      <div key={a.id} className="flex items-center justify-between p-2 bg-muted/20 rounded-lg text-sm">
                        <div>
                          <p className="font-medium text-foreground">{formatCurrency(a.amount)}</p>
                          <p className="text-xs text-muted-foreground">{a.invoice_number || 'No invoice'} - {new Date(a.created_at).toLocaleDateString()}</p>
                        </div>
                        {a.notes && <p className="text-xs text-muted-foreground truncate max-w-[200px]">{a.notes}</p>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {detailAdvance.status === 'active' && detailAdvance.balance > 0 && (
                <div className="flex gap-3">
                  <button
                    onClick={() => { setShowApply(detailAdvance); setDetailAdvance(null); }}
                    className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-semibold transition"
                  >
                    <ArrowRightLeft className="w-4 h-4" /> Apply to Invoice
                  </button>
                  <button
                    onClick={() => { setShowRefund(detailAdvance); setDetailAdvance(null); }}
                    className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-semibold transition"
                  >
                    <RotateCcw className="w-4 h-4" /> Refund
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showRecord && (
        <RecordAdvanceModal
          paymentMethods={paymentMethods}
          onClose={() => setShowRecord(false)}
          onSaved={() => { setShowRecord(false); loadData(); }}
        />
      )}

      {showApply && (
        <ApplyAdvanceModal
          advance={showApply}
          onClose={() => setShowApply(null)}
          onApplied={() => { setShowApply(null); loadData(); }}
        />
      )}

      {showRefund && (
        <RefundAdvanceModal
          advance={showRefund}
          paymentMethods={paymentMethods}
          onClose={() => setShowRefund(null)}
          onRefunded={() => { setShowRefund(null); loadData(); }}
        />
      )}
    </div>
  );
}

// ============================================================
// Record Advance Modal
// ============================================================
function RecordAdvanceModal({ paymentMethods, onClose, onSaved }: {
  paymentMethods: PaymentMethod[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [customerSearch, setCustomerSearch] = useState('');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [form, setForm] = useState({
    amount: '',
    payment_method: 'cash',
    payment_date: new Date().toISOString().split('T')[0],
    reference_number: '',
    notes: '',
  });

  useEffect(() => {
    if (!customerSearch.trim()) { setCustomers([]); return; }
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from('customers')
        .select('id, name, code')
        .or(`name.ilike.%${customerSearch.trim()}%,code.ilike.%${customerSearch.trim()}%,phone.ilike.%${customerSearch.trim()}%`)
        .order('name')
        .limit(10);
      setCustomers(data || []);
    }, 200);
    return () => clearTimeout(t);
  }, [customerSearch]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedCustomer) { setError('Please select a customer'); return; }
    const amount = Number(form.amount);
    if (!amount || amount <= 0) { setError('Enter a valid amount'); return; }

    setSaving(true); setError('');
    try {
      const { error: insertError } = await supabase.from('customer_advances').insert({
        customer_id: selectedCustomer.id,
        amount,
        balance: amount,
        status: 'active',
        payment_method: form.payment_method,
        payment_date: form.payment_date,
        reference_number: form.reference_number || null,
        notes: form.notes || null,
      });
      if (insertError) throw insertError;

      toast({ title: 'Success', description: `Advance recorded for ${selectedCustomer.name}` });
      onSaved();
    } catch (err: any) {
      setError(err.message || 'Failed to record advance');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-white z-10">
          <h2 className="text-base font-bold">Record Customer Advance</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {error && <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>}

          <div>
            <label className="block text-xs font-medium mb-1">Customer *</label>
            {selectedCustomer ? (
              <div className="flex items-center justify-between p-2.5 border border-border rounded-lg bg-blue-50">
                <div>
                  <p className="text-sm font-medium text-foreground">{selectedCustomer.name}</p>
                  <p className="text-xs text-muted-foreground">{selectedCustomer.code}</p>
                </div>
                <button type="button" onClick={() => setSelectedCustomer(null)} className="text-muted-foreground hover:text-red-500"><X className="w-4 h-4" /></button>
              </div>
            ) : (
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input
                  value={customerSearch}
                  onChange={e => setCustomerSearch(e.target.value)}
                  placeholder="Search customer by name..."
                  className="w-full pl-10 pr-4 py-2.5 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                  autoFocus
                />
                {customers.length > 0 && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-border rounded-lg shadow-lg z-50 max-h-48 overflow-y-auto">
                    {customers.map(c => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => { setSelectedCustomer(c); setCustomerSearch(''); setCustomers([]); }}
                        className="w-full text-left px-3 py-2 hover:bg-blue-50 transition text-sm"
                      >
                        <p className="font-medium text-foreground">{c.name}</p>
                        <p className="text-xs text-muted-foreground">{c.code}</p>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">Amount *</label>
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={form.amount}
                onChange={e => setForm({ ...form, amount: e.target.value })}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Payment Method *</label>
              <select value={form.payment_method} onChange={e => setForm({ ...form, payment_method: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none">
                {paymentMethods.length > 0
                  ? paymentMethods.map(m => <option key={m.code} value={m.code}>{m.name}</option>)
                  : <>
                      <option value="cash">Cash</option>
                      <option value="bank_transfer">Bank Transfer</option>
                      <option value="card">Card</option>
                      <option value="mobile_banking">Mobile Banking</option>
                      <option value="cheque">Cheque</option>
                    </>
                }
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">Date *</label>
              <input type="date" value={form.payment_date} onChange={e => setForm({ ...form, payment_date: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" required />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Reference Number</label>
              <input value={form.reference_number} onChange={e => setForm({ ...form, reference_number: e.target.value })} placeholder="Cheque no., transaction ID..." className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Notes</label>
            <input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="Optional notes..." className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
          </div>

          <div className="flex items-center justify-end gap-3">
            <button type="button" onClick={onClose} className="px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Cancel</button>
            <button type="submit" disabled={saving} className="flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-60">
              <Plus className="w-4 h-4" />
              {saving ? 'Saving...' : 'Record Advance'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ============================================================
// Apply Advance to Invoice Modal
// ============================================================
function ApplyAdvanceModal({ advance, onClose, onApplied }: {
  advance: Advance;
  onClose: () => void;
  onApplied: () => void;
}) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [unpaidInvoices, setUnpaidInvoices] = useState<{ id: string; invoice_number: string; balance_due: number; invoice_date: string }[]>([]);
  const [selectedInvoice, setSelectedInvoice] = useState<string>('');
  const [applyAmount, setApplyAmount] = useState('');

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('invoices')
        .select('id, invoice_number, balance_due, invoice_date')
        .eq('customer_id', advance.customer_id)
        .in('status', ['sent', 'partially_paid', 'unpaid', 'overdue'])
        .order('invoice_date', { ascending: true });
      setUnpaidInvoices((data || []).map((i: any) => ({
        id: i.id,
        invoice_number: i.invoice_number,
        balance_due: Number(i.balance_due),
        invoice_date: i.invoice_date,
      })));
    })();
  }, [advance]);

  const selectedInv = unpaidInvoices.find(i => i.id === selectedInvoice);
  const maxApply = Math.min(advance.balance, selectedInv ? selectedInv.balance_due : 0);

  async function handleApply(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedInvoice) { setError('Select an invoice'); return; }
    const amount = Number(applyAmount);
    if (!amount || amount <= 0) { setError('Enter a valid amount'); return; }
    if (amount > maxApply) { setError(`Amount cannot exceed ${formatCurrency(maxApply)}`); return; }

    setSaving(true); setError('');
    try {
      // 1. Record the application
      const { error: appError } = await supabase.from('customer_advance_applications').insert({
        advance_id: advance.id,
        customer_id: advance.customer_id,
        invoice_id: selectedInvoice,
        amount,
        notes: `Advance ${advance.advance_number} applied to invoice`,
      });
      if (appError) throw appError;

      // 2. Update advance balance and status
      const newBalance = advance.balance - amount;
      await supabase.from('customer_advances').update({
        balance: newBalance,
        status: newBalance <= 0.001 ? 'applied' : 'active',
        updated_at: new Date().toISOString(),
      }).eq('id', advance.id);

      // 3. Record a payment for the invoice (this triggers payment_accounting_trigger
      //    which will Dr Cash/Bank Cr AR — but we need to reverse the cash side and
      //    post Dr Customer Advances Cr AR instead. So we post the journal entry manually.)
      const { data: arAccount } = await supabase.from('accounts').select('id').eq('code', '1100').maybeSingle();
      const { data: advanceAccount } = await supabase.from('accounts').select('id').eq('code', '2300').maybeSingle();

      if (arAccount && advanceAccount) {
        const { data: jeNum } = await supabase.rpc('get_next_journal_number');
        const { data: jeRow, error: jeError } = await supabase.from('journal_entries').insert({
          entry_number: jeNum,
          entry_date: new Date().toISOString().split('T')[0],
          description: `Advance ${advance.advance_number} applied to invoice`,
          reference_type: 'advance_application',
          reference_id: advance.id,
          total_debit: amount,
          total_credit: amount,
          is_posted: true,
          customer_id: advance.customer_id,
        }).select().single();

        if (jeError) throw jeError;

        if (jeRow) {
          await supabase.from('journal_lines').insert([
            { journal_entry_id: jeRow.id, account_id: advanceAccount.id, description: `Advance applied - ${advance.advance_number}`, debit: amount, credit: 0, sort_order: 0 },
            { journal_entry_id: jeRow.id, account_id: arAccount.id, description: `AR cleared - advance ${advance.advance_number}`, debit: 0, credit: amount, sort_order: 1 },
          ]);

          // Update account balances
          await supabase.rpc('increment_account_balance', { p_account_id: advanceAccount.id, p_delta: -amount });
          await supabase.rpc('increment_account_balance', { p_account_id: arAccount.id, p_delta: -amount });
        }
      }

      // 4. Update invoice amount_paid and status (balance_due is a generated column)
      const inv = unpaidInvoices.find(i => i.id === selectedInvoice)!;
      const { data: invRow } = await supabase.from('invoices').select('amount_paid').eq('id', selectedInvoice).maybeSingle();
      const currentPaid = Number(invRow?.amount_paid || 0);
      const newAmountPaid = currentPaid + amount;
      const newBalanceDue = inv.balance_due - amount;
      const newStatus = newBalanceDue <= 0.001 ? 'paid' : 'partially_paid';
      await supabase.from('invoices').update({
        amount_paid: newAmountPaid,
        status: newStatus,
      }).eq('id', selectedInvoice);

      // 5. Update customer outstanding balance
      const { data: customer } = await supabase.from('customers').select('outstanding_balance').eq('id', advance.customer_id).maybeSingle();
      if (customer) {
        await supabase.from('customers').update({
          outstanding_balance: Math.max(0, (customer.outstanding_balance || 0) - amount),
          updated_at: new Date().toISOString(),
        }).eq('id', advance.customer_id);
      }

      toast({ title: 'Success', description: `Advance applied to invoice successfully` });
      onApplied();
    } catch (err: any) {
      setError(err.message || 'Failed to apply advance');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-white z-10">
          <div>
            <h2 className="text-base font-bold">Apply Advance to Invoice</h2>
            <p className="text-xs text-muted-foreground mt-0.5">{advance.advance_number} - {advance.customer_name}</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={handleApply} className="p-6 space-y-5">
          {error && <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>}

          <div className="bg-amber-50 rounded-lg p-4 flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground">Available Advance Balance</p>
              <p className="text-2xl font-bold text-amber-600">{formatCurrency(advance.balance)}</p>
            </div>
            <HandCoins className="w-8 h-8 text-amber-400" />
          </div>

          {unpaidInvoices.length === 0 ? (
            <div className="p-4 bg-muted/30 rounded-lg text-center text-sm text-muted-foreground">
              This customer has no unpaid invoices. Create an invoice first, then apply the advance.
            </div>
          ) : (
            <>
              <div>
                <label className="block text-xs font-medium mb-1">Select Invoice *</label>
                <select value={selectedInvoice} onChange={e => { setSelectedInvoice(e.target.value); setApplyAmount(''); }} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none">
                  <option value="">Choose an unpaid invoice...</option>
                  {unpaidInvoices.map(i => (
                    <option key={i.id} value={i.id}>{i.invoice_number} - Balance: {formatCurrency(i.balance_due)} ({new Date(i.invoice_date).toLocaleDateString()})</option>
                  ))}
                </select>
              </div>

              {selectedInv && (
                <div>
                  <label className="block text-xs font-medium mb-1">Amount to Apply *</label>
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    max={maxApply}
                    value={applyAmount}
                    onChange={e => setApplyAmount(e.target.value)}
                    placeholder={`Max: ${formatCurrency(maxApply)}`}
                    className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                    required
                  />
                  <div className="flex gap-2 mt-2">
                    <button type="button" onClick={() => setApplyAmount(maxApply.toString())} className="px-3 py-1 text-xs bg-blue-50 text-blue-600 rounded-md hover:bg-blue-100 transition">
                      Apply Max ({formatCurrency(maxApply)})
                    </button>
                    {selectedInv.balance_due <= advance.balance && (
                      <button type="button" onClick={() => setApplyAmount(selectedInv.balance_due.toString())} className="px-3 py-1 text-xs bg-green-50 text-green-600 rounded-md hover:bg-green-100 transition">
                        Settle Invoice Fully
                      </button>
                    )}
                  </div>
                </div>
              )}

              {selectedInv && applyAmount && (
                <div className="bg-muted/30 rounded-lg p-3 space-y-1.5 text-sm">
                  <div className="flex justify-between"><span className="text-muted-foreground">Invoice Balance</span><span className="font-medium">{formatCurrency(selectedInv.balance_due)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Applying</span><span className="font-semibold text-green-600">{formatCurrency(Number(applyAmount) || 0)}</span></div>
                  <div className="flex justify-between border-t border-border pt-1.5"><span className="text-muted-foreground">Remaining Invoice Balance</span><span className="font-bold text-foreground">{formatCurrency(selectedInv.balance_due - (Number(applyAmount) || 0))}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Remaining Advance Balance</span><span className="font-bold text-amber-600">{formatCurrency(advance.balance - (Number(applyAmount) || 0))}</span></div>
                </div>
              )}
            </>
          )}

          <div className="flex items-center justify-end gap-3">
            <button type="button" onClick={onClose} className="px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Cancel</button>
            <button type="submit" disabled={saving || unpaidInvoices.length === 0} className="flex items-center gap-2 px-5 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-60">
              <ArrowRightLeft className="w-4 h-4" />
              {saving ? 'Applying...' : 'Apply Advance'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ============================================================
// Refund Advance Modal
// ============================================================
function RefundAdvanceModal({ advance, paymentMethods, onClose, onRefunded }: {
  advance: Advance;
  paymentMethods: PaymentMethod[];
  onClose: () => void;
  onRefunded: () => void;
}) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    amount: advance.balance.toString(),
    refund_method: advance.payment_method,
    refund_date: new Date().toISOString().split('T')[0],
    reference_number: '',
    notes: '',
  });

  async function handleRefund(e: React.FormEvent) {
    e.preventDefault();
    const amount = Number(form.amount);
    if (!amount || amount <= 0) { setError('Enter a valid amount'); return; }
    if (amount > advance.balance) { setError(`Amount cannot exceed ${formatCurrency(advance.balance)}`); return; }

    setSaving(true); setError('');
    try {
      // 1. Record the refund
      const { error: refundError } = await supabase.from('customer_advance_refunds').insert({
        advance_id: advance.id,
        customer_id: advance.customer_id,
        amount,
        refund_method: form.refund_method,
        refund_date: form.refund_date,
        reference_number: form.reference_number || null,
        notes: form.notes || null,
      });
      if (refundError) throw refundError;

      // 2. Update advance balance and status
      const newBalance = advance.balance - amount;
      const isFullRefund = newBalance <= 0.001;
      await supabase.from('customer_advances').update({
        balance: newBalance,
        status: isFullRefund ? 'refunded' : 'active',
        updated_at: new Date().toISOString(),
      }).eq('id', advance.id);

      // 3. Post journal entry: Dr Customer Advances (2300), Cr Cash/Bank
      const { data: advanceAccount } = await supabase.from('accounts').select('id').eq('code', '2300').maybeSingle();

      let cashAccountId: string | null = null;
      const { data: pmAccount } = await supabase
        .from('payment_methods')
        .select('account_id')
        .eq('code', form.refund_method)
        .eq('is_active', true)
        .maybeSingle();

      if (pmAccount?.account_id) {
        cashAccountId = pmAccount.account_id;
      } else {
        const { data: cashAccount } = await supabase.from('accounts').select('id').eq('code', '1001').maybeSingle();
        cashAccountId = cashAccount?.id || null;
      }

      if (advanceAccount && cashAccountId) {
        const { data: jeNum } = await supabase.rpc('get_next_journal_number');
        const { data: jeRow, error: jeError } = await supabase.from('journal_entries').insert({
          entry_number: jeNum,
          entry_date: form.refund_date,
          description: `Advance refund - ${advance.advance_number}`,
          reference_type: 'advance_refund',
          reference_id: advance.id,
          total_debit: amount,
          total_credit: amount,
          is_posted: true,
          customer_id: advance.customer_id,
        }).select().single();

        if (jeError) throw jeError;

        if (jeRow) {
          await supabase.from('journal_lines').insert([
            { journal_entry_id: jeRow.id, account_id: advanceAccount.id, description: `Advance refunded - ${advance.advance_number}`, debit: amount, credit: 0, sort_order: 0 },
            { journal_entry_id: jeRow.id, account_id: cashAccountId, description: `Cash/Bank paid out - refund ${advance.advance_number}`, debit: 0, credit: amount, sort_order: 1 },
          ]);

          // Update account balances: advance liability decreases, cash decreases
          await supabase.rpc('increment_account_balance', { p_account_id: advanceAccount.id, p_delta: -amount });
          await supabase.rpc('increment_account_balance', { p_account_id: cashAccountId, p_delta: -amount });
        }
      }

      toast({ title: 'Success', description: isFullRefund ? 'Advance fully refunded' : `Refunded ${formatCurrency(amount)} from advance` });
      onRefunded();
    } catch (err: any) {
      setError(err.message || 'Failed to process refund');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-white z-10">
          <div>
            <h2 className="text-base font-bold">Refund Customer Advance</h2>
            <p className="text-xs text-muted-foreground mt-0.5">{advance.advance_number} - {advance.customer_name}</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={handleRefund} className="p-6 space-y-5">
          {error && <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>}

          <div className="bg-amber-50 rounded-lg p-4 flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground">Available Advance Balance</p>
              <p className="text-2xl font-bold text-amber-600">{formatCurrency(advance.balance)}</p>
            </div>
            <RotateCcw className="w-8 h-8 text-amber-400" />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">Refund Amount *</label>
              <input
                type="number"
                min="0.01"
                step="0.01"
                max={advance.balance}
                value={form.amount}
                onChange={e => setForm({ ...form, amount: e.target.value })}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                required
              />
              <button type="button" onClick={() => setForm({ ...form, amount: advance.balance.toString() })} className="mt-1.5 px-3 py-1 text-xs bg-amber-50 text-amber-600 rounded-md hover:bg-amber-100 transition">
                Refund Full Balance
              </button>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Refund Method *</label>
              <select value={form.refund_method} onChange={e => setForm({ ...form, refund_method: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none">
                {paymentMethods.length > 0
                  ? paymentMethods.map(m => <option key={m.code} value={m.code}>{m.name}</option>)
                  : <>
                      <option value="cash">Cash</option>
                      <option value="bank_transfer">Bank Transfer</option>
                      <option value="card">Card</option>
                      <option value="mobile_banking">Mobile Banking</option>
                      <option value="cheque">Cheque</option>
                    </>
                }
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">Refund Date *</label>
              <input type="date" value={form.refund_date} onChange={e => setForm({ ...form, refund_date: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" required />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Reference Number</label>
              <input value={form.reference_number} onChange={e => setForm({ ...form, reference_number: e.target.value })} placeholder="Cheque no., transaction ID..." className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Notes</label>
            <input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="Reason for refund, etc..." className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
          </div>

          {Number(form.amount) > 0 && Number(form.amount) <= advance.balance && (
            <div className="bg-muted/30 rounded-lg p-3 space-y-1.5 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Refunding</span><span className="font-semibold text-red-600">{formatCurrency(Number(form.amount) || 0)}</span></div>
              <div className="flex justify-between border-t border-border pt-1.5"><span className="text-muted-foreground">Remaining Advance Balance After Refund</span><span className="font-bold text-amber-600">{formatCurrency(advance.balance - (Number(form.amount) || 0))}</span></div>
            </div>
          )}

          <div className="flex items-center justify-end gap-3">
            <button type="button" onClick={onClose} className="px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Cancel</button>
            <button type="submit" disabled={saving} className="flex items-center gap-2 px-5 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-60">
              <RotateCcw className="w-4 h-4" />
              {saving ? 'Processing...' : 'Process Refund'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
