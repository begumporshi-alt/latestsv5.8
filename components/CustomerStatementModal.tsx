'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCurrency, formatDate } from '@/lib/format';
import { toast } from '@/hooks/use-toast';
import { printNode } from '@/lib/print';
import { X, Printer, FileText, BookOpen } from 'lucide-react';
import type { Customer } from '@/lib/types';

type Preset = 'this_month' | 'last30' | 'this_year' | 'all' | 'custom';

interface PeriodRow {
  date: string;
  kind: string;
  doc_number: string | null;
  label: string;
  details: string | null;
  method: string | null;
  reference_number: string | null;
  bill: number;
  paid: number;
  balance: number;
  revised?: boolean;
}

interface PeriodStatement {
  opening_balance: number;
  closing_balance: number;
  total_bills: number;
  total_paid: number;
  store_credit_balance: number;
  advance_balance: number;
  zero_net_excluded: number;
  revised_count: number;
  rows: PeriodRow[];
}

interface OpenInvoice {
  id: string;
  invoice_number: string;
  invoice_date: string;
  due_date: string | null;
  balance_due: number;
}

interface LedgerRow {
  entry_date: string;
  entry_number: string;
  doc_type: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
}

interface CompanyInfo {
  name?: string;
  address?: string;
  phone?: string;
  email?: string;
  logo_url?: string;
}

interface CustomerStatementModalProps {
  customer: Customer;
  onClose: () => void;
}

const FALLBACK_LOGO = '/Whats-App-Image-2026-07-09-at-15-57-58.jpg';

function ymdLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function presetRange(preset: Preset, customFrom: string, customTo: string): { from: string | null; to: string | null } {
  const today = new Date();
  switch (preset) {
    case 'this_month':
      return { from: ymdLocal(new Date(today.getFullYear(), today.getMonth(), 1)), to: ymdLocal(today) };
    case 'last30': {
      const from = new Date(today);
      from.setDate(from.getDate() - 29);
      return { from: ymdLocal(from), to: ymdLocal(today) };
    }
    case 'this_year':
      return { from: `${today.getFullYear()}-01-01`, to: ymdLocal(today) };
    case 'all':
      return { from: null, to: null };
    case 'custom':
      return { from: customFrom || null, to: customTo || null };
  }
}

