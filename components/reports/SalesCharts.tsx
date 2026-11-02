'use client';

/**
 * Screen charts for the dimension tabs.
 *
 * Chart type is matched to the dimension rather than applied uniformly:
 *   product / customer — horizontal bars (names are long; a category axis
 *                        would clip them), with a Pareto line for customers
 *                        because concentration is the question being asked.
 *   brand / category   — donut plus a ranked list, because the question is
 *                        mix, not ranking.
 *
 * Animation is off everywhere: an animated bar is mid-transition when a
 * screenshot or a print capture happens, which is how charts end up blank in
 * exported documents.
 */

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatAmount, formatAxisCurrency, getCurrencyFormat } from '@/lib/format';
import type { BreakdownRow } from '@/lib/reports/sales-report';
import type { ChartMetric } from '@/lib/reports/sales-report-store';

const NAVY = '#1e3a6e';
const SOFT = '#8fb0d4';
const PALETTE = ['#1e3a6e', '#3f6f9e', '#6f9ac4', '#9dbcd9', '#c3d5e6', '#8fb0d4', '#5f8ab5', '#b7c9da'];

const tooltipStyle = { fontSize: 11, borderRadius: 8, border: '1px solid #e2e8f0' };

function metricOf(row: BreakdownRow, metric: ChartMetric): number {
  if (metric === 'profit') return row.profit;
  if (metric === 'quantity') return row.quantity;
  return row.revenue;
}

/**
 * The dimension's true total for the active metric.
 *
 * Charts must divide by this, never by the sum of the rows they happen to be
 * drawing: the top-N cut means "sum of shown" is a subset, and a donut that
 * divides by it will claim 100% of revenue while showing 10 of 85 customers.
 */
export function dimensionTotal(rows: BreakdownRow[], metric: ChartMetric): number {
  return rows.reduce((s, r) => s + metricOf(r, metric), 0);
}

function formatValue(v: number, metric: ChartMetric): string {
  if (metric === 'quantity') return Math.round(v).toLocaleString('en-US');
  return `${getCurrencyFormat().symbol}${formatAmount(v)}`;
}

function axisFormatter(metric: ChartMetric) {
  if (metric === 'quantity') return (v: number) => Math.round(v).toLocaleString('en-US');
  return (v: number) => formatAxisCurrency(v);
}

export interface ChartDatum {
  name: string;
  value: number;
  raw: BreakdownRow;
}

export function toChartData(rows: BreakdownRow[], metric: ChartMetric, limit: number): ChartDatum[] {
  return rows
    .slice()
    .sort((a, b) => metricOf(b, metric) - metricOf(a, metric))
    .slice(0, limit)
    .map((r) => ({ name: r.name, value: metricOf(r, metric), raw: r }));
}

/* ------------------------------------------------------------------ */

