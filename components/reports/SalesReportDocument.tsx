'use client';

/**
 * The printed sales report.
 *
 * Design rules this file follows:
 *   - Every sheet is an exact A4 box (210×297mm minus the print margin of 0,
 *     with 12mm internal padding). The page count is therefore known before
 *     rendering, so "Page n of m" is real rather than a browser guess.
 *   - Rows are chunked deterministically, so the printed table is the WHOLE
 *     dataset — never the paginated slice that happened to be on screen.
 *   - Inline styles only: the document is printed in a bare popup window with
 *     no Tailwind, and it must look identical there.
 *   - Charts are CSS bars, not SVG. A chart that depends on a measured
 *     container renders blank in print; a bar is a coloured div.
 *   - Numbers right-aligned, tabular, grouped; negatives in parentheses.
 */

import { formatAmount, getCurrencyFormat } from '@/lib/format';
import {
  DIMENSION_LABEL,
  DIMENSIONS,
  compositionSlices,
  marginPct,
  type BreakdownRow,
  type Dimension,
  type SalesSummary,
  type View,
} from '@/lib/reports/sales-report';
import type { ChartMetric, PrintScope } from '@/lib/reports/sales-report-store';

const NAVY = '#1e3a6e';
const NAVY_SOFT = '#8fb0d4';
const INK = '#1f2937';
const MUTED = '#6b7280';
const FAINT = '#8a94a6';
const RULE = '#dde3ef';
const ZEBRA = '#f7f9fc';
const TINT = '#eef2f8';
const GREEN = '#3b6d11';
const RED = '#a32d2d';

/** Rows that fit on the first page of a section (chart occupies space). */
const ROWS_FIRST = 18;
/** Rows that fit on a continuation page. */
const ROWS_REST = 30;

export interface CompanyInfo {
  name: string;
  address?: string;
  phone?: string;
  email?: string;
  logo_url?: string;
}

export interface SalesReportDocumentProps {
  summary: SalesSummary;
  /** Full lists, when available. Falls back to the summary's top rows. */
  fullRows: Partial<Record<Dimension, BreakdownRow[]>>;
  periodLabel: string;
  scope: PrintScope;
  activeView: View;
  metric: ChartMetric;
  company: CompanyInfo;
  preparedBy: string;
  isOffline: boolean;
  syncedAt?: number | null;
}

const money = (v: number) => formatAmount(v);
const pct = (v: number) => `${v.toFixed(1)}%`;
const sym = () => getCurrencyFormat().symbol;

function paginate<T>(rows: T[], first: number, rest: number): T[][] {
  if (rows.length <= first) return [rows];
  const pages: T[][] = [rows.slice(0, first)];
  let i = first;
  while (i < rows.length) {
    pages.push(rows.slice(i, i + rest));
    i += rest;
  }
  return pages;
}

function metricValue(row: BreakdownRow, metric: ChartMetric): number {
  if (metric === 'profit') return row.profit;
  if (metric === 'quantity') return row.quantity;
  return row.revenue;
}

function metricLabel(metric: ChartMetric): string {
  return metric === 'profit' ? 'Gross profit' : metric === 'quantity' ? 'Quantity sold' : 'Revenue';
}

/* ------------------------------------------------------------------ */
/* Shared blocks                                                       */
/* ------------------------------------------------------------------ */

