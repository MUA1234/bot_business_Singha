# Release 1 runbook — staging, migration, rollback, smoke

**None of this has been executed.** Every production step is an owner-approved boundary.

Two rules that govern everything below:

1. **There are no down-migrations for the numbered sequence.** Rollback means restore from
   backup. An unproven restore is not a rollback.
2. **A partially migrated database must never be reported as successful.** The runner applies
   each migration in its own transaction, so an abort leaves earlier ones committed. If a run
   stops, the database is between states and needs the restore path, not a retry.

---

## A. Backup and restore

Do this **before** any migration, on every environment, every time.

```bash
# Backup. Record the byte size and the SHA-256; a backup nobody measured is a hope.
pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" > pre-release1-$(date -u +%Y%m%dT%H%M%SZ).dump
sha256sum pre-release1-*.dump
```

**Restore drill — mandatory, and it is the drill that makes the backup real.** Restore into a
scratch database and confirm the app's own expectations, not just that `pg_restore` exited 0.

```bash
psql "$ADMIN_URL" -c 'create database restore_drill'
pg_restore --no-owner --no-privileges --dbname "$ADMIN_URL_restore_drill" pre-release1-*.dump

# The ledger is the thing that must survive: it decides what runs next.
psql "$ADMIN_URL_restore_drill" -c 'select count(*), min(version), max(version) from schema_migrations'
psql "$ADMIN_URL_restore_drill" -c "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'"
psql "$ADMIN_URL_restore_drill" -c 'drop database restore_drill' 2>/dev/null || true
```

Record the row counts and the high-water mark. If the restored high-water differs from the
source, stop: the backup is not a faithful copy and the rollback path does not exist.

---

## B. Staging deployment

Prerequisite: [STAGING-REQUIREMENTS.md](STAGING-REQUIREMENTS.md). Nothing here works without it.

```bash
# 1. Deploy the exact candidate SHA FROM GIT, so the deployment carries a commit hash.
#    (The production deployment does not — finding PR-F-014 — which is why it cannot be audited.)
railway environment staging
railway up --service singha-web --detach     # or trigger the GitHub deploy for the SHA

# 2. Confirm what actually landed.
railway status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);for(const e of j.environments.edges)for(const si of e.node.serviceInstances.edges)for(const d of si.node.activeDeployments||[])console.log(e.node.name, d.id, d.meta&&d.meta.commitHash||"(NO COMMIT HASH)")})'
```

A deployment with `(NO COMMIT HASH)` cannot be tied to a revision. Redeploy from git.

### Migration, recording every version

```bash
npm run migrate:status     # what is pending, BEFORE
npm run migrate            # applies pending in order, one transaction each
npm run migrate:status     # must report 0 pending
psql "$DATABASE_URL" -c 'select version, filename, applied_at from schema_migrations order by version'
```

Paste the full ledger into the deployment record. "It migrated" is not a record; the rows are.

---

## C. Production migration

**Owner-approved boundary. Not authorised by this document.**

Preconditions:

| # | Precondition | Status |
|---|---|---|
| 1 | The hosted probe run and the case identified — **not assumed** | ✅ **CASE A proven 2026-09-10** ([HOSTED-MIGRATION-EVIDENCE.md](HOSTED-MIGRATION-EVIDENCE.md)) |
| 2 | `STAGING VERIFIED` on a real staging environment | ❌ no environment exists |
| 3 | Backup taken **and restore drilled** (§A) | ❌ needs the hosted window |
| 4 | `RLS_READS` / `RLS_WRITES` set explicitly on the service | ❌ both unset — the app now refuses to start otherwise, so this is **mandatory before any deploy** |
| 5 | A maintenance window, because a partial migration needs a restore | — |
| 6 | Owner approval in writing, for this SHA and this migration set | ❌ |

Production has **no `DATABASE_URL`** on the service (finding H-3), so `npm run migrate` has never
run from it. The connection string is a runbook input, supplied for the window and not persisted
to the service.

### The pending set is known exactly

**41 migrations: `0070` through `0110`.**

Measured, not inferred: the hosted ledger holds **69 contiguous rows** with high-water
`0069_company_routing_and_catalogue_department.sql` applied `2026-09-01T12:10:52Z`. An earlier
estimate of "42, starting with 0069" was one too many — `MIGRATION_STATE.md` stopped one short of
the real ledger, and 0069 is already applied.

