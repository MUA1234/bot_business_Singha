# 12. Owner decisions genuinely required before implementation

> Only decisions that **change what gets built** or that an agent must not take alone.
> Routine engineering judgement is excluded deliberately.

## D-1 — Which host runs the product? **(blocking R1)**

Two origins are live against one Supabase project, and Meta's webhook can point at only
one. Today it points at **Vercel**, while the in-process scheduler runs on **Railway**.
The result: the host receiving customer messages runs no outbox drain, no follow-ups and
no `ai-monitor`; the host running all of them receives no messages. A real customer reply
already sat undelivered in `message_outbox` until an operator drained it by hand
(2026-09-01).

| Option | Consequence |
|---|---|
| **Railway only** (recommended) | Persistent process, real scheduler, no 25-second middleware limit. Matches the owner's stated intent in D-021. Requires repointing the Meta webhook and retiring the Vercel origin |
| Vercel only | Reverts to serverless; Hobby crons cap at 2/day, which is the defect the scheduler was written to fix |
| Both | Not viable as configured — only one can receive the webhook, and two schedulers against one database invite double-processing |

**Needed:** a decision, plus the webhook repoint (an owner action in Meta's console).

---

## D-2 — Which inbound company-resolution model survives? **(blocking R2)**

Both lines independently fixed the hardcoded-company defect, incompatibly.

| Option | Trade-off |
|---|---|
| `main`'s `companies.whatsapp_phone_number_id` | Deployed, carrying live data, simple. WhatsApp-specific — every new channel needs its own mechanism |
| Branch's `channel_accounts` + `resolve_channel_company` (**recommended**) | Channel-agnostic, already built and tested, required for email/document/connector intake. Needs a data migration from the live values |

The target architecture requires many channels, so the branch model is the better
target — but this is the owner's call because it touches live routing of customer
traffic.

---

## D-3 — Authorise a production schema-state check, and a staging environment **(blocking R0/R2)**

The authoritative record says nothing after 0041 was applied; the deployed code requires
0069 (PR-F-004). Until the real state is known, **no migration may be applied to
production**.

**Needed:**
1. Authorisation to run a **read-only** state check (`npm run migrate:status`, or the two
   queries in [04-DATABASE-AND-MIGRATION-STATE.md §4.5](04-DATABASE-AND-MIGRATION-STATE.md#45-verification-commands-the-owner-or-an-operator-should-run)) against production, or the owner running them and sharing the output.
2. A decision on provisioning a **staging environment** (OPS-004, currently
   `blocked_owner`). A management OS that acts on real business state should not have its
   first real execution in production. This has a cost implication.

Optionally, authorising the `claude.ai Supabase` connector would let this be answered
directly. It is currently unauthenticated and cannot be authorised from this
non-interactive session.

---

## D-4 — Enable database-enforced isolation (RLS cutover)?

`RLS_READS`/`RLS_WRITES` are OFF; the app uses the RLS-bypassing service-role client
(PR-F-012, OF-012). Policies are written, migrated and pass the full integration suite
with the flags ON.

`CLAUDE.md` requires cross-company leakage to be "proven impossible by tests" — a proof
that currently holds only in a configuration production does not run. Recommended for
Phase R7, after staging validation. **Requires owner approval because it changes the
live security posture.**

---

## D-5 — What happens to the spatial workspace?

21 components, flag-gated, **not on the deployed branch**, reaching no user.

| Option | Consequence |
|---|---|
| Adopt as the primary shell | Significant UX change; needs its own validation |
| Keep as an optional flag-gated shell over the same panels (**recommended**) | Preserves the work at near-zero cost; the Command Centre panel is already shared |
| Retire | Discards real work — not recommended, and contrary to the preserve instruction |

Not an audit judgement. It is a product decision.

---

## D-6 — Model provider credentials and budget

MOD-001 and OF-003 are `blocked_owner`. Without a live model:

- finance intent classification cannot run, so staff finance intake stays blocked
  (FOUND-003);
- the kernel's step 3 degrades to deterministic rules — the loop still works, but
  without interpretation.

**Needed:** provider credentials, plus a **monthly model budget ceiling** per company.
The budget policy machinery (0092) exists and is enforced; it needs a number.

---

## D-7 — Which domain proves the kernel first?

Recommended: **finance**. It has the deepest existing logic (1,028 LOC of modules), the
best tests, the clearest detectors (overdue, variance, cash trough), and the highest
business value per correct alert.

Alternatives: work/projects (most tasks, most visible), or legal/compliance (deadline
risk, deterministic detectors, low model cost).

---

## D-8 — Which second channel, and when?

Email intake (COM-004) is recommended first: most B2B obligations arrive by email, and
the inbound adapter contract was built to take a second channel. Voice notes (COM-002)
and image/document intake (COM-003) need provider decisions and, for documents, an
evidence-retention policy.

**Note:** each new channel expands what the AI observes, which is the point — and also
expands the privacy surface, so each needs its own approval rather than a blanket one.

---

## D-9 — Autonomy ceiling

The target architecture proposes that the kernel may act **without** a human only within
`automatic` authority — low-risk, reversible, catalogue-registered actions such as
sending an internal reminder or opening a task. Everything else stops at the ladder.

**The owner should confirm this ceiling explicitly**, and confirm the prohibitions
remain absolute: no bank payments or transfers, no material journals, no permission
changes, no hiring/dismissal/discipline, no autonomous customer commitments.

---

## D-10 — Approval of this audit and the target architecture

Required before any implementation begins, per the instruction. Specifically:

1. the target architecture ([06](06-TARGET-ARCHITECTURE.md)) — one kernel, many domain
   adapters, sales re-parented as a subsystem;
2. the management-loop specification ([07](07-MANAGEMENT-LOOP-SPEC.md));
3. the phase ordering ([09](09-RECOVERY-ROADMAP.md)), in particular that **R2 line
   reconciliation precedes all new capability work**.

---

## Decisions deliberately NOT asked

To be clear about scope discipline — these remain closed and are not reopened by the
recovery:

- **GPS, CCTV, attendance tracking, facial recognition** — gated behind legal/privacy
  review. Out of scope.
- **Customer-facing AI agents and the Agent Builder** — gated. The kernel is an
  *internal* management layer; it must not become a route to build these.
- **Multi-country features** — gated.
- **QuickBooks** — void (D-011). The Accounting Core is the source of truth.
- **Paid infrastructure** (Redis, Kafka, queues, orchestration) — the cost rule stands;
  the kernel runs on the existing Postgres + scheduler + outbox spine.
