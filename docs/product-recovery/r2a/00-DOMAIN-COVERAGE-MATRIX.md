# R2A — domain coverage matrix

**Local-only. Supabase access deferred, not waived; hosted migration state remains unknown.**
No merge, no deploy, no migration renumbering, no hosted contact.

Purpose: take the management kernel's observation coverage from **5 of 12** managed domains
to **12 of 12**, wrapping logic that already exists. This is the AI CEO/Manager kernel gaining
eyes in every department — not twelve more dashboards.

**Nothing below invents a production data source.** Every "existing tables" and "existing
detector" entry was verified in the repository before this matrix was written.

## Legend

| Adapter status | Meaning |
|---|---|
| **connected** | Registered, wrapping real logic, producing observations (R1) |
| **planned** | Real tables and real detector exist; adapter to be written in R2A |
| **blocked** | A required table, provider or hosted fact is genuinely absent — typed boundary and truthful blocked state only, no fabricated records, no speculative schema |

---

## The five already connected (R1 — unchanged by R2A)

| # | Domain | Requirements | Tables | Detector wrapped | Adapter |
|---|---|---|---|---|---|
| 1 | **Finance** | FIN-002, FIN-006, CTL-001 | `customer_invoices` | `modules/finance/aging.ts` `bucketFor` | **connected** `finance.receivable_overdue` |
| 2 | **Workforce** | WRK-001, WRK-002 | `capacity_snapshots`, `leave_requests` | `ai-manager/exceptions.ts` `detectCapacityExceptions`, `work/availability.ts` | **connected** `workforce.capacity_exception` |
| 3 | **Operations / projects & tasks** | PRJ-001, SCH-006 | `tasks`, `task_check_ins` | `ai-manager/exceptions.ts` `detectTaskExceptions` | **connected** `operations.task_exception` |
| 4 | **CRM / customer follow-up** | CRM-001, SCH-002 | `wa_conversations` | wait-window evaluation | **connected** `crm.followup_due` (draft-only, R1-D-7) |
| 5 | **System health / providers** | OPS-001, CTL-003, MOD-003 | `message_outbox`, `ai_model_attempts` | `lib/health-signals.ts` | **connected** `system.health_degraded` |

**R1 behaviour for these five must not change.** A regression test pins it.

---

## The seven to connect in R2A

### 6. Governance — owner/CEO command and decision management

| | |
|---|---|
| **Requirements** | GOV-001 directives with response obligations · GOV-002 acknowledgement and escalation · GOV-006 governance audit trail |
| **Tables** | `management_directives` (`status`, `response_required_by`, `issued_to`, `acknowledged_at`, `closed_at`), `management_directive_conflicts` |
| **Components** | `/app/admin/directives`, `/api/cron/directive-escalation` |
| **Detector** | `modules/governance/directive-escalation.ts` → `evaluateDirectiveEscalation` |
| **Evidence available** | directive row id, status, response-due date, acknowledgement state |
| **Conditions to detect** | a directive past `response_required_by` and unacknowledged; an escalated directive still open |
| **Authority** | `manager_approval` — a directive is an owner instruction; chasing one is a management act. Never `automatic` |
| **Adapter status** | **planned** — `governance.directive_overdue` |
| **Missing dependencies** | none |

### 7. Objectives / KPIs and planning

| | |
|---|---|
| **Requirements** | PRJ-002 objectives, milestones and stage gates · CTL-004 explainable business-health score |
| **Tables** | `objectives` (`metric`, `target_value`, `current_value`, `period_start`, `period_end`, `status`) |
| **Components** | `/app/admin/objectives` |
| **Detector** | `ai-manager/objective-status.ts` → `assessObjective` (`on_track` / `at_risk` / `off_track` / `done`) |
| **Evidence available** | objective row id, assessed status, period boundaries |
| **Conditions to detect** | an objective `at_risk` or `off_track` inside its period |
| **Authority** | `manager_approval` — re-planning an objective is a management decision |
| **Adapter status** | **planned** — `objectives.objective_at_risk` |
| **Missing dependencies** | none. `current_value` is owner-maintained; the adapter reports what is recorded and never estimates it |

### 8. Marketing and campaigns

| | |
|---|---|
| **Requirements** | MKT-001 campaigns, audiences and marketing outcomes |
| **Tables** | `campaigns` (`status`, `budget`, `currency`, `sent_count`, `audience_id`), `audiences`, `leads` |
| **Components** | `/app/marketing`, `/app/marketing/campaigns`, `/app/marketing/audiences` |
| **Detector** | `modules/commercial/lead-scoring.ts` → `scoreLead` (existing, tested) |
| **Evidence available** | campaign row id, status, whether an audience is attached, sent count |
| **Conditions to detect** | a campaign left in a non-terminal status with no audience or no sends — i.e. **stalled**, not "underperforming" |
| **Authority** | `manager_approval`, and the recommendation may only ever be **internal review**. R2A adds no send path and no campaign execution |
| **Adapter status** | **planned** — `marketing.campaign_stalled` |
| **Missing dependencies** | **attribution is absent.** There is no table linking a campaign to resulting revenue, so no ROI or effectiveness condition can be detected. Recorded here rather than approximated |

### 9. Procurement, suppliers and inventory

