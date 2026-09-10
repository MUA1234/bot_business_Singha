# Original Vision Reconciliation

**Documentation-only checkpoint, 2026-09-02.** No product code, migration, RLS policy, API
contract, production configuration or business control was changed. R1 was not started.

**Governing principle applied throughout:** the product is a total AI-driven business
management operating system. **WhatsApp sales workflows are one managed operational
channel and were not permitted to define the architecture** — they appear below as
COM-001 and the Sales subsystem, at the same altitude as procurement or fleet.

## What changed in the register

| | Before | After |
|---|---|---|
| Requirements | 90 | **110** |
| Groups | 20 | **27** |
| `locally_verified` | 60 | 60 |
| **`staging_verified`** | **0** | **0** |
| **`production_verified`** | **0** | **0** |
| Deployment axis recorded | no | **yes — on all 110** |

Nothing was marked implemented or verified. The two records that describe substantial
existing code (PRC-001 procurement, FIN-009 accounting core) are `implemented_unverified`
— the code demonstrably exists, but no requirement-level behavioural evidence has been
assembled against those records and no SHA verified for them. Claiming otherwise would be
the exact failure the register exists to prevent.

`npm run autonomy:audit` passes: **registered=110, verified=60, unexpanded-groups=0,
register internally consistent.**

## The owner's twelve preserved requirements — where each now lives

| # | Owner requirement | Requirement IDs | Status |
|---|---|---|---|
| 1 | Work marketplace for staff, AI bots and approved external consultants | **WMP-001** (new) | `absent` |
| 2 | Point/credit opportunity and bidding/ranking window, fair, **not** surveillance or social credit | **WMP-002** (new) + **WMP-003** (new, the guardrails) | `absent` — WMP-003 must be satisfied **before** WMP-002 |
| 3 | AI recommendations: assignees, teams, advisors, delegates, external consultants | AIM-006, WRK-005 (existing) + **WRK-007** (new — advisors and delegates) | `specified` / `absent` |
| 4 | Staff-initiated "Ask AI" guidance with privacy- and authority-respecting visibility | **AIM-009** (new) | `absent` — AIM-007's own residual already recorded Ask-AI as not built |
| 5 | Per-staff language preference EN/SI/TA preserving meaning, permissions, audit | LNG-001, MOB-004 (existing) + **LNG-002** (new — the invariance) | `absent` |
| 6 | Skills, strengths, workload, performance, development, coaching — explainable and fair | WRK-002, WRK-003, WRK-004 (existing) + **WRK-006** (new — explainability and fairness) | `absent` |
| 7 | Customer-facing AI agents as a **separate** subsystem supervised via adapters | **CSA-001**, **CSA-002** (new) | `blocked_owner` — legal/privacy gated |
| 8 | Approved inputs: WhatsApp, email, Google Sheets; voice/images/documents where supported | COM-001 ✅, COM-004, COM-006, COM-002, COM-003 (all existing) | fully covered; only COM-001 is built |
| 9 | GPS, CCTV, attendance as **future** owner-gated capabilities | **GTD-001**, **GTD-002**, **GTD-003** (new) | `deliberately_deferred` — preserved, not deleted |
| 10 | The company's own accounting core rather than QuickBooks | **FIN-009** (new) | `implemented_unverified` |
| 11 | Owner/CEO cockpit, spatial primary workspace, flat/reduced-motion, mobile fallback | CTL-001 ✅, MOB-001 ✅, MOB-002 ✅ + **UX-001** (new — spatial primary + mandated fallbacks) | `implementation_in_progress` |
| 12 | Management of every listed domain | PRJ, FIN, WRK, CRM, AST, RSK, OPS (existing) + **PRC-001/002**, **MKT-001** (new) | mixed |

Plus the loop itself, which had no record at all: **KRN-001** (one domain-agnostic
kernel), **KRN-002** (observation sources across every domain), **KRN-003** (registered
action catalogue).

### Two coverage gaps found that the owner had not named

Reconciling item 12 against the register exposed two whole domains with **zero**
requirements despite shipped code:

- **Procurement** — purchase requests, purchase orders, PO lines, goods receipts, RFQs,
  supplier quotations, stock movements, inventory (migrations 0020, 0021), ten pages,
  five action files and three test suites, appearing in the register only as *evidence
  paths for other requirements*. Now **PRC-001**.
- **Marketing** — campaigns, audiences and lead scoring (migration 0018), three pages.
  Now **MKT-001**, recorded `foundation_only` because it is thin and has no execution,
  attribution or budget linkage.

## The five-way separation the owner requested

### A. Existing retained capabilities (keep, do not rebuild)

Built, tested and reachable on the deployed line.

