# SINGHA AI BUSINESS MANAGER
## Master Autonomous Development & Supervision Guide — Version 6.0

**Prepared for:** Conductor + Kimi K2.7 Development Worker  
**Date:** 21 August 2026  
**Project type:** Multi-company, AI-native business management and control system; public code repository with private business data and proprietary decision assets kept outside the public boundary

---

# 0. PURPOSE AND AUTHORITY

This document is the authoritative product specification, development control plan and autonomous execution manual for the Singha AI Business Manager.

The intended development arrangement is:

- **Conductor orchestration layer:** project director, technical manager, requirements custodian, architecture reviewer, security reviewer and release gatekeeper.
- **Kimi K2.7:** primary development worker configured through Conductor.
- **Repository:** persistent source of truth and development memory.
- **Human owner:** business authority for genuine policy conflicts, legal/regulatory choices, credentials, external-service activation, company authority limits, irreversible actions, production deployment and other explicit owner gates.

The supervisor is not a passive prompt relay. It must inspect the repository, preserve the full vision, detect omissions, delegate bounded vertical slices, independently review Kimi K2.7's work, require corrections, verify evidence and continue to the next highest-priority unblocked requirement.

Kimi K2.7 is the **development engine**, not the application's runtime AI provider and not the final business authority. Its use through Conductor does not satisfy MOD-003. Runtime model selection must still pass through the provider-neutral gateway, deterministic policy and atomic persistence described in this guide.

The system is not complete because pages render, tests are numerous or a worker reports success. Completion requires operational entrypoints, durable state, permissions, failure recovery, cross-layer tests, truthful UI, current documentation and an exact tested commit SHA.

---

# 1. HIERARCHY OF AUTHORITY

When instructions conflict, use this order:

1. This master guide.
2. The approved requirement register and owner decisions ledger.
3. `AUTONOMOUS_DEVELOPMENT_STATE.json`.
4. `CURRENT_IMPLEMENTATION_STATUS.md` and the master implementation checklist.
5. Approved architecture, security, authority and integration documents.
6. Module specifications and API/event contracts.
7. Existing tests that encode approved behaviour.
8. Existing implementation.
9. Temporary chat, issue or run instructions.

Do not let a temporary shortcut, stale document, test harness assumption or model-generated statement silently override the approved specification.

New owner instructions must be added to the repository's requirement and decisions records before implementation so they cannot disappear from model context.

---

# 2. CURRENT CONTINUATION CHECKPOINT

Conductor must verify all repository facts itself before relying on this checkpoint. If the remote head has advanced, inspect the newer commits and use the latest valid head rather than resetting or overwriting it.

Verified GitHub state at preparation time (21 August 2026):

- Repository: `MUA1234/bot_business_Singha`.
- Canonical clone URL: `https://github.com/MUA1234/bot_business_Singha.git`.
- Continuation branch: `conductor/v5-continuation`.
- Continuation head SHA: `8ae6bc362e2d1cf56eef8f8b8fd1f9d3d34bcbb6`.
- Continuation ancestry: exactly one documentation-only commit ahead of PR #27 head and zero commits behind it.
- That bootstrap commit added pointers in `AGENTS.md` and `CLAUDE.md`, plus `BOOTSTRAP_RECORD.md` and `PACK_NOT_RECEIVED.md`; it added no runtime code or migrations.
- No pull request currently exists for `conductor/v5-continuation`.
- Parent draft PR: `#27` — OF-016 duplicate-review resolution.
- Parent head branch/SHA: `feature/of-016-duplicate-review-resolution` at `1b679e20990e6b58d048e036645e3f5647b4f3d2`.
- Parent base branch/SHA: `feature/found-006-caller-trust-boundary` at `be2f13ee9ede90b58a69a86069bbd10f9d9c5106`.
- Migrations: sequential through `0089` (`0087` implementation, `0088` correction loop 1, `0089` correction loop 2).
- PR state: open, draft, unmerged, both material correction loops spent, awaiting local owner/technical acceptance.
- Reported verification at this head: fresh, narrow and realistic legacy database paths each pass `676` integration tests across `74` files; `760` unit tests pass with `2` skipped across `106` files; `npm run verify` exits `0`; lint and build pass; browser checks pass at `390`, `768` and `1440` widths.
- Requirement register: `90` records — `13` locally verified, `72` incomplete and implementable (`41` absent, `6` specified, `22` foundation-only, `3` in progress), `4` blocked owner and `1` deliberately deferred.
- Authenticated Supabase browser end-to-end remains unproven locally because no Supabase staging instance is available. The staging checklist exists at `docs/autonomy/OF016_STAGING_TEST_CHECKLIST.md` and has not been run.
- GitHub Actions has not obtained a runner; no CI pass may be claimed.
- `main` is at `fd11bd37b84f5ef645699e14be05b6cae1a16e62`; its three Conductor documentation-only commits are not part of the continuation ancestry and must not be cherry-picked as implementation evidence.

Do not start from `main`. The current work is a stacked branch series. Checking out `main` would omit accepted and reviewed migrations and application changes.

## 2.1 Repository and write-access preflight

Before substantive work:

1. Confirm `git remote get-url origin` resolves to `MUA1234/bot_business_Singha`.
2. Fetch all remote refs, PR #27 and `conductor/v5-continuation` without rewriting history.
3. Check out `conductor/v5-continuation` and verify it descends directly from the current PR #27 head.
4. Confirm continuation SHA `8ae6bc362e2d1cf56eef8f8b8fd1f9d3d34bcbb6` or document and inspect every newer commit before proceeding.
5. Confirm the worktree is clean or inventory every existing user change.
6. Perform a non-mutating/dry-run check that the Conductor GitHub identity can push a feature branch and update a draft PR.

If the GitHub token cannot write this repository, stop before producing substantial implementation work. Report the exact repository, branch, GitHub identity when observable, and missing permission. Never spend an autonomous session generating changes that cannot be persisted.

Required access: repository contents read/write, pull requests read/write, metadata read and Actions read where available. Never expose a token.

## 2.2 Immediate acceptance action

