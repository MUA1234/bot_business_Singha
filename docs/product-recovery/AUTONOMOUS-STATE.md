# Autonomous state — resumption record

Updated after every checkpoint and before any unavoidable response.

---

## Position

| | |
|---|---|
| Repository | `MUA1234/bot_business_Singha` |
| Branch | `claude/product-recovery-r1` |
| HEAD | `e5b55524444443f797b9f3c0f2a4e53cfa3d2c8f` — pushed, in sync |
| Working tree | **dirty**, deliberately: TD-002 + R2D await the four separated commits |
| Phase | **R2D**, batches 1–8 implemented; verification campaign running |

## Completed since HEAD

**TD-002 — incremental high-water mark** (product defect). A caught-up `keyset_updated` lane
committed `next = null`, so the next cycle re-read the oldest rows and a change made moments ago
waited behind the whole table. Now parks at its compound `(updated_at, id)` mark; an empty page
never erases a valid position. Bound corrected: sentinel is row 601, page 100, so earliest forward
discovery is **cycle 7**. Reconciliation reads carry a `lane` marker — two earlier tail-liveness
"passes" had been satisfied by the wrong lane.

**Performance** — queries/cycle 2074 → 581; identity lookups 494 → 7. Cause was the test shim
re-deriving RPC signatures per call (42%) and the per-observation N+1 (46%), not the dual lanes
(+14%).

**R2D** — audit + contracts (`r2d/00-AUDIT-AND-CONTRACTS.md`, findings F-001…004); draft unit
**020** (threads, turns, citations, suggested actions, coded safety events; RLS own-membership +
`management.ask_ai.review`; safety events own-membership-only; no write policy; retention 30 days
default, 90-day ceiling, `expires_at` NOT NULL); capability registered default-deny in the existing
`permissions` catalogue; `src/kernel/ask-ai/{contract,sensitive,retrieval,ask,fixtures,review,
identity}.ts`; `src/app/api/ask-ai/route.ts`; `AskAiWindow` + registry entry.

**Defects found and fixed this phase**
- retrieval selected `assignee_membership_id` — no such column; real one is `assigned_to`
  → `profiles(id)` → a USER. Same class as R2C-F-002.
- `asUser` test helper omitted the transaction, so `SET LOCAL ROLE` was a no-op and six RLS
  assertions ran as the table owner. Failed **open**, which is why it was caught.
- draft 020 granted no `SELECT` to `authenticated` — refusal by table privilege would have looked
  like isolation while also denying a person their own guidance.
- `expires_at > created_at` forbade early expiry, which purge and revocation both need.

**Identity brands** (owner decision): `UserId`/`MembershipId`/`CompanyId` are branded, so the
transposition that caused the retrieval defect is now a compile error, mutation-verified by
`@ts-expect-error`.

## Test counts

Kernel + spatial units **≈823 passing** (Ask-AI 35, multilingual 9, UI 22, disclosure 14,
identity 8). Live campaign: running.

## Running now

`node scripts/r1/run-r1-security-tests.mjs` → `/tmp/r2d3.log` — 20 suites including
r2d-ask-ai, r2d-adversarial, r2d-non-execution, r2d-saved-answer-access.

## Next exact action

```
# 1. read the campaign
grep -aE "FAILED |Test Files|Tests |FAIL " /tmp/r2d3.log | tail

# 2. mutation-check the high-water invariant
node <scratchpad>/mutate-hw.mjs break && node scripts/r1/run-r1-security-tests.mjs
node <scratchpad>/mutate-hw.mjs restore

# 3. full gates, diff review, then FOUR separated commits:
#    (1) TD-002 high-water/lane/reconciliation + tests  [carries the shared runner file]
#    (2) R2D contracts, persistence, backend, security
#    (3) R2D spatial/mobile UI + tests
#    (4) R2D report/evidence
# 4. push, verify local == remote, then continue into R2E
```

## Unresolved findings

- **R2D-F-002** production retention duration — owner/legal gate; local 30 days, 90-day ceiling
- **R2D-F-003** `membership_languages` is quarantined draft 016 — deployment blocked by 0069
- Sinhala/Tamil classifier coverage thin — handled by the `unverified` mode, which answers but
  does not file to reviewable history and never infers a grievance; native-speaker review is a
  staging gate
- **TD-001** `loadFor` positional `(source, companyId)` pair, 47 call sites — deferred
- Pixel layout and assistive-technology behaviour — staging/human gates; the disclosure tests are
  structural DOM evidence only

## Hard blockers

**None.** Staging and production remain zero. No hosted contact, no live model, no migration
numbering, no real data.
