#!/usr/bin/env node
/**
 * Apply a single .sql file to DATABASE_URL (WP F). Used in CI to install the
 * Supabase-compatibility shim onto the disposable Postgres BEFORE migrations run.
 *   node scripts/apply-sql.mjs <path-to.sql>
 */
import pg from "pg";
import { readFileSync } from "node:fs";

const URL = process.env.DATABASE_URL;
const file = process.argv[2];
if (!URL) { console.error("DATABASE_URL is required"); process.exit(2); }
if (!file) { console.error("usage: node scripts/apply-sql.mjs <file.sql>"); process.exit(2); }

const LOCAL = /localhost|127\.0\.0\.1/.test(URL) || process.env.PGSSL === "disable";
const c = new pg.Client({ connectionString: URL, ssl: LOCAL ? false : { rejectUnauthorized: false } });
await c.connect();
try {
  await c.query(readFileSync(file, "utf8"));
  console.log("✅ applied", file);
} catch (e) {
  console.error("❌ FAILED", file, "→", e.message);
  await c.end();
  process.exit(1);
}
await c.end();
