import { buildPosSettlement, type PosOutstandingRow, type PosAdvanceRow } from '../pos-settlement';

const dues = (...amounts: number[]): PosOutstandingRow[] =>
  amounts.map((balance_due, i) => ({
    invoice_id: `inv-${i + 1}`,
    invoice_number: `INV-00${i + 1}`,
    balance_due,
  }));

const wallets = (...amounts: number[]): PosAdvanceRow[] =>
  amounts.map((balance, i) => ({
    advance_id: `adv-${i + 1}`,
    advance_number: `ADV-00000${i + 1}`,
    balance,
  }));

const base = {
  registered: true,
  grandTotal: 0,
  storeCredit: 0,
  tendered: 0,
  partialAmount: 0,
  paymentTerm: 'full' as const,
  dueCollectInput: 0,
  outstanding: [] as PosOutstandingRow[],
  advances: [] as PosAdvanceRow[],
  advanceBalance: 0,
};

describe('cash mode (unchanged behaviour)', () => {
  it('a full payment records the whole bill and no dues sweep without a request', () => {
    const s = buildPosSettlement({ ...base, mode: 'cash', grandTotal: 1000, tendered: 1000 });
    expect(s.cashToBill).toBe(1000);
    expect(s.invoiceAmountPaid).toBe(1000);
    expect(s.invoiceStatus).toBe('paid');
    expect(s.duesCleared).toBe(0);
    expect(s.change).toBe(0);
  });

  it('sweeps only the tendered EXCESS into older dues, oldest first', () => {
    const s = buildPosSettlement({
      ...base, mode: 'cash', grandTotal: 1200, tendered: 2000,
      dueCollectInput: 1000, outstanding: dues(3000),
    });
    // 2000 tendered - 1200 bill = 800 excess, capped by the request and the due
    expect(s.duesCleared).toBe(800);
    expect(s.duesAlloc).toEqual([{ invoice_id: 'inv-1', invoice_number: 'INV-001', amount: 800 }]);
    expect(s.invoiceAmountPaid).toBe(1200);
    expect(s.previousDueAfter).toBe(2200);
  });

  it('never sweeps more than the customer actually owes', () => {
    const s = buildPosSettlement({
      ...base, mode: 'cash', grandTotal: 1000, tendered: 5000,
      dueCollectInput: 5000, outstanding: dues(400, 500),
    });
    expect(s.duesCleared).toBe(900);
    expect(s.duesAlloc.map(a => a.amount)).toEqual([400, 500]);
  });

  it('keeps the legacy partial/credit arithmetic', () => {
    const partial = buildPosSettlement({
      ...base, mode: 'cash', paymentTerm: 'partial', grandTotal: 1000, partialAmount: 400,
    });
    expect(partial.cashToBill).toBe(400);
    expect(partial.invoiceAmountPaid).toBe(400);
    expect(partial.invoiceStatus).toBe('partially_paid');

    const credit = buildPosSettlement({ ...base, mode: 'cash', paymentTerm: 'credit', grandTotal: 1000 });
    expect(credit.cashToBill).toBe(0);
    expect(credit.invoiceAmountPaid).toBe(0);
    expect(credit.invoiceStatus).toBe('sent');
  });

  it('reduces what the till takes by the store credit redeemed', () => {
    const s = buildPosSettlement({ ...base, mode: 'cash', grandTotal: 1000, storeCredit: 300, tendered: 700 });
    expect(s.billNeeds).toBe(700);
    expect(s.cashToBill).toBe(700);
    expect(s.invoiceAmountPaid).toBe(1000);
  });
});