| Capability | IDs |
|---|---|
| Double-entry accounting core, settlement, reversal, periods, immutability | FIN-009, FIN-001…008 |
| Deterministic company-scoped authority engine, delegation, approvals | FOUND-004, GOV-005 |
| AI trust boundary — untrusted output cannot decide identity, scope or authority | FOUND-005 |
| Durable inbound processing; worker fairness; outbox with lease/retry/dead-letter | FOUND-001, FOUND-002, COM-001 |
| Atomic AI case/task/audit persistence; task-level dedup | AIM-001, AIM-002 |
| Canonical customer/supplier identity; provider registry; compliance status | CRM-001, CRM-002, CRM-003, CRM-005 |
| Exception-led command surface; portfolio view; health score; audit search | CTL-001, CTL-002, CTL-004, OPS-001, OPS-002 |
| Follow-ups, SLAs, escalation, leave/workload-aware scheduling, overdue evidence | SCH-002, SCH-003, SCH-004, SCH-006 |
| Human handover, opt-out, communication preferences | COM-007 |
| Responsive mobile, PWA, versioned mobile APIs | MOB-001, MOB-002, MOB-003 |
| Provider-neutral model gateway, policy router, budgets | MOD-003 |
| Risk, contracts, licences, insurance, incidents registers | RSK-001…005 |

### B. Capabilities needing adaptation (logic is right, wiring is wrong)

The largest category, and the cheapest to fix — this is why recovery is re-wiring rather
than rewrite.

| What exists | What must change | IDs |
|---|---|---|
| Domain detectors as tested pure functions (renewals, exceptions, objective-status, forecast, ageing, budget-vs-actual, capacity, three-way match, availability) | Re-expose as registered observation sources. **Every one exists; exactly one reaches the loop.** | KRN-002, PRC-002, MKT-001 |
| `planFromObservation` | Resolve recommendations to catalogue actions, not free text | KRN-003 |
| `/api/cron/ai-monitor` | Become the generic kernel scan scheduler, not hardcoded to `wa_conversations` | KRN-002 |
| `analyze-conversation` | Become one observation source among many | KRN-002 |
| `route-captured-tasks` | Become the department-routing step of real allocation | WRK-005, WMP-001 |
| Follow-ups and escalation chain | Extend from tasks to kernel cases | SCH-004, KRN-001 |
| Department pages (95 of 105 query Supabase directly) | Move queries into domain services so the kernel has a seam | PR-F-009, all domain groups |
| Procurement and accounting implementations | Assemble requirement-level behavioural evidence and verify | PRC-001, FIN-009 |
| Spatial workspace | Land on the deployed line; verify the mandated fallbacks as a set | UX-001 |

### C. Missing capabilities (no implementation)

| Capability | IDs |
|---|---|
| The management kernel itself | KRN-001, KRN-002, KRN-003 |
| Work marketplace, opportunity/bidding window, fairness guardrails | WMP-001, WMP-002, WMP-003 |
| Assignment, team, advisor, delegate and consultant recommendation | WRK-005, WRK-007, AIM-006 |
| Skills-based people analytics with explainability and fairness | WRK-004, WRK-006 |
| Staff-initiated Ask-AI | AIM-009 |
| Per-staff language preference and multilingual invariance | LNG-001, LNG-002, MOB-004 |
| **Learning — the entire eleventh loop step** | AIM-008, IMP-001, IMP-002, IMP-003 |
| Email, Sheets, calendar, voice, image/document intake | COM-004, COM-006, COM-005, COM-002, COM-003 |
| Task Intelligence Profile, decision-path ladder | AIM-004, AIM-005 |
| Asset intelligence beyond fleet | AST-001 |
| Board-reserved matters and emergency suspension | GOV-004 |
| Counterparty performance history | CRM-004 |
| Handover and meeting-action extraction | SCH-005 |
| Backup/restore drills, incident response | OPS-003, OPS-007 |

### D. Future owner-gated capabilities (preserved, deliberately not built)

**Recorded so they are not lost, and gated so they are not drifted into.**

| Capability | IDs | Gate |
|---|---|---|
| GPS location | GTD-001 | notices, retention policy, legal review |
| CCTV | GTD-002 | notices, retention policy, legal review; facial recognition needs **separate** written approval and is excluded |
| Attendance device integration | GTD-003 | notices, retention policy, legal review |
| Customer-facing AI agents (supervised subsystem) | CSA-001, CSA-002 | legal and privacy review |
| Points/credit ranking | WMP-002 | explicit owner approval of the model, its inputs and its visibility — **after** WMP-003 |
| Private-vs-manager-visible coaching | WRK-004, WRK-006, AIM-009 | privacy review of the visibility model |
| Multilingual specification | LNG-001, LNG-002 | approval of the specification |
| Live voice | COM-008 | future |
| Monitored production pilot | OPS-008 | owner approval of merge, hosted migration, flags, promotion |