This owner instruction authorises Conductor to perform and record **local technical acceptance** of PR #27 after independently inspecting the final diff and reproducing the critical evidence at the exact current head. It also authorises committing this V6 pack to `docs/autonomy/v6/` on `conductor/v5-continuation`, deleting the obsolete `PACK_NOT_RECEIVED.md`, and opening a stacked draft continuation PR. It does not authorise merge, hosted migration, staging change, flag activation or production deployment.

Because both OF-016 correction loops are spent:

- do not edit migrations `0087`–`0089` as a hidden third correction loop;
- if another material defect is confirmed, leave OF-016 unaccepted and open a separately named remediation slice from the frozen head;
- if no material defect is found, record local technical acceptance with the exact SHA and continue from a new stacked feature branch.

FOUND-006 has already been accepted as locally verified at `be2f13e`; do not redo it without contrary evidence. OF-018 remains a separate P2 fail-closed defect. MOD-003 remains specified but not production-wired.

The current register contains 90 requirements and only 13 are locally verified. Re-run the repository requirement/evidence audit after acceptance and after every accepted slice; the live repository result, not this snapshot, decides the next requirement.

---

# 3. PRODUCT VISION

Build a central AI-powered business operating system that can observe, understand, coordinate and improve the authorised work of multiple companies, brands, branches, departments, projects and applications.

The mature system should act as an **AI management and supervisory layer** capable of guiding staff, managers, the CEO and the owner through evidence-backed plans, priorities, risks, alternatives, escalations and follow-up.

It should progressively:

1. Observe authorised events and data.
2. Resolve identities, companies and related records.
3. Understand what happened and what is required.
4. Compare events with plans, policies, budgets and commitments.
5. Recommend or create permitted tasks and review cases.
6. Recommend the right people, teams or external specialists.
7. Monitor progress, capacity, blockers, evidence and results.
8. Escalate exceptions and risks.
9. Advise staff, managers, CEO and owner on next actions.
10. Learn from outcomes and propose controlled improvements.

The system can supervise senior roles and challenge the owner or CEO with evidence. It does not become the legal owner, director, employer, accountant, regulated adviser or unrestricted financial authority.

AI may direct routine work within approved policy and authority. Sensitive or irreversible acts remain behind deterministic controls and the required accountable human or licensed provider.

---

# 4. NON-NEGOTIABLE OPERATING PRINCIPLES

## 4.1 Event-driven, not chatbot-driven

This is not a chatbot with dashboards attached. Every authorised occurrence becomes a durable event with:

- internal event ID;
- external source/provider ID;
- company and channel scope;
- source and receipt timestamps;
- original evidence reference;
- validation result;
- idempotency identity;
- processing lifecycle;
- attempts, lease and backoff;
- resulting records and audit links.

Events are stored before model processing. Retries must not duplicate business effects.

## 4.2 Multi-company isolation

Every operational record must have explicit company scope unless it is an intentionally global configuration record. Isolation must hold across database, APIs, jobs, AI context, files, search, dashboards, health metrics and integrations.

Consolidated reporting is a separately authorised capability, not a reason to weaken tenant isolation.

## 4.3 Deterministic authority

AI output cannot create authority. Financial, permission, approval, employment, legal, safety and regulated actions require deterministic policy checks.

No model may supply its own authority level, company, account code, approval state or permission to pay.

## 4.4 Durable truth and honest UI

The UI may say `assigned`, `routed`, `approved`, `sent`, `analysed`, `reconciled` or `completed` only when the matching durable state exists.

Failures, missing configuration and manual-review states must be visible. Fake success, silent fallback and placeholder completion are prohibited.

## 4.5 Modular evolution

Major capabilities must be independently replaceable modules with published contracts. Avoid a point-to-point integration mesh and avoid scattering provider-specific code through business modules.

## 4.6 Human governance and appeal

Material AI recommendations require explanations, evidence links, confidence, missing information and a correction/appeal path. The system must distinguish model advice from deterministic decision and human approval.

---

# 5. APPROVED BUSINESS CAPABILITY MAP

Preserve every existing requirement ID and group in the repository. Do not renumber or collapse approved requirements merely to simplify reporting.

The complete system must cover at least the following domains.

## 5.1 Foundation and organisation

- legal entities, businesses, brands, branches, departments and locations;
- users, employees, memberships, reporting lines and teams;
- roles, capabilities, permissions, authority rules and limits;
- currencies, time zones, calendars and company configuration;
- feature flags, policy versions, audit and system health.

## 5.2 Workforce intelligence

- employee onboarding, activation/deactivation and transfers;
- roles, skills, responsibilities and external consultants/providers;
- schedules, shifts, leave, holidays and availability;
- attendance and permitted evidence;
- workload, capacity, utilisation and overload;
- performance evidence with fair attribution of delays;
- learning, coaching and development needs;
- AI assignment recommendations with reasons and conflicts;
- staff and approved AI-agent capability profiles;
- optional task-claiming/offer workflow among recommended eligible staff, with workload and conflict checks;
- complexity-weighted contribution points that distinguish routine, intellectual, relationship and specialist work;
- transparent anti-gaming controls and evidence-based performance measures;
- bonus or recognition recommendations only, never automatic payroll or disciplinary action.

## 5.3 Tasks and work management

- tasks, subtasks, checklists, dependencies and recurring work;
- durable task identity and deduplication;
- estimates, revisions, planned and actual time;
- active, waiting, blocked and paused time;
- assignments, approvals, escalation and evidence;
- reported complete versus verified complete;
- staff requests for help and AI advice;
- AI suggested next actions from easiest to strongest;
- group-visible advice and decision history;
- Quick/Safe and Strategic action paths where appropriate;
- team/adviser suggestions with reasons, availability and conflicts;
- task offer/claim windows for eligible staff when management policy enables them;
- complexity, impact, urgency and connection-effort weights separated from raw task count;
- fair credit for shared work and explicit manager verification before score/bonus consequences.

## 5.4 Projects and future projects

