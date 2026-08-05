# Singha AI Management System

## Current System to Senior AI Manager Architecture V2 — Change Plan

**Document purpose:** Define the changes required to evolve the current Singha application into the Senior AI Management System described in `Singha_AI_Management_Architecture_V2.puml`.

**Repository reviewed:** `https://github.com/MUA1234/bot_business_Singha.git`  
**Baseline reviewed:** `main` at commit `a10d05c2aea175ce12fad0d8b2b4f4cacf0636cd`  
**Architecture companion:** `Singha_AI_Management_Architecture_V2.puml`  
**Recommended strategy:** Controlled refactor and expansion of the existing repository; do not perform a complete rewrite.

---

## 1. Executive decision

The present system should be retained because it already contains useful and tested foundations:

- Next.js and TypeScript application shell.
- Supabase/PostgreSQL database design and migrations.
- WhatsApp quotation flow.
- AI gateway with structured Zod validation.
- Event-ingestion, duplicate-detection and Inngest components.
- Authority and approval logic.
- Double-entry accounting calculations.
- Trial balance, profit-and-loss and balance-sheet calculations.
- Sixty-six passing unit tests at the reviewed baseline.

However, the current application is not yet a complete management platform. Several pages are placeholders, parts of the database access layer bypass Row Level Security, identity is represented in two different ways, WhatsApp processing is partly synchronous, and the accounting engine is not yet connected to a complete production ledger workflow.

The correct approach is therefore:

1. Preserve the tested domain logic and current UI shell.
2. Correct security, tenancy, identity and event-processing foundations.
3. Build the work-management and employee-capacity core.
4. Connect the accounting logic to a production double-entry ledger.
5. Add departmental modules in controlled phases.
6. Add GPS, CCTV and autonomous customer agents only after governance approval.

---

## 2. Target operating model

The completed platform will act as a **Senior AI Manager** across multiple companies, divisions, departments, projects and sites.

Its recurring management loop will be:

1. Observe verified events from WhatsApp, email, documents and connected systems.
2. Identify the company, department, project, people and financial effect.
3. Update confirmed business facts.
4. Detect new work, risks, delays, missing evidence and financial implications.
5. Propose plans, tasks, priorities, assignments and decisions.
6. Apply deterministic authority, financial, legal and security policies.
7. Ask staff for estimates, dependencies and completion dates.
8. Monitor check-ins, messages, evidence, deadlines and capacity.
9. Perform permitted routine actions through controlled domain services.
10. Obtain human approval for sensitive or exceptional actions.
11. Record the decision, evidence, policy version, approver and outcome.
12. Update management dashboards, forecasts and alerts.

The language model must never write directly to the accounting ledger, execute a bank payment, sign a contract, dismiss an employee, change supplier bank details or grant itself additional authority.

---

## 3. Priority definitions

| Priority | Meaning |
|---|---|
| **P0** | Must be corrected before the system handles production business or financial data. |
| **P1** | Required foundation for the Senior AI Manager pilot. |
| **P2** | Required for full departmental management. |
| **P3** | Advanced expansion after the core is stable. |
| **Gated** | Build only after owner, legal, privacy and security approval. |

---

## 4. High-level gap assessment

