# OF-016 — human staging test checklist

**Status:** prepared for a human tester. **Nothing here has been run.** No hosted or staging
migration has been applied, no flag activated, nothing deployed. This document exists so the person
doing the testing knows exactly what to do, what to expect, and — importantly — what would count as
a failure rather than a quirk.

**Prerequisite:** migration `0087` applied to the staging database, and at least one paused
duplicate review present (see *Setting up the fixture* at the end).

---

## What automated evidence already covers, and what it does not

Read this first, so staging time is spent on what only staging can prove.

| Already proven, on a disposable local PostgreSQL 16 | How |
|---|---|
| Authorization: unauthorized, cross-company, ended-membership, anonymous and service-role callers are all refused | 17 integration tests from genuine login roles |
| Both decisions behave correctly, including replay and conflicting replay | same suite |
| Concurrency: two reviewers, reviewer-vs-worker, AB-BA stress, stale worker, crash-after-commit | 7 multi-connection tests |
| Business shapes: same-day, recurring, salary, exact replay, rejected predecessor, historic 0083 row, existing payment | 10 tests |
| The screen's words match the rows the RPC persisted | component rendered against real persisted rows |
| The resume actually survives a pipeline pass | 4 unit tests |
| Routes served and gated; no horizontal overflow at 390/768/1440; no console errors | real Chromium, 22 checks |
| The UI calls these RPCs as the USER, never the service role | architectural test |
| `finance.duplicate.resolve` is grantable and resolves correctly | 7 provisioning tests |

| **NOT proven, and only staging can prove it** | Why |
|---|---|
| A real signed-in reviewer, in a real browser, against a real Supabase project | **There is no Supabase instance in this container.** The app reaches its database over Supabase's HTTP API, so no local browser check can sign in, load the queue with rows in it, or click a button that resolves one. This is a hard environmental limit, not an oversight |
| Supabase Auth session behaviour across refresh and restart | same reason |
| RLS as enforced by the real PostgREST request pipeline | the local tests drive PostgreSQL directly with the same role/claim shape, which is close but not identical |
| Real-world layout on real devices | viewport emulation is not a device |

---

## 1. Authorized reviewer login

1. Sign in as a user who holds `finance.duplicate.resolve` in the test company (role
   `finance_reviewer`, `owner_management` or `system_administrator`) **and whose membership is
   `active`**.
2. Go to **Finance → Suspected duplicates** (`/app/finance/duplicate-reviews`).

**Expect:** the queue renders. Header reads *Suspected duplicates*, with a count badge
*“N awaiting a decision”*.

**Fail if:** you land on `/login` while genuinely signed in; or you see the permission-denied panel
despite holding the capability; or the page shows *“The review queue could not be loaded”* — that
banner means the read failed, which is deliberately **not** the same as an empty queue.

---

## 2. Queue visibility and evidence

On a pending item, confirm every one of these is present and correct against the database:

- [ ] Both transactions side by side — **This payment** and **Earlier payment**
- [ ] Each with its **own** amount *and currency* (`LKR 128,500.75`, not a bare number)
- [ ] Date, counterparty, purpose, state, and the event id for each side
- [ ] Score as a percentage
- [ ] **Why this was raised** expands to show per-feature contributions (amount / date / counterparty)
- [ ] Evidence **present** and evidence **missing** both listed
- [ ] Where evidence is missing, the line *“missing evidence contributed nothing to the score”*
- [ ] The rule version (e.g. `dup/v2-evidence-required`)
- [ ] The caveat: *“suspected duplicate … not proven fraud and not a verdict … paused and reversible”*
- [ ] A **required** reason field, and both action buttons

**Fail if:** an amount appears without its currency; a figure differs from the database; the caveat
is missing; or the reason field can be left empty and still submit.

---

## 3. Confirm duplicate

1. On a pending item, type a reason (e.g. *“same receipt forwarded twice”*) and press
   **Confirm it is a duplicate**.

**Expect:** success message *“Marked as a duplicate.”* Then verify in the database:

```sql
select state, duplicate_of_event_id from financial_events where id = '<candidate>';
--> 'duplicate', and the id of the EARLIER event

select state from financial_events where id = '<earlier>';
--> unchanged (e.g. 'posted') — the original must never be rewritten

select status, lease_owner from source_events where id = '<source>';
--> 'completed', lease_owner null — no longer claimable

select count(*) from approval_requests where financial_event_id = '<candidate>';
select count(*) from payments where source_event_id = '<source>';
--> 0 and 0 — a confirmation creates no business effect
```

**Fail if:** any journal, payment, approval, task or outbound message appears; or the earlier event
changed; or the source event is still claimable.

---

## 4. Mark distinct, and confirm processing genuinely resumes

This is the highest-value check on the list, because it is the one that depends on the worker.