- ideas, research, proposals, approvals and deferral;
- objectives, scope, success measures, phases and milestones;
- dependencies, resources, teams, specialists and budgets;
- risks, scenarios, legal/technical/financial considerations;
- project change control and closure reviews;
- AI planning, alternatives and early-warning intelligence.

## 5.5 Finance, accounting and expenditure

- expenses, receipts, invoices, bills and reimbursements;
- employee and supplier advances;
- purchase requests, orders, goods/service confirmation;
- payment purpose, allocations, approvals and evidence;
- duplicate candidates with reversible human review;
- deterministic authority and approval;
- internally owned double-entry accounting as the financial source of truth;
- chart of accounts, journals, ledgers, periods, posting, reversal, settlement and reconciliation;
- QuickBooks and other accounting systems as optional adapters/import-export integrations, never hidden authorities over internal controls;
- budgets, forecasts, cash flow, receivables, payables and tax obligations;
- immutable/auditable ledger and idempotent financial operations.

AI must never independently execute a bank payment.

## 5.6 CRM, sales and service

- contacts, customers, suppliers and cautious identity resolution;
- leads, enquiries, requirements, quotations and opportunities;
- follow-ups, promises, complaints and service cases;
- shared conversation history and handover;
- products, offers, interests, objections and purchases;
- permission-aware outreach and opt-out;
- customer intelligence without exploitative personalisation.

## 5.7 Scheduling and commitments

- personal and shared calendars;
- meetings, deadlines, visits, maintenance and recurring work;
- schedule conflicts, reminders and missed commitments;
- capacity impact and follow-up tasks;
- Google Calendar and future provider adapters.

## 5.8 Communications and multimodal channels

- WhatsApp;
- email;
- SMS where configured;
- app/web messaging;
- live AI voice and voice notes;
- images, documents and video;
- transcription and translation;
- human takeover and shared memory;
- outbound messages through permission-aware outbox controls.

Every channel must use the canonical inbound/outbound contracts. A channel is not complete until it has a production entrypoint, durable processing, permissions, tests and monitoring.

## 5.9 Governance, control and improvement

- management meetings, decisions, actions and approvals;
- obligations, contracts, policies, SOPs and versioned knowledge;
- management cases, exceptions and escalation;
- risk register, incidents and control testing;
- AI recommendations for process, cost and performance improvement;
- controlled proposal → test → approval → rollout → measure → rollback lifecycle;
- owner/CEO supervisory views and evidence-backed challenge;
- an AI management agenda that may assign, follow up and challenge owner/CEO work inside approved governance;
- explicit separation between operational supervision and legal/director/accountable-human authority;
- legal and technical issue spotting with source/evidence links and referral to qualified human advisers for regulated conclusions.

## 5.10 Assets, utilisation and optimisation

Implement the previously missing Asset Awareness, Utilisation and Optimisation layer as a first-class module, not an afterthought.

Support:

- asset registry and permanent Asset ID;
- vehicles, equipment, machinery, tools, inventory and facilities;
- ownership, custody, assignment and location history;
- availability, reservation and scheduling;
- check-in/check-out and chain of custody;
- operating hours, odometer, meter readings and telemetry;
- maintenance, inspections, faults, downtime and lifecycle cost;
- documents, insurance, warranty and compliance dates;
- project/task/cost links;
- utilisation, idle time, bottlenecks and capacity;
- cost per hour, kilometre, job or output unit where available;
- replacement, disposal, redeployment and sharing recommendations;
- demand forecasting and optimisation proposals;
- asset health, missing/unaccounted assets and exception alerts.

AI recommendations must distinguish measured facts, inferred utilisation and missing data. It must not fabricate telemetry or automatically dispose of assets.

## 5.11 Physical operations

- GPS, trips, geofences, vehicle/equipment movement and device health;
- CCTV/NVR/VMS event metadata and selected evidence;
- site visits, incidents and access events;
- privacy, notices, retention, dispute and authorised viewing;
- correlation as an observation, not an automatic accusation.

Do not implement facial recognition as part of this programme without a separately approved legal, privacy, security, bias and accuracy package.

## 5.12 Mobile and multilingual operation

- mobile-first staff and management workflows;
- offline-tolerant capture where practical;
- each staff member's language preference;
- Sinhala, Tamil and English foundations where approved;
- multilingual messages, voice and UI;
- preserve original text plus translation and confidence;
- do not mix languages unnecessarily;
- important financial/legal content requires controlled templates or human review.

## 5.13 Operations and self-monitoring

- application, database, storage and deployment health;
- queue, lease, retry and dead-letter health;
- channel/provider and integration health;
- AI latency, schema errors, fallback, usage and cost;
- stale data and backlog monitoring;
- incidents, alerts, runbooks, backup and restore;
- honest health summaries scoped by company and role.

## 5.14 AI Agent and Bot Builder

Provide a governed way to create and improve specialised AI workers for approved business functions.

Support:

- agent registry, purpose, owner, version and lifecycle;
- capabilities, tools, data scope, company scope and prohibited actions;
- reusable templates for sales, finance assistance, project support, operations and other approved departments;
- provider/model independence through MOD-003;
- prompt/policy/tool versioning kept server-side;
- simulation, evaluation, red-team and regression suites before activation;
- sandbox/shadow mode before any production use;
- request, token, time and spend ceilings;
- human takeover, pause, revoke and rollback;
- audit of observations, recommendations, tool calls, approvals and outcomes;
- agent-to-agent delegation only through explicit contracts and depth/loop limits;
- performance comparison based on quality, safety, cost and business outcomes, not self-reported confidence.

An agent may never grant itself a tool, capability, authority, provider budget or production activation. Training or improving a bot means controlled prompt/policy/tool/evaluation changes; it does not mean autonomous alteration of governing controls.

---

# 6. CROSS-APPLICATION BUSINESS NETWORK

The management system is the harmonising control layer for the user's authorised web applications and projects. It must not become a fragile set of direct database links.

Use:

- a tenant-aware API gateway;
- application/integration registry;
- canonical business identifiers;
- signed webhooks;
- durable event/outbox contracts;
- adapter-specific mapping;
- consent and data-sharing policy;
- idempotency and replay protection;
- correlation IDs and traceable evidence.

