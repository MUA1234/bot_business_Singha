# FOUND-006 — the database caller and trust boundary

What decides that a caller may do something, and what merely describes them.

## 1. The principle, in one line

**PostgreSQL grants and role membership are privilege. `request.jwt.claims` is request metadata.**

Any caller holding a database role can `set_config('request.jwt.claims', …)` — it is a session GUC,
not a credential. A function that converts a claimed JWT role into service authority is therefore
asking the caller to describe their own privilege and believing the answer.

## 2. The five contexts, and what identity means in each

| # | Context | What is trustworthy | What is not |
|---|---|---|---|
| 1 | **Normal PostgREST request** (`anon` / `authenticated` / `service_role`) | The database ROLE PostgREST `SET ROLE`s into, because it is chosen by the API key PostgREST verified. `auth.uid()`, because PostgREST wrote the claims from a signed JWT | Nothing the request body says about itself |
| 2 | **Trusted backend / service operation** | The `service_role` GRANT the connection holds | The JWT text, which may say anything |
| 3 | **SECURITY DEFINER execution** | The OWNER's privileges — that is the point of DEFINER | `current_user` (it is the owner, not the caller); `session_user` (it is `authenticator`) |
| 4 | **Direct database connection** | The login role and its memberships | Any GUC the session sets itself |
| 5 | **Arbitrary SQL under the shared `authenticated` role** (an application defect, an injection) | The role's own grants — which is exactly why grants must be the gate | **Every claim, including `sub`.** See §5 |

## 3. Measured facts, not assumptions

Reproduced on a disposable local PostgreSQL 16 under the real PostgREST role pattern (log in as
`authenticator`, then `SET LOCAL ROLE`):

| Context | `current_user` | `session_user` |
|---|---|---|
| SECURITY DEFINER body | **`postgres`** (the owner) | `authenticator` |
| SECURITY INVOKER body | `authenticated` / `service_role` | `authenticator` |
| SECURITY INVOKER **trigger** | `authenticated` / `service_role` | `authenticator` |

Two consequences, both of which killed a proposed fix before it shipped:

* Inside a **DEFINER** body, `current_user` is the owner and says nothing about the caller.
* `session_user` is `authenticator` for **every** request, and Supabase grants `authenticator`
  membership of `service_role` so it can `SET ROLE` — so
  `pg_has_role(session_user, 'service_role', 'MEMBER')` is **TRUE for every ordinary web request**.
  Measured directly.

What *is* provable: inside a **SECURITY INVOKER** body, `current_user` is the caller's effective
role, and `has_function_privilege(current_user, '<service-only fn>', 'EXECUTE')` asks whether the
caller holds a GRANT. Measured: `authenticated` → false, `service_role` → true.

## 4. The rules that follow

**Service-only entrypoints.** Authorization is the EXECUTE grant: revoke from `PUBLIC`, `anon` and
`authenticated`; grant to `service_role` and any required owner/internal role. No branch may convert
a claimed role into service authority, and no caller-supplied boolean or actor-source may stand in
for service identity. A `service_role` request whose JWT text reads `authenticated` **keeps** its
access; an `authenticated` role whose claim reads `service_role` stays **refused**.

> **Corrected after security review 2.** An earlier draft ended that paragraph with "Both are
> tested", which was true only of the quotation split. It was NOT true of the tree. `_resolve_actor`
> (migration 0049) read `request.jwt.claims` directly and turned `role=service_role` into
> `actor_type='system'`; nine SECURITY DEFINER finance RPCs, every one EXECUTE-able by
> `authenticated`, gated their capability check on that value and so skipped it entirely. A login
> role holding no service membership at all posted a 999,999 journal with one forged GUC, and
> defeated the supplier bank-change maker-checker the same way. **Migration 0086 removes the
> branch** — there is no role test left, the actor is the authenticated subject, and the capability
> check is unconditional. The rule above is now enforced across the api-reachable surface, and
> `found-006-caller-trust.test.ts` re-runs the exploit from a genuine unprivileged login role.

**Authenticated human entrypoints.** Grant to `authenticated` only. Derive the person from the
trusted request context (`auth.uid()`), resolve active membership inside the transaction, and
re-check capability and authority at commit. Never take the final member, actor source, company or
authority level from caller input.

**Triggers.** Prefer SECURITY INVOKER where the writer's identity matters — it is the only context
where the caller is knowable. Never assume `current_user` is the caller inside a DEFINER body, never
use `session_user` to identify an API role, and do not use `pg_has_role(current_user, …)` inside a
DEFINER body at all.

**Internal helpers.** Remove API-role EXECUTE that nothing needs. Expose role-specific wrappers over
a shared implementation rather than one helper carrying a request-claim branch. Keep exact-signature
allowlists and pinned search paths.

## 5. What FOUND-006 does NOT solve

`anon`, `authenticated` and `service_role` are **shared** database roles reached through one
`authenticator` login role. Two distinct consequences follow, and an earlier draft of this document
got the second one wrong.

### 5a. Forged claims → user impersonation

