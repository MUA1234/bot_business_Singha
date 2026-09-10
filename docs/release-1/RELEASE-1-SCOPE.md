# Release 1 — scope

**Branch:** `claude/product-recovery-deploy-candidate`, built forward from `origin/main`.
**Nothing has been deployed, merged, or applied to any hosted database.**

## The loop Release 1 closes

```
observe → evidence → recommend → route → human decision where required →
controlled action → assignment → completion claim → outcome verification →
conservative learning → management visibility
```

Every step has a runtime writer. The step that had none — the lifecycle hops from `observed`
to `awaiting_approval` — was closed in R5 by `src/kernel/orchestrator.ts`, and the sweep is
wired into the cycle through `makeCycleDeps`. Until this release, though, **nothing invoked
that cycle on a schedule**: `/api/management/cycle` resolves its caller from a server session,
which a scheduler cannot satisfy, so an item sat in `observed` until a person pressed a button.
`/api/cron/management-cycle` closes that.

## In scope, and where it lives

| Capability | Where |
|---|---|
| All 12 management domains | `src/kernel/source-queries.ts` — 12 registered observation sources |
| Management queue and cockpit | `src/app/app/**`, `src/components/spatial/**` |
| Evidence-grounded recommendations | `management_item_evidence`; the zero-evidence prohibition is a database check |
| Authority-aware routing | `r1_draft_may_see_management_item`, `has_capability`, the authority engine |
| Human approval / rejection | decision RPC gated on `auth.uid()`; `service_role` revoked |
| Manager assignment | `r1_draft_assign_management_item`, requires `operations.task.manage` |
| Staff completion claims | claim RPC, `auth.uid()` = `tasks.assigned_to` |
| Deterministic outcome verification | verification sweep, `actor_type='system'`, null actor |
| Conservative learning | `OutcomeRecord` with six distinct identities and five admissibility rules |
| Ask-AI, advisory only | no tools, no functions, no execution path |
| **Exactly one** automated effect | `ops.task.create_internal` — creates an *unassigned* internal task |
| Railway as sole scheduler | `src/lib/scheduler.ts` `DEFAULT_JOBS`; `vercel.json` declares no cron |
| Canonical company resolution | `channel_accounts` + `resolve_channel_company` |

### The single automated effect

`ops.task.create_internal` creates an unassigned internal task and nothing else. Every other
catalogue action fails closed. The task it creates is **unassigned on purpose**: assignment is
a human manager's act, so the automated step stops exactly where a person's judgement begins.

Customer messages, quotations with unconfirmed prices, payments, material journals, contracts,
permission changes, HR decisions and external commitments always require a human. That is the
autonomy ceiling from the owner's decisions, and it is unchanged by this release.

## Explicitly NOT in Release 1

These are future roadmap. None is a Release 1 blocker, and none was started.

| Deferred | Why |
|---|---|
| Email, Google Sheets, voice | New integration surfaces; no Release 1 capability depends on them |
| CCTV, GPS | Gated behind legal and privacy review (`docs/SECURITY_AND_PRIVACY_MODEL.md`) |
| Marketplace, points | Product expansion, not loop closure |
| Additional AI agents | The autonomy ceiling is one catalogue action; more agents widen it |
| Additional automated actions | Same reason. Widening the ceiling is an owner decision, not an engineering one |
| Multi-country | Out of scope |
| Promoting the R1 draft migrations to production numbers | A separate numbering decision after the 0069 reconciliation lands (owner decision R1-D-1) |

## What changed in this candidate

| Area | Change |
|---|---|
| Migrations | Recovery line shifted +1 (`0069–0109` → `0070–0110`); `main`'s 0069 retained. [MIGRATION-LINEAGE.md](MIGRATION-LINEAGE.md) |
| Company resolution | Canonical path is `channel_accounts` + `resolve_channel_company`; `companies.whatsapp_phone_number_id` demoted to a legacy backfill source |
| Quotation routing | `main`'s data-driven department resolution retained; the unconditional `?? "sales"` is gone |
| Quotation currency | Read from `companies.base_currency`, not a compiled-in `"LKR"` |
| Scheduler | `dispatch-drain`, `inbound-sweeper`, `directive-escalation` and `management-cycle` added to `DEFAULT_JOBS`; `vercel.json` crons removed |
| Isolation config | Production refuses to start unless `RLS_READS`/`RLS_WRITES` are set explicitly |
| CI | Split into core and kernel campaigns on separate databases; both run |

## Verification posture

A capability is claimed only with a runtime path, discriminating test evidence, a deployment
axis and an exact SHA. This candidate has the first three. **It has no deployment axis**: no
staging environment exists in the Railway project, so nothing in this release is
`staging_verified`, and nothing is `production_verified`.

See [DEPLOYMENT-READINESS.md](DEPLOYMENT-READINESS.md) for the measured gate results and the
open items that block staging.