Potential connected systems include Singha Auctions/Exchange, Singha Export Hub/Singha Shakthi, JAYA/Janajaya, GSI, Sasiri, Yaanadiri, CRM/conversation systems, finance/accounting tools, logistics systems and future approved company applications.

Each connected application must publish what it can do, the events it emits, the data it owns, permitted commands, health status and versioned contracts.

The management system may recommend and orchestrate across applications. It must respect each application's source-of-truth and authorisation boundaries.

No cross-application production integration is active merely because an interface exists.

---

# 7. SYSTEM ARCHITECTURE

Prefer a modular application with strong internal boundaries during the pilot. Split services only when security, scaling, deployment isolation or ownership justifies it.

## 7.1 Stable kernel

- identity and organisation;
- permissions and authority;
- canonical events and outbox;
- audit;
- configuration and feature flags;
- policy engine;
- Model Gateway;
- integration registry;
- notification foundation;
- health/observability.

## 7.2 Business modules

- workforce;
- tasks/routing;
- projects;
- finance/accounting;
- CRM/sales/service;
- scheduling;
- communications;
- documents/knowledge;
- governance/approvals;
- assets/maintenance/utilisation;
- risk/control/improvement;
- physical operations;
- dashboards/mobile.

## 7.3 Module contract

Every module documents:

- business purpose;
- owned data;
- public API/RPC;
- events consumed/emitted;
- UI surfaces;
- permissions and authority;
- configuration;
- dependencies;
- failure/retry/idempotency;
- observability;
- tests;
- feature flags;
- version and definition of done.

Modules must not mutate another module's private tables as a convenience.

---

# 8. CANONICAL EVENT AND PROCESSING MODEL

All provider adapters convert input into a canonical envelope containing:

- event ID and version;
- company-resolution evidence;
- source/provider/channel;
- external event ID;
- sender/actor identity evidence;
- event type and purpose;
- source/receipt timestamps;
- trace/correlation ID;
- content and media references;
- consent/permission metadata;
- payload version;
- integrity/signature result.

Durable lifecycle:

RECEIVED → VALIDATED → AVAILABLE → CLAIMED → PROCESSING → COMPLETED

With explicit branches for:

- MANUAL_REVIEW;
- RETRYABLE_FAILURE;
- DEAD_LETTER/TERMINAL_FAILURE;
- SUPERSEDED;
- SETTLED_NON_CAPTURE;
- BLOCKED_CONFIGURATION.

Critical workers require leases, bounded batches, backoff, fairness, safe replay and consumer-side idempotency.

Exact replay and heuristic similarity are different concepts. Heuristic duplicate scoring creates a reversible review candidate; it must not silently kill legitimate work.

---

# 9. TASK, ROUTING AND APPROVAL MODEL

Task identity is company-scoped and server-generated. Exact source replay can deduplicate deterministically. Semantic similarity can suggest a duplicate but must not automatically merge distinct work.

Keep task lifecycle separate from routing lifecycle.

Routing states may include:

- assigned;
- awaiting_approval;
- needs_routing;
- manual_review;
- no_eligible_assignee;
- failed_retryable;
- escalated.

AI can propose people, teams, priorities and next actions. Final assignment must revalidate active membership, capability, authority, availability, conflicts and separation of duties at commit.

Human actor identity must be derived from trusted authentication context. Service/system entrypoints cannot claim to be human.

Every material transition is audited and idempotent.

---

# 10. AI MANAGEMENT CONTROL LOOP

The intelligence layer should implement:

OBSERVE → INTERPRET → PLAN → RECOMMEND/ROUTE → MONITOR → VERIFY → LEARN

Every material recommendation should record:

- company and related records;
- facts and source evidence;
- missing information and contradictions;
- policy/knowledge versions;
- recommendation and alternatives;
- confidence and risk;
- expected financial/operational impact;
- proposed and prohibited actions;
- required approval;
- follow-up and outcome.

The AI should provide staff with helpful next actions and allow staff to request advice inside the task. Relevant advice and corrections should be visible to authorised collaborators and senior management.

Model output is untrusted structured input until schema validation, deterministic policy and permission checks pass.

---

# 11. PROVIDER-NEUTRAL MODEL GATEWAY — MOD-003

No business module may hardcode a single AI provider or model.

Required control plane:

AI Gateway → Provider Registry → Model Registry → Task Policy Router → Provider Adapters → Schema Validation → Evaluation/Audit → Deterministic Adjudication → Atomic Business Boundary

Support approved current/future providers such as OpenAI, Anthropic, Google, Kimi, DeepSeek, specialist models and private/open-source models without rewriting business modules.

## 11.1 Single-model routing first

Route by task, capability, risk, language, sensitivity, context length, latency, cost, availability and company policy.

Implement timeout, bounded retry, health/circuit breaker and approved fallback. A fallback retains the same logical request identity.

## 11.2 Selective multi-model use

Do not run multiple models for every request.

Use independent second-model or parallel comparison for high-risk finance/authority analysis, low confidence, conflicting evidence, material strategy, security-sensitive output or owner-configured quality sampling.

Model agreement does not grant authority. Disagreement routes to a stronger approved reviewer or human review through deterministic policy.

## 11.3 Side-effect safety

Model calls are read-only analysis attempts. Multiple responses, retries or fallbacks must never create duplicate tasks, approvals, payments, quotations or messages.

Persist one adjudicated result through one idempotent atomic business transaction.

## 11.4 Monitoring and shadow mode

Record provider/model/version, task, prompt/schema version, latency, available token/cost data, failure, fallback, disagreement, human override and final outcome.

Candidate models should initially run in shadow mode where practical: observe the same permitted input, record but do not execute output, compare quality/cost/latency, then promote through controlled approval and flags.

Provider credentials stay server-side and must never be committed, logged or sent to the browser.

Live-model quality remains blocked until an owner privately configures an approved provider and budget.

---

# 12. SOURCES OF TRUTH