| Area | Present system | Required V2 state | Priority |
|---|---|---|---|
| Product definition | Documents contain conflicting Phase 0, QuickBooks and Accounting Core instructions. | One approved specification declaring the internal ledger as the accounting source of truth. | P0 |
| Repository privacy | Repository was public when reviewed. | Private repository, protected branches and secret scanning. | P0 |
| Company isolation | Many service-role queries rely on manual `company_id` filtering. | RLS-bound user access, company-scoped repositories and database constraints. | P0 |
| Identity and permissions | `users/user_company_access` and `profiles` are separate access models. | One membership, role, permission and authority model. | P0 |
| Administrative actions | Some update/reset operations are not scoped to the target company. | Every operation verifies subject company, permission and authority. | P0 |
| WhatsApp processing | Customer AI and replies may run inline in the webhook. | Persist-first, asynchronous, retryable event processing with an outbox. | P0/P1 |
| AI manager | Quotation-focused AI plus financial extraction components. | Continuous observation, planning, delegation, monitoring and escalation engine. | P1 |
| Employees | Basic employee creation, status and one department. | Skills, memberships, multiple roles, schedules, capacity, workload and performance evidence. | P1 |
| Tasks/projects | Project foundation exists; operational task pages are placeholders. | Full task lifecycle, dependencies, estimates, check-ins, evidence and escalation. | P1 |
| Accounting | Core calculations and tables exist; posting workflow and finance UI remain incomplete. | Production ledger, subledgers, approval-to-posting, reporting and reconciliation. | P1/P2 |
| Sales/CRM | WhatsApp conversations, products, quotations and orders partly exist. | Customer 360, leads, opportunities, fulfilment, collections and supervised AI agents. | P2 |
| Procurement | Placeholder pages. | Suppliers, requests, quotations, purchase orders, receiving and invoice matching. | P2 |
| Legal/compliance | Designed in documents but not implemented as an operating module. | Matters, contracts, obligations, licences, renewals, evidence and adviser handover. | P2 |
| Transport/fleet | Not implemented. | Vehicles, drivers, trips, fuel, maintenance, documents and project allocation. | P2 |
| Attendance/GPS/CCTV | Future/gated. | Consent-based, purpose-limited integrations with retention and correction controls. | Gated |
| Management dashboard | Basic counts and navigation cards. | Exception-led command centre with workload, cash, risk, deadlines and decisions. | P1/P2 |
| Testing and delivery | Unit tests and build pass; lint and live RLS/integration testing are incomplete. | Non-interactive CI, database tests, isolation tests and staged deployment. | P0/P1 |

---

## 5. Changes required in the current repository

### 5.1 Correct the authoritative project documents — P0

The current project instructions can cause Claude or another coding agent to implement the wrong architecture. `CLAUDE.md`, `AGENTS.md`, `README.md` and several documents still state that there is no feature code or that QuickBooks is the accounting source of truth.

Required changes:

- Replace the Phase 0 warning with the actual implementation status.
- Declare the internally owned Accounting Core as the accounting source of truth.
- Mark QuickBooks documentation as superseded or archive it.
- Reconcile `docs/DECISIONS.md` with the master specification.
- Update the architecture, data model, permission model and phased plan.
- Add a `CURRENT_IMPLEMENTATION_STATUS.md` generated from verified code and tests.
- Add a rule that an AI coding agent must not rely on a document marked superseded.
- Link this change plan and the Architecture V2 PlantUML file from the root README.

**Acceptance criteria**

- No active instruction says that QuickBooks is the accounting source of truth.
- No active instruction says the repository contains no feature code.
- All active architecture documents describe the same identity, event and accounting models.

### 5.2 Protect the repository and environments — P0

Required changes:

- Make the production repository private.
- Confirm that no credentials or customer data exist in Git history.
- Enable protected `main` branch rules and pull-request review.
- Separate development, staging and production Supabase/Inngest/hosting projects.
- Store credentials only in approved secret stores.
- Add secret scanning and dependency scanning to CI.
- Prevent production data from being copied into local development.

### 5.3 Replace the dual identity model — P0

Current problem:

- `0001_org_and_access.sql` uses `users`, `user_company_access`, roles and permissions as the RLS anchor.
- `0007_app_profiles_and_orders.sql` introduces `profiles`, one company, one department and `is_admin`.
- Employee actions write to `profiles`, while the accounting RLS model expects company-access records.

Required target model:

- `users`: global identity linked to `auth.users`.
- `companies`: legal or operating entities.
- `memberships`: user-to-company relationship.
- `membership_roles`: multiple roles per company membership.
- `role_permissions`: deterministic permissions.
- `authority_rules`: money, legal, HR and operational limits.
- `organisation_units`: division, branch, department, team, project office or site.
- `membership_assignments`: membership-to-organisation-unit assignments.
- `employee_profiles`: employment and skill information, not the RLS source of truth.
- `delegations`: temporary delegated authority with start/end dates.

The model must allow one person to:

- Work across multiple companies when authorised.
- Belong to more than one department or project.
- Hold multiple roles with different authority limits.
- Temporarily cover another manager.

**Acceptance criteria**

