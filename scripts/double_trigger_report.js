#!/usr/bin/env node
// Double Trigger Issue - Full Analysis Report
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

(async () => {
  await client.connect();
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║        DOUBLE TRIGGER ISSUE — FULL ANALYSIS REPORT          ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // ── SECTION 1: TRIGGER MAP ──────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  SECTION 1: CURRENT TRIGGER MAP');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const { rows: allTriggers } = await client.query(`
    SELECT 
      c.relname as table_name,
      t.tgname as trigger_name,
      p.proname as function_name,
      CASE 
        WHEN t.tgtype & 2 = 2 THEN 'BEFORE'
        WHEN t.tgtype & 4 = 4 THEN 'AFTER'
        ELSE 'INSTEAD OF'
      END as timing,
      CASE 
        WHEN t.tgtype & 8 = 8 THEN 'INSERT'
        WHEN t.tgtype & 16 = 16 THEN 'DELETE'
        WHEN t.tgtype & 20 = 20 THEN 'INSERT OR DELETE'
        WHEN t.tgtype & 4 = 4 THEN 'UPDATE'
        ELSE 'OTHER'
      END as event
    FROM pg_trigger t
    JOIN pg_class c ON t.tgrelid = c.oid
    JOIN pg_proc p ON t.tgfoid = p.oid
    WHERE NOT t.tgisinternal
    AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
    ORDER BY c.relname, t.tgname
  `);

  const byTable = {};
  allTriggers.forEach(t => {
    if (!byTable[t.table_name]) byTable[t.table_name] = [];
    byTable[t.table_name].push(t);
  });

  for (const [table, trigs] of Object.entries(byTable)) {
    console.log(`  📋 ${table} (${trigs.length} triggers)`);
    trigs.forEach(t => {
      const isCOGS = t.function_name.includes('cogs');
      const isStock = t.function_name.includes('deduct') || t.function_name.includes('stock');
      const marker = isCOGS ? ' ⚠️ COGS' : isStock ? ' ⚠️ STOCK' : '';
      console.log(`     ${t.timing} ${t.event} → ${t.function_name}${marker}`);
    });
    console.log('');
  }

  // ── SECTION 2: STOCK DEDUCTION ANALYSIS ─────────────────────
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  SECTION 2: STOCK DEDUCTION ANALYSIS');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const { rows: stockAnalysis } = await client.query(`
    SELECT 
      i.invoice_number,
      i.status,
      i.invoice_date::date as sale_date,
      i.total_amount,
      (SELECT COUNT(*) FROM invoice_items WHERE invoice_id = i.id) as item_count,
      COUNT(DISTINCT sm.id) as movement_count,
      SUM(ABS(sm.quantity)) as total_qty_deducted,
      COUNT(DISTINCT sm.id) - (SELECT COUNT(*) FROM invoice_items WHERE invoice_id = i.id) as excess_movements,
      ROUND(
        (COUNT(DISTINCT sm.id)::numeric / NULLIF((SELECT COUNT(*) FROM invoice_items WHERE invoice_id = i.id), 0))::numeric, 1
      ) as deduction_multiplier
    FROM invoices i
    JOIN stock_movements sm ON sm.reference_id = i.id 
      AND sm.reference_type = 'invoice' 
      AND sm.movement_type = 'sale'
    WHERE i.status != 'cancelled'
    GROUP BY i.id, i.invoice_number, i.status, i.invoice_date, i.total_amount
    HAVING COUNT(DISTINCT sm.id) > (SELECT COUNT(*) FROM invoice_items WHERE invoice_id = i.id)
    ORDER BY excess_movements DESC
  `);

  console.log(`  Invoices with EXTRA stock deductions: ${stockAnalysis.length}\n`);
  
  let totalExcessQty = 0;
  let totalExcessMovements = 0;

  console.log('  ┌──────────────────┬──────────┬────────────┬──────────┬──────────┬──────────┬───────────┐');
  console.log('  │ Invoice          │ Status   │ Date       │ Items    │ Movements│ Excess   │ Multiplier│');
  console.log('  ├──────────────────┼──────────┼────────────┼──────────┼──────────┼──────────┼───────────┤');
  
  stockAnalysis.forEach(s => {
    totalExcessMovements += Number(s.excess_movements);
    const excessQty = Number(s.total_qty_deducted) - Number(s.item_count) * 1; // approximate
    totalExcessQty += Number(s.excess_movements);
    console.log(`  │ ${s.invoice_number.padEnd(16)} │ ${s.status.padEnd(8)} │ ${String(s.sale_date).substring(0,10)} │ ${String(s.item_count).padStart(8)} │ ${String(s.movement_count).padStart(8)} │ ${String(s.excess_movements).padStart(8)} │ ${String(s.deduction_multiplier).padStart(9)}x │`);
  });
  
  console.log('  └──────────────────┴──────────┴────────────┴──────────┴──────────┴──────────┴───────────┘');
  console.log(`\n  Total excess stock movements: ${totalExcessMovements}`);
  console.log(`  Affected invoices: ${stockAnalysis.length}`);

  // ── SECTION 3: COGS DOUBLE POSTING ──────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  SECTION 3: COGS DOUBLE POSTING ANALYSIS');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const { rows: cogsAnalysis } = await client.query(`
    SELECT 
      i.invoice_number,
      i.status,
      i.invoice_date::date as sale_date,
      i.total_amount,
      COUNT(DISTINCT je.id) as total_journals,
      COUNT(DISTINCT CASE WHEN je.description LIKE 'COGS%' AND je.description NOT LIKE '%reconciliation%' THEN je.id END) as cogs_entries,
      SUM(CASE WHEN je.description LIKE 'COGS%' AND je.description NOT LIKE '%reconciliation%' THEN je.total_debit ELSE 0 END) as total_cogs_debit,
      (SELECT SUM(total_amount) FROM invoice_items WHERE invoice_id = i.id) as invoice_total
    FROM invoices i
    JOIN journal_entries je ON je.reference_type = 'invoice' AND je.reference_id = i.id
    WHERE i.status != 'cancelled'
    GROUP BY i.id, i.invoice_number, i.status, i.invoice_date, i.total_amount
    HAVING COUNT(DISTINCT CASE WHEN je.description LIKE 'COGS%' AND je.description NOT LIKE '%reconciliation%' THEN je.id END) > 1
    ORDER BY cogs_entries DESC
  `);

  console.log(`  Invoices with DUPLICATE COGS journals: ${cogsAnalysis.length}\n`);
  
  let totalExcessCOGS = 0;

  console.log('  ┌──────────────────┬──────────┬────────────┬──────────┬──────────┬──────────────────┐');
  console.log('  │ Invoice          │ Status   │ Date       │ COGS #   │ COGS amt │ Excess COGS      │');
  console.log('  ├──────────────────┼──────────┼────────────┼──────────┼──────────┼──────────────────┤');
  
  cogsAnalysis.forEach(c => {
    // First COGS entry is correct, rest are duplicates
    const excessCOGS = Number(c.total_cogs_debit) - (Number(c.total_cogs_debit) / Number(c.cogs_entries));
    totalExcessCOGS += excessCOGS;
    console.log(`  │ ${c.invoice_number.padEnd(16)} │ ${c.status.padEnd(8)} │ ${String(c.sale_date).substring(0,10)} │ ${String(c.cogs_entries).padStart(8)} │ ৳${String(Math.round(Number(c.total_cogs_debit))).padStart(13)} │ ৳${String(Math.round(excessCOGS)).padStart(15)} │`);
  });
  
  console.log('  └──────────────────┴──────────┴────────────┴──────────┴──────────┴──────────────────┘');
  console.log(`\n  Total EXCESS COGS debited: ৳${Math.round(totalExcessCOGS).toLocaleString()}`);

  // ── SECTION 4: FIFO CONSUMPTION ANALYSIS ────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  SECTION 4: FIFO CONSUMPTION ANALYSIS');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const { rows: fifoAnalysis } = await client.query(`
    SELECT 
      i.invoice_number,
      COUNT(DISTINCT iibc.id) as consumption_records,
      (SELECT COUNT(*) FROM invoice_items WHERE invoice_id = i.id) as item_count,
      SUM(iibc.quantity_consumed) as total_consumed,
      SUM(iibc.cogs_amount) as total_fifo_cogs
    FROM invoices i
    JOIN invoice_item_batch_consumption iibc ON iibc.invoice_item_id IN (
      SELECT id FROM invoice_items WHERE invoice_id = i.id
    )
    WHERE i.status != 'cancelled'
    GROUP BY i.id, i.invoice_number
    HAVING COUNT(DISTINCT iibc.id) > (SELECT COUNT(*) FROM invoice_items WHERE invoice_id = i.id)
    ORDER BY consumption_records DESC
    LIMIT 10
  `);

  console.log(`  Invoices with EXTRA FIFO consumption records: ${fifoAnalysis.length}`);
  if (fifoAnalysis.length > 0) {
    fifoAnalysis.forEach(f => {
      console.log(`    ${f.invoice_number}: ${f.consumption_records} records for ${f.item_count} items (excess: ${f.consumption_records - f.item_count})`);
    });
  } else {
    console.log('  ✅ No duplicate FIFO consumption records found');
  }

  // ── SECTION 5: ENTITY-LEVEL SUMMARY ─────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  SECTION 5: ENTITY-LEVEL IMPACT SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const { rows: [entities] } = await client.query(`
    SELECT 
      (SELECT COUNT(*) FROM invoices WHERE status != 'cancelled') as total_invoices,
      (SELECT COUNT(DISTINCT i.id) FROM invoices i 
       JOIN stock_movements sm ON sm.reference_id = i.id AND sm.reference_type = 'invoice' AND sm.movement_type = 'sale'
       WHERE i.status != 'cancelled'
       GROUP BY i.id HAVING COUNT(DISTINCT sm.id) > (SELECT COUNT(*) FROM invoice_items WHERE invoice_id = i.id)
      ) as invoices_with_double_stock,
      (SELECT SUM(total_debit) FROM journal_entries WHERE description LIKE 'COGS%' AND description NOT LIKE '%reconciliation%') as total_cogs_posted,
      (SELECT SUM(quantity) FROM invoice_items ii JOIN invoices i ON ii.invoice_id = i.id WHERE i.status != 'cancelled') as actual_items_sold,
      (SELECT SUM(ABS(quantity)) FROM stock_movements WHERE movement_type = 'sale') as stock_movements_total
  `);

  console.log('  ┌─────────────────────────────────────────┬──────────────────┐');
  console.log('  │ Metric                                  │ Value            │');
  console.log('  ├─────────────────────────────────────────┼──────────────────┤');
  console.log(`  │ Total invoices                          │ ${String(entities.total_invoices).padStart(16)} │`);
  console.log(`  │ Invoices with double stock deduction    │ ${String(entities.invoices_with_double_stock).padStart(16)} │`);
  console.log(`  │ Stock over-deduction multiplier         │ ${String((Number(entities.stock_movements_total) / Number(entities.actual_items_sold)).toFixed(1) + 'x').padStart(16)} │`);
  console.log(`  │ Total COGS posted (non-reconciliation)  │ ৳${String(Math.round(Number(entities.total_cogs_posted)).toLocaleString()).padStart(14)} │`);
  console.log(`  │ Actual items sold                       │ ${String(Number(entities.actual_items_sold).toLocaleString()).padStart(16)} │`);
  console.log(`  │ Stock movements recorded                │ ${String(Number(entities.stock_movements_total).toLocaleString()).padStart(16)} │`);
  console.log('  └─────────────────────────────────────────┴──────────────────┘');

  // ── SECTION 6: ROOT CAUSE IDENTIFICATION ────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  SECTION 6: ROOT CAUSE IDENTIFICATION');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log('  🔴 BUG #1: Stock Deduction Trigger Has No Idempotency Guard');
  console.log('  ─────────────────────────────────────────────────────────────');
  console.log('  Trigger: trg_deduct_stock_on_invoice_item (AFTER INSERT on invoice_items)');
  console.log('  Problem: Fires on EVERY INSERT — no check if stock was already deducted');
  console.log('  When EditInvoiceModal re-inserts items, stock is deducted again');
  console.log('  Fix: Add guard: IF EXISTS (SELECT 1 FROM stock_movements WHERE reference_id = ...)');
  console.log('');
  
  console.log('  🔴 BUG #2: Two Competing COGS Triggers on invoices');
  console.log('  ─────────────────────────────────────────────────────────────');
  console.log('  Trigger A: trg_invoice_insert_cogs (AFTER INSERT) — posts COGS on INSERT');
  console.log('  Trigger B: trg_invoice_status_cogs (INSTEAD OF UPDATE) — posts COGS on status change');
  console.log('  Problem: When invoice inserted with status=sent, BOTH fire');
  console.log('  Fix: Remove one trigger, keep the other with proper guards');
  console.log('');
  
  console.log('  🟡 BUG #3: FIFO Trigger Fires on Re-insert During Edit');
  console.log('  ─────────────────────────────────────────────────────────────');
  console.log('  Trigger: trg_invoice_items_cogs (AFTER INSERT on invoice_items)');
  console.log('  Has idempotency guard, but guard only prevents DOUBLE consumption');
  console.log('  When old items are deleted and new items inserted, FIFO fires again');
  console.log('  This is actually CORRECT behavior (new items need new consumption)');
  console.log('  The real problem is stock deduction being duplicated');
  console.log('');
  
  console.log('  🟡 BUG #4: edit_invoice RESTORE + RE-INSERT Creates Duplication');
  console.log('  ─────────────────────────────────────────────────────────────');
  console.log('  When editing: old items deleted → stock restored → new items inserted → stock deducted');
  console.log('  If the restore happens but the new insert also fires the trigger,');
  console.log('  the net effect depends on timing and whether restore completes first');
  console.log('  The current flow creates duplicate stock_movements records');

  // ── SECTION 7: RECOMMENDED FIXES ────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  SECTION 7: RECOMMENDED FIXES');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log('  FIX 1: Add idempotency guard to trg_deduct_stock_on_invoice_item');
  console.log('  ─────────────────────────────────────────────────────────────');
  console.log('  Add at the start of the function:');
  console.log('    IF EXISTS (SELECT 1 FROM stock_movements');
  console.log('      WHERE reference_id = NEW.invoice_id');
  console.log('      AND product_id = NEW.product_id');
  console.log('      AND reference_type = \'invoice\'');
  console.log('      AND movement_type = \'sale\') THEN');
  console.log('      RETURN NEW;');
  console.log('    END IF;');
  console.log('');
  
  console.log('  FIX 2: Remove trg_invoice_insert_cogs (keep trg_invoice_status_cogs)');
  console.log('  ─────────────────────────────────────────────────────────────');
  console.log('  The INSERT trigger posts COGS immediately on creation');
  console.log('  The STATUS trigger handles the draft→sent transition properly');
  console.log('  Keep only the STATUS trigger to avoid double-posting');
  console.log('');
  
  console.log('  FIX 3: Add unique constraint to prevent duplicate stock_movements');
  console.log('  ─────────────────────────────────────────────────────────────');
  console.log('  CREATE UNIQUE INDEX idx_sm_no_dup ON stock_movements');
  console.log('    (reference_id, product_id, reference_type, movement_type)');
  console.log('  WHERE movement_type = \'sale\';');
  console.log('');
  
  console.log('  FIX 4: Cleanup migration to reverse duplicate entries');
  console.log('  ─────────────────────────────────────────────────────────────');
  console.log('  DELETE duplicate stock_movements (keep earliest per invoice+product)');
  console.log('  DELETE duplicate COGS journal entries (keep first per invoice)');
  console.log('  Restore stock to correct levels');

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  END OF REPORT');
  console.log('═══════════════════════════════════════════════════════════════\n');

  await client.end();
})().catch(err => console.error('Error:', err));
