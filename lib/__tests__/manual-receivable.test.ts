import { buildManualOutstandingMap, type ReceivableEntry } from '../manual-receivable';

const entry = (id: string, customer: string | null, debit: number): ReceivableEntry => ({
  id,
  customer_id: customer,
  total_debit: debit,
});

describe('buildManualOutstandingMap', () => {
  it('reports an untouched receivable in full', () => {
    const map = buildManualOutstandingMap([entry('e1', 'c1', 1500)], []);

    expect(map).toEqual({ c1: 1500 });
  });

  it('nets cash payments against the entry', () => {
    const map = buildManualOutstandingMap(
      [entry('e1', 'c1', 1500)],
      [{ reference_id: 'e1', amount: 500, bad_debt_amount: 0 }],
    );

    expect(map).toEqual({ c1: 1000 });
  });

  it('counts a bad-debt write-off as settlement', () => {
    // A written-off receivable is no longer collectable, so it must not appear
    // in the manual due the Collect Payment modal offers.
    const map = buildManualOutstandingMap(
      [entry('e1', 'c1', 800)],
      [{ reference_id: 'e1', amount: 300, bad_debt_amount: 500 }],
    );

    expect(map).toEqual({});
  });

  it('sums several open entries for one customer', () => {
    const map = buildManualOutstandingMap(
      [entry('e1', 'c1', 400), entry('e2', 'c1', 600), entry('e3', 'c2', 250)],
      [],
    );

    expect(map).toEqual({ c1: 1000, c2: 250 });
  });

  it('does not let an overpaid entry offset an underpaid one', () => {
    // processManualPayment walks entry remainders, so the collectable figure is
    // the positive one only. Offsetting would understate what can be collected.
    const map = buildManualOutstandingMap(
      [entry('e1', 'c1', 100), entry('e2', 'c1', 400)],
      [{ reference_id: 'e1', amount: 150, bad_debt_amount: 0 }],
    );

    expect(map).toEqual({ c1: 400 });
  });

  it('omits fully settled entries', () => {
    const map = buildManualOutstandingMap(
      [entry('e1', 'c1', 500)],
      [{ reference_id: 'e1', amount: 500, bad_debt_amount: 0 }],
    );

    expect(map).toEqual({});
  });

  it('ignores payments belonging to other reference types', () => {
    const map = buildManualOutstandingMap(
      [entry('e1', 'c1', 500)],
      [{ reference_id: 'invoice-1', amount: 500, bad_debt_amount: 0 }],
    );

    expect(map).toEqual({ c1: 500 });
  });

  it('skips entries with no customer and payments with no reference', () => {
    const map = buildManualOutstandingMap(
      [entry('e1', null, 500), entry('e2', 'c1', 200)],
      [{ reference_id: null, amount: 100, bad_debt_amount: 0 }],
    );

    expect(map).toEqual({ c1: 200 });
  });

  it('tolerates numeric strings from PostgREST', () => {
    const map = buildManualOutstandingMap(
      [{ id: 'e1', customer_id: 'c1', total_debit: '1500.00' }],
      [{ reference_id: 'e1', amount: '500.00', bad_debt_amount: null }],
    );

    expect(map).toEqual({ c1: 1000 });
  });

  it('rounds the per-customer total to paisa', () => {
    const map = buildManualOutstandingMap(
      [entry('e1', 'c1', 0.1), entry('e2', 'c1', 0.2)],
      [],
    );

    expect(map.c1).toBe(0.3);
  });
});
