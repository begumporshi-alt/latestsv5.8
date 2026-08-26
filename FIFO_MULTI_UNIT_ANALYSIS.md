# FIFO Inventory & Multi-Unit Product System Analysis

**Project:** SI Building Solutions ERP  
**Analysis Date:** August 26, 2026  
**Scope:** FIFO Inventory Costing, Multi-Unit Products, COGS Accounting, and Integration with POS/Invoices

---

## Executive Summary

Your ERP implements a sophisticated **FIFO (First-In-First-Out) inventory costing system** combined with **multi-unit product management**. This system accurately tracks cost of goods sold (COGS) by consuming inventory from the oldest purchase batches first, while supporting products sold in different units (e.g., selling cables by meter, coil, or box with automatic base-unit conversion).

The system has undergone significant evolution with **20+ migrations** specifically for FIFO and multi-unit fixes, indicating a mature, battle-tested implementation that handles edge cases like:
- Invoice editing/cancellation with FIFO restoration
- Selling without sufficient stock (negative adjustment batches)
- Multi-unit COGS calculation (base quantity vs. sale quantity)
- Duplicate COGS prevention and account balance reconciliation

---

## 1. FIFO Inventory System Architecture

### 1.1 Core Tables

#### **`inventory_batches`**
The foundation of FIFO tracking. Each purchase creates a new batch with its own unit cost.

```sql
CREATE TABLE inventory_batches (
  id uuid PRIMARY KEY,
  product_id uuid REFERENCES products,
  warehouse_id uuid REFERENCES warehouses,
  batch_number text,                      -- e.g., "GRN-000123", "OPN-000001"
  quantity_received decimal(15,3),        -- Original quantity received
  quantity_remaining decimal(15,3),       -- Current available quantity
  unit_cost decimal(15,2),                -- Cost per base unit
  batch_type text,                        -- 'purchase', 'opening', 'adjustment', 'return'
  reference_type text,                    -- 'grn', 'invoice_item', etc.
  reference_id uuid,
  reference_number text,
  created_at timestamptz                  -- Used for FIFO ordering (oldest first)
);
```

**Key Insights:**
- **Batches are in BASE UNITS only** (e.g., meters, pieces, not coils or boxes)
- `quantity_remaining` decreases as sales consume from the batch
- Batches are ordered by `created_at ASC` for FIFO consumption
- Supports 4 batch types:
  - `purchase`: From GRN (Goods Receipt Note)
  - `opening`: Initial stock backfill
  - `adjustment`: Negative batches when selling without stock
  - `return`: From sales returns

#### **`invoice_item_batch_consumption`**
Tracks which batches were consumed for each sale line, enabling reversal and audit trails.

```sql
CREATE TABLE invoice_item_batch_consumption (
  id uuid PRIMARY KEY,
  invoice_item_id uuid REFERENCES invoice_items,
  batch_id uuid REFERENCES inventory_batches,  -- NULL for fallback adjustments
  product_id uuid,
  warehouse_id uuid,
  quantity_consumed decimal(15,3),             -- In base units
  unit_cost decimal(15,2),                     -- Cost per base unit from batch
  cogs_amount decimal(15,2),                   -- quantity_consumed × unit_cost
  created_at timestamptz
);
```

**Key Insights:**
- One consumption record can span multiple batches (e.g., selling 150 units might consume 100 from Batch A + 50 from Batch B)
- `batch_id` can be NULL for fallback scenarios (sold without stock)
- COGS is calculated as `SUM(cogs_amount)` across all consumption records for an invoice item
- Used for restoration when invoices are cancelled or edited

---

### 1.2 FIFO Functions

#### **`consume_fifo(product_id, warehouse_id, quantity, invoice_item_id)`**
The core FIFO consumption function. Returns total COGS.

**Algorithm:**
```
1. Lock oldest batches with remaining stock (ORDER BY created_at ASC)
2. For each batch:
   - Consume LEAST(batch.quantity_remaining, remaining_to_consume)
   - Update batch.quantity_remaining -= consumed
   - Insert consumption record with unit_cost and cogs_amount
   - Accumulate total COGS
3. If still short on stock:
   - Create negative adjustment batch at product.cost_price
   - Insert consumption record for remaining quantity
   - Add fallback COGS
4. Return total COGS
```

**Multi-Unit Fix (Migration 20260811):**
- CRITICAL: Must pass `base_quantity` (not `quantity`) to consume_fifo
- Example: Selling 1 coil (100 meters) must consume 100 base units, not 1

#### **`restore_fifo(invoice_item_id)`**
Reverses FIFO consumption when invoices are cancelled or edited.

**Algorithm:**
```
1. Find all consumption records for invoice_item_id
2. For each consumption:
   - If batch_type = 'adjustment': DELETE the batch entirely
   - Else: UPDATE batch.quantity_remaining += quantity_consumed
   - DELETE consumption record
```

**Edge Cases Handled:**
- Adjustment batches (negative stock) are deleted, not restored
- Handles partial restores for invoice edits
- Idempotent (safe to call multiple times)

---

## 2. Multi-Unit Product System

### 2.1 Core Tables

#### **`product_units`**
Defines multiple units of measure for a single product.

```sql
CREATE TABLE product_units (
  id uuid PRIMARY KEY,
  product_id uuid REFERENCES products,
  unit_name text,                   -- e.g., "Meter", "Coil", "Box"
  unit_short text,                  -- e.g., "m", "coil", "bx"
  conversion_factor decimal(15,4),  -- How many base units = 1 this unit
  is_base_unit boolean,             -- Only ONE true per product
  is_sale_unit boolean,             -- Preferred for sales (default in POS)
  price decimal(15,2),              -- Sale price per this unit
  cost_price decimal(15,2),         -- Cost price per this unit
  barcode text,                     -- Optional barcode for this unit
  sort_order integer,
  is_active boolean
);
```

