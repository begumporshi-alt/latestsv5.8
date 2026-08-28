import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const ALL_TABLES = [
  "accounts", "activity_logs", "app_settings", "attendance", "brands",
  "categories", "customer_notes", "customer_store_credits", "customers",
  "deliveries", "delivery_items", "employees", "goods_receipt_notes",
  "inventory_items", "invoice_items", "invoices", "journal_entries",
  "journal_lines", "online_order_items", "online_orders", "payment_methods",
  "payments", "product_colors", "product_sizes", "product_units",
  "product_variants", "products", "profiles", "project_tasks", "projects",
  "purchase_order_items", "purchase_orders", "quotation_items", "quotations",
  "sales_return_items", "sales_returns", "stock_movements",
  "store_credit_redemptions", "suppliers", "unit_types", "warehouses",
  "warranty_records",
];

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

    // Fetch all table data in parallel (batched to avoid rate limits)
    const tableData: Record<string, any[]> = {};
    const tableErrors: Record<string, string> = {};

    const BATCH = 8;
    for (let i = 0; i < ALL_TABLES.length; i += BATCH) {
      const batch = ALL_TABLES.slice(i, i + BATCH);
      const results = await Promise.all(
        batch.map(async (table) => {
          const { data, error } = await supabase.from(table).select("*").limit(50000);
          return { table, rows: data || [], error: error?.message };
        })
      );
      for (const { table, rows, error } of results) {
        tableData[table] = rows;
        if (error) tableErrors[table] = error;
      }
    }

    // Fetch schema: column definitions from information_schema
    const { data: columnsData } = await supabase
      .from("information_schema.columns" as any)
      .select("table_name, column_name, data_type, column_default, is_nullable, character_maximum_length")
      .eq("table_schema", "public")
      .order("table_name")
      .order("ordinal_position");

    // Fetch RLS policies
    const { data: policiesData } = await supabase
      .from("pg_policies" as any)
      .select("schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check")
      .eq("schemaname", "public");

    // Fetch table constraints (foreign keys, primary keys)
    const { data: constraintsData } = await supabase
      .from("information_schema.table_constraints" as any)
      .select("table_name, constraint_name, constraint_type")
      .eq("constraint_schema", "public");

    const backup = {
      version: "2.0",
      created_at: new Date().toISOString(),
      stats: {
        tables_exported: ALL_TABLES.length,
        total_rows: Object.values(tableData).reduce((sum, rows) => sum + rows.length, 0),
        tables_with_errors: Object.keys(tableErrors).length,
        per_table: Object.fromEntries(
          ALL_TABLES.map((t) => [t, tableData[t]?.length ?? 0])
        ),
      },
      schema: {
        columns: columnsData || [],
        rls_policies: policiesData || [],
        constraints: constraintsData || [],
      },
      data: tableData,
      ...(Object.keys(tableErrors).length > 0 && { errors: tableErrors }),
    };

    const filename = `erp-backup-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`;

    return new Response(JSON.stringify(backup, null, 2), {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
