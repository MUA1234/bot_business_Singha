# Asset Intelligence — registry, utilization and optimization

> **IMPLEMENTATION STATUS: NOT STARTED.** No table, migration, runtime code, UI or test for any of
> this exists in the repository. The branch reconciliation
> (`docs/verification/BRANCH_RECONCILIATION.md`) confirmed it has never existed on any branch or in
> any pull request. This document is the authoritative specification so the program cannot go
> missing again; it is not a description of built software, and nothing here may be reported as
> available, partial or in progress.
>
> Scope note: "asset" elsewhere in this codebase means an **accounting** asset account, or the
> free-text `involved.assets[]` field an AI observation fills in and nothing reads. Neither is this.

## 1. Unified asset registry

One registry for every asset class the business controls — vehicles, plant and machinery, tools,
IT equipment, furniture, property and leases — replacing the vehicle-only `vehicles` table by
generalising it, not by duplicating it.

- Company-scoped identity: `company_id` on every row, enforced by RLS and by composite foreign keys
  the way `quotation_items` and `tasks` already are.
- Stable identifiers: internal asset code (unique per company), plus optional serial, VIN,
  registration, IMEI, barcode. Duplicate detection across all identifier types, not just one.
- Classification: category, sub-category, make, model, year, specification.
- Ownership: owned / leased / rented / customer-supplied, with the contract or lease reference.
- Lifecycle states and the legal transitions between them: `planned → acquired → in_service →
  under_maintenance → idle → reserved → disposed`. Reactivating a disposed asset is refused;
  deletion is refused once any history exists (correct by reversal, never by erasure — the rule the
  accounting core already follows).

## 2. Custody and location history

- Append-only custody records: who holds the asset, from when, at which site, under which project.
- Location history independent of custody (an asset can move without changing hands).
- Condition evidence at each handover (photographs, notes, meter reading), preserved as documents.
- **Conflict adjudication:** when a message contradicts stored custody, the stored record is the
  source of truth and the discrepancy becomes a task — the system must never silently accept the
  newer prose. The verification campaign's scenario CNF-01 exists for exactly this and is currently
  untestable because no custody layer exists.

## 3. Assignments and reservations

- Assign, return, reassign — each an audited transition with an actor and a timestamp.
- Forward reservations with a start and end, per asset.
- **Overlapping reservations must be impossible**, enforced in the database (an exclusion
  constraint over an asset and a time range), not only in application code — the same standard the
  quotation delivery boundary is held to.
- Concurrent reservation attempts from two connections must resolve to exactly one winner.
- Reserving an out-of-service or disposed asset is refused.
- Timezone and date-boundary behaviour specified and tested explicitly.

## 4. Meter readings

- Readings per asset with unit (km, hours, cycles), timestamp, source and recorder.
- A reading that decreases is refused or flagged for correction, never silently accepted.
- Missing readings are **missing**, never zero — an asset with no reading has unknown utilization,
  and the distinction must survive into every downstream calculation and screen.

## 5. Utilization and downtime

- Utilization derived from custody, reservations, trips and meter deltas, over an explicit window.
- Downtime attributed to a cause: maintenance, fault, idle, unavailable, unknown.
- **Confidence and data sufficiency are first-class outputs.** "No reliable usage data" is a
  distinct result from "low utilization", and no proposal may treat the first as the second.

## 6. Maintenance and compliance

- Schedules by date and by meter, plus recurring schedules.
- Overdue detection, completion recording, and cost capture per event.
- Compliance items with expiry: insurance, licence, permit, warranty, inspection.
- Expiries surface as dated tasks routed to a responsible person — not as a dashboard number
  nobody owns.
- Repair-versus-replace recommendation, with the evidence and assumptions behind it.

## 7. Cost and TCO

- Acquisition, depreciation, maintenance, fuel/energy, insurance, finance and disposal cost.
- **Exact decimal money throughout**, multi-currency, no implicit conversion — the standard already
  enforced in `src/lib/money.ts` and in the authority engine.
- TCO per asset, per period and per unit of output, with the inputs traceable.

## 8. Optimization proposals

Proposals only. Nothing executes. Every proposal must cite:

- the evidence it rests on, with links to the underlying records;
- confidence, and explicitly whether the data was sufficient;
- expected benefit, quantified in exact money where money is involved;
- risk and reversibility;
- the required authority, resolved by the deterministic engine in
  `src/policy/authority-engine.ts` — never by the model.

Proposal types: dispose, reallocate, share across projects, defer purchase in favour of an idle
internal asset, address a capacity shortage, retire a duplicate or redundant asset.

## 9. Integration

- **Procurement:** a purchase request for something the company already owns and has idle must
  surface that asset before the order is raised.
- **Finance:** acquisition and disposal produce *proposed* accounting work only. The AI never posts
  a journal — the existing rule, unchanged.
- **Tasks:** maintenance, compliance and custody discrepancies create routed tasks with an owner.
- **Providers:** external service providers and their compliance status.

## 10. Security, isolation and concurrency

- RLS on every table; cross-company reads and writes proven impossible by test, not asserted.
- Capability-gated writes, following the existing `0048` sensitive-write pattern.
- Audit events for every state transition, custody change, reservation and proposal decision.
- Concurrency proven with two real database connections: reservation races, custody-versus-
  maintenance races, and simultaneous conflicting assignment.
- Service-only RPCs pinned to the canonical `search_path` and locked to `service_role`, per
  migrations 0062 and 0067.

## 11. Asset Control UI

Register, asset detail with full history, custody and reservation calendars, maintenance queue,
compliance expiry queue, utilization views that distinguish "no data" from "low", and an optimization
proposal review screen where a human accepts or rejects with a recorded reason.

## 12. Flags and rollout

Every capability behind a **default-OFF** flag in `src/config/flags.ts`, enabled only by owner
authorisation after staging UAT. Read-only surfaces ship before write surfaces; proposals ship in
shadow before they are shown to staff.

## 13. Explicitly out of scope

GPS tracking and CCTV integration remain **gated** and are not part of this program. They require
separate legal and privacy review under `docs/SECURITY_AND_PRIVACY_MODEL.md`, and no part of this
specification may be used to introduce them.
