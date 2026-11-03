'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { format, isValid, parseISO } from 'date-fns';
import {
  Building2,
  Download,
  Printer,
  Receipt,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  TriangleAlert as AlertTriangle,
  Wallet,
} from 'lucide-react';

import { supabase } from '@/lib/supabase';
import { formatCurrency, formatCurrencyWith, getCurrencyFormat } from '@/lib/format';
import {
  buildQuickStatement,
  type LineAmounts,
  type StatementLine,
} from '@/lib/quick-balance-sheet';
import { formatRangeLabel, previousDayISO, rangeDayCount } from '@/lib/date-range';
import { AsOfDatePicker } from '@/components/AsOfDatePicker';
import { DateRangePicker } from '@/components/DateRangePicker';
import { useStatementScope, type StatementMode } from '@/hooks/use-statement-scope';
import { cn } from '@/lib/utils';

interface QuickRow {
  section: string;
  code: string;
  label: string;
  balance: number | string;
  sub_amount?: number | string | null;
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
  delta?: number;
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
        {delta !== undefined && Math.abs(delta) >= 0.005 && (
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
        supabase.rpc('get_quick_statement', { p_as_of: previousDayISO(range.from) }),
        supabase.rpc('get_quick_statement', { p_as_of: range.to }),
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

    const { data, error: rpcError } = await supabase.rpc('get_quick_statement', { p_as_of: asOf });
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

  /**
   * One model for both modes: in single-date mode the same rows are passed as
   * both ends, so every change is zero and the change column is simply not
   * rendered. See buildQuickStatement().
   */
  const statement = useMemo(
    () => buildQuickStatement(isRange ? openRows : rows, rows),
    [isRange, openRows, rows]
  );

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
    : 'Fixed assets, inventory, receivables, payables, revenue and expenses — cash and bank excluded';

  const periodLabel = isRange ? rangeLabel : `to ${asOfLabel}`;

  function exportCsv() {
    const lines: string[] = ['QUICK BALANCE SHEET'];
    if (isRange) {
      lines.push(`Period,${rangeLabel}`);
      lines.push(`Opening (close of ${openingLabel}),Closing (${closingLabel}),Change`);
    } else {
      lines.push(`As of ${asOfLabel}`);
    }
    lines.push('');

    const line = (row: StatementLine) =>
      isRange
        ? `${row.code} ${row.label},${row.opening.toFixed(2)},${row.closing.toFixed(2)},${row.change.toFixed(2)}`
        : `${row.code} ${row.label},${row.closing.toFixed(2)}`;

    const total = (label: string, amount: LineAmounts) =>
      isRange
        ? `${label},${amount.opening.toFixed(2)},${amount.closing.toFixed(2)},${amount.change.toFixed(2)}`
        : `${label},${amount.closing.toFixed(2)}`;

    const section = (title: string, list: StatementLine[], totalLabel: string, amount: LineAmounts) => {
      lines.push(title);
      list.forEach(row => lines.push(line(row)));
      lines.push(total(totalLabel, amount));
      lines.push('');
    };

    section('ASSETS', statement.assets, 'Total Assets', statement.totalAssets);
    section('LIABILITIES', statement.liabilities, 'Total Liabilities', statement.totalLiabilities);
    section('REVENUE', statement.revenues, 'Total Revenue', statement.totalRevenue);

    // The Quick Sell slice of 4000 is a breakdown, not a separate amount, so it
    // is written as an "of which" line rather than added to the total.
    const quickLine = statement.revenues.find(
      row => Math.abs(isRange ? row.sub.change : row.sub.closing) >= 0.005
    );
    if (quickLine) {
      lines.pop(); // the blank line the section helper just appended
      lines.push(
        isRange
          ? `  of which Quick Sell,${quickLine.sub.opening.toFixed(2)},${quickLine.sub.closing.toFixed(2)},${quickLine.sub.change.toFixed(2)}`
          : `  of which Quick Sell,${quickLine.sub.closing.toFixed(2)}`
      );
      lines.push('');
    }

    section('EXPENSES', statement.expenses, 'Total Expenses', statement.totalExpenses);
    lines.push(total('Net position (Assets - Liabilities)', statement.netPosition));
    lines.push(total('Net profit (Revenue - Expenses)', statement.netProfit));

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

  /**
   * 4000 Sales Revenue mixes counter, invoiced and Quick Sell revenue. When the
   * RPC reports a breakdown, show it inline rather than as another row — it is a
   * slice of the line above it, not an amount to be added.
   */
  const breakdownNote = (line: StatementLine): string | null => {
    const value = isRange ? line.sub.change : line.sub.closing;
    if (Math.abs(value) < 0.005) return null;
    return isRange
      ? `incl. ${money(value)} quick sales in period`
      : `incl. ${money(value)} quick sales`;
  };

  const lineRow = (line: StatementLine) => {
    const note = breakdownNote(line);
    return (
      <tr key={`${line.section}-${line.code}`} className="border-b border-gray-100">
        <td className="py-2.5 pl-4 text-sm text-gray-700">
          <span className="mr-2 font-mono text-xs text-gray-400">{line.code}</span>
          {line.label}
          {note && (
            <span className="ml-1.5 text-[11px] text-gray-500" suppressHydrationWarning>
              ({note})
            </span>
          )}
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
  };

  const totalRow = (label: string, amount: LineAmounts) => (
    <tr className="border-b border-gray-200 bg-blue-50">
      <td className="py-2.5 pl-4 font-semibold text-gray-800">{label}</td>
      {isRange && (
        <td className="py-2.5 pl-3 pr-4 text-right text-sm font-semibold tabular-nums text-blue-700/70">
          {money(amount.opening)}
        </td>
      )}
      <td className="py-2.5 pl-3 pr-4 text-right font-bold tabular-nums text-blue-800">
        {money(amount.closing)}
      </td>
      {isRange && changeCell(amount.change, true)}
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

  const renderSection = (
    title: string,
    note: string | undefined,
    list: StatementLine[],
    totalLabel: string,
    amount: LineAmounts
  ) => (
    <div>
      {sectionHead(title, note)}
      <table className="w-full text-sm">
        {tableHead}
        <tbody>
          {list.length === 0 ? (
            <tr className="border-b border-gray-100">
              <td
                colSpan={isRange ? 4 : 2}
                className="px-4 py-3 text-center text-xs text-gray-400"
              >
                No account with a balance
              </td>
            </tr>
          ) : (
            list.map(line => lineRow(line))
          )}
          {totalRow(totalLabel, amount)}
        </tbody>
      </table>
    </div>
  );

  const netProfit = statement.netProfit;
  const netPosition = statement.netPosition;

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

      <div className={`grid grid-cols-2 gap-3 lg:grid-cols-5 transition-opacity ${loading ? 'opacity-60' : ''}`}>
        <StatCard
          label="Total Assets"
          value={formatCurrency(statement.totalAssets.closing)}
          caption={isRange ? `Closing at ${closingLabel}` : 'Fixed + Inventory + Receivable'}
          delta={isRange ? statement.totalAssets.change : undefined}
          icon={Building2}
        />
        <StatCard
          label="Total Revenue"
          value={formatCurrency(statement.totalRevenue.closing)}
          caption={isRange ? `Earned in ${rangeLabel}` : 'Cumulative to date'}
          delta={isRange ? statement.totalRevenue.change : undefined}
          icon={TrendingUp}
        />
        <StatCard
          label="Total Expenses"
          value={formatCurrency(statement.totalExpenses.closing)}
          caption={isRange ? `Incurred in ${rangeLabel}` : 'Cumulative to date'}
          delta={isRange ? statement.totalExpenses.change : undefined}
          icon={TrendingDown}
        />
        <StatCard
          label={netProfit.closing < 0 ? 'Net Loss' : 'Net Profit'}
          value={formatCurrency(Math.abs(netProfit.closing))}
          caption="Revenue − Expenses"
          delta={isRange ? netProfit.change : undefined}
          icon={Wallet}
          tone={netProfit.closing < 0 ? 'negative' : 'default'}
        />
        <StatCard
          label="Accounts Payable"
          value={formatCurrency(statement.totalLiabilities.closing)}
          caption="Owed to suppliers"
          delta={isRange ? statement.totalLiabilities.change : undefined}
          icon={Receipt}
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
            {renderSection('ASSETS', undefined, statement.assets, 'Total Assets', statement.totalAssets)}
            {renderSection('LIABILITIES', undefined, statement.liabilities, 'Total Liabilities', statement.totalLiabilities)}
            {renderSection(
              'REVENUE',
              isRange ? 'Change = revenue earned in this window' : undefined,
              statement.revenues,
              'Total Revenue',
              statement.totalRevenue
            )}
            {renderSection(
              'EXPENSES',
              isRange ? 'Change = expenses incurred in this window' : undefined,
              statement.expenses,
              'Total Expenses',
              statement.totalExpenses
            )}

            {isRange && !statement.hasMovement && (
              <p className="rounded-lg bg-slate-50 px-4 py-3 text-center text-xs text-slate-500">
                Nothing was posted between {openingLabel} and {closingLabel} — every line is
                unchanged.
              </p>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between rounded-lg bg-slate-100 px-4 py-3">
                <div>
                  <span className="text-xs font-bold tracking-wide text-slate-700">
                    NET POSITION
                  </span>
                  <span className="ml-2 text-[11px] text-slate-500">Assets − Liabilities</span>
                </div>
                <span className="text-base font-bold tabular-nums text-slate-800">
                  {money(netPosition.closing)}
                </span>
              </div>

              <div className="flex items-center justify-between rounded-lg bg-slate-800 px-4 py-4">
                <div>
                  <span className="text-sm font-bold tracking-wide text-white">
                    {netProfit.closing < 0 ? 'NET LOSS' : 'NET PROFIT'}
                  </span>
                  <span className="ml-2 text-[11px] font-medium text-slate-300">
                    Revenue − Expenses{isRange ? ` · ${periodLabel}` : ''}
                  </span>
                  {isRange && Math.abs(netProfit.change) >= 0.005 && (
                    <span className="ml-2 text-[11px] font-medium text-slate-400" suppressHydrationWarning>
                      ({netProfit.change > 0 ? '+' : '−'}{money(Math.abs(netProfit.change))} in period)
                    </span>
                  )}
                </div>
                <span className="text-xl font-bold tabular-nums text-white">
                  {money(Math.abs(netProfit.closing))}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      <p className="mx-auto max-w-3xl text-xs leading-relaxed text-muted-foreground">
        A summary of selected accounts, not a complete statement. Cash and bank accounts are
        excluded by design, so this will not balance and must not be read as a trial balance.
        {isRange ? (
          <>
            {' '}Assets, liabilities, revenue and expenses all appear as opening, closing and the
            movement between; the closing column is the one that answers “where do we stand on{' '}
            {closingLabel}”, while each change column is what happened inside the window.
          </>
        ) : (
          <>
            {' '}Revenue and expense balances are cumulative to the as-of date, since the ledger
            began — they are not period figures. Switch to Date range to read them per period.
          </>
        )}{' '}
        Net profit covers every revenue and expense account listed above and nothing else. 4001
        Sales Revenue — Manual is excluded from this statement by request, so net profit is lower
        than the ledger by whatever that account holds.
      </p>
    </div>
  );
}
