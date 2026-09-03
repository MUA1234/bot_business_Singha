# R2D — staff Ask-AI and multilingual operational guidance — report

**Local-only.** No hosted contact, no deploy, no merge, no production migration number, no live or
paid model, no real data, no message sent, no financial effect.

## SHAs

| | |
|---|---|
| Phase start | `e5b5552` (R2S-P cursor handoff) |
| TD-002 + harness hardening | `09c0753` |
| R2D contracts, retrieval, persistence, security | `e4d293c` |
| R2D spatial UI | `2d7d074` |
| R2D audit, contracts, state record | `7e825b9` |
| **This report** | *(filled at commit)* |

## What was built

Evidence-grounded operational guidance for authorised staff, in English, Sinhala and Tamil, inside
the existing management workspace. It explains, cites and recommends. It cannot act.

Everything reuses a mechanism that already existed — `AiGateway`'s injectable transport,
`ACTION_CATALOGUE`, the kernel's evidence references, `membership_languages` from draft 016,
`has_capability`. No second gateway, action registry, evidence model or authority system was
created.

## The ordering is the safety property

```
classify sensitive → resolve language → retrieve AUTHORISED evidence → ask → validate → persist
```

Two of those positions cannot be moved without losing the guarantee:

**Classification precedes persistence.** Once a grievance is in a history a manager may review, the
disclosure has already happened. There is no later filter that undoes it.

**Retrieval precedes the model.** Evidence is filtered by what the REQUESTER may see, so prompt
injection is structurally uninteresting here: a planted instruction can demand another company's
invoices, but those rows were never fetched, are not in the context, and the model has no tool with
which to fetch them. The adversarial suite asserts this on the CONTEXT rather than the answer —
`COMPANY B SECRET PROJECT` never appears in what the provider was handed, under six injection
shapes including a fence-escape and a mixed-script attempt.

## Defects found, each by running it

| Id | Defect | Why it mattered |
|---|---|---|
| **R2D-F-005** | retrieval selected `assignee_membership_id` — no such column | The real one is `assigned_to` → `profiles(id)` → a USER. Even spelled correctly, scoping by membership matches nothing: a person is shown an empty task list, which reads as *"you have no work"* |
| **R2D-F-006** | the write-guard trigger returned `NEW` on `DELETE` | `NEW` is NULL for a delete, and NULL from a BEFORE trigger **skips the operation**. Every delete was silently discarded — including the retention purge. No error, no warning, no changed row count |
| **R2D-F-007** | the route used `supabaseAdmin()` | Service-role reads made the capability filter the only thing between a bug in it and another company's records. Caught by the repository's own allowlist gate, before commit |
| **R2D-F-008** | a component was invoked as a function | No renderer attached, so its first hook dereferenced null |

### R2D-F-006 in full, because the test was the problem

The purge test passed while nothing was being deleted. It asserted that expired guidance no longer
appeared through ordinary queries — and RLS hides expired rows from `SELECT` regardless of whether
anything was removed. **It tested visibility and reported it as storage.**

That is recorded here as a **false pass**. Every retention assertion now reads through a privileged
connection with RLS explicitly bypassed, and one test reproduces the false pass deliberately:
expire a thread *without* purging, confirm an ordinary read sees nothing, then prove via the
privileged read that all rows are still there. A test that stopped at the first assertion would
report a working purge.

### R2D-F-005 and what followed

A repository-wide audit found **no other** `assigned_to`-versus-membership comparison. `UserId`,
`MembershipId` and `CompanyId` are now branded types. Making them load-bearing failed **55 call
sites** — every one a place where a bare string was flowing into an identity field, and where the
compiler previously had nothing to say. The route builds all three from the session in one
reviewable place.

## What the schema cannot express

Draft unit **020** has no column for a system prompt, hidden reasoning, a provider secret, or a
copy of a source record. Citations are **references**, so a saved answer never becomes a route
around access revoked later. There is **no write policy at all** — a client cannot fabricate an
answer, citation or suggested action and replay it as the system's. `status` is constrained to the
single value `'suggested'`: there is no representable executed state.

## Non-execution, proved at runtime

> **166 application tables inspected by count and canonical content digest before and after a
> hostile sequence — unexpected changes: none.**

The inventory is derived from `information_schema`, not hand-listed. The digest is `md5` over
`row_to_json` of every row ordered by its own JSON text, so it covers timestamps, status,
ownership, authority and amounts — because a row COUNT survives both an `UPDATE` and an
insert-then-delete. Three exclusions are justified in the file; nothing is excluded for being
unchanged.

The transport receives exactly `{question, language, evidence, catalogueActionIds}` — no `tools`,
`functions`, `tool_choice` or `executor` — and the catalogue arrives as **strings, never callables**.
An in-process `fetch` guard catches any outbound attempt.

