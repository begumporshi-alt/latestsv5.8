/*
# Add discount and reference columns to purchase orders

Adds columns to support per-line discounts, cart-level percentage discount,
extra flat discount, and a reference field on purchase orders — mirroring
the invoice/quotations schema so the PO form can match the invoice form.

## Changes to purchase_orders
- `cart_discount_percent` (numeric, default 0) — percentage discount on subtotal
- `extra_discount` (numeric, default 0) — flat amount discount
- `reference` (text, nullable) — reference person or PO reference

## Changes to purchase_order_items
- `discount_percent` (numeric, default 0) — per-line discount percentage

All additions are nullable/defaulted so existing data is unaffected.
*/

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS cart_discount_percent NUMERIC(5,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS extra_discount NUMERIC(15,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reference TEXT;

ALTER TABLE purchase_order_items
  ADD COLUMN IF NOT EXISTS discount_percent NUMERIC(5,2) DEFAULT 0;
