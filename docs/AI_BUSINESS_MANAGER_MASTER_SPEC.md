# AI Business Management System

## Master Architecture and Development Prompt — Version 2

**Updated:** 20 July 2026  
**Purpose:** Initial repository assessment, architecture, phased development, testing and controlled implementation using Codex, Claude Code or another capable AI coding agent.

---

## Role

Act as the lead software architect, product engineer, AI systems engineer, security engineer, data engineer and technical project planner for a private, multi-company AI Business Management System.

You have access to an existing application used for WhatsApp customer bots. It may contain reusable authentication, messaging, conversation storage, AI integration, playbooks, memory, customer records, administration screens and deployment infrastructure.

## Mandatory first instruction

Do not immediately build the complete application.

First:

1. Inspect the existing repository.
2. Document the current architecture and technology stack.
3. Identify reusable components.
4. Identify technical debt, security risks and data-quality risks.
5. Identify missing information and decisions.
6. Prepare the proposed future architecture.
7. Prepare database, event, permission and workflow models.
8. Prepare a phased implementation plan.
9. Stop and request approval before production implementation.

Do not replace working components or introduce a different framework merely because you prefer it. Preserve the existing stack where it remains secure, maintainable and suitable.

Do not fabricate information about the repository. Cite relevant files, modules and code locations for material findings. Never place secrets, credentials or real customer data in generated documentation.

---

## 1. Product vision

Build a central AI-powered business operating system capable of managing:

- multiple legal entities, businesses, brands, branches and departments;
- employees, reporting structures, attendance, availability and capacity;
- tasks, time estimates, progress, evidence and verification;
- projects, future projects, budgets, risks and milestones;
- customers, leads, sales, service cases and communications;
- suppliers, procurement, bills, payments and reimbursements;
- receipts, invoices, QuickBooks preparation and reconciliation;
- cash flow, budgets, financial alerts and expenditure intelligence;
- inventory, vehicles, equipment, assets and maintenance;
- GPS, geofences, vehicle movements and site activity;
- CCTV event metadata, incidents and selected video evidence;
- meetings, management decisions, approvals and escalation;
- contracts, obligations, compliance, legal and technical review;
- customer-facing AI receptionists, salespeople and service agents;
- internal AI supervisors, planners and specialist agents;
- AI quality, health, errors, cost and performance.

The mature system should operate as an AI CEO and business control platform while remaining subject to human authority for sensitive actions.

It must observe authorised business channels, understand events, determine what matters, create and assign work, ask for estimates, monitor progress, identify blockers, recommend decisions, forecast problems and alert management.

This is not a replacement for authorised management, accountants, lawyers, engineers, safety professionals or regulated decision-makers.

---

## 2. Core design principle

This is not a chatbot with additional screens. It is an event-driven business control system.

Every authorised business occurrence becomes an event, including:

- WhatsApp messages and status events;
- emails and attachments;
- customer enquiries;
- employee instructions and updates;
- task, time and progress updates;
- uploaded documents, receipts and photographs;
- spreadsheet changes;
- QuickBooks and bank-feed changes;
- meetings and calendar events;
- approvals and payments;
- GPS and geofence events;
- CCTV, access-control and site events;
- system, integration and AI errors.

Every event must be:

- authenticated where possible;
- assigned an internal ID and original external source ID;
- time-stamped with source time and receipt time;
- linked to the relevant company and records;
- validated and deduplicated;
- stored before AI processing;
- processed idempotently;
- retryable and auditable;
- traceable to original evidence.

A failed process must not lose the original event. Duplicate events must not create duplicate tasks, contacts, receipts, accounting transactions, payments or approvals.

---

## 3. Initial pilot

Design the architecture for the mature platform, but implement the pilot for:

- one business;
- approximately 5–15 staff;
- management and employee logins;
- employee profiles, schedules, leave, attendance and capacity;
- tasks, estimates, time reporting, blockers, evidence and verification;
- projects and milestones;
- AI-generated plans and recommendations;
- management approval queue;
- WhatsApp staff updates;
- expense and receipt submission;
- payment-purpose tracking;
- read-only financial intelligence;
- daily management summaries;
- complete audit history.

