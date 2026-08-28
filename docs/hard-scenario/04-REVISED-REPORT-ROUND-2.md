# HARD SCENARIO TESTING — REVISED REPORT (ROUND 2)

**Baseline SHA (code under test):** `d65c502c565e5dee50840172b456966eca2bf1f5`
— branch `claude/uiux-v3-v4-checkpoint`, the preserved UI/UX V3/V4 checkpoint.
**Round 1 checkpoint:** `91ec444`
**Testing branch:** `claude/hard-scenario-testing`
**Date:** 2026-08-28
**Recommendation:** [conditionally accept for staging](#recommendation). **Production
remains prohibited.**

Supersedes `02-HARD-SCENARIO-TESTING-REPORT.md`. Round-1 findings are carried forward
with their current status.

---

## 1. Round-2 remediation — what was asked, and what happened

| # | Item | Outcome |
|---|---|---|
| 1 | Harness integrity; genuine 697/697; add a self-check | **Done.** Topology fixed at the root; integration genuinely 697/697 twice; 27-check self-check gates the suites |
| 2 | Review F-001 | **Done.** Original assertion proven invalid; replaced with a strictly stronger one, mutation-verified |
| 3 | Remediate F-004 | **Done.** Migration 0109 bounds 280 externally-writable columns; 10 tests |
| 4 | Remediate F-005 | **Done.** `dec()` fails closed outside the exact range; 20 exact-equality tests |
| 5 | Execute packages A, B, C, E, F | **Done.** 9 files / 107 scenario tests |
| 6 | AI behaviour with deterministic fixtures | **Done.** 18 cases. Live-model quality remains `blocked_owner` |
| 7 | Complete spatial coverage | **Mostly done.** 17 state/scale tests + a 4-viewport browser audit. Gaps named in §7 |
| 8 | Screenshot artifact policy | **Done.** `artifacts/` gitignored, checksums recorded, merge strategy written |
| 9 | Final gates, adversarial review, revised report | **Done.** §6 |

---

## 2. Item 1 — harness integrity, resolved at the root

Round 1 reported one integration failure and attributed it to the harness. That
attribution was correct but the reasoning was not good enough, so the cause was removed.

`found-006-caller-trust` asserts **OF-017**: no non-superuser login role may hold both
api (`anon`/`authenticated`) and service (`service_role`) membership, because one
`SET ROLE` from public API traffic would then reach full service authority. The harness
used a single `authenticator` role holding all three — stock Supabase topology, and
exactly what the test forbids.

The harness now does what the test asks production to do:

| Role | anon / authenticated | service_role |
|---|---|---|
| `pgrst_api` | yes | **no** |
| `pgrst_service` | **no** | yes |

Two PostgREST instances sit behind the gateway, which routes `/rest/v1` by the token's
`role` claim — so the api identity is never even connected to for a service-role request.
The claim only selects an upstream; PostgREST still verifies the signature, so a forged
claim lands on an instance whose role cannot serve it. The merged `authenticator` role
was dropped.

**Result: integration 77 files / 697 tests / 0 failures**, confirmed twice — once after
the topology fix, and again after migration 0109 was applied.

### The self-check (`scripts/hard-scenario/harness-selfcheck.mjs`)

27 deterministic checks that must pass **before** application tests are trusted:
loopback-only services, the role topology, grants (`anon`/`authenticated`/`service_role`
hold no CREATE), schema/migration/auth state, both tenants seeded, RLS live on the core
tables, residue from previous runs, and the outbound guard exercised against the three
real provider hosts.

It earned its place immediately by failing three times on real problems — twice on its
own assertions, once on genuine residue:

1. It accepted only an empty anon result when a `42501` permission denial is *stronger*.
2. It found two 2 MB residue rows left by an earlier scenario.
3. It hard-coded `migs === 108` and went stale when 0109 landed — now it asserts the
   invariant (applied count equals migration files on disk).

---

## 3. Item 2 — F-001, reviewed and strengthened

**Before:** `expect(home).toContain('href="/app/admin/directives"')` — a JSX attribute
literal.

**Why it was invalid, not merely outdated:** the admin home builds its index from a data
array rendered through `.map()` into `<Link>` (`src/app/app/admin/page.tsx:71`, `:92`).
That literal **cannot exist** however well the link works. The assertion tested a
rendering syntax, not a business invariant. Round 1's replacement — a bare path substring
— was weaker than necessary, since a path also matches a comment or dead code.

**After:**

```ts
expect(home).toContain('href: "/app/admin/directives"');
expect(home).toMatch(/href:\s*"\/app\/admin\/directives"[^}]*label:\s*"Directives"/);
```

**Verified discriminating by mutation:**

| Mutation | Result |
|---|---|
| `href` changed to `/app/admin/REMOVED` | gov-001 **fails** |
| Label renamed `Integrations` → `Connectors` | int-001 **fails** |

The label mutation is caught by the new assertion and would **not** have been caught by
the original — so this is stronger than what was there before the checkpoint, not merely
a restoration. The end-to-end half is asserted live in package A (A12): the routes
resolve for an admin and fail closed for an anonymous caller.

---

## 4. Items 3 and 4 — F-004 and F-005 remediated

### F-004 — bounded user text (`0109_bounded_user_text.sql`)

**Scoped by measurement, not by guess.** 280 unbounded text columns across the 104 tables
that carry an INSERT/UPDATE policy **and** an `authenticated` grant — the externally
writable surface — not all 448. Service-only and system tables are untouched: they are
unreachable by a user, and constraining them would risk breaking trusted writers.

Limits are per column **purpose**: contact 320/32, url/path 2048, enum-like 64,
identifier 256, label 256, prose 8000, default 1000. The longest value in any of these
columns on a fully seeded database is **91 characters**, so nothing legitimate is near a
limit.

**Nothing is truncated.** These are CHECK constraints: an oversized write is refused.
Trimming an identifier would corrupt a record rather than protect it.

10 tests (`tests/hard-scenario/f004-bounded-text.test.ts`): the original 2 MB defect,
exact-limit vs one-over boundaries, an oversized UPDATE leaving the record untouched,
`service_role` bound by the same limit, a bulk import refused whole with no partial row,
a tighter column class — and, because a byte-based limit would have been a bug for this
business's own customers, **200-character Sinhala names, emoji and multiline prose all
accepted unaltered** (the constraint uses `char_length`, not bytes).

Package H is now **14/14**; the previously open H6 scenario passes.

### F-005 — money exact or refused

Full path traced: parse → validate → persist → **transport** → calculate → format.
The single gap is the transport: PostgREST serialises `numeric` as an unquoted JSON
number, so every read arrives as a double. That is a platform property, identical on
hosted Supabase.

`dec()` accepted such a number silently. It now refuses any number at or beyond `1e12`,
or with more than 15 significant digits, or non-finite — the region where a double can no
longer carry two-to-four decimal places — and the error names the durable fix
(`select("amount::text")`, which PostgREST answers with a quoted decimal string). Below
that range the round trip is provably lossless, so existing reads are unaffected: the
full unit suite passes.

20 tests (`tests/money-boundary.test.ts`) assert **exact** equality throughout — no
`toBeCloseTo` anywhere, because an approximate assertion about money is the same mistake
as a float, moved into the test suite. Covers the accept/refuse boundary, `0.1+0.2`,
`1.005-1.00`, a 1000-term sum a float gets wrong, zero- and three-decimal currencies,
bankers' rounding in four directions, line totals at awkward quantities, and one value
compared exactly at every stage.

---

## 5. Items 5–7 — campaigns executed

**9 files / 107 scenario tests, all passing.**

| Pkg | Coverage | Cases |
|---|---|---|
| A | Owner + AI matrix: grounded, missing info, uncertainty, malformed, contract-violating, prose, timeout, injection fencing, per-company binding, disagreement, budget exhaustion, admin surfaces reachable/fail-closed, AI runs company-scoped, no action without approval | 18 |
| B | Service-only RPC boundary, creation, duplicate and 6-way concurrent dedup, eligibility (foreign member, self-assignment, suspended), assignment integrity, concurrent updates, undeclared status refused, permission loss mid-task, append-only routing ledger | 14 |
| C | Enquiry capture, cross-channel identity, shared phone across tenants, multilingual round-trip, prompt injection as data, opt-out, human handover, quotation initial-state and RPC-only delivery, nothing sent | 12 |
| D | Approvals (unchanged from R1) | 13 |
| E/F | Project/task linkage, cross-project refused, late dependency, risks, manager vs other-company visibility, trips, maintenance, retired assets keep history, fleet isolation, **F-009**, **F-010** | 14 |
| H | Security and tenant isolation | 14 |
| I | Reliability and chaos | 12 |
| Embeds | Ambiguous-embed gate | 2 |
| F-004 | Bounded text | 10 |

### AI behaviour — what is and is not claimed

Package A drives the **real** `AiGateway` (real fencing, real Zod contract, real cost
ledger) with deterministic fixtures injected through the production
`CompletionTransport`. That makes functional behaviour repeatable.

It does **not** measure response quality. No live model was called: `ANTHROPIC_API_KEY`
is empty and the outbound guard blocks the provider. **Live-model evaluation remains
`blocked_owner`** — see §9 for the bounded plan and cost estimate.

### Spatial coverage

17 reducer tests: 25 simultaneous windows with distinct z-order all inside bounds, focus
raising exactly one, duplicate window requests and the same record opened two ways
collapsing to one, and the honest states (loading / error / stale / permission-denied as
independent flags). *A failed request must never render as "there is nothing here"* — the
F-002 lesson expressed in the interface.

Browser audit at 390 / 768 / 1440 / 2560, touch and reduced-motion, real GoTrue sign-in:

```
mobile-390        overflow=false  offscreenFocusable=0  focusable=104  localStorage=[]
tablet-768        overflow=false  offscreenFocusable=0  focusable=104  localStorage=[]
desktop-1440      overflow=false  offscreenFocusable=0  focusable=109  localStorage=[]
large-touch-2560  overflow=false  offscreenFocusable=0  focusable=109  localStorage=[]
keyboard: 40 tab stops reached, command palette reachable
skip link present; landmarks present; no unnamed buttons; no missing alt
```

---

## 6. Item 9 — final gates

| Gate | Result |
|---|---|
| Harness self-check | **27/27** (gates everything below) |
| Unit suite | **184 files / 1363 passed, 2 skipped** |
| Integration (live PG16) | **77 files / 697 passed, 0 failed** — genuine |
| Hard-scenario suites | **9 files / 107 passed** |
| RLS / tenant isolation | Included above (H 14/14, `rls-coverage`, `rls-matrix-coverage`, `company-isolation`) |
| Typecheck | **Clean** |
| Lint | **Clean** (3 pre-existing `<img>` warnings) |
| Build | **Clean** — see §6.1 |
| Browser + accessibility audit | **PASSED** across 4 viewports |
| Secret scan | **Clean** |
| Migration lint | **Clean** — 109 sequential, no gaps |
| Fresh-database migration | **109 applied cleanly** to an empty database |
| Staged 0108 → 0109 upgrade | **Fails closed on violating data; succeeds after remediation**; converges byte-identically with fresh (280 constraints, 109 migrations) |
| Rollback rehearsal | **280 → 0 → 280**, ledger 109 → 108 → 109, data intact |
| Dependency scan | **2 high** — see §8 |

### 6.1 Migration and rollback rehearsal, in detail

The staged upgrade was run against **populated** data deliberately containing a
256-limit-violating row:

```
applying 0109 to data containing a 5000-char customer name
  -> FAILED: check constraint "customers_name_len_chk" is violated by some row
  -> the 5000-char row is INTACT at 5000 characters (nothing truncated)

operator removes the offending row (a decision, not a silent trim)
  -> 0109 applies cleanly
  -> hst_fresh and hst_staged both: 280 len_chk constraints, 109 migrations
  -> the legal 200-char row survived untouched
```

Rollback (`scripts/hard-scenario/rollback-0109.sql`) drops the constraints and the ledger
row; it touches no data, because 0109 only ever added constraints. Verified round-trip.

---

## 7. Findings register (all rounds)

| # | Sev | Summary | Status |
|---|---|---|---|
| F-002 | High | Campaigns list always empty (ambiguous embed) | **Fixed** R1 |
| F-003 | High | Follow-ups cron 500 on every run | **Fixed** R1 |
| F-006 | High | Spatial "Save layout" silently inoperative; would have persisted record content | **Fixed** R1 |
| F-004 | Medium | No length bound on user-writable text; 2 MB accepted | **Fixed** R2 (0109) |
| F-005 | Low | Money precision lost beyond ~15 significant digits | **Fixed** R2 (`dec()` fails closed) |
| F-001 | Low | Two assertions weakened in the checkpoint | **Fixed** R2 (stronger, mutation-verified) |
| F-008 | Info | Harness tripped the OF-017 topology test | **Fixed** R2 (topology corrected) |
| **F-009** | **Medium** | **A trip in company A can be charged to company B's project** | **Open** — owner gate |
| **F-010** | **Low/Med** | **A trip's end odometer may be lower than its start** | **Open** — owner gate |
| F-007 | Info | `cron-auth` flakes at the default 5 s timeout on this machine | Open (environmental) |
| F-011 | — | *Withdrawn.* Dock restore buttons appeared unreachable at 1440; they are not | Not a defect |

### F-009 — cross-tenant foreign-key gap (Medium, OPEN)

`trips` carries a composite tenant-integrity key for the vehicle
(`trips_vehicle_id_company_fk` on `(vehicle_id, company_id)`) but only a **single-column**
key for `project_id`. The pattern was intended here and missed.

**Reproduced with an ordinary authenticated user**, not just `service_role`: a tenant-A
user created a trip in company A referencing tenant-B's project, and the row was accepted.

A catalogue audit finds **103** single-column references where both child and parent carry
`company_id` and no composite counterpart exists — the same class as the 42 pairs that
*did* receive composite keys.

Severity is Medium, not Critical: it corrupts referential integrity across tenants and
couples two companies' rows, but it is not a read leak on its own, because the attacker
must already know the foreign UUID (which is not enumerable — cross-tenant reads are
blocked, as package H confirms).

**Not fixed here.** It needs `unique(id, company_id)` on several parents plus ~103 new
constraints — too large to land unvalidated at the end of a round, and a schema change of
that size is an owner decision. Pinned by a test that fails if the gap widens.

### F-010 — impossible odometer readings (Low/Medium, OPEN)

A trip's `end_odometer` may be lower than its `start_odometer`. No CHECK, no write-path
guard. The impossible value flows into fuel-efficiency and maintenance-interval
calculations. Fix is a one-line constraint; pinned by a test asserting current behaviour.

Both pinning tests state explicitly that the expectation must be **inverted** when fixed,
so a fix cannot land silently.

### Unconfirmed observation

The viewport audit reports **1 focusable control below the WCAG 2.5.8 24×24 px minimum**
(a 20×20 input) at every viewport. It could not be re-identified in a later live session,
so it is recorded as an observation needing confirmation — **not** as a finding.

---

## 8. Unresolved risks and owner gates

1. **F-009** — decide on the composite-FK migration (103 constraints).
2. **F-010** — one-line odometer constraint.
3. **Dependency scan: 2 high severity**, both `postcss` reached transitively through
   `next`. `npm audit fix --force` would change the Next major version — a breaking
   change and an owner decision, not a testing-round action.
4. **Authority ceilings are unseeded.** The system fails closed with no rule configured,
   which is correct and is what package D verifies — but the *populated* path (approve
   below / at / above a limit) is still unexercised end to end.
5. **`.env.local`** carries real provider credentials and is loaded by `next build` /
   `next start`. This campaign neutralised it with overrides plus a process-level network
   guard. A checked-in guard that refuses to start when `APP_ENV` is not production and
   provider hosts are non-loopback would make that safe by default.
6. **~140 MB of screenshots** in the checkpoint's history — see
   `03-MERGE-CANDIDATE-STRATEGY.md`.
7. **`D-0xx`** unfilled decision-record number in `docs/DECISIONS.md`.

## 9. Requires genuine external-provider testing

Untouched by construction — the guard blocked every attempt:

- WhatsApp Cloud API delivery: template approval, the 24-hour window, real Meta error
  codes, real redelivery.
- **Live-model evaluation — `blocked_owner`.** A bounded plan, for approval:
  ~40 scenario prompts × ~2 k tokens in / ~1 k out on the `evaluation` route
  (`claude-opus-5`), run once, capped by `EVAL_LIMITS` (200 requests/process, 2 k output
  tokens, 60 s timeout) — **an estimated USD 3–6 in total**. It would measure grounding,
  uncertainty handling and injection resistance, which fixtures cannot. **Not run: it
  needs explicit owner approval and a key.**
- Inngest durable execution (`WHATSAPP_ASYNC` off).
- Push delivery via VAPID.
- Hosted Supabase behaviour under pooling and load.

## 10. Requires human acceptance

- Visual/interaction acceptance of the V3/V4 interface (measurements pass; taste does not
  automate).
- Touch-only operation on real hardware — emulated touch was exercised, a finger was not.
- The F-009 and F-010 decisions, and the dependency upgrade.

## 11. Artifacts

Binaries are **not** committed. Regenerate and compare checksums.

| Artifact | Location | SHA-256 |
|---|---|---|
| Spatial viewport/accessibility audit | `artifacts/hard-scenario/spatial-viewport-audit.json` | `219b13465498245ae6a26a51cd7fc3b24647834d9d056fc4281149207d1c5082` |

Produced against the application built from `claude/hard-scenario-testing` on the local
stack. `artifacts/` and `.playwright-mcp/` are gitignored.

## 12. Rollback

Nothing merged, deployed, or applied to any hosted service. The hosted database was not
migrated. `main` is untouched.

```bash
# Undo the R2 remediation only, keeping R1:
git revert 2b88d07 62e6334

# Roll back migration 0109 on a local database:
psql "$DATABASE_URL" -f scripts/hard-scenario/rollback-0109.sql

# Discard the testing branch entirely, keeping the UI/UX checkpoint:
git checkout claude/uiux-v3-v4-checkpoint
git branch -D claude/hard-scenario-testing
git push origin --delete claude/hard-scenario-testing

# Return to the original pre-campaign branch state:
git checkout kimi/uiux-v2-spatial-workspace   # HEAD 8c71c81

# Tear down the disposable environment:
docker rm -f singha-hst-pg16 singha-hst-gotrue singha-hst-rest-api singha-hst-rest-svc
```

---

## Recommendation

**CONDITIONALLY ACCEPT FOR STAGING.** Production remains prohibited.

Round 1's gaps are closed. The integration suite passes **genuinely** — the privilege
topology it objected to was corrected rather than explained away, and a 27-check
self-check now gates every run so a future result cannot be excused the way the last one
was. F-001, F-004 and F-005 are remediated with discriminating tests, one of them
mutation-verified. The five omitted campaigns ran, and the AI matrix is honest about the
line between functional behaviour and unmeasured quality.

The system's core invariants held under sustained attack across both rounds: cross-company
reads and writes, forged and expired tokens, self-approval, unauthorised approvers,
duplicate and concurrent webhooks, duplicate and concurrent task creation, and unbounded
input are all refused. Money is now exact or refused. The migration path was rehearsed
forwards on populated data — where it correctly **failed closed rather than truncating** —
and backwards to a clean rollback.

Two open findings keep this short of unconditional acceptance. **F-009** is the more
important: the tenant-integrity pattern applied to 42 relationships was not applied to
103 others, and one of them is exploitable by an ordinary user today. It is bounded and
mechanical, but it is a schema decision the owner should take deliberately.

Conditions before staging:

1. Decide **F-009** (composite-FK migration) and **F-010** (odometer constraint).
2. Decide the **dependency upgrade** (2 high, `postcss` via `next`).
3. Seed and exercise the **populated authority-ceiling** path.
4. Add a checked-in **provider guard** so a local run cannot reach a real provider.
5. Approve or decline the **live-model evaluation** (~USD 3–6) — response quality is
   otherwise unmeasured.
6. Take the **merge-candidate** approach in `03-MERGE-CANDIDATE-STRATEGY.md` so ~140 MB
   of screenshots never enters the merged history.

Do not merge, deploy, or migrate any hosted service on the strength of this report.
