# PILOT_SCOPE.md

> **⚠️ QUICKBOOKS SUPERSEDED (D-011 / NEXT_PHASE_DEVELOPER_BRIEF).** QuickBooks is
> **not used** and is **not** the accounting source of truth. The internally-owned
> double-entry Accounting Core (`src/accounting/*`) is the sole accounting source of
> truth. Ignore every QuickBooks connection / posting / draft / sync / OAuth /
> reconciliation instruction in this document; those references are historical only.
> See document precedence in `CLAUDE.md`.


**Status:** Phase 0 deliverable — for review. Master spec §3.

## In scope (pilot)

- **One** business (single legal entity), but the schema models the full
  multi-company hierarchy from day one so isolation is real, not retrofitted.
- ~5–15 staff. Management and employee logins; finance and admin roles.
- Employee profiles, schedules, leave, attendance (manual/app check-in), capacity.
- Tasks: full lifecycle, estimates + revisions, time reporting, blockers, evidence,
  verification.
- Projects and milestones.
- AI-generated plans and recommendations → **management approval queue**.
- WhatsApp staff updates (Meta Cloud API).
- Expense & receipt submission; payment-purpose tracking.
- Read-only financial intelligence.
- Daily management summaries.
- Complete audit history.
- QuickBooks: **read-only / finance-approved draft workflow only.** AI never executes
  a bank payment.

## Explicitly out of scope (pilot) — gated

- GPS, geofences, fleet tracking.
- CCTV, access control, site surveillance, video.
- Facial recognition (requires separate legal/privacy/bias/accuracy review — never
  a casual add).
- Customer-facing AI receptionists / sales / service agents.
- Agent Builder and controlled self-learning / quality supervisor auto-actions.
- Additional businesses, branches, sites, vehicles, countries, currencies.
- Automatic QuickBooks posting or bank payment execution.

**Gate condition for GPS/CCTV/attendance-monitoring:** approved monitoring policy,
written notices/signage, purpose limitation, configurable retention, role-based
viewing, access/export logging, and country-specific legal review — all signed off
before any such feature enters staging.

## Pilot success criteria

1. A staff WhatsApp update or app action becomes a stored, deduped event and (where
   relevant) a task, with full audit trail.
2. Replaying any event twice produces exactly one downstream record (proven test).
3. A management-facing AI recommendation can only change business state via the
   approval queue + human decision; the decision is immutably audited.
4. A receipt photo → Storage → OCR/extraction (Inngest) → human verification →
   QuickBooks **draft** (never auto-post), with duplicate detection.
5. Company-isolation test suite passes and fails loudly when isolation is broken.
6. Staging and production run on separate Supabase projects.

## Pilot org shape (to confirm — see OPEN_QUESTIONS)

- 1 `legal_entity` → 1 `business` → 1–2 `branches`/`departments`.
- Roles: `owner/admin`, `manager`, `finance`, `employee`.
- Authority limits configured per role (see `AUTHORITY_MATRIX.md`).