**No pending version collides with a recorded one**, so nothing would be silently skipped. This
was rehearsed end-to-end against the real ledger: `scripts/hosted/rehearse-from-ledger.mjs`
reported `applied: 69  pending: 41`, applied all 41, and finished at high-water `0110` with both
lineages' objects present.

**Still confirm against the live ledger in the window.** The probe was read on 2026-09-10; if
anything has been applied since, the set has changed:

```bash
npm run migrate:status     # must report exactly 41 pending, 0070…0110
```

### If it fails partway

Do **not** re-run. Establish where it stopped, then restore.

```bash
psql "$DATABASE_URL" -c 'select max(version), count(*) from schema_migrations'
# then restore from §A, and only then diagnose
```

---

## D. Rollback criteria — decide before, not during

Roll back if **any** of these is true:

| Trigger | Why it is a rollback and not a fix-forward |
|---|---|
| A migration aborts | The database is between states; there are no down-migrations |
| The app refuses to start | Almost certainly configuration; a restore returns a known-good state fastest |
| Cross-company data appears in any read | Isolation failure is the one defect this system treats as critical |
| `/api/health` reports `crit` and does not clear within 10 minutes | Longer is a decision to run degraded |
| Inbound messages stop being written to `source_events` | Meta stops retrying after a bounded period; messages lost here are lost |
| Any customer-visible message is sent that a human did not approve | The autonomy ceiling was breached |

**Rollback = restore the backup, then redeploy the previous revision.** For production that
previous revision currently has no commit hash, so record the image digest
(`sha256:897348ef806c…` as of 2026-09-01) before deploying over it.

---

## E. Post-deployment smoke checklist

Run in order. Stop at the first failure.

| # | Check | Pass condition |
|---|---|---|
| 1 | `GET /api/health` | 200, level not `crit` |
| 2 | Sign in as a seeded staging user | Session established, dashboard renders |
| 3 | Company isolation | A member of company A cannot see company B's items in any list |
| 4 | Scheduler is running | Logs show scheduled ticks; **no** `cron.scheduler_disabled` |
| 5 | Exactly one scheduler | `vercel.json` declares no cron; Railway has one replica; no external caller of `/api/cron/*` |
| 6 | `management-cycle` honest when off | With `MANAGEMENT_KERNEL` unset it returns `status: "disabled"` with a reason — not a silent success |
| 7 | `management-cycle` with the kernel on | Returns `completed`/`partial` with `companiesSwept` ≥ 1 |
| 8 | Lifecycle advances | A seeded evidenced item moves `observed` → `understood` **without anyone pressing anything** |
| 9 | Human boundary holds | The service role cannot perform `recommended → awaiting_approval → approved`; a person can |
| 10 | Assignment is human | Assignment requires `operations.task.manage`; the service role is refused |
| 11 | The single automated action | `ops.task.create_internal` creates an **unassigned** task; every other catalogue action fails closed |
| 12 | Ask-AI is advisory | No tool, no function, no execution path; answers only |
| 13 | Inbound webhook | Signature verification rejects an unsigned POST; a signed test payload writes a `source_events` receipt |
| 14 | Company resolution | An **unmapped** number resolves `unmapped` and is NOT dispatched to any company |
| 15 | No outbound effects | No message sent, no payment, no external call, during the whole smoke run |
| 16 | Rollback | Restore the backup taken at step 0 and confirm the app runs against it |

Step 16 is not optional. A rollback that has never been executed is a plan, not a capability.

---

## F. Webhook / Meta cutover — separate approval

**Not part of Release 1 deployment.** Recorded because it is the outstanding P0 (R0-F-001) and
someone will ask.

As probed on 2026-09-01, every Vercel path returned HTTP 402 `DEPLOYMENT_DISABLED`, including
`/api/webhooks/whatsapp`. If Meta still points at Vercel, inbound customer messages are being
delivered to a dead origin and Meta stops retrying after a bounded period.

| # | Step |
|---|---|
| 1 | Read Meta App Dashboard → WhatsApp → Configuration → Webhook callback URL. **Read only.** |
| 2 | If it names a `*.vercel.app` origin, inbound messaging is down now — that is the finding, not a theory |
| 3 | Confirm the Railway origin verifies: `GET /api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…` returns the challenge |
| 4 | Repoint to the Railway origin — **owner-approved production change** |
| 5 | Send one message from a test number; confirm a `source_events` row appears |
| 6 | Watch for redelivery of anything Meta buffered |

Rollback: repoint to the previous URL. Meta's callback change takes effect immediately, so the
blast radius is bounded — which is the one merciful property of this particular change.
