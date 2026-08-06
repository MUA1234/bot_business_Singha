# Singha AI Business Manager

## Developer Observations, Next Development Phase, and Claude Code Master Prompt

**Repository:** `MUA1234/bot_business_Singha`  
**Reviewed baseline:** commit `5615d4c3d85820871ff9b4b12156c47238b8c58b`  
**Purpose:** move the current application from a broad pilot foundation to a secure, auditable production-control foundation for the intended Senior AI Manager.

---

## 1. Executive decision

Continue developing the current repository. Do not rewrite it as a new application.

The repository now contains valuable working foundations: authentication, department dashboards, tasks, staff capacity, accounting, HR, legal, fleet, procurement, sales, marketing, notifications, audit screens, AI schemas, event-processing components, database migrations, and 195 passing unit tests.

However, it is not yet safe to describe the system as a complete or production-ready AI senior manager. The next phase must concentrate on security boundaries, data integrity, approvals, staff progress, durable messaging, and live integration tests. Do not add more broad department screens until this phase is complete.

The intended product is not simply a chatbot or dashboard. It is a multi-company business control system in which the AI observes, organises, recommends, follows up, and performs only explicitly authorised low-risk actions. Financial, legal, employment, permission, banking, GPS, and CCTV decisions remain under deterministic policies and human authority.

---

## 2. Observations from the current repository

### 2.1 Strong foundations already present

- Next.js application deployed on Vercel.
- Supabase database, authentication, storage, and RLS foundations.
- Official Meta WhatsApp Cloud API integration.
- Internal double-entry accounting ledger; QuickBooks is not the accounting source of truth.
- Customer invoices, supplier bills, payments, journals, trial balance, P&L, balance sheet, ageing, reconciliation, commitments, loans, periods, and petty cash features.
- Tasks, assignments, estimates, check-ins, evidence, notifications, and capacity snapshots.
- HR, legal, fleet, procurement, sales, CRM, marketing, and management command-centre modules.
- Structured AI observation and planning schemas with Zod validation.
- Inngest consumers, source-event abstractions, duplicate handling, and an outbound-message outbox foundation.
- Security headers, CI configuration, audit screens, and system-health screens.
- TypeScript checking passes.
- Production build passes when required build-time configuration is supplied.
- 195 unit tests across 46 test files pass.

### 2.2 Important limitations

#### Identity and company isolation

- The new membership and organisation-unit model is additive only; the application still reads the legacy `profiles`, `department`, and `is_admin` fields.
- Normal application pages and server actions use the Supabase service-role client in approximately 117 files.
- Service role bypasses RLS. Company isolation therefore relies on every query remembering a manual `company_id` condition.
- Roles, membership roles, authority rules, and organisation assignments are not yet the application access-control source of truth.
- There are no live database tests proving that one company cannot read or mutate another company's data.

#### Accounting and payments

- Ledger posting exists, but document posting and source-document updates are sometimes separate operations.
- Invoice/bill header creation and line creation are not consistently transactional.
- Settlement and reversal functions do not provide caller-supplied idempotency keys or sufficient concurrency locking.
- Reconciliation trusts browser-submitted target IDs and amounts and is not fully transactional.
- Finance permissions are currently reduced to administrator or finance department checks; authority limits and approval policies are not consistently enforced.
- Several financial server actions use JavaScript `Number` for money and calculations.
- Database functions need explicit execution permissions and defence-in-depth authorisation.
- Parent/child company consistency is not enforced with composite foreign keys across every new module.

#### Auditability

- Audit recording is best-effort.
- Supabase insert errors can be returned as `{ error }` without throwing, so audit failures may be silently ignored.
- Sensitive mutation and audit insertion are not consistently committed in one database transaction.

#### Staff progress and capacity

- Managers can assign tasks, but task detail and task-update actions are restricted to Operations or administrators.
- An employee in Finance, Sales, Legal, Fleet, or another department can see an assigned task in `My Work` but cannot reliably perform the full task workflow.
- Employees cannot formally accept a task, provide their own estimate, report a blocker, request an extension, submit actual hours, or request verification.
- Capacity is primarily based on assigned estimated hours, not work schedules, leave, attendance, actual hours, and remaining effort.
- Evidence uploaded by a worker and evidence verified by a manager are not cleanly separated.
- The AI does not yet automatically ask a worker for an estimate or follow up through WhatsApp.

#### AI manager

