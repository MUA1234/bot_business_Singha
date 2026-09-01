# Owner decisions record — product recovery

**Date:** 2026-09-02
**Audit approved (conditionally):** `bdf6435e10437851591cae05f6af1665181f79c7`
**Authorised work:** **Phase R0 only.** No R1, no R2, no new management capability.

This is the authoritative record of the owner's decisions. Where any other document
conflicts with it, this record wins (owner instruction is the highest precedence under
the `CLAUDE.md` conflict rule).

## Decisions

| # | Decision | Ruling |
|---|---|---|
| **D-1** | Host | **Railway is the canonical production runtime** for app, webhook, scheduler, outbox drain, follow-ups and management kernel. Vercel may remain **preview-only** and must never run a competing production scheduler or receive the production Meta webhook. **The live Meta webhook must NOT be repointed yet** — prepare and verify in staging, supply the exact change window and rollback procedure, then **stop for owner approval immediately before touching Meta or production.** |
| **D-2** | Inbound company resolution | **Adopt the branch model** — `channel_accounts` + `resolve_channel_company` — as the channel-agnostic routing source of truth. Preserve all live WhatsApp mappings by **deterministic backfill**. Required: dual-read verification, mismatch reporting, cutover criteria, rollback. **Never silently default an unresolved inbound message to Sales or to any other company.** |
| **D-3** | Production truth and staging | **Read-only** production investigation authorised for R0 (see the permission boundary below). A **separate Railway staging service and separate Supabase staging project** are approved **in principle**; stop when an owner must enter credentials, choose billing or create provider access. **Staging must use synthetic or explicitly masked production-shaped fixtures** — no customer messages, phone numbers, addresses or financial records copied into staging. |
| **D-4** | RLS | Database-enforced company isolation is the **approved target state**. `RLS_READS`/`RLS_WRITES` must **not** be enabled in production until staging migration reconciliation passes, role and tenant-isolation tests pass, rollback is rehearsed, **and** the owner gives a final production approval. |
| **D-5** | Spatial workspace | **The intended primary user experience**, not an optional experiment. Must preserve: flat 2D fallback, reduced-motion mode, mobile stacked mode, and a rollback feature flag. **Not production-default** until connected to real management cases and passing human usability testing. |
| **D-6** | Model budget | Existing model gateway and cost ledger **only**. Ceilings: **staging USD 25/month total; pilot USD 50/company/month**; alert at 70%; strong warning at 90%; **fail closed at 100%**. **No paid model calls during R0–R3** without separate approval. Production ceiling to be set from measured pilot usage. |
| **D-7** | First domain | **Finance** proves the complete kernel. The **first extension after the kernel closes successfully must be work/projects**, because staff assignment, supervision and progress management are central to the product. |
| **D-8** | Channel order | **Email second, Google Sheets third.** Voice notes, images and documents remain **gated** pending provider, privacy and retention decisions. |
| **D-9** | Autonomy ceiling | See below — recorded in full because it is a safety boundary. |
| **D-10** | Architecture | **Approved**: one domain-agnostic management kernel; typed observation sources; registered domain actions; persisted management cases; evidence-grounded recommendations; authority and approvals; work allocation; supervision and escalation; outcome verification by re-observation; evidence-bound learning proposals. |

## D-9 — Autonomy ceiling (safety boundary)

The kernel may perform automatically **only** catalogue-registered, low-risk, reversible
**internal** actions within `automatic` authority:

- create an internal task;
- send an internal reminder;
- request a progress update;
- route an internal notification;
- schedule a follow-up;
- escalate an overdue internal task under an approved playbook.

**Always requires human approval:**

- customer messages or commitments;
- quotations with unconfirmed prices;
- payments or transfers;
- material journals;
- contracts;
- permission changes;
- hiring, dismissal, discipline or remuneration decisions;
- external provider commitments;
- irreversible actions.

**AI interpretation never directly executes an action.** Validated policy and authority
controls remain mandatory: Zod schema → deterministic authority rules → permission check
→ audit.

## Amendments and safeguards

1. **Customer-facing AI agents remain a separate connected subsystem.** The management OS
   observes and supervises them **through adapters** — it does not become them. (This
   amends the audit, which had treated them purely as out-of-scope; they are out of scope
   *to build here*, and in scope *to supervise*.)
2. **GPS, CCTV and attendance are future-gated — not permanently deleted.** Do not build;
   do not delete existing scaffolding.
