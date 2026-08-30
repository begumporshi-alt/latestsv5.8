#!/usr/bin/env node
// ============================================================
// TEST: Verify COGS journal entries are created for POS sales
// ============================================================
// This test simulates the POS sale flow:
// 1. Create invoice directly as 'paid' (no draft step)
// 2. Insert invoice_items (separate step, like POS page does)
// 3. Verify COGS journal entry was posted automatically
// ============================================================

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const envContent = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf-8');
const env = {};
envContent.split('\n').forEach(line => {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) env[match[1].trim()] = match[2].trim();
});

const client = new Client({
  connectionString: env.NEXT_PUBLIC_SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false }
});

let testInvoiceId = null;
let testInvoiceNumber = null;
let testProductId = null;
let testCustomerId = null;

async function cleanup() {
  console.log('\n=== CLEANUP ===');
  try {
    if (testInvoiceId) {
      // Delete in order: journal lines → journal entries → invoice_items → invoices
      await client.query(`DELETE FROM journal_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE reference_id = $1 AND reference_type = 'invoice' AND description LIKE 'COGS%')`, [testInvoiceId]);
      const deleted = await client.query(`DELETE FROM journal_entries WHERE reference_id = $1 AND reference_type = 'invoice' AND description LIKE 'COGS%'`, [testInvoiceId]);
      console.log(`  Deleted ${deleted.rowCount} COGS journal entries`);
      
      await client.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [testInvoiceId]);
      await client.query(`DELETE FROM invoices WHERE id = $1`, [testInvoiceId]);
      console.log(`  Deleted test invoice ${testInvoiceNumber}`);
    }
  } catch (e) {
    console.log('  Cleanup error (non-fatal):', e.message);
  }
}

