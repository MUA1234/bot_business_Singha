# Hard-scenario campaign — findings register

**Tested SHA:** `d65c502c565e5dee50840172b456966eca2bf1f5`
**Branch:** `claude/hard-scenario-testing`

Every material finding was **reproduced** before any code was changed. Severity is about
business consequence, not about how hard the bug was to find.

| # | Severity | Area | Status |
|---|---|---|---|
| F-001 | Low | Test strength (campaign suites) | Open — reported, not changed |
| F-002 | High | Marketing / campaigns list | **Fixed** + regression gate |
| F-003 | High | Follow-ups cron | **Fixed** + regression gate |
| F-004 | Medium | Input validation (systemic) | Open — needs an owner decision |
| F-005 | Low | Money transport precision | Open — boundary pinned by a test |
| F-006 | High | Spatial workspace layout | **Fixed** + regression test |
| F-007 | Informational | Test-run environment | Not a product defect |

---

## F-002 — the campaigns list is always empty (High) — FIXED

**Where:** `src/app/app/marketing/campaigns/page.tsx:29`
**Role affected:** any user who can open Marketing → Campaigns.
**Pre-existing at HEAD.** Not introduced by the V3/V4 work; the V3/V4 embed sweep fixed
several sites of this class but missed this one.

**Expected:** the page lists the company's campaigns with their audience names.
**Actual:** the page lists **nothing**, always, with no error shown.

**Cause.** The page embedded `audiences(name)` inside the `campaigns` select.
`campaigns` carries TWO foreign keys into `audiences` — `campaigns_audience_id_fkey` and
the composite tenant-integrity key `campaigns_audience_id_company_fk` — so PostgREST
cannot choose a join path and refuses the request. The refusal is an ERROR with
`data: null`, and the call site ends `.data ?? []`, so the failure renders as "no
campaigns" rather than as a problem.

**Reproduction** (real PostgREST, same credentials, only the embed differs):

```
GET /campaigns?select=id,name,channel,status            -> 200
GET /campaigns?select=id,name,...,audiences(name)       -> PGRST201
   "Could not embed because more than one relationship was found for
    'campaigns' and 'audiences'"
```

**Fix.** Select `audience_id` and resolve the label from the audiences list the page
already loads. Verified: the corrected query returns 200.

---

## F-003 — the follow-ups cron fails on every run (High) — FIXED

**Where:** `src/app/api/cron/follow-ups/route.ts:137`
**Role affected:** every assignee who should receive a reminder or escalation.
**Pre-existing at HEAD.**

**Expected:** the sweep reminds assignees, escalates overdue work, and ranks candidates
by workload.
**Actual:** the route returns **HTTP 500** every time. No reminder, no escalation, and no
follow-up is ever sent. It fails loudly in the log rather than silently — but the
business effect is that the entire follow-up loop is inert.

**Cause.** Workload was read by embedding `memberships` and `tasks` inside a
`task_assignments` select and filtering on the embedded tables' columns.
`task_assignments` holds THREE foreign keys into `tasks` and TWO into `memberships`, so
the embed is doubly ambiguous. `workloadError` is therefore always truthy, and the
handler's fail-closed check returns 500 before any reminder is enqueued.

**Reproduction:**

```
GET /task_assignments?select=membership_id,task_id                       -> 200
GET /task_assignments?select=memberships!inner(user_id),tasks!inner(...)  -> PGRST201
```

**Fix.** Two plain reads — open tasks with their `estimate_hours`, and all assignments —
joined in code against the already-loaded active memberships. The inactive-membership
and completed/cancelled-task filters are preserved exactly.

**Why no test caught either.** `tests/campaign/sch-003-…` asserted the embed's filter
syntax *verbatim*, so a route that could never succeed passed its own suite. That
assertion has been replaced with one that tests the intent, plus a negative assertion
that the ambiguous embed has not returned.

### Regression gate for the whole class

