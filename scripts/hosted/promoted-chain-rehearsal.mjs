#!/usr/bin/env node
/**
 * Rehearse the FINAL numbered chain, from nothing, ten ways.
 *
 * The chain changed shape: the quarantined R1 units became `0111`–`0140`, and the approved schema
 * policy added `0141` (bounded client-writable text) and `0142` (tenant-integrity foreign keys).
 * Every earlier rehearsal was of a 110-migration chain plus a separate draft runner, so none of
 * them is evidence about this one.
 *
 * Each scenario builds its OWN database and destroys it. Nothing hosted is contacted; the script
 * refuses a non-loopback `DATABASE_URL`.
 *
 * Usage:
 *   DATABASE_URL=postgres://…@127.0.0.1:PORT/postgres node scripts/hosted/promoted-chain-rehearsal.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import pg from "pg";

const ADMIN = process.env.DATABASE_URL;
if (!ADMIN) { console.error("DATABASE_URL is required"); process.exit(2); }
if (!/127\.0\.0\.1|localhost|\[::1\]/.test(ADMIN)) {
  console.error("REFUSED: this creates and destroys databases, so it runs only against a LOCAL server.");
  process.exit(2);
}

const MIG_DIR = "src/db/migrations";
const ROLLBACK_DIR = "src/db/rollback";
const EVIDENCE = "docs/release-1/evidence/hosted-state-2026-09-10.json";

const files = readdirSync(MIG_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const HIGH = files[files.length - 1].slice(0, 4);
const TOTAL = files.length;

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); }
};
const section = (n) => console.log(`\n${n}`);

const admin = new pg.Client({ connectionString: ADMIN, ssl: false });
await admin.connect();
const urlFor = (db) => { const u = new URL(ADMIN); u.pathname = `/${db}`; return u.toString(); };

async function freshDb(name) {
  await admin.query(`drop database if exists "${name}" with (force)`);
  await admin.query(`create database "${name}"`);
  const url = urlFor(name);
  execFileSync("node", ["scripts/apply-sql.mjs", "tests/integration/helpers/supabase-shim.sql"],
    { env: { ...process.env, DATABASE_URL: url, PGSSL: "disable" }, stdio: "pipe" });
  return url;
}

const migrate = (url, extra = {}) =>
  execFileSync("node", ["scripts/migrate.mjs"],
    { env: { ...process.env, DATABASE_URL: url, PGSSL: "disable", ...extra }, encoding: "utf8", stdio: "pipe" });

async function q(url, sql, params = []) {
  const c = new pg.Client({ connectionString: url, ssl: false });
  await c.connect();
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}

/** The ledger's shape, in the terms every scenario asks about. */
async function ledger(url) {
  const [r] = await q(url, `select count(*)::int n, min(version) lo, max(version) hi from schema_migrations`);
  const dupes = await q(url, `select version from schema_migrations group by version having count(*) > 1`);
  const versions = (await q(url, `select version from schema_migrations order by version`)).map((x) => Number(x.version));
  const gaps = [];
  for (let i = 1; i <= TOTAL; i++) if (!versions.includes(i)) gaps.push(i);
  return { n: r.n, lo: r.lo, hi: r.hi, dupes: dupes.length, gaps };
}

