# UI/UX v1 Polish — Batch 5 Report

Branch: `kimi/uiux-v1-polish`  
Batch focus: model-budget / system-health administration, remaining admin/config surfaces, command AI surfaces, and mobile refinements  
Date: 2026-08-24

## Summary

Polished the remaining administrative and AI surfaces so the whole app now shares the same
premium operating-system feel: model-budget policies, system health, business health,
integration gateway, inbound setup/review, employees, catalog, outbox, command analyse/cases/memory,
and the shared `FormField` component. Mobile navigation and topbar behaviour were tightened
without changing layout semantics. No business logic, auth rules, RLS, migrations, API contracts
or server actions were changed.

## Files changed

| Area | Files |
|------|-------|
| Model budgets | `src/app/app/admin/model-budgets/page.tsx` |
| System health | `src/app/app/admin/health/page.tsx`, `src/app/app/command/health/page.tsx` |
| Admin config | `src/app/app/admin/audit/page.tsx`, `src/app/app/admin/integrations/page.tsx`, `src/app/app/admin/departments/page.tsx` |
| Inbound | `src/app/app/admin/inbound-setup/page.tsx`, `src/app/app/admin/inbound-setup/SetupForms.tsx`, `src/app/app/admin/inbound-review/page.tsx`, `src/app/app/admin/inbound-review/ReviewRow.tsx` |
| Staff & catalog | `src/app/app/admin/employees/page.tsx`, `src/app/app/admin/employees/CreateEmployeeForm.tsx`, `src/app/app/admin/catalog/page.tsx`, `src/app/app/admin/catalog/AddProductForm.tsx` |
| Command AI | `src/app/app/command/analyze/page.tsx`, `src/app/app/command/analyze/AnalyzeForm.tsx`, `src/app/app/command/cases/page.tsx`, `src/app/app/command/memory/page.tsx` |
| Outbox | `src/app/app/admin/outbox/page.tsx` |
| Shared components | `src/components/ui/Card.tsx` (added `style` and `CardBody` `padding` props), `src/components/ui/FormField.tsx` (clone child with label id + ARIA descriptors) |
| Mobile shell | `src/app/globals.css` (topbar wrap/min-width, nav scroll-snap, scrollbar hide) |

## Verification

- `npm run typecheck` ✓
- `npm run lint` ✓ (only pre-existing `<img>` warnings)
- Focused tests: 11 files, 69 tests passed
  - `tests/campaign/ui-rendered-truthfulness.test.ts`
  - `tests/campaign/analyze-ui-truthfulness.test.ts`
  - `tests/campaign/inbound-review-surface.test.ts`
  - `tests/campaign/int-001-integration-gateway.test.ts`
  - `tests/campaign/mem-001-organizational-memory.test.ts`
  - `tests/model-budget-policy-action.test.ts`
  - `tests/outbox.test.ts`
  - `tests/health.test.ts`
  - `tests/health-signals.test.ts`
  - `tests/audit-format.test.ts`
  - `tests/campaign/sch-001-ai-monitor-surface.test.ts`

## Screenshots

All changed screens in this batch require authentication. Public-page before/after shots at
390px, 768px and 1440px were captured via `scripts/verify/ui-screenshots.mjs`:

- `screenshots/uiux-v1/batch5-before/*`
- `screenshots/uiux-v1/batch5-after/*`

Public pages are unchanged in this batch, so the before/after pairs are identical and confirm no
regression. Authenticated admin/health/model-budget pages cannot be screenshotted locally because no
local Supabase instance with seeded users is configured; this is a known limitation carried forward
from earlier batches.

## Self-review notes

- All admin and command pages now use the shared `Card`/`CardHeader`/`CardBody`/`EmptyState`/`DataTable`/`Badge`/`StatusBadge`/`Button`/`FormField` vocabulary.
- Dates and numbers use the central `fmtDate`/`fmtDateTime`/`fmtNumber` helpers; money continues to use `fmtMoney`.
- `FormField` now clones a single child element so `<select>` controls inside it get the correct `id`, label association and ARIA descriptors.
- Mobile nav strip gained `scroll-snap-type` and hidden scrollbars; topbar gained `min-width: 0` and wrapping so long department labels do not force horizontal overflow.
- Permission-denied notices were preserved verbatim.
- No server actions, form `name`s, data queries or financial calculations were changed.
