import { buildAdjustmentPlan, resolveDelta, isDebitNormalAccount } from '../balance-adjustment';

const plan = (overrides: Partial<Parameters<typeof buildAdjustmentPlan>[0]> = {}) =>
  buildAdjustmentPlan({
    accountType: 'asset',
    currentBalance: 1,
    mode: 'by',
    direction: 'increase',
    amount: 1500,
    ...overrides,
  });

describe('isDebitNormalAccount', () => {
  it('treats assets and expenses as debit-normal', () => {
    expect(isDebitNormalAccount('asset')).toBe(true);
    expect(isDebitNormalAccount('expense')).toBe(true);
  });

  it('treats liabilities, equity and revenue as credit-normal', () => {
    expect(isDebitNormalAccount('liability')).toBe(false);
    expect(isDebitNormalAccount('equity')).toBe(false);
    expect(isDebitNormalAccount('revenue')).toBe(false);
  });
});

describe('resolveDelta', () => {
  it('applies an increase as a positive delta', () => {
    expect(resolveDelta('by', 'increase', 500, 100)).toBe(500);
  });

  it('applies a decrease as a negative delta', () => {
    expect(resolveDelta('by', 'decrease', 500, 100)).toBe(-500);
  });

  it('derives the delta from a target balance', () => {
    expect(resolveDelta('to', 'increase', 1501, 1)).toBe(1500);
  });

  it('derives a negative delta when the target is below the current balance', () => {
    expect(resolveDelta('to', 'decrease', 600, 1000)).toBe(-400);
  });

  it('ignores the direction toggle in target mode', () => {
    // 'to' mode is authoritative: the target decides the direction.
    expect(resolveDelta('to', 'increase', 400, 1000)).toBe(-600);
    expect(resolveDelta('to', 'decrease', 400, 1000)).toBe(-600);
  });
});

describe('buildAdjustmentPlan', () => {
  it('debits a debit-normal account when increasing', () => {
    const p = plan({ accountType: 'asset', mode: 'by', direction: 'increase', amount: 1500 });

    expect(p.delta).toBe(1500);
    expect(p.magnitude).toBe(1500);
    expect(p.newBalance).toBe(1501);
    expect(p.direction).toBe('increase');
    expect(p.targetDebit).toBe(1500);
    expect(p.targetCredit).toBe(0);
    expect(p.offsetDebit).toBe(0);
    expect(p.offsetCredit).toBe(1500);
  });

  it('credits a debit-normal account when decreasing', () => {
    const p = plan({ accountType: 'asset', mode: 'by', direction: 'decrease', amount: 500 });

    expect(p.delta).toBe(-500);
    expect(p.targetDebit).toBe(0);
    expect(p.targetCredit).toBe(500);
    expect(p.offsetDebit).toBe(500);
    expect(p.offsetCredit).toBe(0);
  });

  it('credits a credit-normal account when increasing', () => {
    const p = plan({ accountType: 'liability', mode: 'by', direction: 'increase', amount: 800 });

    expect(p.direction).toBe('increase');
    expect(p.targetDebit).toBe(0);
    expect(p.targetCredit).toBe(800);
    expect(p.offsetDebit).toBe(800);
    expect(p.offsetCredit).toBe(0);
  });

  it('debits a credit-normal account when decreasing', () => {
    const p = plan({ accountType: 'revenue', mode: 'by', direction: 'decrease', amount: 250 });

    expect(p.delta).toBe(-250);
    expect(p.targetDebit).toBe(250);
    expect(p.targetCredit).toBe(0);
    expect(p.offsetDebit).toBe(0);
    expect(p.offsetCredit).toBe(250);
  });

  it('always keeps the two lines balanced', () => {
    const cases = [
      { accountType: 'asset', direction: 'increase' as const },
      { accountType: 'asset', direction: 'decrease' as const },
      { accountType: 'liability', direction: 'increase' as const },
      { accountType: 'liability', direction: 'decrease' as const },
      { accountType: 'equity', direction: 'increase' as const },
      { accountType: 'revenue', direction: 'decrease' as const },
      { accountType: 'expense', direction: 'increase' as const },
    ];

    for (const c of cases) {
      const p = plan({ accountType: c.accountType, direction: c.direction, amount: 123.45 });
      expect(p.targetDebit + p.offsetDebit).toBeCloseTo(p.targetCredit + p.offsetCredit, 2);
      expect(p.targetDebit + p.offsetDebit).toBeCloseTo(123.45, 2);
    }
  });

  it('treats a target equal to the current balance as a no-op', () => {
    const p = plan({ mode: 'to', amount: 1, currentBalance: 1 });

    expect(p.delta).toBe(0);
    expect(p.direction).toBeNull();
    expect(p.targetDebit).toBe(0);
    expect(p.targetCredit).toBe(0);
  });

  it('reports a target below the current balance as a decrease', () => {
    const p = plan({ mode: 'to', amount: 600, currentBalance: 1000 });

    expect(p.delta).toBe(-400);
    expect(p.direction).toBe('decrease');
    expect(p.newBalance).toBe(600);
  });

  it('allows a decrease that overshoots into a negative balance', () => {
    // The panel warns about this rather than blocking it: some contra-style
    // corrections are legitimate, but the figure must still be shown.
    const p = plan({ accountType: 'asset', mode: 'by', direction: 'decrease', amount: 500 });

    expect(p.newBalance).toBe(-499);
    expect(p.direction).toBe('decrease');
  });

  it('does not leak floating point noise into the new balance', () => {
    const p = plan({ mode: 'by', direction: 'increase', amount: 0.1, currentBalance: 0.2 });

    expect(p.newBalance).toBe(0.3);
  });

  it('survives a non-finite amount without producing NaN', () => {
    const p = plan({ amount: Number.NaN });

    expect(p.delta).toBe(0);
    expect(p.newBalance).toBe(1);
    expect(p.targetDebit).toBe(0);
    expect(p.targetCredit).toBe(0);
  });
});