3. **Any production webhook change is a separate owner-approved operation.**
4. **Production-shaped staging data must be masked or synthetic.**
5. **Source-text appearance tests must be replaced by behavioural tests** (PR-F-013).
6. **Every phase requires an independent Codex review before the next phase begins.**
7. **No percentages or file presence may be reported as operational completion.**
8. **Every verified capability requires:** a runtime path, **discriminating** test
   evidence, a deployment axis, and an exact SHA.

## R0 permission boundary (binding)

**Allowed:**

- `npm run migrate:status`;
- documented **SELECT-only** schema and migration-ledger queries;
- read-only verification of the deployed SHA and the webhook destination;
- read-only, unauthenticated HTTP probes of the owner's own public origins.

**Prohibited:**

- migrations; DDL; INSERT/UPDATE/DELETE;
- configuration changes; webhook changes; deployment;
- secret disclosure.

Configured credentials may be **used** but never printed, copied or committed. **Stop if
an operation cannot be proven read-only.**

## Supplementary instruction — Original Vision Reconciliation (2026-09-02)

Issued after the R0 checkpoint. Documentation-only; R1 and implementation remain
unauthorised.

| Ruling | Effect |
|---|---|
| **Meta webhook change deferred** to later owner-controlled provider work | Removed from R1. Record that Railway is healthy and **exposes** the webhook route — but **do not claim inbound WhatsApp is operational**: Meta's callback destination and the Railway configuration are unverified. Meta verification must not block the vision reconciliation. |
| **Railway remains canonical**; no contact with or change to Meta, Railway, Vercel or Supabase | Honoured — this checkpoint made no network call beyond the two read-only probes already recorded in R0. |
| **Hosted migration state and exact deployed SHA remain open production gates** | Carried forward as PR-F-004 / R0-F-002 and PR-F-014 / R0-F-004. |
| **Preserve twelve original requirements**, creating stable IDs where nothing covers them | 20 new IDs across 7 new groups. See [14-VISION-RECONCILIATION.md](14-VISION-RECONCILIATION.md). |
| **Never mark implemented or verified without behavioural evidence** | Verified count unchanged at 60. Two records describing shipped code are `implemented_unverified`, not complete. |
| **Do not weaken an audit because an evidence SHA is invalid; register the defect** | Honoured. The rule was **not** relaxed: IP-001's evidence was re-run at `f86eb97` and the SHA replaced with the commit actually verified; the defect is recorded in the register and as R0-F-005. |
| **Do not let WhatsApp sales workflows define the architecture** | Sales is recorded as one managed operational channel (COM-001) at the same altitude as procurement, fleet or legal. |

### New gates created by this reconciliation

| Gate | Requirement | Why |
|---|---|---|
| Approve the points/credit model, its inputs and its visibility | **WMP-002** | Must not become punitive surveillance or an uncontrolled social-credit system |
| Approve the marketplace model and external-party exposure | **WMP-001** | External consultants must never see internal staff data |
| Approve the fairness and anti-surveillance guardrails **first** | **WMP-003** | Registered as a **blocker on** WMP-002, not a sibling |
| Approve the private-vs-manager-visible coaching model | **WRK-004, WRK-006, AIM-009** | Inherited privacy review; guidance visibility must respect privacy, policy and manager authority |
| Approve the multilingual specification | **LNG-001, LNG-002** | Meaning, permissions and audit evidence must be language-invariant |
| Legal and privacy review before any customer-facing agent work | **CSA-001, CSA-002** | Remains prohibited to build; permitted to supervise via adapters |
| Notices, retention policy and legal review | **GTD-001/002/003** | GPS, CCTV, attendance devices — future-gated, preserved, not deleted. Facial recognition needs **separate** written approval and is excluded |
| Owner gate before any customer-facing campaign execution | **MKT-001** | Campaign sending is an external commitment surface |
| Spatial must not become production-default | **UX-001** (D-5) | Until connected to real management cases and passing human usability testing |

## Effect on the audit's own recommendations

Two audit recommendations are **superseded** by the owner's ruling and must not be acted
on as written:

| Audit said | Owner ruled |
|---|---|
| Retire one origin (either Vercel or Railway) — §10.5 | Railway is canonical; **Vercel is retained as preview-only**, not retired |
| Spatial workspace: keep as an optional flag-gated shell (recommended) — D-5 | Spatial is the **intended primary experience**, with mandated fallbacks |

One is **extended**: customer-facing AI agents are not merely out of scope — the OS must
be able to **supervise** them through adapters when they exist.
