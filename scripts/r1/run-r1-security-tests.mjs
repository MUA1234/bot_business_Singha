#!/usr/bin/env node
/**
 * R1/R2 security-baseline tests against a DISPOSABLE local PostgreSQL 16 carrying the FULL
 * application schema.
 *
 * The RLS matrix is gated on the repository's real identity functions (has_company_access,
 * has_capability) and the real roles/permissions seed, so it cannot be tested on an empty
 * database. This builds the whole thing from scratch, runs the tests, and destroys it:
 *
 *   1. disposable postgres:16, published to LOOPBACK ONLY;
 *   2. the Supabase compatibility shim (auth roles, auth.uid(), grants);
 *   3. all production migrations via the ordinary runner;
 *   4. the quarantined R1 draft units via the draft runner;
 *   5. the live integration campaign;
 *   6. teardown, pass or fail.
 *
 * Nothing hosted is contacted at any point.
 *
 * ── HARNESS HARDENING ───────────────────────────────────────────────────────────────────────
 *
 * An earlier version used one fixed container name and port and cleaned up only in `finally`.
 * When a run ended abnormally — killed, crashed, or terminated by a signal — `finally` never
 * ran, the container was orphaned, and the NEXT run raced it for the port and reported
 * "database never became ready". Five test failures were then attributed to the product before
 * the real cause was found. That is a harness defect that manufactures false evidence, so:
 *
 *   * every run gets a UNIQUE container name and a port the OS says is free;
 *   * containers are LABELLED with this harness and this run;
 *   * cleanup runs on success, failure, SIGINT, SIGTERM and uncaught errors;
 *   * cleanup removes ONLY containers carrying this harness's label — never by guesswork, and
 *     never anything belonging to another project on the same machine;
 *   * a preflight sweep reports and removes stale containers OWNED BY THIS HARNESS;
 *   * a concurrency lock refuses a second campaign rather than letting two fight;
 *   * an INACTIVITY WATCHDOG kills a genuinely silent run instead of hanging for ever;
 *   * a final summary and a real exit code are always emitted.
 */
import { execFileSync, execSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import pg from "pg";

// ── Identity of this run ─────────────────────────────────────────────────────────────────────
const HARNESS_LABEL = "singha.harness=r1-security";
const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const NAME = `singha-r1-sec-pg16-${RUN_ID}`;
const LOCK = ".r1-security-campaign.lock";

/** No output at all for this long means the run is not doing anything. */
const WATCHDOG_MS = Number(process.env.R1_SEC_WATCHDOG_MS ?? 10 * 60 * 1000);

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });

/**
 * The loopback port DOCKER assigned, read back after the container is running.
 *
 * Choosing a port ourselves means checking availability and then binding, and anything may
 * take the port in the gap between the two. That is the same collision class this hardening
 * exists to remove, so it should not be the mechanism that removes it. Publishing to
 * `127.0.0.1::5432` lets Docker allocate, and `docker port` reports what it chose — there is
 * no window, because the port is never unbound between decision and use.
 */
function assignedPort(container) {
  if (process.env.R1_SEC_PORT) return process.env.R1_SEC_PORT;
  const out = execSync(`docker port ${container} 5432/tcp`, { encoding: "utf8" }).trim();
  const m = out.match(/:(\d+)\s*$/m);
  if (!m) throw new Error(`could not read the published port from: ${out}`);
  return m[1];
}

// ── Cleanup, by ownership label only ─────────────────────────────────────────────────────────
let cleaned = false;
function cleanup(reason = "normal") {
  if (cleaned) return;
  cleaned = true;
  try {
    execSync(`docker rm -f ${NAME}`, { stdio: "ignore" });
    console.log(`▶ removed disposable container ${NAME} (${reason})`);
  } catch (e) {
    // Visible, never swallowed: a container left running is the exact failure this replaces.
    console.error(`✖ COULD NOT REMOVE ${NAME} — remove it manually: docker rm -f ${NAME}`);
    console.error(`  ${(e && e.message) || e}`);
  }
  try {
    if (existsSync(LOCK)) unlinkSync(LOCK);
  } catch { /* the lock is advisory */ }
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
  process.on(sig, () => { cleanup(sig); process.exit(130); });
}
process.on("uncaughtException", (e) => { console.error(e); cleanup("uncaughtException"); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error(e); cleanup("unhandledRejection"); process.exit(1); });

