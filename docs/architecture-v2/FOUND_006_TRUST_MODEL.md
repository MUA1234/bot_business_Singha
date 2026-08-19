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
access; an `authenticated` role whose claim reads `service_role` stays **refused**. Both are tested.

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

`anon`, `authenticated` and `service_role` are **shared** database roles. A caller able to execute
arbitrary SQL as `authenticated` — through an application defect or an injection — can set
`request.jwt.claims` to any `sub` and therefore control `auth.uid()`, and so impersonate any user to
every RLS policy. Measured and asserted in `tests/integration/found-006-caller-trust.test.ts`.

**This is a property of the shared-role architecture, not of any helper's name, and renaming or
re-wrapping a function does not address it.** It is outside the supported client boundary. Closing
it requires a different architecture: per-user database identity, or claims verified
cryptographically inside the database rather than accepted from a GUC.

What FOUND-006 *does* guarantee is narrower and worth stating exactly: **no forged claim yields
service-only database privilege.** Impersonating a user is a different and unsolved problem from
becoming the service worker.

## 6. Inventory — every identity/privilege decision

48 functions in `public` reference an identity primitive. 17 are reachable by `anon` or
`authenticated`; the rest are gated by EXECUTE grants and are unreachable from the API.

| Classification | Count | Examples | Why |
|---|---|---|---|
| **Security-sensitive, CHANGED by 0084** | 1 | `_quotation_status_for_guard` | The only DEFINER function reachable by an API role that converted a claimed role into authority. **Dropped**, replaced by a three-way split |
| **Safe — the exact grant is the gate** | 24 | `claim_source_events`, `record_inbound_receipt`, `admin_*`, `route_task_as_ai`, `settle_processed_source_event` | `anon` and `authenticated` hold no EXECUTE. Forging a claim is irrelevant when the call itself is refused |
| **Safe — the claim use is RESTRICTIVE** | 2 | `decide_approval`, `route_task_as_human` | The claim can only *tighten*: `decide_approval` refuses `anon` and a null `auth.uid()`; `route_task_as_human` refuses a caller claiming `service_role`. Forging makes them refuse, not admit |
| **Identity/audit within the trusted PostgREST boundary** | 10 | `has_capability`, `has_company_access`, `my_company`, `within_authority`, `is_admin` | RLS predicate helpers evaluated in the caller's role. They decide which ROWS are visible, never service privilege. Their exposure to forged `sub` is the §5 limitation |
| **Internal, EXECUTE removed by 0084** | 2 | `caller_jwt_role()`, `_resolve_actor` | Verified first: no SECURITY INVOKER function calls either, so every caller is a DEFINER body running as its owner. The API-role grant bought nothing |
| **Trigger helpers that must keep the grant** | 2 | `_is_quotation_delivery_owner()`, `quotations_enforce_insert_initial_state()` | Called from INVOKER trigger bodies, so the invoker needs EXECUTE for the trigger to run. They read `pg_catalog` and return a boolean about the current user — they disclose nothing |

## 7. What migration 0084 changed

**The quotation status read, split by privilege:**

* `_quotation_status_read(company, id)` — the shared implementation, with the `FOR UPDATE` lock
  migration 0067 added. **No authorization inside it, and reachable by no API role** — only its two
  wrappers and the WP12 delivery functions, which run as the same owner.
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
