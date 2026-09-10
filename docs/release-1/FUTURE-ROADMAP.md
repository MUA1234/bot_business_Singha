# Future roadmap — explicitly NOT Release 1

Kept separate so nothing here is mistaken for a Release 1 blocker, and so that "we should also
do X" has somewhere to go that is not the release.

**Nothing below was started.** Release 1's scope is
[RELEASE-1-SCOPE.md](RELEASE-1-SCOPE.md).

---

## Deferred by owner instruction

| Item | Why it is not Release 1 |
|---|---|
| Email, Google Sheets, voice | New integration surfaces. No Release 1 capability depends on one |
| CCTV, GPS | Gated behind notices, a retention policy and legal review (`docs/SECURITY_AND_PRIVACY_MODEL.md`) |
| Marketplace, points | Product expansion, not loop closure |
| Additional AI agents | The autonomy ceiling is one catalogue action. More agents widen it |
| Additional automated actions | Same. Widening the ceiling is an owner decision, not an engineering one |
| Multi-country | Out of scope |
| Facial recognition | Requires separate written approval |

## Deferred by engineering judgement, with the reason

### R2F-F-019 — a PostgREST transport for the execution ledger

**Status: open, registered, and honestly reported at runtime.** `makeCycleDeps` supplies no
execution SQL transport; the orchestrator records an explicit "execution transport unavailable"
hold against the item and marks the cycle partial. It never reports the item as advanced, and a
test asserts that absence so the contract cannot change silently.

**Why it was not closed in this pass.** `SqlExec` is a raw SQL executor, and PostgREST cannot be
one. A faithful implementation means changing the shape of the ports, and the seven service
queries include correlated subqueries, a capability join and an ordered content digest — none
expressible in PostgREST without either new SECURITY DEFINER RPC functions (a migration, and a
new production surface) or decomposition into several round trips with the joins computed in
TypeScript. The second option moves the company re-check **out of SQL**, where it currently lives
per-row, and that is the property the whole path exists to hold.

**It changes nothing operationally.** `EXECUTION_GLOBALLY_ENABLED` is `false as const`, so no
deployment can execute anything regardless of transport. The transport is the second lock on a
door whose first lock is welded shut.

**When it is done:** design the RPC surface first, with the company re-check inside each function,
and review it as new security-sensitive code rather than as a port.

### Enabling execution at all

`EXECUTION_GLOBALLY_ENABLED = false as const` — deliberately not an environment variable, not a
flag, not a database row. Turning it on is a code change, in a reviewed diff, in a commit with an
author. **This was not touched**, because enabling autonomous business effects is a change to
what the system may do without a person, which is the owner's decision and not an implementation
detail.

Release 1 ships the *capability* to execute exactly one action, gated shut. Opening the gate is a
separate, explicit act.

### The management cycle's own audit writes (D-4)

`writeAudit` goes through the Supabase REST client, so in a database-only test environment it
throws and is caught. Audit **is** verified elsewhere — five core suites assert `audit_events`
rows directly in SQL — but the `management_cycle.*` actions specifically are not. Closing it means
either giving the kernel campaign a PostgREST endpoint or letting `writeAudit` take an injected
client, as the rest of the kernel does. The second is smaller and matches the existing pattern.

### R2F-F-020 — automatic authority with no actor membership

The authority engine fails closed on a null actor membership, so no cycle-created item resolves
to `automatic` authority. **Deliberately unrepaired**: lowering it would weaken an authority
control. Whether an unattended cycle may resolve `automatic` when there is no actor by
construction is a product decision, not a bug. The manual approval path covers the gap today.

### R2F-F-015 — `POLARITY.reopened = -1` regardless of source

Open, pinned by a permanent gate so it cannot drift further while it waits.

---

## Operational items that need an owner, not code

| Item | Action |
|---|---|
| **Model spend** | `ai-monitor` has run hourly since 2026-09-01 against a live key. The candidate adds `MODEL_JOBS=off`, which stops it **without** stopping outbox and inbound recovery. Applying it to production is a production configuration change |
| **Deployment provenance** | The running artifact has no commit hash (`railway up` from the CLI). Only a fresh deployment from git fixes this |
| **The Meta webhook** | Every Vercel path returned 402 on 2026-09-01. Where Meta points is unverified, and repointing is a production boundary ([RUNBOOK.md](RUNBOOK.md) §F) |
| **A staging environment** | Does not exist; creating one has a cost ([STAGING-REQUIREMENTS.md](STAGING-REQUIREMENTS.md)) |
| **The R1 draft migrations** | 28 units quarantined outside the numbered sequence under owner decision R1-D-1. Promoting them to production numbers is a separate numbering decision, after this reconciliation lands |
