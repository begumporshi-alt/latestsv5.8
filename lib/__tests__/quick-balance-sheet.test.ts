import {
  buildQuickStatement,
  type StatementRow,
  type StatementSection,
} from '../quick-balance-sheet';

const row = (
  section: StatementSection,
  code: string,
  label: string,
  balance: number | string
): StatementRow => ({ section, code, label, balance });

/** The live chart at 2026-11-04, trimmed to what the page actually renders. */
const liveRows: StatementRow[] = [
  row('asset', '1004', 'Fixed Assets', 1),
  row('asset', '1200', 'Inventory', '11257763.33'),
  row('asset', '1100', 'Accounts Receivable', '2905177.76'),
  row('liability', '2000', 'Accounts Payable', '3309584.27'),
  row('revenue', '4000', 'Sales Revenue', '10470430.62'),
  row('revenue', '4001', 'Sales Revenue — Manual (no COGS)', '836883.00'),
  row('revenue', '4020', 'Shipping Income', '12845.21'),
  row('expense', '4050', 'Sales Returns & Allowances', '49294.40'),
  row('expense', '5000', 'Cost of Goods Sold', '9225828.58'),
  row('expense', '5100', 'Salaries & Wages', '182030.00'),
  row('expense', '5200', 'Rent Expense', '33000.00'),
  row('expense', '5300', 'Utilities', '37000.00'),
  row('expense', '5500', 'Transport & Delivery', '24350.00'),
  row('expense', '5600', 'Bad Debt Expense', '6701.29'),
  row('expense', '5900', 'Inventory Adjustment', '33450.00'),
  row('expense', '6000', 'Operating Expenses', '56198.00'),
  row('expense', '6327', 'Nasta And Lunch', '36333.00'),
  // Inactive but still carrying a balance: excluding it would stop the total
  // reconciling to the chart.
  row('expense', '6331', 'Hubaib', '1000.00'),
  row('expense', '6676', 'Investment in', '222965.00'),
  row('expense', '6760', 'return expense', '1920.00'),
];

describe('buildQuickStatement — single snapshot', () => {
  // Same rows twice is how the page renders "as of a date": no change column.
  const statement = buildQuickStatement(liveRows, liveRows);

  it('splits the rows into the four sections', () => {
    expect(statement.assets).toHaveLength(3);
    expect(statement.liabilities).toHaveLength(1);
    expect(statement.revenues).toHaveLength(3);
    expect(statement.expenses).toHaveLength(13);
  });

  it('totals assets', () => {
    expect(statement.totalAssets.closing).toBeCloseTo(14162942.09, 2);
  });

  it('totals every revenue account, not just 4000', () => {
    // 4000 alone would be 10,470,430.62; 4001 and 4020 add 849,728.21.
    expect(statement.totalRevenue.closing).toBeCloseTo(11320158.83, 2);
  });

  it('totals expenses across all expense accounts', () => {
    expect(statement.totalExpenses.closing).toBeCloseTo(9910070.27, 2);
  });

  it('derives net position as assets less liabilities', () => {
    expect(statement.netPosition.closing).toBeCloseTo(10853357.82, 2);
  });

  it('derives net profit as revenue less expenses', () => {
    expect(statement.netProfit.closing).toBeCloseTo(1410088.56, 2);
  });

  it('reports no movement when both snapshots are the same', () => {
    expect(statement.hasMovement).toBe(false);
    expect(statement.netProfit.change).toBe(0);
  });

  it('reports every change as zero in single-date mode', () => {
    const allZero = [
      ...statement.assets,
      ...statement.liabilities,
      ...statement.revenues,
      ...statement.expenses,
    ].every(line => line.change === 0);

    expect(allZero).toBe(true);
  });

  it('orders lines by account code', () => {
    expect(statement.expenses.map(line => line.code)).toEqual([
      '4050', '5000', '5100', '5200', '5300', '5500',
      '5600', '5900', '6000', '6327', '6331', '6676', '6760',
    ]);
  });

  it('knows the chart has income accounts', () => {
    expect(statement.hasIncome).toBe(true);
  });
});

