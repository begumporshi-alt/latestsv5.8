#!/usr/bin/env node
// ============================================================
// TEST: Multi-item COGS journal entry (the original bug)
// Verifies that inserting items one-by-one results in a
// single COGS JE that includes ALL items.
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

const client = new Client({ connectionString: env.NEXT_PUBLIC_SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });

let testInvoiceId = null;
let testItems = [];

async function cleanup() {
  console.log('\n=== CLEANUP ===');
  try {
    if (testInvoiceId) {
      await client.query(`DELETE FROM journal_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE reference_id = $1 AND reference_type = 'invoice' AND description LIKE 'COGS%')`, [testInvoiceId]);
      await client.query(`DELETE FROM journal_entries WHERE reference_id = $1 AND reference_type = 'invoice' AND description LIKE 'COGS%'`, [testInvoiceId]);
      await client.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [testInvoiceId]);
      await client.query(`DELETE FROM invoices WHERE id = $1`, [testInvoiceId]);
      console.log('  Deleted test invoice and all related data');
    }
  } catch (e) {
    console.log('  Cleanup error (non-fatal):', e.message);
  }
}

async function runTest() {
  await client.connect();
  console.log('=== TEST: Multi-Item COGS Journal Entry ===\n');

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
    // Find 2 different products with stock
    const prods = await client.query(`
      SELECT p.id, p.name, p.sku, p.cost_price, ii.quantity_on_hand, ii.warehouse_id
      FROM products p
      JOIN inventory_items ii ON ii.product_id = p.id
      WHERE p.is_active = true AND ii.quantity_on_hand > 0
      AND EXISTS (SELECT 1 FROM inventory_batches ib WHERE ib.product_id = p.id AND ib.quantity_remaining > 0)
      ORDER BY p.name
      LIMIT 2
    `);

    if (prods.rows.length < 2) {
      console.log('  Need at least 2 products with stock. Found:', prods.rows.length);
      await client.end();
      process.exit(1);
    }

    const product1 = prods.rows[0];
    const product2 = prods.rows[1];
    console.log(`  Product 1: ${product1.name} (${product1.sku}) — Qty: ${product1.quantity_on_hand}, Cost: ${product1.cost_price}`);
    console.log(`  Product 2: ${product2.name} (${product2.sku}) — Qty: ${product2.quantity_on_hand}, Cost: ${product2.cost_price}`);

    // Find customer
    const cust = await client.query(`SELECT id, name FROM customers WHERE is_active = true LIMIT 1`);
    const customer = cust.rows[0];
    console.log(`  Customer: ${customer.name}\n`);

    // Create invoice as 'paid' (POS style)
    const invNum = `TEST-MULTI-${Date.now()}`;
    const inv = await client.query(`
      INSERT INTO invoices (invoice_number, customer_id, invoice_date, subtotal, total_amount, amount_paid, status, is_pos)
      VALUES ($1, $2, CURRENT_DATE, 20.00, 20.00, 20.00, 'paid', true)
      RETURNING id
    `, [invNum, customer.id]);

    testInvoiceId = inv.rows[0].id;
    console.log(`STEP 1: Created invoice ${invNum} as "paid"`);

    // Insert ITEM 1
    console.log('\nSTEP 2: Inserting item 1...');
    const item1 = await client.query(`
      INSERT INTO invoice_items (invoice_id, product_id, quantity, unit_price, cost_price, subtotal, sort_order, warehouse_id)
      VALUES ($1, $2, 3, 5.00, $3, 15.00, 1, $4) RETURNING id
    `, [testInvoiceId, product1.id, product1.cost_price, product1.warehouse_id]);
    testItems.push({ id: item1.rows[0].id, name: product1.name, qty: 3, cost: product1.cost_price });

    // Wait for trigger
    await new Promise(r => setTimeout(r, 300));

    // Check COGS JE after item 1
    const cogs1 = await client.query(`
      SELECT je.description FROM journal_entries je
      WHERE je.reference_type = 'invoice' AND je.reference_id = $1 AND je.description LIKE 'COGS%'
    `, [testInvoiceId]);

    if (cogs1.rows.length > 0) {
      console.log(`  COGS JE exists: "${cogs1.rows[0].description}"`);
    } else {
      console.log('  No COGS JE yet (will be created with item 2)');
    }

    // Insert ITEM 2
    console.log('\nSTEP 3: Inserting item 2...');
    const item2 = await client.query(`
      INSERT INTO invoice_items (invoice_id, product_id, quantity, unit_price, cost_price, subtotal, sort_order, warehouse_id)
      VALUES ($1, $2, 2, 5.00, $3, 10.00, 2, $4) RETURNING id
    `, [testInvoiceId, product2.id, product2.cost_price, product2.warehouse_id]);
    testItems.push({ id: item2.rows[0].id, name: product2.name, qty: 2, cost: product2.cost_price });

    // Wait for trigger
    await new Promise(r => setTimeout(r, 300));

    // Verify COGS JE includes BOTH items
    console.log('\nSTEP 4: Verifying COGS JE includes both items...');
    const cogsAll = await client.query(`
      SELECT je.description, jl.debit, jl.credit, a.code
      FROM journal_entries je
      JOIN journal_lines jl ON je.id = jl.journal_entry_id
      JOIN accounts a ON jl.account_id = a.id
      WHERE je.reference_type = 'invoice' AND je.reference_id = $1 AND je.description LIKE 'COGS%'
    `, [testInvoiceId]);

    assert(cogsAll.rows.length > 0, 'COGS journal entry exists');

    // Count COGS DR lines (should have 2 for 2 products)
    const cogsLines = cogsAll.rows.filter(r => r.code === '5000');
    assert(cogsLines.length === 2, `Has ${cogsLines.length} COGS DR lines (expected 2 for 2 products)`);

    // Check total
    const totalDr = cogsLines.reduce((sum, r) => sum + parseFloat(r.debit), 0);
    const expectedTotal = (3 * product1.cost_price) + (2 * product2.cost_price);
    assert(Math.abs(totalDr - expectedTotal) < 0.01, `Total COGS: ৳${totalDr} (expected ৳${expectedTotal})`);

    // Check description mentions both items
    const desc = cogsAll.rows[0].description;
    assert(desc.includes('2 items'), `Description says "2 items": "${desc}"`);

    // Verify accounts balanced
    const totalCr = cogsAll.rows.filter(r => r.code === '1200').reduce((sum, r) => sum + parseFloat(r.credit), 0);
    assert(Math.abs(totalDr - totalCr) < 0.01, `Accounts balanced: DR ৳${totalDr} = CR ৳${totalCr}`);

    // Verify FIFO consumption for both items
    console.log('\nSTEP 5: Verifying FIFO consumption for both items...');
    for (const item of testItems) {
      const fifo = await client.query(`SELECT quantity_consumed, cogs_amount FROM invoice_item_batch_consumption WHERE invoice_item_id = $1`, [item.id]);
      assert(fifo.rows.length > 0, `${item.name}: FIFO consumed`);
    }

    // Final summary
    console.log('\n' + '='.repeat(50));
    console.log(`TEST RESULTS: ${passed} passed, ${failed} failed`);
    console.log('='.repeat(50));

    if (failed === 0) {
      console.log('\n🎉 ALL TESTS PASSED! Multi-item COGS is working correctly.');
    } else {
      console.log(`\n⚠️ ${failed} test(s) failed.`);
    }

  } catch (e) {
    console.error('\n❌ TEST ERROR:', e.message);
    failed++;
  } finally {
    await cleanup();
    await client.end();
  }

  process.exit(failed > 0 ? 1 : 0);
}

runTest();
