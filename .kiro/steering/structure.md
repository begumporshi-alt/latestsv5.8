# Project Structure

```
siv4-main/
├── app/
│   ├── (auth)/
│   │   └── login/page.tsx          # Login page (public route)
│   └── (erp)/
│       ├── layout.tsx              # Auth guard + sidebar/header shell (client component)
│       ├── dashboard/page.tsx
│       ├── accounting/
│       │   ├── accounts/           # Chart of accounts + [id] detail
│       │   ├── aging/              # AR/AP aging report
│       │   ├── journal/            # Journal entries
│       │   ├── journal-guide/
│       │   └── payment-methods/
│       ├── crm/                    # Customers + [id] detail
│       ├── delivery/
│       ├── employees/
│       ├── expenses/
│       ├── hr/attendance/
│       ├── inventory/              # Products + [id] detail, movements, transfers, warehouses
│       ├── online-store/
│       ├── projects/
│       ├── purchases/              # POs, GRN, returns
│       ├── quotations/
│       └── reports/                # activity, edit-history, inventory
│
├── components/
│   ├── layout/
│   │   ├── Header.tsx
│   │   └── Sidebar.tsx
│   ├── ui/                         # shadcn/ui components + custom search inputs
│   │   ├── CustomerSearchInput.tsx
│   │   ├── ProductSearchInput.tsx
│   │   ├── SupplierSearchInput.tsx
│   │   ├── ProductFilterDropdown.tsx
│   │   ├── QuickActionDrawer.tsx
│   │   └── AppPagination.tsx
│   ├── BarcodeScannerModal.tsx
│   ├── CollectPaymentModal.tsx
│   ├── DeliveryChallan.tsx
│   ├── EditHistoryPanel.tsx
│   ├── EditInvoiceModal.tsx
│   └── PrintTemplate.tsx
│
├── hooks/
│   ├── use-global-cart.ts          # Cart state for POS/quotation flows
│   └── use-toast.ts
│
├── lib/
│   ├── supabase.ts                 # Supabase client singleton
│   ├── types.ts                    # All shared TypeScript interfaces and types
│   ├── utils.ts                    # cn() utility
│   ├── format.ts                   # formatCurrency, formatRelativeTime, etc.
│   ├── print.ts                    # Print helpers
│   └── unit-utils.ts               # Product unit conversion utilities
│
├── supabase/
│   ├── migrations/                 # Ordered SQL migrations (do not edit manually)
│   └── functions/                  # Supabase Edge Functions (if any)
│
└── public/                         # Static assets
```

## Key Conventions

**Routing:** Next.js App Router with route groups. `(auth)` is public; `(erp)` requires authentication enforced in `layout.tsx` via `supabase.auth.getSession()`.

**Pages:** Every page is a `'use client'` component. Data is fetched directly with the Supabase client inside `useEffect` on mount. No server components or server actions are used.

**Types:** All shared types live in `lib/types.ts`. Import from there — do not redefine types inline in pages.

**Components:** 
- Shadcn/ui primitives live in `components/ui/` — extend but don't modify the base primitives
- Feature-specific modals and panels live in `components/` root
- `components/layout/` is only for the shell (Sidebar, Header)

**Database Schema:** Defined by SQL migrations in `supabase/migrations/`. Key tables: `invoices`, `invoice_items`, `products`, `inventory_items`, `customers`, `suppliers`, `purchase_orders`, `payments`, `journal_entries`, `journal_lines`, `accounts`, `activity_logs`. Accounting logic runs in DB triggers — don't replicate it in the frontend.

**New pages** should follow the pattern: `app/(erp)/<module>/page.tsx` with `'use client'`, a loading state, and data fetched via `supabase.from(...)` in `useEffect`.
