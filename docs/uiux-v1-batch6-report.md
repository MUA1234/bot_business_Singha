# UI/UX v1 Polish — Batch 6 Report

Branch: `kimi/uiux-v1-polish`  
Batch focus: loading, error, permission and empty states; final consistency pass  
Date: 2026-08-24

## Summary

Added route-level loading placeholders, a global app error boundary, a reusable
`PermissionDenied` component, and replaced all remaining bare `.empty` placeholders
with the shared `EmptyState`. Permission-denied returns in the admin surfaces touched
earlier now use the same premium, accessible card. No business logic, auth rules,
RLS, migrations or API contracts were changed.

## Files changed

| Area | Files |
|------|-------|
| Global app states | `src/app/app/error.tsx`, `src/app/app/admin/loading.tsx`, `src/app/app/command/loading.tsx`, `src/app/app/finance/loading.tsx`, `src/app/app/fleet/loading.tsx`, `src/app/app/hr/loading.tsx`, `src/app/app/legal/loading.tsx`, `src/app/app/marketing/loading.tsx`, `src/app/app/me/loading.tsx`, `src/app/app/messages/loading.tsx`, `src/app/app/notifications/loading.tsx`, `src/app/app/operations/loading.tsx`, `src/app/app/portfolio/loading.tsx`, `src/app/app/procurement/loading.tsx`, `src/app/app/sales/loading.tsx` |
| Permission gates | `src/app/app/admin/model-budgets/page.tsx`, `src/app/app/admin/inbound-setup/page.tsx`, `src/app/app/admin/inbound-review/page.tsx` |
| Empty states | `src/app/app/messages/page.tsx`, `src/app/app/messages/[id]/page.tsx`, `src/app/app/marketing/campaigns/page.tsx`, `src/app/app/marketing/audiences/page.tsx`, `src/app/app/legal/page.tsx`, `src/app/app/legal/risks/page.tsx`, `src/app/app/legal/obligations/page.tsx`, `src/app/app/legal/matters/page.tsx`, `src/app/app/legal/licences/page.tsx`, `src/app/app/legal/insurances/page.tsx`, `src/app/app/legal/incidents/page.tsx`, `src/app/app/legal/contracts/page.tsx`, `src/app/app/legal/contracts/[id]/page.tsx` |
| Shared components | `src/components/ui/PageLoader.tsx`, `src/components/ui/PermissionDenied.tsx`, `src/components/ui/Card.tsx` (added `style` to `CardBody`), `src/components/ui/index.ts` |

## Verification

- `npm run typecheck` ✓
- `npm run lint` ✓ (only pre-existing `<img>` warnings)
- Focused tests: 9 files, 69 tests passed
  - `tests/campaign/inbound-review-surface.test.ts`
  - `tests/campaign/rsk-005-incidents-and-obligations.test.ts`
  - `tests/campaign/analyze-ui-truthfulness.test.ts`
  - `tests/campaign/rsk-004-insurance-register.test.ts`
  - `tests/campaign/com-007-communication-preferences.test.ts`
  - `tests/campaign/rsk-001-risk-register.test.ts`
  - `tests/campaign/ui-rendered-truthfulness.test.ts`
  - `tests/campaign/rsk-002-contracts-register.test.ts`
  - `tests/campaign/rsk-003-licences-register.test.ts`

## Self-review notes

- Every department route now has a `loading.tsx` that shows the navigation and an
  on-brand skeleton table, preventing layout shift while data streams in.
- `src/app/app/error.tsx` is a client error boundary with retry action, accessible
  alert text, and a reference digest when available.
- `PermissionDenied` is used for the three admin permission gates changed in this
  batch; remaining permission notices across older pages already use the established
  `notice err` pattern and were not altered to avoid scope creep.
- `EmptyState` is now used for all empty list/table states under `src/app/app`.
- No server actions, form names, queries, permission predicates or calculations changed.