A caller able to execute arbitrary SQL as `authenticated` can set `request.jwt.claims` to any `sub`
and therefore control `auth.uid()`, impersonating any user to every RLS policy. Asserted in
`tests/integration/found-006-caller-trust.test.ts`.

### 5b. `SET ROLE` → FULL SERVICE ESCALATION — corrected after review

An earlier version of this document said "impersonating a user is a different and unsolved problem
from becoming the service worker". **That was false, and an independent security review was right to
reject it.**

`SET ROLE` is authorized against **`session_user`**, not `current_user`. Under the exact PostgREST
topology this design is built around, `session_user` is `authenticator` — and `authenticator` is a
member of `service_role` so that PostgREST can serve service-key requests. So a caller with
arbitrary SQL as `authenticated` does not need to forge anything: **one statement makes them the
service worker**, with BYPASSRLS and every service-only RPC.

Reproduced on a disposable local PostgreSQL, roles mirroring Supabase
(`create role authenticator login noinherit; grant anon, authenticated, service_role to authenticator;`):

```
begin; set local role authenticated;
  has_function_privilege(current_user, 'quotation_status_for_service…', 'EXECUTE')  → f
set role service_role;                       -- ONE statement, no forgery involved
  current_user                                → service_role
  has_function_privilege(current_user, …)     → t
  quotation_status_for_service(…)             → 'sent'
```

**This is not a regression introduced by 0084** — at 0083 the same attacker forged the GUC instead,
reaching the same place by a different door. What 0084 removed is the door that needed no
escalation; it did not, and could not, remove `SET ROLE`.

**The mitigation is topological, not a migration.** `SET ROLE` succeeds because ONE login role is a
member of both the API roles and `service_role`. Closing it requires the service backend to connect
as a role that is **not** the login role serving public API traffic — separate connections, separate
login roles, with the public one holding no `service_role` membership. That is a deployment change on
the hosted project and an **owner action**; a migration cannot make it, and revoking
`service_role` from `authenticator` on a live Supabase project would break the service path outright.

`tests/integration/found-006-caller-trust.test.ts` carries two separate things here, and security
review 2 was right that an earlier draft confused them:

* a **topology detector** — it enumerates the real non-superuser login roles in the database under
  test, excluding the probe roles the integration suite itself creates, and FAILS naming any role
  that holds both `service_role` and an api-role membership. On a disposable test database there is
  no deployment login role at all, so it passes while saying exactly that; an empty pass is not a
  statement about the hosted project.
* a **mechanism demonstration** — it builds a merged login role deliberately and shows the
  escalation is one statement long. It is titled as a demonstration because that is what it is.

An earlier draft said the detector "is expected to fail against the current single-`authenticator`
shape and to pass once the owner separates the roles". **That was the opposite of what the code did**
— it asserted the escalation SUCCEEDS, so it was green today and would have gone red on the fix, and
it measured a role the test itself had created rather than the deployed topology. A reader of the
document alone would have concluded the suite was red pending owner action. Both the code and this
paragraph are corrected.

**A note on what PostgreSQL 16 does offer.** `GRANT … WITH SET FALSE` is the in-database control for
this class in general: it lets a role inherit privileges without being able to `SET ROLE` to the
grantor. It does not help *here*, because PostgREST needs `SET ROLE` on the very login role that
serves API traffic in order to switch between `anon`, `authenticated` and `service_role` at all. So
the accurate statement is not "no in-database control exists" but **"no in-database control closes
this while one login role must switch into both the api roles and `service_role`."** The remedy is
still the separate service login identity. For completeness: event triggers cannot intercept
`SET ROLE`, `NOINHERIT` does not restrict it, and revoking `service_role` from `authenticator` on a
live project breaks the service path.

### What FOUND-006 actually guarantees

Stated exactly, and no wider: **as of migration 0086, no forged request claim yields service-only
database privilege or skips a capability check on the api-reachable surface.** A caller must hold
the `service_role` GRANT — by membership — and holding it is a database fact, not a request
assertion. Everything above about `SET ROLE` and `sub` is about who can *obtain* that membership,
which is a deployment question this package does not close.

> **What this sentence looked like before, and why it was wrong.** At 0084/0085 it read "no forged
> request claim yields service-only database privilege" with no qualifier, and it was false: the
> claim did not need to yield *privilege* to do damage, only to select a *branch*. `_resolve_actor`
> gave a forged `service_role` claim an actor_type that nine finance RPCs read as "skip the
> capability check". Reproduced, then closed by 0086. The lesson is in the wording: a guarantee
> about grants says nothing about what a function does with claim text once the caller is inside.

## 6. Inventory — every identity/privilege decision

Measured on a fresh `0001–0085` disposable database, counting functions in `public` whose body
references `auth.uid()`, `caller_jwt_role`, `request.jwt`, `current_user`, `session_user` or
`pg_has_role`:

**45 functions, of which 15 are reachable by `anon` or `authenticated`.** Both counts verified
against `pg_proc` on a fresh `0001–0086` disposable database. (An earlier draft said "48 / 17"; 17
was the pre-0084 count and 48 matched no definition.)