`tests/hard-scenario/g-ambiguous-embeds.test.ts` reads the ambiguous parent/child pairs
from the **live schema catalogue** (42 pairs today) and fails if any source file embeds
across one. It found exactly these two sites and no false positives among the other 13
embeds in `src`. Because it derives its rule from the schema rather than a fixed list, a
future migration that makes a NEW pair ambiguous fails this test instead of silently
emptying a screen.

---

## F-006 — "Save layout" is silently inoperative (High) — FIXED

**Where:** `src/components/spatial/WorkspaceProvider.tsx` (`makeSnapshot`)
**Role affected:** every spatial-workspace user, all roles.
**Introduced by the V3/V4 work under test.**

**Expected:** Save layout stores the arrangement; Restore layout and a refresh bring it
back.
**Actual:** nothing is saved, nothing is restored, and the user is told nothing.

**Cause.** `makeSnapshot` shallow-copied each window with `{ ...w }`. Window state carries
`content` — the window's rendered React tree — for every window opened by the server. The
tree's graph is circular, so `JSON.stringify` threw *before* `localStorage.setItem` was
reached, and `saveLayout`'s `catch` (written for quota and private-mode errors) swallowed
it.

**Reproduction** — in a real browser against the running application, signed in as the
fixture owner:

```
windows open: 6      windows carrying content: 6
Storage.prototype.setItem calls after clicking "Save layout": 0
localStorage keys: []            (localStorage confirmed writable)
JSON.stringify(snapshot) -> TypeError: Converting circular structure to JSON
                            --- property 'default' closes the circle
```

**Second, latent consequence.** Where the graph did *not* close a cycle, the same shallow
copy wrote the **rendered record content** — customer names, money amounts, task text —
into `localStorage`. A standalone reproduction confirmed the serialised snapshot
contained `LKR 1,840,000.00 payable to FIXTURE Northwind supplier`. The type has always
documented `content` as "never persisted"; the code did not honour it. This is precisely
the campaign requirement that no sensitive record data may live in local layout state.

**Fix.** Drop `content` when building the snapshot:
`state.windows.map(({ content: _content, ...w }) => w)`. One change closes both the
broken-save and the data-at-rest problem.

**Regression test.** `tests/spatial/layout-persistence.test.tsx` — verified
discriminating: **2 of its 3 cases fail against the old code** and all 3 pass against the
fix. It asserts the snapshot serialises, that window geometry survives, and that no
`content` key or record text is present.

---

## F-004 — no length bound on any business text column (Medium) — OPEN

**Reproduction:** an authenticated, non-admin user posted a customer record with a
**2,000,000-character** name through the normal data API. It was accepted and stored in
full.

**Scope — this is systemic, not local:**

- Of 448 `text` / `varchar` columns in `public`, **zero** carry a length limit.
- The 28 `CHECK` constraints that use `length()` are **all** in GoTrue's own `auth`
  schema. The application schema has none.
- The write path (`customer-invoices/actions.ts`) trims the form value and inserts it
  without bounding it.

**Consequence:** any authenticated user can consume unbounded storage, and unbounded
values are rendered into pages and reports. This is resource abuse and a UI-integrity
problem. It is **not** a tenant-isolation or financial-integrity break — company scoping
held throughout.

**Why it was not fixed here.** A proportionate fix is either a migration adding CHECK
constraints across the affected columns, or a validation layer at the API boundary. Both
are design decisions with wide blast radius, and a migration is outside the currently
approved phase (`CLAUDE.md`: one approved phase at a time, never build ahead). Silently
patching one column would leave 447 and create a false sense of coverage.

**Recommendation:** decide a standard maximum per column class (identifier, name,
free-text note), then add it as a migration with the enforcement test alongside. The
failing scenario in `tests/hard-scenario/h-security-isolation.test.ts` asserts the
requirement and will pass once bounds exist.

---

## F-005 — money loses precision above ~15 significant digits (Low) — OPEN, pinned

PostgREST serialises `numeric` as an unquoted JSON **number**, so every JS consumer
parses money into a double. This is a Supabase platform characteristic, identical on a
hosted project, not a repository choice.

