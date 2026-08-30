-- Drop the hardcoded CHECK constraint on payments.payment_method
-- Payment methods are now managed dynamically via the payment_methods table.
-- The constraint only allowed: cash, bank_transfer, bkash, nagad, rocket, sslcommerz, cheque, card, store_credit
-- This blocked custom bank methods like standard_bank_transfer, islami_bank_transfer, pubali_bank_transfer.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_payment_method_check;