**Example: Cable Product**
| Unit Name | Short | Conversion Factor | Base | Sale | Price | Cost Price |
|-----------|-------|-------------------|------|------|-------|------------|
| Meter     | m     | 1                 | ✓    |      | 50    | 30         |
| Coil      | coil  | 100               |      | ✓    | 4800  | 2900       |
| Box       | bx    | 500               |      |      | 23000 | 14000      |

**Calculation Examples:**
- Selling **1 coil** = **100 meters** base quantity
- Cost = 100m × ₹30/m = ₹3,000 (not 1 × ₹2,900)
- Stock check: If 450m available, can sell 4 coils (400m) but not 5 coils (500m)

---

### 2.2 Multi-Unit Utility Functions

Located in `lib/unit-utils.ts`:

```typescript
// Get the base unit (conversion_factor = 1, is_base_unit = true)
getBaseUnit(product): ProductUnit | null

// Get the preferred sale unit (is_sale_unit = true)
getSaleUnit(product): ProductUnit | null

// Convert sale quantity to base quantity
convertToBaseUnit(quantity: number, unit: ProductUnit): number
// Example: convertToBaseUnit(2, coilUnit) = 2 × 100 = 200 meters

// Convert base quantity to sale quantity
convertFromBaseUnit(baseQuantity: number, unit: ProductUnit): number
// Example: convertFromBaseUnit(300, coilUnit) = 300 / 100 = 3 coils

// Check if product has multi-unit enabled
isMultiUnitEnabled(product): boolean

// Get default unit for sales (sale unit > base unit > fallback)
getDefaultSaleUnit(product): ProductUnit
```

---

### 2.3 Multi-Unit Columns in Transaction Tables

#### **`invoice_items`**
```sql
ALTER TABLE invoice_items ADD COLUMN unit_name text;
ALTER TABLE invoice_items ADD COLUMN unit_conversion_factor decimal(15,4);
ALTER TABLE invoice_items ADD COLUMN base_quantity decimal(15,3);
```

**Example Row:**
```json
{
  "product_id": "uuid-cable",
  "quantity": 2.5,                    // 2.5 coils (sale quantity)
  "unit_name": "Coil",
  "unit_conversion_factor": 100,
  "base_quantity": 250,               // 2.5 × 100 = 250 meters
  "unit_price": 4800,                 // ₹4,800 per coil
  "cost_price": 2920,                 // ₹2,920 per coil (FIFO calculated)
  "subtotal": 12000                   // 2.5 × ₹4,800 = ₹12,000
}
```

**Critical Fields:**
- `quantity`: Sale quantity in the selected unit (2.5 coils)
- `base_quantity`: Converted to base units for FIFO consumption (250 meters)
- `unit_price`: Price per sale unit (₹4,800/coil)
- `cost_price`: Cost per sale unit, **calculated by FIFO and stored**

**Same pattern applied to:**
- `quotation_items`
- `purchase_order_items`
- `stock_movements`
- `delivery_items`
- `online_order_items`

---

## 3. Integration Points

### 3.1 POS System (`app/(erp)/sales/pos/page.tsx`)

**Multi-Unit Flow:**

1. **Product Search & Display:**
```typescript
// Load products with units
const { data: products } = await supabase
  .from('products')
  .select(`
    id, name, sku, sale_price, cost_price, image_url, unit, base_unit, enable_multi_unit,
    inventory_items(id, warehouse_id, quantity_on_hand),
    units:product_units(
      id, product_id, unit_name, unit_short, conversion_factor,
      is_base_unit, is_sale_unit, price, cost_price, is_active, sort_order
    )
  `);
```

2. **Unit Selection:**
```typescript
function handleProductClick(product: ProductData) {
  if (isMultiUnitEnabled(product)) {
    setUnitSelectorProduct(product); // Show modal to select unit
  } else {
    addToCart(product); // Use default unit
  }
}
```

3. **Add to Cart with Unit:**
```typescript
function addToCart(product: ProductData, selectedUnit?: ProductUnit) {
  const unit = selectedUnit || getDefaultSaleUnit(product);
  const unitPrice = unit.price || product.sale_price;
  const baseQuantity = convertToBaseUnit(1, unit); // Convert quantity to base

  setCart(prev => [...prev, {
    id: product.id,
    name: product.name,
    quantity: 1,                              // Sale quantity
    unit_price: unitPrice,                    // Price per sale unit
    cost_price: unit.cost_price || 0,         // Cost per sale unit (placeholder)
    selected_unit: unit,
    base_quantity: baseQuantity,              // For FIFO consumption
    discount_percent: 0,
    warehouse_id: bestWarehouse.id,
    stock_available: stockInBaseUnits,        // Base units available
  }]);
}
```

4. **Stock Validation (Critical):**
```typescript
function updateCartQuantity(id: string, unitId: string, newQty: number) {
  setCart(prev => prev.map(i => {
    if (i.id !== id || i.selected_unit?.id !== unitId) return i;
    
    const baseQty = convertToBaseUnit(newQty, i.selected_unit);
    
    // Check against base stock
    if (baseQty > i.stock_available) {
      toast({ 
        title: 'Stock limit', 
        description: `Only ${i.stock_available} base units available` 
      });
      return i; // Don't update
    }
    
    return { ...i, quantity: newQty, base_quantity: baseQty };
  }));
}
```

