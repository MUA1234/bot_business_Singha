# Deployment gates — WP F.8

A change reaches production only after every gate below passes. Claude never performs
production migrations, credential changes, or flag flips — those are owner actions
(invariant #16).

## 1. CI green (required, automated)

Both CI jobs pass on the commit:
- `verify`: secret-scan, migration-lint, typecheck, lint, unit tests, production build,
  dependency audit gate.
- `db-tests`: migrations apply to a disposable Postgres, and ALL integration / RLS /
  capability / concurrency tests pass (the job fails loud if no test DB — never skips).

## 2. Migration + rollback plan reviewed

- New migrations are forward-only, additive, and idempotent (verified by migration-lint).
- `MIGRATION_STATE.md` updated with the intended target and per-environment state.
- Rollback: capability policies (0038) and RPC hardening (0039) are inert while
  `RLS_READS`/`RLS_WRITES` are off (service role bypasses RLS; RPCs treat the service
  caller as the trusted path), so they can ship ahead of any flag flip with no behaviour
  change and are reversible by leaving the flags off. Durable-messaging (0040/0041) is
  additive. See `RLS_CUTOVER_PLAN.md` for the flag rollback procedure.

## 3. Production environment validated

- `/api/health` (CRON_SECRET-gated) reports `config.missing` empty in production.
- All mandatory env vars present (see `.env.example`); `APP_ENV=production` makes missing
  security config a critical health signal.

## 4. Owner approval for finance/security changes

- Any change to accounting RPCs, RLS/capability policies, auth, or flags requires explicit
  owner sign-off recorded on the PR.

## 5. Small, monitored pilot

- Ship to production with flags still OFF (zero behaviour change), confirm health green.
- Flip flags one at a time per `RLS_CUTOVER_PLAN.md` (reads → writes → async), each after
  staging UAT, each independently reversible.
- Watch `/api/health` and alerts through a monitored rollback window before widening.

## 6. Rollback window

- Keep the previous deployment available; each feature flag reverts to `off` immediately
  to restore prior behaviour without a migration revert.