export function HorizontalBarChart({
  data,
  metric,
  height = 320,
  color = NAVY,
}: {
  data: ChartDatum[];
  metric: ChartMetric;
  height?: number;
  color?: string;
}) {
  if (data.length === 0) return <EmptyChart height={height} />;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 20, bottom: 4, left: 4 }} barCategoryGap={6}>
        <CartesianGrid horizontal={false} stroke="#f1f5f9" />
        <XAxis
          type="number"
          tickFormatter={axisFormatter(metric)}
          tick={{ fontSize: 10.5, fill: '#64748b' }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          type="category"
          dataKey="name"
          width={240}
          tick={{ fontSize: 10.5, fill: '#475569' }}
          axisLine={false}
          tickLine={false}
          // Truncate to a length that fits on ONE line. Recharts wraps a tick
          // that overflows its axis width, and the wrapped second line is then
          // clipped by the chart's top/bottom margin.
          tickFormatter={(v: string) => (v.length > 29 ? `${v.slice(0, 28)}…` : v)}
        />
        <Tooltip
          cursor={{ fill: 'rgba(30,58,110,0.04)' }}
          contentStyle={tooltipStyle}
          formatter={(v: number) => [formatValue(v, metric), '']}
        />
        <Bar dataKey="value" fill={color} radius={[0, 3, 3, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function DonutChart({
  data,
  metric,
  height = 320,
  totalValue,
  totalMembers,
}: {
  data: ChartDatum[];
  metric: ChartMetric;
  height?: number;
  /** Whole-dimension total for the metric; defaults to the sum of `data`. */
  totalValue?: number;
  /** Members not represented by a slice, used to label the remainder. */
  totalMembers?: number;
}) {
  if (data.length === 0) return <EmptyChart height={height} />;

  const shown = data.reduce((s, d) => s + d.value, 0);
  const grand = Math.max(totalValue ?? shown, shown);
  const remainder = Math.max(grand - shown, 0);
  const share = (v: number) => (grand > 0 ? (v / grand) * 100 : 0);
  // A real but tiny slice must not print as "0.0%" — that reads as zero.
  const shareLabel = (v: number) => {
    const p = share(v);
    return p > 0 && p < 0.05 ? '<0.1' : p.toFixed(1);
  };

  const slices: { name: string; value: number; others?: boolean }[] = [
    ...data.map((d) => ({ name: d.name, value: d.value })),
    ...(remainder > 0.5
      ? [{ name: totalMembers ? `Others (${totalMembers})` : 'Others', value: remainder, others: true }]
      : []),
  ];
  const colorAt = (i: number, others?: boolean) =>
    others ? '#cbd5e1' : PALETTE[i % PALETTE.length];

  return (
    <div className="flex flex-col sm:flex-row items-center gap-6" style={{ minHeight: height }}>
      <div className="shrink-0" style={{ width: 240, height: 240 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius={62}
              outerRadius={104}
              paddingAngle={2}
              isAnimationActive={false}
            >
              {slices.map((s, i) => (
                <Cell key={i} fill={colorAt(i, s.others)} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(v: number, _n, item) => [
                `${formatValue(v, metric)} · ${shareLabel(v)}%`,
                (item?.payload as { name?: string } | undefined)?.name ?? '',
              ]}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="flex-1 w-full grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1.5 content-center">
        {slices.map((d, i) => (
          <div key={`${d.name}-${i}`} className="flex items-center gap-2 min-w-0">
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: colorAt(i, d.others) }}
            />
            <span
              className={`text-xs truncate flex-1 ${d.others ? 'italic text-muted-foreground' : 'text-muted-foreground'}`}
            >
              {d.name}
            </span>
            <span className="text-xs font-semibold text-foreground tabular-nums">
              {formatValue(d.value, metric)}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums w-12 text-right">
              {shareLabel(d.value)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Pareto: bars by revenue with a cumulative-share line.
 * The 80% reference is what makes customer concentration legible at a glance.
 */
export function ParetoChart({
  data,
  metric,
  height = 340,
  totalValue,
}: {
  data: ChartDatum[];
  metric: ChartMetric;
  height?: number;
  /** Whole-dimension total; the line then ends below 100% when a tail exists. */
  totalValue?: number;
}) {
  if (data.length === 0) return <EmptyChart height={height} />;

  const shown = data.reduce((s, d) => s + d.value, 0);
  const total = Math.max(totalValue ?? shown, shown);
  let running = 0;
  const series = data.map((d) => {
    running += d.value;
    return { ...d, cumulative: total > 0 ? (running / total) * 100 : 0 };
  });

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={series} margin={{ top: 8, right: 8, bottom: 8, left: 4 }}>
        <CartesianGrid vertical={false} stroke="#f1f5f9" />
        <XAxis
          dataKey="name"
          tick={{ fontSize: 10.5, fill: '#64748b' }}
          axisLine={false}
          tickLine={false}
          angle={-30}
          textAnchor="end"
          height={78}
          interval={0}
          tickFormatter={(v: string) => (v.length > 16 ? `${v.slice(0, 15)}…` : v)}
        />
        <YAxis
          yAxisId="left"
          width={82}
          tickFormatter={axisFormatter(metric)}
          tick={{ fontSize: 10.5, fill: '#64748b' }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          yAxisId="right"
          orientation="right"
          width={46}
          domain={[0, 100]}
          tickFormatter={(v: number) => `${v}%`}
          tick={{ fontSize: 10.5, fill: '#64748b' }}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip
          contentStyle={tooltipStyle}
          formatter={(v: number, key) =>
            key === 'cumulative' ? [`${v.toFixed(1)}%`, 'Cumulative'] : [formatValue(v, metric), 'Value']
          }
        />
        <Bar yAxisId="left" dataKey="value" fill={SOFT} radius={[3, 3, 0, 0]} isAnimationActive={false} />
        <Line
          yAxisId="right"
          type="monotone"
          dataKey="cumulative"
          stroke={NAVY}
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function EmptyChart({ height }: { height: number }) {
  return (
    <div
      className="flex items-center justify-center text-sm text-muted-foreground"
      style={{ height }}
    >
      No data for this period
    </div>
  );
}
