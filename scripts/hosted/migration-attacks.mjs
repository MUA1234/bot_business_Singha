#!/usr/bin/env node
/**
 * Adversarial migration campaign.
 *
 * The migration runner is the one component that can destroy a production database, and it is
 * silent by construction: `migrate.mjs` keys `schema_migrations` on the four-digit filename
 * prefix, so a version already recorded is skipped WITHOUT a message. Every attack below exists
 * because that silence turns a mistake into a schema nobody can explain afterwards.
 *
 * Each scenario builds its OWN disposable database, does something hostile, and asserts what the
 * runner did. Nothing hosted is touched; the script refuses a non-loopback DATABASE_URL.
 *
 * Usage:
 *   DATABASE_URL=postgres://…@127.0.0.1:PORT/postgres node scripts/hosted/migration-attacks.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import pg from "pg";

const ADMIN = process.env.DATABASE_URL;
if (!ADMIN) { console.error("DATABASE_URL is required (point it at the maintenance database)"); process.exit(2); }
if (!/127\.0\.0\.1|localhost|\[::1\]/.test(ADMIN)) {
  console.error("REFUSED: these attacks create and destroy databases, so they run only against a LOCAL server.");
  process.exit(2);
}

const MIG_DIR = "src/db/migrations";

/**
 * The chain's length and high-water are DERIVED, not written down.
 *
 * Four checks here read 110 and "0110" as literals. The chain became 142 the day the R1 units were
 * promoted, and all four failed while reporting the correct answer — 142 rows, high-water 0142 — as
 * though it were a defect. An attack campaign whose expectations go stale every time a migration is
 * added teaches its reader to skim the failures, which is the one thing it must not do.
 */
const ALL_MIGRATIONS = readdirSync(MIG_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const EXPECTED_N = ALL_MIGRATIONS.length;
const EXPECTED_HW = ALL_MIGRATIONS[ALL_MIGRATIONS.length - 1].slice(0, 4);
const urlFor = (db) => { const u = new URL(ADMIN); u.pathname = `/${db}`; return u.toString(); };

const admin = new pg.Client({ connectionString: ADMIN, ssl: false });
await admin.connect();

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}

async function freshDb(name) {
  await admin.query(`drop database if exists "${name}" with (force)`);
  await admin.query(`create database "${name}"`);
  return urlFor(name);
}
const env = (url, extra = {}) => ({ ...process.env, DATABASE_URL: url, PGSSL: "disable", ...extra });
const shim = (url) => execFileSync("node", ["scripts/apply-sql.mjs", "tests/integration/helpers/supabase-shim.sql"], { env: env(url), stdio: "pipe" });
const migrate = (url, extra = {}) => execFileSync("node", ["scripts/migrate.mjs"], { env: env(url, extra), stdio: "pipe", encoding: "utf8" });
const q = async (url, sql, params = []) => {
  const c = new pg.Client({ connectionString: url, ssl: false });
  await c.connect();
  try { return await c.query(sql, params); } finally { await c.end(); }
};

// ── 1. Fresh database ────────────────────────────────────────────────────────────────
console.log("\n▶ 1. fresh database");
{
  const url = await freshDb("atk_fresh");
  shim(url);
  migrate(url);
  const { rows } = await q(url, "select count(*)::int n, max(version) hw from schema_migrations");
  check("all migrations apply to an empty database", rows[0].n === EXPECTED_N && rows[0].hw === EXPECTED_HW,
    `${rows[0].n} rows, high-water ${rows[0].hw}`);
}

// ── 2. main-seeded ───────────────────────────────────────────────────────────────────
console.log("\n▶ 2. seeded to the released high-water, then the pending range");
{
  const url = await freshDb("atk_seeded");
  shim(url);
  migrate(url, { MIGRATE_UPTO: "0069" });
  const before = await q(url, "select count(*)::int n from schema_migrations");
  migrate(url);
  const after = await q(url, "select count(*)::int n, max(version) hw from schema_migrations");
  check("the pending range applies over a partially-migrated line",
    before.rows[0].n === 69 && after.rows[0].n === EXPECTED_N && after.rows[0].hw === EXPECTED_HW,
    `${before.rows[0].n} → ${after.rows[0].n}`);
}