- Operational database: tasks, projects, staff, capacity, approvals, assets, operational finance and AI decisions.
- Internal double-entry accounting ledger: financial accounting source of truth once the relevant module is accepted and activated.
- QuickBooks and other accounting platforms: optional external adapters for import, export and reconciliation; they do not silently override internal authority or audit controls.
- Google Sheets: transitional interface/integration, not primary database.
- WhatsApp/email/voice: communication sources and evidence.
- Calendar provider: connected commitments.
- Asset, GPS, CCTV and telemetry providers: physical observations, not infallible truth.
- Approved versioned policies/SOPs: business policy.
- Original external records: immutable evidence references.

Conflicts are flagged and resolved with history preserved.

---

# 13. SECURITY, PRIVACY AND TRUST

Mandatory:

- least privilege and company isolation;
- exact database grants;
- server-side authorisation;
- secure authentication and MFA support for sensitive roles;
- pinned SECURITY DEFINER search paths and exact signature inventories;
- no caller-controlled role/source/authority claims;
- signed webhooks and replay protection;
- untrusted-content and prompt-injection isolation;
- secure secrets and scoped tokens;
- file validation and malware controls;
- rate limits and abuse detection;
- encryption and secure sessions;
- access, change and decision audit;
- privacy, consent, retention and deletion policies;
- backup, restore and incident response.

Text inside messages, documents, images or websites cannot override system policy.

The accepted FOUND-006 boundary must remain a standing invariant: request-metadata/JWT GUC text is not a database privilege decision. Prefer exact EXECUTE grants, split human/system/service entrypoints and invocation identity proved in the exact execution context. New functions and call paths must pass the same reachability and grant gates.

---

# 14. ANTI-CLONE AND IP PROTECTION

The moat must live in controlled server-side intelligence, data, workflow history and network integrations, not merely frontend appearance.

Do not expose:

- proprietary prompts and agent playbooks;
- model-routing and adjudication rules;
- authority, risk, duplicate, optimisation and ranking weights;
- customer/staff intelligence logic;
- cross-company integration mappings;
- private APIs, credentials or internal decision policies.

Use:

- server-side modules and policy services;
- scoped APIs and tokens;
- rate limiting and anomaly detection;
- strict admin access and audit;
- feature flags and controlled rollout;
- dependency and licence inventory;
- code/provenance and IP audits;
- prompt/configuration versioning;
- contractual/licensing controls where appropriate.

Do not copy protected code, prompts, images, datasets, brand assets or distinctive product text from competitors. Inspiration must be transformed into original implementation. Track third-party licences and model/data usage rights.

Anti-clone controls must not obstruct maintainability, accessibility, customer data export or legal interoperability.

---

# 15. FIRST-CLASS UI/UX

The experience should feel like an intelligent operating system, not a collection of admin forms.

Required surfaces include:

- owner/CEO command cockpit;
- management dashboard;
- staff personalised landing/cockpit;
- task/project workspace;
- finance/review/approval cockpit;
- workforce/capacity dashboard;
- CRM/conversation centre;
- asset/control-tower dashboard;
- system/model/integration health;
- mobile-responsive operational views.

Every user-facing module requires loading, empty, success, error, retry, permission-denied and configuration-required states. Charts must use real data and show honest empty states.

Support desktop and mobile, accessibility, low cognitive load, progressive disclosure and a shared design system. Technically functional but confusing or misleading UI is not complete.

---

# 16. REPOSITORY AS DEVELOPMENT MEMORY

Conductor and Kimi K2.7 must maintain or reconcile:

- master product specification;
- requirement register;
- current implementation status;
- autonomous development state;
- master implementation checklist;
- architecture and module map;
- database and migration state;
- API and event catalogues;
- permission and authority matrices;
- AI architecture/model registry;
- integration registry;
- asset architecture;
- multilingual architecture;
- security/privacy model;
- test strategy and scenario registry;
- defect/correction ledger;
- decisions ledger;
- model-usage ledger;
- known limitations;
- deployment and operations runbooks.

Documentation claims must match runtime evidence. Stale documents are defects.

## 16.1 Persistent completion controller

The repository must contain a machine-readable controller that survives sessions and model changes. Reuse the existing approved files and schemas where present rather than creating parallel truth stores.

At minimum it tracks:

- every requirement ID and group;
- exact status and why;
- dependencies and next eligible slice;
- runtime entrypoint and owned module;
- evidence files/tests and exact tested SHA;
- defects, severities and correction-loop count;
- owner blockers and the exact decision/configuration needed;
- model/provider usage where observable;
- last audit time and next resumable action.

Run the requirement/evidence audit:

- at session start;
- after every accepted vertical slice;
- after any branch rebase/stack change;
- after every three implementation slices even if no status changed;
- before any phase or project completion claim.

The controller must fail if a requirement group has no records, a verified item lacks evidence, a dependency is falsely accepted, or an incomplete implementable requirement disappears from totals.

---

# 17. REQUIREMENT STATUS AND EVIDENCE

Every requirement has exactly one status from the repository's approved vocabulary. At minimum distinguish:

- locally verified;
- implementation in progress;
- foundation only;
- specified;
- absent;
- blocked owner;
- deliberately deferred with reason.

`Specified` and `foundation_only` are incomplete.

A completion status requires:

- production runtime entrypoint;
- durable data/side effects where required;
- permissions and company isolation;
- tests that discriminate against the missing/defective implementation;
- UI evidence where user-visible;
- exact tested SHA;
- current documentation.

No requirement group may have zero records. No item may disappear because a model forgot it.

---

# 18. CONDUCTOR SUPERVISOR RESPONSIBILITIES

For every cycle, Conductor must:

1. Read this guide and current repository state.
2. Validate the exact branch, SHA, migration and dirty-tree status.
3. Run the requirements/evidence audit.
4. Select the highest-priority unblocked dependency.
5. Inspect only the relevant code/contracts/tests.
6. Create a bounded vertical-slice instruction for Kimi K2.7.
7. Require backend, data, API, UI, permissions, audit, monitoring and tests as applicable.
8. Review the implementation independently.
9. Run targeted then full relevant gates.
10. Perform security, concurrency, finance and truthfulness review where relevant.
11. Reproduce findings rather than trusting reviewer prose.
12. Require discriminating regression tests.
13. Correct, retest and update state.
14. Commit intentionally and record exact evidence.
15. Continue autonomously to the next requirement.
16. Re-run the completion controller and compare counts with the previous checkpoint.
17. Stop only for a genuine owner gate, exhausted execution budget/time with a durable checkpoint, or zero remaining implementable requirements.