let code = 1;
try {
  console.log(`rehearsing ${TOTAL} migrations, 0001–${HIGH}\n`);

  // ── 1. fresh ─────────────────────────────────────────────────────────────────────────────
  section("1. fresh — 0001 to the high-water in one run");
  {
    const url = await freshDb("reh_fresh");
    migrate(url);
    const l = await ledger(url);
    check(`${TOTAL} contiguous rows, high-water ${HIGH}`,
      l.n === TOTAL && l.hi === HIGH && l.lo === "0001" && l.dupes === 0 && l.gaps.length === 0,
      JSON.stringify(l));

    const missing = [];
    for (const t of ["management_items", "management_item_evidence", "management_item_recommendations",
      "management_item_decisions", "management_execution_attempts", "management_execution_enablement",
      "management_kernel_enablement", "management_cycle_leases", "ask_ai_threads", "observation_sources"]) {
      if (!(await q(url, `select to_regclass($1) x`, [`public.${t}`]))[0].x) missing.push(t);
    }
    check("every management table exists", missing.length === 0, missing.join(", "));

    const rpcs = await q(url, `select p.oid::regprocedure::text sig from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='public' and p.proname like 'r1\\_exec\\_%' order by 1`);
    check("exactly seven execution RPCs, one signature each", rpcs.length === 7,
      `${rpcs.length}: ${rpcs.map((r) => r.sig).join(", ")}`);
    const names = new Set(rpcs.map((r) => r.sig.split("(")[0]));
    check("no stale overload", names.size === rpcs.length, `${names.size} names for ${rpcs.length} signatures`);

    check("no draft-only ledger exists",
      (await q(url, `select to_regclass('public.r1_draft_migrations') x`))[0].x === null);
    check("no retired advisory-lock function remains",
      (await q(url, `select to_regprocedure('public.r1_draft_try_cycle_lock(uuid)') x`))[0].x === null);

    const gaps = await q(url, `
      with fks as (select c.conrelid::regclass::text child, c.confrelid::regclass::text parent,
             (select array_agg(a.attname::text order by k.ord) from unnest(c.conkey) with ordinality k(att,ord)
              join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.att) cols
        from pg_constraint c join pg_namespace n on n.oid=c.connamespace where c.contype='f' and n.nspname='public'),
      single as (select * from fks where array_length(cols,1)=1 and cols[1] <> 'company_id'),
      composite as (select child,parent,cols from fks where 'company_id'=any(cols) and array_length(cols,1)>1)
      select s.child||'.'||s.cols[1] g from single s
       where s.child ~ '^(management_|observation_|ask_ai_)'
         and exists (select 1 from information_schema.columns ic where ic.table_schema='public' and ic.table_name=s.child and ic.column_name='company_id')
         and exists (select 1 from information_schema.columns ip where ip.table_schema='public' and ip.table_name=s.parent and ip.column_name='company_id')
         and not exists (select 1 from composite cp where cp.child=s.child and cp.parent=s.parent and s.cols[1]=any(cp.cols))`);
    check("no tenant-integrity gap on the promoted tables", gaps.length === 0, gaps.map((r) => r.g).join(", "));

    const unbounded = await q(url, `
      select col.table_name||'.'||col.column_name r from information_schema.columns col
       where col.table_schema='public' and col.data_type in ('text','character varying')
         and col.character_maximum_length is null
         and col.table_name in (select cl.relname from pg_policy p join pg_class cl on cl.oid=p.polrelid
            join pg_namespace ns on ns.oid=cl.relnamespace where ns.nspname='public'
              and p.polcmd::text in ('a','w','*') and has_table_privilege('authenticated', cl.oid,'INSERT'))
         and not exists (select 1 from pg_constraint c join pg_class cl2 on cl2.oid=c.conrelid
            join pg_namespace ns2 on ns2.oid=cl2.relnamespace where ns2.nspname='public'
              and cl2.relname=col.table_name and c.conname=left(col.table_name||'_'||col.column_name||'_len_chk',63))`);
    check("no unbounded authenticated-writable text", unbounded.length === 0, unbounded.map((r) => r.r).join(", "));
  }

  // ── 2. main baseline, then the rest ──────────────────────────────────────────────────────
  section("2. main's baseline 0001–0069, then the pending range");
  {
    const url = await freshDb("reh_baseline");
    migrate(url, { MIGRATE_UPTO: "0069" });
    const mid = await ledger(url);
    check("stops exactly at 0069", mid.n === 69 && mid.hi === "0069", JSON.stringify(mid));
    migrate(url);
    const l = await ledger(url);
    check(`reaches ${TOTAL} / ${HIGH}`, l.n === TOTAL && l.hi === HIGH && l.dupes === 0, JSON.stringify(l));
  }

  // ── 3. the hosted Case-A ledger, then everything pending ─────────────────────────────────
  section("3. the REAL hosted Case-A ledger, then all pending migrations");
  {
    const url = await freshDb("reh_hosted");
    const evidence = JSON.parse(readFileSync(EVIDENCE, "utf8"));
    const rows = evidence.ledger;

    // BUILD THE SCHEMA FIRST, then make the ledger say what the hosted one says.
    //
    // Seeding ledger rows alone was the first attempt, and it failed at 0070 with `relation
    // "public.source_events" does not exist` — correctly. A ledger that claims 69 migrations ran
    // against an empty database is not Case A, it is a corrupt ledger, and scenario 8 exists to
    // test that separately. Case A is a database that really HAS the first 69 migrations and
    // whose ledger records MAIN's filenames for them.
    migrate(url, { MIGRATE_UPTO: "0069" });
    const c = new pg.Client({ connectionString: url, ssl: false });
    await c.connect();
    try {
      // Replace the filenames with the hosted ones, version for version. The candidate renumbered
      // the branch, so `0069` is a different file here than on production — which is exactly the
      // difference this scenario exists to rehearse across.
      for (const r of rows) {
        await c.query(`update schema_migrations set filename = $2 where version = $1`, [r.version, r.filename]);
      }
      const [{ n }] = (await c.query(
        `select count(*)::int n from schema_migrations`)).rows;
      if (Number(n) !== rows.length) {
        throw new Error(`expected ${rows.length} ledger rows after seeding, found ${n}`);
      }
    } finally { await c.end(); }
    const seeded = await ledger(url);
    check(`the hosted ledger seeds as ${rows.length} rows, high-water ${rows[rows.length - 1].version}`,
      seeded.n === rows.length, JSON.stringify(seeded));

    const out = migrate(url);
    const pending = TOTAL - rows.length;
    check(`applies exactly ${pending} pending migrations`,
      (out.match(/✅ applied/g) ?? []).length === pending,
      `${(out.match(/✅ applied/g) ?? []).length} applied`);
    const l = await ledger(url);
    check(`final ${TOTAL} rows, high-water ${HIGH}, no duplicates, no gaps`,
      l.n === TOTAL && l.hi === HIGH && l.dupes === 0 && l.gaps.length === 0, JSON.stringify(l));
  }

  // ── 4 & 5. interruption, in each half ────────────────────────────────────────────────────
  for (const [label, stopAt, db] of [
    ["4. interruption during 0070–0110", "0085", "reh_int_a"],
    ["5. interruption during 0111–0140", "0125", "reh_int_b"],
  ]) {
    section(label);
    const url = await freshDb(db);
    migrate(url, { MIGRATE_UPTO: stopAt });
    const mid = await ledger(url);
    check(`stops cleanly at ${stopAt}`, mid.hi === stopAt, JSON.stringify(mid));
    // No partial migration: the interrupted run left a ledger whose high-water is a COMPLETE
    // migration, because each one commits as a unit.
    const [{ filename }] = await q(url, `select filename from schema_migrations order by version desc limit 1`);
    check("the last ledger row names a real migration file", files.includes(filename), filename);

    // 6. resume and complete — the same database, carried on.
    migrate(url);
    const l = await ledger(url);
    check(`resumes to ${TOTAL} / ${HIGH} with no duplicate`,
      l.n === TOTAL && l.hi === HIGH && l.dupes === 0, JSON.stringify(l));
  }

  // ── 7. duplicate version ─────────────────────────────────────────────────────────────────
  section("7. a duplicate version is refused by the ledger");
  {
    const url = await freshDb("reh_dupe");
    migrate(url);
    let refused = false;
    try {
      const c = new pg.Client({ connectionString: url, ssl: false });
      await c.connect();
      try {
        await c.query(`insert into schema_migrations (version, filename) values ('0111','forged.sql')`);
      } finally { await c.end(); }
    } catch (e) { refused = /duplicate key|unique/i.test(e.message); }
    check("a second row for version 0111 is refused", refused);
  }

  // ── 8. missing dependency ────────────────────────────────────────────────────────────────
  section("8. a missing dependency fails loudly rather than half-applying");
  {
    const url = await freshDb("reh_missingdep");
    // 0111 creates `management_items`; 0113 references it. Apply 0112 onward without 0111 by
    // marking 0111 applied without running it — the shape of a ledger that lies.
    const c = new pg.Client({ connectionString: url, ssl: false });
    await c.connect();
    try {
      await c.query(`create table if not exists schema_migrations (
        version text primary key, filename text not null, applied_at timestamptz not null default now())`);
      for (const f of files.filter((x) => x.slice(0, 4) <= "0111")) {
        await c.query(`insert into schema_migrations (version, filename) values ($1,$2)
                       on conflict do nothing`, [f.slice(0, 4), f]);
      }
    } finally { await c.end(); }
    let failed = false, message = "";
    try { migrate(url); } catch (e) { failed = true; message = String(e.stderr ?? e.message).split("\n")[0]; }
    check("the runner fails rather than continuing past a missing dependency", failed, message.slice(0, 120));
  }

  // ── 9. altered historical migration ──────────────────────────────────────────────────────
  section("9. an altered historical migration does not re-run silently");
  {
    const url = await freshDb("reh_altered");
    migrate(url);
    const target = `${MIG_DIR}/0111_management_items.sql`;
    const original = readFileSync(target, "utf8");
    const backup = `${target}.rehearsal-backup`;
    writeFileSync(backup, original);
    try {
      writeFileSync(target, `${original}\n-- altered after the fact\nselect 1/0;\n`);
      const out = migrate(url);
      check("an already-applied migration is skipped even when its content changed",
        !/0111/.test(out.replace(/^.*Applied.*$/m, "")), out.trim().split("\n").slice(-1)[0]);
      const l = await ledger(url);
      check("the ledger is unchanged by the altered file", l.n === TOTAL && l.hi === HIGH, JSON.stringify(l));
    } finally {
      writeFileSync(target, original);
      if (existsSync(backup)) unlinkSync(backup);
    }
  }

  // ── 10. rollback in reverse ──────────────────────────────────────────────────────────────
  section("10. rollback scripts, reverse dependency order, on disposable data");
  {
    const url = await freshDb("reh_rollback");
    migrate(url);
    const c = new pg.Client({ connectionString: url, ssl: false });
    await c.connect();
    try {
      const before = Number((await c.query(`select count(*)::int n from information_schema.tables
        where table_schema='public' and table_name in
        ('companies','users','memberships','tasks','projects','customers','quotations',
         'journal_entries','message_outbox','audit_events')`)).rows[0].n);

      const downs = readdirSync(ROLLBACK_DIR).filter((f) => /^\d{4}_.*\.down\.sql$/.test(f)).sort().reverse();
      let failedAt = "";
      for (const f of downs) {
        try { await c.query(readFileSync(`${ROLLBACK_DIR}/${f}`, "utf8")); }
        catch (e) { failedAt = `${f}: ${e.message.split("\n")[0]}`; break; }
      }
      check(`all ${downs.length} rollback scripts apply in reverse order`, failedAt === "", failedAt);

      const kernel = (await c.query(`select count(*)::int n from information_schema.tables
        where table_schema='public' and table_name in
        ('management_items','management_item_evidence','management_cycle_leases','observation_sources')`)).rows[0].n;
      check("the kernel tables are gone", Number(kernel) === 0, `${kernel} remain`);

      const after = Number((await c.query(`select count(*)::int n from information_schema.tables
        where table_schema='public' and table_name in
        ('companies','users','memberships','tasks','projects','customers','quotations',
         'journal_entries','message_outbox','audit_events')`)).rows[0].n);
      check("the released schema is untouched — a rollback, not a wipe", after === before, `${before} → ${after}`);
    } finally { await c.end(); }
  }

  code = fail === 0 ? 0 : 1;
} catch (e) {
  console.error(e.message ?? e);
  code = 1;
} finally {
  for (const db of ["reh_fresh", "reh_baseline", "reh_hosted", "reh_int_a", "reh_int_b",
                    "reh_dupe", "reh_missingdep", "reh_altered", "reh_rollback"]) {
    await admin.query(`drop database if exists "${db}" with (force)`).catch(() => {});
  }
  await admin.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(code);