describe('buildQuickStatement — window', () => {
  const opening = [
    row('asset', '1200', 'Inventory', 1000),
    row('liability', '2000', 'Accounts Payable', 400),
    row('revenue', '4000', 'Sales Revenue', 5000),
    row('expense', '5000', 'Cost of Goods Sold', 3000),
  ];
  const closing = [
    row('asset', '1200', 'Inventory', 1200),
    row('liability', '2000', 'Accounts Payable', 450),
    row('revenue', '4000', 'Sales Revenue', 5600),
    row('expense', '5000', 'Cost of Goods Sold', 3200),
  ];

  it('computes opening, closing and change per line', () => {
    const statement = buildQuickStatement(opening, closing);
    const inventory = statement.assets[0];

    expect(inventory.opening).toBe(1000);
    expect(inventory.closing).toBe(1200);
    expect(inventory.change).toBe(200);
  });

  it('computes the period revenue and expense movement', () => {
    const statement = buildQuickStatement(opening, closing);

    expect(statement.totalRevenue.change).toBe(600);
    expect(statement.totalExpenses.change).toBe(200);
    expect(statement.netProfit.change).toBe(400);
  });

  it('carries an account that exists only at the end', () => {
    const statement = buildQuickStatement(
      [row('expense', '5100', 'Salaries & Wages', 0)],
      [row('expense', '5100', 'Salaries & Wages', 0), row('expense', '5200', 'Rent Expense', 900)]
    );

    expect(statement.expenses).toHaveLength(2);
    const rent = statement.expenses.find(line => line.code === '5200')!;
    expect(rent.opening).toBe(0);
    expect(rent.closing).toBe(900);
    expect(rent.change).toBe(900);
  });

  it('keeps an account that disappeared from the closing chart', () => {
    const statement = buildQuickStatement(
      [row('revenue', '4020', 'Shipping Income', 500)],
      [row('revenue', '4000', 'Sales Revenue', 100)]
    );

    const shipping = statement.revenues.find(line => line.code === '4020')!;
    expect(shipping.opening).toBe(500);
    expect(shipping.closing).toBe(0);
    expect(shipping.change).toBe(-500);
  });

  it('flags movement when anything changed', () => {
    expect(buildQuickStatement(opening, closing).hasMovement).toBe(true);
  });

  it('does not treat float noise as movement', () => {
    const statement = buildQuickStatement(
      [row('asset', '1200', 'Inventory', 100.1)],
      [row('asset', '1200', 'Inventory', 100.1)]
    );

    expect(statement.hasMovement).toBe(false);
  });
});

describe('buildQuickStatement — robustness', () => {
  it('ignores rows from an unknown section', () => {
    const rows = [
      row('asset', '1004', 'Fixed Assets', 10),
      row('equity' as StatementSection, '3900', 'Equity', 99),
    ];
    const statement = buildQuickStatement(rows, rows);

    expect(statement.assets).toHaveLength(1);
    expect(statement.totalAssets.closing).toBe(10);
  });

  it('coerces numeric strings, which is how Postgres returns numeric', () => {
    const rows = [row('asset', '1200', 'Inventory', '1234.56')];

    expect(buildQuickStatement(rows, rows).totalAssets.closing).toBe(1234.56);
  });

  it('treats an unparseable balance as zero', () => {
    const rows = [
      row('asset', '1200', 'Inventory', 'not-a-number'),
      row('asset', '1100', 'AR', 100),
    ];

    expect(buildQuickStatement(rows, rows).totalAssets.closing).toBe(100);
  });

  it('returns zeros and no income for an empty result', () => {
    const statement = buildQuickStatement([], []);

    expect(statement.assets).toEqual([]);
    expect(statement.totalAssets).toEqual({ opening: 0, closing: 0, change: 0 });
    expect(statement.netProfit).toEqual({ opening: 0, closing: 0, change: 0 });
    expect(statement.hasIncome).toBe(false);
    expect(statement.hasMovement).toBe(false);
  });

  it('reports a net loss without clamping it at zero', () => {
    const rows = [
      row('revenue', '4000', 'Sales Revenue', 100),
      row('expense', '5000', 'COGS', 400),
    ];

    expect(buildQuickStatement(rows, rows).netProfit.closing).toBe(-300);
  });

  it('keeps each subtotal equal to the sum of its printed lines', () => {
    const statement = buildQuickStatement(liveRows, liveRows);
    const sumOf = (lines: Array<{ closing: number }>) =>
      Math.round(lines.reduce((total, line) => total + line.closing, 0) * 100) / 100;

    expect(statement.totalAssets.closing).toBe(sumOf(statement.assets));
    expect(statement.totalRevenue.closing).toBe(sumOf(statement.revenues));
    expect(statement.totalExpenses.closing).toBe(sumOf(statement.expenses));
  });

  it('rounds every amount to currency precision', () => {
    const statement = buildQuickStatement(
      [row('asset', '1200', 'Inventory', '10.004')],
      [row('asset', '1200', 'Inventory', '10.126')]
    );

    expect(statement.assets[0].opening).toBe(10);
    expect(statement.assets[0].closing).toBe(10.13);
    expect(statement.assets[0].change).toBe(0.13);
  });
});
