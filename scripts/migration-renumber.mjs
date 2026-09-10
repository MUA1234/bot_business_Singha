#!/usr/bin/env node
/**
 * Migration renumbering — shift a whole dependent sequence, never one file.
 *
 * WHY THIS IS A TOOL AND NOT A SHELL LOOP. `main` and the recovery line each defined a
 * DIFFERENT migration numbered 0069. Resolving that by renaming one file would move it
 * ABOVE its own dependants — the recovery 0069 has 6 direct and 7 transitive dependants —
 * so the whole sequence has to move together, in order, and every reference to a moved
 * number has to move with it. Doing that by hand is how a reference gets missed and a
 * migration silently stops matching the thing that documents it.
 *
 * WHAT IT MOVES
 *   1. the migration FILES, renamed high-to-low so two files never briefly share a number;
 *   2. filename-shaped references anywhere in the repo (`0074_channel_account_...`), which
 *      are unambiguous;
 *   3. prose references (`migration 0074`, `migrations 0074`) for numbers ABOVE the base
 *      branch's high-water mark — also unambiguous, because the base line has no migration
 *      up there at all;
 *   4. prose references to the colliding number itself, but ONLY in the files listed in
 *      `COLLIDING_PROSE_FILES`, because that number is genuinely ambiguous: it means one
 *      migration on the base line and a different one on the recovery line. Each of those
 *      files was read and classified by hand; the rest are left alone deliberately.
 *
 * WHAT IT DOES NOT DO
 *   * It does not touch the quarantined R1 draft units (`src/db/draft-migrations-r1/`),
 *     which are not numbered production migrations and must not become them here.
 *   * It does not apply anything to any database.
 *
 * Usage:
 *   node scripts/migration-renumber.mjs --plan            # print the mapping, change nothing
 *   node scripts/migration-renumber.mjs --apply           # rename + rewrite references
 *   node scripts/migration-renumber.mjs --plan --json     # machine-readable mapping
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DIR = "src/db/migrations";
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const JSON_OUT = argv.includes("--json");

/** The branch whose migrations are being shifted up. */
const RECOVERY_REF = process.env.RENUMBER_FROM_REF ?? "claude/product-recovery-r1";
/** The branch that keeps its numbers. */
const BASE_REF = process.env.RENUMBER_BASE_REF ?? "origin/main";

const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const namesAt = (ref) =>
  git(["ls-tree", "-r", "--name-only", ref, "--", DIR])
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.endsWith(".sql"))
    .map((p) => p.slice(p.lastIndexOf("/") + 1));

const baseNames = namesAt(BASE_REF);
const recoveryNames = namesAt(RECOVERY_REF);
const baseHighWater = baseNames.map((f) => f.slice(0, 4)).sort().at(-1);

/**
 * The first number the shifted sequence may occupy: above the base branch's high-water
 * mark. Computed, never assumed — if the base line grows, the offset grows with it.
 */
const firstFree = String(Number(baseHighWater) + 1).padStart(4, "0");

// Recovery files at or above the collision point are the ones that move.
const baseSet = new Set(baseNames);
const moving = recoveryNames
  .filter((f) => f.slice(0, 4) >= baseHighWater)
  .filter((f) => !baseSet.has(f)) // a file identical on both branches never moves
  .sort();

const offset = Number(firstFree) - Number(moving[0]?.slice(0, 4) ?? firstFree);

const mapping = moving.map((f) => {
  const oldV = f.slice(0, 4);
  const newV = String(Number(oldV) + offset).padStart(4, "0");
  return { oldVersion: oldV, newVersion: newV, oldFilename: f, newFilename: newV + f.slice(4) };
});

/**
 * Files where a prose reference to the COLLIDING number means the recovery migration, not
 * the base one. Classified by reading each occurrence; anything not listed here keeps its
 * number, which is the safe default when the reference is ambiguous.
 */
const COLLIDING_PROSE_FILES = [
  "src/app/api/cron/inbound-sweeper/route.ts",
  "src/app/app/admin/health/page.tsx",
  "src/components/spatial/panels/SystemHealthPanelContent.tsx",
  "src/events/inbound-sweeper.ts",
  "tests/campaign/admin-health-backlog.test.ts",
  "tests/integration/secure-definer-grants.test.ts",
];