function DocHeader({
  company,
  periodLabel,
  reportRef,
  compact,
}: {
  company: CompanyInfo;
  periodLabel: string;
  reportRef: string;
  compact?: boolean;
}) {
  const logo = company.logo_url || '/Whats-App-Image-2026-07-09-at-15-57-58.jpg';
  if (compact) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: `1px solid ${RULE}`,
          paddingBottom: '2.5mm',
          marginBottom: '4mm',
        }}
      >
        <div style={{ fontSize: '8pt', color: MUTED }}>
          <span style={{ color: NAVY, fontWeight: 700 }}>{company.name}</span> · Sales report
        </div>
        <div style={{ fontSize: '8pt', color: MUTED }}>{periodLabel}</div>
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        borderBottom: `2.5px solid ${NAVY}`,
        paddingBottom: '4mm',
        gap: '8mm',
      }}
    >
      <div style={{ display: 'flex', gap: '4mm', alignItems: 'flex-start' }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={logo}
          alt=""
          style={{ height: '15mm', width: 'auto', maxWidth: '46mm', objectFit: 'contain', display: 'block' }}
        />
        <div>
          <div style={{ fontSize: '11.5pt', fontWeight: 700, color: NAVY, lineHeight: 1.2 }}>
            {company.name}
          </div>
          {company.address && (
            <div style={{ fontSize: '7.5pt', color: MUTED, maxWidth: '66mm', lineHeight: 1.45, marginTop: '0.8mm' }}>
              {company.address}
            </div>
          )}
          <div style={{ fontSize: '7.5pt', color: MUTED, marginTop: '0.4mm' }}>
            {[company.phone, company.email].filter(Boolean).join('  ·  ')}
          </div>
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: '14pt', fontWeight: 700, color: NAVY, letterSpacing: '1.5px', lineHeight: 1.15 }}>
          SALES REPORT
        </div>
        <div style={{ fontSize: '8.5pt', color: INK, marginTop: '1.2mm' }}>{periodLabel}</div>
        <div style={{ fontSize: '7pt', color: FAINT, marginTop: '0.6mm' }}>Ref {reportRef}</div>
      </div>
    </div>
  );
}

function MetaBand({
  periodLabel,
  generatedAt,
  preparedBy,
  isOffline,
  syncedAt,
}: {
  periodLabel: string;
  generatedAt: string;
  preparedBy: string;
  isOffline: boolean;
  syncedAt?: number | null;
}) {
  const cells = [
    { label: 'Report period', value: periodLabel },
    { label: 'Generated', value: generatedAt },
    { label: 'Prepared by', value: preparedBy || '—' },
    {
      label: 'Basis',
      value: isOffline
        ? `Local data · synced ${syncedAt ? new Date(syncedAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'unknown'}`
        : `${sym()} · ex-VAT`,
    },
  ];

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', background: ZEBRA, borderBottom: `1px solid ${RULE}` }}>
      <tbody>
        <tr>
          {cells.map((c, i) => (
            <td
              key={c.label}
              style={{
                width: '25%',
                padding: '2.5mm 3mm',
                borderRight: i < cells.length - 1 ? `1px solid ${RULE}` : 'none',
                verticalAlign: 'top',
              }}
            >
              <div style={{ fontSize: '7pt', color: FAINT, letterSpacing: '0.2px' }}>{c.label}</div>
              <div style={{ fontSize: '8.5pt', color: INK, fontWeight: 600, marginTop: '0.6mm' }}>{c.value}</div>
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  );
}

function KpiStrip({ kpis }: { kpis: SalesSummary['kpis'] }) {
  const cells = [
    { label: `Revenue (${sym()})`, value: money(kpis.revenue), sub: `${kpis.orders} invoices` },
    { label: 'Sales returns', value: money(kpis.returns), sub: 'account 4050' },
    { label: 'COGS', value: money(kpis.cogs), sub: 'account 5000' },
    {
      label: 'Gross profit',
      value: money(kpis.gross_profit),
      sub: `${pct(marginPct(kpis.gross_profit, kpis.revenue))} margin`,
      strong: true,
    },
    { label: 'Cart discount', value: money(kpis.cart_discount), sub: 'allocated to lines' },
    { label: `Avg. invoice (${sym()})`, value: money(kpis.avg_invoice), sub: 'per invoice' },
  ];

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', borderBottom: `1px solid ${RULE}` }}>
      <tbody>
        <tr>
          {cells.map((c, i) => (
            <td
              key={c.label}
              style={{
                width: `${100 / cells.length}%`,
                padding: '3mm',
                borderRight: i < cells.length - 1 ? `1px solid ${RULE}` : 'none',
                verticalAlign: 'top',
              }}
            >
              <div style={{ fontSize: '7pt', color: FAINT }}>{c.label}</div>
              <div
                style={{
                  fontSize: c.strong ? '11pt' : '10.5pt',
                  fontWeight: 700,
                  color: c.strong ? (kpis.gross_profit >= 0 ? GREEN : RED) : INK,
                  marginTop: '0.8mm',
                  whiteSpace: 'nowrap',
                }}
              >
                {c.value}
              </div>
              <div style={{ fontSize: '7pt', color: FAINT, marginTop: '0.4mm' }}>{c.sub}</div>
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  );
}

function SectionTitle({ title, note }: { title: string; note?: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        marginTop: '5mm',
        marginBottom: '2.5mm',
      }}
    >
      <div style={{ fontSize: '10pt', fontWeight: 700, color: NAVY, letterSpacing: '0.3px' }}>{title}</div>
      {note && <div style={{ fontSize: '7.5pt', color: FAINT }}>{note}</div>}
    </div>
  );
}

function TrendBlock({ monthly }: { monthly: SalesSummary['monthly'] }) {
  const rows = monthly.slice(-18);
  const max = Math.max(...rows.map((m) => m.revenue), 1);

  return (
    <div style={{ marginTop: '1mm' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '4mm', marginBottom: '1.5mm' }}>
        <Legend color={NAVY} label="Revenue" />
        <Legend color={NAVY_SOFT} label="Gross profit" />
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: '1.8mm',
          height: '55mm',
          borderBottom: `1px solid ${RULE}`,
        }}
      >
        {rows.map((m) => {
          const h = Math.max((m.revenue / max) * 100, m.revenue > 0 ? 1.5 : 0);
          const p = Math.max(((m.revenue - m.cost) / max) * 100, 0);
          return (
            <div
              key={m.month}
              style={{ flex: 1, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: '0.5mm', height: '100%' }}
            >
              <div style={{ width: '2.8mm', height: `${h}%`, background: NAVY }} />
              <div style={{ width: '2.8mm', height: `${p}%`, background: NAVY_SOFT }} />
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: '1.8mm', marginTop: '1mm' }}>
        {rows.map((m) => (
          <div key={m.month} style={{ flex: 1, textAlign: 'center', fontSize: '6.5pt', color: FAINT }}>
            {m.month.slice(2)}
          </div>
        ))}
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '1.2mm', fontSize: '7pt', color: MUTED }}>
      <span style={{ width: '2.6mm', height: '2.6mm', background: color, display: 'inline-block' }} />
      {label}
    </div>
  );
}