**Measured** (database truth → PostgREST JSON → JS round trip):

| Stored | Read back | Result |
|---|---|---|
| `1234.5600` | `1234.56` | exact |
| `0.0001` | `0.0001` | exact |
| `99999999999999.9999` | `100000000000000` | **lost 0.9999** |

Realistic amounts survive exactly, because JS prints the shortest representation that
round-trips. The loss begins beyond the double's ~15 significant digits.

`Money.of()` correctly refuses a raw JS number, but `dec()` accepts one via
`String(value)`, so a value that has already lost precision is silently accepted.

**Recommendation:** make `dec()` refuse a `number` argument, so the invariant
"decimal money, never a JS float" fails closed instead of truncating. Not done here
because `dec()` is a core money primitive with many callers and changing it belongs with
a deliberate review, not a test campaign.

The boundary is pinned by a test so it cannot widen unnoticed.

---

## F-001 — two campaign assertions were weakened more than necessary (Low) — OPEN

**Where:** `tests/campaign/gov-001-management-directives.test.ts:63`,
`tests/campaign/int-001-integration-gateway.test.ts:67`
**Introduced by the V3/V4 work under test.**

Both changed `expect(home).toContain('href="/app/admin/directives"')` to a bare substring
`toContain("/app/admin/directives")`. The stated reason is correct — the admin home now
builds its index from a data array, so the JSX literal no longer exists — but the
replacement is weaker than it needed to be: the bare path would match a comment or dead
code.

The admin home renders `href: "/app/admin/directives"`, so
`toContain('href: "/app/admin/directives"')` was available and is as strong as the
original. Verified at `src/app/app/admin/page.tsx:71` and `:92`.

Left unchanged deliberately: it is in the owner's V3/V4 checkpoint, it is cosmetic to
test strength rather than to behaviour, and the brief separates cosmetic from functional.

---

## F-008 — the campaign's own stack trips a privilege-topology test (Informational)

Not a product defect. Recorded because it changes how the integration result must be
read, and because it is a point in the suite's favour.

`tests/integration/found-006-caller-trust.test.ts` — "TOPOLOGY DETECTOR: no login role in
THIS database holds both api and service membership" — **failed** on the campaign stack:

```
expected [ 'authenticator' ] to deeply equal []
```

**Cause is the harness, not the application.** To run real PostgREST, the campaign creates
an `authenticator` login role holding `anon`, `authenticated` and `service_role`. That is
the stock Supabase topology, and it is exactly what OF-017 forbids for this system: the
service backend must have its own login identity that serves no public API traffic.
PostgreSQL roles are **cluster-wide**, so a role created for the `singha_app` database is
visible to a test running against `singha_hst` on the same cluster.

**Attribution proven, not assumed:**

```
revoke service_role from authenticator
  -> tests/integration/found-006-caller-trust.test.ts: 21 passed (21)
grant  service_role to authenticator   (restored — PostgREST needs it)
  -> the topology assertion fails again
```

`postgres` also holds all three memberships (granted by the Supabase shim) but is a
superuser and is correctly not flagged.

**How to read the integration gate:** 696/697 passed on the campaign stack; **697/697
attributable to the application**, with the one failure caused by the test environment's
PostgREST role grant.

**Recommendation for any future harness:** give PostgREST a login role holding only
`anon` and `authenticated`, and reach `service_role` through a separate identity — which
is the topology this test is asking production to adopt.

---

## F-007 — `cron-auth` flakes at the default timeout (Informational)

`tests/campaign/cron-auth.test.ts` intermittently fails on this machine at vitest's
default 5 s timeout, on the FIRST route it dynamically imports (`dispatch drain`) — the
one that pays the cold module-transform cost. With `--testTimeout=30000` all 12 cases
pass.

Not a product defect and unrelated to any change here: the route was not modified. Worth
noting only because a CI machine under load could see the same flake. A per-file timeout
on that suite would remove it.
