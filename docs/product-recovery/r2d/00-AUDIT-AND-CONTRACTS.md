# R2D checkpoint 1 — audit and contracts

**Local-only.** No hosted contact, no deploy, no merge, no production migration number, no live or
paid model, no real data, no message sent.

Ask-AI is **operational staff guidance inside the management system** — not a chatbot, not a sales
agent, not a second AI platform. Everything below reuses a mechanism that already exists; where it
does not exist, that absence is recorded as a finding rather than filled by invention.

## What already exists, and is therefore reused

| Need | Existing mechanism | Why it is sufficient |
|---|---|---|
| Model boundary | `src/ai/gateway.ts` — `AiGateway`, `CompletionTransport`, `MODEL_ROUTES`, cost ledger | The transport is already injectable, so deterministic fixtures need no new seam and no second gateway |
| Suggested actions | `src/kernel/catalogue.ts` — `ACTION_CATALOGUE`, `actionById`, `actionFor`, `catalogueIsInternalOnly()` | The catalogue is already the only registry of executable actions; Ask-AI proposes from it and never invents an id |
| Evidence and provenance | management kernel `Fact<T>`, `management_item_evidence`, adapter `EvidenceRef` | Citations reuse the same reference shape the kernel already audits |
| Language | **`membership_languages`** (quarantined draft 016) | Already `('en','si','ta')` with `is_preferred`, and already distinguishes *receiving* communication from *working* in a language — exactly R2D's distinction |
| Interface | spatial window registry (`ApprovalsWindow`, `ManagementQueueWindow`, `AIRecommendationsWindow`, `TasksWorkspaceWindow`, `CommandCentreWindow`, `ModuleWindow`) | Ask-AI is another window in the existing shell, not a new interface |
| Identity and scope | server session → `getProfile()`, `resolveCapability()`, company-scoped RLS | Company and membership come from the session; a client-supplied company is refused, as in the cycle route |
| Audit | `writeAudit`, append-only transitions, correlation ids | No second audit system |

## Findings

### R2D-F-001 — there is no existing Ask-AI, chat or conversation capability

Searched: no Ask-AI component, no chat component, no conversation table for staff guidance. The
only "conversation" structure is `wa_conversations`, which is **customer** WhatsApp state and is
neither authorised for nor shaped like staff guidance.

**Consequence.** Ask-AI is greenfield here. That removes any risk of a competing system, and it
means persistence needs a new structure — which, under the containment rules, can only be a
quarantined unnumbered draft unit.

### R2D-F-002 — no approved retention duration exists, anywhere

`docs/AI_BUSINESS_MANAGER_MASTER_SPEC.md` requires "configurable retention" for several domains and
`/privacy` states a purpose-bound principle — *"as long as necessary for the purposes above and to
meet legal, accounting, and tax record-keeping obligations, after which they are deleted or
anonymised"* — but **no duration is approved anywhere**, and the codebase has no retention
mechanism at all: `retention_days`, `retain_until` and `retention_policy` return nothing.

**Disposition.** This is an **owner/staging gate, not an implementation choice.** Choosing a
duration here would be inventing policy, and defaulting to "keep for ever" would be doing it
silently. The local implementation therefore:

- carries an explicit `retention_status` and a configurable window, default-conservative;
- never sets an unbounded retention;
- stores nothing in browser storage;
- records the missing policy as a blocker on the requirement, not as a solved problem.

### R2D-F-003 — `membership_languages` is quarantined, so multilingual support is deployment-blocked

The only language-preference storage lives in draft 016. There is **no `preferred_language` column
in any released migration**.

**Consequence.** Sinhala and Tamil preference can be exercised locally against the draft database
and nowhere else. Deployment of the language preference remains blocked by the same migration
reconciliation (0069) that blocks everything else. Ask-AI must therefore fall back **truthfully** to
English when no preference is readable, and must not claim released-schema support.

### R2D-F-004 — manager review needs a capability that does not yet exist

`resolveCapability` exists and the role matrix is real, but there is no capability meaning "may
review another member's operational guidance". Manager *status* is not sufficient authorisation —
the owner's instruction is explicit — so a specific capability is required.

**Disposition.** Reuse the existing capability mechanism with a dedicated capability id rather than
inferring from role. If it cannot be registered without schema change, manager review stays
**absent and reported**, not approximated by a role check.

## Contracts

### Request

Company and membership come from the authenticated **server session**. A caller-supplied company is
**refused**, not ignored — the same rule the management cycle route already enforces.

```
AskRequest = {
  question: string          // bounded length
  threadId?: string         // reauthorised on every reopen
  language?: "en" | "si" | "ta"   // overrides the stored preference for this turn only
  context?: { table, id }   // an authorised record the user launched from
}
```

### Retrieval and authorisation boundary

Evidence is filtered **before** it reaches the model, never after. The model never sees a record the
requester could not open directly, so a prompt cannot widen access — there is nothing wider in the
context to leak. Service-role access is never a substitute for proving user access.

### Answer contract (strictly validated)

`answer · language · citations[] · confidence · uncertainties[] · missingInformation[] ·
suggestedActions[] · requiredApproval · escalation · refusalReason · staleEvidence ·
generatedAt · correlationId`

Rejected, failing closed: a citation to a record the requester cannot access or that does not
exist; an action id absent from `ACTION_CATALOGUE`; a language code outside `en|si|ta`; malformed
or oversized output; any attempt to invoke a tool or claim an action was performed.

### Prompt-injection boundary

Retrieved content — customer messages, task text, supplier notes, uploaded text — is **data**.
Instructions found inside it carry no authority. Evidence can never change who the requester is or
what they may see, because authorisation is resolved from the session before retrieval and is not
re-derived from anything the model returns.

### Authority boundary

Ask-AI explains and recommends. It does not assign, approve, message, grant access, create
delegations, change employment information, move money, post journals, resolve items or mark work
complete. A suggested action is a **proposal from the catalogue**, unexecuted and marked as
requiring review.

### Sensitive topics

Classification happens **before** ordinary persistence, not after. Grievance, harassment, health,
disability, whistleblowing, protected HR, disciplinary and privileged legal content are not written
to ordinary Ask-AI history; the response directs the person to a protected human channel, and only a
minimal coded safety event is recorded. There is no protected case-management system in this
repository and **one will not be invented** — its absence is reported.

## What this checkpoint does not claim

Deterministic fixtures prove integration, authorisation and safety behaviour. They prove **nothing**
about real model quality, and nothing about whether Sinhala or Tamil output is idiomatic or correct.
Native-speaker review remains a separate human gate, and no live or paid model is called anywhere in
this phase.