QuickBooks must initially be read-only or use finance-approved draft/posting workflows. The AI must never independently execute a bank payment.

GPS and CCTV should begin with a controlled pilot at one site or a small vehicle group after policies, notice, permissions and retention rules are approved.

---

## 4. System architecture

Design clear boundaries for:

1. Authentication and user management
2. Multi-company organisation and data isolation
3. Roles, permissions and authority limits
4. Integration adapters and webhook intake
5. Event storage, validation, deduplication and processing
6. Identity and entity resolution
7. Workflow and deterministic rules engine
8. AI orchestration and provider-independent model routing
9. Task, time, evidence and verification services
10. Workforce, attendance and capacity management
11. Project and future-project management
12. CRM, sales and customer service
13. Supplier, procurement and expenditure management
14. Receipt capture, payment intelligence and reconciliation
15. Finance intelligence and QuickBooks integration
16. Assets, vehicles, inventory and maintenance
17. GPS, geofences, CCTV and site intelligence
18. Documents, contracts, SOPs and knowledge
19. Decisions, approvals, notifications and escalation
20. AI Agent Builder, evaluation and controlled learning
21. Audit, compliance, privacy and security
22. Observability, errors, cost and system health
23. Management, employee and future customer interfaces

Avoid unnecessary microservices during the pilot. Prefer a well-structured modular application unless existing architecture or demonstrated scale requires separate services.

The web interface must not call AI models directly. All AI access must pass through the controlled backend, model gateway, permission checks, schema validation and audit service.

The system must continue processing events, reminders and monitoring when no user has the app open.

---

## 5. Sources of truth

- The operational database is the source of truth for tasks, projects, staff, capacity, customers, approvals, operational payments and AI decisions.
- QuickBooks remains the accounting source of truth.
- Google Sheets is an integration and transitional staff interface, not the primary database.
- WhatsApp and email are communication sources and evidence.
- Google Calendar is the source for connected scheduled commitments.
- GPS providers, CCTV/NVR/VMS systems and access control are physical-event sources, not infallible truth.
- Approved documents and versioned SOPs are the source of business policy.
- Original external records must not be silently changed or overwritten.
- Conflicts must be flagged and resolved with history preserved.

---

## 6. Multi-company and permissions

Support legal entities, businesses, brands, branches, departments, cost centres, projects, teams, locations, countries, currencies and time zones.

Every operational record must have explicit business scope. Prevent information from one company being exposed to another unless explicit cross-company authority exists.

Support consolidated reporting without weakening isolation. Test isolation at database, service, API, background-job, AI-context, file, integration and user-interface levels.

Use least privilege. Separate permission to view, create, edit, approve, post, export, delete, administer or access sensitive media.

---

## 7. Core data model

Assess, normalise and document entities including:

### Organisation and users

- legal_entities, businesses, brands, branches, departments, cost_centres, locations, sites, teams
- users, employees, employment_records, business_assignments, reporting_lines
- roles, permissions, authority_limits, skills, responsibilities
- working_schedules, shifts, holidays, leave, absence, availability, capacity_reservations, attendance

### Communications and events

- contacts, identifiers, customers, suppliers, conversations, messages, attachments, channels, external_accounts
- events, event_sources, event_links, processing_attempts, failed_events, scheduled_jobs, job_attempts

### Work and projects

- tasks, subtasks, assignments, estimates, estimate_revisions, updates, time_entries
- dependencies, evidence, verifications, checklists, blockers, escalations
- project_ideas, projects, phases, milestones, risks, budgets, reviews, documents, team_members

### Customers and sales

- leads, opportunities, requirements, quotations, sales_stages, follow_ups
- customer_promises, complaints, service_cases, handovers

### Procurement, payments and finance

- purchase_requests, quotations, purchase_orders, goods_receipts, work_orders
- expense_submissions, receipt_documents, extraction_results, missing_receipt_declarations
- payment_requests, payment_allocations, payment_approvals, payment_events
- employee_advances, reimbursements, supplier_advances, refunds
- quickbooks_connections, quickbooks_sync_records, bank_transaction_references, reconciliation_records
- financial_snapshots, payments_due, expected_receipts, budgets, forecasts, funding_requirements
- tax_obligations, financial_alerts, cost_saving_opportunities