// ── Preflight: refuse a concurrent campaign, and sweep OUR stale containers ───────────────────
if (existsSync(LOCK)) {
  const held = readFileSync(LOCK, "utf8").trim();
  const pid = Number(held.split(":")[1]);
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch { alive = false; }
  if (alive) {
    console.error(`✖ another campaign is running (${held}). Two would fight over the database.`);
    process.exit(1);
  }
  console.log(`▶ clearing a stale lock from a run that did not finish (${held})`);
  try { unlinkSync(LOCK); } catch { /* fine */ }
}
writeFileSync(LOCK, `${RUN_ID}:${process.pid}`, "utf8");

try {
  const stale = execSync(`docker ps -aq --filter "label=${HARNESS_LABEL}"`, { encoding: "utf8" })
    .split("\n").map((s) => s.trim()).filter(Boolean);
  if (stale.length) {
    // Ours by label, so removing them is safe. Anything unlabelled — another project's database,
    // a developer's own container — is never touched.
    console.log(`▶ removing ${stale.length} stale container(s) left by a previous campaign`);
    execSync(`docker rm -f ${stale.join(" ")}`, { stdio: "ignore" });
  }
} catch {
  console.log("▶ no stale harness containers to remove");
}

console.log(`▶ run ${RUN_ID} — disposable PostgreSQL 16 …`);
run("docker", [
  "run", "-d", "--name", NAME,
  "--label", HARNESS_LABEL,
  "--label", `singha.run=${RUN_ID}`,
  "-e", "POSTGRES_PASSWORD=postgres",
  // Docker chooses the loopback port; we read it back below.
  "-p", "127.0.0.1::5432",
  "postgres:16",
]);

const PORT = assignedPort(NAME);
const URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;
console.log(`▶ database published on 127.0.0.1:${PORT}`);

/**
 * Ready means "a client can connect and run a statement", not "pg_isready said yes".
 *
 * The postgres image runs initdb against a TEMPORARY server, then restarts the real one.
 * `pg_isready` answers yes to the temporary server, so the next connection is dropped
 * mid-statement with "Connection terminated unexpectedly" — which looks like a database
 * fault and is actually a readiness check answering the wrong question. Two consecutive
 * successful round trips are required, so a connection that survives only until the restart
 * cannot satisfy it.
 */
