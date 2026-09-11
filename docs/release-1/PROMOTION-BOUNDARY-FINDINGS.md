# What promotion exposed: five boundary defects the quarantine was hiding

Promoting the management kernel into the numbered lineage (0112–0141) did more than change file
names. It moved 46 functions and 26 tables into the population the **core** enumeration gates run
against — and those gates run on a database that carries no draft object, which is why they had
never seen any of this.

Six core-campaign tests failed on the first run after promotion. Every one of them was right.

| # | Finding | Severity | Fix |
|---|---|---|---|
| 1 | 38 kernel functions carried a non-canonical `search_path` | Medium | source-level, 30 files |
| 2 | The Ask-AI retention purge was callable by any signed-in user | **High** | `0144` |
| 3 | 28 kernel trigger functions were executable by `anon` | Low | `0144` |
| 4 | `management_task_idempotency` had RLS off and full DML for `authenticated` | **High** | `0144` |
| 5 | 17 worker-only kernel tables still carried write GRANTS | Medium | `0144` |
| 6 | A test suite leaked one orphan profile per run | Medium (test integrity) | teardown |

None of these is a regression from the integration. All six predate it and were invisible because
the objects lived outside the sequence the gates enumerate. **That is the finding behind the
findings**: a quarantine that hides objects from the security gates buys schedule at the cost of
review, and the bill arrives at promotion.

---

## 1. Non-canonical `search_path` on 38 functions

Migration 0067 re-pins every application-owned SECURITY DEFINER and trigger function in `public`
to `pg_catalog, extensions, public, pg_temp` — **the functions that exist when it runs**. The
kernel chain was promoted to 0112–0141, which is after 0067, so its functions were created with
the older `pg_catalog, public, pg_temp` form and never swept.

That form is `pg_temp`-last, so it is not exploitable by the temp-relation shadowing class 0067
was written for. It is still not the canonical value, and the gate demands strict equality
precisely because "nearly canonical" is where the next hole hides.

**Fixed at the source**, not with a corrective migration: 64 pins across 30 files, all of them
above main's high-water. `0066` carries the same older literal and was deliberately left alone —
it has run on production, and 0067's sweep canonicalises its functions at install time anyway.

Verified by rebuilding the database from empty: **93 SECURITY DEFINER functions, all canonical,
one distinct value.**

## 2. The Ask-AI retention purge was callable by any signed-in user

`r1_draft_ask_ai_purge_expired()` is SECURITY DEFINER with no caller gate and **no company
scope**. It marks every expired Ask-AI thread across every company and deletes their turns.

0131 revokes it `from public`. That does nothing here: Supabase's default privileges grant EXECUTE
on new functions **directly to `authenticated`**, so the privilege to remove was never PUBLIC's.

Proven rather than argued — called as `authenticated` on a live database:

```
select public.r1_draft_ask_ai_purge_expired();
 rows_purged_as_authenticated
------------------------------
                            0
```

A row count, not `42501`.

It only deletes rows already past `expires_at`, so a caller could accelerate a purge that was
going to happen, not destroy live content. It is still a cross-tenant destructive entrypoint that
nobody decided to publish. `0144` makes it service-only.

## 3. Trigger functions executable by anon

28 kernel trigger functions — the append-only and company guards — were executable by `anon` and
`authenticated`. Calling one directly raises *"trigger functions can only be called as triggers"*,
so this is surface rather than breach. It is still inconsistent with the released chain, which
treats a trigger function as reachable by nobody.

Revoking EXECUTE does not disarm a trigger: PostgreSQL checks that privilege when the trigger is
**created**, not when it fires.

## 4. `management_task_idempotency` — RLS off, full DML for `authenticated`

The worst of the five. 0132 creates the table with no RLS and no revoke, so the default privileges
handed `authenticated` SELECT, INSERT, UPDATE and DELETE on **every company's** execution
idempotency keys.

Reading them leaks which internal actions ran. Writing them is worse: those keys are how
`r1_draft_create_internal_task` decides a request is a duplicate, so planting a key for another
company's pending action makes the real call return *already done* and the approved action never
happens. **A suppressed execution that reports success is a worse failure than a refused one.**

`0144` enables RLS, **forces** it, and withdraws every grant but `service_role`'s. All 25 other
promoted tables were checked the same way; this was the only one.

## 5. Worker-only tables that still carried write grants

17 kernel tables have RLS on, a read policy, and no write policy — so authenticated writes are
already refused. The DML grant was still there.

RLS alone is one mechanism deep. The day RLS is disabled on one of those tables — a migration, a
restore, a dropped `force` — the grant is live with no policy behind it.
`security/rls-classification.json` calls these tables `service_only` / `rpc_only`, which is a claim
about privilege and not only about policy, so `0144` makes the privilege match the claim.

The rule is computed, not listed: for each promoted table, if no policy lets `authenticated`
INSERT, UPDATE or DELETE, the privilege goes. A table that later gains a write policy keeps its
grant automatically.

## 6. One orphan profile per campaign run

`identity-consistency` — *every profile has a membership in its own company* — passed on a fresh
database and failed on the second run against the same one.

`wp12-enqueue-item-race`'s teardown deleted memberships and companies but not `profiles`. Because
`profiles` references `companies`, the company delete then failed on the foreign key and **the
error was swallowed by a `catch`** — so both rows survived, one pair per run, accumulating until a
later suite noticed.

Two things made this hard to see and are worth keeping: the campaign **shuffles file order**, so
the failure moved around, and the teardown's silent catch turned a foreign-key error into nothing
at all.

Fixed, then verified by running the campaign **twice against one database**: 702/702 both times.

---

## What the gates now assert

* `search-path-safety` — 93 definer functions, one canonical path, any owner.
* `secure-definer-grants` — 25 promoted signatures classified by hand with reasons, service-only
  ones proven unreachable by `anon`/`authenticated`.
* `rls-coverage` — every company-scoped table has RLS and a read policy, or is allowlisted with
  the migration that decided it.
* `rls-matrix-coverage` — 167 classified tables; none is `company_member`.
* `found-006-caller-trust` — the call-graph closure of api-reachable definers that can reach claim
  text is pinned at 32. None of the seven new ones mentions `service_role`; each reaches claims
  only for `auth.uid()`.

`0144` verifies its own work and **aborts naming what is still open** — no anon reach, no callable
trigger function, the purge service-only *and still service-callable*, the policy-evaluated
helpers still reachable by `authenticated`, and the idempotency table RLS-forced with no user
grants. The first draft of it aborted on its own assertion, which is how finding 2's real cause —
`revoke ... from anon` where the grant was PUBLIC's — was discovered rather than assumed.
