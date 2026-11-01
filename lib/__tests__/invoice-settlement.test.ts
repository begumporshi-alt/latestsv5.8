import { getInvoiceSettlement } from '../invoice-settlement';

describe('getInvoiceSettlement', () => {
  it('reports nothing when the invoice carries no write-off', () => {
    const s = getInvoiceSettlement({
      status: 'paid',
      total_amount: 1000,
      amount_paid: 1000,
      bad_debt_amount: 0,
    });
    expect(s.isWrittenOff).toBe(false);
    expect(s.label).toBe('');
    expect(s.writtenOff).toBe(0);
  });

  it('does not treat a zero balance as a write-off', () => {
    // The 767 invoices that are simply fully paid must stay clean: the badge is
    // driven by bad_debt_amount, never by balance_due = 0.
    const s = getInvoiceSettlement({
      status: 'paid',
      total_amount: 1000,
      amount_paid: 1000,
      bad_debt_amount: null,
    });
    expect(s.isWrittenOff).toBe(false);
  });

  it('flags a partial write-off', () => {
    const s = getInvoiceSettlement({
      status: 'paid',
      total_amount: 1000,
      amount_paid: 900,
      bad_debt_amount: 100,
    });
    expect(s.isWrittenOff).toBe(true);
    expect(s.isFullyWrittenOff).toBe(false);
    expect(s.label).toBe('Written off');
    expect(s.writtenOff).toBe(100);
    expect(s.title).toContain('remainder was collected');
  });

  it('flags a full write-off with no cash collected', () => {
    const s = getInvoiceSettlement({
      status: 'paid',
      total_amount: 2648.23,
      amount_paid: 0,
      bad_debt_amount: 2648.23,
    });
    expect(s.isWrittenOff).toBe(true);
    expect(s.isFullyWrittenOff).toBe(true);
    expect(s.title).toContain('nothing was collected');
  });

  it('accepts numeric strings as returned by PostgREST', () => {
    const s = getInvoiceSettlement({
      status: 'paid',
      total_amount: '9378.79',
      amount_paid: '9000.00',
      bad_debt_amount: '378.79',
    });
    expect(s.isWrittenOff).toBe(true);
    expect(s.writtenOff).toBeCloseTo(378.79, 2);
  });

  it('ignores sub-paisa residues', () => {
    const s = getInvoiceSettlement({
      status: 'paid',
      total_amount: 100,
      amount_paid: 99.996,
      bad_debt_amount: 0.004,
    });
    expect(s.isWrittenOff).toBe(false);
  });

  it('stays silent for cancelled and draft invoices', () => {
    const base = { total_amount: 100, amount_paid: 0, bad_debt_amount: 100 };
    expect(getInvoiceSettlement({ ...base, status: 'cancelled' }).isWrittenOff).toBe(false);
    expect(getInvoiceSettlement({ ...base, status: 'draft' }).isWrittenOff).toBe(false);
  });

  it('tolerates a null invoice', () => {
    expect(getInvoiceSettlement(null).isWrittenOff).toBe(false);
    expect(getInvoiceSettlement(undefined).isWrittenOff).toBe(false);
  });
});
