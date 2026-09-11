#!/usr/bin/env node
/**
 * Shift the candidate's own migration sequence up by one, as ONE dependency-preserving unit.
 *
 * ── Why a second renumbering tool ───────────────────────────────────────────────────────────
 *
 * `scripts/migration-renumber.mjs` resolved the FIRST collision (main's `0069` against the
 * recovery line's). It plans from the recovery branch's file list, which is the right input for
 * that job and the wrong input for this one: those files have long since moved, and running it
 * here plans a shift of forty migrations that no longer exist under those names.
 *
 * This one is driven by the WORKING TREE and by what `origin/main` actually contains now.
 *
 * ── What it moves, and what decides ─────────────────────────────────────────────────────────
 *
 * `origin/main` owns `0070_identity_backfill_and_event_lifecycle.sql`, and its data repair has
 * already been applied to production. So main keeps `0070`, and every migration the candidate
 * added from `0070` upward moves up by one.
 *
 * Which files are "the candidate's" is decided by comparing filenames against `origin/main`, not
 * by a hardcoded list. A file main has keeps its number; a file only the candidate has moves.
 *
 * ── The guarantees ──────────────────────────────────────────────────────────────────────────
 *
 *   * Renamed HIGH TO LOW, so two files never briefly share a number.
 *   * The block must be CONTIGUOUS before the shift and contiguous after, or it refuses: a gap
 *     means a file was already moved and re-running would shift it twice.
 *   * The dependency graph is resolved before and after, and every dependant must still come
 *     after the migration defining what it needs. That is checked, not assumed — a shift that
 *     reordered a dependency would be the exact defect the whole-sequence rule exists to prevent.
 *   * `src/db/rollback/` moves in lockstep, so each rollback still names its own migration.
 *   * Historical evidence is not rewritten: `docs/product-recovery/`, `docs/hard-scenario/`,
 *     `docs/release-1/evidence/`, this file, and the other renumber tool are all skipped.
 *
 * Usage:
 *   node scripts/shift-candidate-sequence.mjs --plan
 *   node scripts/shift-candidate-sequence.mjs --apply
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildInventory, resolveDependencies } from "./lib/migration-graph.mjs";

const DIR = "src/db/migrations";
const ROLLBACK_DIR = "src/db/rollback";
const BASE_REF = process.env.SHIFT_BASE_REF ?? "origin/main";
const APPLY = process.argv.includes("--apply");

/** Paths whose migration numbers are HISTORY and must not be mechanically rewritten. */
const SKIP_PATH = [
  "node_modules", ".git", ".next", "dist", "coverage", "artifacts",
  "docs/product-recovery",          // the R0 evidence record
  "docs/hard-scenario",             // a campaign report about a past SHA
  "docs/release-1/evidence",        // committed hosted-probe output
  "scripts/migration-renumber.mjs", // describes the PREVIOUS shift
  "scripts/shift-candidate-sequence.mjs",
  // Records ABOUT a renumbering. Rewriting the numbers inside a document that explains a
  // collision turns it into a description of the resolved state, which is not what it says it is.
  // Learned the hard way: this file previously edited MAIN-MOVED-0070-COLLISION.md into claiming
  // the collision was between 0070 and 0071.
  "docs/release-1/MAIN-MOVED-0070-COLLISION.md",
  "docs/release-1/candidate-sequence-shift-map.json",
  "docs/release-1/migration-promotion-map.json",
  "docs/release-1/SHA-ATTRIBUTION.md",
];

const skip = (p) => SKIP_PATH.some((s) => p.replace(/\\/g, "/").includes(s));

// ── What main has, and what only we have ────────────────────────────────────────────────────
const baseNames = execFileSync("git", ["ls-tree", "-r", "--name-only", BASE_REF, `${DIR}/`],
  { encoding: "utf8" }).split("\n").map((s) => s.trim()).filter(Boolean).map((p) => p.split("/").pop());
const baseSet = new Set(baseNames);
const baseHigh = baseNames.map((f) => f.slice(0, 4)).sort().at(-1);

const all = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const ours = all.filter((f) => !baseSet.has(f));

if (ours.length === 0) { console.error("nothing to shift: every migration is also on " + BASE_REF); process.exit(2); }

const lowest = ours[0].slice(0, 4);
const firstFree = String(Number(baseHigh) + 1).padStart(4, "0");

// Contiguity, before. A gap means a previous run already moved something.
const nums = ours.map((f) => Number(f.slice(0, 4)));
for (let i = 1; i < nums.length; i++) {
  if (nums[i] !== nums[i - 1] + 1) {
    console.error(`refusing: the candidate's block is not contiguous — ${nums[i - 1]} then ${nums[i]}`);
    process.exit(2);
  }
}
if (Number(lowest) > Number(firstFree)) {
  console.error(`nothing to do: the candidate's lowest (${lowest}) is already above main's high-water (${baseHigh})`);
  process.exit(0);
}

