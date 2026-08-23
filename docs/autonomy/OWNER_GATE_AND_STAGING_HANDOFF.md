# OWNER GATE AND STAGING HANDOFF

**Prepared:** 2026-08-24  
**Branch:** `kimi/found006-rls-cutover`  
**Head:** `5b65ba7`  
**Repository:** `MUA1234/bot_business_Singha`  
**Last green verification:** `5b65ba7` — MOB-003 acceptance, register correction and coverage-matrix regeneration complete.

This document is **documentation only**. No runtime code was changed in its preparation. It lists every requirement that is not yet `locally_verified`, the exact owner gate or blocker, the safest staging action, the acceptance tests that must pass after that action, the rollback procedure, and whether production remains prohibited.

---

## 1. Executive summary

- **60 of 90** requirements are `locally_verified` at head `5b65ba7`.
- **30 remain blocked or incomplete**: 7 owner/credential blocked, 1 deliberately deferred, 3 specified V3.1 contracts, 1 foundation-only, 1 implementation pending owner acceptance, and 17 absent/dependency-blocked.
- **No production pilot** is approved. OPS-008 (`Monitored production pilot`) is itself blocked_owner until every prior OPS gate is satisfied.
- **Do not merge `kimi/found006-rls-cutover` to `main` or deploy to production** without owner approval.

---

## 2. Per-requirement handoff table

