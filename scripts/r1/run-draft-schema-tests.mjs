#!/usr/bin/env node
/**
 * Runs the R1 draft-schema integration tests against a DISPOSABLE local PostgreSQL 16
 * container, then destroys it.
 *
 * Nothing hosted is contacted. The container is created for this run, bound to loopback
 * only, and removed afterwards whether the tests pass or fail.
 *
 *   node scripts/r1/run-draft-schema-tests.mjs
 */
import { execFileSync, execSync } from "node:child_process";

const NAME = "singha-r1-draft-pg16";
const PORT = process.env.R1_DRAFT_PORT ?? "55471";
const URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: "inherit", ...opts });

function cleanup() {
  try {
    execSync(`docker rm -f ${NAME}`, { stdio: "ignore" });
  } catch {
    /* already gone */
  }
}

cleanup();
console.log(`▶ starting disposable PostgreSQL 16 on 127.0.0.1:${PORT} …`);
run("docker", [
  "run", "-d", "--name", NAME,
  "-e", "POSTGRES_PASSWORD=postgres",
  // Loopback-only publish: the container is unreachable from the network.
  "-p", `127.0.0.1:${PORT}:5432`,
  "postgres:16",
]);

// Wait for readiness rather than sleeping blindly.
let ready = false;
for (let i = 0; i < 60; i++) {
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
  // Invoke vitest's own entry point rather than `npx`: on Windows `npx` is a .cmd shim that
  // execFileSync cannot spawn, which silently produced an empty run.
  run("node", [
    "node_modules/vitest/vitest.mjs",
    "run",
    "-c", "vitest.integration.config.ts",
    "tests/integration/r1-draft-schema.test.ts",
  ], {
    env: { ...process.env, DATABASE_URL: URL, R1_DRAFT_CONFIRM: "disposable-local-only" },
  });
} catch {
  code = 1;
} finally {
  console.log("▶ destroying disposable database …");
  cleanup();
}
process.exit(code);