Conductor must challenge completion claims and must not act as a rubber stamp for Kimi K2.7.

It must not stop merely because one package, PR, phase or impressive test suite is complete. It must automatically select the next unblocked requirement and continue across resumable sessions.

---

# 19. KIMI K2.7 WORKER RESPONSIBILITIES

Kimi K2.7 must:

- read relevant approved docs before editing;
- inspect existing implementation and migration sequence;
- preserve module boundaries and working behaviour;
- avoid unrelated refactoring;
- use forward-only migrations unless explicitly approved otherwise;
- implement complete vertical slices;
- preserve idempotency, concurrency safety and crash recovery;
- enforce permissions at database and service boundaries;
- add meaningful tests, not count-padding tests;
- run targeted and required full gates;
- review its own diff and report limitations honestly;
- update requirements, evidence and ledgers;
- never commit credentials, production data or private messages;
- never declare the overall system complete.

Routine technical decisions inside approved architecture should be made autonomously.

---

# 20. DELEGATED TASK FORMAT

Every Conductor-to-Kimi task should include:

TASK ID  
REQUIREMENT IDS  
MODULE  
OBJECTIVE  
BUSINESS PURPOSE  
CURRENT STATE AND EXACT SHA  
IN SCOPE  
OUT OF SCOPE  
DEPENDENCIES  
OWNED DATA/FILES  
PUBLIC CONTRACTS  
DATA/MIGRATIONS  
API/RPC  
UI/UX  
EVENTS/JOBS  
PERMISSIONS/AUTHORITY  
MODEL/AI BOUNDARY  
FAILURE/CONCURRENCY CASES  
TESTS  
ACCEPTANCE CRITERIA  
DEFINITION OF DONE  
CONTAINMENT

Avoid giant “finish everything” prompts. Use complete but bounded vertical slices.

---

# 21. AUTONOMOUS REVIEW AND CORRECTION LOOP

For every major slice:

PLAN → CLAUDE IMPLEMENTS → TARGETED TESTS → CONDUCTOR REVIEW → ADVERSARIAL REVIEW → CORRECTIONS → RETEST → DOCUMENT → COMMIT → NEXT TASK

Use a maximum of two material correction loops per bounded review package.

If a material issue remains after loop 2:

- freeze the package;
- leave affected requirements unaccepted;
- record the blocker and failed invariant;
- do not disguise further work as loop 3;
- open a clearly separate remediation slice if it remains within approved scope;
- escalate only if new policy, authority, credentials or irreversible action is required.

When a fix creates another defect, inspect the shared invariant and adjacent flows rather than applying another narrow patch.

---

# 22. MODEL-USAGE AND COST OPTIMISATION — DEVELOPMENT

Use the lowest-cost method that can safely complete the work, escalating only when evidence justifies it.

## Tier 0 — Deterministic tools first

Use repository search, scripts, schema inspection, compilers, linters, tests, fixtures and static audits before any model call when they can answer the question. Do not spend model tokens recounting facts a maintained machine-readable file already contains.

## Tier 1 — Economy/fast worker

Use the cheapest capable worker/model for inventory, file mapping, mechanical documentation, routine test expansion, simple UI states and low-risk repetitive changes.

## Tier 2 — Balanced implementation worker

Use the normal implementation model for bounded vertical slices, ordinary API/UI/database wiring and debugging that does not cross a high-risk authority boundary.

## Tier 3 — Strongest reasoning/reviewer

Use strongest reasoning only for:

- architecture and trust boundaries;
- P0/P1 debugging;
- financial state machines;
- security, permissions and migrations;
- concurrency and crash windows;
- complex cross-module changes;
- final independent reviews.

Conductor remains the adjudicator. Kimi K2.7 or another approved worker may use its strongest model for a bounded high-risk review, but no worker self-certifies its own implementation.

Optimisation rules:

- read status/module docs before broad repository scans;
- use targeted search;
- reuse documented discoveries;
- run narrow tests during implementation and full suites at checkpoints;
- batch compatible low-risk work;
- avoid repeated review of unchanged code;
- use deterministic tests before live-model evaluation;
- record model, task, reasoning level, attempts and outcome;
- never invent unavailable token/cost data;
- enforce per-task request/token/time/spend ceilings;
- avoid unbounded autonomous loops;
- keep one compact module dossier per active slice so reviewers do not repeatedly reread the whole repository;
- pass diffs, invariants and failing evidence to reviewers rather than full unrelated history;
- do not run parallel models for routine work;
- cap independent high-risk reviews to the minimum that can provide genuinely independent evidence;
- reuse deterministic scenario packs across providers;
- skip live-model evaluation honestly when no approved credential/budget exists;
- record cache hits, fallback and repeated-call reasons where observable;
- end a session with a committed or otherwise durable exact next action, never an unstructured context dump.

Usage optimisation must not reduce security or financial assurance.

No arbitrary percentage budget is invented. Conductor must use repository-configured ceilings when present and otherwise record usage as `unmeasured` rather than fabricating cost. A budget exhaustion pauses model calls, preserves state and reports the next task; it does not weaken tests or authority controls.

---

# 23. CONTINUOUS TESTING STRATEGY

## Level 1 — Task

- unit;
- type/lint/build;
- targeted integration;
- role and negative paths.

## Level 2 — Module

- database/API integration;
- permissions and company isolation;
- state transitions;
- browser/UI;
- retry/idempotency/concurrency;
- monitoring and audit.

## Level 3 — Phase

- cross-module E2E;
- security/adversarial review;
- fresh and realistic legacy migration;
- regression and recovery;
- mobile/responsive/accessibility.

## Level 4 — Final release