| ID | Title | Status | Exact blocker | Owner decision / credential required | Safest staging action | Acceptance tests after action | Rollback procedure | Production prohibited? |
|---|---|---|---|---|---|---|---|---|
| FOUND-003 | Production-reachable staff and finance intake | `blocked_owner` | No model provider configured for finance classification | Supply model provider credential for finance classification; map each receiving WhatsApp number to its company in `channel_accounts`; grant `operations.inbound.review` to queue workers; apply hosted migration 0042–0068 | Configure provider key and channel account mapping in **staging only**; run inbound end-to-end with classification fixture first | `tests/integration/extreme-end-to-end.test.ts`, `tests/integration/inbound-end-to-end.test.ts`, `tests/integration/inbound-review-queue.test.ts`, `tests/campaign/inbound-routing.test.ts`, `tests/campaign/finance-intake.test.ts` | Disable provider key / remove channel mappings; restore staging DB from pre-migration backup | Yes — until hosted migration applied and queue staffed |
| AIM-003 | Truthful task routing | `implementation_in_progress` | Pending owner's acceptance of R1 review | Owner accepts R1; no code change required | Owner reviews R1 evidence; if accepted, update register status to `locally_verified`; keep V3.1 flags OFF | `tests/integration/task-routing.test.ts`, `tests/integration/routing-and-mapping-corrections.test.ts`, `tests/campaign/capture-routing.test.ts`, `tests/campaign/analyze-ui-truthfulness.test.ts` | Revert register status to `implementation_in_progress` if R1 acceptance is withdrawn | Yes — status remains unverified until owner accepts |
| AIM-004 | Task Intelligence Profile | `specified` | V3.1 flag-gated contract only | Activate `V3_1_TASK_DETECTION` flag (owner decision) | Keep flag OFF; do not build a producer until AIM-003 is verified and V3.1 approved | `tests/v3_1-contracts.test.ts` (contract shape only); no runtime tests yet | Toggle flag OFF; no runtime code to revert | Yes — contract only |
| AIM-005 | Decision-path ladder | `specified` | V3.1 flag-gated contract only | Activate `V3_1_DECISION_PATHS` flag (owner decision) | Keep flag OFF | `tests/v3_1-contracts.test.ts` | Toggle flag OFF | Yes — contract only |
| AIM-006 | Team formation and resource recommendation | `specified` | V3.1 flag-gated contract only | Activate `V3_1_TEAM_FORMATION` flag (owner decision) | Keep flag OFF; depends on AIM-004 | `tests/v3_1-contracts.test.ts` | Toggle flag OFF | Yes — contract only |
| AIM-008 | Outcome measurement and improvement loop | `absent` | Depends on AIM-003; no outcome column | Wait for AIM-003 owner acceptance, then design outcome model | No staging action until AIM-003 verified | N/A — not implemented | N/A | Yes — not built |
| AST-001 | Asset Intelligence | `specified` | Owner spec approval required | Approve `docs/specs/ASSET_INTELLIGENCE_SPEC.md` | Keep in `specified`; do not implement until spec approved | N/A — no code exists | N/A | Yes — not built |
| LNG-001 | Multilingual English / Sinhala / Tamil | `specified` | Owner spec approval required | Approve `docs/specs/MULTILINGUAL_SPEC.md` | Keep in `specified`; do not implement until spec approved | N/A — no code exists | N/A | Yes — not built |
| MOD-001 | Live-model evaluation path | `blocked_owner` | No provider key configured | Supply `ANTHROPIC_API_KEY` privately via local/staging secret configuration (never commit) | Add key to staging environment only; run evaluation harness | `tests/campaign/live-eval.test.ts` (currently skips without key) | Remove key from staging; tests skip safely | Yes — evaluation-only, no production path |
| GOV-004 | Board-reserved matters and emergency suspension | `absent` | Reserved-matter list undefined | Owner defines reserved-matter list and emergency suspension rules | No implementation until list defined | N/A — not implemented | N/A | Yes — not built |
| WRK-004 | Strengths, development needs and coaching | `absent` | Privacy review required | Owner approves private-vs-manager-visible coaching visibility model | No staging action until privacy review complete | N/A — not implemented | N/A | Yes — not built |
| WRK-005 | Fair assignment and internal/external team formation | `absent` | Depends on WRK-002/003/CRM-003/AIM-006 | Activate `V3_1_TEAM_FORMATION` flag and verify dependencies | Keep flag OFF; no staging action until dependencies verified | `tests/v3_1-contracts.test.ts`; new tests required when built | Toggle flag OFF; revert implementation commit | Yes — not built |
| CRM-004 | Counterparty performance, reliability and history | `absent` | Depends on CRM-001/002/003/IMP-001 | Wait for dependencies; design scoring weights with IP-001 review | No staging action until dependencies verified | N/A — not implemented | N/A | Yes — not built |
| SCH-005 | Handovers and meeting-action extraction | `absent` | Depends on COM-005/AIM-003 | Wait for dependencies; select meeting provider | No staging action until dependencies verified | N/A — not implemented | N/A | Yes — not built |
| COM-002 | Voice-note intake | `absent` | Transcription provider not selected | Select transcription provider; supply credentials privately | Add provider credentials in staging only; implement adapter behind existing inbound contract | `tests/integration/channel-identity.test.ts`, `tests/integration/inbound-event-identity.test.ts`, new voice adapter tests | Remove provider credentials; route returns `not_configured` | Yes — not built |
| COM-003 | Image and document intake with evidence preservation | `absent` | No inbound path writes to `documents` | Design evidence-preservation flow with FOUND-003 owner | No staging action until FOUND-003 unblocked | N/A — not implemented | N/A | Yes — not built |
| COM-004 | Email intake and send | `absent` | No email provider chosen | Select email provider; supply credentials privately | Configure provider in staging only; implement adapter behind existing contract | New email adapter tests; `tests/integration/inbound-event-identity.test.ts` | Remove credentials; route remains 501 stub | Yes — stub only |
| COM-005 | Calendar and meeting events | `absent` | Connector approval required | Approve calendar connector and credentials | No staging action until connector approved | N/A — not implemented | N/A | Yes — not built |
| COM-006 | Approved data connectors (Google Sheets etc.) | `absent` | Connector approval and credentials required | Approve connector and credentials | No staging action until connector approved | N/A — not implemented | N/A | Yes — not built |
| COM-008 | Live voice (future) | `deliberately_deferred` | Deferred by owner | Explicit owner approval before any work begins | No staging action; record in deferred list | N/A — not implemented | N/A | Yes — deferred |
| IMP-001 | Outcome recording against recommendations | `absent` | `management_cases` has no outcome column | Design outcome model with owner | No staging action until design approved | N/A — not implemented | N/A | Yes — not built |
| IMP-002 | Staff feedback and lessons learned | `absent` | Depends on IMP-001 | Wait for IMP-001 | No staging action until dependency verified | N/A — not implemented | N/A | Yes — not built |
| IMP-003 | Versioned playbooks and prompt/evaluation improvement | `absent` | Private repo/package decision pending | Owner decides private repository/package for proprietary playbooks | No staging action until IP-001 private repo decision made | N/A — not implemented | N/A | Yes — not built |
| RSK-006 | Sri Lankan-context advisory sources and human legal review | `absent` | Authorised legal reviewer not identified | Identify authorised legal reviewer and approved sources | No staging action until reviewer identified | N/A — not implemented | N/A | Yes — not built |
| MOB-004 | Accessibility and Sinhala/Tamil rendering | `absent` | Depends on LNG-001 | Wait for LNG-001 spec approval and Sinhala/Tamil font assets | No staging action until dependencies satisfied | N/A — not implemented | N/A | Yes — not built |
| OPS-003 | Backup, restore and rollback drills | `absent` | No staging environment exists | Provision staging environment access to rehearse | Create staging project; rehearse backup/restore on a disposable clone | Documented successful restore of staging DB to another instance | Re-provision if drill fails | Yes — no procedure until rehearsed |
| OPS-004 | Staging UAT and browser role testing | `blocked_owner` | No staging environment exists | Provision staging environment plus credentials | Run role-based browser tests on staging; use Playwright against staging URL | `scripts/verify/browser-check.mjs` against staging; department-specific login flows; RLS_READS/RLS_WRITES ON | Tear down staging deployment; restore from snapshot | Yes — blocked until UAT passes |
| OPS-006 | Model and provider configuration with cost monitoring | `foundation_only` | Provider selection and credentials pending; no production consumer | Select AI providers; supply credentials privately; configure budgets | Add providers/credentials in staging only; keep `MODEL_ROUTES` unused until approved | `tests/model-routes.test.ts`, `tests/ai-pricing.test.ts`, new budget-policy tests | Remove provider config; revert to no-provider state | Yes — foundation only |
| OPS-007 | Incident response and business continuity | `absent` | Depends on OPS-001/OPS-003 | Owner defines on-call expectations and continuity plan | No staging action until plan defined | N/A — not implemented | N/A | Yes — not built |
| OPS-008 | Monitored production pilot | `blocked_owner` | Every prior OPS gate | Owner approval of merge, hosted migration, flags and promotion | Run full staging campaign; merge only after all gates green | Full `npm run verify`, integration, browser-check, migration-lint, secret-scan on staging | Revert deployment to previous stable main SHA; restore hosted DB from pre-migration backup | **Yes — prohibited until all prior gates satisfied** |

