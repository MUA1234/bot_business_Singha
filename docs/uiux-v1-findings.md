# UI/UX v1 Polish — Findings Register

Branch: `kimi/uiux-v1-polish`  
Base SHA: `22bf41b0f963735ae20d14dd0d1affdeb4f35e61`  
Date: 2026-08-23

## 1. Scope & constraints

This register records the baseline audit before any UI/UX changes are made. The polish programme must:

- Only touch presentational UI code (components, styles, layouts, client navigation, animations).
- Not modify database migrations, security/RLS, financial controls, authority rules, API contracts or verified business logic.
- Not merge, deploy, enable flags, contact hosted services or change production data.
- Preserve the existing "Agentic OS" dark theme and living-background style.

## 2. Route inventory

The app contains **117 `page.tsx` routes** under `src/app`:

- **Public (6):** `/`, `/login`, `/privacy`, `/terms`, `/data-deletion`, `/q/[token]`
- **Authenticated shell (`/app/*`):**
  - Shared: `/app`, `/app/me`, `/app/notifications`, `/app/messages`, `/app/messages/[id]`, `/app/portfolio`
  - Admin: `/app/admin` + 13 sub-routes
  - Command: `/app/command` + 4 sub-routes
  - Finance: `/app/finance` + 30 sub-routes
  - Sales: `/app/sales` + 9 sub-routes
  - Operations: `/app/operations` + 3 sub-routes
  - HR: `/app/hr` + 4 sub-routes
  - Procurement: `/app/procurement` + 7 sub-routes
  - Legal: `/app/legal` + 8 sub-routes
  - Fleet: `/app/fleet` + 3 sub-routes
  - Marketing: `/app/marketing` + 3 sub-routes

All department pages gate via `requireDepartment(key)` or `requireAdmin()`. Admins can view every department. Middleware only enforces login for `/app/*`.

## 3. Baseline strengths

1. Coherent dark "Agentic OS" theme in `src/app/globals.css` with CSS custom properties for brand, surfaces, text and semantic states.
2. Strong foundational primitives: `.card`, `.btn`, `.input`, `.badge`, `.table-wrap` + `table.data`, `.stat`, grid helpers, shell layout, safe-area handling and `prefers-reduced-motion`.
3. Living background is performant, self-contained, poster-first and respects reduced motion.
4. Typography uses fluid `clamp()` sizing; grids collapse responsively.
5. Most dashboards already use stat tiles and quick-link cards.

## 4. Concrete findings

### 4.1 Missing shared components

| Missing component | Impact |
|-------------------|--------|
| `<Button>` | Every page rebuilds buttons; no unified loading, disabled, or pending states. |
| `<Card>` with header/body/footer | Cards are raw `div.card`; inconsistent padding and headers. |
| `<Badge>` / `<StatusBadge>` | Status maps are duplicated page by page; colours drift. |
| `<EmptyState>` | Many pages use a bare `<div class="empty">` with no action. |
| `<Skeleton>` / `<SkeletonTable>` | No loading placeholders; Next.js default white flash is used. |
| `<DataTable>` | Tables are hand-rolled; sorting, pagination and empty states vary. |
| `<ConfirmDialog>` | Destructive actions lack a confirmation pattern. |
| `<Breadcrumb>` | Deep detail pages have no way back except browser. |
| `<SearchInput>` | No shared search/filter input with clear button. |
| `<FormField>` | Labels, hints and errors are repeated inline. |

### 4.2 No route-level UX boundaries

| File | Status | Impact |
|------|--------|--------|
| `src/app/app/loading.tsx` | Missing | Authenticated shell flashes while data loads. |
| `src/app/app/error.tsx` | Missing | Server errors fall back to generic Next.js error page. |
| `src/app/not-found.tsx` | Missing | `notFound()` renders plain Next.js 404. |
| Per-route `loading.tsx` | Missing | Every page shows the same unbranded loading state. |

### 4.3 Navigation & shell gaps

