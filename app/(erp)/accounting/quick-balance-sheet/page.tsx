'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { format, isValid, parseISO } from 'date-fns';
import {
  Building2,
  Download,
  Printer,
  Receipt,
  RefreshCw,
  TrendingUp,
  TriangleAlert as AlertTriangle,
  Wallet,
} from 'lucide-react';

import { supabase } from '@/lib/supabase';
import { formatCurrency, formatCurrencyWith, getCurrencyFormat } from '@/lib/format';
import {
  buildQuickComparison,
  buildQuickSummary,
  type QuickSummary,
} from '@/lib/quick-balance-sheet';
import { formatRangeLabel, previousDayISO, rangeDayCount } from '@/lib/date-range';
import { AsOfDatePicker } from '@/components/AsOfDatePicker';
import { DateRangePicker } from '@/components/DateRangePicker';
import { useStatementScope, type StatementMode } from '@/hooks/use-statement-scope';
import { cn } from '@/lib/utils';

interface QuickRow {
  line_key: string;
  label: string;
  code: string;
  balance: number | string;
}

type SummaryKey = keyof QuickSummary;

interface StatementLine {
  code: string;
  name: string;
  opening: number;
  closing: number;
  change: number;
}

const MODES: Array<{ id: StatementMode; label: string; hint: string }> = [
  { id: 'asOf', label: 'As of a date', hint: 'One snapshot — the position on a single day' },
  { id: 'range', label: 'Date range', hint: 'Opening, closing and movement across a window' },
];

/**
 * Statement cells print the full amount.
 *
 * formatCurrency() compacts above a lakh/crore so a KPI card can stay small,
 * but in a three-column table that turns one row into "৳1.03Cr → ৳1.14Cr, change
 * +৳11.49L" — three different-looking units for one arithmetic relationship.
 * The statement is the record, so it shows every digit; the cards above it stay
 * compact on purpose.
 */
const money = (value: number): string =>
  formatCurrencyWith(value, { ...getCurrencyFormat(), large_display: 'full' });

function StatCard({
  label,
  value,
  caption,
  delta,
  icon: Icon,
  tone = 'default',
}: {
  label: string;
  value: string;
  caption: string;
  delta?: number | null;
  icon: typeof Building2;
  tone?: 'default' | 'negative';
}) {
  return (
    <div className="rounded-xl border border-border bg-white p-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        <span className="text-[11px] font-medium">{label}</span>
      </div>
      <p
        className={cn(
          'mt-2 text-xl font-bold tabular-nums',
          tone === 'negative' ? 'text-red-600' : 'text-foreground'
        )}
        suppressHydrationWarning
      >
        {value}
      </p>
      <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
        <p className="text-[11px] text-muted-foreground">{caption}</p>
        {delta !== null && delta !== undefined && Math.abs(delta) >= 0.005 && (
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-[10px] font-semibold tabular-nums',
              delta > 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
            )}
            suppressHydrationWarning
          >
            {delta > 0 ? '▲' : '▼'} {formatCurrency(Math.abs(delta))}
          </span>
        )}
      </div>
    </div>
  );
}