describe('dues_first mode', () => {
  it('clears old dues first and leaves the rest of this bill due', () => {
    const s = buildPosSettlement({
      ...base, mode: 'dues_first', grandTotal: 1200, tendered: 2000, outstanding: dues(3000),
    });
    expect(s.duesCleared).toBe(2000);
    expect(s.cashToBill).toBe(0);
    expect(s.invoiceAmountPaid).toBe(0);
    expect(s.invoiceStatus).toBe('sent');
    expect(s.previousDueAfter).toBe(1000);
    expect(s.change).toBe(0);
  });

  it('pays this bill with whatever is left after the oldest dues are settled', () => {
    const s = buildPosSettlement({
      ...base, mode: 'dues_first', grandTotal: 1200, tendered: 3000, outstanding: dues(1000, 500),
    });
    expect(s.duesCleared).toBe(1500);
    expect(s.duesAlloc.map(a => a.amount)).toEqual([1000, 500]);
    expect(s.cashToBill).toBe(1200);
    expect(s.invoicePaidTotal).toBe(1200);
    expect(s.invoiceStatus).toBe('paid');
    expect(s.change).toBe(300);
  });

  it('partially pays this bill when the cash runs out mid-way', () => {
    const s = buildPosSettlement({
      ...base, mode: 'dues_first', grandTotal: 1000, tendered: 800, outstanding: dues(500),
    });
    expect(s.duesCleared).toBe(500);
    expect(s.cashToBill).toBe(300);
    expect(s.invoiceStatus).toBe('partially_paid');
  });

  it('behaves like an ordinary cash sale when there are no dues', () => {
    const s = buildPosSettlement({ ...base, mode: 'dues_first', grandTotal: 900, tendered: 1000 });
    expect(s.duesCleared).toBe(0);
    expect(s.cashToBill).toBe(900);
    expect(s.invoiceStatus).toBe('paid');
    expect(s.change).toBe(100);
  });

  it('reduces the dues swept by the store credit used on this bill', () => {
    const s = buildPosSettlement({
      ...base, mode: 'dues_first', grandTotal: 1000, storeCredit: 400,
      tendered: 1600, outstanding: dues(2000),
    });
    // ৳1600 cash clears dues first; the bill still needs only ৳600 after credit
    expect(s.duesCleared).toBe(1600);
    expect(s.billNeeds).toBe(600);
    expect(s.cashToBill).toBe(0);
    // the store credit already credited ৳400 to this invoice, so ৳600 stays due
    expect(s.invoiceAmountPaid).toBe(400);
    expect(s.invoiceStatus).toBe('partially_paid');
  });
});

describe('advance_first mode', () => {
  it('pays the whole bill from the wallets and takes no cash', () => {
    const s = buildPosSettlement({
      ...base, mode: 'advance_first', grandTotal: 1200, tendered: 0,
      advances: wallets(5000), advanceBalance: 5000,
    });
    expect(s.advanceApplied).toBe(1200);
    expect(s.advanceAlloc).toEqual([{ advance_id: 'adv-1', advance_number: 'ADV-000001', amount: 1200 }]);
    expect(s.cashToBill).toBe(0);
    expect(s.invoiceAmountPaid).toBe(0);
    expect(s.invoiceStatus).toBe('sent');   // what the invoice insert writes
    expect(s.finalStatus).toBe('paid');     // what the advance application makes it
  });

  it('takes the wallets oldest-first and collects only the remainder in cash', () => {
    const s = buildPosSettlement({
      ...base, mode: 'advance_first', grandTotal: 1200, tendered: 500,
      advances: wallets(300, 400), advanceBalance: 700,
    });
    expect(s.advanceApplied).toBe(700);
    expect(s.advanceAlloc.map(a => a.amount)).toEqual([300, 400]);
    expect(s.cashToBill).toBe(500);
    expect(s.invoicePaidTotal).toBe(1200);
    expect(s.finalStatus).toBe('paid');
    expect(s.change).toBe(0);
  });

  it('leaves the shortfall due when neither wallet nor cash covers the bill', () => {
    const s = buildPosSettlement({
      ...base, mode: 'advance_first', grandTotal: 1000, tendered: 100,
      advances: wallets(300), advanceBalance: 300,
    });
    expect(s.advanceApplied).toBe(300);
    expect(s.cashToBill).toBe(100);
    expect(s.invoicePaidTotal).toBe(400);
    expect(s.invoiceStatus).toBe('partially_paid');
    expect(s.finalStatus).toBe('partially_paid');
  });

  it('never spends more than the wallets actually hold', () => {
    const s = buildPosSettlement({
      ...base, mode: 'advance_first', grandTotal: 1000, tendered: 0,
      advances: wallets(250), advanceBalance: 900,   // stale sum vs the real rows
    });
    expect(s.advanceApplied).toBe(250);
    expect(s.cashToBill).toBe(0);
    expect(s.finalStatus).toBe('partially_paid');
  });

  it('returns cash beyond what the bill needs as change', () => {
    const s = buildPosSettlement({
      ...base, mode: 'advance_first', grandTotal: 500, tendered: 800, advances: wallets(), advanceBalance: 0,
    });
    expect(s.cashToBill).toBe(500);
    expect(s.change).toBe(300);
  });
});

describe('walk-in customers', () => {
  it('falls back to cash mode and reports the mode it used', () => {
    const s = buildPosSettlement({
      ...base, registered: false, mode: 'dues_first', grandTotal: 500, tendered: 500,
      outstanding: dues(1000), advanceBalance: 0,
    });
    expect(s.mode).toBe('cash');
    expect(s.duesCleared).toBe(0);
    expect(s.cashToBill).toBe(500);
    expect(s.previousDueAfter).toBe(1000);
  });
});

