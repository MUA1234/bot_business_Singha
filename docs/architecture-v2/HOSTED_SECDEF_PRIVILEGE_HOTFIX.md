# Hosted SECURITY DEFINER privilege exposure — check + emergency hotfix (PREPARED, NOT EXECUTED)

> Final external-review security-boundary item. Migration **0062** locks every service-only /
> internal SECURITY DEFINER function to `service_role` on any database it is applied to. But
> migrations **0038–0041 were owner-applied to the hosted database on 2026-08-07**, and they revoked
> EXECUTE only **from PUBLIC**. On managed Supabase the `authenticated` (and `anon`) roles are granted
> EXECUTE on `public` functions **directly**, not only via PUBLIC — so a `revoke … from public` alone
> can leave those functions callable by any logged-in user. This document is the **prepared, but NOT
> executed** break-glass for that window (before 0062 reaches the hosted DB).
>
> **This development process did NOT run either script against the hosted database** (owner
> authorisation not given, and outside the standing constraints). The evidence below is from a
> disposable PostgreSQL 16 staged at 0041 to mirror the hosted state.

## Potentially-exposed functions on the hosted DB (0038–0041 applied)

| Function | Created in | On hosted? | Risk if authenticated can call it |
|---|---|---|---|
| `_journal_post_internal(uuid,date,text,text,uuid,jsonb,text)` (legacy **7-arg**) | 0039 | **yes** | Post an arbitrary journal, bypassing the wrappers' capability/authority checks |
| `claim_outbox_batch(integer,text,integer)` | 0040 | **yes** | Lease/read another company's outbound messages |
| `ledger_integrity_report(uuid)` | 0041 | **yes** | Read a cross-company ledger-integrity report |
| `complete_outbox_and_advance(uuid,text,text)` | 0055 | no (0042+ not hosted) | (Not on hosted yet; the hotfix covers it if present) |

The current 11-arg `_journal_post_internal` (0044) and the outbox/currency RPCs (0055/0061) are **not**
on the hosted DB (0042+ is "owner confirmation required"), so they are not part of the hosted exposure —
but the hotfix is name-based and locks them too if they are ever present.

## Artifacts (in this directory)

1. **`hosted_secdef_privilege_check.sql`** — READ-ONLY. Lists every SECURITY DEFINER function and its
   anon/authenticated/service_role EXECUTE ACL, plus a focused query that flags `exposed = true`. Safe
   to run against hosted at any time; it mutates nothing.
2. **`hosted_secdef_emergency_revoke.sql`** — mutation; **owner approval REQUIRED before execution**
   (the script header states a requirement, not that approval has been granted). The break-glass
   lockdown (identical in effect to migration 0062's core): **catalog-driven** — it discovers the
   service-only functions from `pg_proc` by name and locks down every present signature, so no signature
   is hardcoded and it is safe on both a 0041-only and a fully-migrated DB — idempotent, and
   **self-verifying**: after the REVOKEs it ASSERTS in the same transaction that no anon/authenticated
   EXECUTE remains and RAISES (aborting the whole transaction) if any does, so a partial lockdown can
   never be committed from a SQL-editor batch. Run ONLY with owner approval, ONLY if the check shows an
   exposure, and ONLY before 0062 is applied.

## Evidence (disposable PostgreSQL 16 staged at 0041 — mirrors the hosted 0038–0041 state)

**Before** the hotfix — the focused exposure check (`authenticated_execute`):

```
 _journal_post_internal | p_company uuid, p_date date, p_currency text, p_memo text, p_actor uuid, p_lines jsonb, p_idempotency_key text | t
 claim_outbox_batch     | p_limit integer, p_owner text, p_lease_seconds integer                                                        | t
 ledger_integrity_report| p_company uuid                                                                                                | t
```

All three are `authenticated_execute = true` — i.e. reachable by a logged-in user. This reproduces the
hosted risk (the legacy 7-arg `_journal_post_internal` is present and exposed).

**Running** `hosted_secdef_emergency_revoke.sql` — the REVOKE loop ran, the in-transaction self-verify
found zero residual exposure, and the transaction reached `COMMIT` (`DO` then `COMMIT`).

**After** the hotfix — same functions (`authenticated_execute`, `service_role_execute`):

```
 _journal_post_internal  | … 7-arg …          | f | t
 claim_outbox_batch      | …                  | f | t
 ledger_integrity_report | p_company uuid      | f | t
```

**Abort-gate proof** — a deliberately simulated residual exposure (re-granting EXECUTE to
`authenticated` on one service-only function before the self-verify) makes the gate RAISE and the whole
transaction ROLL BACK, so nothing is committed:

```
ERROR:  emergency hotfix ABORTED: 1 service-only signature(s) still expose EXECUTE to anon/authenticated
ROLLBACK
-- and the simulated grant did NOT persist (transaction aborted):
 has_function_privilege
------------------------
 f
```

This is the fail-safe the review requires: the operator cannot commit a partial lockdown from a
SQL-editor batch — residual exposure aborts the transaction rather than reaching `COMMIT`.

`authenticated` (and `anon`) EXECUTE is revoked; `service_role` retains it. Applying migration **0062**
afterwards is a no-op on these functions (same end-state).

## Recommended owner sequence (owner-gated; not performed here)

1. Run `hosted_secdef_privilege_check.sql` on the hosted DB (read-only). Save the output.
2. If any service-only function shows `exposed = true`, run `hosted_secdef_emergency_revoke.sql`
   (owner-approved) to close the window immediately.
3. Apply the full Phase-1 migration set (…→**0062**) via `npm run migrate` on staging first, then
   production — at which point 0062 makes the lockdown permanent and part of the migration history.