- One source of truth determines company access.
- One shared authorisation service is used by pages, API routes and workers.
- Cross-company access tests prove that users cannot read or mutate other companies.

### 5.4 Eliminate unsafe service-role access — P0

Current user-facing pages and actions frequently use `supabaseAdmin()`. The service role bypasses RLS, making application code solely responsible for company isolation.

Required changes:

- User-facing reads and writes use the session-bound Supabase client.
- Service-role usage is restricted to verified webhook ingestion, background workers and account provisioning.
- Service-role calls are isolated in reviewed worker repositories.
- Every repository method requires an explicit company context.
- Target records are loaded and validated before privileged mutation.
- Privileged operations create append-only audit records.

Immediate fixes include:

- Scope employee activation/deactivation to the administrator's company.
- Scope employee password reset to the administrator's company.
- Scope product activation/deactivation to the caller's company.
- Audit password resets, role changes and employee status changes.
- Prevent an administrator from disabling or resetting a user outside their authorised companies.

### 5.5 Repair Row Level Security policies — P0

Required changes:

- Remove policies permitting normal users to read records where `company_id IS NULL`.
- Restrict unresolved source events to trusted ingestion workers.
- Remove `using (true)` from the dead-letter event policy.
- Add `company_id` and restricted ownership to dead-letter records.
- Add explicit insert, update and delete policies rather than relying only on select policies.
- Add company-scoped composite foreign keys so child and parent rows cannot belong to different companies.
- Generate automated RLS tests for every company-owned table.

Examples of constraints required:

- A journal line's company must equal its journal's company.
- A task assignment's company must equal its task and employee membership companies.
- A quotation item must belong to the same company as its quotation.
- A financial allocation's project/site/division must belong to the same company.

### 5.6 Make ingress fully event-driven — P0/P1

Current problem:

The WhatsApp webhook verifies the signature, but then runs the order-intake AI and outbound reply inline. A slow or partially failed request can create delivery and duplication problems.

Required workflow:

1. Verify the provider signature against the raw request body.
2. Identify the channel connection and company from the receiving phone number/account.
3. Validate the payload envelope.
4. Persist the complete raw source event.
5. Apply provider-ID idempotency.
6. Acknowledge the provider quickly.
7. Enqueue the source-event ID through Inngest.
8. Process extraction and business logic under durable retries.
9. Write outbound communication to an outbox.
10. Send through an idempotent delivery worker.
11. Capture delivery status and failures.
12. Send exhausted failures to a restricted dead-letter workflow.

Additional WhatsApp support required:

- Text, image, document, audio/voice note and location messages.
- Delivery, read and failure status events.
- Employee versus customer identity resolution.
- Multiple WhatsApp numbers mapped to the correct company/division/AI role.
- Human takeover and conversation assignment.

### 5.7 Add transactional commands and an outbox — P0/P1

Multi-record operations such as order/quotation creation must be atomic.

Required changes:

- Create domain command handlers with database transactions.
- Use an outbox table for provider messages and other external writes.
- Add idempotency keys for all external events and outbound actions.
- Prevent concurrent quotation finalisation from sending twice.
- Add optimistic concurrency or row locks for status transitions.
- Record correlation and causation IDs from the original event through every result.

---

## 6. Senior AI Manager changes

### 6.1 Introduce a management observation model — P1

Create a standard `ManagementObservation` schema containing:

- Source event and evidence references.
- Company, division, department, site and project.
- People, customers, suppliers, vehicles and assets involved.
- Confirmed facts versus inferred facts.
- New tasks or commitments detected.
- Financial, legal, operational, customer and safety impact.
- Confidence and uncertainty.
- Missing information.
- Suggested next actions.
- Required authority and approval level.
- Suggested follow-up date.

Every AI result must pass schema validation before being considered by the policy engine.

### 6.2 Build the Senior AI Manager loop — P1

Create these internal services:

- Event classifier.
- Entity resolver.
- Fact and commitment extractor.
- Evidence/confidence assessor.
- Priority and risk scorer.
- Work decomposer and planner.
- Capacity-aware assignment recommender.
- Progress monitor.
- Exception detector.
- Forecast and scenario engine.
- Executive briefing generator.

