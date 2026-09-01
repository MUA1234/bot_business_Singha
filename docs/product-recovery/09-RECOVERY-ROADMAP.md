# 9. Dependency-ordered recovery roadmap, phases and verification criteria

> Covers deliverables 9 and 11. **Nothing here begins until the owner approves the audit
> and the target architecture.**

## 9.1 Ordering principle

The order is forced by dependency, not preference:

1. **Truth before change.** The hosted schema state is currently unknown (PR-F-004).
   Nothing may be applied to production until it is known.
2. **One line before new work.** Two divergent lines with a silent migration collision
   (PR-F-001/2/3) cannot both be built on.
3. **Seam before loop.** The kernel needs domain services to attach to (PR-F-009).
4. **Loop before breadth.** One domain proves the loop end-to-end before twelve use it.
5. **Close the loop before scaling it.** A loop without steps 10b and 11 scales noise.

## 9.2 Phases

### Phase R0 — Establish truth (no code changes)

| Task | Output |
|---|---|
| Determine actual production `schema_migrations` state | Resolves PR-F-004 |
| Confirm the deployed SHA from the Railway dashboard | Resolves PR-F-014 for now |
| Confirm which origin receives the Meta webhook | Confirms PR-F-005 |
| Record 0069–0109 in `MIGRATION_STATE.md` | Resolves PR-F-011 |
| Correct `CLAUDE.md` | Resolves PR-F-015 |

**Verification:** `npm run migrate:status` against production runs and its output is
recorded in `MIGRATION_STATE.md` with a date and a named confirmer. Every migration
0001–0109 has an explicit per-environment state.

**Owner input required:** yes — D-1, D-3. This phase cannot be done by an agent alone.

---

### Phase R1 — Stabilise the deployed system

Small, high-value, entirely within the deployed line. Nothing architectural.

| Task | Closes |
|---|---|
| Repoint the Meta webhook to Railway; confirm the in-process scheduler runs the outbox drain, follow-ups and `ai-monitor` against live traffic | PR-F-005 |
| Retire or neutralise the second origin so two hosts cannot schedule against one database | PR-F-005 |
| Expose the build SHA on `/api/health` | PR-F-014 |
| Add `.gitattributes`; convert the 12 source-text test assertions to behavioural ones | PR-F-013 |
| Harden the migration runner: key the ledger on version **and** filename/content hash, fail closed on mismatch | PR-F-001 (detection) |

**Verification:** a customer message arriving at the live webhook produces a delivered
outbox row **without operator intervention**, evidenced by timestamps; `npm test` is
green on both Windows and Linux checkouts; a deliberately mismatched migration filename
causes `npm run migrate` to abort.

**Risk:** low. **Owner input:** D-1.

---

### Phase R2 — Reconcile the two lines into one

The hardest phase, and unavoidable. 234 commits and 41 migrations must land without
regressing production.

| Task | Closes |
|---|---|
| Choose the inbound company-resolution model and write the data migration | PR-F-003, D-2 |
| Renumber branch migrations 0069–0109 above the deployed high-water mark, preserving 0063–0067 ordering and their self-verifying assertions verbatim | PR-F-001 |
| Port main-only production fixes onto the branch line: `no-store`, `scheduler.ts`, `whatsapp-inbound.ts`, the `routeDepartment ?? "sales"` removal | PR-F-002 |
| Rehearse the full migration on a disposable PostgreSQL 16 **from a snapshot of production's actual state**, not from empty | — |
| Provision a staging environment and run the cutover there first | OPS-004 |

**Verification:** fresh-install and upgrade-path migration runs both succeed; the
upgrade path starts from a production-shaped database; full unit + integration suites
green with `RLS_READS=on` and `RLS_WRITES=on`; a documented, rehearsed rollback exists;
no production fix present on `main` is absent from the merged line (verified by explicit
file-level diff, not by assertion).

**Risk: high.** This is where data loss or a silent schema skip would occur. It deserves
the same external-review discipline the 0048–0067 work received.

**Owner input:** D-2, D-3.

---

### Phase R3 — Build the seam (domain services)

Extraction, not invention. No behaviour change.

| Task | Closes |
|---|---|
| Define `ObservationSource` and `DomainAction` contracts | — |
| Extract finance, work/projects and legal domain services from page code | PR-F-009 |
| Register existing server actions into the action catalogue | — |
| Add the lint/test rules of §7.4 (no domain imports the AI gateway; no domain creates a case) | — |

