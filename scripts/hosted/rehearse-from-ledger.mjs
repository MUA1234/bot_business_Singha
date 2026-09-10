#!/usr/bin/env node
/**
 * Production-ledger-shaped migration rehearsal.
 *
 * Builds a disposable database whose `schema_migrations` ledger is the EXACT set of rows read
 * from production, applies the released migrations up to that high-water mark, and then applies
 * whatever the runner considers pending. It answers one question: *if we ran the migration on
 * production tonight, what would happen?*
 *
 * This is different from — and stricter than — a fresh-database run. A fresh run proves the
 * migrations are self-consistent. This proves they are consistent with the state that actually
 * exists, including the possibility that the runner would SKIP something because its version is
 * already recorded. That skip is silent by design (`migrate.mjs` keys on the four-digit prefix),
 * so the only way to see it is to reproduce the ledger and look.
 *
 * It never touches a hosted database: it reads a committed evidence FILE, and writes only to a
 * local disposable one.
 *
 * Usage:
 *   DATABASE_URL=postgres://…/scratch node scripts/hosted/rehearse-from-ledger.mjs \
 *     docs/release-1/evidence/hosted-state-2026-09-10.json
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import pg from "pg";

const evidencePath = process.argv[2] ?? "docs/release-1/evidence/hosted-state-2026-09-10.json";
const URL = process.env.DATABASE_URL;
if (!URL) { console.error("DATABASE_URL is required"); process.exit(2); }
if (!/127\.0\.0\.1|localhost|\[::1\]/.test(URL)) {
  console.error("REFUSED: this rehearsal writes, so it runs only against a LOCAL disposable database.");
  process.exit(2);
}

const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
const ledger = evidence.ledger;
if (!Array.isArray(ledger) || ledger.length === 0) {
  console.error(`no ledger rows in ${evidencePath}`);
  process.exit(2);
}
const highWater = ledger[ledger.length - 1].version;
console.log(`evidence: ${evidencePath}`);
console.log(`hosted ledger: ${ledger.length} rows, high-water ${highWater}\n`);

const env = { ...process.env, DATABASE_URL: URL, PGSSL: "disable" };
const run = (args) => execFileSync("node", args, { env, stdio: "pipe", encoding: "utf8" });

// 1. Shim, then the released migrations up to the hosted high-water mark. MIGRATE_UPTO stages
//    exactly the schema production has, rather than a guess at it.
console.log("▶ applying the released migrations up to the hosted high-water …");
run(["scripts/apply-sql.mjs", "tests/integration/helpers/supabase-shim.sql"]);
execFileSync("node", ["scripts/migrate.mjs"], {
  env: { ...env, MIGRATE_UPTO: highWater }, stdio: "pipe",
});

const c = new pg.Client({ connectionString: URL, ssl: false });
await c.connect();

// 2. Make the ledger match production EXACTLY — same versions, same filenames. A filename that
//    differs is the collision class this whole reconciliation exists to remove, so the rehearsal
//    has to carry the real ones rather than the ones our own runner happened to write.
const staged = (await c.query("select version, filename from schema_migrations order by version")).rows;
let corrected = 0;
for (const row of ledger) {
  const mine = staged.find((r) => r.version === row.version);
  if (!mine) {
    await c.query("insert into schema_migrations (version, filename) values ($1,$2)", [row.version, row.filename]);
    corrected++;
  } else if (mine.filename !== row.filename) {
    await c.query("update schema_migrations set filename=$2 where version=$1", [row.version, row.filename]);
    corrected++;
  }
}
const extra = staged.filter((r) => !ledger.some((l) => l.version === r.version));
for (const r of extra) await c.query("delete from schema_migrations where version=$1", [r.version]);

const after = (await c.query("select count(*)::int n, max(version) hw from schema_migrations")).rows[0];
console.log(`▶ ledger shaped to production: ${after.n} rows, high-water ${after.hw}` +
  ` (${corrected} corrected, ${extra.length} removed)`);
if (after.n !== ledger.length || after.hw !== highWater) {
  console.error("✖ the staged ledger does not match the evidence — refusing to continue");
  process.exit(1);
}

// 3. What does the runner consider pending?
//    `--status` exits 1 WHEN THERE IS PENDING WORK — that is its contract, not a failure, so the
//    non-zero exit is expected here and the output is read from the thrown error.
let status;
try {
  status = execFileSync("node", ["scripts/migrate.mjs", "--status"], { env, stdio: "pipe", encoding: "utf8" });
} catch (e) {
  status = String(e.stdout ?? "");
  if (!status.includes("pending")) throw e; // a real failure, not the pending-work exit code
}
console.log(`\n▶ runner status against the production-shaped ledger:\n${status.trim()}`);

// 4. Apply it, exactly as production would.
console.log("\n▶ applying pending …");
const applied = execFileSync("node", ["scripts/migrate.mjs"], { env, stdio: "pipe", encoding: "utf8" });
console.log(applied.trim().split("\n").slice(-3).join("\n"));

// 5. The objects the pending range was supposed to create must now exist. A migration that was
//    silently skipped shows up here and nowhere else.
const expect = async (label, sql, want = true) => {
  const { rows } = await c.query(sql);
  const got = Boolean(rows[0]?.ok);
  console.log(`   ${got === want ? "✅" : "❌"} ${label}`);
  return got === want;
};
console.log("\n▶ post-state — objects the pending range must have created:");
let ok = true;
ok = await expect("source_events.next_attempt_at (0070)",
  "select exists(select 1 from information_schema.columns where table_schema='public' and table_name='source_events' and column_name='next_attempt_at') ok") && ok;
ok = await expect("function claim_source_events (0070)",
  "select exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname='claim_source_events') ok") && ok;
ok = await expect("table channel_accounts (0075)",
  "select to_regclass('public.channel_accounts') is not null ok") && ok;
ok = await expect("function resolve_channel_company (0075)",
  "select exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname='resolve_channel_company') ok") && ok;
ok = await expect("companies.whatsapp_phone_number_id RETAINED (main 0069)",
  "select exists(select 1 from information_schema.columns where table_schema='public' and table_name='companies' and column_name='whatsapp_phone_number_id') ok") && ok;
ok = await expect("bounded_user_text marker (0110, the last one)",
  "select exists(select 1 from schema_migrations where version='0110') ok") && ok;
ok = await expect("no R1 draft object leaked in",
  "select exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname like 'r1_draft_%') ok", false) && ok;

const final = (await c.query("select count(*)::int n, max(version) hw from schema_migrations")).rows[0];
console.log(`\n▶ final ledger: ${final.n} rows, high-water ${final.hw}`);
await c.end();

if (!ok || final.hw !== "0110") {
  console.error("\n✖ REHEARSAL FAILED");
  process.exit(1);
}
console.log("\n✅ REHEARSAL PASSED — the pending range applies cleanly over the real production ledger.");