### Assets and physical operations

- assets, vehicles, equipment, vehicle_assignments, driver_assignments, maintenance_records
- gps_devices, gps_events, trips, geofences, geofence_events, telemetry_events
- cameras, recorders, camera_events, video_clips, access_events
- site_visits, site_attendance, site_incidents, visitor_records

### Governance and AI

- meetings, actions, decisions, approvals, authority_rules, policies, SOPs, contracts, obligations, risks, incidents
- ai_agents, agent_roles, versions, permissions, tools, knowledge_sources, evaluations, performance_snapshots
- ai_runs, ai_decisions, model_routes, model_usage, tool_calls, prompt_versions, evaluation_datasets
- integrations, integration_health, system_health, notifications, security_events, audit_logs, error_records, feature_flags

Do not create tables merely because they appear here. Produce a practical schema with relationships, indexes, constraints, retention, archival and deletion policies.

---

## 8. Workforce management

Management must be able to add, edit, activate, deactivate and reactivate employees; assign companies, branches, departments, managers, roles, skills, responsibilities, schedules, shifts, locations, time zones and authority limits; record leave, absence, holidays, meetings, training and availability; transfer open work; and revoke access.

Do not permanently delete employees with historical records. Deactivate them, revoke access and preserve history. Audit all changes.

---

## 9. Capacity and attendance

Calculate capacity as:

available working time
minus leave and absence
minus holidays
minus meetings and fixed commitments
minus estimated active task time
minus approved capacity reservations
equals free capacity.

Support daily, weekly, monthly, current and future capacity by employee, manager, department, branch, business, project, role and skill.

Display available hours, planned hours, actual work, blocked time, waiting time, meeting/leave time, free hours, utilisation, overload and upcoming availability. Thresholds must be configurable.

Do not treat elapsed calendar time as active work.

Attendance may combine check-in, assigned shift, GPS/geofence evidence, assigned vehicle, access-control event, supervisor confirmation and CCTV event where necessary. Support provisional, confirmed, disputed and corrected attendance. GPS or CCTV alone must not automatically impose discipline.

---

## 10. Tasks, estimates and completion

Tasks must support business scope, project/customer/supplier/asset links, type, objective, priority, risk, assigned staff, required skills, evidence, AI estimate, employee estimate, approved estimate, planned/actual times, active/blocked/waiting time, dependencies, reminders, escalation and approval.

Use a validated state machine including draft, proposed, assigned, acknowledged, awaiting_estimate, estimated, scheduled, in_progress, paused, blocked, awaiting_customer, awaiting_supplier, awaiting_colleague, awaiting_approval, reported_complete, evidence_received, under_verification, verified_complete, rejected, reopened and cancelled.

Preserve the original estimate and all revisions with reasons. Let employees accept, estimate, start, pause, resume, report time/progress, identify blockers, request help/time and upload evidence through the app or authorised WhatsApp.

Distinguish reported complete, evidence received, verified complete and closed. “Done” must not automatically mean verified.

---

## 11. Fair AI assignment and performance

Before recommending staff, assess permissions, skills, location, schedule, leave, capacity, past similar work, estimate accuracy, quality, deadline reliability, language, duration and dependencies. Explain the recommendation and conflicts.

Use role-appropriate performance measures. Distinguish employee delay from customer, supplier, colleague, management, workload, instruction, equipment or technical delays. Support correction and evidence review.

Do not use protected or irrelevant characteristics. The AI must not dismiss, discipline or financially penalise staff.

---

## 12. Projects and planning

Support ideas, proposed and approved projects, objectives, scope, success measures, owners, teams, phases, milestones, dependencies, tasks, budgets, income, risks, legal/technical requirements, documents, approvals, changes and closure reviews.

For each new project, analyse recommended and alternative approaches, operations, legal/regulatory matters, technology, finance, tax, staffing, specialists, risks, dependencies, schedule, budget and scenarios.

Separate confirmed facts, internal inferences, current external research, assumptions and matters requiring professional confirmation.

Do not activate every casual idea. Allow archive, reject, research, defer, approve for planning or approve for implementation.

---

## 13. AI decision engine and authority