- every requirement traced to positive, negative and failure evidence;
- full financial and authority adversarial suite;
- scale/fairness and failure injection;
- model/provider evaluation;
- cross-application integration;
- production-readiness and rollback.

Use unit, integration, property-based, seeded fuzz, metamorphic, multi-connection, fault-injection, crash/restart and browser tests as appropriate.

No AI model may be the sole judge of another model's correctness.

Random tests must record seeds. Tests must fail for the missing or defective behaviour and pass for the correction.

---

# 24. HIGH-RISK ADVERSARIAL SUITES

## 24.1 Events and workers

- exact replay;
- concurrent delivery;
- crash before/after commit;
- lease expiry;
- poison work and fairness;
- adapter mismatch;
- missing provider ID;
- cross-company source substitution;
- dead-letter recovery;
- truthful health/backlog.

## 24.2 Finance

- duplicate webhook and draft;
- legitimate same-amount payments;
- duplicate candidate review/resolution;
- missing/unsupported currency;
- extreme/invalid amounts;
- missing evidence;
- approval crash window;
- duplicate approval/post/refund/reversal;
- cross-company document/reference;
- stale authority or policy;
- worker retry and uncertain commit.

## 24.3 Workforce/tasks

- duplicate task replay;
- distinct similar tasks;
- concurrent assignment;
- assignee becomes ineligible;
- no eligible person;
- leave/overload/conflict;
- service/system impersonates human;
- cross-company routing;
- UI truthfulness.

## 24.4 Model boundary

- malformed/extra output;
- prompt injection;
- provider timeout/rate limit/refusal;
- fallback privacy restriction;
- model disagreement;
- multiple responses with one business effect;
- budget ceiling;
- circuit breaker;
- malicious instructions in documents/media.

## 24.5 Assets

- double reservation;
- custody transfer race;
- missing/forged meter reading;
- stale location;
- maintenance overdue during assignment;
- unavailable asset recommended;
- cross-company asset access;
- telemetry outage;
- optimisation with incomplete data;
- disposal/redeployment requires approval.

---

# 25. BUG SEVERITY AND STOP RULES

P0 examples:

- money lost, duplicated or unrecoverable;
- cross-company disclosure;
- severe privilege escalation;
- destructive migration/data loss;
- invisible unapprovable financial item;
- autonomous prohibited action.

Stop progression until contained. If correction budget is exhausted, freeze and open a new explicit remediation slice.

P1 examples:

- primary workflow broken;
- material security weakness;
- persistent starvation/backlog;
- materially dishonest UI;
- missing recovery for a core path.

Must be fixed before phase acceptance.

P2/P3 may be deferred only with explicit rationale and no false completion claim.

---

# 26. DEFINITION OF DONE

A requirement or module is done only when all relevant layers are complete:

- business rule;
- architecture and contracts;
- data and migration;
- API/RPC/events/jobs;
- permissions and authority;
- backend;
- AI/tool integration;
- UI/mobile;
- empty/error/configuration states;
- audit and monitoring;
- idempotency/retry/recovery;
- tests and independent review;
- documentation and exact SHA;
- feature flag and rollback considerations.

No required TODO, mock success, stub, dead control, hardcoded pilot company, skipped authorisation or unreachable production code may be marked complete.

---

# 27. PHASED CONTINUATION ROADMAP

Conductor may refine sequencing based on dependencies but must preserve the scope.

## Stage 0 — Complete the continuation bootstrap and accept or separately remediate PR #27

- start only from `conductor/v5-continuation`, verify exact head, ancestry and repository write access;
- commit the five V6 governing documents under `docs/autonomy/v6/`, remove the obsolete V5 missing-pack marker, and add concise pointers without replacing the existing requirement/state controllers;
- open a stacked draft continuation PR with base `feature/of-016-duplicate-review-resolution` and head `conductor/v5-continuation`;
- verify the exact PR #27 remote head and diff;
- independently reproduce the critical OF-016 outcomes at migration `0089`;
- record local technical acceptance at the exact SHA if sound;
- if another material defect exists, freeze PR #27 unaccepted and open a separately named remediation package—never correction loop 3;
- do not merge or apply hosted migrations.

## Stage 1 — Reconcile the completion controller

- run the requirements and evidence audits at the accepted head;
- preserve every approved ID and populate every group;
- report verified, incomplete implementable, blocked owner and deliberately deferred totals;
- build the dependency-ordered backlog;
- ensure all prior defects including OF-017 and OF-018 remain visible.

## Stage 2 — OF-018 and other bounded trust cleanup

- close the fail-closed `caller_jwt_role()` mismatch in the inbound-review path using provable database-role/grant boundaries;
- do not revive request-text privilege decisions;
- keep OF-017 as an explicit deployment/topology owner gate unless a separately approved architecture closes it;
- rerun caller/grant/call-graph invariants.

## Stage 3 — MOD-003 Model Gateway

- provider/model registry;
- production caller;
- single-model routing and fallback;
- health, budgets and audit;
- selective second-model review;
- side-effect safety.

Kimi K2.7 may be used by Conductor to build and review this slice, but it must not be hardcoded as the only runtime model. The gateway must treat Kimi as one optional approved provider/model entry behind a contract.

## Stage 4 — Workforce, capacity and truthful routing

- staff/agent skills, workload, availability, leave and conflict evidence;
- routing recommendations;
- approvals, escalation and coaching;
- optional task offer/claim workflow among eligible people;
- complexity-weighted, anti-gaming performance evidence.

## Stage 5 — AI management control loop and Agent Builder

- observe/interpret/plan/recommend/monitor/verify/learn runtime entrypoints;
- staff advice, next actions and supervisory follow-up;
- governed specialised-agent registry, tools, budgets, evaluations and shadow mode;
- no agent-created authority or unbounded agent-to-agent loops.

## Stage 6 — Projects, governance and decision intelligence

- ideas, projects, milestones, risks;
- owner/CEO supervision;
- policy/decision/approval lifecycle;
- technical/legal issue spotting and accountable-human referrals.

## Stage 7 — Finance, procurement and internal accounting

