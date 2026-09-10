# Release 1 — index

**Candidate branch:** `claude/product-recovery-deploy-candidate`, built forward from
`origin/main`. The recovery line `claude/product-recovery-r1` is preserved unchanged at
`b3e43b3` and was never rebased.

**Nothing has been deployed, merged, or applied to any hosted database.** The one hosted
operation performed was a SELECT-only probe, authorised explicitly by the owner.

---

## Start here

| Document | What it answers |
|---|---|
| [DEPLOYMENT-READINESS.md](DEPLOYMENT-READINESS.md) | **Is it ready?** The verdict, every measured gate, and the open items |
| [RELEASE-1-SCOPE.md](RELEASE-1-SCOPE.md) | What the release closes, and what is deliberately outside it |
| [FUTURE-ROADMAP.md](FUTURE-ROADMAP.md) | Everything NOT in Release 1, and why each was deferred |

## Evidence

| Document | What it establishes |
|---|---|
| [HOSTED-MIGRATION-EVIDENCE.md](HOSTED-MIGRATION-EVIDENCE.md) | **CASE A proven.** Hosted ledger read; high-water `0069` is main's; recovery markers absent; ledger and objects agree |
| [`evidence/hosted-state-2026-09-10.json`](evidence/hosted-state-2026-09-10.json) | The raw probe output — ledger rows and booleans, no credentials, no business rows |
| [MIGRATION-LINEAGE.md](MIGRATION-LINEAGE.md) | The complete 41-row old→new mapping, and how the +1 offset was **computed** rather than assumed |
| [RLS-VERIFICATION.md](RLS-VERIFICATION.md) | What is proven about isolation locally, and what only a deployment can add |

## Procedures

| Document | Use when |
|---|---|
| [RUNBOOK.md](RUNBOOK.md) | Backup/restore, staging deploy, production migration, rollback thresholds, the 16-step smoke checklist, Meta cutover |
| [STAGING-REQUIREMENTS.md](STAGING-REQUIREMENTS.md) | Standing up the environment that does not yet exist |

## Tooling this work added

| Command | Purpose |
|---|---|
| `npm run test:integration` | Core campaign — released migrations only |
| `npm run test:kernel` | R1/R2 kernel campaign — a second database carrying the draft chain |
| `npm run test:draft-schema` | Draft-schema campaign — builds and drops its own database |
| `npm run migration-collision-check` | Base-aware collision gate against `origin/main` |
| `npm run migration-inventory` | The dependency matrix |
| `node scripts/hosted/probe.mjs` | The SELECT-only hosted probe |
| `node scripts/hosted/rehearse-from-ledger.mjs` | Rehearse the pending range against the **real** ledger |
| `node scripts/hosted/migration-attacks.mjs` | The 12-scenario adversarial migration campaign |

---

## The one-line summary

The candidate is integrated, reconciled, and green on every gate that does not require a
deployment — **and it has no deployment axis**, because no staging environment exists and
creating one has a cost only the owner can authorise. Nothing here is `staging_verified`, and
nothing is `production_verified`.
