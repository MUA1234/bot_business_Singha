# Dependency Audit — deliberate triage process

> NEXT_PHASE_DEVELOPER_BRIEF §WP6.9: "Triage dependency audit results deliberately. Do
> NOT run a blind upgrade or `npm audit fix` without reviewing framework compatibility."
> This document is the approved exception process. It is the required CI gate's policy.

## How the audit runs

- CI runs `npm audit --omit=dev --audit-level=high` as an **informational** step (it
  reports; it does not auto-fix and does not silently block a release).
- A finding at `high` or `critical` must be triaged here **before** merge — it is not
  auto-dismissed and not auto-upgraded.

## Triage rules

1. **Never** run `npm audit fix --force` — it can bump Next.js / React / Supabase to
   incompatible majors. Framework upgrades are a separate, owner-approved work package
   (STOP condition: "a dependency upgrade requires a material framework migration").
2. For each `high`/`critical` finding, record a row below with: package, advisory, why
   it does/does not affect us (is the vulnerable path reachable at runtime?), and the
   action (patch within semver / accept-with-reason / defer to a framework-upgrade WP).
3. A **transitive** dev-only advisory (build tooling, not shipped) may be accepted with a
   note; a **runtime** advisory on a reachable path must be patched or the feature gated.
4. Re-triage on every lockfile change.

## Current exceptions / decisions

Audit run 2026-08-07 (`npm audit --omit=dev`) on `next@14.2.35` (latest 14.x): **3 high**.

| Package | Advisory | Reachable at runtime? | Decision | Date |
|---|---|---|---|---|
| next | SSRF in rewrites via attacker-controlled destination host (GHSA-p9j2-gv94-2wf4) | We define **no dynamic/user-controlled rewrites** (`next.config.mjs` has none) → not reachable | **Accept + defer**: only fixed in next@16 (breaking framework migration = STOP condition). Track a dedicated Next 14→16 upgrade WP. | 2026-08-07 |
| next | Unbounded Server Action payload on Edge runtime (GHSA-4c39-4ccg-62r3) | Our server actions run on the **Node** runtime, not Edge → not reachable | Accept + defer (next@16). | 2026-08-07 |
| next | Unauthenticated disclosure of internal Server Function endpoints (GHSA-955p-x3mx-jcvp) | Server actions are auth-gated (`requireProfile`/capability); disclosure is of endpoint IDs, not data | Accept + defer (next@16); revisit if the upgrade WP slips. | 2026-08-07 |
| postcss (transitive via next) | XSS/path-traversal via attacker-controlled `sourceMappingURL` (multiple) | **Build-time** CSS tooling only; no untrusted CSS is processed at runtime | Accept: transitive, dev/build-only; resolves with the next upgrade. | 2026-08-07 |

**Decision:** do **not** run `npm audit fix --force` (it installs next@16, a breaking major). The
three highs are not reachable given our config (no dynamic rewrites, Node runtime,
auth-gated actions); they are cleared by a planned, owner-approved **Next 14→16 upgrade
work package** with its own regression pass.

## Local verification

`npm run verify` runs the no-infra gates (secret scan, migration lint, typecheck, unit
tests). The dependency audit is intentionally **not** in `verify` because it needs a
working npm cache + registry; run it explicitly during dependency review.
