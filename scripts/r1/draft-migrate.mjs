#!/usr/bin/env node
/**
 * R1 DRAFT migration runner — DISPOSABLE LOCAL DATABASES ONLY.
 *
 * Owner decision R1-D-1: the six R1 tables may not take production migration numbers while
 * the 0069 collision (PR-F-001) and the unknown hosted schema state (PR-F-004) are
 * unresolved. They live quarantined in `src/db/draft-migrations-r1/` and are applied only
 * by this command.
 *
 * THIS RUNNER IS DELIBERATELY NOT `npm run migrate`, AND CANNOT BE MISTAKEN FOR IT:
 *   * it reads a different directory;
 *   * the files there fail the production runner's `/^\d{4}_.*\.sql$/` filename filter;
 *   * it records state in `r1_draft_migrations` and NEVER touches `schema_migrations`;
 *   * it refuses any non-loopback DATABASE_URL;
 *   * it requires R1_DRAFT_CONFIRM=disposable-local-only.
 *
 * Both guards must pass. Either missing is a refusal, not a warning.
 *
 * Usage:
 *   R1_DRAFT_CONFIRM=disposable-local-only DATABASE_URL=postgresql://…@127.0.0.1:…/db \
 *     node scripts/r1/draft-migrate.mjs --up | --down | --status
 */
import pg from "pg";
import { readdirSync, readFileSync } from "node:fs";

export const DRAFT_DIR = "src/db/draft-migrations-r1";
export const CONFIRM_VAR = "R1_DRAFT_CONFIRM";
export const CONFIRM_VALUE = "disposable-local-only";
export const LEDGER = "r1_draft_migrations";
export const HOSTED_MARKER = "NOT FOR HOSTED APPLICATION";

/** Draft filenames. Deliberately NOT the production pattern. */
export const DRAFT_UP_RE = /^R1_DRAFT_\d{3}_.*\.up\.sql$/;
export const DRAFT_DOWN_RE = /^R1_DRAFT_\d{3}_.*\.down\.sql$/;

/**
 * Is this connection string a loopback address?
 *
 * Written as an allowlist of loopback hosts rather than a denylist of hosted ones: a
 * denylist fails open the moment a provider uses a hostname nobody enumerated, and failing
 * open here means writing to somebody's production database.
 */
export function isLoopbackUrl(raw) {
  if (!raw) return false;
  let host;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return false;
  }
  // Strip IPv6 brackets if the URL parser left them.
  host = host.replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0:0:0:0:0:0:0:1";
}

/** Both guards. Returns { ok } or { ok: false, reason }. Pure — unit-testable. */
export function checkGuards(env) {
  const url = env.DATABASE_URL;
  if (!url) return { ok: false, reason: "DATABASE_URL is required" };
  if (env[CONFIRM_VAR] !== CONFIRM_VALUE) {
    return {
      ok: false,
      reason: `${CONFIRM_VAR}=${CONFIRM_VALUE} is required — these are draft migrations and must never reach a hosted database`,
    };
  }
  if (!isLoopbackUrl(url)) {
    return {
      ok: false,
      reason: "DATABASE_URL is not a loopback address — R1 draft migrations are for disposable LOCAL databases only",
    };
  }
  return { ok: true };
}

export function listDraftUnits(dir = DRAFT_DIR) {
  const files = readdirSync(dir);
  const ups = files.filter((f) => DRAFT_UP_RE.test(f)).sort();
  return ups.map((up) => ({
    version: up.slice(0, 12), // R1_DRAFT_NNN
    up,
    down: up.replace(/\.up\.sql$/, ".down.sql"),
  }));
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────
// Guarded so the module can be imported by tests without connecting to anything.
const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/r1/draft-migrate.mjs");

if (invokedDirectly) {
  const guard = checkGuards(process.env);
  if (!guard.ok) {
    console.error(`REFUSED: ${guard.reason}`);
    process.exit(2);
  }

  const mode = process.argv[2] ?? "--status";
  const units = listDraftUnits();

  for (const u of units) {
    const sql = readFileSync(`${DRAFT_DIR}/${u.up}`, "utf8");
    if (!sql.includes(HOSTED_MARKER)) {
      console.error(`REFUSED: ${u.up} is missing the "${HOSTED_MARKER}" marker`);
      process.exit(2);
    }
  }

  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: false });
  await c.connect();
  await c.query(
    `create table if not exists ${LEDGER} (version text primary key, filename text not null, applied_at timestamptz not null default now())`,
  );
  const applied = new Set((await c.query(`select version from ${LEDGER}`)).rows.map((r) => r.version));

  if (mode === "--status") {
    const pending = units.filter((u) => !applied.has(u.version));
    console.log(`R1 draft — applied: ${applied.size}  pending: ${pending.length}`);
    if (pending.length) console.log("  pending:", pending.map((u) => u.version).join(", "));
    await c.end();
    process.exit(0);
  }

  if (mode === "--up") {
    let n = 0;
    for (const u of units.filter((x) => !applied.has(x.version))) {
      const sql = readFileSync(`${DRAFT_DIR}/${u.up}`, "utf8");
      try {
        await c.query("begin");
        await c.query(sql);
        await c.query(`insert into ${LEDGER} (version, filename) values ($1,$2)`, [u.version, u.up]);
        await c.query("commit");
        console.log("✅ applied", u.up);
        n++;
      } catch (e) {
        await c.query("rollback").catch(() => {});
        console.error("❌ FAILED", u.up, "→", e.message);
        await c.end();
        process.exit(1);
      }
    }
    console.log(n ? `Applied ${n} draft unit(s).` : "Up to date.");
    await c.end();
    process.exit(0);
  }

  if (mode === "--down") {
    // Reverse order, each unit in its own transaction.
    let n = 0;
    for (const u of [...units].reverse().filter((x) => applied.has(x.version))) {
      const sql = readFileSync(`${DRAFT_DIR}/${u.down}`, "utf8");
      try {
        await c.query("begin");
        await c.query(sql);
        await c.query(`delete from ${LEDGER} where version = $1`, [u.version]);
        await c.query("commit");
        console.log("↩️  rolled back", u.down);
        n++;
      } catch (e) {
        await c.query("rollback").catch(() => {});
        console.error("❌ ROLLBACK FAILED", u.down, "→", e.message);
        await c.end();
        process.exit(1);
      }
    }
    console.log(n ? `Rolled back ${n} draft unit(s).` : "Nothing to roll back.");
    await c.end();
    process.exit(0);
  }

  console.error(`unknown mode "${mode}" — use --up, --down or --status`);
  await c.end();
  process.exit(2);
}
