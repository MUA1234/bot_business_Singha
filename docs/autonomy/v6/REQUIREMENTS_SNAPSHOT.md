# SINGHA AI BUSINESS MANAGER — REQUIREMENTS SNAPSHOT V6

This is a human-readable checkpoint, not a replacement for `docs/autonomy/ORIGINAL_VISION_REQUIREMENTS.yaml` or the repository audit.

## Current totals

| Status | Count | Completion treatment |
|---|---:|---|
| `locally_verified` | 13 | verified locally only |
| `absent` | 41 | incomplete/implementable |
| `specified` | 6 | incomplete/implementable |
| `foundation_only` | 22 | incomplete/implementable |
| `implementation_in_progress` | 3 | incomplete/implementable |
| `blocked_owner` | 4 | incomplete; owner action required |
| `deliberately_deferred` | 1 | excluded only with explicit impact acceptance |
| **Total** | **90** | **72 implementable remain** |

## Verified requirement IDs

`FOUND-001`, `FOUND-002`, `FOUND-004`, `FOUND-005`, `AIM-001`, `AIM-002`, `FIN-001`, `FIN-002`, `FIN-003`, `SCH-006`, `COM-001`, `CTL-001`, `OPS-001`.

## Active or next-boundary IDs

- `OF-016`: implementation and both correction loops exist, but local acceptance must be recorded at the exact frozen SHA.
- `OF-018`: next bounded trust cleanup.
- `MOD-003`: provider-neutral Model Gateway and Policy Router; specified, no production caller.
- `IP-001`: public-repository anti-clone/IP boundary; in progress.
- `FOUND-006`: service-role/RLS read-write cutover remains in progress and OF-017 stays visible.
- `AIM-003`: truthful task routing remains in progress.

## Owner-blocked IDs

- `FOUND-003`: live finance classifier/provider plus receiving-number mapping, queue grant and hosted migration.
- `MOD-001`: live-model evaluation credential.
- `OPS-004`: staging UAT/authenticated browser-role testing.
- `OPS-008`: monitored production pilot.

## Deliberately deferred

- `COM-008`: live voice.

## Material capability groups still incomplete

- Governance: directives, conflict resolution, reserved matters and accountable override.
- Workforce: capacity, skills/certifications, coaching and fair team formation.
- Projects: budgets, milestones, risks, decisions and portfolio prioritisation.
- Finance: commitments, budget-v-actual, scenario analysis, investments and complete payment intelligence.
- CRM: canonical identities are foundations; provider/compliance/performance workflows remain incomplete.
- Scheduling: leave-aware scheduling, handovers, meetings and mature escalation.
- Communications: documents, voice notes, email, calendar, approved connectors and handover/opt-out.
- Assets: registry, custody, reservations, meter readings, maintenance, utilisation and optimisation are specified but not implemented.
- Cross-application integration: provider/app registry and canonical connector contracts are absent.
- Multilingual/mobile: Sinhala/Tamil/English runtime, accessibility, PWA/offline and versioned mobile APIs are incomplete.
- Improvement/risk/operations: outcome learning, playbooks, risk registers, backup/restore, incident response and production readiness remain incomplete.

## Dependency-aware order

1. Bootstrap V6 and accept/remediate OF-016.
2. OF-018 trust cleanup.
3. MOD-003 Model Gateway, then MOD-002 cost-ledger completeness.
4. IP-001 before proprietary prompt/evaluation/routing logic expands.
5. Finish FOUND-006/AIM-003 repository-controlled work without crossing owner gates.
6. Workforce/capacity/fair routing and AI management control loop.
7. Governance/projects/finance/CRM/scheduling/communications.
8. Asset Intelligence and cross-application Integration Gateway.
9. Multilingual/mobile/accessibility.
10. Improvement/risk/operations hardening.
11. Privacy-approved GPS/CCTV only after separate approval.
12. Staging, backup/restore, authenticated browser/RLS, and controlled production pilot after owner gates.

Conductor must recalculate this order from the live register after every accepted slice. A requirement is verified only with a production-reachable entrypoint, durable state where applicable, permissions/company isolation, audit/monitoring, discriminating tests and an exact tested SHA.
