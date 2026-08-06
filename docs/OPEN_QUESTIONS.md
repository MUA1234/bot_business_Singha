# OPEN_QUESTIONS.md

> **⚠️ QUICKBOOKS SUPERSEDED (D-011 / NEXT_PHASE_DEVELOPER_BRIEF).** QuickBooks is
> **not used** and is **not** the accounting source of truth. The internally-owned
> double-entry Accounting Core (`src/accounting/*`) is the sole accounting source of
> truth. Ignore every QuickBooks connection / posting / draft / sync / OAuth /
> reconciliation instruction in this document; those references are historical only.
> See document precedence in `CLAUDE.md`.


**Status:** Phase 0 deliverable — for review. Answers unblock Phase 1+ and become
decisions in `DECISIONS.md`. Each proceeds on the **safer default** until answered.

## Organisation & people

1. Which **legal entity / business** is the pilot? Name, country, currency, timezone,
   tax IDs? _Safer default: single entity, Sri Lanka / LKR / Asia-Colombo (matches
   Sasiri context)._
2. The ~5–15 **staff**: names, roles, managers, branches/departments? Who is
   `owner_admin`, `manager`, `finance`?
3. **Authority thresholds:** expense self-approve limit per role; finance-review
   threshold; who may verify tasks; who may reactivate employees; who approves
   QuickBooks drafts? _Safer default: employees can approve nothing; all sensitive
   actions require manager/finance approval until thresholds are set._

## Finance / QuickBooks

4. QuickBooks **entity(ies)** and is a **sandbox** company available? _Safer default:
   sandbox-only until confirmed; production stays draft-only._
5. Chart-of-accounts / tax-code expectations for expense mapping? Who is the
   accountant reviewer for uncertain tax?
6. Retention appetite for financial records and event payloads?

## Channels

7. **WhatsApp number strategy:** a **separate** WhatsApp Business number for staff ops
   (recommended), or share the Sasiri sales number? _Safer default: separate number._
8. Are approved WhatsApp **message templates** available for business-initiated staff
   messages outside the 24h window?

## Privacy / gated

9. Timeline and owner for the **GPS/CCTV/attendance** privacy gate (notices, policy,
   retention, legal review)? _Default: out of scope until explicitly cleared._
10. Any regulatory constraints (data residency, labour law) affecting attendance,
    monitoring, or employee data?

## Ownership / process

11. Who are the **sign-off owners**: management (scope), finance (accounting/payments),
    privacy/legal (gated features)?
12. Where do **staging vs production** Supabase/Vercel/Inngest/QuickBooks accounts
    live, and who administers them?
13. Alert **owners** per alert type (dead-letter, cost spike, integration down)?