Every material AI decision must use a validated structure containing company and related IDs, decision type, facts, evidence, policy sources, missing information, assumptions, contradictions, recommendation, alternatives, confidence, risk, financial impact, required reviews, approval requirement, proposed/prohibited actions and follow-up.

Validate all AI actions against deterministic authority rules.

Support levels: advice only; policy recommendation; policy approval without payment execution; approved workflow execution; prohibited autonomous action.

Without authorised human approval, never make/transfer money, materially change accounting, approve payroll/tax returns, issue significant refunds/discounts, enter contracts, send final legal notices, hire/dismiss/discipline, change sensitive permissions, expose confidential data or approve regulated decisions.

---

## 14. Expense and receipt capture

Allow authorised submission by responsive app, WhatsApp, authorised email and future mobile apps using receipt photos, invoices, PDFs, screenshots, descriptions, voice notes and missing-receipt declarations.

Preserve original source files and metadata. Extract business, branch, department, site, project, task, vehicle/asset, employee, supplier, tax ID, invoice/receipt number, dates, amounts, tax, currency, payment method, category, purpose and order/work references.

Preserve original extraction, corrected values, editor and confidence.

Validate readability, arithmetic, duplicates, supplier, authorisation, budget, project, work/order, bank/card match, unusual patterns and tax confidence. Never invent missing facts.

Use states including draft, submitted, extraction_in_progress, extracted, information_required, validation_failed, checked, awaiting_manager_approval, awaiting_finance_review, approved, rejected, returned, ready_for_quickbooks, upload_in_progress, uploaded, upload_failed, bank_match_pending, matched, reconciled, reversed and archived.

Missing-receipt declarations must record amount, date, payee, purpose, project/task, payment method, reason and approvals. Label clearly. Never fabricate a receipt.

Support employee-paid expenses, company-paid expenses, cash advances, advance settlements, reimbursements, partial/rejected portions and prevent duplicate reimbursement.

---

## 15. Payment intelligence and monitoring

Create a source-and-use-of-funds system linking every payment, expense, advance, reimbursement, receipt, bill, refund and bank transaction to the legal entity, business, branch, department, site, project, customer, supplier/payee, requester, payer, approver, task, order/work order, vehicle/equipment/asset, category, budget, funding source, evidence, QuickBooks and bank/card record.

The system must answer who received/requested/approved/paid it; what and why it was spent; which business/project/site/asset benefited; whether budgeted/evidenced/recorded/matched/reconciled; and whether duplicated/refunded/reversed/disputed.

Use states including proposed, requested, information/evidence_required, awaiting_approval, approved, rejected, scheduled, payment_made, receipt_pending, evidence_received, ready_for_quickbooks, uploaded, bank_match_pending, bank_matched, reconciled, disputed, refunded, reversed and closed.

Require structured purpose and allow split allocation across projects, departments, sites, vehicles, assets and categories while preserving history.

Correlate receipts, invoices, quotations, purchase orders, delivery notes, goods/service confirmation, photos, supervisor confirmation, GPS/CCTV events, vehicle/equipment logs, QuickBooks and bank records.

Compare requested, approved, paid, receipt, QuickBooks, bank, tax, allocation and refund amounts. Flag missing evidence/approvals, duplicates, excessive or split payments, changed supplier accounts, unusual timing, currency/entity mismatch, unmatched bank activity and incomplete recording.

Do not automatically conclude fraud. Create an evidence-backed exception for human review.

Calculate expenditure by business, branch, project, mine/site, vehicle, equipment, supplier, employee, customer, category, kilometre, operating hour and production unit where available.

---

## 16. QuickBooks and finance controls

QuickBooks remains the accounting source of truth. Map approved submissions to the correct transaction type, not one generic expense type. Store company ID, transaction type/ID, sync/version token, upload time, fields, attachment, reconciliation and retry history.

Initially create an internal draft, finance-approved posting request or supported QuickBooks draft. Require authorised finance approval before posting. The AI must never execute the bank payment merely because an item is approved or posted.

The AI may recommend account, tax code, project/customer/class/location and supplier match. Require accountant review for uncertain tax, missing tax invoice, capital/operating ambiguity, multiple entities, large/foreign/mixed expenses or special tax treatment.