**Verification:** the three extracted domains have no business logic left in page
components; every extracted function keeps its existing tests, unchanged and passing;
the enforcement tests fail when deliberately violated (proven in both directions, as the
hard-scenario campaign proved the design-lab flag gate).

**Risk:** medium — wide but mechanical. Strictly no behaviour change, so any test that
changes is a defect signal.

---

### Phase R4 — The management kernel, proven on one domain

| Task | Closes |
|---|---|
| Kernel state machine, tables and transitions | — |
| Observation scheduler and registry | PR-F-006 (partly) |
| Wire **finance only**: overdue invoices, budget variance, cash trough | PR-F-006 |
| Route every kernel model call through the gateway and cost ledger | OF-011 |
| Kernel queue surfaces in the Command Centre | — |

**Verification:** an overdue invoice created in a test company produces, without human
action: an observation, a case, an interpretation, a classification, a recommendation
drawn from the catalogue, a correct authority outcome, and a task — evidenced end to end
in the audit trail. Cost per scan cycle is measured and bounded. A model outage degrades
to deterministic operation rather than stopping the loop (proven by test).

**Risk:** medium. Contained to one domain and shippable behind a flag.

---

### Phase R5 — Close the loop

Without this, R4 generates work nobody is given and nothing improves.

| Task | Closes |
|---|---|
| Work allocation service: candidates, availability, workload, fairness, reasons | PR-F-008, OF-008, WRK-005 |
| Skills / competency model | WRK-004 |
| Outcome verification by **re-observation** | loop step 10b |
| Learning store: recommendation outcomes, decision reasons, assignment overrides, detector precision | PR-F-007, AIM-008, IMP-001/002 |
| Learning **proposals** requiring human approval; versioned playbooks and prompts | IMP-003 |

**Verification:** a task assigned by the allocator, completed, and re-observed as
resolved closes its case as `verified`; one that is completed but whose condition
persists **reopens**; an owner rejecting a recommendation records a reason that appears
as a learning candidate; no learning candidate can apply itself without approval (proven
adversarially).

**Risk:** medium. This is the phase that makes the product what the owner described.

---

### Phase R6 — Extend to every domain

Repeat R4's wiring for work/projects, legal/compliance, fleet/assets, procurement,
workforce, CRM/sales, marketing, governance and system health. **Kernel code must not
change** — if it does, R3/R4 did not achieve the architecture.

Also here: re-parent sales as a subsystem (§6.4); email intake (COM-004); the spatial
workspace decision (D-5).

**Verification:** adding a new domain touches only its service module and a registry
entry — demonstrated by diff. Detector precision is measured per domain, and a detector
below its threshold is disabled rather than tolerated.

---

### Phase R7 — Production pilot

| Task | Closes |
|---|---|
| Complete the RLS cutover (`RLS_READS`/`RLS_WRITES` on) | PR-F-012, OF-012 |
| Backup, restore and rollback drills | OPS-003 |
| Incident response and business continuity | OPS-007 |
| Monitored pilot on one company, one domain, observe-only first | OPS-008 |

**Verification:** company isolation proven under RLS by tests that fail with the flags
off; a restore drill executed and timed; the pilot runs a full week with every kernel
action reviewed by the owner before the loop is permitted to act within `automatic`
authority.

## 9.3 Sequencing summary

```
R0 truth ──► R1 stabilise ──► R2 reconcile ──► R3 seam ──► R4 kernel(finance)
                                                                  │
                                                                  ▼
                                              R7 pilot ◄── R6 all domains ◄── R5 close loop
```

R0 and R1 are independent of the architecture decision and can begin as soon as the
owner acts on D-1 and D-3. **R2 is the critical path for everything else.**

## 9.4 What "done" means for each verification

Applying this repository's own standard, which is stricter than most and should not be
relaxed:

- A schema contract, a feature flag, a type, a document, a prompt or a fixture **is not
  implementation**.
- Percentages are never evidence.
- A completion status requires a runtime entrypoint, test evidence and a verified SHA.
- `locally_verified` must not be reported to the owner as "working" — the deployment
  axis is what this audit found missing from the register's model, and every phase above
  states its verification in terms of observable behaviour, not code presence.