---

## 3. Ordered staging launch checklist

Use this checklist **in order**. Do not skip a step because a later step looks independent; later steps assume earlier ones.

### 3.1 Pre-staging preparation (no live environment yet)

- [ ] Confirm head is `5b65ba7` on `kimi/found006-rls-cutover` and the tree is clean.
- [ ] Run `npm run verify` locally one final time and confirm:
  - secret-scan: clean
  - migration-lint: 108 sequential migrations, no gaps
  - `npm run typecheck`: clean
  - unit tests: 1208 passed / 2 skipped / 168 files
  - `npm run lint`: 0 errors
  - `npm run build`: clean
  - `npm run browser-check`: 10/10 passed
- [ ] Run integration tests on disposable PostgreSQL 16:
  - fresh `0001→0108`: 697 passed / 77 files
  - narrow `0107→0108`: 697 passed / 77 files
- [ ] Review this handoff with the owner and record go/no-go decisions.

### 3.2 Staging environment provisioning

- [ ] Create a Supabase staging project (separate from production).
- [ ] Configure staging environment variables in Vercel/Supabase:
  - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `SUPABASE_SERVICE_ROLE_KEY` (server-only)
  - `CRON_SECRET` (strong random)
  - `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`
  - **Do not set live provider keys yet** unless the owner explicitly approves.
- [ ] Verify staging DB is reachable from the deployment pipeline.

### 3.3 Migrations

- [ ] Apply `HOSTED_MIGRATION_0042_TO_0068.sql` to staging DB **as project owner** (or apply fresh `0001→0108` if starting from empty).
- [ ] Run `npm run migrate` and confirm `schema_migrations` shows `0108_push_subscriptions.sql`.
- [ ] Run `npm run migrate -- --status` and confirm no pending migrations.
- [ ] Re-run `tests/integration/secure-definer-grants.test.ts` and `tests/integration/search-path-safety.test.ts` against staging to verify SECURITY DEFINER grants.

### 3.4 Secrets and provider configuration (staging only)

- [ ] Add `CRON_SECRET` to staging and confirm `/api/cron/*` routes return 401 without/with wrong secret.
- [ ] If and only if owner approves:
  - Add finance classification provider key for FOUND-003.
  - Add `ANTHROPIC_API_KEY` for MOD-001 evaluation.
  - Configure WhatsApp phone number IDs / access tokens for outbound sends.
  - Configure channel account mappings in `channel_accounts`.
- [ ] Confirm no credentials are committed; run `npm run secret-scan`.

