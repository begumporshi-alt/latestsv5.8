/*
# Add payment_for to edit_invoice payment inserts

The edit_invoice function creates three types of payments without payment_for:
1. REV-* reversal payments → should be 'reversal_payment'
2. EDIT-* partial payment → should be 'paid_invoice_pay'
3. EDIT-* full payment → should be 'paid_invoice_pay'
*/

-- We need to update the edit_invoice function. Since we can't easily do a partial
-- replacement, we'll use a targeted approach: update the three INSERT statements
-- to include payment_for column.

-- First, let's update existing EDIT-* and REV-* payments that have NULL payment_for
-- (already done in previous migration, but just in case)
UPDATE payments SET payment_for = 'reversal_payment'
WHERE payment_for IS NULL AND payment_number LIKE 'REV-%';

UPDATE payments SET payment_for = 'paid_invoice_pay'
WHERE payment_for IS NULL AND payment_number LIKE 'EDIT-%';

-- Now recreate the edit_invoice function with payment_for on all INSERTs
-- We'll read the current function and modify it
DO $$
DECLARE
  v_func text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_func FROM pg_proc WHERE proname = 'edit_invoice';

  -- Add payment_for to the REV-* reversal payment INSERT
  v_func := replace(v_func,
    'INSERT INTO payments (payment_number, payment_type, payment_method, amount, payment_date, reference_type, reference_id, reference_number, notes)
VALUES (''REV-'' || COALESCE(v_payment.payment_number, ''PAY''), CASE WHEN v_payment.payment_type = ''received'' THEN ''refund'' ELSE ''payment'' END, v_payment.payment_method, v_payment.amount, CURRENT_DATE, ''invoice_edit'', p_invoice_id, v_invoice.invoice_number, ''Reversal payment for edited invoice '' || v_invoice.invoice_number)',
    'INSERT INTO payments (payment_number, payment_type, payment_method, amount, payment_date, reference_type, reference_id, reference_number, notes, payment_for)
VALUES (''REV-'' || COALESCE(v_payment.payment_number, ''PAY''), CASE WHEN v_payment.payment_type = ''received'' THEN ''refund'' ELSE ''payment'' END, v_payment.payment_method, v_payment.amount, CURRENT_DATE, ''invoice_edit'', p_invoice_id, v_invoice.invoice_number, ''Reversal payment for edited invoice '' || v_invoice.invoice_number, ''reversal_payment'')'
  );

  -- Add payment_for to the EDIT-* partial payment INSERT
  v_func := replace(v_func,
    'INSERT INTO payments (payment_number, payment_type, payment_method, amount, payment_date, reference_type, reference_id, reference_number, notes)
VALUES (''EDIT-'' || v_invoice.invoice_number, ''received'', v_new_payment_method, v_new_partial_amount, CURRENT_DATE, ''invoice'', p_invoice_id, v_invoice.invoice_number, ''Partial payment for edited invoice '' || v_invoice.invoice_number)',
    'INSERT INTO payments (payment_number, payment_type, payment_method, amount, payment_date, reference_type, reference_id, reference_number, notes, payment_for)
VALUES (''EDIT-'' || v_invoice.invoice_number, ''received'', v_new_payment_method, v_new_partial_amount, CURRENT_DATE, ''invoice'', p_invoice_id, v_invoice.invoice_number, ''Partial payment for edited invoice '' || v_invoice.invoice_number, ''paid_invoice_pay'')'
  );

  -- Add payment_for to the EDIT-* full payment INSERT
  v_func := replace(v_func,
    'INSERT INTO payments (payment_number, payment_type, payment_method, amount, payment_date, reference_type, reference_id, reference_number, notes)
VALUES (''EDIT-'' || v_invoice.invoice_number, ''received'', v_new_payment_method, v_new_total, CURRENT_DATE, ''invoice'', p_invoice_id, v_invoice.invoice_number, ''Payment for edited invoice '' || v_invoice.invoice_number)',
    'INSERT INTO payments (payment_number, payment_type, payment_method, amount, payment_date, reference_type, reference_id, reference_number, notes, payment_for)
VALUES (''EDIT-'' || v_invoice.invoice_number, ''received'', v_new_payment_method, v_new_total, CURRENT_DATE, ''invoice'', p_invoice_id, v_invoice.invoice_number, ''Payment for edited invoice '' || v_invoice.invoice_number, ''paid_invoice_pay'')'
  );

  -- Execute the modified function definition
  EXECUTE v_func;
END $$;