- The AI manager currently analyses manually pasted updates or selected WhatsApp conversations and creates low-risk captured tasks.
- It does not yet continuously monitor all approved business inputs.
- It does not maintain a durable management case/observation/decision record for every material analysis.
- Manager analyses do not consistently use the complete AI gateway cost ledger.
- `gpt-5.6-sol` is configured, but its current price is absent from the application price table; recorded cost can therefore be zero.
- Routine classification and high-volume message work should not automatically use the most expensive model.

#### Messaging and integrations

- The live WhatsApp route performs AI/order processing and outbound replies synchronously inside the webhook request.
- Inngest and the outbox exist but are not connected to the live WhatsApp path.
- Email ingestion is a `501` stub.
- Google Sheets is an export/view mechanism, not a monitored source integration.
- GPS, CCTV, and automated attendance are not implemented and must remain gated until legal and privacy approval.

#### Operations and documentation

- The daily-digest endpoint fails open if `CRON_SECRET` is absent.
- The system-health page can hide database errors by returning zero.
- CI installs ESLint with `--no-save`; the dependencies are absent from the lockfile.
- Local lint fails because ESLint is not declared in `package.json`.
- The production dependency audit reports high-severity findings requiring investigation.
- `CURRENT_IMPLEMENTATION_STATUS.md` contains contradictory and outdated statements.
- `CLAUDE.md` says QuickBooks is not used but still contains QuickBooks posting instructions.
- The repository status document says only migrations 0008–0013 were applied while the current code expects later migrations. Actual environment migration state must be verified; it must not be assumed from the document.

---

## 3. Next phase: Production Control Foundation

### Phase objective

Create a safe production foundation for one-company pilot operation while preserving the multi-company architecture. At the end of this phase, company isolation, permissions, financial posting, staff progress, durable communication, auditing, and health reporting must be enforceable and testable.

This is a foundation phase, not a new-feature expansion phase.

### Work-package order

Complete these work packages sequentially. Use a separate branch or pull request for each package. Do not begin the next package until the previous package has been reviewed and accepted.

---

## WP0 — Documentation and truth reset

### Required work

1. Add this document as `docs/architecture-v2/NEXT_PHASE_DEVELOPER_BRIEF.md`.
2. Update `CLAUDE.md` so its document-precedence rules are unambiguous.
3. Remove all remaining QuickBooks instructions from active development documents.
4. Rewrite `docs/CURRENT_IMPLEMENTATION_STATUS.md` from the actual codebase rather than appending another section.
5. Record the actual migration state separately for local, staging, and production. Never state a migration is applied merely because the SQL file exists.
6. Replace percentage-style completion claims with evidence-based statuses: `not started`, `foundation`, `implemented`, `verified in staging`, or `production approved`.

### Acceptance criteria

- One authoritative target architecture and one authoritative next-phase plan.
- No conflict between active documents.
- QuickBooks documents clearly marked archived/superseded.
- Current status matches the code and test results.

---

## WP1 — Identity, RLS, permissions, and company isolation

### Required work

1. Complete the read and write cutover from legacy profiles to memberships, organisation units, roles, capabilities, authority rules, and delegations.
2. Introduce central helpers such as:
   - `requireMembership()`
   - `requireCapability(capability, scope?)`
   - `requireCompanyRecord(table, id)` or domain-specific equivalents
   - `canActOnTask()`
3. Replace service-role use in ordinary pages and user-initiated server actions with the authenticated RLS-controlled client.
4. Retain service role only for tightly scoped background workers, provider webhooks after verification, provisioning, and exceptional administrative jobs.
5. Add RLS write policies appropriate to capabilities and ownership.
6. Add composite company foreign keys for every parent-child relationship with duplicated `company_id`.
7. Ensure delegations have dates, scope, delegator, delegate, authority ceiling, and audit history.
8. Add integration tests against a real test Postgres/Supabase environment.

### Minimum isolation tests

- Company A user cannot read Company B records.
- Company A user cannot update or delete Company B records by submitting a known UUID.
- A user cannot assign a task to an employee from another company.
- A child row cannot reference a parent from another company.
- An employee cannot gain a capability by modifying form fields.
- A suspended membership loses access.
- A delegation works only during its valid period and within its defined authority.

### Acceptance criteria

- No normal application page or user action requires service role.
- Capabilities, not department-name string comparisons, control sensitive actions.
- Live company-isolation tests pass in CI.
- Existing customer WhatsApp behaviour remains functional.

---

## WP2 — Accounting, approval, idempotency, and audit hardening

### Required work