1. On a different pending item, give a reason (e.g. *“two separate POs, both genuine”*) and press
   **These are different transactions**.

**Expect:** *“Released as a distinct transaction.”* Immediately verify:

```sql
select state from financial_events where id = '<candidate>';           --> 'draft'
select status, lease_owner, processed_at, attempts
  from source_events where id = '<source>';
--> 'pending', null, null — and `attempts` UNCHANGED from before (history is not reset)
```

2. **Wait for the finance worker to run** (or trigger the scheduled drain).

**Expect, after processing:**
- The event moves on — typically to `awaiting_approval`, and an approval request now exists.
- **It does not pause again.** A second `duplicate_reviews` row for the same pair must **not** appear.
- Exactly **one** draft and **one** approval — not two.

**Fail if:** the payment returns to *Suspected duplicates* (the dismissal did not stick); or two
approvals/drafts appear; or the event sits in `draft` indefinitely with no worker action.

---

## 5. Approval appearance

1. Go to **Finance → Approvals**.

**Expect:** the released payment now appears as a normal approval request. While anything is still
paused, a banner reads *“N payments are paused as suspected duplicates and do not appear below”*
with a link to the queue.

**Fail if:** a paused payment appears in the approvals list as though it were actionable; or the
banner shows a count while the queue shows a different one; or the banner appears for someone
without the capability.

---

## 6. Unauthorized and cross-company denial

| Sign in as | Go to | Expect |
|---|---|---|
| A member of the same company **without** `finance.duplicate.resolve` | the queue | The permission-denied panel naming the capability. **No** amounts, counterparties or event ids anywhere on the page |
| A member of the same company without the capability | Finance hub | The *Paused — suspected duplicates* tile reads **0** — never a real count they cannot act on |
| A reviewer of a **different** company | the queue | Their own company's items only. The other company's review must be invisible |
| A reviewer of a different company, pasting the other company's review id into the resolve request | — | Refused: *“you do not hold finance.duplicate.resolve in this company”* |
| Signed out entirely | `/app/finance/duplicate-reviews` | Redirected to `/login`. No content flashes first |

**Fail if:** any amount, counterparty or event id from a company the viewer does not belong to
appears anywhere, including in a count.

---

## 7. Refresh and restart persistence

- [ ] After confirming, **refresh** — the item shows as resolved, with the decision, your name, and
      your reason. It does not reappear as pending.
- [ ] **Close the browser entirely, reopen, sign in again** — the same state.
- [ ] Press the browser **back** button after resolving, then resubmit the form — you get
      *“Already recorded — your decision was applied earlier and stands.”* **Not** a second audit row,
      and **not** an error.
- [ ] Two reviewers on two devices resolve the same item at once — one succeeds, the other is told
      the standing decision. Whichever committed first is the one that stands, and the event goes
      where **that** decision sent it.

---

## 8. Mobile and desktop layout

Check at a real phone width (~390px), a tablet (~768px) and a desktop (~1440px):

- [ ] No horizontal scrolling on any of them
- [ ] The two transactions stack on mobile and sit side by side on desktop
- [ ] Both action buttons are reachable and tappable without zooming
- [ ] The reason field is usable on a phone keyboard
- [ ] Long counterparty names wrap rather than overflowing
- [ ] The evidence disclosure opens and closes

---

## 9. Audit and health

```sql
select actor_type, actor_id, action, payload
  from audit_events
 where entity_id = '<review id>' and action = 'finance.duplicate_review_resolved';
```

- [ ] `actor_type` = `user` and `actor_id` = **the real reviewer's user id** — never null, never a role
- [ ] `payload` carries the resolution, the reason **as typed**, both event ids, the score and the rule version
- [ ] Exactly **one** row per review, even after a refresh-and-resubmit
- [ ] Attempting to edit or delete that audit row is refused (it is append-only)

Then:

- [ ] **Admin → System Health**: the *Paused — suspected duplicates* tile drops by one after each
      resolution, and reads 0 when the queue is clear
- [ ] **Finance hub**: the same tile agrees with the queue's own count
- [ ] Try to `update` or `delete` the resolved `duplicate_reviews` row directly as the service role —
      it must be refused as immutable

---

## Setting up the fixture on staging

A paused review is produced by the pipeline itself: send two closely-matching finance messages for
the same company (same amount, same counterparty, within three days). The second should pause as a
suspected duplicate. If a review is instead needed directly, insert one against two existing
`financial_events` in the same company with the candidate in state `awaiting_information` — the
integration tests' `seedPausedCandidate` helper shows the exact shape.

---

## Reporting back

For each numbered section, record **what happened**, not just pass/fail — an unexpected message is
more useful than a tick. Anything in §4 that does not resume, and anything in §6 that shows one
company's money to another, should stop the test and come straight back.
