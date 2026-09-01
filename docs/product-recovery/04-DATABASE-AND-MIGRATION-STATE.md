# 4. Database and migration-state assessment

## 4.1 Schema scale (branch line, `abc7767e`)

| Measure | Count |
|---|---|
| Migration files | **109** (`0001`–`0109`, no gaps; `migration-lint` enforces this) |
| Migration SQL | 16,501 lines |
| Tables created | 146 |
| Functions created | 109 |
| Tables with RLS explicitly enabled | 74 |

On the deployed line (`main`) the corresponding figures stop at migration **0069**.

## 4.2 Live database state — what can and cannot be established

**The Supabase MCP connector is not authenticated in this session**, so the live schema
could not be inspected directly. This is a hard limit on deliverable 4 and is reported
rather than worked around. Authorising the `claude.ai Supabase` connector (via
claude.ai connector settings) or supplying a read-only `DATABASE_URL` would let
`npm run migrate:status` answer this definitively in one command.

What the repository records:

| Environment | Record |
|---|---|
| Local | No local database provisioned; tests run against disposable PostgreSQL 16 with a Supabase compatibility shim |
| Staging | DB `gazjughejdzebathpscb`, **baselined 2026-08-06 at 35 applied / 0 pending**; migrations 0023–0041 applied 2026-08-06/07 |
| Production | Supabase project; owner applies SQL manually. **0001–0013 owner-confirmed 2026-08-05; 0014–0022 "reported applied, unverified"; 0038–0041 owner-confirmed 2026-08-07; 0042 onward "owner confirmation required" (i.e. not applied)** |

<a id="pr-f-004"></a>
### PR-F-004 (P0) — The authoritative record contradicts the deployed code

`docs/architecture-v2/MIGRATION_STATE.md` declares itself *"the authoritative
migration-state document"* and states, unambiguously:

> This development process has **not** applied any migration to a hosted database and has
> **not** enabled any feature flag.
>
> Everything from **0042 through 0067** has hosted state "owner confirmation required".

But the deployed `main` code **requires migration 0069**. Commit `252e5a1` ("replace
hardcoded company, department and currency with real routing (0069)") introduced
`src/lib/whatsapp-inbound.ts`, which resolves the company from
`companies.whatsapp_phone_number_id` — a column that only migration 0069 creates. That
code is live, and D-021 records the deployment as "health-green", with real customer
conversations observed on 2026-09-01.

Exactly one of these is true:

1. **The record is stale.** Migrations 0042–0069 were applied to production by the
   owner, and `MIGRATION_STATE.md` was never updated. Most likely.
2. **Production is running code ahead of its schema.** The routing lookup fails on a
   missing column, and inbound company resolution is silently falling back — which
   would be a live cross-company attribution risk.

**These are very different situations and the repository cannot distinguish them.**
Resolving this is the single highest-value owner action in the audit, and it takes
minutes: run `npm run migrate:status` against production, or query
`select version from schema_migrations order by version`.

Until it is resolved, **no migration should be applied to production**, because the
starting point is unknown.

<a id="pr-f-011"></a>
### PR-F-011 (P2) — 41 migrations have no state record

`MIGRATION_STATE.md` tracks 0001–0068. Migrations **0069–0109 appear in it nowhere** —
confirmed by direct search for each of 0069, 0075, 0080, 0085, 0090, 0095, 0100, 0105
and 0109 (zero matches each). Outside that file, `0109` is mentioned only in two
hard-scenario campaign documents.

So 41 of 109 migrations — including the entire durable-inbound, task-routing,
model-gateway, risk, directive, integration-gateway and compliance body of work — have
**no per-environment applied-state record at all**. The document that the repository
designates as the one place to track applied state stopped being maintained at the
point where the branch line diverged.

## 4.3 The migration-runner defect

`scripts/migrate.mjs`:

```js
const version = (f) => f.slice(0, 4);
await c.query(`create table if not exists schema_migrations (version text primary key, …)`);
const applied = new Set((await c.query("select version from schema_migrations")).rows.map(r => r.version));
const pending = files.filter((f) => !applied.has(version(f)) && (!upto || version(f) <= upto));
```

The ledger key is the numeric prefix alone, and the filename is stored but never
compared. Therefore:

- **A number collision silently skips a migration** (PR-F-001). No warning, no failure.
- **A renamed migration is a no-op**; a *re-numbered* one re-runs.
- **Drift is undetectable** — `migrate:status` compares numbers, so a database that ran
  `0069_company_routing…` and a repository containing `0069_durable_inbound_processing…`
  report as fully in sync.

**Recommended (not implemented during Phase 0):** make the ledger key
`(version, filename)` or store and verify a content hash, and fail closed when the
recorded filename or hash for an applied version does not match the file on disk. This
single change converts PR-F-001 from a silent-corruption path into a loud one, and
should land before any renumbering work.

## 4.4 Data-model observations relevant to the recovery

**The schema is already broader than the product.** Tables exist for risks, incidents,
insurances, obligations, contracts, licences, service providers, investments, funding
requirements, project scenarios, management directives, integration contracts, model
budget policies, duplicate reviews, inbound reviews and task routing events. The
management OS the owner describes is, to a large extent, **already modelled**. What is
missing is the loop that reads and acts on it.

**Company scope is consistently modelled.** Composite company foreign keys (0009, 0024,
0060) enforce parent/child same-company consistency at the database level — a stronger
guarantee than application-side filtering.

**Two competing inbound models now coexist across the lines** (PR-F-003): `main`'s
`companies.whatsapp_phone_number_id` and the branch's `channel_accounts` /
`channel_identities` / `resolve_channel_company`. The reconciliation must pick one.
The branch's is channel-agnostic and is the right target for an OS that must ingest
email, documents and connectors; the migration must map existing production values into
it.

**Delivery-boundary hardening is exceptional and must not be disturbed.** Migrations
0063–0067 close the quotation delivery boundary against enqueue races, stale outbox
rows, direct-table transitions, claim-then-delete races, snapshot divergence and
`pg_temp` relation shadowing, with a catalog-driven `search_path` audit and a permanent
regression gate. Ten external review loops produced this. Any renumbering must preserve
the ordering and the self-verifying assertions inside these files verbatim.

## 4.5 Verification commands the owner (or an operator) should run

Read-only, safe, and they resolve PR-F-004 and PR-F-011 in one sitting:

```bash
# Against production DATABASE_URL — read-only
npm run migrate:status                     # applied vs pending, exits 1 on drift

# Or directly:
select version, filename, applied_at from schema_migrations order by version;
select column_name from information_schema.columns
  where table_name = 'companies' and column_name = 'whatsapp_phone_number_id';
```

The second query is the decisive one for PR-F-004: if the column exists, production is
at 0069 and the record is merely stale; if it does not, deployed code is ahead of the
schema and inbound routing needs immediate inspection.
