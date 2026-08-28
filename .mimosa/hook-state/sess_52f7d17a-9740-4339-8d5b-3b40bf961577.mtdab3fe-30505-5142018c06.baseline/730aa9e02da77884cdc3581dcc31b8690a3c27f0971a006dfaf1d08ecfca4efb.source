import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// Restore order: dependencies first (no FK violations)
const RESTORE_ORDER = [
  // Reference / lookup tables
  "unit_types",
  "warehouses",
  "categories",
  "brands",
  "payment_methods",
  "accounts",
  "app_settings",
  // People
  "profiles",
  "employees",
  "customers",
  "suppliers",
  // Products
  "products",
  "product_colors",
  "product_sizes",
  "product_units",
  "product_variants",
  "inventory_items",
  "stock_movements",
  "warranty_records",
  // Sales
  "invoices",
  "invoice_items",
  "deliveries",
  "delivery_items",
  "payments",
  "sales_returns",
  "sales_return_items",
  "customer_store_credits",
  "store_credit_redemptions",
  // Purchases
  "purchase_orders",
  "purchase_order_items",
  "goods_receipt_notes",
  // Accounting
  "journal_entries",
  "journal_lines",
  // Quotations & Projects
  "quotations",
  "quotation_items",
  "projects",
  "project_tasks",
  // Online
  "online_orders",
  "online_order_items",
  // CRM / HR
  "customer_notes",
  "attendance",
  "activity_logs",
];

// Tables we do NOT truncate (reference data managed elsewhere or risk FK cycles)
const SKIP_TRUNCATE = new Set(["profiles"]);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } }
    );

    const body = await req.json();
    const backupData: Record<string, any[]> = body.data || body.database?.tables || {};

    if (!backupData || typeof backupData !== "object") {
      return new Response(
        JSON.stringify({ error: "Invalid backup format. Expected { data: { table: rows[] } }" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const results: Record<string, { deleted: number; inserted: number; error?: string }> = {};
    const errors: string[] = [];

    // Disable triggers temporarily to avoid accounting side-effects during restore
    // We process in dependency order to avoid FK violations
    for (const table of RESTORE_ORDER) {
      const rows = backupData[table];
      if (!rows || rows.length === 0) {
        results[table] = { deleted: 0, inserted: 0 };
        continue;
      }

      try {
        // Delete existing rows (skip tables that shouldn't be wiped)
        let deleted = 0;
        if (!SKIP_TRUNCATE.has(table)) {
          const { count } = await supabase
            .from(table)
            .delete()
            .neq("id", "00000000-0000-0000-0000-000000000000")
            .select("*", { count: "exact", head: true });
          deleted = count || 0;
        }

        // Insert in batches of 500
        let inserted = 0;
        const BATCH = 500;
        for (let i = 0; i < rows.length; i += BATCH) {
          const batch = rows.slice(i, i + BATCH);
          const { error } = await supabase
            .from(table)
            .upsert(batch, { onConflict: "id", ignoreDuplicates: false });
          if (error) throw new Error(error.message);
          inserted += batch.length;
        }

        results[table] = { deleted, inserted };
      } catch (err: any) {
        results[table] = { deleted: 0, inserted: 0, error: err.message };
        errors.push(`${table}: ${err.message}`);
      }
    }

    const totalInserted = Object.values(results).reduce((s, r) => s + r.inserted, 0);
    const tablesFailed = errors.length;

    return new Response(
      JSON.stringify({
        success: tablesFailed === 0,
        stats: {
          tables_restored: RESTORE_ORDER.length - tablesFailed,
          tables_failed: tablesFailed,
          total_rows_inserted: totalInserted,
        },
        results,
        ...(errors.length > 0 && { errors }),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
