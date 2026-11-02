import {
  buildAllocationPlan,
  buildCollectRequest,
  isWriteOffOnly,
  type CollectInvoice,
} from '../collect-payment';

function inv(id: string, balanceDue: number, total = balanceDue, paid = 0): CollectInvoice {
  return {
    id,
    invoice_number: id.toUpperCase(),
    balance_due: balanceDue,
    total_amount: total,
    amount_paid: paid,
  };
}

describe('buildAllocationPlan', () => {
  it('settles an invoice by write-off alone when no cash is received', () => {
    const plan = buildAllocationPlan([inv('a', 500)], {}, 500);

    expect(plan.rows).toEqual([{ invoice_id: 'a', amount: 0, bad_debt_amount: 500 }]);
    expect(plan.cashAllocated).toBe(0);
    expect(plan.badDebtAllocated).toBe(500);
    expect(plan.badDebtUnapplied).toBe(0);
  });

  it('spreads a write-off across invoices oldest first', () => {
    const plan = buildAllocationPlan([inv('a', 300), inv('b', 200)], {}, 500);

    expect(plan.rows).toEqual([
      { invoice_id: 'a', amount: 0, bad_debt_amount: 300 },
      { invoice_id: 'b', amount: 0, bad_debt_amount: 200 },
    ]);
    expect(plan.badDebtAllocated).toBe(500);
    expect(plan.badDebtUnapplied).toBe(0);
  });

  it('reports the part of a write-off that has no balance to absorb it', () => {
    // The old code dropped this silently and the toast still claimed ৳700.
    const plan = buildAllocationPlan([inv('a', 300), inv('b', 200)], {}, 700);

    expect(plan.badDebtAllocated).toBe(500);
    expect(plan.badDebtUnapplied).toBe(200);
  });

  it('applies cash first and the write-off to the remainder of the same invoice', () => {
    const plan = buildAllocationPlan([inv('a', 1200)], { a: 1000 }, 200);

    expect(plan.rows).toEqual([{ invoice_id: 'a', amount: 1000, bad_debt_amount: 200 }]);
    expect(plan.cashAllocated).toBe(1000);
    expect(plan.badDebtAllocated).toBe(200);
  });

  it('pushes the write-off to the next invoice when cash clears the first', () => {
    const plan = buildAllocationPlan([inv('a', 1000), inv('b', 500)], { a: 1000 }, 300);

    expect(plan.rows).toEqual([
      { invoice_id: 'a', amount: 1000, bad_debt_amount: 0 },
      { invoice_id: 'b', amount: 0, bad_debt_amount: 300 },
    ]);
  });

  it('does not write off against an over-allocated invoice', () => {
    const plan = buildAllocationPlan([inv('a', 100), inv('b', 400)], { a: 150 }, 200);

    expect(plan.rows).toEqual([
      { invoice_id: 'a', amount: 150, bad_debt_amount: 0 },
      { invoice_id: 'b', amount: 0, bad_debt_amount: 200 },
    ]);
  });

  it('skips invoices that receive neither cash nor write-off', () => {
    const plan = buildAllocationPlan([inv('a', 0), inv('b', 250)], { a: 0 }, 100);

    expect(plan.rows).toEqual([{ invoice_id: 'b', amount: 0, bad_debt_amount: 100 }]);
  });

  it('leaves a cash-only collection unchanged', () => {
    const plan = buildAllocationPlan([inv('a', 800)], { a: 800 }, 0);

    expect(plan.rows).toEqual([{ invoice_id: 'a', amount: 800, bad_debt_amount: 0 }]);
    expect(plan.badDebtAllocated).toBe(0);
    expect(plan.badDebtUnapplied).toBe(0);
  });

  it('rounds to paisa and treats sub-paisa residue as zero', () => {
    const plan = buildAllocationPlan([inv('a', 100)], {}, 99.999);

    expect(plan.rows[0].bad_debt_amount).toBe(100);
    expect(plan.badDebtUnapplied).toBe(0);
  });

  it('tolerates empty invoice lists and negative write-offs', () => {
    expect(buildAllocationPlan([], {}, 500).rows).toEqual([]);

    const plan = buildAllocationPlan([inv('a', 100)], {}, -50);
    expect(plan.badDebtAllocated).toBe(0);
    expect(plan.badDebtUnapplied).toBe(0);
  });
});

describe('buildCollectRequest', () => {
  const base = {
    customerId: 'cust-1',
    paymentDate: '2026-11-02',
    paymentMethod: 'cash',
    allocations: [{ invoice_id: 'a', amount: 0, bad_debt_amount: 500 }],
    overpayment: 0,
    routeOverpayment: false,
  };

  it('carries the chosen cash/bank account through to the RPC', () => {
    const request = buildCollectRequest({ ...base, accountId: 'acct-1022' });

    expect(request.p_account_id).toBe('acct-1022');
  });

  it('sends NULL when no account is selected so routing falls back to the method', () => {
    expect(buildCollectRequest({ ...base, accountId: '' }).p_account_id).toBeNull();
    expect(buildCollectRequest(base).p_account_id).toBeNull();
  });

  it('normalises empty reference and notes to NULL', () => {
    const request = buildCollectRequest({ ...base, referenceNumber: '', notes: '' });

    expect(request.p_reference_number).toBeNull();
    expect(request.p_notes).toBeNull();
  });

  it('accepts an allocation that is write-off only', () => {
    const request = buildCollectRequest(base);

    expect(request.p_allocations).toHaveLength(1);
    expect(request.p_allocations[0].amount).toBe(0);
    expect(request.p_allocations[0].bad_debt_amount).toBe(500);
  });

  it('rounds the overpayment to paisa', () => {
    expect(buildCollectRequest({ ...base, overpayment: 10.005 }).p_overpayment).toBe(10.01);
  });
});

describe('isWriteOffOnly', () => {
  it('is true only when no cash moves', () => {
    expect(isWriteOffOnly(0)).toBe(true);
    expect(isWriteOffOnly(0.004)).toBe(true);
    expect(isWriteOffOnly(0.01)).toBe(false);
    expect(isWriteOffOnly(500)).toBe(false);
  });
});