The clean decomposition is **30 non-api-reachable + 15 api-reachable = 45**, with nothing counted
twice.

The 15 api-reachable members, exactly:

| Group | Count | Members |
|---|---|---|
| RLS/identity predicate helpers | 10 | `has_capability`, `has_company_access`, `has_membership`, `has_permission`, `is_admin`, `my_company`, `my_department`, `within_authority`, `within_authority_for_event`, `authority_ceiling` |
| Restrictive claim readers | 2 | `decide_approval`, `route_task_as_human` — the claim can only *tighten*; both verified by execution, not only by reading |
| Trigger functions (INVOKER — `current_user` is the caller) | 2 | `quotation_items_enforce_frozen`, `quotations_enforce_insert_initial_state` |
| Helper called from an invoker trigger body | 1 | `_is_quotation_delivery_owner()` — resolves the delivery owner's OID from `pg_catalog`. The grant is needed because the trigger BODY calls it as the caller; a trigger function needs no EXECUTE to fire |

The other 30 are not reachable by any api role: `anon` and `authenticated` hold no EXECUTE, so
forging a claim is irrelevant when the call itself is refused. `caller_jwt_role()` and
`_resolve_actor(uuid)` are among them — 0084 revoked their EXECUTE, and no SECURITY INVOKER function
calls either, so every caller is a DEFINER body running as its owner. That revoke is worth naming
honestly: because those functions were only ever reached from owner-context bodies, it changed
nothing about who could exercise them. It reads like remediation and was not; **migration 0086** is
what removed `_resolve_actor`'s claim-to-authority conversion.

> **Corrected after security review 2 (G-04).** An earlier draft named
> `quotation_status_for_capable` as one of the 15 and offered "30 + 2 + 10 + 1 + 2 + 1 + 2 = 48
> classifications across 45 functions — three appear in two rows". Both were wrong.
> `quotation_status_for_capable` is not in the population at all: its body references none of the
> six identity tokens the population is defined by (nor does `quotation_status_for_service`) — they
> are covered by §7 instead. The real 15th member is `_is_quotation_delivery_owner()`. The "three
> appear in two rows" explanation was invented to reconcile 48 down to 45, and the sum silently
> dropped the table's own first row. There is no double counting; the decomposition above adds up.

**The nine finance entrypoints** — `post_manual_journal`, `post_customer_invoice`,
`post_supplier_bill`, `settle_customer_invoice`, `settle_supplier_bill`, `reimburse_expense_claim`,
`reverse_journal`, `request_supplier_bank_change`, `decide_supplier_bank_change` — are api-reachable
SECURITY DEFINER functions that reach claim text *transitively*, through `_resolve_actor` and
`has_capability`. They are outside the 45 because their own bodies name none of the six tokens, and
that is precisely why a source-text inventory missed the G-01 defect. Migration 0086 adds a
**call-graph** invariant that catches them (and the permanent gate mirrors it): every api-reachable
DEFINER function that can reach claim text by any path must sit on a reviewed allowlist of 22, so
the set cannot grow without someone deciding it should.

## 7. What migration 0084 changed

**The quotation status read, split by privilege:**

* `_quotation_status_read(company, id)` — the shared implementation, with the `FOR UPDATE` lock
  migration 0067 added. **No authorization inside it, and reachable by no API role** — only its two
  wrappers, `quotation_status_for_capable` and `quotation_status_for_service`, which run as the same
  owner. (Corrected after security review 2, G-05: an earlier draft also credited the WP12 delivery
  functions with calling it. They do not — the catalog shows exactly two callers, both wrappers.
  F-06 was recorded as fixed in the previous loop but this sentence was never actually edited.)
* `quotation_status_for_capable(company, id)` — authorizes on `sales.quotation.manage`. Granted to
  **`authenticated` only**.
* `quotation_status_for_service(company, id)` — **no branch at all**. Granted to **`service_role`
  only**; the grant *is* the authorization.
* `quotation_items_enforce_frozen()` stays SECURITY INVOKER and chooses between them with
  `has_function_privilege(current_user, …)`.

One implementation detail worth recording, because it cost a debugging cycle: the branch must be
two `IF` statements, **not a `CASE` expression**. PL/pgSQL plans a statement on first execution and
PostgreSQL ACL-checks every function in that plan — including the branch that will not be taken — so
a `CASE` raised `permission denied for function quotation_status_for_service` for an `authenticated`
caller that had correctly chosen the capability branch.

**A semantic change, stated rather than absorbed.** A `service_role` session with no JWT claims used
to be refused as "unclassifiable". It is now recognised by its grant, and may edit a pre-queue
quotation item exactly as it can with claims present. That is the intended direction — the grant is
authoritative — and the queued-snapshot freeze still refuses it. `wp12-enqueue-item-race` was
rewritten to assert the invariant that still matters: the freeze holds, and a caller with neither the
capability nor the grant is refused outright.
