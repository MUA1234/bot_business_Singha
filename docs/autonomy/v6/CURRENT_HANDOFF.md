# SINGHA AI BUSINESS MANAGER — CURRENT HANDOFF V6

**Prepared:** 21 August 2026  
**Development engine:** Kimi K2.7 through Conductor  
**Authority:** GitHub state was re-checked at preparation time; the remote repository wins if it later advances.

## Canonical repository

- Repository: `MUA1234/bot_business_Singha`
- URL: `https://github.com/MUA1234/bot_business_Singha`
- Clone: `https://github.com/MUA1234/bot_business_Singha.git`
- Visibility: public
- Connected access observed: pull and push permitted; no admin/maintain permission
- Default branch: `main`

Only this repository contains the current Singha AI Business Manager programme. Do not use `LakshanV/Bot-Manager`, Singha Auctions repositories or the call-assistant project.

## Latest continuation checkpoint

| Item | Verified value |
|---|---|
| Branch | `conductor/v5-continuation` |
| Head | `8ae6bc362e2d1cf56eef8f8b8fd1f9d3d34bcbb6` |
| Parent | PR #27 head `1b679e20990e6b58d048e036645e3f5647b4f3d2` |
| Relationship | one commit ahead, zero behind PR #27 |
| Runtime changes on continuation branch | none |
| Files changed by bootstrap | `AGENTS.md`, `CLAUDE.md`, `docs/autonomy/v5/BOOTSTRAP_RECORD.md`, `docs/autonomy/v5/PACK_NOT_RECEIVED.md` |
| Continuation PR | none found |
| Latest migration | `0089_duplicate_review_sibling_and_budget.sql` |
| Migration range | `0001–0089`, reported sequential |

The branch was created correctly from PR #27. Its only problem is that the previous V5 attachment never reached the bootstrap worker, so the five promised control documents were not committed.

## Parent PR #27

- URL: `https://github.com/MUA1234/bot_business_Singha/pull/27`
- Title: `OF-016: a paused payment finally has a way back`
- State: open, draft, unmerged, mergeable at verification time
- Head: `feature/of-016-duplicate-review-resolution`
- Head SHA: `1b679e20990e6b58d048e036645e3f5647b4f3d2`
- Base: `feature/found-006-caller-trust-boundary`
- Base SHA: `be2f13ee9ede90b58a69a86069bbd10f9d9c5106`
- Change size reported by GitHub: 4 commits, 49 files, +4866/−61
- Correction loops: 2 of 2 spent
- Status: awaiting local technical/owner acceptance; not production-approved

Migrations `0087`, `0088` and `0089` close the missing duplicate-review resolution flow and its two correction rounds. Any new material issue is a new remediation slice, not migration edits presented as correction loop 3.

## Evidence reported at PR #27 head

All database claims refer to a disposable local PostgreSQL 16:

- fresh `0001→0089`: 676 integration tests / 74 files pass;
- narrow `0088→0089`: 676 / 74 pass;
- realistic legacy `0001→0041` with representative data, then `0042→0089`: 676 / 74 pass;
- migration 0089 re-applies cleanly;
- unit: 760 passed, 2 skipped / 106 files;
- `npm run verify`: exit 0;
- migration lint: 89 sequential migrations;
- lint/build: clean;
- browser: 22 checks at 390/768/1440, three consecutive green;
- discrimination: 60 of 65 OF-016 database tests fail at 0086 and pass at head; documented exceptions are negative/limitation assertions.

These are repository/PR claims, not tests rerun while creating this pack. Conductor must reproduce the critical subset and full checkpoint gates before acceptance.

## Requirement register snapshot

The current register contains 90 records:

| Category | Count |
|---|---:|
| Locally verified | 13 |
| Incomplete and implementable | 72 |
| — absent | 41 |
| — specified | 6 |
| — foundation only | 22 |
| — implementation in progress | 3 |
| Blocked owner | 4 |
| Deliberately deferred | 1 |

The active state still names OF-016 and contains stale language from before its final acceptance. Reconcile it only after independently accepting the frozen PR head.

## Known open/blocked matters

- OF-017: PostgREST shared-login/`SET ROLE` topology risk; requires an owner-approved separate service login architecture.
- OF-018: P2 fail-closed inbound-review mismatch; bounded repository cleanup and the next code slice after acceptance.
- FOUND-006 remains `implementation_in_progress` because RLS cutover and topology work are not complete.
- FOUND-003 is `blocked_owner`: provider credential, receiving-number/company mappings, queue capability grant and hosted migration are required.
- MOD-003 is specified but not wired to production.
- IP-001 anti-clone/public-repository boundary is still in progress.
- Asset Intelligence (AST-001) and multilingual operation (LNG-001) are specified only, not implemented.
- 41 requirements are absent and 22 are foundation-only; the system is far from repository code complete.

## Evidence that remains unavailable

- authenticated Supabase browser/RLS end to end;
- OF-016 staging checklist execution;
- GitHub Actions CI runner;
- live-provider quality/cost results without private credentials;
- hosted/staging migrations and configuration;
- production pilot evidence.

## Immediate continuation order

1. Install this V6 pack on `conductor/v5-continuation` and open its stacked draft PR.
2. Independently accept or separately remediate PR #27.
3. Reconcile the requirement/findings/state controllers at the acceptance SHA.
4. Implement OF-018.
5. Implement MOD-003.
6. Finish IP-001.
7. Select the next highest-priority unblocked dependency from the live 90-record register and continue automatically.

## Main-branch warning

`main` is currently `fd11bd37b84f5ef645699e14be05b6cae1a16e62`. Its three Conductor commits (`a67f95d`, `fcc5fa3`, `fd11bd3`) only changed two ledgers after a misconfigured run. They are not part of the continuation branch and must not be cherry-picked as runtime development evidence.
