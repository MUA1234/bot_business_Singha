# Singha Central — Status & Handover

_Written 2026-09-12. Reflects the tree at commit `f76cb37`._

A plain-language status readme: what this system is, what the last three working sessions
changed, what was found still open and fixed, and what is waiting on the owner. For the
developer-facing rules see `CLAUDE.md`; for the code-derived inventory see
`docs/CURRENT_IMPLEMENTATION_STATUS.md`.

---

## What this project is

**Singha Central** — a multi-company, event-driven AI **business management** system for a Sri
Lankan construction/trading business. Not a chatbot: WhatsApp (official Meta Cloud API) is one
input among several, feeding a system with department dashboards, an admin panel, a live
quotation flow, and an internally-owned double-entry **Accounting Core** that is the accounting
source of truth (QuickBooks is explicitly void — DECISIONS D-011).

Next.js on Vercel/Railway · Supabase Postgres + RLS · Inngest · OpenAI via a self-built gateway ·
TypeScript + Zod. It runs live on Railway against Supabase project `gazjughejdzebathpscb`, on the
real business number **+94 70 113 5556**.

`CLAUDE.md` is its constitution: human-in-the-loop for money, permissions and employment; AI
output never free-texts into business logic; company isolation proven by tests; GPS/CCTV gated
and unbuilt.

---

## What the previous sessions did

**2026-09-01 — first live audit.** Wired up Railway, the WhatsApp webhook and end-to-end message
tests; replaced hardcoded company, department and currency (migration 0069); created the staff
logins.

**2026-09-11 — five live defects found and fixed** (migration 0070; commits `a4e433e`…`fd41d30`):

- staff created with only a `profiles` row, invisible to `has_membership()`
- `source_events` stuck at `received` for ever
- four accounts locked out by an infinite admin redirect
- price requests routable to departments that cannot answer them
- the `ai-monitor` cron writing a company id as the actor

Applied to production over the service-role REST API, because the hosted database is unreachable
by `psql` (AAAA-only host, no IPv6 route from this machine).

Nothing was left half-done — no dangling todos, clean tree, all gates green.

---

## What was found still open, and fixed (2026-09-12, `f76cb37`)

### 1. Unowned work reached nobody

The previous session flagged this as "a design gap, your call" and left it. It is worse than a
gap: the follow-up sweep selected only tasks with a non-null `assigned_to`, **and** its
worker-directed branch silently did nothing when it could not resolve a phone. Every AI-captured
task has `assigned_to = NULL`, so a due unowned task produced no reminder, no escalation and no
log line.

An unowned due task now escalates to the company's admins — as does one held by a deactivated
assignee. Auto-assignment and auto-triage were deliberately **not** added: that is a business
decision, not a code one. The spam risk was checked directly and pinned with a test — the 7 stale
`captured` tasks have no due date, a state that raises nothing, so this cannot blast the admins
about the old test backlog.

### 2. The integration suite was not idempotent — and it silently broke the gate added the day before

`wp12-enqueue-item-race` must really COMMIT its fixtures (it races two live transactions), and its
cleanup stopped at `memberships` — leaking a company, a profile and identity rows every run. The
orphaned profile then failed `identity-consistency.test.ts`, the very identity-drift gate written
on 2026-09-11, on the **second** run against the same database. Two more files leaked the same way.

Fixed and proven: **333/333, three consecutive runs on one database**. `rpc-concurrency` genuinely
cannot clean up — it commits a posted journal, and posted accounting history is immutable by
design — so its cleanup is now honest and documented instead of a list of swallowed failures.

### 3. `README.md` contradicted the constitution three ways

"Phase 0, no feature code", master-spec-always-wins, and QuickBooks as accounting truth. All three
are explicitly void. Rewritten.

### Plus: the integration database had no committed setup path

Nothing in the repo carried a way to stand up the Supabase-shaped database the 333 integration
tests need, so every session rediscovered it. `scripts/test-db-bootstrap.sql` and
`docs/TEST_STRATEGY.md` §3.1 now do it in one command, including the two traps that fail
misleadingly (missing grants; `auth.uid()` reading only the non-JSON claim).

### Verification

typecheck · lint (0 errors) · secret-scan · migration-lint · inventory · build — all clean.
**Unit 506 (87 files). Integration 43 files / 333 tests** on a disposable PostgreSQL 16 migrated
`0001→0070` from the committed bootstrap. No migration, no schema change, nothing touched on any
hosted environment.

---

## Still needing the owner

Not defects — each was raised and deferred. Treat them as known-open rather than re-auditing them.

| # | Item |
|---|---|
| 1 | **The lockout fix is still unproven live.** It needs one of `shanaka` / `thilak` / `kamal` / `nambi` to sign in — and which real departments those four belong in is still unanswered. |
| 2 | **Real `product_catalog`.** Only two `TEST-*` SKUs exist, both named `procurement`; routing and auto-pricing are capable but unconfigured. |
| 3 | **`OPENAI_PRICE_*` unset on Railway** → `ai_runs.cost_usd` records 0 by design (no guessed rates — D-020). |
| 4 | **`LEGAL.legalEntity` is "Singha Holdings"** and the data-protection contact is a personal Gmail. Both are needed before Meta app review. |
| 5 | **Railway → `singha-web` → Source:** the one-time GitHub OAuth so pushes auto-deploy. Right now deploys need `railway up`. |
| 6 | **`/api/webhooks/email` is still a 501 stub.** |
| 7 | **Credentials pasted into a chat transcript on 2026-09-01 should be rotated:** the Supabase database password, the `sb_secret_…` key, `WHATSAPP_VERIFY_TOKEN`, and the three staff passwords. |

---

## Deployment state

The 2026-09-12 work is **committed locally only** — not pushed, not deployed. Pushing to `main`
and running `railway up` are owner decisions (`CLAUDE.md`: no production deployment without
explicit human approval).
