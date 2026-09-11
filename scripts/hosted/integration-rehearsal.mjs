#!/usr/bin/env node
/**
 * The eight integration rehearsals, on disposable databases.
 *
 * The chain is now `0001`–`0143`: main's `0070` kept its number and the candidate's own sequence
 * moved up by one. Every earlier rehearsal measured a different chain, so none of them is evidence
 * about this one.
 *
 * The interesting scenario is 4. Production reportedly has the ledger at `0069`, main's `0070`
 * data repair ALREADY APPLIED over REST, and no `0070` ledger row. That is not a hypothetical
 * shape — it is the shape — and the question the owner asked is whether running the release
 * process against it duplicates, corrupts or partially applies anything.
 *
 * Every scenario reports: starting ledger, starting markers, attempted, committed, ending
 * high-water, object checks, data-integrity checks, rollback result.
 *
 * Usage:
 *   DATABASE_URL=postgres://…@127.0.0.1:PORT/postgres node scripts/hosted/integration-rehearsal.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import pg from "pg";

const ADMIN = process.env.DATABASE_URL;
if (!ADMIN) { console.error("DATABASE_URL is required"); process.exit(2); }
if (!/127\.0\.0\.1|localhost|\[::1\]/.test(ADMIN)) {
  console.error("REFUSED: creates and destroys databases — LOCAL only."); process.exit(2);
}

const MIG_DIR = "src/db/migrations";
const ROLLBACK_DIR = "src/db/rollback";
const MAIN_0070 = "0070_identity_backfill_and_event_lifecycle.sql";

const files = readdirSync(MIG_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const TOTAL = files.length;
const HIGH = files.at(-1).slice(0, 4);

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { if (ok) { pass++; console.log(`    PASS  ${n}`); } else { fail++; console.log(`    FAIL  ${n}${d ? `\n            ${d}` : ""}`); } };
const section = (n) => console.log(`\n${"═".repeat(78)}\n${n}\n${"═".repeat(78)}`);
const report = (label, v) => console.log(`    · ${label}: ${v}`);

const admin = new pg.Client({ connectionString: ADMIN, ssl: false });
await admin.connect();
const urlFor = (db) => { const u = new URL(ADMIN); u.pathname = `/${db}`; return u.toString(); };
const dbs = [];

async function freshDb(name) {
  dbs.push(name);
  await admin.query(`drop database if exists "${name}" with (force)`);
  await admin.query(`create database "${name}"`);
  const url = urlFor(name);
  execFileSync("node", ["scripts/apply-sql.mjs", "tests/integration/helpers/supabase-shim.sql"],
    { env: { ...process.env, DATABASE_URL: url, PGSSL: "disable" }, stdio: "pipe" });
  return url;
}
const migrate = (url, extra = {}) => execFileSync("node", ["scripts/migrate.mjs"],
  { env: { ...process.env, DATABASE_URL: url, PGSSL: "disable", ...extra }, encoding: "utf8", stdio: "pipe" });

async function q(url, sql, params = []) {
  const c = new pg.Client({ connectionString: url, ssl: false });
  await c.connect();
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}
async function ledger(url) {
  const [r] = await q(url, `select count(*)::int n, min(version) lo, max(version) hi from schema_migrations`);
  const d = await q(url, `select version from schema_migrations group by version having count(*)>1`);
  return { n: r.n, lo: r.lo, hi: r.hi, dupes: d.length };
}

/**
 * The rows main's 0070 exists to repair, seeded so the repair has something to do.
 *
 * Every one is a real defect shape from `a4e433e`: a profile with no identity rows, a source event
 * the database can prove was handled, and rows whose author is a COMPANY id.
 */