async function runTest() {
  await client.connect();
  console.log('=== TEST: COGS Journal Entry for POS Sales ===\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ PASS: ${message}`);
      passed++;
    } else {
      console.log(`  ❌ FAIL: ${message}`);
      failed++;
    }
  }

  try {
    // ============================================================
    // STEP 1: Find a test product with FIFO batches
    // ============================================================
    console.log('STEP 1: Finding test product with stock...');
    
    const prodRes = await client.query(`
      SELECT p.id, p.name, p.sku, p.cost_price,
             ii.quantity_on_hand, ii.warehouse_id
      FROM products p
      JOIN inventory_items ii ON ii.product_id = p.id
      WHERE p.is_active = true
      AND ii.quantity_on_hand > 0
      AND EXISTS (
        SELECT 1 FROM inventory_batches ib 
        WHERE ib.product_id = p.id AND ib.quantity_remaining > 0
      )
      ORDER BY ii.quantity_on_hand DESC
      LIMIT 1
    `);

    if (prodRes.rows.length === 0) {
      console.log('  ❌ No products with stock found. Cannot run test.');
      await client.end();
      process.exit(1);
    }

    const product = prodRes.rows[0];
    testProductId = product.id;
    console.log(`  Product: ${product.name} (${product.sku})`);
    console.log(`  Stock: ${product.quantity_on_hand}, Cost: ${product.cost_price}`);
    console.log(`  Warehouse: ${product.warehouse_id}`);

    // ============================================================
    // STEP 2: Find a test customer
    // ============================================================
    console.log('\nSTEP 2: Finding test customer...');
    
    const custRes = await client.query(`
      SELECT id, name FROM customers WHERE is_active = true LIMIT 1
    `);

    if (custRes.rows.length === 0) {
      console.log('  ❌ No customers found. Cannot run test.');
      await client.end();
      process.exit(1);
    }

    testCustomerId = custRes.rows[0].id;
    console.log(`  Customer: ${custRes.rows[0].name}`);

    // ============================================================
    // STEP 3: Create invoice directly as 'paid' (like POS)
    // ============================================================
    console.log('\nSTEP 3: Creating invoice as "paid" (POS style)...');
    
    testInvoiceNumber = `TEST-POS-${Date.now()}`;
    const invoiceRes = await client.query(`
      INSERT INTO invoices (
        invoice_number, customer_id, invoice_date, subtotal,
        total_amount, amount_paid, status, is_pos
      ) VALUES ($1, $2, CURRENT_DATE, 10.00, 10.00, 10.00, 'paid', true)
      RETURNING id, invoice_number
    `, [testInvoiceNumber, testCustomerId]);

    testInvoiceId = invoiceRes.rows[0].id;
    console.log(`  Invoice created: ${invoiceRes.rows[0].invoice_number}`);
    console.log(`  Status: paid (direct, no draft step)`);

    // Verify NO COGS JE exists yet (items not inserted)
    const preCheck = await client.query(`
      SELECT COUNT(*) as cnt FROM journal_entries
      WHERE reference_type = 'invoice' AND reference_id = $1
      AND description LIKE 'COGS%'
    `, [testInvoiceId]);

    assert(
      parseInt(preCheck.rows[0].cnt) === 0,
      'No COGS JE exists before items are inserted'
    );

    // ============================================================
    // STEP 4: Insert invoice_items (SEPARATE step, like POS page)
    // ============================================================
    console.log('\nSTEP 4: Inserting invoice items (separate step)...');
    
    const itemQty = 1;
    const itemRes = await client.query(`
      INSERT INTO invoice_items (
        invoice_id, product_id, quantity, unit_price, cost_price,
        subtotal, sort_order, warehouse_id
      ) VALUES ($1, $2, $3, $4, $5, $6, 1, $7)
      RETURNING id
    `, [testInvoiceId, testProductId, itemQty, 5.00, product.cost_price, 5.00, product.warehouse_id]);

    const itemId = itemRes.rows[0].id;
    console.log(`  Item inserted: ${product.name} × ${itemQty}`);

    // ============================================================
    // STEP 5: Verify FIFO consumption was recorded
    // ============================================================
    console.log('\nSTEP 5: Verifying FIFO consumption...');
    
    // Small delay for async trigger processing
    await new Promise(resolve => setTimeout(resolve, 500));

    const fifoRes = await client.query(`
      SELECT quantity_consumed, unit_cost, cogs_amount
      FROM invoice_item_batch_consumption
      WHERE invoice_item_id = $1
    `, [itemId]);

    assert(
      fifoRes.rows.length > 0,
      `FIFO consumption recorded (${fifoRes.rows.length} records)`
    );

    let totalFifoCogs = 0;
    fifoRes.rows.forEach(r => {
      totalFifoCogs += parseFloat(r.cogs_amount);
      console.log(`    Batch consumed: ${r.quantity_consumed} × ${r.unit_cost} = ${r.cogs_amount}`);
    });
    console.log(`    Total FIFO COGS: ${totalFifoCogs}`);

    // ============================================================
    // STEP 6: Verify COGS journal entry was posted
    // ============================================================
    console.log('\nSTEP 6: Verifying COGS journal entry...');
    
    const cogsRes = await client.query(`
      SELECT je.id, je.entry_number, je.entry_date, je.description,
             jl.debit, jl.credit, a.code, a.name as account_name
      FROM journal_entries je
      JOIN journal_lines jl ON je.id = jl.journal_entry_id
      JOIN accounts a ON jl.account_id = a.id
      WHERE je.reference_type = 'invoice'
      AND je.reference_id = $1
      AND je.description LIKE 'COGS%'
    `, [testInvoiceId]);

    assert(
      cogsRes.rows.length > 0,
      `COGS journal entry exists (${cogsRes.rows.length} lines)`
    );

    if (cogsRes.rows.length > 0) {
      console.log(`  Journal Entry: ${cogsRes.rows[0].entry_number}`);
      console.log(`  Date: ${cogsRes.rows[0].entry_date}`);
      cogsRes.rows.forEach(r => {
        console.log(`    ${r.code} ${r.account_name}: DR ${r.debit} / CR ${r.credit}`);
      });
      console.log(`  Description: ${cogsRes.rows[0].description}`);
    }

    // ============================================================
    // STEP 7: Verify COGS accounts are balanced
    // ============================================================
    console.log('\nSTEP 7: Verifying COGS accounts are balanced...');
    
    const cogsDr = cogsRes.rows.filter(r => r.code === '5000').reduce((sum, r) => sum + parseFloat(r.debit), 0);
    const invCr = cogsRes.rows.filter(r => r.code === '1200').reduce((sum, r) => sum + parseFloat(r.credit), 0);

    assert(
      cogsDr > 0,
      `COGS account (5000) has debit of ৳${cogsDr}`
    );
    assert(
      invCr > 0,
      `Inventory account (1200) has credit of ৳${invCr}`
    );
    assert(
      Math.abs(cogsDr - invCr) < 0.01,
      `COGS and Inventory entries are balanced (DR ${cogsDr} = CR ${invCr})`
    );

    // ============================================================
    // STEP 8: Verify stock was deducted
    // ============================================================
    console.log('\nSTEP 8: Verifying stock deduction...');
    
    const stockRes = await client.query(`
      SELECT movement_type, quantity
      FROM stock_movements
      WHERE reference_id = $1
      AND product_id = $2
    `, [testInvoiceId, testProductId]);

    assert(
      stockRes.rows.length > 0,
      `Stock movement recorded (${stockRes.rows.length} movements)`
    );

    const saleQty = stockRes.rows
      .filter(r => r.movement_type === 'sale')
      .reduce((sum, r) => sum + Math.abs(parseFloat(r.quantity)), 0);

    assert(
      saleQty === itemQty,
      `Stock deducted: ${saleQty} units (expected ${itemQty})`
    );

    // ============================================================
    // STEP 9: Verify idempotency (inserting another item shouldn't
    //         create duplicate COGS JE)
    // ============================================================
    console.log('\nSTEP 9: Verifying idempotency...');
    
    const item2Res = await client.query(`
      INSERT INTO invoice_items (
        invoice_id, product_id, quantity, unit_price, cost_price,
        subtotal, sort_order, warehouse_id
      ) VALUES ($1, $2, 1, 5.00, $3, 5.00, 2, $4)
      RETURNING id
    `, [testInvoiceId, testProductId, product.cost_price, product.warehouse_id]);

    await new Promise(resolve => setTimeout(resolve, 500));

    const cogsCountAfter = await client.query(`
      SELECT COUNT(DISTINCT je.id) as cnt
      FROM journal_entries je
      WHERE je.reference_type = 'invoice'
      AND je.reference_id = $1
      AND je.description LIKE 'COGS%'
    `, [testInvoiceId]);

    assert(
      parseInt(cogsCountAfter.rows[0].cnt) === 1,
      `Still only 1 COGS JE after adding second item (no duplicate)`
    );

    // ============================================================
    // RESULTS
    // ============================================================
    console.log('\n' + '='.repeat(50));
    console.log(`TEST RESULTS: ${passed} passed, ${failed} failed`);
    console.log('='.repeat(50));

    if (failed === 0) {
      console.log('\n🎉 ALL TESTS PASSED! COGS trigger is working correctly.');
    } else {
      console.log(`\n⚠️ ${failed} test(s) failed. Check the output above.`);
    }

  } catch (e) {
    console.error('\n❌ TEST ERROR:', e.message);
    console.error(e.stack);
    failed++;
  } finally {
    await cleanup();
    await client.end();
  }

  process.exit(failed > 0 ? 1 : 0);
}

runTest();