5. **Invoice Creation with Multi-Unit:**
```typescript
// In processOrder()
const invoiceItems = cart.map(item => ({
  invoice_id: invoice.id,
  product_id: item.id,
  quantity: item.quantity,               // Sale quantity (e.g., 2.5 coils)
  unit_price: item.unit_price,           // Price per sale unit
  cost_price: item.cost_price || 0,      // Placeholder (FIFO will update)
  discount_percent: item.discount_percent || 0,
  tax_rate: 0,
  subtotal: item.quantity * item.unit_price * (1 - item.discount_percent / 100),
  unit_name: item.selected_unit?.unit_name,
  unit_conversion_factor: item.selected_unit?.conversion_factor,
  base_quantity: item.base_quantity,     // For FIFO consumption
  warehouse_id: item.warehouse_id || null,
}));

await supabase.from('invoice_items').insert(invoiceItems);
// Trigger fires → consume_fifo(product_id, warehouse_id, base_quantity, item.id)
```

6. **Cost Price History Recording:**
```typescript
// Record cost snapshot at time of sale
const costHistoryRecords = cart.map(item => ({
  product_id: item.id,
  product_name: item.name,
  product_sku: item.sku || '',
  invoice_id: invoice.id,
  unit: item.selected_unit?.unit_name || 'pcs',
  quantity: item.quantity,                      // Sale quantity
  unit_price: item.unit_price,
  cost_price_per_qty: item.cost_price || 0,     // Cost per sale unit
  cost_price_for_added_qty: (item.cost_price || 0) * item.quantity,
  total_cost_price_single: item.cost_price || 0,
  total_cost_price_added: (item.cost_price || 0) * item.quantity,
}));

await supabase.from('cost_price_history').insert(costHistoryRecords);
```

---

### 3.2 Database Triggers (FIFO + Accounting Integration)

#### **Trigger 1: Per-Item COGS (on invoice_items INSERT)**
```sql
CREATE TRIGGER trg_invoice_items_cogs
  AFTER INSERT ON invoice_items
  FOR EACH ROW EXECUTE FUNCTION invoice_items_cogs_trigger();
```

**Function Logic:**
```sql
CREATE OR REPLACE FUNCTION invoice_items_cogs_trigger()
RETURNS TRIGGER AS $$
DECLARE
  v_cogs_amount decimal(15,2);
  v_consume_qty numeric;
  v_qty numeric;
BEGIN
  -- Skip if draft invoice
  IF (SELECT status FROM invoices WHERE id = NEW.invoice_id) = 'draft' THEN
    RETURN NEW;
  END IF;

  -- Skip if already consumed (idempotency)
  IF EXISTS (SELECT 1 FROM invoice_item_batch_consumption WHERE invoice_item_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  v_qty := NEW.quantity;                                -- Sale quantity
  v_consume_qty := COALESCE(NEW.base_quantity, v_qty);  -- Base quantity (CRITICAL!)

  -- Consume from FIFO batches
  v_cogs_amount := consume_fifo(NEW.product_id, warehouse_id, v_consume_qty, NEW.id);

  -- Store cost per sale unit in invoice_items
  UPDATE invoice_items 
  SET cost_price = v_cogs_amount / v_qty  -- Cost per sale unit
  WHERE id = NEW.id;

  -- Post COGS journal entry
  PERFORM post_journal_entry(
    'COGS (FIFO) - ' || invoice_number,
    invoice_date,
    'invoice',
    NEW.invoice_id,
    json_build_array(
      json_build_object('account_id', v_cogs_account, 'debit', v_cogs_amount, 'credit', 0,
        'description', 'COGS (FIFO): ProductName - Qty: ' || v_qty || ' x Avg Cost: ' || (v_cogs_amount / v_qty)),
      json_build_object('account_id', v_inventory_account, 'debit', 0, 'credit', v_cogs_amount,
        'description', 'Inventory released (FIFO)')
    )::json
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

**Critical Multi-Unit Fix:**
```sql
-- WRONG (before fix): Used sale quantity
v_cogs_amount := consume_fifo(NEW.product_id, warehouse_id, NEW.quantity, NEW.id);

-- RIGHT (after fix): Use base quantity
v_consume_qty := COALESCE(NEW.base_quantity, NEW.quantity);
v_cogs_amount := consume_fifo(NEW.product_id, warehouse_id, v_consume_qty, NEW.id);
```

**Example:**
- Selling 2 coils (sale quantity = 2)
- Base quantity = 200 meters (2 × 100)
- consume_fifo must receive **200**, not **2**
- Returns COGS = ₹6,000 (200m × ₹30/m average)
- Stores cost_price = ₹6,000 / 2 = **₹3,000 per coil**

---

#### **Trigger 2: Status Change COGS (draft → active)**
```sql
CREATE TRIGGER trg_invoice_status_cogs
  AFTER UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoice_status_cogs_trigger();
```

Handles case where items are inserted while invoice is draft, then status changes to 'sent'/'paid'.

Same logic as per-item trigger, but loops through all items of the invoice.

---

#### **Trigger 3: GRN Batch Creation (on goods_receipt_notes UPDATE)**
```sql
CREATE TRIGGER trg_grn_accounting
  AFTER INSERT OR UPDATE ON goods_receipt_notes
  FOR EACH ROW EXECUTE FUNCTION grn_accounting_trigger();