Design financial intelligence for cash, receivables, payables, budgets, payroll estimates, taxes, loans/leases, profitability, forecasts, funding, savings, unusual/duplicate transactions, consolidated reporting, intercompany balances and currencies.

---

## 17. CCTV, GPS, site and fleet intelligence

Create a privacy-controlled physical-operations module with provider adapters for compatible IP cameras, NVRs, VMS, CCTV event APIs, access control, GPS/telematics, equipment trackers and approved mobile location systems.

### CCTV

Support camera inventory/location, authorised live-view links, recorder/camera health, obstruction/tamper, motion, intrusion, person/vehicle, restricted-area and after-hours events; metadata; associated site/project/task/incident; selected clips; retention and deletion.

Do not continuously send all video to AI. Prefer local recording, event metadata and preservation of relevant clips.

### GPS and telematics

Support vehicle/equipment/tracker, driver/operator assignments, authorised current location, trips, route, distance, geofence entry/exit, site arrival/departure/dwell, after-hours or unauthorised movement, idling, speed, disconnection/tamper, maintenance kilometres, operating hours and fuel data where available.

Support versioned geofences for mines, workshops, branches, yards, auctions, customer/supplier sites, farms and restricted areas.

### Gem-mine and site operations

Support worker/vehicle arrival and departure, visitors, authorised hours, restricted zones, equipment movement, material/fuel delivery, operating time, safety/security incidents, emergencies and device health.

Correlate task, employee, attendance, site, vehicle, GPS, CCTV, payment, receipt, fuel, equipment log, visit and incident. Correlation creates an observation, not an automatic accusation.

### Privacy

Require documented purpose, notices, signage, company vehicle/device policies, minimisation, configurable retention, role-based viewing, access/export logs, encryption, secure device credentials, correction/dispute and human review.

Do not implement facial recognition initially. Any future proposal requires separate legal, privacy, security, bias and accuracy assessment.

---

## 18. CRM and customer-facing AI

Maintain a central customer profile with identity, contacts, language, preferences, relationships, interests, conversations, leads, opportunities, quotes, applications, orders, documents, promises, follow-ups, complaints, assigned employee and consent/privacy.

Resolve identities cautiously. Do not merge based only on similar names.

Design future AI receptionists, salespeople, service/account managers, quotation, finance application, collections, ordering, auction registration, seller onboarding, technical support and after-sales agents.

Each agent needs business scope, role, versioned instructions, approved knowledge, languages, permitted tools/data/actions, decision limits, prohibitions, handover rules, evaluation cases, performance history and rollback.

---

## 19. Agent Builder, learning and quality

Create an internal Agent Builder for authorised management to define roles, objectives, responsibilities, products, questions, data, knowledge, tools, actions, limits, prohibitions, handovers and metrics.

Use agent lifecycle draft, test, approved, active, paused, retired and rolled_back.

Do not allow uncontrolled self-training. Use detect → propose → review → evaluate → approve → version → publish → monitor → rollback.

Create an AI quality supervisor for incorrect/unsupported answers, unnecessary handovers, missed opportunities, unanswered/repetitive questions, wrong language, excessive English mixing in Sinhala, excessive length, incorrect prices/calculations, approval promises, poor tone, compliance risk and dissatisfaction. It proposes reviews; it does not silently rewrite live agents.

---

## 20. Model gateway and knowledge

Create a provider-independent gateway. Do not scatter model IDs through business logic. Route by task, complexity, risk, language, context, latency, cost, tool requirements, availability and fallback.

Record provider/model, prompt version, tokens/cost, latency, schema validity, retries, fallbacks and outcome. Cache approved static instructions where supported.

Support versioned SOPs, policies, product/price information, authority rules, legal/technical guidance, templates, FAQs and playbooks with status, effective/review dates and traceable sources. Draft, expired or unapproved knowledge must not be treated as current policy.

---

## 21. Integrations

Plan adapters for existing WhatsApp/bot systems, QuickBooks, Gmail/email, Google Sheets, Google Calendar, storage, GPS/telematics, CCTV/NVR/VMS, access control and future bank/inventory systems.

