/**
 * Mutation harness for outcome verification (R2F-F-004).
 *
 * These mutations are TypeScript rather than SQL, so each run is a unit-suite run rather than a
 * disposable-database campaign. The verdict contract is identical: parsed from the summary line,
 * and a run with no summary line is INCONCLUSIVE rather than either answer.
 *
 * The ANSI strip removes the WHOLE escape sequence including the ESC byte. An earlier harness in
 * this repository stripped only the bracket part, which made `Tests\s+(\d+)\s+failed` unmatchable
 * and reported every mutation as SURVIVED.
 */
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { execSync } from "node:child_process";

const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");

const VERIFY = "src/kernel/verification/verify.ts";
const RULES = "src/kernel/verification/rules.ts";
const CONTRACT = "src/kernel/verification/contract.ts";
const FILES = [VERIFY, RULES, CONTRACT];

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
    id: "V1 a successful read alone counts as resolution (execution/read treated as success)",
    apply: () =>
      sub(
        RULES,
        "    const task = read.row;",
        "    const task = read.row;\n    return result('verified_resolved', 'MUTATION: any read verifies', 'verified');",
      ),
  },
  {
    id: "V2 task completion treated as success unconditionally (evidence guard dropped)",
    apply: () =>
      sub(
        RULES,
        "      if (task.requiresEvidence && task.verifiedEvidenceCount < 1) {",
        "      if (false && task.requiresEvidence && task.verifiedEvidenceCount < 1) {",
      ),
  },
  {
    id: "V3 generation-completeness check removed",
    apply: () => sub(VERIFY, "  if (!sweep.complete) {", "  if (false && !sweep.complete) {"),
  },
  {
    id: "V4 loader failure treated as absence, then as resolution",
    apply: () =>
      sub(
        RULES,
        '      return result("unavailable", `the originating record could not be read: ${read.reason}`);',
        "      return result('verified_resolved', 'MUTATION: failure read as absence', 'verified');",
      ),
  },
  {
    id: "V5 originating identity comparison removed",
    apply: () =>
      sub(
        VERIFY,
        "    item.subjectTable !== input.observed.subjectTable ||\n    item.subjectId !== input.observed.subjectId",
        "    false",
      ),
  },
  {
    id: "V6 cross-company evidence accepted",
    apply: () =>
      sub(
        VERIFY,
        "  if (item.companyId !== input.companyId) {",
        "  if (false && item.companyId !== input.companyId) {",
      ),
  },
  {
    id: "V7 unavailable outcome fed into positive learning",
    apply: () =>
      sub(
        CONTRACT,
        '  return o === "verified_resolved";',
        '  return o === "verified_resolved" || o === "unavailable";',
      ),
  },
  {
    id: "V8 observation-before-claim check removed",
    apply: () =>
      sub(
        VERIFY,
        "  if (!(sweep.observedAt > item.claimedAt)) {",
        "  if (false && !(sweep.observedAt > item.claimedAt)) {",
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
    out = execSync("npx vitest run tests/kernel/verification.test.ts", {
      encoding: "utf8",
      stdio: "pipe",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }

  const plain = out.replace(ANSI, "");
  const summary = plain
    .split(String.fromCharCode(10))
    .find((l) => /\bTests\b/.test(l) && /passed|failed/.test(l));
  const failed = summary ? summary.match(/(\d+)\s+failed/) : null;
  const passed = summary ? summary.match(/(\d+)\s+passed/) : null;

  let verdict;
  let detail;
  if (!summary || (!failed && !passed)) {
    verdict = "INCONCLUSIVE";
    detail = "no parsed Tests line — the suite did not run";
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
console.log("\n=== SUMMARY ===");
for (const r of results) console.log(`${r.verdict.padEnd(12)} ${r.id} - ${r.detail}`);
const bad = results.filter((r) => r.verdict !== "CAUGHT");
console.log(bad.length ? `\n${bad.length} mutation(s) NOT caught` : "\nall mutations caught");