The AI manager must operate from verified database state and retrieved policies. Conversation text is evidence, not automatically accepted truth.

### 6.3 Add deterministic governance — P1

Create a shared `DecisionProposal` schema:

- Proposed action.
- Reason and expected outcome.
- Evidence references.
- Confidence.
- Risk classification.
- Applicable policy version.
- Required permission.
- Required approvers.
- Monetary or operational limit.
- Expiry time and conditions.
- Reversal or recovery plan where applicable.

Authority levels:

1. Automatic informational action.
2. Policy-controlled routine action.
3. Manager approval.
4. Finance/legal/HR/privacy specialist approval.
5. Owner approval.

### 6.4 Create management memory without uncontrolled model memory — P1

Store structured business records rather than relying on long chat histories:

- Facts and their evidence.
- People and organisation assignments.
- Plans and active commitments.
- Task dependencies and deadlines.
- Decisions and approval history.
- Customer/supplier relationship history.
- Policies, SOPs and document versions.
- AI runs, prompts, models, costs and validation results.

Old or superseded facts must be versioned, not silently overwritten.

---

## 7. Employee, capacity and workforce changes

### 7.1 Expand employee records — P1

Add:

- Contact and emergency information with restricted visibility.
- Employment status and start/end dates.
- Skills, certifications and expiry dates.
- Reporting lines.
- Company, department, team, project and site assignments.
- Contracted work schedule and working timezone.
- Leave, absence and planned travel.
- Vehicle/equipment authorisations.
- Authority and approval limits.
- Training and onboarding status.

### 7.2 Build capacity calculation — P1

Capacity should be calculated from:

- Available working hours.
- Approved leave and absence.
- Active task estimates.
- Meetings, travel and site commitments.
- Recurring responsibilities.
- Required skills and location.
- Blocked time and dependencies.
- Contingency allowance.

Required outputs:

- Total weekly capacity.
- Allocated hours.
- Available hours.
- Capacity percentage.
- Overloaded/underallocated status.
- Work by project and department.
- Forecast capacity for future weeks.

### 7.3 Build task and project management — P1

Add tables and services for:

- Projects, phases and milestones.
- Tasks and subtasks.
- Dependencies.
- Assignments.
- Worker estimates.
- Planned start/due dates.
- Check-in schedules.
- Status history.
- Blockers and risks.
- Completion criteria.
- Evidence and verification.
- Recurring responsibilities.
- Escalations and reassignment.

Required lifecycle:

`captured → clarifying → planned → awaiting estimate → scheduled → in progress → awaiting evidence → verification → completed`

Exception states:

`blocked`, `overdue`, `escalated`, `cancelled` and `reopened`.

The AI may request estimates and progress updates automatically. It must not mark work as verified when the acceptance criteria require a human, system confirmation, financial reconciliation or site evidence.

---

## 8. Accounting and finance changes

### 8.1 Preserve the existing accounting logic — P1

Retain and expand:

- Decimal money handling.
- Journal balancing rules.
- Period locks.
- Reversals.
- Trial balance.
- Profit-and-loss statement.
- Balance sheet.
- Reconciliation matching.
- Deterministic authority and separation-of-duties rules.

All money values must remain decimal strings or a fixed-precision money type. JavaScript floating-point `Number` must not be used for prices, journal values, taxes or balances.

### 8.2 Connect approval to persistent posting — P1

Build a production posting service that:

1. Loads an approved financial event.
2. Confirms posting authority separately from approval authority.
3. Confirms the accounting period is open.
4. Builds balanced journal lines.
5. Inserts journal header and lines atomically.
6. Applies company-scoped constraints.
7. Updates the relevant subledger.
8. Appends the audit event.
9. Emits a `journal.posted` event.

Approval must not automatically execute a bank payment.

### 8.3 Build operational finance modules — P1/P2

Add complete workflows for:

- Customer invoices and credit notes.
- Supplier bills and debit notes.
- Expenses and staff reimbursements.
- Cash advances and settlement.
- Receipts and allocations.
- Payment requests.
- Payment initiation and separate authorisation.
- Petty cash and bank/cash accounts.
- Loans and intercompany accounts.
- Tax codes and tax reports.
- Fixed assets and depreciation.
- Bank statement imports and reconciliation.
- Period closing and controlled reopening.

