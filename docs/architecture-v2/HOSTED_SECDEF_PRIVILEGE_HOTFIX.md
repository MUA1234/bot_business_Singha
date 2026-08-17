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

## `search_path` / `pg_temp` hardening of the hosted 0038–0041 functions (migration 0067)

Separately from the EXECUTE-privilege exposure above, the **0038–0041 functions were applied to the
hosted DB with `SET search_path = public`** (or none). Because Postgres searches the session temp schema
for RELATION names **before** `pg_catalog`/`public` unless `pg_temp` is listed later, a caller with the
default (PUBLIC) `TEMP` privilege can `CREATE TEMP TABLE memberships`/`journal_entries`/`pg_proc`/… to
shadow the real relations inside those SECURITY DEFINER / trigger functions (see migrations 0066/0067).
Migration **0067** fixes this permanently on any DB it reaches (it re-pins every application SECURITY
DEFINER / trigger function to `pg_catalog, extensions, public, pg_temp`), but until 0067 reaches the
hosted DB the already-hosted functions remain shadowable. Two prepared, **not-executed** artifacts:

3. **`hosted_secdef_searchpath_check.sql`** — READ-ONLY. Lists every application SECURITY DEFINER / trigger
   function in `public` (excluding extension-owned) with its `search_path`, and flags any whose parsed
   path is not EXACTLY the canonical `pg_catalog, extensions, public, pg_temp` (STRICT equality — tenth
   review: "pg_temp last" alone would still accept a path LEADING with an attacker-writable schema, which
   wins relation resolution; strict equality also subsumes the missing-path, `$user` and duplicated-pg_temp
   cases). Safe to run against hosted at any time; mutates nothing.
   *Evidence (disposable PostgreSQL 16 staged at 0041, mirroring the hosted 0038–0041 state):* **19 of 19**
   application SECURITY DEFINER / trigger functions report `unsafe = true`; a planted
   `attacker_x, pg_catalog, public, pg_temp` (pg_temp-last!) path is also flagged.
4. **`hosted_secdef_searchpath_hardening.sql`** — mutation; **owner approval REQUIRED before execution.**
   Catalog-driven and **self-verifying**: it targets the EXACT `regprocedure` identities present, ABORTS if
   the targeted functions do not share ONE owner or that owner is an API role, alters **only** `search_path`
   (never body/owner/args/return/SECURITY-DEFINER/ACL), then RE-VERIFIES in the same transaction that every
   targeted signature now carries EXACTLY the canonical path — RAISING (rolling back the whole
   transaction) on any residual, so a partial hardening can never be committed.
   *Evidence (0041-staged disposable DB, re-run with the strict-canonical predicate):*
   before → **19 unsafe** (+1 planted attacker-schema path → 20/20 with a second-owner plant → 21/21);
   the second-owner plant makes the owner-consistency guard RAISE `ABORTED: … do not share ONE owner` and
   ROLL BACK with the unsafe count unchanged (nothing committed); after dropping it → `hosted hardening
   OK: 20 … pinned; zero residual unsafe` with COMMIT; final check → **0 unsafe / 20** (the planted
   attacker-schema function re-pinned to canonical). Applying migration **0067** afterwards is a
   no-op on these functions (same end-state).

> Fail-closed note: migration 0067 (and any hosted apply of it) ABORTS if `anon`/`authenticated`/
> `service_role` has `CREATE` on the trusted `public`/`extensions` schemas — because a persistent (non-temp)
> shadow object there would defeat even a `pg_temp`-last path. It does **not** revoke that privilege blindly;
> it reports the incompatible condition for owner-approved remediation. (On PostgreSQL 15+ the default
> `PUBLIC` `CREATE` on `public` is already revoked; verify on the hosted DB before applying.)

## Recommended owner sequence (owner-gated; not performed here)

1. Run `hosted_secdef_privilege_check.sql` on the hosted DB (read-only). Save the output.
2. If any service-only function shows `exposed = true`, run `hosted_secdef_emergency_revoke.sql`
   (owner approval required) to close the EXECUTE-privilege window immediately.
3. Run `hosted_secdef_searchpath_check.sql` (read-only). If any application SECURITY DEFINER / trigger
   function shows `unsafe = true`, run `hosted_secdef_searchpath_hardening.sql` (owner approval required)
   to close the `pg_temp`-shadowing window immediately.
4. Apply the full Phase-1 migration set (…→**0067**) via `npm run migrate` on staging first, then
   production — at which point 0062 (EXECUTE lockdown) and 0067 (search_path hardening) become permanent and
   part of the migration history.
