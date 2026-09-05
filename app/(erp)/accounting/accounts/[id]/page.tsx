'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCurrency, formatDate } from '@/lib/format';
import { toast } from '@/hooks/use-toast';
import Link from 'next/link';
import { ArrowLeft, TrendingUp, TrendingDown, ArrowUpRight, ArrowDownLeft, Calendar, Filter, ExternalLink, ChevronLeft, ChevronRight, Wallet, ChartBar as BarChart3, Users, Building2, FileText, Receipt, Activity, BookOpen, Layers, ArrowRightLeft, CircleDot, Plus, X, AlertTriangle } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, PieChart, Pie, Cell, Legend,
} from 'recharts';
import type { Account } from '@/lib/types';

const typeColors: Record<string, string> = {
  asset: 'text-blue-600 bg-blue-50',
  liability: 'text-red-600 bg-red-50',
  equity: 'text-purple-600 bg-purple-50',
  revenue: 'text-green-600 bg-green-50',
  expense: 'text-orange-600 bg-orange-50',
};

const PIE_COLORS = ['#3b82f6', '#10b981', '#ef4444', '#f59e0b', '#8b5cf6', '#06b6d4', '#ec4899', '#64748b'];

interface JournalLineRaw {
  id: string;
  journal_entry_id: string;
  account_id: string;
  debit: number;
  credit: number;
  description: string | null;
  sort_order: number;
  journal_entries: {
    id: string;
    entry_number: string;
    entry_date: string;
    description: string;
    reference_type: string | null;
    reference_id: string | null;
    customer_id: string | null;
    supplier_id: string | null;
  };
}

interface RelatedAccount {
  id: string;
  code: string;
  name: string;
  account_type: string;
  total_debit: number;
  total_credit: number;
  interaction_count: number;
}

interface PartyBreakdown {
  party_id: string;
  party_name: string;
  party_type: 'customer' | 'supplier';
  entry_count: number;
  total_debit: number;
  total_credit: number;
  net_activity: number;
}

interface ModuleUsage {
  reference_type: string;
  entry_count: number;
  total_debit: number;
  total_credit: number;
}

interface AuditEntry {
  id: string;
  action: string;
  entity_type: string;
  entity_label: string | null;
  created_at: string;
  user_name: string | null;
}

const PAGE_SIZE = 20;

