export type StatementSection = 'asset' | 'liability' | 'revenue' | 'expense';

const SECTIONS: StatementSection[] = ['asset', 'liability', 'revenue', 'expense'];

export interface StatementRow {
  section: string;
  code: string;
  label: string;
  balance: number | string;
}

/** A single amount, or the same amount at both ends of a window. */
export interface LineAmounts {
  opening: number;
  closing: number;
  change: number;
}

export interface StatementLine extends LineAmounts {
  section: StatementSection;
  code: string;
  label: string;
}

export interface QuickStatement {
  assets: StatementLine[];
  liabilities: StatementLine[];
  revenues: StatementLine[];
  expenses: StatementLine[];
  totalAssets: LineAmounts;
  totalLiabilities: LineAmounts;
  totalRevenue: LineAmounts;
  totalExpenses: LineAmounts;
  /** Assets − liabilities. A balance-sheet reading, not an accounting equation. */
  netPosition: LineAmounts;
  /** Revenue − expenses, over the same accounts the statement lists. */
  netProfit: LineAmounts;
  /** False when nothing moved in the window — lets the page say so. */
  hasMovement: boolean;
  /** False when the chart has no revenue or expense account at all. */
  hasIncome: boolean;
}

const num = (value: number | string | undefined): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

const isSection = (value: string): value is StatementSection =>
  (SECTIONS as string[]).includes(value);

/** Natural order for account codes: '0999' < '1004' < '10000'. */
const byCode = (a: { code: string }, b: { code: string }): number =>
  a.code.localeCompare(b.code, undefined, { numeric: true });

const sum = (lines: StatementLine[], key: keyof LineAmounts): number =>
  round2(lines.reduce((total, line) => total + line[key], 0));

const totalsOf = (lines: StatementLine[]): LineAmounts => ({
  opening: sum(lines, 'opening'),
  closing: sum(lines, 'closing'),
  change: sum(lines, 'change'),
});

const subtract = (a: LineAmounts, b: LineAmounts): LineAmounts => ({
  opening: round2(a.opening - b.opening),
  closing: round2(a.closing - b.closing),
  change: round2(a.change - b.change),
});

const EMPTY: LineAmounts = { opening: 0, closing: 0, change: 0 };

/**
 * Fold two as-of snapshots of get_quick_statement() into one statement.
 *
 * The statement is built as a comparison even in single-date mode — call it with
 * the same rows twice and every change is zero, which the page simply does not
 * render. One model, one renderer, no second code path to keep in step.
 *
 * Lines are matched across the two snapshots by section + code, not by position:
 * an account that was zero at the start and carries a balance at the end exists
 * on one side only, and its whole closing balance is the movement.
 *
 * Everything is rounded to 2dp before totalling, so a subtotal always equals the
 * sum of the rows printed above it. Summing the raw numeric columns instead
 * would let a displayed total disagree with the displayed lines by a cent.
 */
export function buildQuickStatement(
  openRows: StatementRow[],
  closeRows: StatementRow[]
): QuickStatement {
  const opening = new Map<string, { row: StatementRow; amount: number }>();
  const closing = new Map<string, { row: StatementRow; amount: number }>();

  for (const row of openRows) {
    if (!isSection(row.section)) continue;
    opening.set(`${row.section}:${row.code}`, { row, amount: round2(num(row.balance)) });
  }
  for (const row of closeRows) {
    if (!isSection(row.section)) continue;
    closing.set(`${row.section}:${row.code}`, { row, amount: round2(num(row.balance)) });
  }

  const keys = new Set([...opening.keys(), ...closing.keys()]);
  const lines: StatementLine[] = [];

  for (const key of keys) {
    const open = opening.get(key);
    const close = closing.get(key);
    // Prefer the closing side for the label: it is the current chart of accounts.
    const source = close?.row ?? open!.row;
    const openingAmount = open?.amount ?? 0;
    const closingAmount = close?.amount ?? 0;

    lines.push({
      section: source.section as StatementSection,
      code: source.code,
      label: source.label,
      opening: openingAmount,
      closing: closingAmount,
      change: round2(closingAmount - openingAmount),
    });
  }

  const of = (section: StatementSection) =>
    lines.filter(line => line.section === section).sort(byCode);

  const assets = of('asset');
  const liabilities = of('liability');
  const revenues = of('revenue');
  const expenses = of('expense');

  const totalAssets = assets.length ? totalsOf(assets) : EMPTY;
  const totalLiabilities = liabilities.length ? totalsOf(liabilities) : EMPTY;
  const totalRevenue = revenues.length ? totalsOf(revenues) : EMPTY;
  const totalExpenses = expenses.length ? totalsOf(expenses) : EMPTY;

  return {
    assets,
    liabilities,
    revenues,
    expenses,
    totalAssets,
    totalLiabilities,
    totalRevenue,
    totalExpenses,
    netPosition: subtract(totalAssets, totalLiabilities),
    netProfit: subtract(totalRevenue, totalExpenses),
    hasMovement: lines.some(line => Math.abs(line.change) >= 0.005),
    hasIncome: revenues.length > 0 || expenses.length > 0,
  };
}
