# UI/UX v1 Polish — Batch 3 Report

Branch: `kimi/uiux-v1-polish`  
Batch focus: Staff, workload, performance and leave  
Date: 2026-08-24

## Summary

Polished the HR surface: staff directory, employee record, capacity/workload and
leave management. Shared UI components and formatters are now used consistently.
No business logic, auth rules, RLS, migrations or API contracts were changed.

## Files changed

| Path | Change |
|------|--------|
| `src/components/ui/FormField.tsx` | Switched from `Math.random()` to React `useId()` to avoid hydration mismatches. |
| `src/app/app/hr/staff/page.tsx` | `Card`, `DataTable`, `Badge`, `StatusBadge`, typed `StaffRow`. |
| `src/app/app/hr/capacity/page.tsx` | `Card`, `CardHeader`, `CardBody`, `Button`, `Badge`, `DataTable`, `fmtNumber`, typed rows. |
| `src/app/app/hr/leave/page.tsx` | `Card`, `CardHeader`, `CardBody`, `Badge`, `StatusBadge`, `DataTable`, `fmtDate`, `fmtNumber`. |
| `src/app/app/hr/staff/[id]/page.tsx` | `Card`, `CardHeader`, `CardBody`, `Button`, `Badge`, `StatusBadge`, `DataTable`, `FormField`, `fmtDate`, `fmtNumber`; reject button uses `variant="danger"`. |

## Verification

- `npm run typecheck` ✓
- `npm run lint` ✓ (only pre-existing `<img>` warnings)
- Focused tests: 6 files, 39 tests passed
  - `tests/availability.test.ts`
  - `tests/leave.test.ts`
  - `tests/campaign/sch-003-leave-workload-aware-scheduling.test.ts`
  - `tests/campaign/wrk-001-leave-surface.test.ts`
  - `tests/campaign/wrk-002-capacity-surface.test.ts`
  - `tests/campaign/wrk-003-skills-surface.test.ts`

## Screenshots

All HR pages require an authenticated session; screenshots are deferred until a
local Supabase test session is available. Public-page screenshots remain in
`screenshots/uiux-v1/after/` from Batch 1.

## Self-review notes

- Employee-record forms now use labelled `FormField` components and stack responsively.
- Capacity table uses `fmtNumber` with 2 decimals for hours and percentages.
- Leave dates are formatted with `fmtDate` instead of raw ISO strings.
- Status colours preserved semantically.
- No server actions, form `name`s or data queries changed.