export default function AccountDetailPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [allLines, setAllLines] = useState<JournalLineRaw[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [period, setPeriod] = useState<'all' | 'this_month' | 'this_quarter' | 'this_year' | 'custom'>('all');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [refFilter, setRefFilter] = useState<string>('all');
  const [relatedAccounts, setRelatedAccounts] = useState<RelatedAccount[]>([]);
  const [partyBreakdown, setPartyBreakdown] = useState<PartyBreakdown[]>([]);
  const [moduleUsage, setModuleUsage] = useState<ModuleUsage[]>([]);
  const [auditTrail, setAuditTrail] = useState<AuditEntry[]>([]);
  const [dataSection, setDataSection] = useState<'transactions' | 'related' | 'breakdown' | 'audit'>('transactions');

  const loadAccount = useCallback(async () => {
    const { data } = await supabase.from('accounts').select('*').eq('id', id).maybeSingle();
    if (data) setAccount(data as Account);
  }, [id]);

  const loadTransactions = useCallback(async () => {
    const { data, error } = await supabase
      .from('journal_lines')
      .select(`
        id, journal_entry_id, account_id, debit, credit, description, sort_order,
        journal_entries!inner(
          id, entry_number, entry_date, description, reference_type, reference_id, customer_id, supplier_id
        )
      `)
      .eq('account_id', id);

    if (error) {
      console.error('Error loading transactions:', error);
      setAllLines([]);
      return;
    }

    const lines = (data || []) as unknown as JournalLineRaw[];
    lines.sort((a, b) => {
      const dA = new Date(a.journal_entries.entry_date).getTime();
      const dB = new Date(b.journal_entries.entry_date).getTime();
      if (dB !== dA) return dB - dA;
      return b.journal_entries.entry_number.localeCompare(a.journal_entries.entry_number);
    });
    setAllLines(lines);
  }, [id]);

  const loadRelatedAccounts = useCallback(async () => {
    const { data, error } = await supabase.rpc('get_related_accounts', { p_account_id: id });
    if (!error && data) {
      setRelatedAccounts(data as RelatedAccount[]);
      return;
    }
    // Fallback: query manually through journal lines
    const { data: lines } = await supabase
      .from('journal_lines')
      .select('journal_entry_id')
      .eq('account_id', id);
    if (!lines || lines.length === 0) { setRelatedAccounts([]); return; }

    const entryIds = lines.map(l => l.journal_entry_id);
    const { data: siblingLines } = await supabase
      .from('journal_lines')
      .select('account_id, debit, credit')
      .neq('account_id', id)
      .in('journal_entry_id', entryIds);

    if (!siblingLines) { setRelatedAccounts([]); return; }

    const { data: accounts } = await supabase.from('accounts').select('id, code, name, account_type');
    const accMap = new Map((accounts || []).map((a: any) => [a.id, a]));

    const map = new Map<string, RelatedAccount>();
    for (const sl of siblingLines) {
      const acc = accMap.get(sl.account_id);
      if (!acc) continue;
      const existing = map.get(acc.code) || { id: acc.id, code: acc.code, name: acc.name, account_type: acc.account_type, total_debit: 0, total_credit: 0, interaction_count: 0 };
      existing.total_debit += Number(sl.debit);
      existing.total_credit += Number(sl.credit);
      existing.interaction_count += 1;
      map.set(acc.code, existing);
    }
    setRelatedAccounts(Array.from(map.values()).sort((a, b) => (b.total_debit + b.total_credit) - (a.total_debit + a.total_credit)).slice(0, 15));
  }, [id]);

  const loadPartyBreakdown = useCallback(async () => {
    // Get all journal lines for this account, with customer/supplier info
    const { data: lines } = await supabase
      .from('journal_lines')
      .select(`
        debit, credit,
        journal_entries!inner(customer_id, supplier_id)
      `)
      .eq('account_id', id);

    if (!lines || lines.length === 0) { setPartyBreakdown([]); return; }

    const customerMap = new Map<string, { debit: number; credit: number; count: number }>();
    const supplierMap = new Map<string, { debit: number; credit: number; count: number }>();

    for (const line of lines as any[]) {
      const je = line.journal_entries;
      if (je.customer_id) {
        const existing = customerMap.get(je.customer_id) || { debit: 0, credit: 0, count: 0 };
        existing.debit += Number(line.debit);
        existing.credit += Number(line.credit);
        existing.count += 1;
        customerMap.set(je.customer_id, existing);
      }
      if (je.supplier_id) {
        const existing = supplierMap.get(je.supplier_id) || { debit: 0, credit: 0, count: 0 };
        existing.debit += Number(line.debit);
        existing.credit += Number(line.credit);
        existing.count += 1;
        supplierMap.set(je.supplier_id, existing);
      }
    }

    const customerIds = Array.from(customerMap.keys());
    const supplierIds = Array.from(supplierMap.keys());

    const [custRes, supRes] = await Promise.all([
      customerIds.length > 0 ? supabase.from('customers').select('id, name').in('id', customerIds) : Promise.resolve({ data: [] }),
      supplierIds.length > 0 ? supabase.from('suppliers').select('id, name').in('id', supplierIds) : Promise.resolve({ data: [] }),
    ]);

    const result: PartyBreakdown[] = [];
    (custRes.data || []).forEach((c: any) => {
      const stats = customerMap.get(c.id)!;
      result.push({
        party_id: c.id, party_name: c.name, party_type: 'customer',
        entry_count: stats.count, total_debit: stats.debit, total_credit: stats.credit,
        net_activity: stats.debit - stats.credit,
      });
    });
    (supRes.data || []).forEach((s: any) => {
      const stats = supplierMap.get(s.id)!;
      result.push({
        party_id: s.id, party_name: s.name, party_type: 'supplier',
        entry_count: stats.count, total_debit: stats.debit, total_credit: stats.credit,
        net_activity: stats.debit - stats.credit,
      });
    });

    setPartyBreakdown(result.sort((a, b) => (b.total_debit + b.total_credit) - (a.total_debit + a.total_credit)).slice(0, 20));
  }, [id]);

  const loadModuleUsage = useCallback(async () => {
    const map = new Map<string, ModuleUsage>();
    for (const line of allLines) {
      const rt = line.journal_entries.reference_type || 'manual';
      const existing = map.get(rt) || { reference_type: rt, entry_count: 0, total_debit: 0, total_credit: 0 };
      existing.entry_count += 1;
      existing.total_debit += Number(line.debit);
      existing.total_credit += Number(line.credit);
      map.set(rt, existing);
    }
    setModuleUsage(Array.from(map.values()).sort((a, b) => b.entry_count - a.entry_count));
  }, [allLines]);

  const loadAuditTrail = useCallback(async () => {
    // Scope audit trail to this account: direct account logs + journal entries that contain this account
    const journalEntryIds = [...new Set(allLines.map(l => l.journal_entry_id))].slice(0, 50);

    // Build filter: activity on this account directly, or on journal entries that touch it
    let orFilter = `entity_type.eq.account,entity_id.eq.${id}`;
    if (journalEntryIds.length > 0) {
      // activity_logs doesn't support .in() via .or(), so we fetch account logs then JE logs separately
    }

    const [accountLogsRes, jeLogsRes] = await Promise.all([
      supabase
        .from('activity_logs')
        .select('id, action, entity_type, entity_label, created_at, profiles:user_id(full_name)')
        .eq('entity_type', 'account')
        .eq('entity_id', id)
        .order('created_at', { ascending: false })
        .limit(20),
      journalEntryIds.length > 0
        ? supabase
            .from('activity_logs')
            .select('id, action, entity_type, entity_label, created_at, profiles:user_id(full_name)')
            .eq('entity_type', 'journal_entry')
            .in('entity_id', journalEntryIds)
            .order('created_at', { ascending: false })
            .limit(20)
        : Promise.resolve({ data: [] }),
    ]);

    const combined = [
      ...(accountLogsRes.data || []),
      ...(jeLogsRes.data || []),
    ]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 30);

    setAuditTrail(combined.map((d: any) => ({
      id: d.id,
      action: d.action,
      entity_type: d.entity_type,
      entity_label: d.entity_label,
      created_at: d.created_at,
      user_name: d.profiles?.full_name || null,
    })));
  }, [id, allLines]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await Promise.all([loadAccount(), loadTransactions()]);
      setLoading(false);
    })();
  }, [loadAccount, loadTransactions]);

  useEffect(() => {
    if (allLines.length > 0) {
      loadModuleUsage();
      Promise.all([loadRelatedAccounts(), loadPartyBreakdown()]);
    }
    // Audit trail loads independently (account logs don't require transactions)
    loadAuditTrail();
  }, [allLines, loadModuleUsage, loadRelatedAccounts, loadPartyBreakdown, loadAuditTrail]);

  const dateRange = useMemo(() => {
    const today = new Date();
    const end = today.toISOString().split('T')[0];
    let start = '';

    if (period === 'this_month') {
      start = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
    } else if (period === 'this_quarter') {
      const q = Math.floor(today.getMonth() / 3);
      start = new Date(today.getFullYear(), q * 3, 1).toISOString().split('T')[0];
    } else if (period === 'this_year') {
      start = new Date(today.getFullYear(), 0, 1).toISOString().split('T')[0];
    } else if (period === 'custom') {
      return { start: customStart, end: customEnd || end };
    }
    return { start, end };
  }, [period, customStart, customEnd]);

  const filteredLines = useMemo(() => {
    return allLines.filter(l => {
      const entryDate = l.journal_entries.entry_date;
      if (dateRange.start && entryDate < dateRange.start) return false;
      if (dateRange.end && entryDate > dateRange.end) return false;
      if (refFilter !== 'all' && l.journal_entries.reference_type !== refFilter) return false;
      return true;
    });
  }, [allLines, dateRange, refFilter]);

  const totalPages = Math.ceil(filteredLines.length / PAGE_SIZE);
  const paginatedLines = filteredLines.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const balanceSummary = useMemo(() => {
    const isDebitNormal = account?.account_type === 'asset' || account?.account_type === 'expense';

    let periodDebit = 0, periodCredit = 0;
    for (const l of filteredLines) {
      periodDebit += Number(l.debit);
      periodCredit += Number(l.credit);
    }
    const periodNet = isDebitNormal ? periodDebit - periodCredit : periodCredit - periodDebit;

    // Compute opening balance from all transactions BEFORE the period start.
    // This is accurate regardless of period filter, since allLines contains every transaction.
    let openingBalance = 0;
    if (dateRange.start) {
      for (const l of allLines) {
        if (l.journal_entries.entry_date < dateRange.start) {
          const delta = isDebitNormal
            ? Number(l.debit) - Number(l.credit)
            : Number(l.credit) - Number(l.debit);
          openingBalance += delta;
        }
      }
    }
    // For "All Time" (no start date), opening balance is 0 by definition
    const closingBalance = openingBalance + periodNet;

    return {
      opening: openingBalance,
      totalDebit: periodDebit,
      totalCredit: periodCredit,
      net: periodNet,
      closing: closingBalance,
      entryCount: filteredLines.length,
    };
  }, [filteredLines, allLines, account, dateRange.start]);

  const monthlyChart = useMemo(() => {
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const map = new Map<string, { debit: number; credit: number; label: string }>();
    for (const l of filteredLines) {
      const d = new Date(l.journal_entries.entry_date);
      const key = `${d.getFullYear()}-${String(d.getMonth()).padStart(2, '0')}`;
      const label = `${monthNames[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;
      if (!map.has(key)) map.set(key, { debit: 0, credit: 0, label });
      const entry = map.get(key)!;
      entry.debit += Number(l.debit);
      entry.credit += Number(l.credit);
    }
    return Array.from(map.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-12)
      .map(([, val]) => ({ month: val.label, debit: val.debit, credit: val.credit }));
  }, [filteredLines]);

  const cumulativeBalance = useMemo(() => {
    const isDebitNormal = account?.account_type === 'asset' || account?.account_type === 'expense';
    let running = balanceSummary.opening;
    const points: { label: string; balance: number }[] = [{ label: 'Start', balance: running }];
    const reversed = [...filteredLines].reverse();
    for (const l of reversed) {
      const delta = isDebitNormal ? Number(l.debit) - Number(l.credit) : Number(l.credit) - Number(l.debit);
      running += delta;
      const d = new Date(l.journal_entries.entry_date);
      points.push({ label: `${d.getMonth() + 1}/${d.getDate()}`, balance: running });
    }
    return points.slice(-30);
  }, [filteredLines, account, balanceSummary.opening]);

  const referenceTypes = useMemo(() => {
    const set = new Set<string>();
    allLines.forEach(l => { if (l.journal_entries.reference_type) set.add(l.journal_entries.reference_type); });
    return Array.from(set).sort();
  }, [allLines]);

  const moduleUsagePieData = useMemo(() => {
    return moduleUsage.map(m => ({
      name: m.reference_type.replace(/_/g, ' '),
      value: m.entry_count,
    }));
  }, [moduleUsage]);

  const isDebitNormal = account?.account_type === 'asset' || account?.account_type === 'expense';

  if (!account && !loading) {
    return (
      <div className="space-y-5 animate-fade-in">
        <Link href="/accounting/accounts" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-4 h-4" /> Back to Accounts
        </Link>
        <div className="text-center py-20 text-muted-foreground">Account not found</div>
      </div>
    );
  }

  return (
    <div className="space-y-5 animate-fade-in">
      {/* Breadcrumb + Header */}
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link href="/accounting/accounts" className="hover:text-foreground flex items-center gap-1">
            <ArrowLeft className="w-3.5 h-3.5" /> Chart of Accounts
          </Link>
          <span>/</span>
          <span className="text-foreground font-medium">{account?.code} - {account?.name}</span>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className={`w-14 h-14 rounded-2xl flex items-center justify-center ${typeColors[account?.account_type || ''] || 'bg-gray-100 text-gray-600'}`}>
              <Wallet className="w-7 h-7" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">{account?.name}</h1>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-sm font-mono text-muted-foreground">{account?.code}</span>
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium capitalize ${typeColors[account?.account_type || ''] || 'bg-gray-100 text-gray-600'}`}>{account?.account_type}</span>
                {account?.is_cash && <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-green-50 text-green-600">Cash</span>}
                {account?.is_bank && <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-blue-50 text-blue-600">Bank</span>}
              </div>
            </div>
          </div>
          <div className="text-right">
            <p className="text-xs text-muted-foreground">Current Balance</p>
            <p className={`text-3xl font-bold ${Number(account?.balance) < 0 ? 'text-red-600' : 'text-foreground'}`}>
              {formatCurrency(Math.abs(Number(account?.balance || 0)))}
            </p>
            {Number(account?.balance) < 0 && <p className="text-xs text-red-500">Negative balance</p>}
          </div>
        </div>
      </div>

      {/* Balance Adjustment Panel */}
      {account && <BalanceAdjustmentPanel account={account} onAdjusted={() => { loadAccount(); loadTransactions(); }} />}

      {/* Period Filter Bar */}
      <div className="bg-white rounded-xl border border-border p-4 shadow-sm">
        <div className="flex flex-col lg:flex-row gap-4 items-start lg:items-center justify-between">
          <div className="flex items-center gap-2 flex-wrap">
            <Filter className="w-4 h-4 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground">Period:</span>
            {[
              { key: 'all', label: 'All Time' },
              { key: 'this_month', label: 'This Month' },
              { key: 'this_quarter', label: 'This Quarter' },
              { key: 'this_year', label: 'This Year' },
              { key: 'custom', label: 'Custom' },
            ].map(p => (
              <button
                key={p.key}
                onClick={() => { setPeriod(p.key as typeof period); setCurrentPage(1); }}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                  period === p.key ? 'bg-blue-600 text-white' : 'bg-muted/40 text-muted-foreground hover:bg-muted'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {period === 'custom' && (
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={customStart}
                onChange={e => { setCustomStart(e.target.value); setCurrentPage(1); }}
                className="border border-border rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
              <span className="text-xs text-muted-foreground">to</span>
              <input
                type="date"
                value={customEnd}
                onChange={e => { setCustomEnd(e.target.value); setCurrentPage(1); }}
                className="border border-border rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
            </div>
          )}

          {referenceTypes.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">Type:</span>
              <select
                value={refFilter}
                onChange={e => { setRefFilter(e.target.value); setCurrentPage(1); }}
                className="border border-border rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              >
                <option value="all">All Types</option>
                {referenceTypes.map(rt => (
                  <option key={rt} value={rt}>{rt.replace(/_/g, ' ')}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      </div>

      {/* Balance Summary Cards */}
      <div className="bg-white rounded-xl border border-border p-5 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <BookOpen className="w-4 h-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">Balance Summary</h3>
          <span className="text-xs text-muted-foreground ml-auto">
            {filteredLines.length} entries in selected period
          </span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Opening Balance</p>
            <p className="text-lg font-bold text-foreground">{formatCurrency(balanceSummary.opening)}</p>
          </div>
          <div className="space-y-1">
            <p className="text-xs text-green-600 font-medium">Total Debit</p>
            <p className="text-lg font-bold text-green-600">{formatCurrency(balanceSummary.totalDebit)}</p>
          </div>
          <div className="space-y-1">
            <p className="text-xs text-red-600 font-medium">Total Credit</p>
            <p className="text-lg font-bold text-red-600">{formatCurrency(balanceSummary.totalCredit)}</p>
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Net Change</p>
            <p className={`text-lg font-bold ${balanceSummary.net >= 0 ? 'text-blue-600' : 'text-orange-600'}`}>
              {balanceSummary.net >= 0 ? '+' : ''}{formatCurrency(balanceSummary.net)}
            </p>
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Closing Balance</p>
            <p className="text-lg font-bold text-foreground">{formatCurrency(balanceSummary.closing)}</p>
          </div>
        </div>
      </div>

      {/* Quick Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border border-border p-4 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <div className="w-9 h-9 rounded-full flex items-center justify-center bg-green-50">
              <ArrowUpRight className="w-4 h-4 text-green-600" />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">Total Debits</p>
          <p className="text-xl font-bold mt-0.5 text-green-600">{formatCurrency(balanceSummary.totalDebit)}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">{balanceSummary.entryCount} entries</p>
        </div>
        <div className="bg-white rounded-xl border border-border p-4 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <div className="w-9 h-9 rounded-full flex items-center justify-center bg-red-50">
              <ArrowDownLeft className="w-4 h-4 text-red-600" />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">Total Credits</p>
          <p className="text-xl font-bold mt-0.5 text-red-600">{formatCurrency(balanceSummary.totalCredit)}</p>
        </div>
        <div className="bg-white rounded-xl border border-border p-4 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <div className={`w-9 h-9 rounded-full flex items-center justify-center ${balanceSummary.net >= 0 ? 'bg-blue-50' : 'bg-orange-50'}`}>
              {balanceSummary.net >= 0 ? <TrendingUp className="w-4 h-4 text-blue-600" /> : <TrendingDown className="w-4 h-4 text-orange-600" />}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">Net Activity</p>
          <p className={`text-xl font-bold mt-0.5 ${balanceSummary.net >= 0 ? 'text-blue-600' : 'text-orange-600'}`}>
            {formatCurrency(Math.abs(balanceSummary.net))}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-border p-4 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <div className="w-9 h-9 rounded-full flex items-center justify-center bg-purple-50">
              <BarChart3 className="w-4 h-4 text-purple-600" />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">Avg / Entry</p>
          <p className="text-xl font-bold mt-0.5 text-foreground">
            {formatCurrency(balanceSummary.entryCount > 0 ? (balanceSummary.totalDebit + balanceSummary.totalCredit) / balanceSummary.entryCount : 0)}
          </p>
        </div>
      </div>

      {/* Charts */}
      {monthlyChart.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="bg-white rounded-xl border border-border p-5 shadow-sm">
            <h3 className="text-sm font-semibold text-foreground mb-1">Monthly Activity</h3>
            <p className="text-xs text-muted-foreground mb-4">Debits vs Credits by month</p>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={monthlyChart} barSize={18} barGap={2}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="month" tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} tickFormatter={v => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : String(v)} />
                <Tooltip formatter={(v: number) => [formatCurrency(v), '']} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Bar dataKey="debit" fill="#10b981" radius={[4, 4, 0, 0]} name="Debit" />
                <Bar dataKey="credit" fill="#ef4444" radius={[4, 4, 0, 0]} name="Credit" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="bg-white rounded-xl border border-border p-5 shadow-sm">
            <h3 className="text-sm font-semibold text-foreground mb-1">Cumulative Balance Trend</h3>
            <p className="text-xs text-muted-foreground mb-4">Running balance over time (from opening)</p>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={cumulativeBalance}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} tickFormatter={v => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : String(v)} />
                <Tooltip formatter={(v: number) => [formatCurrency(v), 'Balance']} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Line type="monotone" dataKey="balance" stroke="#3b82f6" strokeWidth={2} dot={false} name="Balance" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Module Usage Pie + Data Section Tabs */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Module Usage */}
        {moduleUsagePieData.length > 0 && (
          <div className="bg-white rounded-xl border border-border p-5 shadow-sm">
            <div className="flex items-center gap-2 mb-4">
              <Layers className="w-4 h-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold text-foreground">Module Usage</h3>
            </div>
            <ResponsiveContainer width="100%" height={180}>
              <PieChart>
                <Pie data={moduleUsagePieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={60} innerRadius={30}>
                  {moduleUsagePieData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                </Pie>
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
              </PieChart>
            </ResponsiveContainer>
            <div className="mt-3 space-y-1.5">
              {moduleUsage.slice(0, 5).map(m => (
                <div key={m.reference_type} className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground capitalize">{m.reference_type.replace(/_/g, ' ')}</span>
                  <span className="font-semibold text-foreground">{m.entry_count} entries</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Data Section Tabs + Content (spans 2 cols) */}
        <div className="lg:col-span-2 bg-white rounded-xl border border-border shadow-sm">
          <div className="border-b border-border flex items-center gap-1 px-4 pt-3 overflow-x-auto">
            {[
              { key: 'transactions', label: 'Transactions', icon: Receipt },
              { key: 'related', label: 'Related Accounts', icon: ArrowRightLeft },
              { key: 'breakdown', label: 'Party Breakdown', icon: Users },
              { key: 'audit', label: 'Audit Trail', icon: Activity },
            ].map(tab => (
              <button
                key={tab.key}
                onClick={() => setDataSection(tab.key as typeof dataSection)}
                className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium border-b-2 transition whitespace-nowrap ${
                  dataSection === tab.key
                    ? 'border-blue-600 text-blue-600'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                <tab.icon className="w-3.5 h-3.5" />
                {tab.label}
              </button>
            ))}
          </div>

          {/* Transactions Tab */}
          {dataSection === 'transactions' && (
            <div>
              {loading ? (
                <div className="p-6 space-y-3">
                  {Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-12 bg-muted rounded-lg animate-pulse" />)}
                </div>
              ) : paginatedLines.length === 0 ? (
                <div className="p-12 text-center text-muted-foreground text-sm">
                  <Wallet className="w-10 h-10 mx-auto mb-2 opacity-20" />
                  No transactions found for this period
                </div>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="bg-muted/40 border-b border-border">
                          <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Entry #</th>
                          <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Date</th>
                          <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Description</th>
                          <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Type</th>
                          <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Party</th>
                          <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Debit</th>
                          <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Credit</th>
                          <th className="text-center text-xs font-semibold text-muted-foreground px-4 py-3">JE</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {paginatedLines.map(line => {
                          const je = line.journal_entries;
                          const refType = je.reference_type;
                          const refId = je.reference_id;
                          return (
                            <tr key={line.id} className="hover:bg-muted/30 transition-colors">
                              <td className="px-4 py-3 text-sm font-mono text-blue-600">{je.entry_number}</td>
                              <td className="px-4 py-3 text-sm text-muted-foreground whitespace-nowrap">{formatDate(je.entry_date)}</td>
                              <td className="px-4 py-3 text-sm text-foreground max-w-xs">
                                <div className="truncate">{line.description || je.description || '—'}</div>
                                {refType === 'invoice' && refId && (
                                  <Link href={`/sales?highlight=${refId}`} className="text-[10px] text-blue-500 hover:underline">View invoice</Link>
                                )}
                                {refType === 'receivable' && refId && (
                                  <Link href="/accounting" className="text-[10px] text-purple-500 hover:underline">View receivable</Link>
                                )}
                              </td>
                              <td className="px-4 py-3">
                                {refType && <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-gray-100 text-gray-600 capitalize">{refType.replace(/_/g, ' ')}</span>}
                              </td>
                              <td className="px-4 py-3 text-xs text-muted-foreground">
                                {je.customer_id ? <span className="inline-flex items-center gap-1"><Users className="w-3 h-3" /> Customer</span> :
                                 je.supplier_id ? <span className="inline-flex items-center gap-1"><Building2 className="w-3 h-3" /> Supplier</span> : '—'}
                              </td>
                              <td className="px-4 py-3 text-sm text-right font-semibold">
                                {Number(line.debit) > 0 ? <span className="text-green-600">{formatCurrency(Number(line.debit))}</span> : <span className="text-muted-foreground">—</span>}
                              </td>
                              <td className="px-4 py-3 text-sm text-right font-semibold">
                                {Number(line.credit) > 0 ? <span className="text-red-600">{formatCurrency(Number(line.credit))}</span> : <span className="text-muted-foreground">—</span>}
                              </td>
                              <td className="px-4 py-3 text-center">
                                <Link href={`/accounting/journal?highlight=${je.id}`} className="text-muted-foreground hover:text-blue-600 transition" title="View in journal">
                                  <ExternalLink className="w-3.5 h-3.5 mx-auto" />
                                </Link>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      {filteredLines.length > 0 && (
                        <tfoot>
                          <tr className="bg-muted/40 border-t-2 border-border">
                            <td colSpan={5} className="px-4 py-3 text-sm font-semibold text-muted-foreground">Period Total</td>
                            <td className="px-4 py-3 text-sm text-right font-bold text-green-600">{formatCurrency(balanceSummary.totalDebit)}</td>
                            <td className="px-4 py-3 text-sm text-right font-bold text-red-600">{formatCurrency(balanceSummary.totalCredit)}</td>
                            <td></td>
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  </div>

                  {/* Pagination */}
                  {totalPages > 1 && (
                    <div className="px-4 py-3 border-t border-border flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">
                        Page {currentPage} of {totalPages} · Showing {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, filteredLines.length)} of {filteredLines.length}
                      </span>
                      <div className="flex items-center gap-1">
                        <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} className="w-8 h-8 flex items-center justify-center rounded-lg border border-border text-sm hover:bg-muted transition disabled:opacity-40 disabled:cursor-not-allowed">
                          <ChevronLeft className="w-4 h-4" />
                        </button>
                        {Array.from({ length: Math.min(totalPages, 7) }).map((_, i) => {
                          let page = i + 1;
                          if (totalPages > 7) {
                            if (currentPage > 4) page = currentPage - 3 + i;
                            if (currentPage > totalPages - 3) page = totalPages - 6 + i;
                          }
                          if (page < 1 || page > totalPages) return null;
                          return (
                            <button key={page} onClick={() => setCurrentPage(page)} className={`w-8 h-8 flex items-center justify-center rounded-lg text-sm font-medium transition ${currentPage === page ? 'bg-blue-600 text-white' : 'border border-border text-muted-foreground hover:bg-muted'}`}>
                              {page}
                            </button>
                          );
                        })}
                        <button onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages} className="w-8 h-8 flex items-center justify-center rounded-lg border border-border text-sm hover:bg-muted transition disabled:opacity-40 disabled:cursor-not-allowed">
                          <ChevronRight className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Related Accounts Tab */}
          {dataSection === 'related' && (
            <div className="p-4">
              {relatedAccounts.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm">No related accounts found</div>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left text-xs font-semibold text-muted-foreground px-3 py-2">Code</th>
                      <th className="text-left text-xs font-semibold text-muted-foreground px-3 py-2">Account Name</th>
                      <th className="text-left text-xs font-semibold text-muted-foreground px-3 py-2">Type</th>
                      <th className="text-right text-xs font-semibold text-muted-foreground px-3 py-2">Debit</th>
                      <th className="text-right text-xs font-semibold text-muted-foreground px-3 py-2">Credit</th>
                      <th className="text-right text-xs font-semibold text-muted-foreground px-3 py-2">Interactions</th>
                      <th className="text-center text-xs font-semibold text-muted-foreground px-3 py-2">View</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {relatedAccounts.map(ra => (
                      <tr key={ra.code} className="hover:bg-muted/30 transition-colors">
                        <td className="px-3 py-2.5 text-sm font-mono text-muted-foreground">{ra.code}</td>
                        <td className="px-3 py-2.5 text-sm font-medium text-foreground">{ra.name}</td>
                        <td className="px-3 py-2.5">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium capitalize ${typeColors[ra.account_type] || 'bg-gray-100 text-gray-600'}`}>{ra.account_type}</span>
                        </td>
                        <td className="px-3 py-2.5 text-sm text-right font-semibold text-green-600">{formatCurrency(ra.total_debit)}</td>
                        <td className="px-3 py-2.5 text-sm text-right font-semibold text-red-600">{formatCurrency(ra.total_credit)}</td>
                        <td className="px-3 py-2.5 text-sm text-right text-muted-foreground">{ra.interaction_count}</td>
                        <td className="px-3 py-2.5 text-center">
                          <Link href={`/accounting/accounts/${ra.id}`} className="text-blue-500 hover:text-blue-700">
                            <ExternalLink className="w-3.5 h-3.5 mx-auto" />
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="text-xs text-muted-foreground mt-3 px-3">
                These accounts share journal entries with {account?.name}. They represent the counterpart entries in double-entry bookkeeping.
              </p>
            </div>
          )}

          {/* Party Breakdown Tab */}
          {dataSection === 'breakdown' && (
            <div className="p-4">
              {partyBreakdown.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm">No customer/supplier transactions found</div>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left text-xs font-semibold text-muted-foreground px-3 py-2">Name</th>
                      <th className="text-left text-xs font-semibold text-muted-foreground px-3 py-2">Type</th>
                      <th className="text-right text-xs font-semibold text-muted-foreground px-3 py-2">Entries</th>
                      <th className="text-right text-xs font-semibold text-muted-foreground px-3 py-2">Debit</th>
                      <th className="text-right text-xs font-semibold text-muted-foreground px-3 py-2">Credit</th>
                      <th className="text-right text-xs font-semibold text-muted-foreground px-3 py-2">Net</th>
                      <th className="text-center text-xs font-semibold text-muted-foreground px-3 py-2">View</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {partyBreakdown.map(p => (
                      <tr key={`${p.party_type}-${p.party_id}`} className="hover:bg-muted/30 transition-colors">
                        <td className="px-3 py-2.5 text-sm font-medium text-foreground">{p.party_name}</td>
                        <td className="px-3 py-2.5">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${p.party_type === 'customer' ? 'bg-blue-50 text-blue-600' : 'bg-purple-50 text-purple-600'}`}>
                            {p.party_type === 'customer' ? <Users className="w-2.5 h-2.5" /> : <Building2 className="w-2.5 h-2.5" />}
                            {p.party_type}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-sm text-right text-muted-foreground">{p.entry_count}</td>
                        <td className="px-3 py-2.5 text-sm text-right font-semibold text-green-600">{formatCurrency(p.total_debit)}</td>
                        <td className="px-3 py-2.5 text-sm text-right font-semibold text-red-600">{formatCurrency(p.total_credit)}</td>
                        <td className={`px-3 py-2.5 text-sm text-right font-bold ${p.net_activity >= 0 ? 'text-blue-600' : 'text-orange-600'}`}>
                          {p.net_activity >= 0 ? '+' : ''}{formatCurrency(p.net_activity)}
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          {p.party_type === 'customer' ? (
                            <Link href={`/crm/${p.party_id}`} className="text-blue-500 hover:text-blue-700"><ExternalLink className="w-3.5 h-3.5 mx-auto" /></Link>
                          ) : (
                            <Link href={`/suppliers/${p.party_id}`} className="text-purple-500 hover:text-purple-700"><ExternalLink className="w-3.5 h-3.5 mx-auto" /></Link>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* Audit Trail Tab */}
          {dataSection === 'audit' && (
            <div className="p-4">
              {auditTrail.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm">No recent audit entries found</div>
              ) : (
                <div className="space-y-2">
                  {auditTrail.map(entry => (
                    <div key={entry.id} className="flex items-start gap-3 p-3 rounded-lg hover:bg-muted/30 transition-colors">
                      <div className="w-8 h-8 rounded-full flex items-center justify-center bg-muted flex-shrink-0">
                        <CircleDot className="w-3.5 h-3.5 text-muted-foreground" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-foreground capitalize">{entry.action.replace(/_/g, ' ')}</span>
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-muted text-muted-foreground capitalize">{entry.entity_type.replace(/_/g, ' ')}</span>
                        </div>
                        {entry.entity_label && <p className="text-xs text-muted-foreground mt-0.5 truncate">{entry.entity_label}</p>}
                        <p className="text-[10px] text-muted-foreground mt-0.5">
                          {entry.user_name || 'System'} · {formatDate(entry.created_at)}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


// BALANCE ADJUSTMENT PANEL
function BalanceAdjustmentPanel({ account, onAdjusted }: { account: Account; onAdjusted: () => void }) {
  const [isOpen, setIsOpen] = useState(false);
  const [form, setForm] = useState({
    amount: '',
    date: new Date().toISOString().split('T')[0],
    description: '',
    offsetAccountId: '',
  });
  const [offsetAccounts, setOffsetAccounts] = useState<Account[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    // Load equity accounts for offset (typically Opening Balance Equity 3900, or Retained Earnings)
    supabase.from('accounts')
      .select('*')
      .eq('account_type', 'equity')
      .eq('is_active', true)
      .order('code')
      .then(({ data }) => setOffsetAccounts((data || []) as Account[]));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.offsetAccountId) {
      setError('Please select an offset account');
      return;
    }

    const amount = parseFloat(form.amount);
    if (isNaN(amount) || amount === 0) {
      setError('Please enter a valid amount');
      return;
    }

    setError('');
    setSaving(true);
    try {
      const { data: jeNum } = await supabase.rpc('get_next_journal_number');
      const isDebitNormal = account.account_type === 'asset' || account.account_type === 'expense';

      // For positive adjustment: debit asset/expense accounts, credit liability/equity/revenue accounts
      // For negative adjustment: flip the sides
      const isPositiveAdjustment = amount > 0;
      const absAmount = Math.abs(amount);

      let targetDebit = 0, targetCredit = 0, offsetDebit = 0, offsetCredit = 0;

      if (isDebitNormal) {
        if (isPositiveAdjustment) {
          targetDebit = absAmount;
          offsetCredit = absAmount;
        } else {
          targetCredit = absAmount;
          offsetDebit = absAmount;
        }
      } else {
        if (isPositiveAdjustment) {
          targetCredit = absAmount;
          offsetDebit = absAmount;
        } else {
          targetDebit = absAmount;
          offsetCredit = absAmount;
        }
      }

      const { data: entry, error: entryError } = await supabase
        .from('journal_entries')
        .insert({
          entry_number: jeNum || `JE-${Date.now().toString().slice(-6)}`,
          entry_date: form.date,
          description: form.description || `Balance adjustment for ${account.name}`,
          reference_type: 'balance_adjustment',
          total_debit: absAmount,
          total_credit: absAmount,
          is_posted: true,
        })
        .select()
        .single();

      if (entryError) throw entryError;

      await supabase.from('journal_lines').insert([
        {
          journal_entry_id: entry.id,
          account_id: account.id,
          description: form.description || `Balance adjustment`,
          debit: targetDebit,
          credit: targetCredit,
          sort_order: 0,
        },
        {
          journal_entry_id: entry.id,
          account_id: form.offsetAccountId,
          description: form.description || `Balance adjustment - ${account.name}`,
          debit: offsetDebit,
          credit: offsetCredit,
          sort_order: 1,
        },
      ]);

      // Update balances using the RPC function
      await supabase.rpc('increment_account_balance', {
        p_account_id: account.id,
        p_delta: isDebitNormal ? (targetDebit - targetCredit) : (targetCredit - targetDebit),
      });
      await supabase.rpc('increment_account_balance', {
        p_account_id: form.offsetAccountId,
        p_delta: offsetDebit - offsetCredit,
      });

      toast({ title: 'Balance adjusted', description: `Adjustment of ${formatCurrency(absAmount)} posted successfully` });
      setIsOpen(false);
      setForm({ amount: '', date: new Date().toISOString().split('T')[0], description: '', offsetAccountId: '' });
      onAdjusted();
    } catch (err: any) {
      setError(err.message || 'Failed to post adjustment');
    } finally {
      setSaving(false);
    }
  }

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="w-full bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 rounded-xl p-4 flex items-center justify-between hover:from-amber-100 hover:to-orange-100 transition group"
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center group-hover:bg-amber-200 transition">
            <Plus className="w-5 h-5 text-amber-600" />
          </div>
          <div className="text-left">
            <p className="text-sm font-semibold text-foreground">Post Balance Adjustment</p>
            <p className="text-xs text-muted-foreground">Correct the account balance via journal entry</p>
          </div>
        </div>
        <div className="text-xs text-amber-600 font-medium">Click to adjust</div>
      </button>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-border p-6 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-amber-600" />
          <h3 className="text-base font-bold text-foreground">Balance Adjustment</h3>
        </div>
        <button onClick={() => setIsOpen(false)} className="text-muted-foreground hover:text-foreground">
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700">
        <p className="font-medium mb-1">⚠️ Use with caution</p>
        <p className="text-xs">
          This will post a journal entry to adjust the current balance. Use only for corrections, reconciliations, or
          setting opening balances. The offset will be posted to an equity account (typically Opening Balance Equity).
        </p>
      </div>

      {error && <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium mb-1">Adjustment Amount *</label>
            <input
              type="number"
              step="0.01"
              required
              value={form.amount}
              onChange={e => setForm({ ...form, amount: e.target.value })}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm"
              placeholder="Enter amount (+ or -)"
            />
            <p className="text-[11px] text-muted-foreground mt-1">
              Positive = increase, Negative = decrease
            </p>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Date *</label>
            <input
              type="date"
              required
              value={form.date}
              onChange={e => setForm({ ...form, date: e.target.value })}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium mb-1">Offset Account *</label>
          <select
            required
            value={form.offsetAccountId}
            onChange={e => setForm({ ...form, offsetAccountId: e.target.value })}
            className="w-full border border-border rounded-lg px-3 py-2 text-sm"
          >
            <option value="">Select equity account...</option>
            {offsetAccounts.map(acc => (
              <option key={acc.id} value={acc.id}>
                {acc.code} - {acc.name}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-muted-foreground mt-1">
            The offsetting side of the entry. Usually "Opening Balance Equity" (3900).
          </p>
        </div>

        <div>
          <label className="block text-xs font-medium mb-1">Description</label>
          <textarea
            value={form.description}
            onChange={e => setForm({ ...form, description: e.target.value })}
            rows={2}
            className="w-full border border-border rounded-lg px-3 py-2 text-sm resize-none"
            placeholder="Reason for adjustment..."
          />
        </div>

        <div className="flex items-center gap-3 pt-2 border-t border-border">
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            className="flex-1 px-4 py-2 border border-border rounded-lg text-sm font-medium hover:bg-muted/50 transition"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="flex-1 px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-50"
          >
            {saving ? 'Posting...' : 'Post Adjustment'}
          </button>
        </div>
      </form>
    </div>
  );
}