/** A composition block: ranked rows with a proportional bar and share. */
function CompositionBlock({
  title,
  rows,
  total,
  totalMembers,
  limit = 5,
}: {
  title: string;
  rows: BreakdownRow[];
  total: number;
  totalMembers?: number;
  limit?: number;
}) {
  const data = compositionSlices(rows, limit, total, totalMembers);
  const max = Math.max(...data.map((d) => d.revenue), 1);

  return (
    <div style={{ border: `1px solid ${RULE}`, padding: '2.5mm 3mm' }}>
      <div style={{ fontSize: '8pt', fontWeight: 700, color: NAVY, marginBottom: '1.8mm' }}>{title}</div>
      {data.length === 0 ? (
        <div style={{ fontSize: '7.5pt', color: FAINT }}>No sales in this period</div>
      ) : (
        data.map((d, i) => (
          <div key={`${d.name}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: '2mm', marginBottom: '1.4mm' }}>
            <div
              style={{
                width: '30mm',
                fontSize: '7.5pt',
                color: d.others ? MUTED : INK,
                fontStyle: d.others ? 'italic' : 'normal',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {d.name}
            </div>
            {/* The absolute amount is deliberately omitted here: at 91mm per
                block it would squeeze the bar into an unreadable stub. The
                share is the question this block answers, and the amounts are
                in the section tables. */}
            <div style={{ flex: 1, height: '2.8mm', background: '#f1f4f9' }}>
              <div
                style={{
                  width: `${(d.revenue / max) * 100}%`,
                  height: '100%',
                  background: d.others ? NAVY_SOFT : NAVY,
                }}
              />
            </div>
            <div style={{ width: '11mm', textAlign: 'right', fontSize: '7.5pt', color: INK }}>{pct(d.share)}</div>
          </div>
        ))
      )}
    </div>
  );
}

function PrintBars({ rows, metric, limit }: { rows: BreakdownRow[]; metric: ChartMetric; limit: number }) {
  const data = rows.slice(0, limit);
  const values = data.map((r) => metricValue(r, metric));
  const max = Math.max(...values.map((v) => Math.abs(v)), 1);

  return (
    <div style={{ border: `1px solid ${RULE}`, padding: '3mm', marginBottom: '4mm' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2.5mm' }}>
        <div style={{ fontSize: '7.5pt', color: NAVY, fontWeight: 700 }}>
          Top {Math.min(limit, rows.length)} · {metricLabel(metric)}
        </div>
        <div style={{ fontSize: '7pt', color: FAINT }}>Bars scaled to the largest value shown</div>
      </div>
      {data.map((r, i) => {
        const v = metricValue(r, metric);
        const width = (Math.abs(v) / max) * 100;
        return (
          <div key={`${r.id ?? r.name}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: '2.5mm', marginBottom: '1.6mm' }}>
            <div style={{ width: '5mm', fontSize: '7pt', color: FAINT, textAlign: 'right' }}>{i + 1}</div>
            <div
              style={{
                width: '58mm',
                fontSize: '7.5pt',
                color: INK,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {r.name}
            </div>
            <div style={{ flex: 1, height: '3.2mm', background: '#f1f4f9' }}>
              <div style={{ width: `${width}%`, height: '100%', background: v < 0 ? RED : NAVY }} />
            </div>
            <div style={{ width: '24mm', textAlign: 'right', fontSize: '7.5pt', color: v < 0 ? RED : INK }}>
              {metric === 'quantity' ? Math.round(v).toLocaleString('en-US') : money(v)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DataTable({
  rows,
  startIndex,
  sectionRevenue,
  pageSubtotal,
}: {
  rows: BreakdownRow[];
  startIndex: number;
  /** Net revenue of the whole section — the denominator for the share column. */
  sectionRevenue: number;
  /** When the section spans pages, each page carries its own subtotal. */
  pageSubtotal: { revenue: number; cost: number; profit: number; quantity: number } | null;
}) {
  const cols: { label: string; align: 'left' | 'right' | 'center'; width: string }[] = [
    { label: '#', align: 'center', width: '7mm' },
    { label: 'Name', align: 'left', width: '50mm' },
    { label: 'Qty', align: 'right', width: '15mm' },
    { label: 'Invoices', align: 'right', width: '14mm' },
    { label: `Revenue (${sym()})`, align: 'right', width: '25mm' },
    { label: 'Cost', align: 'right', width: '23mm' },
    { label: 'Profit', align: 'right', width: '23mm' },
    { label: 'Margin', align: 'right', width: '14mm' },
    { label: '% of rev', align: 'right', width: '13mm' },
  ];

  const pageTotal = rows.reduce(
    (a, r) => ({
      quantity: a.quantity + r.quantity,
      revenue: a.revenue + r.revenue,
      cost: a.cost + r.cost,
      profit: a.profit + r.profit,
    }),
    { quantity: 0, revenue: 0, cost: 0, profit: 0 },
  );

  // On the final page `pageSubtotal` carries the whole-section total (so the
  // footer reconciles with every row printed across all pages); on an
  // intermediate page the footer subtotals only what that page shows.
  const isFinal = pageSubtotal !== null;
  const shown = pageSubtotal ?? pageTotal;

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', fontSize: '7.8pt' }}>
      <colgroup>
        {cols.map((c) => (
          <col key={c.label} style={{ width: c.width }} />
        ))}
      </colgroup>
      <thead>
        <tr style={{ background: TINT }}>
          {cols.map((c) => (
            <th
              key={c.label}
              style={{
                padding: '1.8mm 1.6mm',
                textAlign: c.align,
                fontSize: '7pt',
                fontWeight: 700,
                color: NAVY,
                borderBottom: `1.5px solid ${NAVY}`,
                borderRight: `1px solid ${RULE}`,
              }}
            >
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const m = marginPct(r.profit, r.revenue);
          return (
            <tr key={`${r.id ?? r.name}-${startIndex + i}`} style={{ background: i % 2 === 1 ? ZEBRA : '#fff' }}>
              <td style={cell('center', FAINT)}>{startIndex + i + 1}</td>
              <td style={{ ...cell('left'), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.name}
              </td>
              <td style={cell('right')}>
                {Math.round(r.quantity).toLocaleString('en-US')}
                {r.unit ? <span style={{ color: FAINT, fontSize: '6.5pt' }}> {r.unit}</span> : null}
              </td>
              <td style={cell('right')}>{r.invoice_count}</td>
              <td style={cell('right', INK, true)}>{money(r.revenue)}</td>
              <td style={cell('right', MUTED)}>{money(r.cost)}</td>
              <td style={cell('right', r.profit < 0 ? RED : INK, true)}>{r.profit < 0 ? `(${money(Math.abs(r.profit))})` : money(r.profit)}</td>
              <td style={cell('right', m < 0 ? RED : MUTED)}>{pct(m)}</td>
              <td style={cell('right', FAINT)}>{sectionRevenue > 0 ? pct((r.revenue / sectionRevenue) * 100) : '0.0%'}</td>
            </tr>
          );
        })}
        {rows.length === 0 && (
          <tr>
            <td colSpan={9} style={{ padding: '8mm', textAlign: 'center', color: FAINT, fontSize: '8pt' }}>
              No sales in this period
            </td>
          </tr>
        )}
      </tbody>
      <tfoot>
        <tr style={{ background: TINT, borderTop: `1.5px solid ${NAVY}` }}>
          <td colSpan={2} style={{ ...cell('left', NAVY, true), paddingLeft: '1.6mm' }}>
            {isFinal ? 'TOTAL' : 'Page subtotal'}
          </td>
          <td style={cell('right', NAVY, true)}>{Math.round(shown.quantity).toLocaleString('en-US')}</td>
          <td style={cell('right', NAVY, true)}>—</td>
          <td style={cell('right', NAVY, true)}>{money(shown.revenue)}</td>
          <td style={cell('right', NAVY, true)}>{money(shown.cost)}</td>
          <td style={cell('right', NAVY, true)}>{money(shown.profit)}</td>
          <td style={cell('right', NAVY, true)}>{pct(marginPct(shown.profit, shown.revenue))}</td>
          <td style={cell('right', NAVY, true)}>{isFinal ? '100.0%' : ''}</td>
        </tr>
      </tfoot>
    </table>
  );
}

function cell(align: 'left' | 'right' | 'center', color: string = INK, bold = false): React.CSSProperties {
  return {
    padding: '1.35mm 1.6mm',
    textAlign: align,
    color,
    fontWeight: bold ? 700 : 400,
    borderBottom: `1px solid #eef1f6`,
    borderRight: `1px solid #eef1f6`,
    verticalAlign: 'middle',
  };
}

function BasisNotes({ summary }: { summary: SalesSummary }) {
  const variance = summary.kpis.cogs - summary.kpis.cogs_line;
  const lines = [
    'Revenue is the invoice-line subtotal after allocating each invoice\u2019s cart discount pro-rata across its lines, and excludes VAT and shipping (both billed at invoice level).',
    'COGS in the summary strip is the ledger figure (account 5000) and matches the P&L. Dimension tables use the cost price recorded on each line at the time of sale.',
    'Cancelled and draft invoices are excluded. Sales returns are taken from account 4050.',
  ];
  if (Math.abs(variance) >= 0.5) {
    lines.push(
      `Line-cost COGS differs from the ledger by ${money(variance)} — see the COGS audit report for the posting-level explanation.`,
    );
  }

  return (
    <div>
      <div style={{ fontSize: '6.5pt', color: FAINT, letterSpacing: '0.4px', marginBottom: '1mm' }}>
        BASIS OF PREPARATION
      </div>
      {lines.map((l, i) => (
        <div key={i} style={{ fontSize: '6.8pt', color: MUTED, lineHeight: 1.5 }}>
          {l}
        </div>
      ))}
    </div>
  );
}

function SheetFooter({
  page,
  totalPages,
  companyName,
  summary,
  showSignatures,
}: {
  page: number;
  totalPages: number;
  companyName: string;
  summary: SalesSummary;
  showSignatures: boolean;
}) {
  return (
    <div style={{ marginTop: 'auto', paddingTop: '3mm' }}>
      {showSignatures && (
        <div style={{ display: 'flex', gap: '8mm', borderTop: `1px solid ${RULE}`, paddingTop: '3mm' }}>
          <div style={{ flex: 1.5 }}>
            <BasisNotes summary={summary} />
          </div>
          <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: '5mm' }}>
            {['Prepared by', 'Approved by'].map((label) => (
              <div key={label} style={{ flex: 1, textAlign: 'center' }}>
                <div style={{ borderTop: `1px solid #9aa4b5`, paddingTop: '1mm', fontSize: '6.8pt', color: MUTED }}>
                  {label}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginTop: '2.5mm',
          paddingTop: '1.5mm',
          borderTop: `1px solid ${RULE}`,
          fontSize: '6.5pt',
          color: FAINT,
        }}
      >
        <span>{companyName} · Confidential — for internal management use</span>
        <span>
          Page {page} of {totalPages}
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Document                                                            */
/* ------------------------------------------------------------------ */

type SheetDescriptor =
  | { kind: 'summary'; page: number }
  | {
      kind: 'section';
      dim: Dimension;
      rows: BreakdownRow[];
      pageRows: BreakdownRow[];
      startIndex: number;
      part: number;
      parts: number;
      page: number;
    };

export default function SalesReportDocument({
  summary,
  fullRows,
  periodLabel,
  scope,
  activeView,
  metric,
  company,
  preparedBy,
  isOffline,
  syncedAt,
}: SalesReportDocumentProps) {
  const sections: Dimension[] =
    scope === 'full'
      ? DIMENSIONS
      : activeView === 'summary'
        ? []
        : [activeView as Dimension];

  const paginated = sections.map((dim) => {
    const rows = fullRows[dim] ?? summary.dimensions[dim].rows;
    return { dim, rows, pages: paginate(rows, ROWS_FIRST, ROWS_REST) };
  });

  const descriptors: SheetDescriptor[] = [{ kind: 'summary', page: 1 }];
  let running = 1;
  for (const s of paginated) {
    s.pages.forEach((pageRows, i) => {
      running += 1;
      descriptors.push({
        kind: 'section',
        dim: s.dim,
        rows: s.rows,
        pageRows,
        startIndex: i === 0 ? 0 : ROWS_FIRST + (i - 1) * ROWS_REST,
        part: i + 1,
        parts: s.pages.length,
        page: running,
      });
    });
  }
  const totalPages = running;

  const generatedAt = new Date().toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const reportRef = `${summary.period.start.replace(/-/g, '')}-${summary.period.end.replace(/-/g, '')}`;

  const sectionRevenue = (dim: Dimension) =>
    (fullRows[dim] ?? summary.dimensions[dim].rows).reduce((s, r) => s + r.revenue, 0);

  return (
    <div>
      {/* Self-contained page geometry: the document must print identically
          from the popup and from the in-page fallback, where globals.css
          would otherwise impose a 1.5cm margin and break the sheet height. */}
      <style>{`
        @page { size: A4 portrait; margin: 0; }
        .rpt-sheet { page-break-after: always; break-after: page; }
        .rpt-sheet:last-child { page-break-after: auto; break-after: auto; }
        @media print { .rpt-sheet { box-shadow: none !important; } }
      `}</style>
      {descriptors.map((d) => {
        if (d.kind === 'summary') {
          return (
            <section
              key="summary"
              className="rpt-sheet"
              style={sheetStyle}
            >
              <DocHeader company={company} periodLabel={periodLabel} reportRef={reportRef} />
              <MetaBand
                periodLabel={periodLabel}
                generatedAt={generatedAt}
                preparedBy={preparedBy}
                isOffline={isOffline}
                syncedAt={syncedAt}
              />
              <KpiStrip kpis={summary.kpis} />

              {/* A trend needs at least two points. For a single-month period a
                  one-bar "trend" is a spike, not information — the KPI strip
                  above already carries the month's figures. */}
              {summary.monthly.length > 1 && (
                <>
                  <SectionTitle
                    title="Revenue and gross profit by month"
                    note={`${summary.monthly.length} months with activity`}
                  />
                  <TrendBlock monthly={summary.monthly} />
                </>
              )}
              {summary.monthly.length === 0 && (
                <div style={{ fontSize: '8pt', color: FAINT, padding: '6mm 0' }}>No sales in this period.</div>
              )}

              <SectionTitle title="Revenue composition" note="Share of net revenue" />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3mm' }}>
                <CompositionBlock
                  title="By category"
                  rows={summary.dimensions.category.rows}
                  total={summary.kpis.revenue}
                  totalMembers={summary.dimensions.category.total}
                />
                <CompositionBlock
                  title="By brand"
                  rows={summary.dimensions.brand.rows}
                  total={summary.kpis.revenue}
                  totalMembers={summary.dimensions.brand.total}
                />
                <CompositionBlock
                  title="By product"
                  rows={summary.dimensions.product.rows}
                  total={summary.kpis.revenue}
                  totalMembers={summary.dimensions.product.total}
                />
                <CompositionBlock
                  title="By customer"
                  rows={summary.dimensions.customer.rows}
                  total={summary.kpis.revenue}
                  totalMembers={summary.dimensions.customer.total}
                />
              </div>

              <SheetFooter
                page={d.page}
                totalPages={totalPages}
                companyName={company.name}
                summary={summary}
                showSignatures
              />
            </section>
          );
        }

        const totalRevenue = sectionRevenue(d.dim);
        const isFirstPart = d.part === 1;
        const isLastPart = d.part === d.parts;
        const sectionTotal = {
          quantity: d.rows.reduce((s, r) => s + r.quantity, 0),
          revenue: totalRevenue,
          cost: d.rows.reduce((s, r) => s + r.cost, 0),
          profit: d.rows.reduce((s, r) => s + r.profit, 0),
        };

        return (
          <section
            key={`${d.dim}-${d.part}`}
            className="rpt-sheet"
            style={sheetStyle}
          >
            <DocHeader
              company={company}
              periodLabel={periodLabel}
              reportRef={reportRef}
              compact={!isFirstPart}
            />
            {isFirstPart && (
              <>
                <MetaBand
                  periodLabel={periodLabel}
                  generatedAt={generatedAt}
                  preparedBy={preparedBy}
                  isOffline={isOffline}
                  syncedAt={syncedAt}
                />
                <KpiStrip kpis={summary.kpis} />
              </>
            )}

            <SectionTitle
              title={`Revenue by ${DIMENSION_LABEL[d.dim].toLowerCase()}`}
              note={`${d.rows.length} ${DIMENSION_LABEL[d.dim].toLowerCase()}${d.rows.length === 1 ? '' : 's'} · ${isLastPart ? 'complete list' : `page ${d.part} of ${d.parts}`}`}
            />

            {isFirstPart && d.rows.length > 0 && (
              <PrintBars rows={d.rows} metric={metric} limit={10} />
            )}

            <DataTable
              rows={d.pageRows}
              startIndex={d.startIndex}
              sectionRevenue={totalRevenue}
              pageSubtotal={isLastPart ? sectionTotal : null}
            />

            {!isLastPart && (
              <div style={{ fontSize: '7pt', color: FAINT, marginTop: '2mm', fontStyle: 'italic' }}>
                Continued on page {d.page + 1}
              </div>
            )}

            <SheetFooter
              page={d.page}
              totalPages={totalPages}
              companyName={company.name}
              summary={summary}
              showSignatures={isLastPart}
            />
          </section>
        );
      })}
    </div>
  );
}

const sheetStyle: React.CSSProperties = {
  width: '210mm',
  height: '296mm',
  padding: '12mm',
  boxSizing: 'border-box',
  background: '#fff',
  color: INK,
  fontFamily: 'Arial, Helvetica, sans-serif',
  fontSize: '9pt',
  lineHeight: 1.35,
  display: 'flex',
  flexDirection: 'column',
  // No `overflow: hidden` on purpose: a sheet that runs 2mm long should spill
  // onto a visible extra page, never silently clip the last rows of a
  // financial table. Page breaks come from the `.rpt-sheet` rule, whose
  // `:last-child` override prevents a trailing blank page.
};
