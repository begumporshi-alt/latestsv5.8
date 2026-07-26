# Product Overview

**SI Building ERP** is a multi-module, web-based ERP system built for a building materials/sanitary products business. It manages the full business lifecycle from procurement to sales, accounting, and delivery.

## Core Modules

- **Dashboard** — KPI overview, sales charts, low-stock alerts, recent activity
- **Sales (Invoices)** — POS and credit sales, invoice editing/cancellation, edit history, bad debt support
- **Quotations** — Quote lifecycle (draft → sent → accepted → converted to invoice)
- **Purchases (POs)** — Purchase orders, GRN (goods received notes), purchase returns
- **Inventory** — Multi-warehouse stock, product variants (colors, sizes, multi-unit), stock movements, transfers
- **CRM** — Customer profiles, outstanding balances, store credit, advances
- **Accounting** — Double-entry journal, chart of accounts, aging reports, payment methods, automated journal triggers via Supabase DB functions
- **Delivery** — Delivery challan, delivery status tracking
- **HR / Attendance** — Employee records, attendance tracking
- **Reports** — Activity logs, edit history, inventory reports
- **Online Store** — B2C storefront orders accessible to anonymous/store_customer roles

## Business Context

- Currency is BDT (Bangladeshi Taka, symbol ৳)
- Multi-tenant architecture via `tenant_id` on profiles
- Role-based access: `super_admin`, `manager`, `sales_executive`, `inventory_manager`, `accountant`, `delivery_staff`, `customer_portal`, `store_customer`
- Most accounting automation (COGS, receivables, payables, journal entries) runs via Supabase PostgreSQL triggers and RPC functions — not in application code
