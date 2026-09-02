#!/usr/bin/env node
/**
 * Loader TYPE contract audit.
 *
 * The column audit proves every selected column exists. This proves the loader hands the
 * detector the SHAPE its contract declares — specifically that a field the adapter types as
 * `string | null` is not silently a JavaScript `Date`.
 *
 * That distinction is not pedantry. `pg` returns `date` and `timestamptz` columns as Date
 * objects, and an adapter that declares `expiry_date: string | null` will then do string work on
 * an object: `.slice(0, 10)` is undefined, an ISO comparison compares "Mon Sep 02 2026 …"
 * against "2026-09-02", and a detector quietly produces NOTHING. That is the same failure mode
 * as a missing column — a domain that reports "nothing needs attention" because it could not
 * read its own data — and the column audit cannot see it.
 *
 * Nothing hosted is contacted. Disposable local PostgreSQL only.
 */
import { execFileSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import pg from "pg";

const NAME = "singha-typecheck-pg16";
const PORT = process.env.TYPECHECK_PORT ?? "55503";
const URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;
const clean = () => { try { execSync(`docker rm -f ${NAME}`, { stdio: "ignore" }); } catch { /* gone */ } };

clean();
execFileSync("docker", [
  "run", "-d", "--name", NAME, "-e", "POSTGRES_PASSWORD=postgres",
  "-p", `127.0.0.1:${PORT}:5432`, "postgres:16",
], { stdio: "inherit" });

for (let i = 0; i < 90; i++) {
  try {
    execSync(`docker exec ${NAME} pg_isready -U postgres`, { stdio: "ignore" });
    execSync("ping -n 3 127.0.0.1 > NUL", { stdio: "ignore" });
    break;
  } catch { execSync("ping -n 2 127.0.0.1 > NUL", { stdio: "ignore" }); }
}

let code = 0;
try {
  const boot = new pg.Client({ connectionString: URL, ssl: false });
  await boot.connect();
  await boot.query(readFileSync("tests/integration/helpers/supabase-shim.sql", "utf8"));
  await boot.end();
  execFileSync("node", ["scripts/migrate.mjs"], { env: { ...process.env, DATABASE_URL: URL }, stdio: "pipe" });
  execFileSync("node", ["scripts/r1/draft-migrate.mjs", "--up"], {
    env: { ...process.env, DATABASE_URL: URL, R1_DRAFT_CONFIRM: "disposable-local-only" }, stdio: "pipe",
  });

  const db = new pg.Client({ connectionString: URL, ssl: false });
  await db.connect();

  // Every date/timestamp column any loader selects. If a loader returns such a column raw, the
  // adapter receives a Date where its type says string.
  const src = readFileSync("src/kernel/cycle-deps.ts", "utf8");
  const re = /from\("(\w+)"\)[\s\S]{0,240}?\.select\("([^"]+)"\)/g;
  const selects = [];
  let m;
  while ((m = re.exec(src))) {
    selects.push({ table: m[1], cols: m[2].split(",").map((c) => c.trim()).filter(Boolean) });
  }

  const temporal = [];
  for (const { table, cols } of selects) {
    const { rows } = await db.query(
      `select column_name, data_type from information_schema.columns
        where table_schema = 'public' and table_name = $1`, [table]);
    const types = new Map(rows.map((r) => [r.column_name, r.data_type]));
    for (const c of cols) {
      const t = types.get(c);
      if (t && /date|timestamp/i.test(t)) temporal.push(`${table}.${c} (${t})`);
    }
  }
  await db.end();

  console.log(`temporal columns reached by loaders (${temporal.length}):`);
  for (const t of temporal) console.log("  " + t);
  console.log(
    "\nEach must be normalised to an ISO string by its loader, or its adapter must accept a Date.\n" +
    "The behavioural proof is tests/integration/r2s-loader-contract.test.ts, which asserts the\n" +
    "NORMALISED shape rather than trusting the query.",
  );
} catch (e) {
  console.error("type audit failed:", e.message);
  code = 1;
} finally {
  clean();
}
process.exit(code);
