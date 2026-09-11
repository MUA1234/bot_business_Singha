# Future roadmap — explicitly NOT Release 1

Kept separate so nothing here is mistaken for a Release 1 blocker, and so that "we should also
do X" has somewhere to go that is not the release.

**Two items below were subsequently CLOSED and are kept here, struck through, with what closed
them** — R2F-F-019 and the execution boundary. Deleting them would remove the record of why they
were deferred, which is the more useful half. Everything else below is untouched. Release 1's
scope is [RELEASE-1-SCOPE.md](RELEASE-1-SCOPE.md).

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

### ~~R2F-F-019 — a PostgREST transport for the execution ledger~~ — **CLOSED**

This section previously read "open, registered, and honestly reported at runtime", and the
reasoning for deferring it was the first option in its own "when it is done" paragraph: *design
the RPC surface first, with the company re-check inside each function, and review it as new
security-sensitive code rather than as a port.* That is what was built.

**What it was.** `executeManagementAction` reached its ledger and its four loaders through
`SqlExec`, a raw SQL executor. The request path speaks PostgREST, which cannot run SQL text, so
`makeCycleDeps` supplied no transport at all and the orchestrator recorded an "execution transport
unavailable" hold on every approved item. The loop's one authorised effect was unreachable from
the deployed graph.

**What closed it.** `R1_DRAFT_029_execution_transport` — a draft unit, not a numbered migration,
because every table it touches lives in the quarantined draft chain and the 2026-09-11 hosted
probe confirmed production has none of them. It defines **seven** named functions, and the
signature list is asserted exactly by the migration itself, so a `create or replace` that changes
an argument list cannot leave the old one behind as a reachable overload.

The fix that was **not** taken is an RPC that runs SQL text. Nothing here accepts any: every
argument is explicitly typed, no function body contains dynamic execution, and a test enumerates
`pg_proc` to prove both.

| Property | How it is held |
|---|---|
| No caller-supplied company trust | Every function re-reads the row's own `company_id` and compares |
| No caller-supplied authority, approver, membership or entitlement | No such argument exists; the approver is derived inside the transaction |
| **No caller-supplied parameters at all** | The execute reads `planned_parameters` from the plan row. A first draft took `p_title` and was a hole with a comment above it saying otherwise |
| Exact action matching | `is distinct from 'ops.task.create_internal'` — four lookalikes are tested |
| Both switches | The company enablement row **and** a server-side `r1_exec_global_boundary` row, each refusing on its own |
| Atomic | Claim, effect and terminal ledger row are one transaction. Ten concurrent callers produce one task and one ledger row |
| Refusals cost nothing | A refusal writes no task, no ledger row, and consumes no idempotency key — the same key still executes afterwards |
| Service-only | `EXECUTE` revoked from `PUBLIC`/`anon`/`authenticated`, granted to `service_role`, **and** an in-function `caller_jwt_role()` gate |

**Proof.** `tests/integration/r2f-postgrest-execution.test.ts` drives the whole loop through
`makeCycleDeps` with **no** SQL transport injected — the shape a server process builds — and
compares the resulting ledger row and task field-by-field against the SQL transport for the same
scenario. `tests/integration/r2f-postgrest-adversarial.test.ts` is 28 named attacks.

Two disagreements the parity suite found, both now settled in the code and explained there: the
ledger records **no approver** for an automatic execution while the task records the person who
approved the item, and the ledger's `resolved_authority` is the executor's canonical resolution
(`automatic`), not the approval's level.

### Enabling execution at all

`EXECUTION_GLOBALLY_ENABLED = false as const` **was** the design, and it was the better one: no
deployment could turn execution on, so turning it on was a code change in a reviewed diff.

It is now `EXECUTION_ENABLED`, a server variable, default off. **This is a real reduction in
strength and is recorded as one.** It changed for one reason: staging cannot verify the loop's
single authorised effect without producing it once, and a constant cannot be true in staging and
false in production. Shipping a Release 1 whose one automated effect had never been observed
working anywhere was the alternative.

What was kept, each asserted by a test in `tests/kernel/execution-boundary.test.ts` (28 tests,
including seven named mutation checks):

* default false — missing, empty, or anything that is not exactly `"on"`;
* never a `NEXT_PUBLIC_*` variable, and a test reports one if it is ever introduced;
* it cannot widen the action allowlist — that is a single-member union and a policy table, and
  neither reads the environment;
* it is independent of the model-job control, so stopping spend and stopping execution stay two
  decisions;
* it does not bypass the per-company boundary, nor the server-side boundary row;
* and it is reported at **startup**, at error level when on, with names and booleans only.

**Production remains disabled**, and that is now a property of production's configuration rather
than of the source. Opening the gate is still a separate, explicit act — it is simply an act an
operator can perform, which is what staging verification requires.

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
| **The R1 draft migrations** | **29** units quarantined outside the numbered sequence under owner decision R1-D-1 — the twenty-ninth is the execution transport that closed R2F-F-019, and it is a draft unit for the same reason as the other twenty-eight: every table it touches is in the quarantined chain, and the hosted probe confirmed production has none of them. Promoting them to production numbers is a separate numbering decision, after this reconciliation lands |