export default function QuickBalanceSheetPage() {
  const { mode, setMode, asOf, setAsOf, range, setRange, ready } = useStatementScope();
  const [rows, setRows] = useState<QuickRow[]>([]);
  const [openRows, setOpenRows] = useState<QuickRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [companyName, setCompanyName] = useState('SI Building Solutions.');
  const requestRef = useRef(0);

  const isRange = mode === 'range';

  useEffect(() => {
    supabase
      .from('app_settings')
      .select('setting_value')
      .eq('setting_key', 'company')
      .maybeSingle()
      .then(({ data }) => {
        if (data?.setting_value?.name) setCompanyName(data.setting_value.name);
      });
  }, []);

  const load = useCallback(async () => {
    const seq = ++requestRef.current;
    setLoading(true);
    setError(null);

    if (mode === 'range') {
      // Opening is the close of the day *before* `from`; see previousDayISO().
      const [openRes, closeRes] = await Promise.all([
        supabase.rpc('get_quick_balance_sheet', { p_as_of: previousDayISO(range.from) }),
        supabase.rpc('get_quick_balance_sheet', { p_as_of: range.to }),
      ]);
      if (seq !== requestRef.current) return;
      const rpcError = openRes.error ?? closeRes.error;
      if (rpcError) {
        setError(rpcError.message);
        setRows([]);
        setOpenRows([]);
      } else {
        setOpenRows((openRes.data || []) as QuickRow[]);
        setRows((closeRes.data || []) as QuickRow[]);
      }
      setLoading(false);
      return;
    }

    const { data, error: rpcError } = await supabase.rpc('get_quick_balance_sheet', { p_as_of: asOf });
    // A newer request is already in flight; its response is the one that counts.
    if (seq !== requestRef.current) return;
    if (rpcError) {
      setError(rpcError.message);
      setRows([]);
    } else {
      setRows((data || []) as QuickRow[]);
    }
    setOpenRows([]);
    setLoading(false);
  }, [mode, asOf, range.from, range.to]);

  useEffect(() => { if (ready) load(); }, [ready, load]);

  const summary = useMemo(() => buildQuickSummary(rows), [rows]);
  const comparison = useMemo(() => buildQuickComparison(openRows, rows), [openRows, rows]);

  /** Whichever snapshot the statement is describing — the closing one in range mode. */
  const view = isRange ? comparison.closing : summary;
  const delta = isRange ? comparison.change : null;

  const openingISO = previousDayISO(range.from);
  const openingDate = parseISO(openingISO);
  const toDate = parseISO(range.to);

  const openingLabel = isValid(openingDate) ? format(openingDate, 'd MMM yyyy') : openingISO;
  const closingLabel = isValid(toDate) ? format(toDate, 'd MMM yyyy') : range.to;
  const rangeLabel = formatRangeLabel(range);

  const parsedAsOf = parseISO(asOf);
  const asOfLabel = isValid(parsedAsOf) ? format(parsedAsOf, 'd MMMM yyyy') : asOf;

  const subtitle = isRange
    ? `${rangeLabel} · ${rangeDayCount(range)} days · opening at ${openingLabel}`
    : 'Fixed assets, inventory, receivables, payables and revenue — cash, bank and expenses excluded';

  function exportCsv() {
    const lines: string[] = ['QUICK BALANCE SHEET'];
    if (isRange) {
      lines.push(`Period,${rangeLabel}`);
      lines.push(`Opening (close of ${openingLabel}),Closing (${closingLabel}),Change`);
    } else {
      lines.push(`As of ${asOfLabel}`);
    }
    lines.push('');

    const row = (label: string, line: StatementLine) => {
      const name = line.code ? `${line.code} ${label}` : label;
      return isRange
        ? `${name},${line.opening.toFixed(2)},${line.closing.toFixed(2)},${line.change.toFixed(2)}`
        : `${name},${line.closing.toFixed(2)}`;
    };

    lines.push('ASSETS');
    lines.push(row('Fixed Assets', lineFor('1004', 'Fixed Assets', 'fixedAssets')));
    lines.push(row('Inventory', lineFor('1200', 'Inventory', 'inventory')));
    lines.push(row('Accounts Receivable', lineFor('1100', 'Accounts Receivable', 'receivables')));
    lines.push(row('Total Assets', totalFor('Total Assets', 'totalAssets')));
    lines.push('');
    lines.push('LIABILITIES');
    lines.push(row('Accounts Payable', lineFor('2000', 'Accounts Payable', 'payables')));
    lines.push(row('Total Liabilities', totalFor('Total Liabilities', 'totalLiabilities')));
    lines.push('');
    lines.push(isRange ? 'REVENUE (EARNED IN PERIOD)' : 'REVENUE (CUMULATIVE TO DATE)');
    lines.push(row('Sales Revenue', lineFor('4000', 'Sales Revenue', 'revenue')));
    lines.push('');
    lines.push(row('Net position (Assets - Liabilities)', totalFor('Net position', 'netPosition')));

    const csv = '\uFEFF' + lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = isRange
      ? `quick_balance_sheet_${range.from}_to_${range.to}.csv`
      : `quick_balance_sheet_${asOf}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function lineFor(code: string, name: string, key: SummaryKey): StatementLine {
    return {
      code,
      name,
      opening: comparison.opening[key],
      closing: view[key],
      change: comparison.change[key],
    };
  }

  function totalFor(name: string, key: SummaryKey): StatementLine {
    return {
      code: '',
      name,
      opening: comparison.opening[key],
      closing: view[key],
      change: comparison.change[key],
    };
  }

  const sectionHead = (label: string, note?: string) => (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-t border-border bg-blue-50 px-4 py-2">
      <h4 className="text-xs font-bold tracking-wide text-blue-700">{label}</h4>
      {note && <span className="text-[10px] font-medium text-blue-600/80">{note}</span>}
    </div>
  );

  const changeCell = (value: number, strong = false) => {
    const flat = Math.abs(value) < 0.005;
    return (
      <td
        className={cn(
          'py-2.5 pl-3 pr-4 text-right text-sm tabular-nums',
          strong ? 'font-bold' : 'font-medium',
          flat ? 'text-gray-300' : 'text-slate-700'
        )}
      >
        {flat ? '—' : `${value > 0 ? '+' : '−'}${money(Math.abs(value))}`}
      </td>
    );
  };

  const lineRow = (line: StatementLine) => (
    <tr key={`${line.code}-${line.name}`} className="border-b border-gray-100">
      <td className="py-2.5 pl-4 text-sm text-gray-700">
        {line.code && <span className="mr-2 font-mono text-xs text-gray-400">{line.code}</span>}
        {line.name}
      </td>
      {isRange && (
        <td className="py-2.5 pl-3 pr-4 text-right text-sm tabular-nums text-gray-500">
          {money(line.opening)}
        </td>
      )}
      <td className="py-2.5 pl-3 pr-4 text-right text-sm font-medium tabular-nums text-gray-800">
        {money(line.closing)}
      </td>
      {isRange && changeCell(line.change)}
    </tr>
  );

  const totalRow = (line: StatementLine) => (
    <tr key={line.name} className="border-b border-gray-200 bg-blue-50">
      <td className="py-2.5 pl-4 font-semibold text-gray-800">{line.name}</td>
      {isRange && (
        <td className="py-2.5 pl-3 pr-4 text-right text-sm font-semibold tabular-nums text-blue-700/70">
          {money(line.opening)}
        </td>
      )}
      <td className="py-2.5 pl-3 pr-4 text-right font-bold tabular-nums text-blue-800">
        {money(line.closing)}
      </td>
      {isRange && changeCell(line.change, true)}
    </tr>
  );

  const tableHead = (
    <thead>
      <tr className="border-b border-gray-200 bg-gray-50/70">
        <th className="py-2 pl-4 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
          Account
        </th>
        {isRange && (
          <th className="py-2 pl-3 pr-4 text-right text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            <span className="block">Opening</span>
            <span className="block font-normal normal-case text-gray-400">{openingLabel}</span>
          </th>
        )}
        <th className="py-2 pl-3 pr-4 text-right text-[11px] font-semibold uppercase tracking-wide text-gray-500">
          {isRange ? (
            <>
              <span className="block">Closing</span>
              <span className="block font-normal normal-case text-gray-400">{closingLabel}</span>
            </>
          ) : (
            'Balance'
          )}
        </th>
        {isRange && (
          <th className="py-2 pl-3 pr-4 text-right text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            Change
          </th>
        )}
      </tr>
    </thead>
  );

  return (
    <div className="space-y-5 animate-fade-in print-modal">
      <div className="flex items-start justify-between flex-wrap gap-3 print:hidden">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Quick Balance Sheet</h1>
          <p className="mt-0.5 text-sm text-muted-foreground" suppressHydrationWarning>{subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            title="Refresh balances"
            aria-label="Refresh balances"
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm transition hover:bg-muted"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => window.print()}
            title="Print"
            aria-label="Print quick balance sheet"
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm transition hover:bg-muted"
          >
            <Printer className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={exportCsv}
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700"
          >
            <Download className="h-4 w-4" />
            Export
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <div
          role="group"
          aria-label="Statement basis"
          className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5"
        >
          {MODES.map(item => (
            <button
              key={item.id}
              type="button"
              title={item.hint}
              aria-pressed={mode === item.id}
              onClick={() => setMode(item.id)}
              className={cn(
                'rounded-md px-3 py-1.5 text-xs font-semibold transition',
                mode === item.id
                  ? 'bg-white text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        {isRange ? (
          <DateRangePicker value={range} onChange={setRange} loading={loading} />
        ) : (
          <AsOfDatePicker value={asOf} onChange={setAsOf} loading={loading} />
        )}
      </div>

      {error && (
        <div className="flex gap-3 rounded-xl border border-red-200 bg-red-50 p-4 print:hidden">
          <AlertTriangle className="h-5 w-5 shrink-0 text-red-500" />
          <div className="text-sm text-red-700">{error}</div>
        </div>
      )}

      <div className={`grid grid-cols-2 gap-3 lg:grid-cols-4 transition-opacity ${loading ? 'opacity-60' : ''}`}>
        <StatCard
          label="Total Assets"
          value={formatCurrency(view.totalAssets)}
          caption={isRange ? `Closing at ${closingLabel}` : 'Fixed + Inventory + Receivable'}
          delta={delta?.totalAssets}
          icon={Building2}
        />
        <StatCard
          label="Accounts Payable"
          value={formatCurrency(view.payables)}
          caption={isRange ? `Closing at ${closingLabel}` : 'Owed to suppliers'}
          delta={delta?.payables}
          icon={Receipt}
        />
        <StatCard
          label="Net Position"
          value={formatCurrency(view.netPosition)}
          caption="Assets − Payables"
          delta={delta?.netPosition}
          icon={Wallet}
          tone={view.netPosition < 0 ? 'negative' : 'default'}
        />
        <StatCard
          label="Sales Revenue"
          value={formatCurrency(view.revenue)}
          caption={isRange ? `Earned in ${rangeLabel}` : 'Cumulative to date'}
          delta={delta?.revenue}
          icon={TrendingUp}
        />
      </div>

      <div className="mx-auto max-w-3xl rounded-lg border border-gray-200 bg-white shadow-sm print:border-none print:shadow-none">
        <div className="border-b border-gray-200 py-6 text-center">
          <div className="mb-2 flex items-center justify-center gap-2">
            <Building2 className="h-5 w-5 text-gray-600" />
            <h2 className="text-lg font-bold tracking-wide text-gray-900">{companyName}</h2>
          </div>
          <h3 className="mt-2 text-base font-semibold text-gray-800">QUICK BALANCE SHEET</h3>
          <p className="mt-1 text-sm text-gray-500" suppressHydrationWarning>
            {isRange ? `Period ${rangeLabel}` : `As of ${asOfLabel}`}
          </p>
          {isRange && (
            <p className="mt-0.5 text-xs text-gray-400" suppressHydrationWarning>
              Opening at close of {openingLabel} · closing at {closingLabel}
            </p>
          )}
        </div>

        {loading && rows.length === 0 ? (
          <div className="px-8 py-12 text-center text-gray-400">Loading balances…</div>
        ) : (
          <div className={`space-y-6 px-6 py-4 transition-opacity ${loading ? 'opacity-60' : ''}`}>
            <div>
              {sectionHead('ASSETS')}
              <table className="w-full text-sm">
                {tableHead}
                <tbody>
                  {lineRow(lineFor('1004', 'Fixed Assets', 'fixedAssets'))}
                  {lineRow(lineFor('1200', 'Inventory', 'inventory'))}
                  {lineRow(lineFor('1100', 'Accounts Receivable', 'receivables'))}
                  {totalRow(totalFor('Total Assets', 'totalAssets'))}
                </tbody>
              </table>
            </div>

            <div>
              {sectionHead('LIABILITIES')}
              <table className="w-full text-sm">
                {tableHead}
                <tbody>
                  {lineRow(lineFor('2000', 'Accounts Payable', 'payables'))}
                  {totalRow(totalFor('Total Liabilities', 'totalLiabilities'))}
                </tbody>
              </table>
            </div>

            <div>
              {sectionHead(
                isRange ? 'REVENUE (EARNED IN PERIOD)' : 'REVENUE (CUMULATIVE TO DATE)',
                isRange ? 'Change = revenue earned in this window' : undefined
              )}
              <table className="w-full text-sm">
                {tableHead}
                <tbody>{lineRow(lineFor('4000', 'Sales Revenue', 'revenue'))}</tbody>
              </table>
            </div>

            {isRange && !comparison.hasMovement && (
              <p className="rounded-lg bg-slate-50 px-4 py-3 text-center text-xs text-slate-500">
                Nothing was posted between {openingLabel} and {closingLabel} — every line is
                unchanged.
              </p>
            )}

            <div className="mt-4 flex items-center justify-between rounded-lg bg-slate-800 px-4 py-4">
              <div>
                <span className="text-sm font-bold tracking-wide text-white">NET POSITION</span>
                {isRange && (
                  <span className="ml-2 text-[11px] font-medium text-slate-300">
                    {delta && Math.abs(delta.netPosition) >= 0.005
                      ? `${delta.netPosition > 0 ? '+' : '−'}${money(Math.abs(delta.netPosition))} over ${rangeDayCount(range)} days`
                      : 'unchanged over the period'}
                  </span>
                )}
              </div>
              <span className="text-xl font-bold tabular-nums text-white">{money(view.netPosition)}</span>
            </div>
          </div>
        )}
      </div>

      <p className="mx-auto max-w-3xl text-xs leading-relaxed text-muted-foreground">
        A snapshot of five key accounts, not a complete statement. Cash, bank and expense accounts are
        excluded by design, so this will not balance and must not be read as a trial balance.
        {isRange ? (
          <>
            {' '}Fixed assets, inventory, receivables and payables are positions, so a period can only
            report them as opening, closing and the movement between; the closing column is the one
            that answers “where do we stand on {closingLabel}”. Sales revenue is the only flow line,
            and its change column is revenue earned inside the window rather than a running total.
          </>
        ) : (
          <>
            {' '}Sales revenue is an income account shown for context — it is cumulative to the as-of
            date, not a balance-sheet item.
          </>
        )}
      </p>
    </div>
  );
}