if (!APPLY) {
  if (JSON_OUT) {
    console.log(JSON.stringify({ baseRef: BASE_REF, recoveryRef: RECOVERY_REF, baseHighWater, firstFree, offset, mapping }, null, 2));
  } else {
    console.log(`base ${BASE_REF} high-water: ${baseHighWater}`);
    console.log(`first free number:          ${firstFree}`);
    console.log(`offset:                     +${offset}`);
    console.log(`migrations moving:          ${mapping.length}\n`);
    for (const m of mapping) console.log(`  ${m.oldFilename}\n      -> ${m.newFilename}`);
  }
  process.exit(0);
}

// ── apply ────────────────────────────────────────────────────────────────────────────

// 1. Rename files high-to-low so no two files ever share a number mid-flight.
const descending = [...mapping].sort((a, b) => b.oldVersion.localeCompare(a.oldVersion));
let renamed = 0;
for (const m of descending) {
  const from = join(DIR, m.oldFilename);
  const to = join(DIR, m.newFilename);
  try { statSync(from); } catch { console.log(`  skip (absent): ${m.oldFilename}`); continue; }
  renameSync(from, to);
  renamed++;
}

// 2/3/4. Rewrite references across the repo.
const TEXT_EXT = /\.(ts|tsx|mjs|js|sql|md|json|yml|yaml)$/;
/**
 * `docs/product-recovery/` is deliberately excluded. Those files are an EVIDENCE RECORD:
 * they state what was measured, on which database, under which numbering, on a given date.
 * Rewriting a number inside them would turn "the apply halted at 0076_inbound_boundary_
 * correction.sql" into a description of a run that never happened under that name. Historical
 * records are corrected by adding a dated note, never by editing the observation. The first
 * run of this tool did rewrite them, and the damage was reverted; the exclusion is here so it
 * cannot recur.
 *
 * This file is excluded for a duller reason: it walks the tree it is editing, and on the
 * first run it renumbered the examples in its own docstring.
 */
const SKIP_DIR = /(^|[\\/])(node_modules|\.git|\.next|dist|build|coverage|artifacts)([\\/]|$)/;
const SKIP_PATH = /(^|[\\/])(docs[\\/]product-recovery|scripts[\\/]migration-renumber\.mjs)/;

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (SKIP_DIR.test(p) || SKIP_PATH.test(p)) continue;
    if (e.isDirectory()) walk(p, out);
    else if (TEXT_EXT.test(e.name)) out.push(p);
  }
  return out;
}

const stems = mapping.map((m) => ({
  oldStem: m.oldFilename.replace(/\.sql$/, ""),
  newStem: m.newFilename.replace(/\.sql$/, ""),
  oldVersion: m.oldVersion,
  newVersion: m.newVersion,
}));
// Rewrite descending so 0070->0071 never collides with an as-yet-unrewritten 0071.
const stemsDesc = [...stems].sort((a, b) => b.oldVersion.localeCompare(a.oldVersion));

const collidingVersion = baseHighWater;
let filesTouched = 0;
let refCount = 0;

for (const file of walk(".")) {
  const original = readFileSync(file, "utf8");
  let s = original;

  // (2) filename-shaped references — unambiguous.
  for (const st of stemsDesc) {
    if (!s.includes(st.oldStem)) continue;
    const n = s.split(st.oldStem).length - 1;
    s = s.split(st.oldStem).join(st.newStem);
    refCount += n;
  }

  // (3) prose references strictly ABOVE the base high-water mark — also unambiguous.
  for (const st of stemsDesc) {
    if (st.oldVersion <= collidingVersion) continue;
    const re = new RegExp(`\\b(migrations?)\\s+${st.oldVersion}\\b`, "g");
    s = s.replace(re, (m0, word) => { refCount++; return `${word} ${st.newVersion}`; });
  }

  // (4) prose references to the colliding number — only in hand-classified files.
  const rel = file.replace(/^\.[\\/]/, "").replace(/\\/g, "/");
  if (COLLIDING_PROSE_FILES.includes(rel)) {
    const st = stems.find((x) => x.oldVersion === collidingVersion);
    if (st) {
      s = s.replace(new RegExp(`\\b(migrations?)\\s+${collidingVersion}\\b`, "g"), (m0, word) => { refCount++; return `${word} ${st.newVersion}`; });
      s = s.replace(new RegExp(`\\b${collidingVersion}\\b(?=\\s+(durable|governs))`, "g"), () => { refCount++; return st.newVersion; });
    }
  }

  if (s !== original) { writeFileSync(file, s); filesTouched++; }
}

console.log(`✅ renumbered ${renamed} migration file(s) by +${offset} (first free ${firstFree}, base high-water ${baseHighWater}).`);
console.log(`   rewrote ${refCount} reference(s) across ${filesTouched} file(s).`);
