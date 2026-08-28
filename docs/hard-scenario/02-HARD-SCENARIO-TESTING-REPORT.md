# HARD SCENARIO TESTING REPORT

**Tested SHA:** `d65c502c565e5dee50840172b456966eca2bf1f5`
**Baseline branch:** `claude/uiux-v3-v4-checkpoint` (pushed)
**Testing branch:** `claude/hard-scenario-testing` (pushed)
**Date:** 2026-08-28
**Recommendation:** see [Recommendation](#recommendation).

---

## 1. What was tested, and what "tested" means here

The baseline is the complete UI/UX V3/V4 working tree, preserved and committed as its
own checkpoint before any testing began. Nothing was stashed, discarded or excluded.

Scenarios ran against the **real** application: the real build, the real page and route
handlers, real authentication (GoTrue issuing genuine JWTs), real authorisation
(PostgREST + Postgres RLS), and the real database with all 108 migrations applied.

Exactly two things were substituted, and neither is an application API:

1. **An HTTP gateway** — a path-prefix router standing in for Kong (`/auth/v1` → GoTrue,
   `/rest/v1` → PostgREST). It forwards method, headers and body verbatim.
2. **External provider adapters** — no real WhatsApp, model, payment, email, SMS or voice
   provider was contacted, by configuration and by a process-level network guard.

No authorisation check, business rule or test assertion was weakened to make anything
pass.

---

## 2. Environment

Full detail in [`00-ENVIRONMENT-AND-ISOLATION.md`](./00-ENVIRONMENT-AND-ISOLATION.md).

| Component | Address | Notes |
|---|---|---|
| PostgreSQL 16 | `127.0.0.1:55442` | disposable container; `singha_app` + `singha_hst` |
| GoTrue `v2.196.0` | `127.0.0.1:55444` | real authentication |
| PostgREST `v16.1` | `127.0.0.1:55445` | real RLS enforcement |
| Gateway | `127.0.0.1:54321` | Kong stand-in |
| Application | `127.0.0.1:3241` | real `next start` build |

An unrelated process owns port **3230**. It was treated as outside this campaign: never
used, never inspected, never terminated. `.env.local` was never read, printed, copied or
modified, and no credential value appears in any command, log, commit or this report.

### Seeded roles

| Tenant | Company | Users (created through the real GoTrue admin API) |
|---|---|---|
| A | `FIXTURE — Northwind Placeholder (Pvt) Ltd` | owner, finance, staff, sales |
| B | `FIXTURE-B — Southgate Placeholder (Pvt) Ltd` | owner, finance, staff |

Tenant B exists so cross-company isolation is tested against rows that genuinely belong
to another company and are genuinely readable by that company's own users — otherwise
every isolation assertion could pass because the row simply is not there.

### Provider isolation, verified before any scenario ran

Three independent layers: overridden configuration, a process-level outbound network
guard (`net-guard.cjs`, loaded via `NODE_OPTIONS=--require`), and port isolation. The
guard makes isolation a property of the process rather than of an environment audit being
exhaustive.

```
blocked: https://graph.facebook.com/v20.0/me   -> EHSTNETGUARD   (WhatsApp Cloud API)
blocked: https://api.openai.com/v1/models      -> EHSTNETGUARD   (OpenAI)
blocked: https://api.anthropic.com/v1/messages -> EHSTNETGUARD   (Anthropic)
loopback allowed: gateway -> 200
```

During the whole campaign the guard recorded **zero** blocked attempts from the
application, and no `message_outbox` row was ever marked `sent`.

---

## 3. Scenario matrix

Legend: **Pass** — exercised and the invariant held. **Defect** — exercised, invariant
broken, recorded as a finding. **Not run** — see §7.

| Pkg | Scenario area | Result |
|---|---|---|
| **D** | Maker cannot approve **or reject** their own request (separation of duties) | Pass |
| D | Unauthorised employee (staff submitter) refused an approval | Pass |
| D | No authority rule configured → approval fails **closed**, not open | Pass |
| D | Non-pending request cannot be decided again | Pass |
| D | Unknown request id refused, not silently ignored | Pass |
| D | Invalid action refused | Pass |
| D | Cross-tenant approval decision refused, no action recorded | Pass |
| D | Repeat identical decision is idempotent (no second action row) | Pass |
| D | An actor cannot reverse their own recorded decision | Pass |
| D | 8 concurrent decisions collapse to at most one action | Pass |
| D | Money round-trips exactly at realistic magnitudes | Pass |
| D | Money precision beyond ~15 significant digits | **Defect F-005** (pinned) |
| **H** | Tenant B's owner can read tenant B's rows (control) | Pass |
| H | Cross-company read by direct record id (customer, project, task) | Pass |
| H | Unfiltered list never returns another company's rows (5 tables) | Pass |
| H | Cross-company insert refused and not persisted | Pass |
| H | Cross-company update / delete refused | Pass |
| H | Flipped-signature token refused (401) | Pass |
| H | Payload edited to claim `service_role` refused (401) | Pass |
| H | Expired token refused (401) | Pass |
| H | Anon key alone cannot read business data | Pass |
| H | 13 `/app` routes fail-closed to `/login` when anonymous | Pass |
| H | Cron routes refuse a caller without the shared secret | Pass |
| H | Hostile Unicode (RTL override, BOM, `<script>`, `' OR 1=1 --`) stored as data | Pass |
| H | Oversized input (2,000,000 chars) | **Defect F-004** |
| **I** | Unsigned webhook rejected, nothing persisted | Pass |
| I | Wrong signature rejected | Pass |
| I | Valid signature over a *different* body rejected (tamper) | Pass |
| I | Malformed JSON refused with 400 after signature check | Pass |
| I | Status-only delivery acknowledged, not errored | Pass |
| I | Redelivered webhook → exactly ONE source event | Pass |
| I | Byte-for-byte replay → still one event | Pass |
| I | 6 concurrent identical deliveries → one event, no 500 | Pass |
| I | Out-of-order deliveries each stored under their own identity | Pass |
| I | Two messages in one delivery → two rows, neither holding the other's content | Pass |
| I | Subscription handshake gated on the verify token | Pass |
| I | No message marked `sent` during an offline run | Pass |
| **G** | Spatial workspace mounts, 6 open + 3 minimised windows, real data | Pass |
| G | Window controls present: drag, resize, pin, maximise, minimise, dock, close | Pass |
| G | Close-all-unpinned operates (6 → 3 windows) | Pass |
| G | Reduced-motion and flat-mode toggles present | Pass |
| G | No sensitive record data in local layout state | **Defect F-006** — fixed, re-verified live |
| G | Save layout / restore layout / survives refresh | **Defect F-006** — fixed, re-verified live |
| **Embeds** | No source file embeds across an ambiguous relationship (42 pairs) | **Defects F-002, F-003** |
| **Auth** | Real password sign-in through the real form reaches `/app/admin` | Pass |
| Auth | `/dev/design-lab` gate: 200 with flag on in dev, 404 with flag off | Pass |
| Auth | HSTS / `upgrade-insecure-requests` correctly absent on plain-HTTP local | Pass |

---

## 4. Defects discovered

Full detail, reproductions and evidence in [`01-FINDINGS.md`](./01-FINDINGS.md).

| # | Severity | Summary | Status |
|---|---|---|---|
| F-002 | High | Marketing → Campaigns list was **always empty**; ambiguous PostgREST embed returned an error that `?? []` rendered as "no campaigns" | **Fixed** |
| F-003 | High | Follow-ups cron returned **HTTP 500 on every run**; no reminder or escalation was ever sent | **Fixed** |
| F-006 | High | Spatial **"Save layout" silently did nothing**; the same code would otherwise have written rendered record content into `localStorage` | **Fixed** |
| F-004 | Medium | **No length bound on any of 448 business text columns**; a 2 MB value was accepted | Open — owner decision |
| F-005 | Low | Money loses precision beyond ~15 significant digits over the PostgREST JSON transport | Open — boundary pinned |
| F-001 | Low | Two campaign assertions relaxed further than necessary in the V3/V4 work | Open — reported, unchanged |
| F-007 | Info | `cron-auth` flakes at the default 5 s timeout on this machine (not a product defect) | Info |

F-002 and F-003 were **pre-existing at HEAD** — the V3/V4 embed sweep fixed several sites
of this class but missed these two. F-006 was introduced by the V3/V4 work under test.

---

## 5. Corrections made and regression tests added

Every fix is accompanied by a test that fails without it.

| Fix | Regression test | Discriminating? |
|---|---|---|
| F-002, F-003 | `tests/hard-scenario/g-ambiguous-embeds.test.ts` | Yes — it independently found exactly the two defect sites, with no false positives among the other 13 embeds in `src` |
| F-006 | `tests/spatial/layout-persistence.test.tsx` | Yes — **verified**: 2 of its 3 cases fail against the old code, all 3 pass against the fix |

**F-006 re-verified live** on the rebuilt application, signed in as the fixture owner:

```
Storage.setItem calls after "Save layout": 1  (2087 bytes)
windows saved: 6      any window carrying a `content` key: false
leaked money / company / person names / auth token: false, false, false, false
geometry preserved: win-command x=80 width=760

seeded win-command to x=321 y=234 -> full page reload
  -> hydrated state: x=321 y=234, 6 windows   (restored: true)
```

Save, restore and survive-a-refresh all work, and nothing of the record reaches
`localStorage`.
| F-003 | `tests/campaign/sch-003-…` updated | The old assertion pinned the broken embed's syntax *verbatim*, which is why an unrunnable route passed its own suite. Replaced with an intent assertion plus a negative assertion |

The embed gate reads its rule from the **live schema catalogue** rather than a fixed list,
so a future migration that makes a new parent/child pair ambiguous fails the test instead
of silently emptying a screen.

**No test, authorisation rule or business rule was weakened.** The one relaxation found
(F-001) was reported rather than accepted, and the SCH-003 change made that suite
strictly stronger.

---

## 6. Unresolved risks

1. **F-004 — unbounded text, systemic.** Any authenticated user can store unbounded data
   in any business text column. Needs a decision on maximum lengths per column class,
   then a migration. Company scoping was never breached.
2. **F-005 — money precision ceiling.** Correct for realistic amounts; loses precision
   beyond ~15 significant digits. Recommended hardening is to make `dec()` refuse a JS
   `number` so it fails closed.
3. **Authority rules are unseeded.** The fixture company has no `authority_rules` rows.
   The system fails closed, which is the correct behaviour and what was verified — but
   the *populated* authority-ceiling path (approve below / at / above a limit) was
   therefore not exercised end to end.
4. **`.env.local` in the working tree.** It carries real provider credentials and is
   loaded by `next build` / `next start`. This campaign neutralised it with explicit
   overrides plus the network guard. Any future local run without those layers could
   reach real providers. Consider a checked-in guard that refuses to start when
   `APP_ENV` is not production and provider hosts are not loopback.
5. **The V3/V4 checkpoint adds ~140 MB of screenshot evidence** (188 PNGs) to the
   repository. Consistent with existing precedent (`screenshots/uiux-v1` is 59 MB
   tracked), but repository growth is now material.
6. **`docs/DECISIONS.md` contains an unfilled heading** — `## D-0xx` where the
   convention (D-001 … D-021) implies D-022. Left unchanged: renumbering an owner's
   decision record is the owner's call.

---

## 7. Not covered — and why

These are stated plainly rather than implied by silence.

- **Packages A, B, C, E, F were not executed as scenario suites.** Owner/AI management,
  staff task operations, CRM and sales, projects and operations, and assets and fleet
  were not driven end to end in this campaign. Time went into building the isolated
  real-services stack and into the three High-severity defects found in D/G/I and the
  embed class. The existing repository suites cover much of this ground at unit and
  integration level (see §8), but **not** as the multi-step adversarial scenarios the
  brief describes.
- **Live-model AI evaluation was not run.** `ANTHROPIC_API_KEY` was deliberately left
  empty and the network guard blocks the provider, so no model was called. The AI
  response-quality criteria (factual grounding, uncertainty handling, injection
  resistance, escalation) are therefore **unmeasured** in this run. The repository's own
  harness reports this as BLOCKED rather than estimating it, which is the correct
  behaviour. Prompt-injection *fencing* is covered by existing unit tests
  (`tests/prompt-injection.test.ts`), but not by a live adversarial exchange.
- **Spatial workspace breadth.** The workspace was verified to mount and operate with
  real data and full window controls, and the layout-persistence defect was found and
  fixed. Not covered: 20+ simultaneous windows, drag/resize/dock by pointer gesture,
  simultaneous multi-priority arrivals, permission loss while a window is open,
  390/768/1440/large-touch viewports, and touch-only vs keyboard-only operation.
- **Accessibility checks, dependency scan.** Not run. (Secret scan **was** run and is
  clean; lint, typecheck and build were run.)

---

## 8. Final gate results

All against the fixed tree on `claude/hard-scenario-testing`.

| Gate | Result |
|---|---|
| Typecheck (`tsc --noEmit`) | **Clean** |
| Lint (`next lint`) | **Clean** (3 pre-existing `<img>` warnings) |
| Unit suite | **182 files, 1326 passed, 2 skipped** |
| Integration suite (live PostgreSQL 16) | **76/77 files, 696/697 passed** — the one failure is the campaign's own PostgREST role grant, not the application (F-008, attribution proven) |
| Hard-scenario suites, re-run against the rebuilt app | **40/41 passed** (4 files) — the one failure is F-004, the known open defect |
| — D, finance and approvals | 13/13 passed |
| — H, security and tenant isolation | 13/14 passed (F-004 open) |
| — I, reliability and chaos | 12/12 passed |
| — Ambiguous-embed regression gate | 2/2 passed after the fixes (it reported 3 offending embeds before them) |
| Spatial layout-persistence regression | **3/3 passed**; verified to fail 2/3 without the fix |
| Production build | **Clean** — compiled successfully, 110/110 static pages |
| Secret scan | **Clean** — no tracked secrets |
| Migration lint | **Clean** — 108 migrations, sequential 0001–0108 |
| `supabaseAdmin` allowlist check | **Clean** |
| Autonomy requirement + IP-boundary audits | **Clean** |

Baseline comparison (unmodified HEAD `8c71c81`, before any fix and before the campaign
stack existed): integration **77 files / 697 tests passed**.

**On the single integration failure.** `FOUND-006 — TOPOLOGY DETECTOR` fails on the
campaign stack because the harness gives PostgREST an `authenticator` login role holding
`anon`, `authenticated` and `service_role` — the stock Supabase topology, and precisely
what OF-017 forbids for this system. PostgreSQL roles are cluster-wide, so a role created
for one database is seen by a test running against another on the same cluster.
Attribution was **proven, not assumed**: revoking the grant makes that file pass 21/21,
and restoring it reproduces the failure. No application code is implicated, and the test
behaved correctly — it caught a privilege weakening introduced by infrastructure around
it. See F-008.

---

## 9. Items requiring genuine external-provider testing

Nothing in this campaign touched a real provider, so these remain unverified by
construction:

- WhatsApp Cloud API delivery: template approval, the 24-hour customer-service window,
  real Meta error codes, and real redelivery behaviour.
- Live model behaviour through the AI gateway (OpenAI in production routes; Anthropic on
  the evaluation route) — cost accounting, latency, budget enforcement under real usage.
- Inngest durable job execution (`WHATSAPP_ASYNC` was off).
- Push delivery via VAPID.
- Hosted Supabase specifics: connection pooling under load, and whether the hosted
  PostgREST version resolves any embed differently.

## 10. Items requiring human acceptance

- Visual and interaction acceptance of the V3/V4 spatial interface across the four target
  viewports and the touch/keyboard-only modes (§7).
- The F-004 decision on maximum text lengths.
- Whether to adopt the F-005 hardening of `dec()`.
- Whether ~140 MB of screenshot evidence should remain tracked in the repository.
- The `D-0xx` decision-record number.

---

## 11. Rollback

Nothing was merged, deployed, or applied to any hosted service. The hosted database was
not migrated. All work is on two pushed branches, and `main` is untouched.

```bash
# Discard the testing work entirely, keeping the UI/UX checkpoint:
git checkout claude/uiux-v3-v4-checkpoint
git branch -D claude/hard-scenario-testing
git push origin --delete claude/hard-scenario-testing

# Revert only the three code fixes, keeping the tests and findings:
git revert edbc863

# Discard everything and return to the original branch state:
git checkout kimi/uiux-v2-spatial-workspace   # HEAD 8c71c81, as before this work

# Tear down the disposable environment (nothing else is affected):
docker rm -f singha-hst-pg16 singha-hst-gotrue singha-hst-rest-app singha-hst-postgrest
```

The three application fixes are individually small and independently revertible:
`src/app/app/marketing/campaigns/page.tsx`, `src/app/api/cron/follow-ups/route.ts`,
`src/components/spatial/WorkspaceProvider.tsx`.

---

## Recommendation

**Conditionally accept for staging** — conditional on the items below, and explicitly
**not** a statement of production readiness.

The system's hardest invariants held under direct attack. Cross-company isolation was not
breachable by record id, by unfiltered listing, by insert, update or delete, or by a
forged, re-signed or expired token. The approval path refused self-approval, unauthorised
approvers, cross-tenant decisions, and reversal of a recorded decision, and it failed
closed where authority was unconfigured. The webhook boundary rejected every
unauthenticated variant and collapsed redelivered, replayed, reordered and concurrent
deliveries to exactly one event each. These are the properties that matter most, and they
are sound.

Three High-severity defects were found and fixed, each with a regression test. Two of them
— an always-empty campaigns list and a follow-up cron that had been returning 500 on every
run — had passed the existing suites because those suites asserted query syntax that the
database can never execute. That pattern, not the individual bugs, is the most important
result of this campaign, and the schema-derived embed gate now closes it.

Conditions before staging:

1. Decide and implement F-004 (unbounded text), or accept it explicitly with a rationale.
2. Seed and exercise the populated authority-ceiling path — approvals below, at and above
   a configured limit are currently unverified end to end.
3. Run packages A, B, C, E and F, and the spatial breadth items in §7. A meaningful part
   of the brief was not executed.
4. Add a checked-in provider guard so a local run cannot reach a real provider without a
   deliberate opt-in.

Do not merge, deploy or migrate any hosted service on the strength of this report. It
covers what can be proven on a disposable local stack, and says plainly where that
stopped.