export default function CustomerStatementModal({ customer, onClose }: CustomerStatementModalProps) {
  const [mode, setMode] = useState<'period' | 'ledger'>('period');
  const [preset, setPreset] = useState<Preset>('this_month');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [periodData, setPeriodData] = useState<PeriodStatement | null>(null);
  const [openInvoices, setOpenInvoices] = useState<OpenInvoice[]>([]);
  const [ledgerRows, setLedgerRows] = useState<LedgerRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [company, setCompany] = useState<CompanyInfo>({});
  const paperRef = useRef<HTMLDivElement>(null);

  const range = presetRange(preset, customFrom, customTo);
  const rangeKey = `${range.from ?? ''}..${range.to ?? ''}`;

  useEffect(() => {
    supabase
      .from('app_settings')
      .select('setting_value')
      .eq('setting_key', 'company')
      .maybeSingle()
      .then(({ data }) => setCompany(data?.setting_value ?? {}));
  }, []);

  const loadPeriod = useCallback(async () => {
    setLoading(true);
    try {
      const [stmtRes, invoicesRes] = await Promise.all([
        supabase.rpc('get_customer_period_statement', {
          p_customer_id: customer.id,
          p_from: range.from,
          p_to: range.to,
        }),
        supabase
          .from('invoices')
          .select('id, invoice_number, invoice_date, due_date, balance_due')
          .eq('customer_id', customer.id)
          .neq('status', 'cancelled')
          .gt('balance_due', 0)
          .order('invoice_date', { ascending: true }),
      ]);
      if (stmtRes.error) throw stmtRes.error;
      setPeriodData(stmtRes.data as PeriodStatement);
      setOpenInvoices((invoicesRes.data as OpenInvoice[]) || []);
    } catch (err: any) {
      toast({ title: 'Error', description: err.message || 'Failed to build statement', variant: 'destructive' });
      setPeriodData(null);
      setOpenInvoices([]);
    } finally {
      setLoading(false);
    }
  }, [customer.id, rangeKey]);

  const loadLedger = useCallback(async () => {
    if (ledgerRows) return;
    setLoading(true);
    try {
      const { data, error } = await supabase.rpc('get_customer_ar_statement', { p_customer_id: customer.id });
      if (error) throw error;
      setLedgerRows((data || []) as LedgerRow[]);
    } catch (err: any) {
      toast({ title: 'Error', description: err.message || 'Failed to build ledger', variant: 'destructive' });
      setLedgerRows(null);
    } finally {
      setLoading(false);
    }
  }, [customer.id]);

  useEffect(() => {
    if (mode === 'period') loadPeriod();
    else loadLedger();
  }, [mode, loadPeriod, loadLedger]);

  const today = ymdLocal(new Date());
  const periodLabel =
    preset === 'all'
      ? 'All time'
      : range.from && range.to
        ? `${formatDate(range.from)} – ${formatDate(range.to)}`
        : 'Custom range';
  const asOf = range.to || today;

  const periodRows = periodData?.rows ?? [];
  const ledgerBalance = ledgerRows?.length ? Number(ledgerRows[ledgerRows.length - 1].balance) : 0;
  const closing = mode === 'period' ? Number(periodData?.closing_balance ?? 0) : ledgerBalance;
  const hasMemo = (Number(periodData?.store_credit_balance) > 0) || (Number(periodData?.advance_balance) > 0);
  const shownInvoices = openInvoices.slice(0, 20);
  const moreInvoices = openInvoices.length - shownInvoices.length;

  const renderBanner = (
    <div className={`flex items-center justify-between border-2 border-black px-4 py-2 mb-3 ${closing === 0 ? 'bg-gray-100' : ''}`}>
      <span className="text-sm font-bold tracking-wide">
        {closing > 0
          ? 'BALANCE DUE'
          : closing < 0
            ? 'ADVANCE BALANCE (paid ahead)'
            : 'FULLY SETTLED — NOTHING DUE'}
      </span>
      <span className="text-xl font-extrabold font-mono">{formatCurrency(Math.abs(closing))}</span>
    </div>
  );

  const renderHeader = (
    <div className="flex items-start justify-between border-b-2 border-black pb-3 mb-3">
      <div className="flex items-center gap-3">
        <img
          src={company.logo_url || FALLBACK_LOGO}
          alt={company.name || 'Company logo'}
          className="h-14 w-auto object-contain"
        />
        <div className="text-xs">
          <p className="text-sm font-extrabold">{company.name || 'SI Building Solutions'}</p>
          {company.address && <p>{company.address}</p>}
          {(company.phone || company.email) && (
            <p>{[company.phone, company.email].filter(Boolean).join(' · ')}</p>
          )}
        </div>
      </div>
      <div className="text-right text-xs">
        <h1 className="text-base font-extrabold tracking-wider">
          {mode === 'period' ? 'STATEMENT OF ACCOUNT' : 'ACCOUNTS RECEIVABLE LEDGER'}
        </h1>
        <p className="mt-0.5">{mode === 'period' ? `Period: ${periodLabel}` : 'Full history · all entries'}</p>
        <p>Issued: {formatDate(today)}</p>
      </div>
    </div>
  );

  const renderBilledTo = (
    <div className="mb-3 text-xs">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-600">Billed to</p>
      <p className="text-sm font-bold">
        {customer.name}
        {customer.company_name ? ` — ${customer.company_name}` : ''} ({customer.code})
      </p>
      {(customer.phone || customer.address || customer.city) && (
        <p className="text-gray-700">
          {[customer.phone, customer.address, customer.city].filter(Boolean).join(' · ')}
        </p>
      )}
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-3xl shadow-2xl max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <h2 className="text-lg font-bold">Customer Statement</h2>
            <p className="text-xs text-muted-foreground">{customer.name} ({customer.code})</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => printNode(paperRef.current)}
              disabled={loading || (mode === 'period' ? !periodData : !ledgerRows?.length)}
              className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-50"
            >
              <Printer className="w-4 h-4" />Print
            </button>
            <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-muted" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="px-6 py-3 border-b border-border space-y-2">
          <div className="flex items-center rounded-lg border border-border overflow-hidden w-fit" role="group" aria-label="Statement type">
            {([['period', 'Customer Statement'], ['ledger', 'Detailed Ledger (internal)']] as const).map(([value, label]) => (
              <button
                key={value}
                onClick={() => setMode(value)}
                aria-pressed={mode === value}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition ${mode === value ? 'bg-blue-600 text-white' : 'bg-white text-muted-foreground hover:bg-muted'}`}
              >
                {value === 'period' ? <FileText className="w-3.5 h-3.5" /> : <BookOpen className="w-3.5 h-3.5" />}
                {label}
              </button>
            ))}
          </div>

          {mode === 'period' && (
            <div className="flex flex-wrap items-center gap-2">
              {([
                { value: 'this_month', label: 'This Month' },
                { value: 'last30', label: 'Last 30 Days' },
                { value: 'this_year', label: 'This Year' },
                { value: 'all', label: 'All Time' },
                { value: 'custom', label: 'Custom' },
              ] as const).map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setPreset(opt.value)}
                  aria-pressed={preset === opt.value}
                  className={`px-3 py-1 rounded-lg text-xs font-medium transition ${preset === opt.value ? 'bg-blue-600 text-white' : 'bg-muted/50 text-muted-foreground hover:bg-muted'}`}
                >
                  {opt.label}
                </button>
              ))}
              {preset === 'custom' && (
                <div className="flex items-center gap-1">
                  <input
                    type="date"
                    value={customFrom}
                    onChange={e => setCustomFrom(e.target.value)}
                    className="border border-border rounded-lg px-2 py-1 text-xs"
                    aria-label="From date"
                  />
                  <span className="text-muted-foreground text-xs">to</span>
                  <input
                    type="date"
                    value={customTo}
                    onChange={e => setCustomTo(e.target.value)}
                    className="border border-border rounded-lg px-2 py-1 text-xs"
                    aria-label="To date"
                  />
                </div>
              )}
            </div>
          )}
        </div>

        <div className="overflow-y-auto p-6 bg-muted/30 flex-1">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <div className="flex justify-center">
              {/* Paper preview — this exact node is what printNode prints */}
              <div ref={paperRef} className="bg-white p-6 text-black shadow-sm" style={{ width: '760px' }}>
                {renderHeader}
                {renderBilledTo}
                {renderBanner}

                {mode === 'period' ? (
                  <>
                    <div className="flex gap-4 mb-3 text-xs">
                      <div className="flex-1 border border-black p-2 space-y-0.5">
                        <div className="flex justify-between"><span>Previous balance</span><span className="font-mono">{formatCurrency(periodData?.opening_balance ?? 0)}</span></div>
                        <div className="flex justify-between"><span>+ Bills &amp; additions this period</span><span className="font-mono">{formatCurrency(periodData?.total_bills ?? 0)}</span></div>
                        <div className="flex justify-between"><span>− Payments, returns &amp; credits</span><span className="font-mono">{formatCurrency(periodData?.total_paid ?? 0)}</span></div>
                        <div className="flex justify-between font-bold border-t border-black mt-1 pt-1"><span>= Balance due</span><span className="font-mono">{formatCurrency(periodData?.closing_balance ?? 0)}</span></div>
                      </div>
                      {hasMemo && (
                        <div className="flex-1 border border-black p-2 space-y-0.5">
                          <p className="font-semibold border-b border-black pb-1 mb-1">Also on your account</p>
                          {Number(periodData?.store_credit_balance) > 0 && (
                            <div className="flex justify-between"><span>Store credit available</span><span className="font-mono">{formatCurrency(periodData!.store_credit_balance)}</span></div>
                          )}
                          {Number(periodData?.advance_balance) > 0 && (
                            <div className="flex justify-between"><span>Advance balance</span><span className="font-mono">{formatCurrency(periodData!.advance_balance)}</span></div>
                          )}
                          <p className="text-[10px] text-gray-600 mt-1">Not part of the balance due.</p>
                        </div>
                      )}
                    </div>

                    <table className="w-full border-collapse text-[11px]" style={{ tableLayout: 'fixed' }}>
                      <thead>
                        <tr>
                          <th className="border border-black px-1.5 py-1.5 bg-gray-100 text-left w-[64px]">Date</th>
                          <th className="border border-black px-1.5 py-1.5 bg-gray-100 text-left">Details</th>
                          <th className="border border-black px-1.5 py-1.5 bg-gray-100 text-right w-[86px]">Bill ৳</th>
                          <th className="border border-black px-1.5 py-1.5 bg-gray-100 text-right w-[92px]">Paid ৳</th>
                          <th className="border border-black px-1.5 py-1.5 bg-gray-100 text-right w-[104px]">Balance ৳</th>
                        </tr>
                      </thead>
                      <tbody>
                        {periodRows.length === 0 ? (
                          <tr><td className="border border-black px-1.5 py-3 text-center" colSpan={5}>No activity in this period</td></tr>
                        ) : periodRows.map((r, i) => (
                          <tr key={i}>
                            <td className="border border-black px-1.5 py-1.5 align-top">{formatDate(r.date)}</td>
                            <td className="border border-black px-1.5 py-1.5">
                              <span className="font-semibold">
                                {r.label}{r.doc_number ? ` ${r.doc_number}` : ''}{r.revised ? ' (revised)' : ''}
                              </span>
                              {(r.details || r.method || r.reference_number) && (
                                <span className="block text-[10px] text-gray-600">
                                  {[r.details, r.method ? r.method.replace(/_/g, ' ') : null, r.reference_number ? `Ref ${r.reference_number}` : null]
                                    .filter(Boolean)
                                    .join(' · ')}
                                </span>
                              )}
                            </td>
                            <td className="border border-black px-1.5 py-1.5 text-right font-mono align-top">{Number(r.bill) > 0 ? formatCurrency(r.bill) : ''}</td>
                            <td className="border border-black px-1.5 py-1.5 text-right font-mono align-top">{Number(r.paid) > 0 ? formatCurrency(r.paid) : ''}</td>
                            <td className="border border-black px-1.5 py-1.5 text-right font-mono align-top">
                              {Number(r.balance) < 0 ? `Adv ${formatCurrency(-Number(r.balance))}` : formatCurrency(r.balance)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>

                    {shownInvoices.length > 0 && (
                      <div className="mt-3">
                        <p className="font-bold text-xs border-b-2 border-black pb-1 mb-1">Unpaid invoices (as of today)</p>
                        <table className="w-full border-collapse text-[11px]" style={{ tableLayout: 'fixed' }}>
                          <thead>
                            <tr>
                              <th className="border border-black px-1.5 py-1 bg-gray-100 text-left">Invoice</th>
                              <th className="border border-black px-1.5 py-1 bg-gray-100 text-left w-[70px]">Date</th>
                              <th className="border border-black px-1.5 py-1 bg-gray-100 text-left w-[110px]">Due date</th>
                              <th className="border border-black px-1.5 py-1 bg-gray-100 text-right w-[104px]">Amount due ৳</th>
                            </tr>
                          </thead>
                          <tbody>
                            {shownInvoices.map(inv => {
                              const overdue = inv.due_date && inv.due_date < today;
                              return (
                                <tr key={inv.id}>
                                  <td className="border border-black px-1.5 py-1 font-semibold">{inv.invoice_number}</td>
                                  <td className="border border-black px-1.5 py-1">{formatDate(inv.invoice_date)}</td>
                                  <td className="border border-black px-1.5 py-1">
                                    {inv.due_date ? formatDate(inv.due_date) : '—'}
                                    {overdue ? <span className="font-bold"> (overdue)</span> : ''}
                                  </td>
                                  <td className="border border-black px-1.5 py-1 text-right font-mono">{formatCurrency(inv.balance_due)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                        {moreInvoices > 0 && (
                          <p className="text-[10px] text-gray-600 mt-1">…and {moreInvoices} more unpaid invoice{moreInvoices === 1 ? '' : 's'} — please contact us for the full list.</p>
                        )}
                        <div className="flex justify-between font-bold border-t border-black mt-1 pt-1">
                          <span>Total currently unpaid ({openInvoices.length} invoice{openInvoices.length === 1 ? '' : 's'})</span>
                          <span className="font-mono">{formatCurrency(openInvoices.reduce((s, inv) => s + Number(inv.balance_due), 0))}</span>
                        </div>
                      </div>
                    )}

                    <p className="text-[10px] mt-3 border-t border-black pt-2 text-gray-700 leading-relaxed">
                      As of {formatDate(asOf)},{' '}
                      {closing > 0
                        ? <>total balance due is <strong>{formatCurrency(closing)}</strong>.</>
                        : closing < 0
                          ? <>you have an advance of <strong>{formatCurrency(-closing)}</strong> with us.</>
                          : <>your account is fully settled — nothing is due.</>}
                      {' '}This statement covers {periodLabel} ({periodRows.length} document{periodRows.length === 1 ? '' : 's'}
                      {Number(periodData?.zero_net_excluded) > 0 ? `; ${periodData!.zero_net_excluded} cancelled or fully-reversed documents not shown` : ''}).
                      {Number(periodData?.revised_count) > 0 ? ' Invoices marked (revised) are shown at their latest corrected amount.' : ''}
                      {company.phone ? ` Questions? Call ${company.phone}.` : ''} Thank you for your business.
                    </p>
                  </>
                ) : (
                  <>
                    <table className="w-full border-collapse text-[11px]" style={{ tableLayout: 'fixed' }}>
                      <thead>
                        <tr>
                          {['Date', 'Entry #', 'Type', 'Description', 'Debit', 'Credit', 'Balance'].map(h => (
                            <th key={h} className="border border-black px-1.5 py-1.5 text-left bg-gray-100">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {!ledgerRows || ledgerRows.length === 0 ? (
                          <tr><td className="border border-black px-1.5 py-3 text-center" colSpan={7}>No receivable activity</td></tr>
                        ) : ledgerRows.map((row, i) => (
                          <tr key={i}>
                            <td className="border border-black px-1.5 py-1.5">{formatDate(row.entry_date)}</td>
                            <td className="border border-black px-1.5 py-1.5">{row.entry_number}</td>
                            <td className="border border-black px-1.5 py-1.5">{row.doc_type}</td>
                            <td className="border border-black px-1.5 py-1.5 truncate">{row.description}</td>
                            <td className="border border-black px-1.5 py-1.5 text-right font-mono">{Number(row.debit) > 0 ? formatCurrency(row.debit) : ''}</td>
                            <td className="border border-black px-1.5 py-1.5 text-right font-mono">{Number(row.credit) > 0 ? formatCurrency(row.credit) : ''}</td>
                            <td className="border border-black px-1.5 py-1.5 text-right font-mono">{formatCurrency(row.balance)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="text-[10px] mt-2 text-gray-600">
                      Internal ledger: debit increases what the customer owes (invoices, receivables); credit reduces it (payments, returns, bad debt). Bills and payments are shown net of edit/cancel reversals on the customer statement.
                    </p>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