// ── 3. Interrupted migration ─────────────────────────────────────────────────────────
// A migration that fails partway must leave the LEDGER honest: everything before it recorded,
// itself NOT recorded. A ledger claiming a migration that did not run is how a database ends up
// silently missing objects.
console.log("\n▶ 3. interrupted migration");
{
  const url = await freshDb("atk_interrupt");
  shim(url);
  migrate(url, { MIGRATE_UPTO: "0069" });

  // Break one migration on disk, run, then restore it.
  const target = "0071_durable_inbound_processing.sql";
  const path = `${MIG_DIR}/${target}`;
  const original = readFileSync(path, "utf8");
  let threw = false;
  try {
    writeFileSync(path, original + "\n\nselect this_function_does_not_exist();\n");
    migrate(url);
  } catch { threw = true; } finally { writeFileSync(path, original); }

  // The expected high-water is DERIVED from the target, not written down. It used to be the
  // literal "0069", which was right only while the broken file was 0070 — the +1 shift made
  // main's own 0070 the migration that legitimately runs first, so a correct run now stops one
  // version later and the assertion failed for a reason that had nothing to do with the
  // behaviour under test. A renumbering must not be able to quietly invalidate an attack.
  const brokenVersion = Number(target.slice(0, 4));
  const lastGood = String(brokenVersion - 1).padStart(4, "0");
  const { rows } = await q(url, "select count(*)::int n, max(version) hw from schema_migrations");
  check("a failing migration is REFUSED loudly, not skipped", threw);
  check("the ledger stops at the last migration that SUCCEEDED, and does not record the one that failed",
    rows[0].hw === lastGood && rows[0].n === brokenVersion - 1,
    `high-water ${rows[0].hw} (expected ${lastGood}), ${rows[0].n} rows (expected ${brokenVersion - 1})`);
  const objs = await q(url, "select to_regclass('public.channel_accounts') is not null ok");
  check("no LATER migration ran after the failure", objs.rows[0].ok === false);
}

// ── 4. Retry after failure ───────────────────────────────────────────────────────────
console.log("\n▶ 4. retry after the failure is repaired");
{
  const url = urlFor("atk_interrupt");
  migrate(url);
  const { rows } = await q(url, "select count(*)::int n, max(version) hw from schema_migrations");
  check("a repaired run completes from where it stopped", rows[0].n === EXPECTED_N && rows[0].hw === EXPECTED_HW,
    `${rows[0].n} rows, high-water ${rows[0].hw}`);
}

// ── 5. Duplicate version ─────────────────────────────────────────────────────────────
// Two files claiming one number is the defect this whole reconciliation exists to remove. The
// lint must refuse it BEFORE anything reaches a database.
console.log("\n▶ 5. duplicate version");
{
  const dup = `${MIG_DIR}/${EXPECTED_HW}_duplicate_attack.sql`;
  writeFileSync(dup, `-- attack: a second file claiming ${EXPECTED_HW}\nselect 1;\n`);
  let refused = false;
  try { execFileSync("node", ["scripts/migration-lint.mjs"], { stdio: "pipe" }); }
  catch { refused = true; } finally { if (existsSync(dup)) unlinkSync(dup); }
  check("migration-lint REFUSES two files at one version", refused);
}

// ── 6. Altered migration ─────────────────────────────────────────────────────────────
// Editing an applied migration is invisible to the runner — the version is recorded, so the new
// content never runs. The base-aware collision gate is what sees it.
console.log("\n▶ 6. altered migration");
{
  const target = `${MIG_DIR}/0069_company_routing_and_catalogue_department.sql`;
  const original = readFileSync(target, "utf8");
  let refused = false;
  try {
    writeFileSync(target, original + "\n-- attack: content changed after it was applied\n");
    execFileSync("node", ["scripts/migration-lint.mjs", "--base", "origin/main"], { stdio: "pipe" });
  } catch { refused = true; } finally { writeFileSync(target, original); }
  check("the collision gate REFUSES an edited already-applied migration", refused);
}

