/*
# Split invoice_payment into outstanding_invoice_pay and paid_invoice_pay

## Logic
- If payment_date == invoice_date, the payment was made at invoice creation time → paid_invoice_pay
- If payment_date > invoice_date, the payment was made later for an outstanding invoice → outstanding_invoice_pay
*/

UPDATE payments p
SET payment_for = 'paid_invoice_pay'
FROM invoices i
WHERE p.reference_type = 'invoice'
  AND p.reference_id = i.id
  AND p.payment_for = 'invoice_payment'
  AND p.payment_date = i.invoice_date;

UPDATE payments p
SET payment_for = 'outstanding_invoice_pay'
FROM invoices i
WHERE p.reference_type = 'invoice'
  AND p.reference_id = i.id
  AND p.payment_for = 'invoice_payment'
  AND p.payment_date > i.invoice_date;

-- Any remaining invoice_payment (payment_date < invoice_date or no matching invoice) → outstanding
UPDATE payments SET payment_for = 'outstanding_invoice_pay'
WHERE payment_for = 'invoice_payment';