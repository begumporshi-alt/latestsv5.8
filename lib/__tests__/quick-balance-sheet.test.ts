import { buildQuickComparison, buildQuickSummary, type QuickLine } from '../quick-balance-sheet';

const rows = (values: Record<string, number | string>): QuickLine[] =>
  Object.entries(values).map(([line_key, balance]) => ({ line_key, balance }));

describe('buildQuickSummary', () => {
  it('reads the five live balances', () => {
    const summary = buildQuickSummary(
      rows({
        fixed_assets: 1,
        inventory: 11263279.39,
        receivables: 2849911.66,
        payables: 3294487.27,
        revenue: 10416295.02,
      })
    );

    expect(summary.fixedAssets).toBe(1);
    expect(summary.inventory).toBe(11263279.39);
    expect(summary.receivables).toBe(2849911.66);
    expect(summary.payables).toBe(3294487.27);
    expect(summary.revenue).toBe(10416295.02);
  });

  it('totals assets from the three asset accounts only', () => {
    const summary = buildQuickSummary(
      rows({ fixed_assets: 100, inventory: 200, receivables: 300, payables: 999, revenue: 999 })
    );

    expect(summary.totalAssets).toBe(600);
    expect(summary.totalLiabilities).toBe(999);
  });

  it('computes net position as assets less payables', () => {
    const summary = buildQuickSummary(rows({ fixed_assets: 100, inventory: 200, receivables: 300, payables: 250 }));

    expect(summary.netPosition).toBe(350);
  });

  it('reports a negative net position rather than clamping at zero', () => {
    const summary = buildQuickSummary(rows({ inventory: 100, payables: 400 }));

    expect(summary.netPosition).toBe(-300);
  });

  it('accepts numeric strings, which is how Postgres returns numeric', () => {
    const summary = buildQuickSummary(
      rows({ fixed_assets: '1', inventory: '11263279.39', receivables: '2849911.66', payables: '3294487.27' })
    );

    expect(summary.totalAssets).toBeCloseTo(14113192.05, 2);
    expect(summary.netPosition).toBeCloseTo(10818704.78, 2);
  });

  it('treats a missing line as zero instead of NaN', () => {
    const summary = buildQuickSummary(rows({ inventory: 500 }));

    expect(summary.fixedAssets).toBe(0);
    expect(summary.receivables).toBe(0);
    expect(summary.payables).toBe(0);
    expect(summary.totalAssets).toBe(500);
    expect(summary.netPosition).toBe(500);
  });

  it('treats unparseable balances as zero', () => {
    const summary = buildQuickSummary(rows({ inventory: 'not-a-number', receivables: 100 }));

    expect(summary.inventory).toBe(0);
    expect(summary.totalAssets).toBe(100);
  });

  it('returns all zeros for an empty result', () => {
    const summary = buildQuickSummary([]);

    expect(summary).toEqual({
      fixedAssets: 0,
      inventory: 0,
      receivables: 0,
      payables: 0,
      revenue: 0,
      totalAssets: 0,
      totalLiabilities: 0,
      netPosition: 0,
    });
  });

  it('does not leak floating point noise into the totals', () => {
    const summary = buildQuickSummary(rows({ fixed_assets: 0.1, inventory: 0.2, receivables: 0 }));

    expect(summary.totalAssets).toBeCloseTo(0.3, 10);
  });
});

describe('buildQuickComparison', () => {
  // Real figures from the live database for 9 Oct 2026 (opening) and
  // 20 Oct 2026 (closing) — the 10–20 Oct window.
  const opening = rows({
    fixed_assets: 0,
    inventory: '10292134.81052',
    receivables: '3136118.1122',
    payables: '3236304.9400',
    revenue: '8024890.53691',
  });

  const closing = rows({
    fixed_assets: 0,
    inventory: '11440855.72052',
    receivables: '2426211.15874',
    payables: '3249364.2900',
    revenue: '8972398.37465',
  });

  it('reports both snapshots unchanged', () => {
    const comparison = buildQuickComparison(opening, closing);

    expect(comparison.opening.inventory).toBeCloseTo(10292134.81, 2);
    expect(comparison.closing.inventory).toBeCloseTo(11440855.72, 2);
  });

  it('computes the movement for each line', () => {
    const comparison = buildQuickComparison(opening, closing);

    expect(comparison.change.inventory).toBeCloseTo(1148720.91, 2);
    expect(comparison.change.payables).toBeCloseTo(13059.35, 2);
    expect(comparison.change.receivables).toBeCloseTo(-709906.95, 2);
    expect(comparison.change.revenue).toBeCloseTo(947507.84, 2);
    expect(comparison.change.fixedAssets).toBe(0);
  });

  it('derives revenue change as the period figure, not a running total', () => {
    const comparison = buildQuickComparison(opening, closing);

    // The closing revenue is ~8.97m cumulative; the window earned 947,507.84.
    expect(comparison.closing.revenue).toBeGreaterThan(8000000);
    expect(comparison.change.revenue).toBeCloseTo(947507.84, 2);
  });

  it('keeps the change subtotals consistent with their components', () => {
    const comparison = buildQuickComparison(opening, closing);

    expect(comparison.change.totalAssets).toBeCloseTo(
      comparison.change.fixedAssets + comparison.change.inventory + comparison.change.receivables,
      2
    );
    expect(comparison.change.netPosition).toBeCloseTo(
      comparison.change.totalAssets - comparison.change.payables,
      2
    );
  });

  it('matches the difference of the two totals', () => {
    const comparison = buildQuickComparison(opening, closing);

    expect(comparison.change.netPosition).toBeCloseTo(
      comparison.closing.netPosition - comparison.opening.netPosition,
      2
    );
  });

  it('flags a window with no postings', () => {
    const comparison = buildQuickComparison(opening, opening);

    expect(comparison.hasMovement).toBe(false);
    expect(comparison.change.netPosition).toBe(0);
  });

  it('flags a window with movement', () => {
    expect(buildQuickComparison(opening, closing).hasMovement).toBe(true);
  });

  it('treats a line missing from one side as zero on that side', () => {
    const comparison = buildQuickComparison(rows({ inventory: 100 }), rows({ inventory: 250, payables: 40 }));

    expect(comparison.opening.payables).toBe(0);
    expect(comparison.change.inventory).toBe(150);
    expect(comparison.change.payables).toBe(40);
  });

  it('returns zeros for two empty snapshots', () => {
    const comparison = buildQuickComparison([], []);

    expect(comparison.hasMovement).toBe(false);
    expect(comparison.closing).toEqual(comparison.opening);
  });

  it('does not let float noise register as movement', () => {
    const comparison = buildQuickComparison(rows({ inventory: 100.1 }), rows({ inventory: 100.1 }));

    expect(comparison.hasMovement).toBe(false);
  });
});
