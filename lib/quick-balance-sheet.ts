export interface QuickLine {
  line_key: string;
  balance: number | string;
}

export interface QuickSummary {
  fixedAssets: number;
  inventory: number;
  receivables: number;
  payables: number;
  revenue: number;
  totalAssets: number;
  totalLiabilities: number;
  /** Assets less liabilities. Not an accounting equation — see the page note. */
  netPosition: number;
}

const num = (value: number | string | undefined): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Fold the five RPC lines into the figures the page displays.
 *
 * Postgres returns `numeric` as a string, so every value is coerced here rather
 * than at each call site. A missing line is treated as zero: the RPC always
 * returns five rows, but if an account is ever deleted or renamed the page
 * should degrade to 0 rather than NaN.
 */
export function buildQuickSummary(rows: QuickLine[]): QuickSummary {
  const byKey = new Map(rows.map(row => [row.line_key, num(row.balance)]));
  const at = (key: string) => byKey.get(key) ?? 0;

  const fixedAssets = at('fixed_assets');
  const inventory = at('inventory');
  const receivables = at('receivables');
  const payables = at('payables');
  const revenue = at('revenue');

  const totalAssets = fixedAssets + inventory + receivables;

  return {
    fixedAssets,
    inventory,
    receivables,
    payables,
    revenue,
    totalAssets,
    totalLiabilities: payables,
    netPosition: totalAssets - payables,
  };
}

export interface QuickComparisonLine {
  lineKey: string;
  opening: number;
  closing: number;
  /** closing − opening. */
  change: number;
}

export interface QuickComparison {
  opening: QuickSummary;
  closing: QuickSummary;
  /** The movement over the window, summarised the same way as either end. */
  change: QuickSummary;
  /** False when all five lines are flat — lets the page say so instead of
   *  drawing five rows of zeroes with no explanation. */
  hasMovement: boolean;
}

const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

/**
 * Compare two as-of snapshots — the day before the window opened, and its last
 * day — into opening / closing / change.
 *
 * Why three columns instead of one "range" figure: four of these five accounts
 * are balance-sheet lines, which are *stocks* — a position at one instant. There
 * is no such thing as "inventory between 10 and 20 Oct", only what it was at the
 * start, what it was at the end, and the movement between. Sales revenue is the
 * one *flow* line, and for it the change column is the natural reading (revenue
 * earned in the window) rather than a running total since inception.
 *
 * Deltas are derived per line and then folded through buildQuickSummary, so the
 * change column obeys the same subtotal arithmetic as the two snapshots — a
 * total computed from raw differences could drift a cent from the sum of its
 * parts.
 */
export function buildQuickComparison(openRows: QuickLine[], closeRows: QuickLine[]): QuickComparison {
  const opening = buildQuickSummary(openRows);
  const closing = buildQuickSummary(closeRows);

  const openByKey = new Map(openRows.map(row => [row.line_key, num(row.balance)]));
  const closeByKey = new Map(closeRows.map(row => [row.line_key, num(row.balance)]));

  const keys = new Set([...openByKey.keys(), ...closeByKey.keys()]);
  const deltaRows: QuickLine[] = [...keys].map(key => ({
    line_key: key,
    balance: round2((closeByKey.get(key) ?? 0) - (openByKey.get(key) ?? 0)),
  }));

  const change = buildQuickSummary(deltaRows);

  return {
    opening,
    closing,
    change,
    hasMovement: deltaRows.some(row => Math.abs(num(row.balance)) >= 0.005),
  };
}