async function waitForDatabase() {
  let consecutive = 0;
  for (let i = 0; i < 120; i++) {
    const probe = new pg.Client({ connectionString: URL, ssl: false });
    try {
      await probe.connect();
      await probe.query("select 1");
      await probe.end();
      if (++consecutive >= 2) return true;
    } catch {
      consecutive = 0;
      try { await probe.end(); } catch { /* never connected */ }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

if (!(await waitForDatabase())) {
  console.error("✖ database never became ready");
  cleanup("not-ready");
  process.exit(1);
}
console.log("✔ database ready");

/**
 * Run vitest, streaming its output, watching for silence and remembering where it got to.
 *
 * `execFileSync` blocks the event loop, so a watchdog timer could never fire alongside it. The
 * output is piped and re-emitted instead, which also lets the runner report the LAST TEST FILE
 * reached — the single most useful fact when a campaign has to be diagnosed after the event.
 */
function runCampaign(files) {
  return new Promise((resolve) => {
    const child = spawn("node", [
      "node_modules/vitest/vitest.mjs", "run", "-c", "vitest.integration.config.ts", ...files,
    ], {
      env: { ...process.env, DATABASE_URL: URL, R1_DRAFT_CONFIRM: "disposable-local-only" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let lastOutput = Date.now();
    let lastFile = "(none reached)";
    const note = (buf, to) => {
      const text = buf.toString();
      lastOutput = Date.now();
      const m = text.match(/tests\/integration\/[a-z0-9-]+\.test\.ts/g);
      if (m) lastFile = m[m.length - 1];
      to.write(text);
    };
    child.stdout.on("data", (b) => note(b, process.stdout));
    child.stderr.on("data", (b) => note(b, process.stderr));

    const watchdog = setInterval(() => {
      const silent = Date.now() - lastOutput;
      if (silent >= WATCHDOG_MS) {
        clearInterval(watchdog);
        console.error(
          `\n✖ WATCHDOG: no output for ${Math.round(silent / 1000)}s. Last file: ${lastFile}`);
        console.error("  Killing the campaign; this is a harness stop, not a test result.");
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        resolve({ code: 1, lastFile, timedOut: true });
      }
    }, 30_000);

    child.on("exit", (code) => {
      clearInterval(watchdog);
      resolve({ code: code ?? 1, lastFile, timedOut: false });
    });
  });
}

const startedAt = Date.now();
let code = 0;
let outcome = { lastFile: "(not started)", timedOut: false };

try {
  console.log("▶ applying the Supabase compatibility shim …");
  const c = new pg.Client({ connectionString: URL, ssl: false });
  await c.connect();
  await c.query(readFileSync("tests/integration/helpers/supabase-shim.sql", "utf8"));
  await c.end();

  console.log("▶ applying production migrations …");
  run("node", ["scripts/migrate.mjs"], { env: { ...process.env, DATABASE_URL: URL }, stdio: "pipe" });

  console.log("▶ applying quarantined R1 draft units …");
  run("node", ["scripts/r1/draft-migrate.mjs", "--up"], {
    env: { ...process.env, DATABASE_URL: URL, R1_DRAFT_CONFIRM: "disposable-local-only" },
  });

  console.log("▶ auditing that every loader column actually exists …");
  run("node", ["scripts/r1/check-loader-columns.mjs"], { env: { ...process.env } });

  /**
   * The whole campaign, or a named subset.
   *
   * `R1_SEC_ONLY` runs specific files against the same disposable database and the same
   * migrations — which is what isolating a suspected stall, or mutation-testing one
   * invariant, actually requires. Running a subset by hand against a different database
   * would answer a different question.
   */
  const ALL = [
    "tests/integration/r1-security-baseline.test.ts",
    "tests/integration/r1-adapter-ingest.test.ts",
    "tests/integration/r1-vertical-slice-campaign.test.ts",
    "tests/integration/r1-runtime-e2e.test.ts",
    "tests/integration/r1-atomic-create.test.ts",
    "tests/integration/r2b-capability-routing.test.ts",
    "tests/integration/r2b-feedback-runtime.test.ts",
    "tests/integration/r2b-learning-e2e.test.ts",
    "tests/integration/r2c-role-routing.test.ts",
    "tests/integration/r2s-loader-contract.test.ts",
    "tests/integration/r2s-p-pagination.test.ts",
    "tests/integration/r2s-p-cursor-handoff.test.ts",
    "tests/integration/r2s-p-reconcile-fairness.test.ts",
    "tests/integration/r2s-p-fence-and-reset.test.ts",
    "tests/integration/r2s-p-tail-liveness.test.ts",
    "tests/integration/r2s-p-batch-lookup.test.ts",
    "tests/integration/r2s-p-incremental-highwater.test.ts",
    "tests/integration/r2d-ask-ai.test.ts",
    "tests/integration/r2d-adversarial.test.ts",
    "tests/integration/r2d-non-execution.test.ts",
    "tests/integration/r2d-saved-answer-access.test.ts",
    "tests/integration/r2d-retention-purge.test.ts",
    "tests/integration/r2e-execution-ledger.test.ts",
    "tests/integration/r2-decision-boundary.test.ts",
    "tests/integration/r2-authority-and-scope.test.ts",
    "tests/integration/r2-outcome-verification.test.ts",
    "tests/integration/r2-verification-schedule.test.ts",
  ];

  const only = (process.env.R1_SEC_ONLY ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const files = only.length ? only : ALL;
  if (only.length) {
    const unknown = only.filter((f) => !ALL.includes(f));
    // A typo would otherwise silently run nothing and report success.
    if (unknown.length) throw new Error(`R1_SEC_ONLY names unknown suites: ${unknown.join(", ")}`);
    console.log(`▶ running ${files.length} selected suite(s) …`);
  } else {
    console.log("▶ running the full live campaign …");
  }
  outcome = await runCampaign(files);
  code = outcome.code;
} catch (e) {
  console.error((e && e.message) || e);
  code = 1;
} finally {
  console.log("▶ destroying disposable database …");
  cleanup(code === 0 ? "success" : "failure");
}

// A final summary, always — so a run that ends abnormally still says where it got to.
const seconds = Math.round((Date.now() - startedAt) / 1000);
console.log(
  `\n══ campaign ${RUN_ID} — ${code === 0 ? "PASSED" : "FAILED"} in ${seconds}s` +
  `${outcome.timedOut ? " (watchdog)" : ""} — last file: ${outcome.lastFile}`);
process.exit(code);