### 8.4 Add AI-assisted financial ingestion — P2

Support staff submitting financial updates through WhatsApp, email or upload:

- Receipt or bill image/PDF.
- Who paid and from which source.
- Supplier/payee.
- Business purpose.
- Company, project, site, vehicle and cost centre.
- Requested reimbursement or settlement.
- Tax and currency.
- Approval and evidence.

The AI extracts and recommends classification. A finance policy/domain service validates and posts it.

### 8.5 Build actual, committed and forecast views — P2

The command centre must separately show:

- Actual posted income and expense.
- Approved but not yet paid amounts.
- Purchase and contractual commitments.
- Expected customer receipts.
- Budget versus actual.
- Short-, medium- and long-term cash forecasts.
- Project/division/site profitability.
- Scenario forecasts.
- Missing evidence and unreconciled transactions.

---

## 9. Departmental modules to add

### 9.1 CRM, sales and customer service — P2

- Customer and contact records.
- Leads and opportunities.
- Conversation ownership.
- Enquiry qualification.
- Products, services and price versions.
- Quotations and approvals.
- Orders and fulfilment status.
- Customer invoices and collections.
- Complaints, service cases and escalations.
- AI receptionist and sales agents operating under scripts, policies and handover rules.

### 9.2 Procurement and inventory — P2

- Supplier onboarding and verification.
- Purchase requests.
- Request-for-quotation workflow.
- Supplier quotations and comparison.
- Purchase approvals.
- Purchase orders.
- Goods/service receipt confirmation.
- Three-way matching: purchase order, receipt and supplier bill.
- Inventory locations and movements.
- Reorder levels and reservations.
- Equipment and asset assignment.

### 9.3 Legal and compliance — P2

- Legal matters and responsible owner.
- Contracts and version history.
- Obligations, notices and deadlines.
- Licences, permits and renewals.
- Required documents and evidence.
- Regulatory and policy checklists.
- External lawyer/adviser requests and responses.
- Legal-risk approval route.

The AI may identify legal considerations and prepare checklists. It must mark jurisdiction, sources, uncertainty and the need for professional review; it must not represent generated text as final legal advice.

### 9.4 Transport and fleet — P2

- Vehicle and equipment register.
- Registration, insurance and licence expiry.
- Driver and operator assignments.
- Trips and project/site allocation.
- Fuel requests, bills and consumption.
- Repairs and preventive maintenance.
- Incident and damage records.
- Downtime and utilisation.
- Supplier invoices linked to the correct vehicle/project.

### 9.5 GPS, attendance and CCTV — Gated

Only implement after written governance approval covering:

- Lawful purpose and notice/consent.
- Roles allowed to view location or footage.
- Site and work-hour boundaries.
- Minimum retention periods.
- Employee correction/dispute procedures.
- Export/download auditing.
- Health and tamper monitoring.
- Data minimisation.

The management application should normally receive structured events such as geofence entry, vehicle movement, recorder offline or verified attendance. It should not continuously expose unnecessary live footage or personal tracking to all staff.

---

## 10. Dashboard and user-experience changes

### 10.1 Replace the basic overview with an exception-led command centre — P1/P2

Add:

- Decisions awaiting the owner.
- High-risk or overdue work.
- Employees over/under capacity.
- Projects at risk.
- Today's operational priorities.
- Cash position and upcoming obligations.
- Unpaid customer invoices.
- Supplier bills and payment requests.
- Missing receipts or evidence.
- Legal/licence renewals.
- Vehicle downtime and maintenance due.
- Integration/system failures.
- AI confidence exceptions and model costs.

Every dashboard card must open the underlying records and evidence; it must not be a decorative count only.

### 10.2 Add role-based workspaces — P2

- Owner/board.
- Senior manager.
- Department manager.
- Employee.
- Finance reviewer/accountant.
- HR administrator.
- Legal/compliance reviewer.
- Auditor/read-only.
- Customer/supplier external portal.

Visibility must be determined by server-side permissions, not only by hiding navigation items.

---

## 11. Proposed codebase restructuring

