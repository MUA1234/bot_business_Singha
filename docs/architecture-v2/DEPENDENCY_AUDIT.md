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

_None recorded yet — run `npm audit --omit=dev` after the `~/.npm` cache is fixed
(`sudo chown -R 501:20 ~/.npm`, see STAGING_SETUP.md §0) and populate this table._

| Package | Advisory | Reachable at runtime? | Decision | Date |
|---|---|---|---|---|
| _(pending first audit)_ | | | | |

## Local verification

`npm run verify` runs the no-infra gates (secret scan, migration lint, typecheck, unit
tests). The dependency audit is intentionally **not** in `verify` because it needs a
working npm cache + registry; run it explicitly during dependency review.