### E. Provider and infrastructure incidents (not capability gaps)

Separated deliberately: these are environment facts, not missing features.

| ID | Incident | Status |
|---|---|---|
| **R0-F-001** | Vercel origin returns `402 DEPLOYMENT_DISABLED` on every path including `/api/webhooks/whatsapp`. Per D-021 Meta's callback may still point there. | **OPEN** — owner-controlled provider work, deferred by instruction |
| **PR-F-004 / R0-F-002** | Hosted migration state unresolved; the authoritative record contradicts deployed code | **OPEN production gate** |
| **PR-F-014 / R0-F-004** | Exact deployed Railway SHA unconfirmed; bounded to ≥ `19a8e9d` | **OPEN production gate** |
| **PR-F-001** | Two different migrations numbered `0069`; the runner would silently skip one | **OPEN** — blocks R2 |
| **PR-F-005** | Scheduling split: the origin receiving traffic runs no drain | **OPEN** — resolves with the deferred webhook work |
| **R0-F-005** | Register cited a non-existent SHA (IP-001) | **CLOSED** — evidence re-run at `f86eb97`, rule not relaxed |
| **PR-F-012** | RLS bypassed at runtime (flags OFF) | **OPEN** — D-4 target state |

**Railway status, stated precisely as instructed:** Railway is the selected canonical
production runtime; the origin is healthy (`200` on all public pages, `/app` fails closed
to login, security headers complete) and **exposes the WhatsApp webhook route, which
correctly rejects an unverified request with `403`.** This is **not** a claim that inbound
WhatsApp is operational — Meta's current callback destination and the Railway
configuration (`WHATSAPP_*`, `CRON_SECRET`, `IN_PROCESS_CRON`) remain **unverified**.

## Consistency checks run

| Check | Result |
|---|---|
| `secret-scan` | ✅ no tracked secrets |
| `migration-lint` | ✅ 109 migrations, sequential 0001–0109, no gaps or duplicates |
| `completion-inventory --check` | ✅ `supabaseAdmin` confined to the system allowlist |
| **`autonomy:audit`** | ✅ **registered=110, verified=60, unexpanded-groups=0 — register internally consistent; matrix regenerated** |
| `check-ip-boundary` | ✅ tracked=1320, source=771, hard=0, review=3 |
| `typecheck` | ✅ clean |
| `test` | ⚠️ **1362 passed / 1 failed / 2 skipped (184 files)** |

**The audit was fixed, not weakened.** It had been failing on IP-001's non-existent SHA
(R0-F-005). The rule requiring a completion status to cite a real, tested commit was left
exactly as it was; instead the evidence was **re-run** — `tests/autonomy/ip-boundary.test.ts`
2/2 passed and `check-ip-boundary` reported zero hard violations at `f86eb97` — and the
SHA replaced with the commit actually verified. The defect is recorded in IP-001's
`residual_risks` and in the register header, with the standing instruction that any other
record citing an absent SHA must be **re-verified, never re-pointed by guess**.

**The one remaining test failure is the pre-existing PR-F-013 defect** — a CRLF-sensitive
*source-text* assertion in `tests/campaign/sch-003-leave-workload-aware-scheduling.test.ts`,
unchanged by this checkpoint. Owner safeguard 5 requires source-text appearance tests to
be replaced with behavioural ones; that is a test-code change and is **not authorised in a
documentation-only checkpoint**. It is carried into the R1 scope.

`completion-inventory` continues to report `flags-no-consumer=7/8`, independently
corroborating PR-F-010.

## Requirements the reconciliation deliberately did not resolve

Honesty about what remains outstanding:

1. **Five extended fields are not backfilled across the 90 pre-existing records.**
   `intent`, `gap`, `authority_restrictions`, `privacy_restrictions` and
   `acceptance_scenarios` are populated on the 20 new records only. Writing them for the
   other 90 requires re-reading each implementation; inventing them would be worse than
   their absence. Recorded in the register header as outstanding.
2. **PRC-001 and FIN-009 are `implemented_unverified`.** Assembling their behavioural
   evidence is real work, not a documentation edit.
3. **R0-F-005's root cause is unconfirmed.** The evidence was re-run and the SHA
   corrected; *why* `c72b2fe` vanished (most consistent with a squashed or rebased
   branch) is not established. Any other record citing an absent SHA must be re-verified
   the same way — **never re-pointed by guess.**

## One non-documentation file was touched

`scripts/autonomy/audit-requirements.mjs` — the `APPROVED_GROUPS` allowlist gained the
seven new group prefixes, with a comment recording the owner instruction that authorised
them. This is requirements **tooling**, not product code: it changes no migration, RLS
policy, API contract, production configuration or business control. Without it the
register cannot hold the IDs the owner directed creating, and the audit fails closed —
which is the guard working as designed.