**What this establishes:** no committed difference between two moments. It does **not** establish
that no transient write occurred and was rolled back; that needs statement or WAL instrumentation,
which is not in place and is not claimed.

## A saved answer re-authorises on read

References protect the records; they do nothing for the prose, which already copied the facts out.
`review.ts` re-checks every citation against the reader **now**, and withholds the answer text
entirely if one has closed. The restricted state is deliberately uninformative — the same sentence
whatever the cause, naming no table, id, title or count, because *"this cites 3 records you cannot
see"* is itself a disclosure. A foreign-company thread and a non-existent one return **identical**
outcomes. The author is not exempt.

Each test plants `ZZ-SECRET-MARKER-7F3A9C` in the inaccessible record and asserts it never
reappears.

## An accepted design consequence, not a defect

An authenticated `DELETE`/`UPDATE` on the Ask-AI tables **affects zero rows and returns success**
rather than raising, because no RLS policy exists for those commands. Adding permissive policies so
the guard trigger could raise a clearer error would make that trigger the **only** thing between an
authenticated caller and another company's rows. That trade was refused. The tests assert the
effect — zero rows, stored data byte-identical — and a separate case proves the guard still raises
loudly on `INSERT`, where a row does reach it.

## Multilingual — and the asymmetry it creates

A frozen 9-phrase corpus asserts that identifiers, amounts, currency and dates survive **verbatim**
in all three languages, that negation and approval are never inverted, and that "overdue" and "not
overdue" remain distinct strings — a translation collapsing them would pass every token check while
being dangerous.

**Sinhala and Tamil classifier coverage is thin.** An unclassifiable question in those scripts is
answered but **not filed** to reviewable history, and is **never inferred to be a grievance** —
that would accuse someone of something they did not do. The cost is real and stated in the notice
the person sees: a Sinhala or Tamil speaker gets no thread history and no manager review until
native-speaker review closes the gap. That cost is visible and temporary; a protected disclosure
sitting in a reviewable history is neither.

## Runtime evidence

Real server, real production build, real Chromium:

```
/api/ask-ai refuses an unauthenticated caller                          401
/api/ask-ai REFUSES a caller-supplied companyId rather than ignoring it 400
/api/ask-ai REFUSES a caller-supplied membershipId                      400
/app/command is served and gated                    307 → /login?next=/app/command
```

The third line is the one worth having: a route that quietly *drops* an unexpected identity leaves
the caller believing it was honoured.

## Mutation evidence

| Mutation | Result |
|---|---|
| write guard returns `NEW` on `DELETE` again | **CAUGHT** — 6 failed |
| caught-up keyset lane clears its high-water mark | **CAUGHT** — 5 failed |
| task scope reverts to the membership id | **CAUGHT** — 2 failed |

A fourth was initially reported as "survived" and was not: the harness had failed to parse a run
that never executed tests. **No `Tests` line means inconclusive, not survived** — the mutation
runner now distinguishes them.

## Totals

| Gate | Result |
|---|---|
| Live campaign | **400 passed / 0 failed** across 22 files (1643s) |
| Unit suite | **2195 passed**, 4 skipped |
| Outbound-network guard | **625 passed** |
| Typecheck · lint · build | clean · clean · exit 0 |
| secret-scan · migration-lint | no tracked secrets · 109 sequential |
| inventory · IP-boundary · autonomy | `supabaseAdmin` confined · pass · pass |
| browser-check | routes served, gated, rendering |

## Requirement status

**Nothing is advanced to `locally_verified` by this phase.**

The runtime path, authorisation, persistence, failure handling and user-facing surface are all
exercised — but deterministic fixtures prove **integration and safety behaviour only**. They prove
nothing about real model quality, and nothing about whether the Sinhala and Tamil read naturally.
Advancing a language or Ask-AI requirement on fixture evidence would be exactly the kind of claim
this recovery exists to stop making.

## Gates that remain open

- **Production retention duration** — owner/legal/privacy. Local default 30 days, clamped 1–90,
  `expires_at` NOT NULL. Not the production policy (R2D-F-002).
- **`membership_languages` is quarantined draft 016** — multilingual preference is deployment-blocked
  by the same 0069 reconciliation as everything else (R2D-F-003).
- **Native-speaker review** of the Sinhala and Tamil strings, and of the sensitive-topic term list.
- **Real viewport and assistive-technology verification** — `spatial-viewport-audit.mjs` drives a
  real browser at 390/768/1440/2560 but needs credentials this phase may not use. The disclosure
  tests are **structural DOM evidence**, not pixel layout.
- **Live-model evaluation** — planned, not executed. No paid call was made.
- **TD-001** — `loadFor(source, companyId)`, 47 call sites, still positional.

Staging and production verification remain **zero**.