| | |
|---|---|
| **Requirements** | PRC-001 requisition→PO→receipt→three-way match · PRC-002 procurement as a managed domain |
| **Tables** | `purchase_orders`, `po_lines`, `goods_receipts`, `rfqs`, `supplier_quotations`, `inventory_items` (`quantity_on_hand`, `reorder_level`) |
| **Components** | ten `/app/procurement/*` pages, five action files |
| **Detectors** | `modules/procurement/inventory.ts` → `needsReorder` / `reorderList`; `three-way-match.ts` → `threeWayMatch`; `quote-comparison.ts` |
| **Evidence available** | inventory row id with on-hand and reorder level; PO row id and status |
| **Conditions to detect** | stock at or below reorder level; a PO open well past its expected date |
| **Authority** | `manager_approval` — committing spend is a human decision. **Finance rules still apply: nothing posts, settles, approves or pays** |
| **Adapter status** | **planned** — `procurement.stock_below_reorder` |
| **Missing dependencies** | three-way-match variance needs an invoice↔receipt↔PO join that is page-level, not a module function. Deferred rather than reimplemented — R2A wraps `needsReorder`, which is already pure and tested |

### 10. Assets and fleet

| | |
|---|---|
| **Requirements** | AST-001 asset intelligence *(specified, not built)* · operations.fleet.manage capability |
| **Tables** | `vehicles`, `vehicle_documents` (`doc_type`, `expiry_date`), `maintenance_records`, `fuel_logs`, `trips`, `drivers` |
| **Components** | `/app/fleet`, `/app/fleet/vehicles`, `/app/fleet/drivers` |
| **Detector** | `ai-manager/renewals.ts` → `detectRenewals` / `renewalStatus` (pure, tested, already used by the fleet pages) |
| **Evidence available** | vehicle-document row id, doc type, expiry date |
| **Conditions to detect** | a vehicle document expired or expiring soon |
| **Authority** | `manager_approval` — a grounded vehicle is an operational and legal matter |
| **Adapter status** | **planned** — `assets.document_expiring` |
| **Missing dependencies** | AST-001's wider registry (custody, reservations, utilisation) is `specified`, not built. R2A covers **vehicle documents only** and says so; it does not stand in for AST-001 |

### 11. Legal, licences, contracts and compliance

| | |
|---|---|
| **Requirements** | RSK-002 contracts with renewal dates · RSK-003 licences and permits with expiry · RSK-005 incidents and statutory obligations |
| **Tables** | `licences` (`expiry_date`, `authority`, `status`), `contracts`, `obligations`, `insurances`, `legal_matters`, `incidents` |
| **Components** | nine `/app/legal/*` pages, seven action files |
| **Detector** | `ai-manager/renewals.ts` → `detectRenewals` (the same pure function the legal pages already use) |
| **Evidence available** | licence/contract/obligation row id, kind, expiry or due date |
| **Conditions to detect** | a licence, contract, insurance or statutory obligation expired or expiring soon |
| **Authority** | `specialist_approval` — an expired licence or a statutory deadline is a legal exposure, and RSK-006 records that Sri Lankan advisory sources and human legal review are **absent**. The kernel raises it for a human; it never advises |
| **Adapter status** | **planned** — `legal.obligation_expiring` |
| **Missing dependencies** | none for expiry detection. Legal *interpretation* is out of scope and gated by RSK-006 |

### 12. External consultants and service providers

| | |
|---|---|
| **Requirements** | CRM-003 consultant and service-provider registry · CRM-005 compliance and insurance status per counterparty |
| **Tables** | `service_providers` (`status`, `compliance_status`, `insurance_status`, `insurance_expiry`), `counterparty_compliance` |
| **Components** | `/app/procurement/service-providers`, `/app/procurement/service-providers/[id]` |
| **Detector** | `modules/crm/service-provider.ts` → `providerHealth` (`verified` / `warning` / `blocked`) |
| **Evidence available** | provider row id, health classification, insurance expiry |
| **Conditions to detect** | a provider `blocked` or `warning` — lapsed insurance or failed compliance while still engaged |
| **Authority** | `manager_approval` — engaging or standing down a provider is an external commitment and always human |
| **Adapter status** | **planned** — `providers.provider_at_risk` |
| **Missing dependencies** | CRM-004 counterparty **performance history** is `absent`, so reliability and delivery-performance conditions cannot be detected. Only compliance and insurance health are available |

---

## Blocked and partially-covered conditions, stated plainly

None of the seven domains is wholly blocked — every one has a real table and a real detector.
Four carry **partial** coverage, and the gap is named rather than approximated:

| Domain | Available now | Genuinely unavailable | Consequence |
|---|---|---|---|
| Marketing | campaign stalled | **attribution** — no campaign→revenue link exists | no ROI or effectiveness condition |
| Procurement | stock below reorder | three-way-match variance as a module-level function | match variance deferred, not reimplemented |
| Assets/fleet | vehicle document expiry | AST-001 registry: custody, reservations, utilisation | fleet documents only; AST-001 stays `specified` |
| Providers | compliance and insurance health | CRM-004 performance history | no reliability or delivery-performance condition |

**No table, column or migration will be invented to close these.** Each becomes a residual in
the R2A report and stays visible in the register.

---

## What R2A changes, and what it must not

**Changes:** the `Department` union, the department CHECK constraints and the registered-source
allowlist in the draft schema (a new *quarantined draft unit* — **not** a numbered migration);
seven new adapter modules; seven registry entries; catalogue actions for the new domains; the
cycle's source list.

**Must not change:** the five R1 adapters and their tests; the lifecycle; the authority engine;
RLS; the atomic create RPC's structure; the spatial workspace's design. The queue renders new
departments through the **existing** panel — no UI redesign.

**Still prohibited in R2A:** the points/bidding marketplace, live model calls, an unattended
executor, customer message sending, payments or financial posting, GPS/CCTV, production
integrations.
