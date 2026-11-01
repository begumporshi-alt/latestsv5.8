import { planDeliveryItemSync } from '../delivery-item-sync';

describe('planDeliveryItemSync', () => {
  test('create copies the invoice lines', () => {
    expect(planDeliveryItemSync({ isEdit: false, invoiceId: 'inv-1', existingRowCount: 0 })).toBe('insert');
  });

  test('a re-save with the same link leaves the rows alone (no duplication)', () => {
    expect(
      planDeliveryItemSync({ isEdit: true, invoiceId: 'inv-1', previousInvoiceId: 'inv-1', existingRowCount: 22 }),
    ).toBe('skip');
  });

  test('changing the linked invoice replaces the rows', () => {
    expect(
      planDeliveryItemSync({ isEdit: true, invoiceId: 'inv-2', previousInvoiceId: 'inv-1', existingRowCount: 22 }),
    ).toBe('replace');
  });

  test('linking an invoice to a delivery that had none inserts', () => {
    expect(
      planDeliveryItemSync({ isEdit: true, invoiceId: 'inv-1', previousInvoiceId: null, existingRowCount: 0 }),
    ).toBe('insert');
  });

  test('a challan with no rows is backfilled even when the link is unchanged', () => {
    expect(
      planDeliveryItemSync({ isEdit: true, invoiceId: 'inv-1', previousInvoiceId: 'inv-1', existingRowCount: 0 }),
    ).toBe('insert');
  });

  test('no linked invoice means no rows to copy', () => {
    expect(planDeliveryItemSync({ isEdit: false, invoiceId: null, existingRowCount: 0 })).toBe('skip');
    expect(planDeliveryItemSync({ isEdit: true, invoiceId: '', previousInvoiceId: 'inv-1', existingRowCount: 5 })).toBe('skip');
  });

  test('an empty previous id is treated as no link', () => {
    expect(
      planDeliveryItemSync({ isEdit: true, invoiceId: 'inv-1', previousInvoiceId: undefined, existingRowCount: 3 }),
    ).toBe('replace');
  });
});