1. `AppShell` nav links have no `aria-current` attribute; active state is visual only.
2. Sidebar collapses to a horizontal scroll strip below 820px, which hides labels on very small screens and is not thumb-friendly.
3. Topbar shows only department badge and user avatar; no global search, no notification badge, no breadcrumbs.
4. No focus-visible styles for `.nav-item`, `.card` links or `.dept-chip`.
5. User avatar is just the first letter with no accessible name/role announcement.

### 4.4 Dashboard inconsistencies

1. Stat tile value sizes vary across departments (`1.5rem`, `1.8rem`, `1.9rem`).
2. Some dashboards show `0` with no contextual empty guidance (e.g., HR "Overloaded").
3. Simple home pages (`/app/procurement`, `/app/legal`, `/app/marketing`, `/app/hr`) show only a header and empty grid.
4. Quick-link card grids use inconsistent icon sizes and gap classes.
5. Chart components have no loading, empty or error states.

### 4.5 List & table gaps

1. Tables mix inline numeric alignment with no shared `.num`/`.money` cell style.
2. Date/time formatting is inconsistent (`toLocaleString`, `toLocaleDateString`, raw ISO).
3. Many list pages silently swallow DB errors and show an empty table instead of a recoverable error message.
4. Action buttons inside tables are small and lack focus rings.
5. Some tables may not be wrapped in `.table-wrap` (needs per-page verification).

### 4.6 Detail & form gaps

1. Long detail pages (task, project, vehicle) have no sticky progress/step indicator or collapsible sections.
2. Task detail mixes many adjacent forms with visually identical buttons ("Log", "Add", "Upload", "Save"), increasing mis-click risk.
3. `datalist` is used for account selection in journal forms — poor on mobile, no validation.
4. Phone input has no visible `<label htmlFor>` association.
5. Form error/success notices are not tied to `aria-live` regions.

### 4.7 Mobile gaps

1. Landing hero collapses at 900px but text and device panel sit cramped at medium widths.
2. Chat/conversation layout is not mobile-optimised: fixed `maxWidth: 78%` and no viewport-based padding reduction.
3. Table actions have small touch targets.
4. Form rows with `wrap` and fixed-width inputs can overflow on 320–390px screens.

### 4.8 Accessibility gaps

1. `Brand` wordmark variant has no accessible text.
2. Tables lack `<caption>`, `scope` and row headers.
3. Chat bubbles have no `aria-label`, role or list semantics.
4. Status indicators rely partly on colour alone.
5. Icon-only buttons are common but lack `aria-label`.
6. No skip-to-content link.

## 5. Batched remediation plan

| Batch | Focus | Expected deliverables |
|-------|-------|----------------------|
| 1 | Design-system foundation | Shared components (`Button`, `Card`, `Badge`, `EmptyState`, `Skeleton`, `DataTable`, `FormField`, `SearchInput`); `globals.css` focus-visible utilities; `src/app/app/loading.tsx`; `src/app/not-found.tsx`; `src/app/global-error.tsx`. |
| 2 | Shell, navigation & search | `AppShell` mobile bottom-bar option, `aria-current`, focus rings, global search placeholder, notification badge, user menu, skip link. |
| 3 | Dashboards | Polish owner/CEO, Command, Finance, HR, Sales, Operations, Procurement, Legal, Fleet, Marketing home pages; consistent stat tiles and empty states. |
| 4 | Lists & tables | Convert representative list pages to shared `DataTable`; add loading/error/empty states; standardise date/money formatting helpers. |
| 5 | Detail & forms | Improve task, project, vehicle, employee, invoice, bill detail pages; add breadcrumbs; improve form hierarchy and mobile stacking. |
| 6 | Final sweep & verification | Run full `npm run verify`; browser screenshots at 390/768/1440px; self-review; corrections; completion report. |

## 6. Risk & limitation notes

- Authenticated screenshots require a running dev server and valid test credentials. The audit captured static structure; runtime authenticated states will be validated as far as the local environment permits.
- The programme will not create or modify business data, so some empty-state screenshots will naturally show zero counts.
- Any page whose business logic is protected by unreleased migrations or hosted-DB state will be noted as a provider/staging limitation rather than modified.
