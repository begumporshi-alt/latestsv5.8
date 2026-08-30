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
    // Find products WITHOUT FIFO consumption records (simulating pre-FIFO invoices)
    const products = await client.query(`
      SELECT p.id, p.name, p.sku, p.cost_price, ii.quantity_on_hand, ii.warehouse_id
      FROM products p
      JOIN inventory_items ii ON p.id = ii.product_id
      WHERE ii.quantity_on_hand >= 5
        AND NOT EXISTS (
          SELECT 1 FROM invoice_item_batch_consumption iibc
          JOIN invoice_items ii ON iibc.invoice_item_id = ii.id
          WHERE ii.product_id = p.id
        )
      LIMIT 3
    `);
    
    if (products.rows.length < 2) {
      console.log('❌ Need at least 2 test products with stock >= 5 and NO FIFO consumption records');
      await client.end();
      return;
    }

    console.log('=== TEST: Edit Invoice — Verify COGS JE + Stock Movements (Pre-FIFO Simulation) ===\n');
    console.log('Products (NO FIFO consumption records):');
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

    // Step 1: Create invoice with 2 items (simulate OLD invoice with no FIFO tracking)
    console.log('\n--- Step 1: Create invoice with 2 items (NO FIFO consumption records) ---');
    const invNum = `TEST-EDIT-FIX-${Date.now()}`;
    const invoiceResult = await client.query(`
      INSERT INTO invoices (invoice_number, customer_id, status, invoice_date, total_amount, amount_paid, subtotal)
      VALUES ($1, $2, 'paid', CURRENT_DATE, 100, 100, 100)
      RETURNING id, invoice_number
    `, [invNum, customer.rows[0].id]);
    testInvoiceId = invoiceResult.rows[0].id;
    console.log(`  Invoice: ${invoiceResult.rows[0].invoice_number} (${testInvoiceId})`);

    // Insert items - IMPORTANT: Do NOT insert into invoice_item_batch_consumption to simulate pre-FIFO state
    const p1 = products.rows[0];
    const p2 = products.rows[1];
    
    await client.query(`
      INSERT INTO invoice_items (invoice_id, product_id, quantity, unit_price, cost_price, base_quantity, warehouse_id, sort_order)
      VALUES ($1, $2, 2, 10, $3, 2, $4, 0)
    `, [testInvoiceId, p1.id, p1.cost_price, defaultWh]);
    
    await client.query(`
      INSERT INTO invoice_items (invoice_id, product_id, quantity, unit_price, cost_price, base_quantity, warehouse_id, sort_order)
      VALUES ($1, $2, 3, 15, $4, 3, $5, 1)
    `, [testInvoiceId, p2.id, p2.cost_price, defaultWh]);

    // Check initial state - should have sale movements but NO consumption records
    const initialMovements = await client.query(`
      SELECT movement_type, quantity, product_id, notes
      FROM stock_movements WHERE reference_id = $1
      ORDER BY created_at
    `, [testInvoiceId]);
    console.log(`\n  Initial stock movements: ${initialMovements.rows.length}`);
    initialMovements.rows.forEach(m => {
      console.log(`    [${m.movement_type}] qty=${m.quantity} | ${m.notes}`);
    });

    const initialConsumption = await client.query(`
      SELECT COUNT(*) as count FROM invoice_item_batch_consumption iibc
      JOIN invoice_items ii ON iibc.invoice_item_id = ii.id
      WHERE ii.invoice_id = $1
    `, [testInvoiceId]);
    console.log(`  Initial FIFO consumption records: ${initialConsumption.rows[0].count} (expected: 0)`);

    const initialCogs = await client.query(`
      SELECT description FROM journal_entries WHERE reference_id = $1 AND description LIKE 'COGS%'
    `, [testInvoiceId]);
    console.log(`  Initial COGS JEs: ${initialCogs.rows.length} (expected: 1)`);
    if (initialCogs.rows.length > 0) {
      console.log(`    ${initialCogs.rows[0].description}`);
    }

    // Step 2: Edit invoice — change quantities
    console.log('\n--- Step 2: Edit invoice (change quantites: item1 2→1, item2 3→2) ---');
    
    const editData = JSON.stringify({
      customer_id: customer.rows[0].id,
      invoice_date: new Date().toISOString().split('T')[0],
      notes: 'test edit for fix verification',
      items: [
        { product_id: p1.id, quantity: 1, unit_price: 10, cost_price: p1.cost_price || 0, base_quantity: 1, warehouse_id: defaultWh, sort_order: 0 },
        { product_id: p2.id, quantity: 2, unit_price: 15, cost_price: p2.cost_price || 0, base_quantity: 2, warehouse_id: defaultWh, sort_order: 1 }
      ],
      payment_term: 'full',
      payment_method: 'cash',
    });

    const editResult2 = await client.query(
      `SELECT edit_invoice($1::uuid, $2::json, $3::text, $4::text) as result`,
      [testInvoiceId, editData, 'Test', 'Test edit for fix']
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
      const emoji = m.movement_type === 'sale' ? '🔴' : (m.movement_type === 'return_in' ? '🟢' : '⚪');
      console.log(`    ${emoji} ${i+1}. [${m.movement_type}] qty=${m.quantity} | ${m.notes.substring(0, 80)}${m.notes.length > 80 ? '...' : ''}`);
    });

    // Verify: should see original sale movements + new sale movements + return_in movements
    const returnIns = postMovements.rows.filter(m => m.movement_type === 'return_in');
    const sales = postMovements.rows.filter(m => m.movement_type === 'sale');
    console.log(`\n  Return_in movements: ${returnIns.length}`);
    console.log(`  Sale movements: ${sales.length}`);

    // Check COGS - THIS IS THE KEY TEST
    const postCogs = await client.query(`
      SELECT id, description, total_debit, total_credit
      FROM journal_entries WHERE reference_id = $1 AND description LIKE 'COGS%'
    `, [testInvoiceId]);
    console.log(`\n  COGS JEs: ${postCogs.rows.length} (expected: 1)`);
    if (postCogs.rows.length > 0) {
      console.log(`    Description: ${postCogs.rows[0].description}`);
      console.log(`    Total Debit: ${postCogs.rows[0].total_debit}`);
      console.log(`    Total Credit: ${postCogs.rows[0].total_credit}`);
    }

    // Check FIFO consumption - should now exist for new items
    const fifo = await client.query(`
      SELECT iibc.quantity_consumed, iibc.unit_cost, iibc.cogs_amount, ii.quantity as invoice_qty
      FROM invoice_item_batch_consumption iibc
      JOIN invoice_items ii ON iibc.invoice_item_id = ii.id
      WHERE ii.invoice_id = $1
      ORDER BY ii.sort_order
    `, [testInvoiceId]);
    console.log(`  FIFO consumption records: ${fifo.rows.length} (expected: 2 - one per item)`);
    fifo.rows.forEach((f, i) => {
      console.log(`    ${i+1}. consumed=${f.quantity_consumed} cost=${f.unit_cost} cogs=${f.cogs_amount} (invoice qty: ${f.invoice_qty})`);
    });

    // Final verification - check current item quantities
    const currentItems = await client.query(`
      SELECT quantity, unit_price, cost_price
      FROM invoice_items WHERE invoice_id = $1 ORDER BY sort_order
    `, [testInvoiceId]);
    console.log(`\n  Current items: ${currentItems.rows.map((r, i) => `Item${i+1}: qty=${r.quantity} price=${r.unit_price} cost=${r.cost_price}`).join(', ')}`);

    // Summary
    console.log('\n=== SUMMARY ===');
    const cogsJeExists = postCogs.rows.length === 1;
    const cogsJeBalanced = postCogs.rows.length > 0 && 
                          Math.abs(Number(postCogs.rows[0].total_debit) - Number(postCogs.rows[0].total_credit)) < 0.01;
    const fifoRecordsExist = fifo.rows.length === 2;
    const noExtraReturnIn = returnIns.length <= 2; // Should be 2 (one per restored item)
    
    console.log(`  COGS JE exists: ${cogsJeExists ? '✅' : '❌'}`);
    console.log(`  COGS JE balanced: ${cogsJeBalanced ? '✅' : '❌'}`);
    console.log(`  FIFO records = 2: ${fifoRecordsExist ? '✅' : '❌'}`);
    console.log(`  Reasonable return_in: ${noExtraReturnIn ? '✅' : '❌'} (${returnIns.length})`);
    
    const allPassed = cogsJeExists && cogsJeBalanced && fifoRecordsExist && noExtraReturnIn;
    console.log(`\n  ${allPassed ? '🎉 ALL TESTS PASSED!' : '❌ SOME TESTS FAILED'}`);
    
    if (!allPassed) {
      console.log('\n🔍 DETAILS:');
      if (!cogsJeExists) console.log('   - Missing COGS JE after edit');
      if (!cogsJeBalanced) console.log('   - COGS JE not balanced (debit ≠ credit)');
      if (!fifoRecordsExist) console.log('   - Missing FIFO consumption records');
      if (!noExtraReturnIn) console.log(`   - Too many return_in movements (${returnIns.length})`);
    }

  } catch (err) {
    console.error('Test error:', err.message);
  } finally {
    await cleanup();
    await client.end();
  }
})();