1. Design document-specific transactional posting functions for customer invoices, supplier bills, expenses, receipts, settlements, and reversals.
2. Each transactional posting operation must:
   - establish the authenticated actor;
   - verify company membership and capability;
   - verify approval status and authority limit;
   - lock the source record;
   - accept and enforce a caller-provided idempotency key;
   - validate the accounting period;
   - use fixed-precision decimal values;
   - post a balanced journal;
   - update/link the source document;
   - write the audit event;
   - commit or roll back as one transaction.
3. Add explicit `REVOKE`/`GRANT` statements for database functions. Do not rely on default function permissions.
4. If `SECURITY DEFINER` is used, set a safe `search_path`, perform internal `auth.uid()`/membership/capability checks, and test every bypass scenario.
5. Implement maker/checker controls and prevent prohibited self-approval.
6. Implement amount/currency/company/division approval thresholds.
7. Make reconciliation validate the target record, company, direction, currency, and remaining amount on the server inside a transaction.
8. Replace JavaScript floating-point money handling with validated decimal strings and `decimal.js` or Postgres numeric arithmetic.
9. Make critical audit writes fail closed and transactional.
10. Preserve the distinction between recording a payment and executing a bank transfer. The system must not execute bank transfers in this phase.

### Required tests

- Balanced and unbalanced journals.
- Closed/locked accounting period.
- Duplicate idempotency key.
- Concurrent settlement attempts.
- Concurrent reversal attempts.
- Overpayment and negative amount.
- Cross-company document and account references.
- Missing or insufficient approval.
- Self-approval prohibition.
- Failed audit insert rolls back the sensitive mutation.
- Source document and journal never become partially linked.

### Acceptance criteria

- Retried requests cannot duplicate financial records.
- Concurrent requests cannot over-settle or double-reverse.
- Sensitive postings require capability and valid approval.
- The source document, ledger, and audit trail always agree.

---

## WP3 — Staff task progress and capacity

### Required workflow

1. Manager or authorised AI creates a captured task.
2. Manager assigns it to a worker and requests an estimate.
3. Worker receives an in-app notification and, once messaging is wired, a WhatsApp notification.
4. Worker accepts, declines with a reason, or requests clarification.
5. Worker submits estimated hours and expected completion date.
6. Manager accepts the estimate or revises the plan.
7. Worker records progress, blockers, remaining effort, actual hours, and evidence.
8. The system follows up at configurable intervals.
9. Worker requests verification.
10. A manager or authorised verifier approves completion or returns the task for correction.

### Permission rules

- An assignee may update only permitted fields on their own assigned task.
- An assignee cannot reassign, approve, or verify their own task unless an explicit policy allows it.
- A manager can manage tasks within their organisational scope.
- Administrators can intervene, with an audit event.
- Evidence submission and evidence verification are separate events.

### Capacity model

Include:

- contracted weekly hours;
- work schedule and timezone;
- approved leave;
- holidays where configured;
- open assigned tasks;
- original estimate;
- actual hours;
- remaining estimate;
- due dates and dependencies;
- reserved operational time;
- overload and under-allocation thresholds.

### Acceptance criteria

- An employee from any department can action their own assignment without gaining Operations access.
- A manager can see planned, actual, remaining, blocked, overdue, and free capacity per employee.
- Capacity is reproducible from underlying records, not an unexplained AI score.
- Every status transition is authorised, validated, and audited.

---

## WP4 — Durable WhatsApp, reminders, and integration boundary

### Required work

1. Refactor the WhatsApp webhook to:
   - verify the raw-body signature;
   - parse only enough information to identify the event;
   - persist the raw event and provider message ID;
   - deduplicate it;
   - enqueue an Inngest event;
   - return HTTP 200 promptly.
2. Move AI processing, business updates, order handling, and reply preparation into durable workers.
3. Send outbound messages only through the transactional outbox and a retrying sender worker.
4. Store provider delivery IDs, attempts, last error, next retry, and final status.
5. Add dead-letter handling and an administrator retry/replay workflow.
6. Map staff WhatsApp identities explicitly. Do not infer employee identity solely from message text.
7. Add approved internal templates for task assignment, estimate request, overdue reminder, clarification, verification request, and escalation.
8. Respect Meta's customer-service window and approved-template requirements.
9. Keep the email route disabled until provider choice and signature verification are approved.

### Required tests