async function seedRepairable(url) {
  const c = new pg.Client({ connectionString: url, ssl: false });
  await c.connect();
  try {
    await c.query(`select set_config('request.jwt.claims','{"role":"service_role"}',false)`);
    const co = "0000aaaa-0000-4000-8000-000000000001";
    await c.query(`insert into companies (id,name,base_currency) values ($1,'Rehearsal Co','LKR')
                   on conflict (id) do nothing`, [co]);
    // Two profiles with NO users/memberships rows — the A1/A2/A3 defect.
    for (const [i, isAdmin] of [[1, false], [2, true]]) {
      const uid = `0000aaaa-0000-4000-8000-00000000010${i}`;
      await c.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [uid]);
      await c.query(`insert into profiles (id, company_id, username, full_name, department, is_active, is_admin)
                     values ($1,$2,$3,'Rehearsal Person','operations',true,$4) on conflict (id) do nothing`,
        [uid, co, `reh${i}`, isAdmin]);
    }
    // A deactivated profile WITH an active membership — the A4 defect.
    const sus = "0000aaaa-0000-4000-8000-000000000109";
    await c.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [sus]);
    await c.query(`insert into users (id, full_name, is_active) values ($1,'Suspended',false)
                   on conflict (id) do nothing`, [sus]);
    await c.query(`insert into profiles (id, company_id, username, full_name, department, is_active, is_admin)
                   values ($1,$2,'rehsus','Suspended','operations',false,false) on conflict (id) do nothing`, [sus, co]);
    await c.query(`insert into memberships (company_id,user_id,status) values ($1,$2,'active')
                   on conflict (company_id,user_id) do update set status='active'`, [co, sus]);
    // Rows authored by a COMPANY id — the C defect.
    await c.query(`insert into tasks (company_id,title,status,created_by) values ($1,'rehearsal mis-authored','captured',$1)`, [co]);
    return { co };
  } finally { await c.end(); }
}

/** What the repair should have achieved — the read-only predicates. */
async function repairPredicates(url) {
  const co = "0000aaaa-0000-4000-8000-000000000001";
  const [p] = await q(url, `select
      (select count(*)::int from profiles p where p.company_id=$1
         and not exists (select 1 from users u where u.id=p.id))                       as profiles_without_users,
      (select count(*)::int from profiles p where p.company_id=$1
         and not exists (select 1 from memberships m where m.user_id=p.id and m.company_id=p.company_id)) as profiles_without_membership,
      (select count(*)::int from memberships m join profiles p on p.id=m.user_id and p.company_id=m.company_id
         where m.company_id=$1 and p.is_active=false and m.status='active')            as suspended_but_active,
      (select count(*)::int from tasks t where t.company_id=$1 and t.created_by is not null
         and exists (select 1 from companies c where c.id=t.created_by))               as company_authored_tasks,
      (select count(*)::int from memberships where company_id=$1)                       as memberships,
      (select count(*)::int from membership_roles where company_id=$1)                  as role_grants,
      (select count(*)::int from users)                                                 as users
    `, [co]);
  return p;
}

const applyMainRepairManually = async (url) => {
  // Exactly what the REST applier did to production: the migration's effects, no ledger row.
  const sql = readFileSync(`${MIG_DIR}/${MAIN_0070}`, "utf8");
  const c = new pg.Client({ connectionString: url, ssl: false });
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
};

