'use client';

/**
 * One "where the revenue comes from" block for the Summary tab.
 *
 * All four blocks (category, brand, product, customer) read from the single
 * summary payload — no extra request, and because the server allocates the
 * cart discount pro-rata, each donut sums to the same headline revenue.
 *
 * A small count of members is rolled into an explicit "Others" slice so the
 * shares add to 100% instead of silently omitting the tail.
 */

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { formatAmount, getCurrencyFormat } from '@/lib/format';
import { compositionSlices, type BreakdownRow } from '@/lib/reports/sales-report';

const PALETTE = ['#1e3a6e', '#3f6f9e', '#6f9ac4', '#9dbcd9', '#c3d5e6', '#8fb0d4'];

export default function RevenueCompositionCard({
  title,
  subtitle,
  rows,
  total,
  totalMembers,
  onOpen,
}: {
  title: string;
  subtitle: string;
  rows: BreakdownRow[];
  total: number;
  totalMembers?: number;
  onOpen?: () => void;
}) {
  const data = compositionSlices(rows, 5, total, totalMembers);
  const symbol = getCurrencyFormat().symbol;

  return (
    <div className="bg-white rounded-xl border border-border p-5 shadow-sm flex flex-col">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
        </div>
        {onOpen && (
          <button
            onClick={onOpen}
            className="text-xs text-blue-600 hover:underline whitespace-nowrap"
          >
            View all
          </button>
        )}
      </div>

      {data.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground py-8">
          No sales in this period
        </div>
      ) : (
        <div className="flex items-center gap-3 flex-1">
          <div className="shrink-0" style={{ width: 132, height: 132 }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={data}
                  dataKey="revenue"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius={38}
                  outerRadius={62}
                  paddingAngle={2}
                  isAnimationActive={false}
                >
                  {data.map((_, i) => (
                    <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ fontSize: 11, borderRadius: 8, border: '1px solid #e2e8f0' }}
                  formatter={(v: number, _n, item) => [
                    `${symbol}${formatAmount(v)}`,
                    (item?.payload as { name?: string } | undefined)?.name ?? '',
                  ]}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>

          <div className="flex-1 min-w-0 space-y-1.5">
            {data.map((d, i) => (
              <div key={`${d.name}-${i}`} className="flex items-center gap-2">
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: PALETTE[i % PALETTE.length] }}
                />
                <span
                  className={`text-xs truncate flex-1 ${d.others ? 'text-muted-foreground italic' : 'text-muted-foreground'}`}
                >
                  {d.name}
                </span>
                <span className="text-xs font-medium text-foreground tabular-nums">
                  {d.share.toFixed(1)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