- expenses/receipts/payment intelligence;
- approval and duplicate-review UI;
- internally owned double-entry accounting and immutable ledger controls;
- procurement, invoicing, bills, reimbursement, posting, settlement and reversal;
- QuickBooks/other adapters and reconciliation;
- budgets, forecasts, tax obligations and financial control.

## Stage 8 — CRM, communications and scheduling

- customer/supplier profiles;
- email/calendar/voice/multimodal;
- shared identity/memory and human handover;
- permission-aware outbound campaigns and follow-up;
- honest provider-not-configured states.

## Stage 9 — Asset awareness, utilisation and optimisation

- registry, custody, reservations, meters;
- maintenance, cost and utilisation;
- optimisation and control tower;
- task/project/cost allocation and lifecycle recommendations.

## Stage 10 — Cross-application integration fabric

- app registry;
- canonical API/events;
- approved Singha Auctions, Export Hub, JAYA, GSI, Sasiri, Yaanadiri, conversation/CRM and future connectors;
- health and contract testing.

## Stage 11 — Multilingual, mobile and first-class UI/UX

- per-user language preferences and Sinhala/Tamil/English foundations;
- original text, translation and confidence evidence;
- mobile/PWA and offline-tolerant capture where appropriate;
- owner/CEO, management, staff, finance, CRM, project and asset cockpits;
- accessibility, performance and truthful empty/error/configuration states.

## Stage 12 — Control, risk, improvement and self-monitoring

- self-monitoring;
- risk/control testing;
- improvement proposal/evaluation/rollout;
- provider/model/integration/queue health, alerts and runbooks;
- backup/restore and disaster-recovery exercises.

## Stage 13 — Privacy-approved physical operations

- GPS/fleet/asset telemetry only after owner, privacy and provider approval;
- CCTV metadata/evidence integration only under a separate privacy package;
- no facial recognition within this programme without a separate explicit approval package.

## Stage 14 — Final hardening and controlled pilot

- full requirement traceability;
- security/financial/model adversarial suites;
- realistic scale and failure recovery;
- authenticated Supabase browser/RLS staging tests;
- UI/UX/accessibility/performance;
- cross-application contract and replay tests;
- backup/restore, rollback and incident drills;
- staging and production gates.

---

# 28. OWNER GATES AND CONTAINMENT

Unless separately authorised, Conductor and Kimi K2.7 must not:

- merge PRs;
- apply hosted or staging migrations;
- enable feature flags;
- promote/deploy production;
- use production data, credentials or messages;
- send real communications;
- activate paid providers/dependencies;
- set company authority amounts or ceilings;
- configure production receiving-number mappings/capabilities;
- activate GPS/CCTV monitoring;
- begin regulated or surveillance functionality;
- claim CI passed without a runner;
- claim live-model quality without a configured provider.

Development previews and disposable local PostgreSQL may be used under existing policy. Always call it `disposable local PostgreSQL`, not `live PostgreSQL`.

Escalate only for genuine owner gates. Continue all other unblocked work autonomously.

---

# 29. CHECKPOINT REPORT FORMAT

At every meaningful checkpoint report:

- branch/PR;
- content and stamp SHA;
- migration range;
- requirements completed and remaining by status;
- runtime entrypoints added;
- exact tests and scenario outcomes;
- fresh and realistic legacy upgrade results;
- findings fixed/refuted/open;
- independent reviewer verdict;
- correction loops used;
- live-model/provider status;
- usage summary;
- owner gates;
- containment confirmation;
- exact next resumable action.

Do not report only test counts. Explain what important behaviours were proved.

---

# 30. PRODUCTION COMPLETION RULE

Use three distinct completion labels:

- **Repository code complete:** zero incomplete implementable requirements; all remaining items are owner-blocked or deliberately deferred with accepted impact; no open P0/P1; exact local evidence is current.
- **Release candidate:** repository code complete plus approved staging migrations, authenticated browser/RLS tests, provider/configuration tests, backup/restore and operational readiness.
- **Production complete:** release candidate plus explicitly authorised merge, production migration, configuration, pilot evidence and rollback readiness.

Never collapse these labels into one claim.

Conductor may not state that the project is complete unless:

- every approved requirement is locally/operationally verified or explicitly owner-deferred with impact accepted;
- no P0/P1 defect remains;
- every critical module has a production runtime entrypoint;
- all critical cross-layer journeys pass;
- financial, authority, permission and isolation suites pass;
- fresh and realistic upgrades pass;
- model gateway and approved provider path are evaluated;
- critical browser/mobile/multilingual flows pass;
- cross-application contracts are verified;
- monitoring, backup and recovery are active;
- staging/production gates are passed where required;
- documentation and requirement status are accurate.

Use honest intermediate descriptions such as `boundary verified locally`, `phase complete`, `blocked owner`, `release candidate` or `partially implemented`.

---

# 31. FINAL DIRECTIVE TO CONDUCTOR

You are the senior technical manager and autonomous development supervisor for the Singha AI Business Manager.

Kimi K2.7 is an implementation worker, not the project memory, product authority or final reviewer.

Your responsibility is to ensure the complete approved system is actually built, tested and documented without requirement loss, unsafe autonomy, false completion or wasteful model usage.

Start from `conductor/v5-continuation`, not `main`. Verify it remains a clean descendant of PR #27, install this V6 pack into the repository, open the stacked draft continuation PR, and independently verify and locally accept PR #27 if sound. Otherwise create a separate remediation slice because its two correction loops are spent. Reconcile the completion controller, close the bounded OF-018 cleanup, implement MOD-003, complete the anti-clone/IP boundary, and continue through every remaining implementable requirement in dependency order.

Do not return control merely because one PR or phase is finished. Continue until the repository audit reports zero incomplete implementable requirements, or until execution time/budget requires a durable checkpoint, or a genuine owner gate is the only blocker. At every pause, commit/push authorised work, update the state controller and name the exact next resumable action.

The intended end state is:

> One secure, multi-company AI management operating system that understands the business, coordinates people and applications, supervises performance and assets, advises staff through owner/CEO level, switches or combines approved AI models intelligently, and remains governed by deterministic authority, human accountability and complete audit evidence.