### 3.5 Feature flags

- [ ] Confirm all V3.1 flags remain default-OFF (`V3_1_TASK_DETECTION`, `V3_1_DECISION_PATHS`, `V3_1_TEAM_FORMATION`, `V3_1_AI_GUIDE`, etc.).
- [ ] Verify `/api/health` reports each flag as `off` or the configured value.
- [ ] Do **not** turn flags ON without a separate owner-approved rollout plan.

### 3.6 Seeded test data

- [ ] Seed at least two test companies with distinct data.
- [ ] Create active memberships for each department/role combination to be tested.
- [ ] Add sample customers, suppliers, service providers, projects, tasks, risks, incidents, obligations, budgets, invoices, bills, payments.
- [ ] Map receiving WhatsApp numbers to companies in `channel_accounts` if testing FOUND-003.
- [ ] Grant `operations.inbound.review` to a test user if testing the review queue.

### 3.7 Role-based browser testing

- [ ] Deploy staging preview.
- [ ] Run `scripts/verify/browser-check.mjs` against staging URL.
- [ ] Manually log in as:
  - Admin: confirm cross-company portfolio, admin pages, health backlog.
  - Finance: confirm finance dashboards, approvals, budgets, funding, reconciliation.
  - Operations: confirm projects, tasks, risks, scenarios.
  - HR: confirm leave, capacity, staff skills.
  - Legal: confirm contracts, licences, incidents, obligations.
  - Procurement: confirm suppliers, service providers, POs, RFQs.
  - Sales: confirm customers, quotations, price requests.
- [ ] Verify company isolation: a user in company A must not see company B data.

### 3.8 Failure, retry and idempotency testing

- [ ] Trigger `/api/cron/inbound-sweeper` with wrong secret — must return 401.
- [ ] Submit a duplicate WhatsApp message (if provider configured) — must result in one source event.
- [ ] Restart the sweeper mid-batch — previously claimed rows must return to eligibility.
- [ ] Submit a finance message without classification provider — must reach `manual_review` queue, never capture.
- [ ] Submit an opt-out identity — outbound enqueue must return `opted_out`.
- [ ] Attempt direct `quotations` status change from `ready` to `queued` as `authenticated` — must be refused (RPC-only trigger).

### 3.9 Audit verification

- [ ] Inspect `audit_events` table and confirm:
  - Every write action has a corresponding audit row.
  - `actor_type` is `system`, `human` or `ai` (never fabricated).
  - `company_id` is present and scoped.
- [ ] Inspect `/api/health` output and confirm:
  - `openInboundReviews`, `unattributedInbound`, flag snapshot are reported.
  - No hard errors.
- [ ] Confirm `ai_runs`, `ai_model_attempts` and cost fields are populated only when a provider is used.

### 3.10 Rollback rehearsal

- [ ] Before any production promotion, restore the staging DB from a backup taken immediately before migration.
- [ ] Confirm the application starts and read-only pages still function.
- [ ] Document the actual restore time and steps.

### 3.11 Production prohibition

- [ ] Confirm OPS-008 (`Monitored production pilot`) is still `blocked_owner`.
- [ ] Do **not** merge `kimi/found006-rls-cutover` to `main` or promote to production.
- [ ] Schedule owner review for production pilot approval.

---

## 4. Rollback summary

| Scenario | Rollback action |
|---|---|
| Staging migration fails | Restore staging DB from pre-migration backup; do not retry on production |
| Provider credential leaks | Rotate credential in Supabase/Vercel only; never commit; re-run `npm run secret-scan` |
| Flag accidentally enabled | Toggle flag OFF in staging; revert any state written while flag was ON |
| Browser test finds company isolation breach | Stop staging testing; file finding; do not promote |
| Inbound review queue mis-classifies staff as customer | Disable provider key; revert `channel_accounts` mappings; messages route to `manual_review` |
| R1 acceptance for AIM-003 withdrawn | Revert register status to `implementation_in_progress`; no production claim |
| Any unverified requirement pushed to production | **Production is prohibited** — revert deployment to last verified main SHA |

---

## 5. Production status

**Production remains prohibited for all requirements listed in Section 2.**

Only the 60 `locally_verified` requirements can be considered production-ready once OPS-008 is approved and the branch is merged. Until then, `kimi/found006-rls-cutover` is a verified working branch and must not be deployed to production.

---

*End of handoff. No credentials or secrets were pasted into this document or committed.*