Keep the current repository, but evolve it towards the following boundaries:

```text
src/
  app/
    app/                       # role-based web/PWA pages
    api/webhooks/              # verification + persist + enqueue only
    api/commands/              # authenticated, validated application commands

  platform/
    auth/                      # membership, tenancy and session context
    events/                    # source events, domain events and outbox
    observability/             # audit, logs, health and cost monitoring
    storage/                   # documents, evidence and retention

  management/
    ai-manager/                # observation, planning and progress monitoring
    policy/                    # authority and approval routes
    knowledge/                 # policies, SOPs and retrieval
    models/                    # model gateway, routing and schemas

  modules/
    organisation/
    work/
    finance/
    commercial/
    procurement/
    legal/
    fleet/

  integrations/
    whatsapp/
    email/
    google/
    banking/
    gps-cctv/

  db/
    migrations/
    repositories/
    transactions/
    generated-types/
```

Boundary rules:

- Domain modules must not call AI providers directly.
- AI modules must not mutate tables directly.
- Integrations must not contain business rules.
- Pages must not use the service-role client.
- Money-changing operations must be transactional.
- Every sensitive operation must produce an audit event.

---

## 12. Database migration approach

Do not delete the existing codebase or reset a database containing real data.

If existing migrations have been applied to any environment:

- Add forward-only migrations beginning after the latest applied migration.
- Introduce the unified membership model alongside old profiles.
- Backfill and validate memberships.
- Move reads to the new model.
- Move writes to the new model.
- Run isolation and reconciliation tests.
- Remove or freeze legacy columns only after successful migration.

If the migrations have never been applied outside disposable development environments:

- Create a clean consolidated baseline migration after preserving the current files for history.
- Run the full migration and seed process from an empty database in CI.

Never edit production accounting records to make a migration pass. Use explicit migration adjustments and balanced financial corrections.

---

## 13. Testing and release requirements

### 13.1 Continuous integration — P0

Add non-interactive CI steps for:

- Dependency installation from the lockfile.
- Formatting check.
- ESLint with committed configuration.
- TypeScript type checking.
- Unit tests.
- Production build.
- Migration validation.
- Secret and dependency scanning.

### 13.2 Required automated tests — P0/P1

- Cross-company read isolation.
- Cross-company mutation isolation.
- Role and authority enforcement.
- Webhook signature rejection.
- Persist-before-enqueue behaviour.
- Duplicate inbound event handling.
- Duplicate outbound-send prevention.
- Dead-letter access restrictions.
- Task state transitions and overdue escalation.
- Capacity calculations.
- Approval expiry and separation of duties.
- Decimal money and balanced journals.
- Period lock and reversal behaviour.
- Approval-to-posting transactionality.
- Bank re-import and reconciliation idempotency.
- Receipt/OCR correction and duplicate detection.
- Prompt-injection and invalid-schema handling.
- AI outage and fallback behaviour.

### 13.3 Staging acceptance — P1

Before production:

- Run migrations on an empty staging database.
- Run migrations on a realistic anonymised upgrade dataset.
- Verify RLS using at least two companies and several roles.
- Verify WhatsApp webhook-to-worker-to-outbox end to end.
- Verify accounting reports reconcile to the journal.
- Verify backup restoration.
- Verify alerts for failed queues, providers and model errors.

---

## 14. Recommended implementation phases

### Phase 0 — Stabilise and secure

- [ ] Make repository private and protect branches.
- [ ] Correct authoritative documents.
- [ ] Configure deterministic lint and CI.
- [ ] Fix cross-company administrative mutations.
- [ ] Restrict service-role use.
- [ ] Repair RLS and dead-letter policies.
- [ ] Add company-isolation tests.

**Exit condition:** The present application can be tested without known cross-company authorisation gaps.

### Phase 1 — Unified organisation and event foundation

- [ ] Implement memberships, roles, organisation assignments and authority rules.
- [ ] Add channel-account-to-company routing.
- [ ] Convert WhatsApp to persist-first asynchronous processing.
- [ ] Add the transactional outbox and restricted dead-letter workflow.
- [ ] Add correlation/causation IDs and complete audit records.

**Exit condition:** Every event is attributable, retryable, company-scoped and auditable.

