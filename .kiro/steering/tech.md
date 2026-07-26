# Tech Stack

## Core Framework
- **Next.js 13.5.1** — App Router, all pages use the `app/` directory
- **React 18.2** with TypeScript 5.2
- All pages and layout components use `'use client'` — this is a client-side rendered app (no RSC data fetching)

## Backend / Database
- **Supabase** (`@supabase/supabase-js ^2.58`) — Postgres database, Auth, Row-Level Security (RLS)
- Single shared client exported from `lib/supabase.ts`
- All DB access is via `supabase.from(...)` queries directly in page components
- Heavy use of Supabase **PostgreSQL triggers and RPC functions** for accounting automation — avoid replicating this logic in the frontend
- Environment variables: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`

## UI / Styling
- **Tailwind CSS 3.3** with CSS variables for theming (`tailwind.config.ts`)
- **shadcn/ui** (Radix UI primitives) — component library in `components/ui/`. Use existing components before adding new ones
- `cn()` utility from `lib/utils.ts` (clsx + tailwind-merge) — always use for conditional class merging
- **lucide-react** for icons
- Dark mode support via `next-themes` and `darkMode: ['class']`
- Custom sidebar color tokens: `sidebar-bg`, `sidebar-hover`, `sidebar-active`, `sidebar-text`, `sidebar-textActive`

## Forms & Validation
- **react-hook-form** + **@hookform/resolvers** + **zod** for all form handling and validation

## Charts
- **recharts** for all data visualizations

## Other Notable Libraries
- `date-fns` — date formatting and manipulation
- `sonner` — toast notifications (alongside `use-toast` hook)
- `xlsx` — Excel/CSV export
- `jsbarcode` — barcode generation
- `embla-carousel-react` — carousels

## Deployment
- Deployed on **Netlify** via `@netlify/plugin-nextjs` and `netlify.toml`
- Images are unoptimized (`images: { unoptimized: true }` in `next.config.js`)
- ESLint errors are ignored during builds (`eslint.ignoreDuringBuilds: true`)

## Common Commands

```bash
# Development server (run manually in terminal)
npm run dev

# Production build
npm run build

# Start production server
npm start

# Lint
npm run lint

# Type check (no emit)
npm run typecheck
```

## Path Aliases

Configured in `tsconfig.json` and `components.json`:
- `@/components` → `components/`
- `@/lib` → `lib/`
- `@/hooks` → `hooks/`
- `@/components/ui` → `components/ui/`
