/**
 * Mutation harness for scheduled verification and its learning boundary.
 *
 * Complements `verification-mutations.mjs`, which covers the decision itself. These four are about
 * the SCHEDULER: partial-cycle handling, fairness, budget, and whether a machine conclusion can be
 * mistaken for a person's.
 *
 * Verdicts are parsed from the summary line of a real campaign. The ANSI strip removes the whole
 * escape sequence including the ESC byte — stripping only the bracket part makes the "failed"
 * pattern unmatchable and reports every mutation as SURVIVED.
 */
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { execSync } from "node:child_process";

const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
const NL = String.fromCharCode(10);

const SCHEDULE = "src/kernel/verification/schedule.ts";
const SERVICE = "src/kernel/verification/service.ts";
const FILES = [SCHEDULE, SERVICE];

for (const f of FILES) copyFileSync(f, `${f}.bak`);
const restore = () => {
  for (const f of FILES) copyFileSync(`${f}.bak`, f);
};

function sub(file, from, to) {
  const s = readFileSync(file, "utf8");
  if (!s.includes(from)) throw new Error(`anchor missing in ${file}: ${from.slice(0, 70)}`);
  writeFileSync(file, s.replace(from, to), "utf8");
}

const MUTATIONS = [
  {
    id: "P1 partial cycle ignored (a half-finished sweep verifies)",
    apply: () => sub(SCHEDULE, "  if (!input.cycleComplete) {", "  if (false) {"),
  },
  {
    id: "P2 backoff removed (a failing item can hold the front of the queue)",
    apply: () =>
      sub(
        SCHEDULE,
        "export function backoffMinutesFor(attempts: number): number {",
        "export function backoffMinutesFor(attempts: number): number {\n  return 0; // MUTATION",
      ),
  },
  {
    id: "P3 budget ignored (verification can starve domain observation)",
    apply: () => sub(SCHEDULE, "    if (used >= budget) {", "    if (false) {"),
  },
  {
    id: "P4 machine conclusion written as a PERSON's (persists becomes person evidence)",
    apply: () =>
      sub(
        SERVICE,
        '  const actorType = input.actorId ? "user" : "system";',
        '  const actorType = "user"; // MUTATION',
      ),
  },
];

const results = [];
for (const m of MUTATIONS) {
  restore();
  try {
    m.apply();
  } catch (e) {
    results.push({ id: m.id, verdict: "INCONCLUSIVE", detail: `could not apply: ${e.message}` });
    console.log(`INCONCLUSIVE ${m.id}`);
    continue;
  }

  let out = "";
  try {
    out = execSync("node scripts/r1/run-r1-security-tests.mjs", {
      env: {
        ...process.env,
        R1_SEC_ONLY: "tests/integration/r2-verification-schedule.test.ts",
      },
      encoding: "utf8",
      stdio: "pipe",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }

  const plain = out.replace(ANSI, "");
  const summary = plain
    .split(NL)
    .find((l) => /\bTests\b/.test(l) && /passed|failed/.test(l));
  const failed = summary ? summary.match(/(\d+)\s+failed/) : null;
  const passed = summary ? summary.match(/(\d+)\s+passed/) : null;

  let verdict;
  let detail;
  if (!summary || (!failed && !passed)) {
    verdict = "INCONCLUSIVE";
    detail = "no parsed Tests line — the campaign did not run the suite";
  } else if (failed) {
    verdict = "CAUGHT";
    detail = `${failed[1]} failed`;
  } else {
    verdict = "SURVIVED";
    detail = `${passed[1]} passed, 0 failed`;
  }
  results.push({ id: m.id, verdict, detail });
  console.log(`${verdict.padEnd(12)} ${m.id} - ${detail}`);
}

restore();
console.log(`${NL}=== SUMMARY ===`);
for (const r of results) console.log(`${r.verdict.padEnd(12)} ${r.id} - ${r.detail}`);
const bad = results.filter((r) => r.verdict !== "CAUGHT");
console.log(bad.length ? `${NL}${bad.length} mutation(s) NOT caught` : `${NL}all mutations caught`);