### Phase 2 — Senior AI Manager and workforce pilot

- [ ] Implement structured management observations.
- [ ] Implement decision proposals and policy evaluation.
- [ ] Implement projects, tasks, dependencies and estimates.
- [ ] Implement employee schedules and capacity.
- [ ] Implement progress follow-up, evidence and escalation.
- [ ] Build owner and employee workspaces.

**Exit condition:** The AI can coordinate a real project, ask staff for estimates, monitor progress and escalate exceptions without unsafe autonomous action.

### Phase 3 — Accounting production workflow

- [ ] Complete persistent journal posting.
- [ ] Build finance approval and posting separation.
- [ ] Build receivables, payables, expenses, advances and reimbursements.
- [ ] Build receipt/document intake.
- [ ] Build bank imports and reconciliation.
- [ ] Build finance statements and management views.

**Exit condition:** Posted financial statements reconcile to immutable journal data, and every financial action has evidence and authority.

### Phase 4 — Department expansion

- [ ] CRM, sales and customer service.
- [ ] Procurement and inventory.
- [ ] Legal and compliance.
- [ ] Fleet and transport.
- [ ] Marketing and campaigns.
- [ ] Supervised AI reception and sales agents.

**Exit condition:** Department workflows feed one management, task, finance and audit system.

### Phase 5 — Advanced intelligence and controlled integrations

- [ ] Forecast and scenario engine.
- [ ] Agent training/evaluation and self-health monitoring.
- [ ] GPS/attendance integration after approval.
- [ ] CCTV health/event integration after approval.
- [ ] Additional banking, calendar and document integrations.

**Exit condition:** Advanced features operate under explicit legal, privacy, security and human-approval controls.

---

## 15. Definition of complete Architecture V2

The project is considered complete only when:

- All companies and records are isolated by tested database and application controls.
- Every staff member has a measurable workload and available-capacity view.
- The AI can create, assign, monitor and escalate tasks.
- Staff estimates, check-ins and evidence are stored and auditable.
- Departments operate through shared projects, tasks, documents, approvals and finance.
- Actual, committed and forecast financial positions are available by company, division, department, project and site.
- The internal double-entry ledger is the accounting source of truth.
- Sensitive actions follow explicit authority and approval policies.
- WhatsApp and other channels use durable, idempotent processing.
- Customer-facing AI agents are supervised, evaluated and capable of human handover.
- System health, integrations, queues, AI errors and costs are monitored.
- Legal, GPS and CCTV features comply with approved governance controls.
- Every AI recommendation and executed action can be traced to evidence, policy, human approval and outcome.

---

## 16. Instructions for the developer and AI coding agent

1. Read this change plan and `Singha_AI_Management_Architecture_V2.puml` before modifying code.
2. Confirm the reviewed repository baseline and inspect later commits for changes.
3. Implement one phase at a time on a dedicated branch.
4. Do not begin new departmental features before Phase 0 security work passes.
5. Do not perform a blind rewrite or create a second disconnected application.
6. Preserve passing accounting, policy, event and AI-schema tests.
7. Add tests for every corrected vulnerability and new domain rule.
8. Use forward-only database migrations for any non-disposable environment.
9. Keep all money in fixed-precision decimal types.
10. Keep AI outputs schema-validated and separate from execution.
11. Route sensitive actions through deterministic policy and human approval.
12. Never place credentials, production customer information or private evidence in prompts, source code or test fixtures.
13. Update the implementation-status document after every completed phase.
14. Stop and request owner approval before enabling money execution, legal commitments, employee surveillance, GPS/CCTV or high-risk customer-agent autonomy.

---

## 17. Final recommendation

Proceed with the present repository as the permanent foundation, but treat the next work as an Architecture V2 foundation correction rather than ordinary feature expansion.

The immediate development order is:

1. Documentation and security corrections.
2. Unified company/employee permission model.
3. Durable event and communication processing.
4. Senior AI Manager task/capacity pilot.
5. Production accounting workflows.
6. Department modules.
7. Advanced agents, GPS and CCTV under governance controls.

This sequence preserves the value already built while preventing the current shortcuts from becoming permanent security, accounting and operational weaknesses.