let code = 1;
try {
  console.log(`chain: ${TOTAL} migrations, 0001–${HIGH}`);

  // ═══ 1. fresh ═══════════════════════════════════════════════════════════════════════════
  section("SCENARIO 1 — fresh database, 0001–" + HIGH);
  {
    const url = await freshDb("ir_fresh");
    report("starting ledger", "none (empty database)");
    report("starting markers", "none");
    const out = migrate(url);
    const applied = (out.match(/✅ applied/g) ?? []).length;
    report("attempted / committed", `${TOTAL} / ${applied}`);
    const l = await ledger(url);
    report("ending high-water", l.hi);
    check(`${TOTAL} rows, one ledger, no duplicates`, l.n === TOTAL && l.dupes === 0 && l.hi === HIGH, JSON.stringify(l));
    check("no second ledger table",
      (await q(url, `select to_regclass('public.r1_draft_migrations') x`))[0].x === null);
    const missing = [];
    for (const t of ["management_items", "management_cycle_leases", "management_execution_attempts", "ask_ai_threads"]) {
      if (!(await q(url, `select to_regclass($1) x`, [`public.${t}`]))[0].x) missing.push(t);
    }
    check("object checks: management tables present", missing.length === 0, missing.join(", "));
  }

  // ═══ 2. main-only, then the candidate ═══════════════════════════════════════════════════
  section("SCENARIO 2 — through main's 0070, then the candidate's 0071–" + HIGH);
  {
    const url = await freshDb("ir_mainonly");
    migrate(url, { MIGRATE_UPTO: "0070" });
    const mid = await ledger(url);
    report("starting ledger", `${mid.n} rows, high-water ${mid.hi}`);
    check("stops exactly at main's 0070", mid.n === 70 && mid.hi === "0070", JSON.stringify(mid));
    const out = migrate(url);
    const applied = (out.match(/✅ applied/g) ?? []).length;
    report("attempted / committed", `${TOTAL - 70} / ${applied}`);
    const l = await ledger(url);
    report("ending high-water", l.hi);
    check(`reaches ${TOTAL} / ${HIGH}`, l.n === TOTAL && l.hi === HIGH && l.dupes === 0, JSON.stringify(l));
    const [fk] = await q(url, `select count(*)::int n from pg_constraint c join pg_class cl on cl.oid=c.conrelid
       where cl.relname='management_item_evidence' and c.contype='f' and array_length(c.conkey,1)=2`);
    check("object checks: composite tenant FKs present", Number(fk.n) > 0, `${fk.n}`);
  }

  // ═══ 3. production ledger BEFORE the manual repair ══════════════════════════════════════
  section("SCENARIO 3 — ledger at 0069, repair effects ABSENT, apply 0070–" + HIGH);
  {
    const url = await freshDb("ir_prod_before");
    migrate(url, { MIGRATE_UPTO: "0069" });
    await seedRepairable(url);
    const before = await repairPredicates(url);
    report("starting ledger", `69 rows, high-water 0069`);
    report("starting markers", `profiles_without_users=${before.profiles_without_users}, ` +
      `profiles_without_membership=${before.profiles_without_membership}, ` +
      `suspended_but_active=${before.suspended_but_active}, company_authored_tasks=${before.company_authored_tasks}`);
    check("the repairable defects are genuinely present",
      before.profiles_without_users > 0 && before.profiles_without_membership > 0 &&
      before.suspended_but_active > 0 && before.company_authored_tasks > 0, JSON.stringify(before));

    const out = migrate(url);
    report("attempted / committed", `${TOTAL - 69} / ${(out.match(/✅ applied/g) ?? []).length}`);
    const after = await repairPredicates(url);
    report("ending markers", JSON.stringify(after));
    check("every defect repaired",
      after.profiles_without_users === 0 && after.profiles_without_membership === 0 &&
      after.suspended_but_active === 0 && after.company_authored_tasks === 0, JSON.stringify(after));
    const l = await ledger(url);
    report("ending high-water", l.hi);
    check(`${TOTAL} rows`, l.n === TOTAL && l.hi === HIGH, JSON.stringify(l));
  }

  // ═══ 4. THE ACTUAL REPORTED PRODUCTION SHAPE ════════════════════════════════════════════
  section("SCENARIO 4 — ledger at 0069, main's 0070 effects ALREADY APPLIED, no 0070 ledger row");
  {
    const url = await freshDb("ir_prod_actual");
    migrate(url, { MIGRATE_UPTO: "0069" });
    await seedRepairable(url);
    const preRepair = await repairPredicates(url);
    report("starting ledger", "69 rows, high-water 0069");
    report("defects before the manual repair", JSON.stringify(preRepair));

    // The REST applier's equivalent: the migration's effects, and NO ledger row.
    await applyMainRepairManually(url);
    const repaired = await repairPredicates(url);
    const l0 = await ledger(url);
    report("after the manual repair", JSON.stringify(repaired));
    report("ledger after the manual repair", `${l0.n} rows, high-water ${l0.hi}`);
    check("the manual repair fixed the defects", repaired.profiles_without_users === 0 &&
      repaired.suspended_but_active === 0 && repaired.company_authored_tasks === 0, JSON.stringify(repaired));
    check("and wrote NO ledger row — this is the production shape", l0.n === 69 && l0.hi === "0069",
      JSON.stringify(l0));

    // Now run the release process exactly as it would run.
    const out = migrate(url);
    const applied = (out.match(/✅ applied/g) ?? []).length;
    report("attempted / committed", `${TOTAL - 69} / ${applied}`);
    check(`the runner applies all ${TOTAL - 69} pending, INCLUDING main's 0070`,
      applied === TOTAL - 69, `${applied}`);

    const afterRun = await repairPredicates(url);
    report("markers after the release run", JSON.stringify(afterRun));
    check("re-running the repair DUPLICATED nothing",
      afterRun.memberships === repaired.memberships &&
      afterRun.role_grants === repaired.role_grants &&
      afterRun.users === repaired.users,
      `memberships ${repaired.memberships}→${afterRun.memberships}, roles ${repaired.role_grants}→${afterRun.role_grants}, users ${repaired.users}→${afterRun.users}`);
    check("and CORRUPTED nothing — every defect still repaired",
      afterRun.profiles_without_users === 0 && afterRun.profiles_without_membership === 0 &&
      afterRun.suspended_but_active === 0 && afterRun.company_authored_tasks === 0, JSON.stringify(afterRun));
    const l = await ledger(url);
    report("ending high-water", l.hi);
    check(`${TOTAL} rows, no duplicates`, l.n === TOTAL && l.dupes === 0 && l.hi === HIGH, JSON.stringify(l));
  }

  // ═══ 5. ledger already reconciled ═══════════════════════════════════════════════════════
  section("SCENARIO 5 — ledger through 0070, effects present, apply 0071–" + HIGH);
  {
    const url = await freshDb("ir_reconciled");
    migrate(url, { MIGRATE_UPTO: "0070" });
    await seedRepairable(url);
    await applyMainRepairManually(url);
    const l0 = await ledger(url);
    report("starting ledger", `${l0.n} rows, high-water ${l0.hi}`);
    const out = migrate(url);
    report("attempted / committed", `${TOTAL - 70} / ${(out.match(/✅ applied/g) ?? []).length}`);
    const l = await ledger(url);
    report("ending high-water", l.hi);
    check(`reaches ${TOTAL} / ${HIGH}`, l.n === TOTAL && l.hi === HIGH, JSON.stringify(l));
    const after = await repairPredicates(url);
    check("data integrity intact", after.profiles_without_users === 0 && after.company_authored_tasks === 0,
      JSON.stringify(after));
  }

  // ═══ 6. interruption ════════════════════════════════════════════════════════════════════
  section("SCENARIO 6 — force a failure mid-sequence, establish the partial state, then restore");
  {
    const url = await freshDb("ir_interrupt");
    migrate(url, { MIGRATE_UPTO: "0100" });
    const mid = await ledger(url);
    report("starting ledger", `${mid.n} rows, high-water ${mid.hi}`);

    // A SNAPSHOT first — the restore procedure restores from one, so there has to be one.
    await admin.query('drop database if exists "ir_interrupt_snap" with (force)');
    await admin.query('create database "ir_interrupt_snap" template "ir_interrupt"');
    dbs.push("ir_interrupt_snap");
    report("snapshot taken", "ir_interrupt_snap (template copy at 0100)");

    // THE FAILURE. Dropping a table 0101 alters is deterministic and touches no file.
    //
    // The first attempt created a conflicting table instead, and forced nothing: almost every
    // migration here uses `create table if not exists`, which is a no-op against an existing
    // table. The scenario "passed" while the chain ran to completion — a test that cannot fail
    // reporting that nothing failed.
    await q(url, "drop table if exists management_directives cascade");
    let failed = false, msg = "";
    try { migrate(url); } catch (e) {
      failed = true;
      const outText = String(e.stdout ?? "") + String(e.stderr ?? "");
      const lines = outText.split(String.fromCharCode(10)).map((l) => l.trim());
      msg = lines.find((l) => l.includes("FAILED")) ?? String(e.message).slice(0, 90);
    }
    check("the runner FAILS loudly rather than continuing", failed, msg.slice(0, 110));

    const afterFail = await ledger(url);
    report("ledger after the interruption", `${afterFail.n} rows, high-water ${afterFail.hi}`);
    check("the ledger did not advance past the last COMPLETE migration",
      afterFail.n === mid.n && afterFail.hi === mid.hi, JSON.stringify(afterFail));
    report("partial state", `schema damaged (management_directives dropped), ledger intact at ${afterFail.hi}`);

    // THE DOCUMENTED RESTORE: go back to the snapshot, then migrate forward. The ledger is never
    // hand-edited and the damaged database is never patched in place.
    await admin.query('drop database if exists "ir_interrupt_restored" with (force)');
    await admin.query('create database "ir_interrupt_restored" template "ir_interrupt_snap"');
    dbs.push("ir_interrupt_restored");
    const restored = urlFor("ir_interrupt_restored");
    const rl0 = await ledger(restored);
    check("the restored copy is back at the pre-failure ledger", rl0.n === mid.n && rl0.hi === mid.hi,
      JSON.stringify(rl0));
    check("and its schema is intact again",
      (await q(restored, "select to_regclass('public.management_directives') x"))[0].x !== null);

    const out = migrate(restored);
    report("attempted / committed on the restored copy",
      `${TOTAL - mid.n} / ${(out.match(/✅ applied/g) ?? []).length}`);
    const l = await ledger(restored);
    report("ending high-water", l.hi);
    check(`the restore procedure completes the chain to ${HIGH}`,
      l.n === TOTAL && l.hi === HIGH && l.dupes === 0, JSON.stringify(l));
  }

  // ═══ 7. rollback from a snapshot ════════════════════════════════════════════════════════
  section("SCENARIO 7 — restore from a pre-apply snapshot and verify schema, ledger and data");
  {
    const src = await freshDb("ir_snap_src");
    migrate(src, { MIGRATE_UPTO: "0069" });
    await seedRepairable(src);
    const snapLedger = await ledger(src);
    const snapData = await repairPredicates(src);
    report("snapshot ledger", `${snapLedger.n} rows, high-water ${snapLedger.hi}`);

    // A real snapshot: pg_dump inside the container is not available here, so the snapshot is a
    // template database — the same guarantee (a byte-identical starting point) by another route.
    await admin.query(`drop database if exists "ir_snap_restored" with (force)`);
    await admin.query(`create database "ir_snap_restored" template "ir_snap_src"`);
    dbs.push("ir_snap_restored");
    const restored = urlFor("ir_snap_restored");

    // Advance the ORIGINAL, then prove the restored copy is untouched by that.
    migrate(src);
    const advanced = await ledger(src);
    const rl = await ledger(restored);
    const rd = await repairPredicates(restored);
    report("original after advancing", `${advanced.n} rows, high-water ${advanced.hi}`);
    report("restored copy", `${rl.n} rows, high-water ${rl.hi}`);
    check("the restored snapshot has the PRE-APPLY ledger", rl.n === snapLedger.n && rl.hi === snapLedger.hi,
      JSON.stringify(rl));
    check("the restored snapshot has the PRE-APPLY schema",
      (await q(restored, `select to_regclass('public.management_items') x`))[0].x === null);
    check("the restored snapshot has the PRE-APPLY data",
      JSON.stringify(rd) === JSON.stringify(snapData), `${JSON.stringify(rd)} vs ${JSON.stringify(snapData)}`);
    // And the restored copy can be migrated forward, which is what a restore is for.
    migrate(restored);
    const rf = await ledger(restored);
    check(`the restored copy migrates forward to ${HIGH}`, rf.n === TOTAL && rf.hi === HIGH, JSON.stringify(rf));
  }

  // ═══ 8. fresh install + the rollback chain ══════════════════════════════════════════════
  section("SCENARIO 8 — every rollback corresponds to its promoted migration");
  {
    const url = await freshDb("ir_rollback");
    migrate(url);
    const downs = readdirSync(ROLLBACK_DIR).filter((f) => /^\d{4}_.*\.down\.sql$/.test(f)).sort();
    report("rollback scripts", `${downs.length}`);

    const orphans = downs.filter((d) => !files.includes(d.replace(/\.down\.sql$/, ".sql")));
    check("every rollback names an existing migration", orphans.length === 0, orphans.join(", "));

    const c = new pg.Client({ connectionString: url, ssl: false });
    await c.connect();
    let failedAt = "";
    try {
      const before = Number((await c.query(`select count(*)::int n from information_schema.tables
        where table_schema='public' and table_name in
        ('companies','users','memberships','tasks','projects','customers','quotations',
         'journal_entries','message_outbox','audit_events')`)).rows[0].n);
      for (const f of [...downs].reverse()) {
        try { await c.query(readFileSync(`${ROLLBACK_DIR}/${f}`, "utf8")); }
        catch (e) { failedAt = `${f}: ${e.message.split("\n")[0]}`; break; }
      }
      check(`all ${downs.length} rollbacks apply in reverse order`, failedAt === "", failedAt);
      const kernel = (await c.query(`select count(*)::int n from information_schema.tables
        where table_schema='public' and table_name in
        ('management_items','management_cycle_leases','observation_sources')`)).rows[0].n;
      check("the kernel is gone", Number(kernel) === 0, `${kernel} remain`);
      const after = Number((await c.query(`select count(*)::int n from information_schema.tables
        where table_schema='public' and table_name in
        ('companies','users','memberships','tasks','projects','customers','quotations',
         'journal_entries','message_outbox','audit_events')`)).rows[0].n);
      check("the released schema stands — a rollback, not a wipe", after === before, `${before} → ${after}`);
    } finally { await c.end(); }
  }

  code = fail === 0 ? 0 : 1;
} catch (e) {
  console.error("\n" + (e.stderr ?? e.message ?? e));
  code = 1;
} finally {
  for (const d of dbs) await admin.query(`drop database if exists "${d}" with (force)`).catch(() => {});
  await admin.end();
}

console.log(`\n${"═".repeat(78)}\n${pass} passed, ${fail} failed\n`);
process.exit(code);
