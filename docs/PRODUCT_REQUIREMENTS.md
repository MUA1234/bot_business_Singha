# PRODUCT_REQUIREMENTS.md

**Status:** Phase 0 deliverable — for review. Derived from the master spec §1–§24.

## 1. Vision

A central, event-driven AI business operating system for a multi-company group.
It observes authorised business channels, turns every occurrence into a stored
event, decides what matters, creates and assigns work, requests estimates, monitors
progress, surfaces blockers and risks, recommends decisions, and alerts management —
while remaining under human authority for every sensitive action.

It is **not** a chatbot with screens, and **not** a replacement for authorised
management, accountants, lawyers or regulated decision-makers.

## 2. Product pillars (mature platform)

1. Multi-company organisation, isolation, roles, permissions, authority limits.
2. Event intake from all authorised channels; stored, deduped, idempotent, auditable.
3. Workforce, attendance, capacity.
4. Tasks with a validated lifecycle, estimates, evidence, verification.
5. Projects, ideas, milestones, AI planning.
6. AI decision engine + deterministic authority + human approval queue.
7. CRM and (later) customer-facing AI agents.
8. Procurement, expenses, receipts, payment intelligence.
9. QuickBooks integration (draft/read-only first) and finance intelligence.
10. Assets, vehicles, GPS, CCTV, site intelligence (gated, last).
11. Model gateway, knowledge/SOPs, Agent Builder (gated), evaluation, quality.
12. Observability, health, cost, security, audit, privacy.

## 3. Functional requirements — pilot (MoSCoW)

**Must**
- Multi-company schema with `company_id` on every table + RLS on every table.
- Auth with roles (management, employee, finance, admin).
- Event pipeline: `events` table, persist-then-enqueue, Inngest consumers,
  idempotency keys, dead-letter, replay-safe.
- Employees, roles, capacity, attendance (manual check-in; no GPS/CCTV).
- Tasks: full state machine (§10), assignment, estimates + revisions, evidence,
  verification (reported-complete ≠ verified).
- Projects + milestones + task linkage.
- Authority matrix as deterministic code; AI proposes → approval queue → human
  decides → immutable audit.
- WhatsApp staff updates via Meta Cloud API (webhook verify + signature, 24h window).
- Management / employee / finance dashboards (server-side data only).
- Expenses & receipts: upload to Supabase Storage, OCR + AI extraction (Inngest),
  human verification, duplicate detection.
- QuickBooks: OAuth, **drafts/read-only only**, sync tokens, reconciliation job.
- AI gateway: single module, Zod-validated outputs, prompt versioning, cost logging.
- Complete audit history; daily management summary.

**Should**
- Payment-purpose (source-and-use-of-funds) tracking with split allocations.
- Read-only financial intelligence (cash, payables, receipts due).
- Capacity forecasting (daily/weekly).

**Could**
- Gmail / Sheets / Calendar adapters (Phase 11).

**Won't (pilot) — GATED, build last / not at all in pilot**
- GPS, geofences, fleet.
- CCTV / access control / site surveillance.
- Facial recognition (never without separate legal/privacy/bias review).
- Customer-facing AI agents; Agent Builder; controlled self-learning.
- Multi-country / additional entities beyond the single pilot business.

## 4. Non-functional requirements

- **Isolation:** company A can never read company B via DB, service, API, job,
  AI-context or file-storage paths. Proven by tests that fail loudly.
- **Idempotency:** replaying any event twice yields exactly one downstream record.
- **Auditability:** every sensitive action writes an immutable audit row (who, what,
  before/after, source, approver, AI confidence).
- **Cost:** every dependency has a usable free tier; no Redis/Kafka/K8s/paid queue.
- **Ban-safety:** official Meta Cloud API only.
- **Human-in-the-loop:** AI never autonomously executes money, accounting posts,
  permission changes, employment actions, legal notices or surveillance actions.
- **Environments:** separate staging and production Supabase projects; never test
  financial/AI behaviour on production data.

## 5. Sources of truth (spec §5)

- Operational Postgres → tasks, projects, staff, capacity, approvals, operational
  payment records, AI decisions.
- QuickBooks → accounting truth.
- WhatsApp / email → communication + evidence.
- GPS / CCTV / access control → physical-event inputs, not infallible truth.
- Approved, versioned SOPs → business policy.
- Original external records are never silently overwritten; conflicts are flagged
  with history preserved.

## 6. Explicit non-goals

Not an accounting system of record (QuickBooks is). Not an autonomous CEO. Not a
surveillance/discipline tool. Not a customer chatbot (in pilot).