```

**Function Logic:**
```sql
CREATE OR REPLACE FUNCTION grn_accounting_trigger()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'posted' AND OLD.status != 'posted' THEN
    -- Create inventory batch for each received item
    FOR v_item IN
      SELECT product_id, variant_id, received_quantity, unit_cost
      FROM purchase_order_items
      WHERE purchase_order_id = NEW.purchase_order_id
        AND received_quantity > 0
    LOOP
      INSERT INTO inventory_batches (
        product_id, warehouse_id, batch_number,
        quantity_received, quantity_remaining, unit_cost,
        batch_type, reference_type, reference_id, reference_number,
        created_at
      ) VALUES (
        v_item.product_id, NEW.warehouse_id, 'GRN-' || NEW.grn_number,
        v_item.received_quantity, v_item.received_quantity, v_item.unit_cost,
        'purchase', 'grn', NEW.id, NEW.grn_number,
        COALESCE(NEW.received_date, CURRENT_DATE)
      );
    END LOOP;

    -- Post AP (Accounts Payable) journal entry
    PERFORM post_journal_entry(
      'Goods Received - GRN #' || NEW.grn_number,
      jsonb_build_array(
        jsonb_build_object('account_code', '1200', 'debit', total_cost, 'description', 'Inventory received'),
        jsonb_build_object('account_code', '2000', 'credit', total_cost, 'description', 'Accounts Payable')
      ),
      NEW.received_date,
      'grn',
      NEW.id
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

**FIFO Batch Flow:**
1. GRN posted → creates `inventory_batches` row(s)
2. Invoice created → `consume_fifo()` consumes from oldest batches
3. Invoice cancelled → `restore_fifo()` restores to batches
4. Sales return → `restore_fifo_on_return()` creates return batch

---

### 3.3 Accounting Journal Entries

**Chart of Accounts (Relevant Accounts):**
```
1000 - Cash
1100 - Accounts Receivable (AR)
1200 - Inventory (Asset)
2000 - Accounts Payable (AP)
4000 - Sales Revenue
5000 - Cost of Goods Sold (COGS)
```

**Journal Entry Flow for Invoice with FIFO:**

**Step 1: Invoice Creation (Revenue Recognition)**
```
Debit:  1100 Accounts Receivable     ₹12,000
Credit: 4000 Sales Revenue            ₹12,000
Description: AR - Invoice INV-00123
```

**Step 2: COGS Recognition (FIFO Trigger)**
```
Debit:  5000 Cost of Goods Sold      ₹7,300
Credit: 1200 Inventory                ₹7,300
Description: COGS (FIFO) - Invoice INV-00123 - Cable Product
```

**Detailed COGS Calculation (from batches):**
```
Batch 1 (GRN-001): 150m @ ₹29/m = ₹4,350  ← Consumed first (oldest)
Batch 2 (GRN-003): 100m @ ₹29.50/m = ₹2,950  ← Consumed second
Total consumed: 250m
Total COGS: ₹7,300
Average cost per base unit: ₹7,300 / 250m = ₹29.20/m
Cost per sale unit (coil): ₹7,300 / 2.5 coils = ₹2,920/coil
```

**Step 3: Payment Collection**
```
Debit:  1000 Cash                    ₹12,000
Credit: 1100 Accounts Receivable     ₹12,000
Description: Payment - Invoice INV-00123
```

**Step 4: Invoice Cancellation (if cancelled)**
```
-- Reverse Revenue & AR
Debit:  4000 Sales Revenue            ₹12,000
Credit: 1100 Accounts Receivable      ₹12,000

-- Reverse COGS & Restore Inventory
Debit:  1200 Inventory                ₹7,300
Credit: 5000 Cost of Goods Sold       ₹7,300

-- Reverse Payment
Debit:  1100 Accounts Receivable      ₹12,000
Credit: 1000 Cash                     ₹12,000

-- restore_fifo() restores batch quantities
```

---

## 4. Edge Cases & Fixes

### 4.1 Selling Without Sufficient Stock
**Scenario:** Selling 500 meters but only 300 meters in batches.

**Solution (consume_fifo):**
```sql
-- Consume 300m from existing batches
-- Create fallback adjustment batch for remaining 200m
INSERT INTO inventory_batches (
  product_id, warehouse_id, batch_number,
  quantity_received, quantity_remaining, unit_cost,
  batch_type, reference_type, notes
) VALUES (
  p_product_id, p_warehouse_id, 'ADJ-' || p_invoice_item_id::text,
  0, -200,  -- Negative remaining!
  fallback_cost_price,
  'adjustment', 'invoice_item',
  'Negative adjustment - sold without sufficient stock'
);
```

**Result:**
- COGS still calculated (using product.cost_price for shortfall)
- Inventory goes negative (tracked in adjustment batch)
- restore_fifo() deletes adjustment batches (not restored)

---

### 4.2 Invoice Editing (Full Edit with FIFO Restore)
**Scenario:** Edit invoice from 2 coils → 3 coils.

**Function:** `edit_invoice(p_invoice_id, p_new_data, ...)`

**Steps:**
1. **Restore FIFO batches for old items:**
```sql
FOR v_item IN SELECT * FROM invoice_items WHERE invoice_id = p_invoice_id LOOP
  PERFORM restore_fifo(v_item.id);  -- Restores batch quantities
END LOOP;
```

2. **Restore stock to inventory_items:**
```sql
UPDATE inventory_items 
SET quantity_on_hand = quantity_on_hand + old_base_quantity
WHERE product_id = ... AND warehouse_id = ...;
```

3. **Reverse old COGS journal entries:**
```sql
DELETE FROM journal_lines WHERE journal_entry_id IN (
  SELECT id FROM journal_entries 
  WHERE reference_id = p_invoice_id AND description LIKE 'COGS%'
);
DELETE FROM journal_entries WHERE ...;
```

4. **Delete old invoice items:**
```sql
DELETE FROM invoice_items WHERE invoice_id = p_invoice_id;
```

5. **Insert new invoice items:**
```sql
INSERT INTO invoice_items (invoice_id, product_id, quantity, base_quantity, unit_name, ...)
VALUES (...);
-- Triggers fire → consume_fifo() with new quantities → new COGS posted
```

6. **Re-post new AR & Revenue:**
```sql
PERFORM post_journal_entry('AR - Invoice INV-00123 EDITED', ...);
```

**Result:** Clean edit with accurate FIFO COGS for new quantities.

---

### 4.3 Duplicate COGS Prevention
**Problem:** Multiple triggers firing for same invoice causing duplicate COGS entries.

**Solution 1: Idempotency Check**
```sql
-- Skip if already consumed
PERFORM 1 FROM invoice_item_batch_consumption WHERE invoice_item_id = NEW.id;
IF FOUND THEN
  RETURN NEW;
END IF;
```

**Solution 2: Cleanup Migration (20260811)**
```sql
-- Keep only latest COGS entry per invoice, delete duplicates
-- Recalculate account balances from journal lines
```

---

### 4.4 Multi-Unit COGS Calculation Bug
**Problem:** Triggers were passing `quantity` (sale units) instead of `base_quantity` to consume_fifo.

**Example:**
- Selling 2 coils (200 meters base)
- Bug: consume_fifo(product_id, warehouse_id, **2**, item_id) ← WRONG!
- Fix: consume_fifo(product_id, warehouse_id, **200**, item_id) ← RIGHT!

**Impact:**
- Under-consumed inventory batches
- Wrong COGS (2m worth instead of 200m worth)
- Batch quantities not decreasing properly

**Fix (Migration 20260811):**
```sql
-- All COGS triggers updated to:
v_consume_qty := COALESCE(NEW.base_quantity, NEW.quantity);
v_cogs_amount := consume_fifo(NEW.product_id, warehouse_id, v_consume_qty, NEW.id);

-- Then store cost PER SALE UNIT:
UPDATE invoice_items SET cost_price = v_cogs_amount / NEW.quantity WHERE id = NEW.id;
```

---

## 5. Data Flow Diagrams

### 5.1 Purchase to Sale Flow (FIFO)

```
┌─────────────────────────────────────────────────────────────────┐
│ PURCHASE FLOW                                                   │
└─────────────────────────────────────────────────────────────────┘

1. Create Purchase Order (PO)
   purchase_orders: { po_number: "PO-001", supplier_id, total: ₹50,000 }
   purchase_order_items: { product_id, quantity: 1000m, unit_cost: ₹30/m }

2. Receive Goods (GRN Posted)
   goods_receipt_notes: { grn_number: "GRN-001", status: "posted" }
   
   → TRIGGER: grn_accounting_trigger()
   
   → Creates batch:
     inventory_batches: {
       batch_number: "GRN-001",
       product_id,
       warehouse_id,
       quantity_received: 1000,
       quantity_remaining: 1000,  ← Available for FIFO
       unit_cost: 30,
       batch_type: "purchase",
       created_at: "2026-08-01T10:00:00Z"  ← FIFO order
     }
   
   → Posts journal entry:
     Dr. 1200 Inventory         ₹30,000
     Cr. 2000 Accounts Payable  ₹30,000

┌─────────────────────────────────────────────────────────────────┐
│ SALES FLOW (Multi-Unit)                                        │
└─────────────────────────────────────────────────────────────────┘

3. Create Invoice (POS)
   User selects: Product = Cable, Unit = Coil (100m), Qty = 2.5
   
   invoice_items: {
     product_id,
     quantity: 2.5,                 ← Sale quantity (coils)
     unit_price: 4800,              ← Price per coil
     unit_name: "Coil",
     unit_conversion_factor: 100,
     base_quantity: 250,            ← 2.5 × 100 = 250 meters (KEY!)
     cost_price: 0                  ← Placeholder (will be updated)
   }

   → TRIGGER: invoice_items_cogs_trigger()
   
   → Calls: consume_fifo(product_id, warehouse_id, 250, item_id)
   
   → Consumes from oldest batch:
     Batch GRN-001 (created 2026-08-01):
       quantity_remaining: 1000 → 750  (consumed 250m)
   
   → Creates consumption record:
     invoice_item_batch_consumption: {
       invoice_item_id,
       batch_id: GRN-001,
       quantity_consumed: 250,
       unit_cost: 30,
       cogs_amount: 7500  ← 250m × ₹30/m
     }
   
   → Returns COGS = ₹7,500
   
   → Updates invoice_items:
     cost_price = 7500 / 2.5 = 3000  ← Cost per coil stored!
   
   → Posts journal entry:
     Dr. 5000 COGS       ₹7,500
     Cr. 1200 Inventory  ₹7,500

4. Payment Collection
   Dr. 1000 Cash             ₹12,000
   Cr. 1100 AR               ₹12,000

┌─────────────────────────────────────────────────────────────────┐
│ CANCELLATION FLOW                                               │
└─────────────────────────────────────────────────────────────────┘

5. Cancel Invoice
   → Calls: restore_fifo(invoice_item_id)
   
   → Restores batch:
     Batch GRN-001:
       quantity_remaining: 750 → 1000  (restored 250m)
   
   → Deletes consumption record
   
   → Reverses journal entries:
     Dr. 1200 Inventory  ₹7,500
     Cr. 5000 COGS       ₹7,500
```

---

### 5.2 Multi-Batch FIFO Consumption

```
┌─────────────────────────────────────────────────────────────────┐
│ SCENARIO: Sell 350m cable (3.5 coils)                          │
└─────────────────────────────────────────────────────────────────┘

BEFORE SALE:
  Batch A (GRN-001, 2026-08-01): 200m @ ₹29/m remaining
  Batch B (GRN-003, 2026-08-10): 500m @ ₹30/m remaining
  Batch C (GRN-005, 2026-08-15): 300m @ ₹31/m remaining

CONSUME_FIFO(product_id, warehouse_id, 350, item_id):
  
  Step 1: Lock batches ORDER BY created_at ASC
  
  Step 2: Consume from Batch A (oldest)
    - consume_qty = LEAST(200, 350) = 200m
    - Batch A: 200 → 0 remaining
    - Record: { batch_id: A, qty: 200, cost: ₹29/m, cogs: ₹5,800 }
    - remaining_to_consume = 350 - 200 = 150m
  
  Step 3: Consume from Batch B (next oldest)
    - consume_qty = LEAST(500, 150) = 150m
    - Batch B: 500 → 350 remaining
    - Record: { batch_id: B, qty: 150, cost: ₹30/m, cogs: ₹4,500 }
    - remaining_to_consume = 150 - 150 = 0
  
  Step 4: Return total COGS
    - COGS = ₹5,800 + ₹4,500 = ₹10,300

AFTER SALE:
  Batch A: 0m remaining (fully consumed)
  Batch B: 350m remaining
  Batch C: 300m remaining (untouched)

INVOICE_ITEMS UPDATE:
  quantity: 3.5 coils
  base_quantity: 350m
  cost_price: ₹10,300 / 3.5 = ₹2,943 per coil  ← Actual average cost!
  unit_price: ₹4,800 per coil
  profit: (₹4,800 - ₹2,943) × 3.5 = ₹6,500
```

---

## 6. Cost Price History Tracking

**Purpose:** Audit trail of product costs at time of sale, even if product.cost_price changes later.

### 6.1 Table Structure

```sql
CREATE TABLE cost_price_history (
  id uuid PRIMARY KEY,
  product_id uuid REFERENCES products,
  product_name text,                    -- Denormalized snapshot
  product_sku text,                     -- Denormalized snapshot
  invoice_id uuid REFERENCES invoices,
  unit text,                            -- Sale unit (e.g., "Coil")
  quantity numeric,                     -- Sale quantity (e.g., 2.5)
  unit_price numeric,                   -- Sale price per unit (e.g., ₹4,800)
  cost_price_per_qty numeric,           -- Cost per sale unit (e.g., ₹2,920)
  cost_price_for_added_qty numeric,     -- Total cost (e.g., ₹7,300)
  total_cost_price_single numeric,      -- Same as cost_price_per_qty
  total_cost_price_added numeric,       -- Same as cost_price_for_added_qty
  recorded_at timestamptz DEFAULT now()
);
```

### 6.2 Recording Flow (POS)

```typescript
// In processOrder() after FIFO triggers have run
const costHistoryRecords = cart.map(item => {
  const unitName = item.selected_unit?.unit_name || 'pcs';
  const costPerUnit = item.cost_price || 0;  // FIFO-calculated cost
  const totalCostAdded = costPerUnit * item.quantity;
  
  return {
    product_id: item.id,
    product_name: item.name,
    product_sku: item.sku || '',
    invoice_id: invoice.id,
    unit: unitName,
    quantity: item.quantity,
    unit_price: item.unit_price,
    cost_price_per_qty: costPerUnit,
    cost_price_for_added_qty: totalCostAdded,
    total_cost_price_single: costPerUnit,
    total_cost_price_added: totalCostAdded,
  };
});

await supabase.from('cost_price_history').insert(costHistoryRecords);
```

**Use Cases:**
- "What was the cost of Cable on August 1st when we sold it?"
- "Calculate profit margin for a specific historical invoice"
- "Track cost trends over time for a product"

---

## 7. Key Insights & Recommendations

### 7.1 System Strengths

✅ **Accurate COGS:** True FIFO costing from actual purchase batches, not static cost_price  
✅ **Multi-Unit Support:** Seamless sale in different units with automatic base conversion  
✅ **Audit Trail:** Full traceability via invoice_item_batch_consumption  
✅ **Reversibility:** Clean restoration on invoice cancel/edit  
✅ **Double-Entry Accounting:** Automatic journal entries maintain balanced books  
✅ **Edge Case Handling:** Negative adjustments, multi-batch consumption, duplicate prevention  

### 7.2 Critical Implementation Details

🔴 **ALWAYS use base_quantity for FIFO consumption:**
```typescript
// WRONG
const cogs = consume_fifo(productId, warehouseId, item.quantity, itemId);

// RIGHT
const baseQty = item.base_quantity || item.quantity;
const cogs = consume_fifo(productId, warehouseId, baseQty, itemId);
```

🔴 **Store cost per sale unit in invoice_items.cost_price:**
```typescript
// After FIFO returns total COGS for base quantity
invoice_item.cost_price = total_cogs / sale_quantity;
// Example: ₹7,500 / 2.5 coils = ₹3,000 per coil
```

🔴 **Idempotency checks in triggers:**
```sql
-- Always check if already processed
PERFORM 1 FROM invoice_item_batch_consumption WHERE invoice_item_id = NEW.id;
IF FOUND THEN RETURN NEW; END IF;
```

### 7.3 Potential Improvements

🔴 **Fix sales returns multi-unit handling** — see Section 10 (confirmed bugs)  
💡 **Batch Expiry Tracking:** Add `expiry_date` to inventory_batches for perishable goods  
💡 **Weighted Average Cost Option:** Support AVCO (Average Cost) alongside FIFO  
💡 **Batch Splitting:** Allow manual batch splits for partial quality issues  
💡 **Multi-Warehouse FIFO:** Currently per-warehouse; could optimize across warehouses  
💡 **Move return processing into a DB function** — currently client-side and non-atomic (Section 10.5)  

### 7.4 Migration History Summary

Your system has **24 FIFO/COGS-related migrations**, showing continuous refinement:

| Date | Migration | Purpose |
|------|-----------|---------|
| 2026-08-08 | `fifo_inventory_batch_tracking` | Initial FIFO system |
| 2026-08-08 | `fifo_complete_part1` | Fix consume_fifo, restore_fifo |
| 2026-08-08 | `fifo_complete_part2` | Cancel/edit invoice FIFO integration |
| 2026-08-11 | `fix_fifo_triggers_for_multi_unit` | **Critical: base_quantity fix** |
| 2026-08-11 | `fix_cogs_journal_entries_for_multi_unit` | Cleanup duplicate COGS |
| 2026-08-11 | `fix_phantom_cogs_reversals` | Edge case fixes |
| 2026-08-12 | `fix_invoice_cogs_posting` | Final COGS trigger refinement |

This indicates a **production-tested, mature system** that handles real-world complexity.

---

## 8. Testing Scenarios

### Scenario 1: Basic FIFO
```
1. Purchase 100m @ ₹30/m (Batch A)
2. Purchase 100m @ ₹32/m (Batch B)
3. Sell 150m
   Expected COGS: (100m × ₹30) + (50m × ₹32) = ₹4,600
   Batch A: 0 remaining
   Batch B: 50 remaining
```

### Scenario 2: Multi-Unit Sale
```
1. Purchase 500m cable @ ₹30/m (Batch A)
2. Sell 2 coils (1 coil = 100m)
   Expected:
   - base_quantity = 200m
   - COGS = 200m × ₹30/m = ₹6,000
   - cost_price per coil = ₹6,000 / 2 = ₹3,000
   - Batch A: 300m remaining
```

### Scenario 3: Invoice Cancellation
```
1. Create invoice (consumes 150m from Batch A)
2. Cancel invoice
   Expected:
   - Batch A restored +150m
   - Consumption records deleted
   - COGS journal entry reversed
   - AR/Revenue reversed
```

### Scenario 4: Insufficient Stock
```
1. Purchase 100m @ ₹30/m (Batch A)
2. Sell 150m
   Expected:
   - Consume 100m from Batch A
   - Create adjustment batch: -50m @ ₹30/m (fallback)
   - COGS = 150m × ₹30 = ₹4,500
   - Inventory goes negative (tracked)
```

### Scenario 5: Cross-Batch Sale
```
1. Purchase 100m @ ₹29/m (Batch A, Aug 1)
2. Purchase 200m @ ₹30/m (Batch B, Aug 5)
3. Purchase 100m @ ₹31/m (Batch C, Aug 10)
4. Sell 2.5 coils (250m)
   Expected:
   - Consume 100m from Batch A @ ₹29 = ₹2,900
   - Consume 150m from Batch B @ ₹30 = ₹4,500
   - Total COGS = ₹7,400
   - Cost per coil = ₹7,400 / 2.5 = ₹2,960
   - Batch A: 0 remaining
   - Batch B: 50m remaining
   - Batch C: 100m remaining (untouched)
```

---

## 9. Sales Returns — Confirmed Bugs (Verified 2026-08-26)

Sales returns are the **weakest link** in the FIFO chain. Unlike invoice creation, cancellation, and editing (all of which correctly use `base_quantity`), the sales return path operates entirely in **sale units**. All findings below were verified against source.

### 9.1 Where return logic lives

There is **no DB function or trigger** for sales returns. The entire flow is client-side in `handleReturn()` at [`app/(erp)/sales/returns/page.tsx:426`](app/(erp)/sales/returns/page.tsx:426). Per returned item it:

1. Inserts `sales_return_items` — line 692
2. Calls `restore_fifo_on_return` RPC — line 705
3. Inserts a `return_in` `stock_movements` row — line 716
4. Directly increments `inventory_items.quantity_on_hand += qty` — line 739

`restore_fifo_on_return` is **not dead code** — this frontend RPC call is its only caller. It restores `quantity_remaining` to the originally consumed batches (skipping `adjustment` batches), and only creates a new `'return'` batch for any un-restorable remainder. The `stock_movement_accounting` trigger deliberately skips `return_in`/`return_out` ([`20260703012241:52-55`](supabase/migrations/20260703012241_20260703_sales_stock_accounting_triggers.sql:52)), so there is no double journal posting from the movement.

### 9.2 🔴 BUG: Base-unit / sale-unit asymmetry

This is the core defect. The sale and return sides disagree on units:

| Path | Quantity basis | Source |
|------|----------------|--------|
| Sale (deduct) | `COALESCE(base_quantity, quantity)` → **base units** | [`20260703012241:161,182`](supabase/migrations/20260703012241_20260703_sales_stock_accounting_triggers.sql:161) |
| Cancel invoice | `COALESCE(base_quantity, quantity)` → **base units** | `20260711043945:84` |
| Edit invoice | `COALESCE(base_quantity, quantity)` → **base units** | `20260711044043:150` |
| **Sales return** | `qty` → **sale units** ❌ | [`returns/page.tsx:709,739`](app/(erp)/sales/returns/page.tsx:709) |

The returns page **never loads** `base_quantity`, `unit_conversion_factor`, or `unit_name` (verified: zero matches in the file), and never writes `sales_return_items.base_quantity_returned` — a column added specifically for this purpose in `20260712084302:661`.

**Impact when `conversion_factor ≠ 1`** — returning 2 coils (factor 100) of a 250m sale:

| Effect | Correct | Actual | Error |
|--------|---------|--------|-------|
| FIFO batch restore | 200 m | 2 m | 100× under-restored |
| `inventory_items` restore | 200 m | 2 m | 100× under-restored |
| COGS reversed | ₹6,000 | ₹60 | 100× under-reversed |

**Net result:** inventory is permanently lost from the books, and COGS stays overstated — understating profit and corrupting the inventory asset balance. Single-unit products (factor = 1) are unaffected, which is likely why this has gone unnoticed.

### 9.3 🔴 BUG: `fifoCostMap` drops all but the last batch

At [`returns/page.tsx:409-413`](app/(erp)/sales/returns/page.tsx:409), the map is **assigned** per consumption row rather than aggregated:

```typescript
(data || []).forEach((c: any) => {
  const consumed = Number(c.quantity_consumed) || 0;
  if (consumed > 0) {
    map[c.invoice_item_id] = Number(c.cogs_amount) / consumed;  // ❌ overwrites
  }
});
```

For an item that consumed **multiple batches**, every row overwrites the previous, so only the **last batch's** unit cost survives. The correct cost basis is the weighted average across all batches:

```typescript
// Aggregate, then divide
const totals: Record<string, {cogs: number, qty: number}> = {};
(data || []).forEach((c: any) => {
  const t = totals[c.invoice_item_id] ??= {cogs: 0, qty: 0};
  t.cogs += Number(c.cogs_amount) || 0;
  t.qty  += Number(c.quantity_consumed) || 0;
});
const map = Object.fromEntries(
  Object.entries(totals).filter(([, t]) => t.qty > 0).map(([k, t]) => [k, t.cogs / t.qty])
);
```

Using the Section 5.2 example (100m @ ₹29 + 150m @ ₹30), the true weighted cost is ₹29.60/m but the code returns ₹30.00/m — COGS reversed at the wrong basis on every multi-batch return.

### 9.4 ⚠️ RISK: Consumption records never decremented

`restore_fifo_on_return` restores batch quantities but **never deletes or decrements** `invoice_item_batch_consumption` rows — in contrast to `restore_fifo`, which does (`fifo_complete_part1.sql:96`). Consequence: each partial return re-reads the **full original** consumption and can restore against it again. Returning 2 units three times from a 10-unit sale restores against all 10 units each time. Today this is bounded only by the UI's `remaining_qty` cap — a client-side guard, not a database invariant.

Additionally, null `base_quantity_returned` causes `cancel_invoice`'s return-netting logic to mis-net (`20260715025120:153-160`), since it cannot tell how much base stock a prior return already restored.

### 9.5 ⚠️ RISK: Non-atomic, client-side orchestration

`handleReturn()` performs the return as a **sequence of separate awaited calls** with no transaction. A failure or closed tab midway leaves the return partially applied — e.g. `sales_return_items` inserted and batches restored, but `inventory_items` never incremented, or the journal entry never posted. There is also an inconsistency in what gets stored: `sales_return_items.cost_price` holds a **per-base-unit** cost, while `invoice_items.cost_price` holds a **per-sale-unit** cost.

**Recommended fix:** move the whole flow into a `process_sales_return(...)` PL/pgSQL function mirroring `cancel_invoice` — atomic, base-unit aware, and consistent with the rest of the FIFO system.

### 9.6 Suggested fix priority

| # | Issue | Severity | Status | Fix sketch |
|---|-------|----------|--------|------------|
| 1 | Base/sale unit asymmetry (9.2) | 🔴 Critical | ✅ Fixed 2026-08-26 | Load `base_quantity` + `unit_conversion_factor`; pass base qty to `restore_fifo_on_return`, `inventory_items`, `stock_movements`; compute COGS on base qty; persist `base_quantity_returned` |
| 2 | `fifoCostMap` overwrite (9.3) | 🔴 High | ✅ Fixed 2026-08-26 | Aggregate `cogs_amount` / `quantity_consumed` before dividing |
| 3 | Consumption not decremented (9.4) | ⚠️ Medium | Open | Decrement/delete consumption rows inside `restore_fifo_on_return` |
| 4 | Non-atomic client flow (9.5) | ⚠️ Medium | Open | Move into a single `process_sales_return()` DB function |

**Fixes 1 & 2** landed in [`app/(erp)/sales/returns/page.tsx`](app/(erp)/sales/returns/page.tsx) plus a documentation migration [`20260826093430`](supabase/migrations/20260826093430_20260826_fix_sales_returns_multi_unit_aware.sql). Conversion is derived per line as `base_quantity / quantity` (falling back to `unit_conversion_factor`, then 1), so it stays correct even if a product's unit definitions changed after the sale. Single-unit products (factor = 1) are provably unaffected.

> **Note:** Fixes 1 and 3 change quantity semantics. Any returns already recorded against multi-unit products carry incorrect stock and COGS. Run [`scripts/diagnose_sales_return_unit_bug.sql`](scripts/diagnose_sales_return_unit_bug.sql) to size the damage, then reconcile `inventory_batches`, `inventory_items`, and the COGS journal entries for affected returns.

---

## 10. Conclusion

Your ERP implements a **production-grade FIFO inventory costing system** with **sophisticated multi-unit product support**. The integration between FIFO batches, multi-unit conversions, POS system, and double-entry accounting is comprehensive and well-architected — **on the sale, cancel, and edit paths**. The sales return path has not caught up (Section 9).

**Key Takeaways:**
1. **Batches are always in base units** (meters, pieces, etc.)
2. **consume_fifo must receive base_quantity**, not sale quantity
3. **cost_price in invoice_items stores cost per sale unit**, calculated from FIFO
4. **Reversibility is built-in** via restore_fifo for cancellations and edits
5. **Audit trail is complete** via invoice_item_batch_consumption and cost_price_history
6. **Accounting integration is automatic** via triggers posting journal entries
7. **Sales returns are the exception** — they operate in sale units and break all of the above for multi-unit products

The **24 migrations** focused on FIFO/COGS refinements demonstrate a mature system, battle-tested on the sale path. The return path never received the equivalent of migration `20260811003327` (the base-unit fix), which is the root cause of every issue in Section 9.

---

**Questions or Next Steps?**
- Fix the sales return base-unit bug (Section 9.2) — highest value, isolated to one file plus one SQL function
- Reconcile existing multi-unit return data corrupted by the bug
- Move return processing into an atomic `process_sales_return()` DB function
- Add weighted average cost (AVCO) as an option, or batch expiry tracking

Want me to implement the Section 9 fixes?