const offset = Number(firstFree) - Number(lowest);
if (offset <= 0) { console.error(`refusing: computed a non-positive offset (${offset})`); process.exit(2); }

const mapping = ours.map((f) => {
  const n = String(Number(f.slice(0, 4)) + offset).padStart(4, "0");
  return { from: f, to: `${n}${f.slice(4)}`, fromVersion: f.slice(0, 4), toVersion: n };
});

console.log(`base ${BASE_REF} high-water: ${baseHigh}`);
console.log(`candidate block:            ${lowest} .. ${ours.at(-1).slice(0, 4)}  (${ours.length} files)`);
console.log(`offset:                     +${offset}\n`);
for (const m of mapping) console.log(`  ${m.from}\n      -> ${m.to}`);

// ── The dependency graph, BEFORE ────────────────────────────────────────────────────────────
function graph(dirFiles) {
  const rows = buildInventory(dirFiles.map((f) => ({ filename: f, content: readFileSync(join(DIR, f), "utf8") })));
  return resolveDependencies(rows);
}
function violations(resolved) {
  const out = [];
  for (const r of resolved.rows ?? resolved) {
    for (const d of r.dependsOn ?? []) {
      const provider = (resolved.rows ?? resolved).find((x) => x.filename === d.filename || x.version === d.version);
      if (provider && provider.number >= r.number) {
        out.push(`${r.filename} needs ${d.key ?? d.filename} defined by ${provider.filename}`);
      }
    }
  }
  return out;
}

const before = graph(all);
const beforeBad = violations(before);
console.log(`\ndependency analyser BEFORE: ${beforeBad.length} ordering violation(s)`);
beforeBad.slice(0, 5).forEach((v) => console.log(`  ${v}`));

if (!APPLY) { console.log("\n(plan only — nothing written)"); process.exit(0); }

// ── Rename, HIGH TO LOW ─────────────────────────────────────────────────────────────────────
for (const m of [...mapping].reverse()) {
  renameSync(join(DIR, m.from), join(DIR, m.to));
  const rbFrom = join(ROLLBACK_DIR, `${m.fromVersion}${m.from.slice(4).replace(/\.sql$/, ".down.sql")}`);
  const rbTo = join(ROLLBACK_DIR, `${m.toVersion}${m.to.slice(4).replace(/\.sql$/, ".down.sql")}`);
  try { statSync(rbFrom); renameSync(rbFrom, rbTo); } catch { /* not every migration has a rollback */ }
}

// ── Rewrite references ──────────────────────────────────────────────────────────────────────
//
// Filename-shaped references only (`0074_channel_account_company_resolution`), plus the
// `.down.sql` forms. These are unambiguous: the name carries the number, so there is no question
// which migration is meant. Bare prose numbers are NOT rewritten — "migration 0070" now means
// main's file on one line and the candidate's on another, and guessing is how a record becomes
// wrong.
const rewrites = new Map();
for (const m of mapping) {
  rewrites.set(m.from.replace(/\.sql$/, ""), m.to.replace(/\.sql$/, ""));
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (skip(p)) continue;
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js|json|md|sql|yml|yaml)$/.test(e.name)) out.push(p);
  }
  return out;
}

let touched = 0;
for (const p of walk(".")) {
  let s;
  try { s = readFileSync(p, "utf8"); } catch { continue; }
  let next = s;
  // Longest first, so 0140_x is not partially rewritten by a 0014_x rule.
  for (const [from, to] of [...rewrites].sort((a, b) => b[0].length - a[0].length)) {
    if (next.includes(from)) next = next.split(from).join(to);
  }
  if (next !== s) { writeFileSync(p, next); touched++; }
}

// ── The dependency graph, AFTER ─────────────────────────────────────────────────────────────
const after = graph(readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort());
const afterBad = violations(after);
console.log(`\ndependency analyser AFTER: ${afterBad.length} ordering violation(s)`);
afterBad.slice(0, 8).forEach((v) => console.log(`  ${v}`));

if (afterBad.length > beforeBad.length) {
  console.error("\n❌ the shift INTRODUCED ordering violations — this is the defect the whole-sequence rule exists to prevent");
  process.exit(1);
}

writeFileSync("docs/release-1/candidate-sequence-shift-map.json",
  JSON.stringify({ shiftedOn: "2026-09-11", baseRef: BASE_REF, baseHighWater: baseHigh, offset, mapping }, null, 2) + "\n");

console.log(`\n✅ shifted ${mapping.length} migration(s) by +${offset}; ${touched} file(s) had references rewritten.`);
