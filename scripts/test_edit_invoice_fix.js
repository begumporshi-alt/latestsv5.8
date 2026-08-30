#!/usr/bin/env node
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

async function cleanup() {
  console.log('\n=== CLEANUP ===');
  try {
    if (testInvoiceId) {
      await client.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [testInvoiceId]);
      await client.query(`DELETE FROM invoice_item_batch_consumption WHERE invoice_item_id IN (SELECT id FROM invoice_items WHERE invoice_id = $1)`, [testInvoiceId]);
      await client.query(`DELETE FROM journal_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE reference_id = $1)`, [testInvoiceId]);
      await client.query(`DELETE FROM journal_entries WHERE reference_id = $1`, [testInvoiceId]);
      await client.query(`DELETE FROM stock_movements WHERE reference_id = $1`, [testInvoiceId]);
      await client.query(`DELETE FROM payments WHERE reference_id = $1`, [testInvoiceId]);
      await client.query(`DELETE FROM invoices WHERE id = $1`, [testInvoiceId]);
      console.log('  Cleaned up test data');
    }
  } catch (err) {
    console.log('  Cleanup error:', err.message);
  }
}

(async () => {
  await client.connect();

  try {
    // Find products with stock
    const products = await client.query(`
      SELECT p.id, p.name, p.sku, p.cost_price, ii.quantity_on_hand, ii.warehouse_id
      FROM products p
      JOIN inventory_items ii ON p.id = ii.product_id
      WHERE ii.quantity_on_hand >= 3 AND p.sku LIKE 'test%'
      LIMIT 3
    `);
    
    if (products.rows.length < 2) {
      console.log('❌ Need at least 2 test products with stock >= 3');
      await client.end();
      return;
    }

    console.log('=== TEST: Edit Invoice — Verify No Double Restoration + COGS JE ===\n');
    console.log('Products:');
    products.rows.forEach((p, i) => {
      console.log(`  ${i+1}. ${p.name} [${p.sku}] stock=${p.quantity_on_hand} cost=${p.cost_price}`);
    });

    // Find customer
    const customer = await client.query(`SELECT id, name FROM customers LIMIT 1`);
    console.log(`\nCustomer: ${customer.rows[0].name}`);

    // Get default warehouse
    const wh = await client.query(`SELECT id FROM warehouses WHERE is_default = true LIMIT 1`);
    const defaultWh = wh.rows.length > 0 ? wh.rows[0].id : null;
    console.log(`Default warehouse: ${defaultWh || 'none'}`);

    // Step 1: Create invoice with 2 items
    console.log('\n--- Step 1: Create invoice with 2 items ---');
    const invNum = `TEST-EDIT-${Date.now()}`;
    const invoiceResult = await client.query(`
      INSERT INTO invoices (invoice_number, customer_id, status, invoice_date, total_amount, amount_paid, subtotal)
      VALUES ($1, $2, 'paid', CURRENT_DATE, 100, 100, 100)
      RETURNING id, invoice_number
    `, [invNum, customer.rows[0].id]);
    testInvoiceId = invoiceResult.rows[0].id;
    console.log(`  Invoice: ${invoiceResult.rows[0].invoice_number} (${testInvoiceId})`);

    // Insert items
    const p1 = products.rows[0];
    const p2 = products.rows[1];
    
    await client.query(`
      INSERT INTO invoice_items (invoice_id, product_id, quantity, unit_price, cost_price, base_quantity, warehouse_id, sort_order)
      VALUES ($1, $2, 2, 10, $3, 2, $4, 0)
    `, [testInvoiceId, p1.id, p1.cost_price, defaultWh]);
    
    await client.query(`
      INSERT INTO invoice_items (invoice_id, product_id, quantity, unit_price, cost_price, base_quantity, warehouse_id, sort_order)
      VALUES ($1, $2, 1, 20, $3, 1, $4, 1)
    `, [testInvoiceId, p2.id, p2.cost_price, defaultWh]);

    // Check initial state
    const initialMovements = await client.query(`
      SELECT movement_type, quantity, product_id, notes
      FROM stock_movements WHERE reference_id = $1
    `, [testInvoiceId]);
    console.log(`  Initial stock movements: ${initialMovements.rows.length}`);
    initialMovements.rows.forEach(m => {
      console.log(`    [${m.movement_type}] qty=${m.quantity} | ${m.notes}`);
    });

    const initialCogs = await client.query(`
      SELECT description FROM journal_entries WHERE reference_id = $1 AND description LIKE 'COGS%'
    `, [testInvoiceId]);
    console.log(`  Initial COGS JEs: ${initialCogs.rows.length}`);

    // Step 2: Edit invoice — change qty of item 1 from 2→3, add note
    console.log('\n--- Step 2: Edit invoice (change qty 2→3 for item 1) ---');
    
    const editData = JSON.stringify({
      customer_id: customer.rows[0].id,
      invoice_date: new Date().toISOString().split('T')[0],
      notes: 'test edit',
      items: [
        { product_id: p1.id, quantity: 3, unit_price: 10, cost_price: p1.cost_price || 0, base_quantity: 3, warehouse_id: defaultWh, sort_order: 0 },
        { product_id: p2.id, quantity: 1, unit_price: 20, cost_price: p2.cost_price || 0, base_quantity: 1, warehouse_id: defaultWh, sort_order: 1 }
      ],
      payment_term: 'full',
      payment_method: 'cash',
    });

    const editResult2 = await client.query(
      `SELECT edit_invoice($1::uuid, $2::json, $3::text, $4::text) as result`,
      [testInvoiceId, editData, 'Test', 'Test edit']
    );

    const editResult = editResult2.rows[0].result;
    if (!editResult.success) {
      console.log(`  ❌ Edit error: ${editResult.error}`);
      await cleanup();
      await client.end();
      return;
    }
    console.log(`  Edit result: ${JSON.stringify(editResult)}`);

    // Check post-edit state
    const postMovements = await client.query(`
      SELECT movement_type, quantity, product_id, notes
      FROM stock_movements WHERE reference_id = $1
      ORDER BY created_at
    `, [testInvoiceId]);
    console.log(`\n  Post-edit stock movements: ${postMovements.rows.length}`);
    postMovements.rows.forEach((m, i) => {
      const emoji = m.movement_type === 'sale' ? '🔴' : '🟢';
      console.log(`    ${emoji} ${i+1}. [${m.movement_type}] qty=${m.quantity} | ${m.notes}`);
    });

    // Verify: should have return_in (from STEP 1b) + sale (from new insert) = 2 movements per product
    const returnIns = postMovements.rows.filter(m => m.movement_type === 'return_in');
    const sales = postMovements.rows.filter(m => m.movement_type === 'sale');
    console.log(`\n  Return_in movements: ${returnIns.length} (expected: 2 — one per product)`);
    console.log(`  Sale movements: ${sales.length} (expected: 2 — one per product)`);

    // Verify: no duplicate return_in (the DELETE trigger should NOT fire because session variable blocks it)
    const dupReturnIns = postMovements.rows.filter(m => 
      m.movement_type === 'return_in' && m.notes.includes('invoice item deleted')
    );
    console.log(`  DELETE-triggered return_in: ${dupReturnIns.length} (expected: 0 — session variable should block)`);

    // Check COGS
    const postCogs = await client.query(`
      SELECT description FROM journal_entries WHERE reference_id = $1 AND description LIKE 'COGS%'
    `, [testInvoiceId]);
    console.log(`\n  COGS JEs: ${postCogs.rows.length} (expected: 1)`);
    if (postCogs.rows.length > 0) {
      console.log(`    ${postCogs.rows[0].description}`);
    }

    // Check FIFO consumption
    const fifo = await client.query(`
      SELECT iibc.quantity_consumed, iibc.unit_cost, iibc.cogs_amount
      FROM invoice_item_batch_consumption iibc
      JOIN invoice_items ii ON iibc.invoice_item_id = ii.id
      WHERE ii.invoice_id = $1
    `, [testInvoiceId]);
    console.log(`  FIFO consumption records: ${fifo.rows.length}`);
    fifo.rows.forEach((f, i) => {
      console.log(`    ${i+1}. consumed=${f.quantity_consumed} cost=${f.unit_cost} cogs=${f.cogs_amount}`);
    });

    // Final verification
    const currentItems = await client.query(`
      SELECT quantity FROM invoice_items WHERE invoice_id = $1 ORDER BY sort_order
    `, [testInvoiceId]);
    console.log(`\n  Current items: ${currentItems.rows.map(r => r.quantity).join(', ')} (expected: 3, 1)`);

    // Summary
    console.log('\n=== SUMMARY ===');
    const allPassed = 
      returnIns.length === 2 && 
      sales.length === 2 && 
      dupReturnIns.length === 0 && 
      postCogs.rows.length === 1 &&
      fifo.rows.length === 2;
    
    console.log(`  Return_in = 2: ${returnIns.length === 2 ? '✅' : '❌'}`);
    console.log(`  Sale = 2: ${sales.length === 2 ? '✅' : '❌'}`);
    console.log(`  No DELETE-triggered return_in: ${dupReturnIns.length === 0 ? '✅' : '❌'}`);
    console.log(`  COGS JE = 1: ${postCogs.rows.length === 1 ? '✅' : '❌'}`);
    console.log(`  FIFO consumption = 2: ${fifo.rows.length === 2 ? '✅' : '❌'}`);
    console.log(`\n  ${allPassed ? '🎉 ALL TESTS PASSED!' : '❌ SOME TESTS FAILED'}`);

  } catch (err) {
    console.error('Test error:', err.message);
  } finally {
    await cleanup();
    await client.end();
  }
})();