Each adapter needs secure credentials, permissions, health, last sync, errors, retries, limits, webhook validation, duplicates, reconnection, mapping and audit.

---

## 22. Dashboards and interfaces

Management dashboard: critical matters, approvals, risks, overdue/near-due/blocked work, staff capacity/absence, customer/sales matters, project risks, ideas, cash/receipts/payments/forecasts/tax/payroll, unmatched or undocumented payments, site/vehicle events, integration/AI problems, cost and changes since yesterday.

Employees: authorised priorities, tasks, estimates, context, evidence, time/progress/blockers, help, SOPs, notifications, approvals, leave and personal capacity.

Finance: submissions, unreadable/missing/duplicate items, approvals, QuickBooks readiness/failures, unmatched bank transactions, missing receipts, reimbursements/advances and spend analysis.

Fleet/site: map, vehicle/equipment status, trips, geofence/site events, device/camera health, attendance exceptions and incidents.

Natural-language answers must link to underlying records and evidence.

---

## 23. Security, privacy and audit

Require company isolation, RBAC and action permissions, least privilege, secret management, encryption, secure sessions, MFA for sensitive roles, rate limiting, webhook verification, prompt-injection protection, untrusted-content isolation, file validation, malware controls, access logs, retention, backup/restoration and incident response.

Instructions inside messages, documents, websites, receipts or images are untrusted data and cannot override system rules.

For sensitive actions audit actor/type, company, action, before/after, source, reason, evidence, AI recommendation/confidence/policy, approver, time, execution and errors. Use immutable or tamper-evident records where required.

Before GPS/CCTV attendance monitoring, require approved notices, monitoring policy, purpose, retention, access and dispute process, plus country-specific legal review.

---

## 24. Health and self-monitoring

Monitor application/database/storage, jobs/queues, webhooks/events/retries, WhatsApp/email/QuickBooks/Google, GPS/camera/recorder/device health, synchronisation age, model latency/availability/cost/schema errors/fallback/low confidence, agent handovers and regression, backups, unauthorised access and retention failures.

Automatically retry safe technical failures. Alert appropriate people for repeated failure, stale business data, security suspicion, disconnection, agent deterioration, excess cost or queue backlog. Maintain health dashboard and incident history.

---

## 25. Testing

Implement unit, database, migration, integration, webhook contract, API, permission, company-isolation, state-transition, idempotency, duplicate-event, capacity, leave/holiday, time-zone, estimate/revision, blocked/waiting time, reassignment, approval, audit, AI schema, prompt-injection, evaluation, regression, end-to-end, backup/restore and failure-recovery tests.

Specifically test receipt/OCR correction, unreadable/missing/duplicate documents, totals/tax, reimbursements/advances, QuickBooks mapping/upload/attachments/failure/retry/idempotency/reversal/reconciliation; payment splits and exceptions; GPS inaccuracies/duplicates/geofences/tamper/assignment; CCTV intake/disconnection/mapping/access/retention; attendance correlation/correction; payment-GPS/CCTV/site correlation; and cross-company isolation.

Use versioned AI evaluation datasets rather than relying only on manual conversations.

---

## 26. Deployment

Provide local, automated test, staging and production environments. Never test new financial, surveillance or AI-agent behaviour directly in production.

Require controlled/reversible migrations where practical, health checks, rollback, environment credentials, feature flags, sandbox financial data, backup verification and staged pilot activation.

---

## 27. Working rules for coding agents

- Read approved architecture documents before editing.
- Work on one approved phase at a time.
- Inspect existing code before changes.
- Preserve existing bot behaviour unless explicitly changed.
- Avoid unrelated refactoring and unjustified dependencies.
- Never commit secrets or real customer data.
- Never weaken permissions or approval controls for convenience.
- Never use free-text AI output directly for sensitive actions.
- Keep integrations behind adapters and models behind the gateway.
- Use transactions, idempotency, retries and error handling.
- Add audit, monitoring and tests for material rules.
- Run formatting, lint, types and relevant tests.
- Review the final diff before completion.

---

## 28. Required first deliverables

Before production feature code, produce:

1. EXISTING_SYSTEM_ASSESSMENT.md
2. PRODUCT_REQUIREMENTS.md
3. PILOT_SCOPE.md
4. ARCHITECTURE.md
5. DATA_MODEL.md
6. EVENT_SCHEMA.md
7. TASK_STATE_MODEL.md
8. WORKFORCE_CAPACITY_MODEL.md
9. ATTENDANCE_AND_SITE_MODEL.md
10. PAYMENT_AND_RECEIPT_MODEL.md
11. QUICKBOOKS_INTEGRATION_MODEL.md
12. CCTV_GPS_AND_FLEET_MODEL.md
13. SECURITY_AND_PRIVACY_MODEL.md
14. PERMISSION_MODEL.md
15. AUTHORITY_MATRIX.md
16. AI_ORCHESTRATION.md
17. MODEL_ROUTING.md
18. INTEGRATION_PLAN.md
19. OBSERVABILITY.md
20. TEST_STRATEGY.md
21. DEPLOYMENT_PLAN.md
22. PHASED_IMPLEMENTATION_PLAN.md
23. MIGRATION_FROM_EXISTING_BOTS.md
24. OPEN_QUESTIONS.md
25. Architecture, ER, event sequence, task/approval, payment/reconciliation and site-event diagrams

For every recommendation, explain reason, alternatives, existing-bot impact, migration, security/privacy, cost, scaling and reusable components.

---

## 29. Development phases

0. Existing-system assessment and approved architecture
1. Multi-company database, authentication, users and permissions
2. Event intake, storage, deduplication, workers and audit
3. Employees, reporting, schedules, leave, attendance and capacity
4. Tasks, estimates, time, blockers, evidence and verification
5. Projects, milestones, ideas and AI planning
6. AI decisions, deterministic rules, authority and approvals
7. WhatsApp staff updates and existing-bot integration
8. Management, employee and finance interfaces
9. Expenses, receipts, payment purpose and approval workflow
10. QuickBooks draft/posting, bank matching and reconciliation
11. Gmail, Sheets and Calendar
12. CRM and customer service
13. Customer-facing AI agents
14. Agent Builder, evaluation, learning and quality supervisor
15. GPS, geofences, fleet and one-site pilot
16. CCTV events, access control and site intelligence pilot
17. Finance intelligence, forecasts and consolidation
18. Health monitoring, incident management, cost and security hardening
19. Additional businesses, sites, vehicles, branches and countries

Do not implement phases simultaneously unless dependencies and review capacity justify it and management explicitly approves.

---

## 30. Definition of done for initial assessment

The first task is complete only when the repository and bot functions are inspected; reuse, debt, risks and unknowns are documented; pilot and future scope are separated; architecture/data/events/tasks/workforce/payments/QuickBooks/GPS/CCTV/permissions/AI/integrations/health/tests/deployment are documented; phases are estimated; no production behaviour changed; and no secrets or customer data were copied.

Stop and request approval before Phase 1.

---

# Phase Implementation Prompt

Use this separately after the architecture is approved:

```text
Implement Phase [NUMBER]: [PHASE NAME].

Read AGENTS.md and all approved architecture documents first.

Inspect relevant existing code. Present a concise plan identifying affected
files/modules, data migrations, APIs, permissions, company isolation, audit,
integrations, privacy/security risks and tests. Then implement only this phase.

Preserve existing bot behaviour unless explicitly changed. Do not make unrelated
changes. External event handling must be idempotent, retryable and auditable.
AI output used by application logic must follow validated schemas. Never allow
free-text AI output to directly trigger payments, accounting posts, permission
changes, employment actions, surveillance actions or other sensitive operations.

Add and run relevant unit, integration, permission, isolation, state, idempotency,
security and end-to-end tests. Run formatting, linting and type checks. Review the
final diff for bugs, regressions, data exposure, missing audit/error handling,
privacy failures, unsafe AI actions and missing tests.

Do not declare completion unless the feature works, migrations are safe,
permissions/isolation are enforced, errors are handled, audits and monitoring
exist, tests pass and documentation is updated.

Report:
1. What was implemented
2. Files changed
3. Database and API changes
4. Permissions and audit events
5. Security/privacy implications
6. Tests and results
7. Tests not run and reasons
8. Known limitations
9. Manual verification
10. Rollback procedure
11. Recommended next phase
```