- Invalid webhook signature.
- Duplicate provider event.
- Worker timeout and retry.
- AI transport failure.
- Outbox send failure and retry.
- Duplicate outbox enqueue.
- One inbound event produces no more than one approved outbound response.
- Raw source event remains available after every downstream failure.

### Acceptance criteria

- No AI call or outbound WhatsApp send occurs inside the webhook request.
- Webhook retries do not duplicate tasks, messages, quotations, expenses, or ledger records.
- Failed processing is visible and safely replayable.

---

## WP5 — AI manager control loop and cost governance

### Required work

1. Persist management observations, evidence references, confirmed facts, inferred facts, uncertainties, proposed actions, policy decisions, approvals, and outcomes.
2. Use the AI gateway for all model calls, including manual manager analysis.
3. Record route, model, prompt version, tokens, cost, latency, validation result, confidence, correlation ID, source-event ID, and company ID.
4. Add the configured model prices to the cost table and test cost calculations.
5. Introduce logical model routes:
   - low-cost classification/extraction;
   - ordinary communication drafting;
   - complex managerial analysis;
   - specialist financial/legal analysis that always requires human review.
6. Do not allow model output to directly call business mutations.
7. Pass every proposed action through deterministic schema validation, policy, capability, authority, approval, idempotency, and audit layers.
8. Add an evaluation dataset for task extraction, financial-event extraction, prompt injection, uncertainty handling, and authority routing.

### Permitted AI autonomy in this phase

The AI may automatically:

- summarise verified records;
- create low-risk captured tasks;
- request missing information;
- send approved internal reminders;
- flag overdue work, inconsistencies, and exceptions;
- recommend assignments based on deterministic capacity data;
- draft communications for review;
- prepare accounting drafts without posting them.

The AI may not automatically:

- execute payments or bank transfers;
- post material journals;
- approve expenses, bills, or reimbursements;
- change bank details;
- sign or commit to contracts;
- make legal determinations;
- hire, dismiss, discipline, or change employee compensation;
- change roles or permissions;
- impose sanctions based on GPS/CCTV/attendance evidence;
- send material customer commitments outside an approved policy.

### Acceptance criteria

- Every material AI observation is traceable to evidence and source events.
- Every AI-proposed action has an explicit policy result and authority requirement.
- AI costs are recorded accurately.
- A prompt-injection attempt in a WhatsApp message, email, receipt, or document cannot override system policy.

---

## WP6 — Reliability, health, CI, and dependency control

### Required work

1. Make `CRON_SECRET` mandatory and fail closed when absent.
2. Do not return company identifiers or sensitive digest details from public cron responses.
3. Stop converting database errors into misleading zero counts on health screens.
4. Add structured logging with correlation IDs and safe redaction.
5. Add actionable alerts for failed source events, dead letters, outbox failures, repeated AI failures, migration mismatch, and accounting integrity exceptions.
6. Add ESLint and the appropriate Next.js lint configuration to `package.json` and the lockfile.
7. Make CI run from the lockfile without installing undeclared packages.
8. Add migration validation and a temporary test database to CI.
9. Triage dependency audit results deliberately. Do not run a blind upgrade or `npm audit fix` without reviewing framework compatibility.
10. Ensure build-time code does not require private runtime credentials.

### Required CI gates

- formatting/lint;
- TypeScript;
- unit tests;
- live database integration tests;
- RLS and company-isolation tests;
- migration up tests;
- accounting idempotency/concurrency tests;
- production build;
- secret scanning;
- dependency audit with an approved exception process.

### Acceptance criteria

- A clean checkout can run the documented verification commands.
- CI uses declared and lockfile-pinned dependencies.
- Health screens distinguish `healthy`, `zero`, `unavailable`, and `error`.
- Critical failures create an alert rather than disappearing into logs.

---

## 4. Capabilities deliberately excluded from this next phase

Do not implement these merely because tables or UI placeholders exist:

- live GPS tracking;
- CCTV video ingestion or automated surveillance;
- facial recognition;
- automatic attendance discipline;
- bank-transfer execution;
- autonomous legal decisions;
- autonomous employment decisions;
- unrestricted customer-facing autonomous agents;
- multi-country tax or payroll;
- an AI agent that trains and deploys other bots without human approval.

These require separate owner approval, threat modelling, privacy assessment, retention rules, legal advice, provider selection, and pilot acceptance criteria.

---

## 5. Definition of done for the next phase

The phase is complete only when:

- identity and permissions use the unified membership model;
- normal user operations do not use service role;
- cross-company read and mutation tests pass against a real database;
- financial posting is transactional, idempotent, concurrency-safe, approval-controlled, and audited;
- employees in every department can update their own assigned work under limited permissions;
- managers can view planned, actual, remaining, blocked, overdue, and free capacity;
- the live WhatsApp webhook is persist-first and asynchronous;
- outbound communication uses the outbox;
- the AI manager produces durable, evidence-linked, policy-routed observations and proposals;
- AI usage cost is accurately measured;
- cron, health, logging, retries, and dead-letter handling fail safely;
- lint, typecheck, unit tests, integration tests, migration tests, and production build pass;
- documentation matches the actual implementation;
- the owner has approved staging results before production deployment or production migration.

---

# 6. Claude Code Master Prompt

Copy the following prompt into Claude Code at the start of the next development phase. Place this document in the repository first so Claude can read it directly.

```text
You are the principal software architect, security engineer, accounting-systems engineer, and senior TypeScript developer for the Singha AI Business Manager.

REPOSITORY
MUA1234/bot_business_Singha

REVIEWED BASELINE
5615d4c3d85820871ff9b4b12156c47238b8c58b

MISSION
Evolve the existing application into a secure and auditable Senior AI Manager for Singha. Preserve the working application. Do not rewrite it, start a greenfield replacement, or add broad new feature modules during this phase.

The next approved phase is the Production Control Foundation described in:
docs/architecture-v2/NEXT_PHASE_DEVELOPER_BRIEF.md

MANDATORY FIRST READS, IN ORDER
1. AGENTS.md
2. docs/architecture-v2/NEXT_PHASE_DEVELOPER_BRIEF.md
3. docs/architecture-v2/CHANGE_PLAN.md
4. docs/architecture-v2/Singha_AI_Management_Architecture_V2.puml
5. docs/architecture-v2/IDENTITY_UNIFICATION_PLAN.md
6. CLAUDE.md
7. docs/SECURITY_AND_PRIVACY_MODEL.md
8. docs/PERMISSION_MODEL.md
9. docs/AUTHORITY_MATRIX.md
10. docs/TEST_STRATEGY.md
11. docs/CURRENT_IMPLEMENTATION_STATUS.md

DOCUMENT PRECEDENCE
1. The owner's explicit instruction for the current task.
2. NEXT_PHASE_DEVELOPER_BRIEF.md.
3. Architecture V2 CHANGE_PLAN.md and the Architecture V2 PlantUML.
4. Security, permission, authority, accounting, and test specifications.
5. CLAUDE.md after conflicting legacy statements are corrected.
6. Older documents only where they do not conflict.

QuickBooks is not used and is not the source of truth. Any active instruction referring to QuickBooks posting is superseded. The internally owned double-entry Accounting Core is the accounting source of truth.

NON-NEGOTIABLE SAFETY RULES
- Never expose, print, inspect, copy, or commit secrets or environment values.
- Never deploy to production or apply production migrations without explicit human approval.
- Never weaken authentication, RLS, company isolation, capabilities, approvals, accounting invariants, or auditability.
- Never use service role for an ordinary signed-in user's page or action.
- Never perform a mutation by bare record ID; prove company scope and authority.
- Never use JavaScript floating-point arithmetic for money.
- Never allow free-text model output to directly call a business mutation.
- Never make a bank transfer or claim that recording a payment executed a transfer.
- Never allow AI to approve/post material accounting, legal, HR, permission, banking, GPS, or CCTV actions.
- Never implement GPS, CCTV, facial recognition, or attendance discipline without a separate written approval.
- Never silently swallow a sensitive database, audit, queue, or integration error.
- Never create a duplicate financial event, journal, payment, reimbursement, task, quotation, or outbound message after a retry.
- Never edit or delete posted accounting history; correct it with controlled reversals.
- Never use unofficial WhatsApp libraries. Official Meta WhatsApp Cloud API only.
- Never run destructive git or database commands.

WORK METHOD
Work on exactly one approved work package at a time in this order:
WP0 documentation truth reset
WP1 identity/RLS/permissions/company isolation
WP2 accounting/approvals/idempotency/audit
WP3 staff task progress/capacity
WP4 durable WhatsApp/outbox
WP5 AI manager control loop/cost governance
WP6 reliability/health/CI/dependencies

Do not begin another work package until the current one has been reviewed and accepted.

BEFORE EDITING EACH WORK PACKAGE
1. Inspect the current implementation and nearby tests.
2. Report the exact files, tables, functions, routes, permissions, migrations, and tests affected.
3. Identify security, company-isolation, accounting, retry, and rollback risks.
4. State any assumption.
5. Ask a question only if the answer materially changes the safe design.
6. Present a concise implementation plan and wait for approval if the work package scope has not already been approved.

IMPLEMENTATION RULES
- Make small, reviewable changes.
- Use forward-only, idempotent migrations.
- Do not duplicate migration SQL in multiple runnable files; keep one migration source of truth.
- Use database transactions for multi-record business invariants.
- Use row locks and caller-provided idempotency keys for financial settlement and reversal.
- Use authenticated RLS paths for users and tightly scoped privileged paths for workers.
- Use central capability and scope checks, not scattered department-name comparisons.
- Add composite company foreign keys for parent-child relationships.
- Use Zod at external and AI boundaries.
- Persist raw source events before processing.
- Use Inngest for durable work and an outbox for outbound messages.
- Record correlation IDs across source event, AI run, decision, approval, mutation, audit event, and outbound message.
- Keep model IDs in the AI gateway only.
- Preserve confirmed facts, inferred facts, uncertainty, evidence, and confidence separately.
- Maintain clear maker, approver, and executor roles.
- Keep code compatible with the repository's chosen Next.js, TypeScript, Supabase, Inngest, and Zod architecture unless an approved dependency migration is part of the work package.

TEST REQUIREMENTS
Unit tests alone are not sufficient for this phase.

Add and run:
- permission tests;
- two-company isolation tests;
- RLS read and mutation tests;
- composite company-FK tests;
- migration tests on a temporary database;
- accounting balance tests;
- approval and authority-limit tests;
- idempotency and concurrency tests;
- duplicate webhook/outbox tests;
- task ownership and transition tests;
- prompt-injection and schema-validation tests;
- production build and lint.

Do not claim a security or database behaviour is verified using only a mocked unit test.

REQUIRED VERIFICATION BEFORE COMPLETION
- npm ci
- npm run lint
- npm run typecheck
- npm test
- the new integration/RLS/migration test command
- npm run build with documented non-secret build configuration
- git diff review
- migration ordering review
- secret scan
- dependency audit review

If a command cannot be run, state exactly why. Do not claim it passed.

REQUIRED COMPLETION REPORT FOR EACH WORK PACKAGE
1. Outcome.
2. Files changed.
3. Migrations added.
4. Permissions and company-isolation controls added.
5. Audit events added.
6. Tests added and exact results.
7. Commands not run and why.
8. Remaining risks.
9. Staging instructions.
10. Rollback/recovery notes.
11. Whether owner approval is required before the next action.

STOP CONDITIONS
Stop and request human direction if:
- production credentials or production mutation authority are required;
- a proposed change may expose or destroy business data;
- migration state is unknown and materially affects safety;
- requirements conflict;
- a financial/legal/HR permission policy is missing;
- a dependency upgrade requires a material framework migration;
- GPS, CCTV, facial recognition, bank execution, or autonomous legal/HR action is requested;
- the only available implementation would weaken an invariant.

FIRST TASK
Start with WP0 only.

Inspect the repository and prepare the WP0 change plan. Do not make code changes until you have reported:
- every conflicting or stale active document;
- the proposed authoritative document hierarchy;
- the actual test/build/CI status observable from the repository;
- the migration files present and the migration state that still requires human/environment confirmation;
- the exact documentation files you propose to modify.

After reporting the WP0 plan, stop and wait for approval.
```

---

## 7. Recommended developer operating pattern

For the best results, the developer should not ask Claude to “complete the whole system” in one session. Use the master prompt once, then issue one work-package prompt at a time.

Example continuation prompt:

```text
Proceed with approved WP1 only.

First inspect the current branch and restate the accepted WP1 scope. Then implement the smallest safe identity/RLS cutover slice that can be independently tested and reviewed. Do not start WP2. Do not deploy or apply production migrations.

At completion, provide the required work-package report and stop.
```

Recommended branch/PR names:

- `phase-control/wp0-doc-truth`
- `phase-control/wp1-identity-rls`
- `phase-control/wp2-accounting-controls`
- `phase-control/wp3-staff-progress`
- `phase-control/wp4-durable-whatsapp`
- `phase-control/wp5-ai-manager-loop`
- `phase-control/wp6-reliability-ci`

Each pull request should be reviewable, reversible where practical, and independently verifiable. Avoid commit messages such as `84%`, `89%`, `final`, or `fix`; use messages that describe the actual invariant or behaviour changed.

