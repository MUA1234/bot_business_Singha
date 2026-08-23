# UI/UX v1 Polish — Batch 1 Report

Branch: `kimi/uiux-v1-polish`  
Batch focus: Design-system foundation + navigation shell  
Date: 2026-08-24

## Summary

Established the shared UI component layer, route-level UX boundaries, and an upgraded
authenticated shell. No business logic, auth rules, RLS, migrations or API contracts
were changed.

## Files changed

| Path | Change |
|------|--------|
| `src/components/ui/*` | New shared components: Button, Card, Badge, EmptyState, Skeleton, DataTable, FormField, SearchInput |
| `src/components/ui/index.ts` | Barrel export for shared UI |
| `src/components/Icon.tsx` | Added missing icons: send, plug, pie-chart, search, x, loader-2, alert-circle, plus, chevron-down, log-out |
| `src/components/AppShell.tsx` | Skip link, aria-current, nav search filter, notification link, user menu, mobile icon-only nav |
| `src/app/globals.css` | Focus-visible, sr-only, skeleton, card header/footer, empty-state, search-input, user-menu, table helpers |
| `src/app/app/loading.tsx` | Authenticated-shell loading skeleton |
| `src/app/not-found.tsx` | Branded 404 page |
| `src/app/global-error.tsx` | Branded global error boundary |
| `scripts/verify/ui-screenshots.mjs` | Reusable screenshot harness |

## Verification

- `npm run typecheck` ✓
- `npm run lint` ✓ (only pre-existing `<img>` warnings)
- `npm test` ✓ 168 test files, 1208 tests passed

## Screenshots

Captured at 390px, 768px and 1440px viewports.

| Page | Before | After |
|------|--------|-------|
| Landing | `screenshots/uiux-v1/before/landing-{mobile,tablet,desktop}.png` | `screenshots/uiux-v1/after/landing-{mobile,tablet,desktop}.png` |
| Login | `screenshots/uiux-v1/before/login-{mobile,tablet,desktop}.png` | `screenshots/uiux-v1/after/login-{mobile,tablet,desktop}.png` |
| Privacy | `screenshots/uiux-v1/before/privacy-{mobile,tablet,desktop}.png` | `screenshots/uiux-v1/after/privacy-{mobile,tablet,desktop}.png` |
| Terms | `screenshots/uiux-v1/before/terms-{mobile,tablet,desktop}.png` | `screenshots/uiux-v1/after/terms-{mobile,tablet,desktop}.png` |
| Data deletion | `screenshots/uiux-v1/before/data-deletion-{mobile,tablet,desktop}.png` | `screenshots/uiux-v1/after/data-deletion-{mobile,tablet,desktop}.png` |
| Not found | n/a (did not exist at base) | `screenshots/uiux-v1/after/not-found-{mobile,tablet,desktop}.png` |

## Notable visual changes

1. **Not-found page** is now branded and offers a clear "Go to dashboard" action.
2. **Login page** remains structurally the same but benefits from the global focus-visible
   ring and the updated not-found/global-error boundaries.
3. **Landing page** is unchanged visually in this batch (it will be refined in a later batch);
   screenshots serve as a baseline.

## Limitations

- Authenticated pages could not be screenshotted because the local environment has no
  configured Supabase instance with seeded users. The screenshot harness is ready and will
  be extended once authenticated sessions can be established locally.
- Public static pages (privacy, terms, data-deletion) are visually unchanged in this batch;
  their screenshots document the baseline.

## Self-review notes

- All new components compile under `strict` TypeScript.
- `prefers-reduced-motion` is respected for skeleton shimmer and button spinner.
- No fake operational data inserted.
- Every new interactive element has a real action or is clearly labelled.
- The user menu and notification link are real navigation affordances.
