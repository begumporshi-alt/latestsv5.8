/**
 * Guard: an RPC's replica declaration must cover every table its SQL writes.
 *
 * `RPC_TABLES` in lib/offline/write-refresh.ts decides which replica tables
 * converge after an RPC call. An RPC that writes a table it does not declare
 * leaves the device copy stale, and nothing reports it: the local read keeps
 * returning the pre-write row until some unrelated cycle happens to refresh
 * that table. Two production bugs came from exactly this —
 *
 *   - `receive_grn` rewrites `product_units` (the per-unit sale prices the POS
 *     tile renders for a multi-unit product) but only `products` was declared,
 *     so a new sale price stayed on the old figure until the POS's own
 *     ten-minute replica cycle refreshed the table;
 *   - a POS sale deducts stock through a trigger on `invoice_items`, which no
 *     `.from()` write could ever name.
 *
 * The second case cannot be read out of the SQL (it lives in a trigger), but
 * the first can: the function body names the tables it touches. This test
 * parses the newest definition of each mapped RPC out of supabase/migrations
 * and fails when a written table is missing from the declaration.
 *
 * When a migration adds a table to an RPC, add it here with the replica name
 * the app uses, then declare it in RPC_TABLES. If the table is not replicated
 * at all, list it in NOT_REPLICATED instead — the test then skips it.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { RPC_TABLES } from '../write-refresh';

// write-refresh imports the replica module lazily; the routing decision is not
// what this suite tests, so it is stubbed to keep the import graph light.
jest.mock('../replica', () => ({
  REPLICA: {},
  REPLICA_BY_TABLE: {},
  refreshReplicaTables: jest.fn(async () => {}),
  replicateAll: jest.fn(async () => {}),
}));

const MIGRATIONS_DIR = join(__dirname, '../../../supabase/migrations');

/** Postgres table → the name RPC_TABLES / REPLICA use for it. */
const REPLICA_NAME: Record<string, string> = {
  accounts: 'Accounts',
  goods_receipt_notes: 'Goods receipt notes',
  inventory_batches: 'Inventory batches',
  inventory_items: 'Stock counters',
  journal_entries: 'Journal entries',
  journal_lines: 'Journal lines',
  product_units: 'Product units',
  products: 'Products',
  purchase_order_items: 'Purchase order items',
  purchase_orders: 'Purchase orders',
  purchase_reminders: 'Purchase reminders',
  stock_movements: 'Stock movements',
};

/** Tables an RPC writes that the replica does not track — nothing to declare. */
const NOT_REPLICATED = new Set<string>([]);

/** Words that can follow INSERT INTO / UPDATE in SQL but are not tables. */
const NOT_A_TABLE = new Set([
  'conflict', 'for', 'from', 'if', 'into', 'loop', 'on', 'only', 'returning',
  'select', 'set', 'table', 'then', 'the', 'using', 'values', 'where',
]);

/** Strip comments first: prose mentions tables in prose, not in statements. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * The body of the NEWEST definition of `name` across all migrations. Migrations
 * are applied in filename order, so the last file that (re)defines the function
 * is the one in force.
 */
function latestFunctionBody(name: string): { file: string; body: string } {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const header = new RegExp(`FUNCTION public\\.${name}\\b`);
  let found: { file: string; body: string } | null = null;

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const at = sql.search(header);
    if (at < 0) continue;
    // The body is dollar-quoted (`AS $function$ … $function$`).
    const tag = sql.slice(at).match(/\$([a-zA-Z_]*)\$/);
    if (!tag) continue;
    const start = at + tag.index! + tag[0].length;
    const end = sql.indexOf(`${tag[0]};`, start);
    found = { file, body: sql.slice(start, end < 0 ? sql.length : end) };
  }

  if (!found) throw new Error(`no migration defines public.${name}`);
  return found;
}

/** Tables a function body inserts into, updates or deletes from. */
function writtenTables(body: string): string[] {
  const re = /(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE)\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi;
  const tables = new Set<string>();
  let match: RegExpExecArray | null;
  const sql = stripComments(body);
  while ((match = re.exec(sql))) {
    const table = match[1].toLowerCase();
    if (!NOT_A_TABLE.has(table)) tables.add(table);
  }
  return [...tables].sort();
}

describe('RPC replica declarations', () => {
  // Generators declare [] because they only advance a sequence.
  const mapped = Object.keys(RPC_TABLES).filter((rpc) => RPC_TABLES[rpc].length > 0);

  it.each(mapped)('declares every table %s writes', (rpc) => {
    const { file, body } = latestFunctionBody(rpc);
    const tables = writtenTables(body);
    const declared = new Set(RPC_TABLES[rpc]);

    const unmapped = tables.filter((t) => !REPLICA_NAME[t] && !NOT_REPLICATED.has(t));
    expect({ file, unmapped }).toEqual({ file, unmapped: [] });

    const missing = tables
      .filter((t) => REPLICA_NAME[t] && !declared.has(REPLICA_NAME[t]))
      .map((t) => `${t} → ${REPLICA_NAME[t]}`);

    // A failure here means the device copy of those tables keeps its pre-write
    // rows after this RPC until an unrelated cycle refreshes it.
    expect({ file, missing }).toEqual({ file, missing: [] });
  });

  it('reads the GRN price tables it needs to keep the POS tile current', () => {
    const { body } = latestFunctionBody('receive_grn');
    const tables = writtenTables(body);

    // The two price sources the POS gallery renders from: the master row for a
    // single-unit product, and the per-unit rows for a multi-unit one.
    expect(tables).toEqual(expect.arrayContaining(['products', 'product_units']));
    expect(RPC_TABLES.receive_grn).toEqual(
      expect.arrayContaining([REPLICA_NAME.products, REPLICA_NAME.product_units]),
    );
  });
});
