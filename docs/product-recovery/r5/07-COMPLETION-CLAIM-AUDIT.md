# Batch 1 — the completion-claim boundary: audit before implementation

**Local-only.** No hosted contact, no deploy, no merge, no migration numbering, no real data, no
live model, no message sent, no financial effect.

Baseline: HEAD `e1ddd17`. Preflight: **17 unrelated containers**.

## What exists

| | |
|---|---|
| task terminal statuses | `completed`, `cancelled` (`task-lifecycle.ts`) |
| task assignee | `tasks.assigned_to` → `profiles(id)`, i.e. a **user** id. Migration 0023 compares it directly with `memberships.user_id`, so `assigned_to = auth.uid()` is the correct test |
| task completion action | `completeTask` — requires `requireOps()`, **not** the assignee |
| task evidence | `task_evidence`, with a nullable `verified_by` |
| management lifecycle into verification | `monitoring → verifying`, `escalated → verifying`. **`assigned → verifying` is not legal** |

## R2F-F-011 — `completeTask` lets any operations user close another person's task

`completeTask` gates on `requireOps()` — operations department or admin — and never checks
`assigned_to`. Anyone in operations can move anyone's task to `completed`.

That is pre-existing task behaviour and is **out of scope to change here**: it is the task module's
own authority model, and altering it would change who may run operations, which nobody asked for.

**It matters to this batch because it is exactly why the claim boundary cannot lean on task status
alone.** "The task is completed" does not imply "the assigned person said their work is done" — a
manager may have closed it. The claim therefore checks `assigned_to = auth.uid()` itself, and the
owner's rule that a manager may not claim on someone's behalf is enforced there rather than
inherited from the task API.

## R2F-F-012 — two real item↔task relationships exist, and they mean different things

| relationship | what it is |
|---|---|
| **originating** | `management_items.subject_table = 'tasks'` + `subject_id` — the task whose overdue/blocked condition RAISED the item |
| **effect** | `management_execution_attempts.effect_ref` — the internal task the executor CREATED in response |

They are not interchangeable, and the difference is the whole point of separating effect from
outcome. Completing the *effect* task means the remedial work was done; the *originating* condition
may still persist. Completing the *originating* task means the condition itself is gone.

The owner's wording — "linked to the exact management item through the real execution/task
relationship" — names the effect relationship. Both are accepted by the boundary and both are
checked explicitly, because both are real links to the item and neither can be inferred from the
other. A task linked by neither is refused.

## R2F-F-013 — a claim needs binding and idempotency state that nothing can hold

`management_item_transitions` records `to_state`, `actor_id`, `actor_type`, `reason` and a database
`created_at`. It has nowhere to record which task the claim was about, which idempotency key it
used, or the item version, action and evidence digest the claimant saw.

Without those, an exact retry cannot be recognised, a conflicting retry cannot be refused, and a
claim cannot be shown to have been made against the state that was on screen.

One minimal quarantined draft unit therefore holds the claim record. The transition log, the
lifecycle boundary and the audit table are reused unchanged.

## What a claim means, and what it does not

A completion claim means exactly: **the assigned person reports that their work is complete.**

It does not mean the action succeeded, the business condition is resolved, evidence was verified,
the worker performed well, the item may be closed, or that learning may be updated. The boundary
performs no verification and writes no learning signal, and a test asserts both.
