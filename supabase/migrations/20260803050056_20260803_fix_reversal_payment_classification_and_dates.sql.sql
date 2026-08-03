/*
# Fix Reversal Payment Classification and Dates

## Problem 1: Mislabeled EDIT-* replacement payment
- EDIT-POS-00589874 was incorrectly tagged as `reversal_payment` instead of `paid_invoice_pay`.
- EDIT-* payments are replacement payments created when an invoice is edited, not reversals.
- The REV-* payments are the actual reversal records.

## Problem 2: Reversal payments inflate collection totals
- The Collection Report and Sales page queries filter by `payment_type = 'received'` and `is_reversed = false`.
- Some reversal payments (REV-*) have `payment_type = 'received'` and `is_reversed = false`, so they show up in collection totals.
- Reversal payments are not real collections — they are internal accounting entries from invoice edits/cancels.
- Fix: The frontend queries already exclude `is_reversed = true` records, but some REV-* reversal payments with `reference_type = 'invoice'` and `is_reversed = false` still slip through.
- We need to mark these as reversed so they don't appear in collection totals.

## Problem 3: Edit invoice uses CURRENT_DATE for replacement payments
- When editing an old invoice, the edit_invoice function creates replacement EDIT-* payments with `payment_date = CURRENT_DATE`.
- This makes old invoice payments appear in today's collection stats.
- Fix: Use the invoice's date (v_new_date) instead of CURRENT_DATE for replacement payments.

## Problem 4: Cancel invoice uses CURRENT_DATE for reversal payments
- Same issue — reversal payments get today's date instead of the invoice date.
- Fix: Use the invoice's date instead of CURRENT_DATE for reversal payment records.

## Changes
1. Update the mislabeled EDIT-POS-00589874 payment_for to 'paid_invoice_pay'.
2. Mark any non-reversed REV-* payments with reference_type='invoice' as is_reversed=true (they are reversal records, not real collections).
3. Recreate edit_invoice function to use v_new_date instead of CURRENT_DATE for replacement payment_date.
4. Recreate cancel_invoice function to use v_invoice.invoice_date instead of CURRENT_DATE for reversal payment_date.
*/

-- Fix 1: Correct the mislabeled EDIT-* payment
UPDATE payments 
SET payment_for = 'paid_invoice_pay' 
WHERE payment_number = 'EDIT-POS-00589874' 
  AND payment_for = 'reversal_payment';

-- Fix 2: Mark non-reversed REV-* reversal payments (with reference_type='invoice') as reversed
-- These are not real collections — they are internal reversal records that should not appear in collection totals
UPDATE payments 
SET is_reversed = true 
WHERE payment_for = 'reversal_payment' 
  AND payment_type = 'received' 
  AND reference_type = 'invoice' 
  AND is_reversed = false;

-- Fix 3: Recreate edit_invoice function with corrected payment dates
-- We need to get the full function definition and replace CURRENT_DATE with v_new_date
-- in the replacement payment INSERT statements only (not the reversal payment or journal entries)
DO $$
DECLARE
  v_func text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_func FROM pg_proc WHERE proname = 'edit_invoice';
  
  -- Replace CURRENT_DATE with v_new_date in the EDIT-* partial payment INSERT
  v_func := replace(v_func,
    'VALUES (''EDIT-'' || v_invoice.invoice_number, ''received'', v_new_payment_method, v_new_partial_amount, CURRENT_DATE, ''invoice'', p_invoice_id, v_invoice.invoice_number, ''Partial payment for edited invoice '' || v_invoice.invoice_number, ''paid_invoice_pay'')',
    'VALUES (''EDIT-'' || v_invoice.invoice_number, ''received'', v_new_payment_method, v_new_partial_amount, v_new_date, ''invoice'', p_invoice_id, v_invoice.invoice_number, ''Partial payment for edited invoice '' || v_invoice.invoice_number, ''paid_invoice_pay'')'
  );
  
  -- Replace CURRENT_DATE with v_new_date in the EDIT-* full payment INSERT
  v_func := replace(v_func,
    'VALUES (''EDIT-'' || v_invoice.invoice_number, ''received'', v_new_payment_method, v_new_total, CURRENT_DATE, ''invoice'', p_invoice_id, v_invoice.invoice_number, ''Payment for edited invoice '' || v_invoice.invoice_number, ''paid_invoice_pay'')',
    'VALUES (''EDIT-'' || v_invoice.invoice_number, ''received'', v_new_payment_method, v_new_total, v_new_date, ''invoice'', p_invoice_id, v_invoice.invoice_number, ''Payment for edited invoice '' || v_invoice.invoice_number, ''paid_invoice_pay'')'
  );
  
  -- Also fix the journal entry dates for the replacement payment JEs to use v_new_date
  v_func := replace(v_func,
    '''Payment - Invoice '' || v_invoice.invoice_number || '' EDITED'', CURRENT_DATE, ''payment'', v_new_payment_id,',
    '''Payment - Invoice '' || v_invoice.invoice_number || '' EDITED'', v_new_date, ''payment'', v_new_payment_id,'
  );
  
  EXECUTE v_func;
END $$;

-- Fix 4: Recreate cancel_invoice function with corrected reversal payment date
DO $$
DECLARE
  v_func text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_func FROM pg_proc WHERE proname = 'cancel_invoice';
  
  -- Replace CURRENT_DATE with v_invoice.invoice_date in the reversal payment INSERT
  -- The reversal payment INSERT uses: payment_date, is_reversed, payment_for,
  -- and the value CURRENT_DATE on the line before 'reversal_payment'
  v_func := replace(v_func,
    'v_payment.payment_method,
    CURRENT_DATE,
    ''reversal_payment'',',
    'v_payment.payment_method,
    COALESCE(v_invoice.invoice_date, CURRENT_DATE),
    ''reversal_payment'','
  );
  
  EXECUTE v_func;
END $$;
