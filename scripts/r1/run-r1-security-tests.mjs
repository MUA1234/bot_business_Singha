#!/usr/bin/env node
/**
 * R1 security-baseline tests against a DISPOSABLE local PostgreSQL 16 carrying the FULL
 * application schema.
 *
 * The RLS matrix is gated on the repository's real identity functions (has_company_access,
 * has_capability) and the real roles/permissions seed, so it cannot be tested on an empty
 * database. This builds the whole thing from scratch, runs the tests, and destroys it:
 *
 *   1. disposable postgres:16, published to LOOPBACK ONLY;
 *   2. the Supabase compatibility shim (auth roles, auth.uid(), grants);
 *   3. all production migrations 0001-0109 via the ordinary runner;
 *   4. the quarantined R1 draft units via the draft runner;
 *   5. the R1 security integration tests;
 *   6. teardown, pass or fail.
 *
 * Nothing hosted is contacted at any point.
 */
import { execFileSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import pg from "pg";

const NAME = "singha-r1-sec-pg16";
const PORT = process.env.R1_SEC_PORT ?? "55473";
const URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });

function cleanup() {
  try {
    execSync(`docker rm -f ${NAME}`, { stdio: "ignore" });
  } catch {
    /* already gone */
  }
}

cleanup();
console.log(`▶ disposable PostgreSQL 16 on 127.0.0.1:${PORT} …`);
run("docker", [
  "run", "-d", "--name", NAME,
  "-e", "POSTGRES_PASSWORD=postgres",
  "-p", `127.0.0.1:${PORT}:5432`,
  "postgres:16",
]);

let ready = false;
for (let i = 0; i < 90; i++) {
  try {
    execSync(`docker exec ${NAME} pg_isready -U postgres`, { stdio: "ignore" });
    ready = true;
    break;
  } catch {
    execSync(process.platform === "win32" ? "ping -n 2 127.0.0.1 > NUL" : "sleep 1", { stdio: "ignore" });
  }
}
if (!ready) {
  cleanup();
  console.error("✖ database never became ready");
  process.exit(1);
}
console.log("✔ database ready");

let code = 0;
try {
  console.log("▶ applying the Supabase compatibility shim …");
  const c = new pg.Client({ connectionString: URL, ssl: false });
  await c.connect();
  await c.query(readFileSync("tests/integration/helpers/supabase-shim.sql", "utf8"));
  await c.end();

  console.log("▶ applying production migrations 0001-0109 …");
  run("node", ["scripts/migrate.mjs"], { env: { ...process.env, DATABASE_URL: URL }, stdio: "pipe" });

  console.log("▶ applying quarantined R1 draft units …");
  run("node", ["scripts/r1/draft-migrate.mjs", "--up"], {
    env: { ...process.env, DATABASE_URL: URL, R1_DRAFT_CONFIRM: "disposable-local-only" },
  });

  console.log("▶ auditing that every loader column actually exists …");
  run("node", ["scripts/r1/check-loader-columns.mjs"], { env: { ...process.env } });

  console.log("▶ running the full R1 + R2B live campaign …");
  run("node", [
    "node_modules/vitest/vitest.mjs", "run",
    "-c", "vitest.integration.config.ts",
    "tests/integration/r1-security-baseline.test.ts",
    "tests/integration/r1-adapter-ingest.test.ts",
    "tests/integration/r1-vertical-slice-campaign.test.ts",
    "tests/integration/r1-runtime-e2e.test.ts",
    "tests/integration/r1-atomic-create.test.ts",
    "tests/integration/r2b-capability-routing.test.ts",
    "tests/integration/r2b-feedback-runtime.test.ts",
    "tests/integration/r2b-learning-e2e.test.ts",
    "tests/integration/r2c-role-routing.test.ts",
  ], { env: { ...process.env, DATABASE_URL: URL, R1_DRAFT_CONFIRM: "disposable-local-only" } });
} catch {
  code = 1;
} finally {
  console.log("▶ destroying disposable database …");
  cleanup();
}
process.exit(code);
