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
  doc_type: string;
  doc_number: string | null;
  description: string | null;
  method: string | null;
  reference_number: string | null;
  charge: number;
  credit: number;
  balance: number;
}

interface PeriodStatement {
  opening_balance: number;
  closing_balance: number;
  total_charges: number;
  total_credits: number;
  store_credit_balance: number;
  advance_balance: number;
  rows: PeriodRow[];
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

interface CustomerStatementModalProps {
  customer: Customer;
  onClose: () => void;
}

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
  const [ledgerRows, setLedgerRows] = useState<LedgerRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const paperRef = useRef<HTMLDivElement>(null);

  const range = presetRange(preset, customFrom, customTo);
  const rangeKey = `${range.from ?? ''}..${range.to ?? ''}`;

  const loadPeriod = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.rpc('get_customer_period_statement', {
        p_customer_id: customer.id,
        p_from: range.from,
        p_to: range.to,
      });
      if (error) throw error;
      setPeriodData(data as PeriodStatement);
    } catch (err: any) {
      toast({ title: 'Error', description: err.message || 'Failed to build statement', variant: 'destructive' });
      setPeriodData(null);
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

  const periodLabel =
    preset === 'all'
      ? 'All time'
      : range.from && range.to
        ? `${formatDate(range.from)} – ${formatDate(range.to)}`
        : 'Custom range';

  const periodRows = periodData?.rows ?? [];
  const hasMemo = (Number(periodData?.store_credit_balance) > 0) || (Number(periodData?.advance_balance) > 0);

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
              disabled={loading || (mode === 'period' ? periodRows.length === 0 : !ledgerRows?.length)}
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
            {([['period', 'Period Statement'], ['ledger', 'AR Ledger (lifetime)']] as const).map(([value, label]) => (
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
                <div className="flex items-baseline justify-between border-b-2 border-black pb-2 mb-3">
                  <div>
                    <h1 className="text-lg font-bold">{mode === 'period' ? 'Customer Statement' : 'Accounts Receivable Ledger'}</h1>
                    <p className="text-sm">{customer.name} ({customer.code}){customer.company_name ? ` — ${customer.company_name}` : ''}</p>
                    {customer.phone && <p className="text-xs">{customer.phone}</p>}
                    {customer.address && <p className="text-xs">{customer.address}{customer.city ? `, ${customer.city}` : ''}</p>}
                  </div>
                  <div className="text-right text-xs">
                    <p className="font-semibold">{formatDate(new Date().toISOString().split('T')[0])}</p>
                    {mode === 'period' && <p className="font-medium">{periodLabel}</p>}
                    {mode === 'ledger' && <p>Full history · all entries</p>}
                    <p>Credit terms: {customer.credit_days} days</p>
                    {Number(customer.credit_limit) > 0 && <p>Limit: {formatCurrency(customer.credit_limit)}</p>}
                  </div>
                </div>

                {mode === 'period' ? (
                  <>
                    <div className="flex gap-4 mb-3 text-xs">
                      <div className="flex-1 border border-black p-2">
                        <p className="font-semibold border-b border-black pb-1 mb-1">Summary</p>
                        <div className="flex justify-between"><span>Opening balance</span><span className="font-mono">{formatCurrency(periodData?.opening_balance ?? 0)}</span></div>
                        <div className="flex justify-between"><span>Charges this period</span><span className="font-mono">{formatCurrency(periodData?.total_charges ?? 0)}</span></div>
                        <div className="flex justify-between"><span>Payments &amp; credits this period</span><span className="font-mono">{formatCurrency(periodData?.total_credits ?? 0)}</span></div>
                        <div className="flex justify-between font-bold border-t border-black mt-1 pt-1"><span>Closing balance</span><span className="font-mono">{formatCurrency(periodData?.closing_balance ?? 0)}</span></div>
                      </div>
                      {hasMemo && (
                        <div className="flex-1 border border-black p-2">
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
                          {['Date', 'Description', 'Charge', 'Credit', 'Balance'].map(h => (
                            <th key={h} className={`border border-black px-1.5 py-1.5 bg-gray-100 ${h === 'Date' || h === 'Description' ? 'text-left' : 'text-right'}`}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {periodRows.length === 0 ? (
                          <tr><td className="border border-black px-1.5 py-3 text-center" colSpan={5}>No activity in this period</td></tr>
                        ) : periodRows.map((r, i) => (
                          <tr key={i}>
                            <td className="border border-black px-1.5 py-1.5">{formatDate(r.date)}</td>
                            <td className="border border-black px-1.5 py-1.5">
                              <span className="font-semibold">{r.doc_number || r.doc_type}</span>
                              <span className="text-gray-700"> · {r.doc_type}{r.method ? ` · ${r.method.replace(/_/g, ' ')}` : ''}{r.reference_number ? ` · Ref ${r.reference_number}` : ''}</span>
                              {r.description && r.description !== `Invoice ${r.doc_number}` && (
                                <span className="block text-[10px] text-gray-600 truncate">{r.description}</span>
                              )}
                            </td>
                            <td className="border border-black px-1.5 py-1.5 text-right font-mono">{Number(r.charge) > 0 ? formatCurrency(r.charge) : ''}</td>
                            <td className="border border-black px-1.5 py-1.5 text-right font-mono">{Number(r.credit) > 0 ? formatCurrency(r.credit) : ''}</td>
                            <td className="border border-black px-1.5 py-1.5 text-right font-mono">{formatCurrency(r.balance)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="text-[10px] mt-2 text-gray-600">
                      Charge increases what you owe (invoices, refunds paid out). Credit reduces it (payments received, returns, write-offs).
                      Generated from the customer profile · {periodRows.length} entr{periodRows.length === 1 ? 'y' : 'ies'}.
                    </p>
                  </>
                ) : (
                  <>
                    <div className="flex gap-4 mb-3 text-xs">
                      <div className="flex-1 border border-black p-2">
                        <p className="font-semibold border-b border-black pb-1 mb-1">Summary</p>
                        <div className="flex justify-between font-bold"><span>Balance due (per ledger)</span><span className="font-mono">{formatCurrency(ledgerRows?.length ? Number(ledgerRows[ledgerRows.length - 1].balance) : 0)}</span></div>
                      </div>
                    </div>
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
                      Debit increases what the customer owes (invoices, receivables). Credit reduces it (payments, returns, bad debt).
                      Generated from the customer profile · {ledgerRows?.length ?? 0} entr{(ledgerRows?.length ?? 0) === 1 ? 'y' : 'ies'}.
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
