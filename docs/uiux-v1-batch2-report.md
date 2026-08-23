# UI/UX v1 Polish — Batch 2 Report

Branch: `kimi/uiux-v1-polish`  
Batch focus: Executive cockpit + AI alerts/approvals  
Date: 2026-08-24

## Summary

Polished the owner/admin executive cockpit, AI-driven command centre, management
directives/objectives, personal workspace, notifications and finance approvals.
Shared UI components and the date formatter are now used consistently across
these surfaces. No business logic, auth rules, RLS, migrations or API contracts
were changed.

## Files changed

| Path | Change |
|------|--------|
| `src/lib/format.ts` | New shared date/time/number formatter (`fmtDate`, `fmtDateTime`, `fmtRelativeDays`, `fmtNumber`). |
| `src/components/Icon.tsx` | Added `alert-triangle`, `check-circle-2` icons used by empty states. |
| `src/components/ui/index.ts` | Re-exported `StatusBadge` and `DataTableColumn`. |
| `src/app/app/admin/page.tsx` | Cards for stat tiles and nav links; `fmtNumber` for counts. |
| `src/app/app/command/page.tsx` | `Card`/`CardHeader`/`CardBody`, `Badge`, `EmptyState`, `fmtNumber`, mobile-wrapped top actions. |
| `src/app/app/portfolio/page.tsx` | Replaced hand-rolled table with `DataTable`; `EmptyState`; `fmtNumber`. |
| `src/app/app/admin/objectives/page.tsx` | `Card`, `FormField`, `DataTable`, `Badge`, `EmptyState`, `fmtDate`, `fmtNumber`. |
| `src/app/app/admin/directives/page.tsx` | `Card`, `FormField`, `DataTable`, `Badge`, `EmptyState`, `fmtDateTime`, `fmtNumber`. |
| `src/app/app/me/page.tsx` | `Card`, `CardHeader`, `EmptyState`, `Badge`, `FormField`, `fmtDate`, `fmtNumber`. |
| `src/app/app/notifications/page.tsx` | `Card`, `CardHeader`, `CardBody`, `Button`, `EmptyState`, `fmtDateTime`. |
| `src/app/app/finance/approvals/page.tsx` | `Card`, `DataTable`, `Button`, `Badge`, `StatusBadge`, `fmtDateTime`; fixed reject button variant. |

## Verification

- `npm run typecheck` ✓
- `npm run lint` ✓ (only pre-existing `<img>` warnings)
- Focused tests: 8 files, 62 tests passed
  - `tests/campaign/prj-002-objectives-surface.test.ts`
  - `tests/campaign/gov-001-management-directives.test.ts`
  - `tests/campaign/gov-003-conflicting-directives.test.ts`
  - `tests/campaign/gov-005-approval-sod.test.ts`
  - `tests/portfolio.test.ts`
  - `tests/portfolio-prioritisation.test.ts`
  - `tests/task-progress.test.ts`
  - `tests/availability.test.ts`

## Screenshots

All pages in this batch require an authenticated session. The local environment does
not have a configured Supabase instance with seeded users, so authenticated
screenshots could not be captured for this batch.

Public pages that were unchanged visually in this batch continue to use the
screenshots captured in Batch 1 (`screenshots/uiux-v1/after/landing-*`,
`screenshots/uiux-v1/after/login-*`, etc.).

The screenshot harness (`scripts/verify/ui-screenshots.mjs`) is ready to capture
authenticated pages once a test user/session is available locally.

## Self-review notes

- All shared component imports compile under strict TypeScript.
- Status badge colours are preserved semantically (critical/danger, warn, info, ok).
- No server actions, form field `name`s, or data queries were altered.
- Mobile stacking improved on directive forms, objective forms, expense/leave forms,
  approval action buttons and notification rows.
- The reject button in approvals now uses `variant="danger"` instead of a non-existent
  `className="danger"`.