// ── 7. Missing dependency ────────────────────────────────────────────────────────────
// Applying a migration whose predecessor never ran must FAIL, not half-apply. This is the exact
// shape of the 0069 collision: the skipped migration's objects are absent and the next one
// references them.
console.log("\n▶ 7. missing dependency");
{
  const url = await freshDb("atk_missing_dep");
  shim(url);
  migrate(url, { MIGRATE_UPTO: "0069" });
  // Record the durable-inbound migration as applied WITHOUT running it — precisely what a
  // version collision does, and the defect class PR-F-001 recorded: `migrate.mjs` keys the ledger
  // on the four-digit prefix and skips a recorded version SILENTLY.
  //
  // The version is derived from the filename. It was hardcoded to '0070' paired with the 0071
  // filename, which was consistent before the +1 shift and self-contradictory after it: the row
  // then skipped MAIN's 0070, the durable-inbound migration ran normally, and both assertions
  // failed while the mechanism under test was never exercised. A false negative in an attack
  // campaign is worse than a failure, because it reads as a passing gate.
  const skipped = "0071_durable_inbound_processing.sql";
  await q(url, "insert into schema_migrations (version, filename) values ($1,$2)", [skipped.slice(0, 4), skipped]);
  let threw = false;
  try { migrate(url); } catch { threw = true; }
  const { rows } = await q(url,
    "select exists(select 1 from information_schema.columns where table_schema='public' and table_name='source_events' and column_name='next_attempt_at') ok");
  check("a migration whose dependency was skipped FAILS", threw);
  check("and the skipped migration's objects are genuinely absent", rows[0].ok === false);
}

// ── 8. Restore, then clean reapply ───────────────────────────────────────────────────
// The rollback path. There are no down-migrations, so restore is the only one — and a restore
// that cannot then be migrated forward is not a rollback.
console.log("\n▶ 8. restore, then a clean reapply");
{
  const src = await freshDb("atk_restore_src");
  shim(src);
  migrate(src, { MIGRATE_UPTO: "0069" });

  const dumpFile = "atk-restore.dump";
  execFileSync("docker", ["exec", process.env.ATK_CONTAINER ?? "", "true"], { stdio: "pipe" });
  // pg_dump/pg_restore run inside the container so no client tooling is required on the host.
  const container = process.env.ATK_CONTAINER;
  execFileSync("docker", ["exec", container, "pg_dump", "-U", "postgres", "-F", "c", "-f", `/tmp/${dumpFile}`, "atk_restore_src"], { stdio: "pipe" });
  await admin.query(`drop database if exists "atk_restore_dst" with (force)`);
  await admin.query(`create database "atk_restore_dst"`);
  execFileSync("docker", ["exec", container, "pg_restore", "-U", "postgres", "-d", "atk_restore_dst", `/tmp/${dumpFile}`], { stdio: "pipe" });

  const dst = urlFor("atk_restore_dst");
  const restored = await q(dst, "select count(*)::int n, max(version) hw from schema_migrations");
  check("the restore carries the ledger faithfully",
    restored.rows[0].n === 69 && restored.rows[0].hw === "0069",
    `${restored.rows[0].n} rows, high-water ${restored.rows[0].hw}`);

  migrate(dst);
  const final = await q(dst, "select count(*)::int n, max(version) hw from schema_migrations");
  check("a restored database migrates forward cleanly",
    final.rows[0].n === EXPECTED_N && final.rows[0].hw === EXPECTED_HW,
    `${final.rows[0].n} rows, high-water ${final.rows[0].hw}`);
}

// ── cleanup ──────────────────────────────────────────────────────────────────────────
for (const db of ["atk_fresh", "atk_seeded", "atk_interrupt", "atk_missing_dep", "atk_restore_src", "atk_restore_dst"]) {
  await admin.query(`drop database if exists "${db}" with (force)`).catch(() => {});
}
await admin.end();

console.log(`\n===== migration attacks: ${pass} passed, ${fail} failed =====`);
process.exit(fail === 0 ? 0 : 1);
