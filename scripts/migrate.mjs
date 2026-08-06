#!/usr/bin/env node
/**
 * Migration runner + ledger (NEXT_PHASE_DEVELOPER_BRIEF §WP6.8; MIGRATION_STATE.md
 * "a durable, queryable applied-migrations ledger populated by the runner").
 *
 * Applies `src/db/migrations/NNNN_*.sql` in order, each in its own transaction, and
 * records the version in a `schema_migrations` table so it is applied exactly once.
 * Reads DATABASE_URL. Usage:
 *   node scripts/migrate.mjs             apply pending migrations
 *   node scripts/migrate.mjs --status    show applied vs pending (exit 1 if pending)
 *   node scripts/migrate.mjs --baseline  mark ALL current files applied WITHOUT running
 *                                        (for a DB whose schema already exists)
 */
import pg from "pg";
import { readdirSync, readFileSync } from "node:fs";

const DIR = "src/db/migrations";
const URL = process.env.DATABASE_URL;
if (!URL) {
  console.error("DATABASE_URL is required");
  process.exit(2);
}
const mode = process.argv[2] ?? "apply";

const files = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const version = (f) => f.slice(0, 4);

const c = new pg.Client({ connectionString: URL, ssl: { rejectUnauthorized: false } });
await c.connect();
await c.query(`create table if not exists schema_migrations (version text primary key, filename text not null, applied_at timestamptz not null default now())`);

const applied = new Set((await c.query("select version from schema_migrations")).rows.map((r) => r.version));
const pending = files.filter((f) => !applied.has(version(f)));

if (mode === "--status") {
  console.log(`applied: ${applied.size}  pending: ${pending.length}`);
  if (pending.length) console.log("  pending:", pending.join(", "));
  await c.end();
  process.exit(pending.length ? 1 : 0);
}

if (mode === "--baseline") {
  for (const f of files) {
    await c.query(`insert into schema_migrations (version, filename) values ($1,$2) on conflict (version) do nothing`, [version(f), f]);
  }
  console.log(`✅ baselined ${files.length} migrations as applied (no SQL run).`);
  await c.end();
  process.exit(0);
}

// apply mode
let n = 0;
for (const f of pending) {
  const sql = readFileSync(`${DIR}/${f}`, "utf8");
  try {
    await c.query("begin");
    await c.query(sql);
    await c.query(`insert into schema_migrations (version, filename) values ($1,$2)`, [version(f), f]);
    await c.query("commit");
    console.log("✅ applied", f);
    n++;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    console.error("❌ FAILED", f, "→", e.message);
    await c.end();
    process.exit(1);
  }
}
console.log(pending.length ? `Applied ${n} migration(s).` : "Up to date — nothing to apply.");
await c.end();
